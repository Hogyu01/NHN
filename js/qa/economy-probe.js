import { CommandBus } from "../core/command-bus.js";
import { divideHalfUp, multiplyDivideHalfUp } from "../core/money.js";
import { cloneValue } from "../core/result.js";
import { GameStore } from "../core/store.js";
import {
  applyCashTransactionToDraft,
  applyContractReserveChangeToDraft,
  CASH_TRANSACTION_POLICIES,
  CONTRACT_RESERVE_OPERATION,
  LEDGER_CATEGORY,
  registerCashTransactionAPI,
} from "../domain/cash-transaction-api.js";
import {
  calculateAvailableCashG,
  createEconomyState,
  projectEconomy,
  validateEconomyState,
  validateEconomyTransition,
} from "../domain/economy.js";
import {
  buildLedgerDrillDownIndex,
  projectEconomyLedger,
  reconcileCashWithLedger,
} from "../domain/economy-ledger.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function equivalent(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function createRootState({
  runtimePhase = "PLANNING",
  economy = {},
  consecutiveArrearsCount = 0,
} = {}) {
  return {
    revision: 0,
    runtimePhase,
    generationId: 13,
    campaign: {
      day: 1,
      consecutiveArrearsCount,
      marker: "campaign-unchanged",
    },
    economy: createEconomyState(economy),
    accounting: {
      fixedCostExpenseG: 40,
      operatingExpenseG: 40,
      marker: "expense-must-not-be-recognized-again",
    },
    idCounters: { tx: 0 },
    rng: { market: { drawCount: 0 } },
    untouched: { marker: "structurally-shared" },
  };
}

function createHarness(options = {}) {
  const store = new GameStore(createRootState(options));
  const bus = new CommandBus({ store });
  const api = registerCashTransactionAPI(bus);
  return { store, bus, api };
}

function commandInput(harness, commandId, payload) {
  return {
    commandId,
    expectedRevision: harness.store.revision,
    generationId: harness.store.generationId,
    issuedAtSimulationMs: harness.store.revision * 20,
    payload,
  };
}

function request(category, amountG, transactionId, causeId = `${transactionId}:cause`) {
  const policy = CASH_TRANSACTION_POLICIES[category];
  return {
    transactionId,
    day: 1,
    category,
    type: policy.type,
    direction: policy.direction,
    amountG,
    causeId,
  };
}

function specialPayload(amountG, transactionId, causeId = `${transactionId}:cause`) {
  return { transactionId, day: 1, amountG, causeId };
}

async function assertRejectedUnchanged(harness, execute, expectedCode, label) {
  const before = harness.store.getSnapshot();
  const signals = harness.bus.getSignalSnapshot();
  const metadata = harness.store.getCommandMetadata();
  const result = await execute();
  assert(!result.ok, `${label}: 요청이 거절되지 않았습니다.`);
  assert(result.code === expectedCode, `${label}: ${expectedCode} 대신 ${result.code}를 반환했습니다.`);
  assert(harness.store.getSnapshot() === before, `${label}: root pointer가 변경됐습니다.`);
  assert(harness.store.revision === before.revision, `${label}: revision이 변경됐습니다.`);
  assert(equivalent(harness.store.getSnapshot(), before), `${label}: state가 변경됐습니다.`);
  assert(equivalent(harness.bus.getSignalSnapshot(), signals), `${label}: event/effect journal이 변경됐습니다.`);
  assert(equivalent(harness.store.getCommandMetadata(), metadata), `${label}: command ID metadata가 변경됐습니다.`);
  assert(result.events.length === 0 && result.effects.length === 0, `${label}: 거절 결과에 signal이 있습니다.`);
  return result;
}

async function runCase(id, description, validates, execute) {
  try {
    const details = await execute();
    return Object.freeze({ id, description, validates, status: "PASS", details });
  } catch (error) {
    return Object.freeze({
      id,
      description,
      validates,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function exactHalfUpReference(numerator, denominator) {
  const signed = BigInt(numerator);
  const sign = signed < 0n ? -1n : 1n;
  const absolute = signed < 0n ? -signed : signed;
  const divisor = BigInt(denominator);
  const quotient = absolute / divisor;
  const remainder = absolute % divisor;
  return Number(sign * (quotient + (remainder * 2n >= divisor ? 1n : 0n)));
}

/** Deterministic examples. **Validates: Requirements 4.12** */
function halfUpExamples() {
  const examples = [
    [0, 2, 0], [1, 2, 1], [3, 2, 2], [1, 3, 0], [2, 3, 1],
    [-1, 2, -1], [-3, 2, -2], [-1, 3, 0], [-2, 3, -1],
  ];
  for (const [numerator, denominator, expected] of examples) {
    assert(divideHalfUp(numerator, denominator) === expected, `Half-Up ${numerator}/${denominator}가 ${expected}가 아닙니다.`);
  }
  assert(multiplyDivideHalfUp(5, 25, 10) === 13, "최종 12.5G Half-Up이 13G가 아닙니다.");
  assert(
    multiplyDivideHalfUp(Number.MAX_SAFE_INTEGER, 100, 100) === Number.MAX_SAFE_INTEGER,
    "BigInt intermediate를 사용한 safe final result가 보존되지 않았습니다.",
  );
  let overflowRejected = false;
  try {
    multiplyDivideHalfUp(Number.MAX_SAFE_INTEGER, 2, 1);
  } catch (error) {
    overflowRejected = error instanceof RangeError;
  }
  assert(overflowRejected, "Half-Up final overflow가 거절되지 않았습니다.");
  return { examples: examples.length + 3 };
}

/** Design Property 3 arithmetic sweep. **Validates: Requirements 4.12** */
function halfUpWideInvariant() {
  const samples = 4_096;
  for (let index = 1; index <= samples; index += 1) {
    const numerator = ((index * 104_729) % 2_000_003) - 1_000_001;
    const denominator = ((index * 7_919) % 997) + 1;
    const actual = divideHalfUp(numerator, denominator);
    const expected = exactHalfUpReference(numerator, denominator);
    assert(actual === expected, `Half-Up invariant sample ${index} 불일치`);
    assert(actual === -divideHalfUp(-numerator, denominator), `Half-Up sign symmetry sample ${index} 불일치`);
  }
  return { invariantSamples: samples };
}

/** Deterministic category examples. **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5** */
async function allLedgerCategoriesExample() {
  const categories = Object.values(LEDGER_CATEGORY);
  for (const category of categories) {
    const policy = CASH_TRANSACTION_POLICIES[category];
    let harness;
    let result;
    const transactionId = `qa:category:${category.toLowerCase()}`;
    if (category === LEDGER_CATEGORY.ARREARS_PAYMENT) {
      harness = createHarness({ economy: { cashG: 100, arrearsG: 20 }, consecutiveArrearsCount: 1 });
      result = await harness.api.payArrears(commandInput(harness, `${transactionId}:cmd`, specialPayload(7, transactionId)));
    } else if (category === LEDGER_CATEGORY.DEBT_PRINCIPAL) {
      harness = createHarness({ economy: { cashG: 100, debtG: 50 } });
      result = await harness.api.repayDebtPrincipal(commandInput(harness, `${transactionId}:cmd`, specialPayload(7, transactionId)));
    } else {
      harness = createHarness({
        runtimePhase: policy.phases[0],
        economy: {
          cashG: 100,
          contractReserveG: category === LEDGER_CATEGORY.CONTRACT_BALANCE ? 20 : 0,
        },
      });
      result = await harness.api.apply(commandInput(harness, `${transactionId}:cmd`, request(category, 7, transactionId)));
    }
    assert(result.ok, `${category} 예제 transaction이 실패했습니다: ${result.code}`);
    const entry = harness.store.getSnapshot().economy.ledger[0];
    assert(entry.category === category && entry.type === policy.type, `${category} category/type이 보존되지 않았습니다.`);
    assert(entry.direction === policy.direction && entry.amountG === 7, `${category} direction/amount가 잘못됐습니다.`);
    assert(entry.day === 1 && entry.causeId === `${transactionId}:cause`, `${category} day/Cause_Id가 잘못됐습니다.`);
  }
  return { categoryCount: categories.length };
}

/** Design Property 3 sweep. **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.12, 5.7** */
function cashSequenceWideReconciliation() {
  const beginningCashG = 500_000;
  const economy = cloneValue(createEconomyState({
    cashG: beginningCashG,
    contractReserveG: 50_000,
    debtG: 500,
  }));
  const categories = [
    LEDGER_CATEGORY.SALE,
    LEDGER_CATEGORY.MARKET,
    LEDGER_CATEGORY.CONTRACT_PREPAID,
    LEDGER_CATEGORY.CONTRACT_BALANCE,
    LEDGER_CATEGORY.STAFF_WAGE,
    LEDGER_CATEGORY.FIXED_COST,
    LEDGER_CATEGORY.FACILITY_INVESTMENT,
  ];
  const samples = 700;
  for (let index = 0; index < samples; index += 1) {
    const category = categories[index % categories.length];
    const policy = CASH_TRANSACTION_POLICIES[category];
    const amountG = (index * 37) % 113 + 1;
    if (category === LEDGER_CATEGORY.CONTRACT_BALANCE && economy.contractReserveG < amountG) {
      const reserve = applyContractReserveChangeToDraft(economy, {
        operation: CONTRACT_RESERVE_OPERATION.RESERVE,
        amountG: amountG + 1_000,
      });
      assert(reserve.ok, `sequence reserve ${index}가 실패했습니다: ${reserve.code}`);
    }
    const outcome = applyCashTransactionToDraft(
      economy,
      request(category, amountG, `qa:sequence:tx:${String(index).padStart(4, "0")}`),
      policy.phases[0],
    );
    assert(outcome.ok, `sequence ${index}가 실패했습니다: ${outcome.code}`);
    const stateValidation = validateEconomyState(economy);
    assert(stateValidation.ok, `sequence ${index} 뒤 economy invariant 실패: ${stateValidation.code}`);
    assert(calculateAvailableCashG(economy) >= 0, `sequence ${index} 뒤 Available_Cash가 음수입니다.`);
  }
  const reconciliation = reconcileCashWithLedger(beginningCashG, economy.cashG, economy.ledger);
  assert(reconciliation.ok, `wide sequence cash equation 실패: ${reconciliation.code}`);
  assert(economy.ledger.length === samples, "wide sequence ledger cardinality가 잘못됐습니다.");
  assert(new Set(economy.processedTransactionIds).size === samples, "wide sequence transaction ID가 유일하지 않습니다.");
  return { invariantSamples: samples, endingCashG: economy.cashG, reconciliation: reconciliation.code };
}

/** Design Property 2 rejection matrix. **Validates: Requirements 4.6, 4.7** */
async function invalidAmountRejectionMatrix() {
  const invalidValues = [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null, Number.MAX_SAFE_INTEGER + 1];
  for (let index = 0; index < invalidValues.length; index += 1) {
    const harness = createHarness({ economy: { cashG: 100 } });
    const payload = request(LEDGER_CATEGORY.MARKET, invalidValues[index], `qa:invalid:${index}`);
    await assertRejectedUnchanged(
      harness,
      () => harness.api.apply(commandInput(harness, `qa:invalid:cmd:${index}`, payload)),
      "INVALID_TRANSACTION_AMOUNT",
      `invalid amount ${index}`,
    );
  }
  return { rejectedInputs: invalidValues.length };
}

/** Design Property 2 duplicate guard. **Validates: Requirements 4.6, 4.7** */
async function duplicateTransactionRejection() {
  const harness = createHarness({ economy: { cashG: 100 } });
  const payload = request(LEDGER_CATEGORY.MARKET, 10, "qa:duplicate:tx");
  const first = await harness.api.apply(commandInput(harness, "qa:duplicate:cmd:1", payload));
  assert(first.ok, "duplicate setup transaction이 실패했습니다.");
  await assertRejectedUnchanged(
    harness,
    () => harness.api.apply(commandInput(harness, "qa:duplicate:cmd:2", payload)),
    "DUPLICATE_TRANSACTION_ID",
    "duplicate transaction ID",
  );
  assert(harness.store.getSnapshot().economy.ledger.length === 1, "duplicate가 ledger를 두 번 기록했습니다.");
  return { ledgerEntries: 1, committedEvents: harness.bus.getSignalSnapshot().events.length };
}

/** Design Property 2 overflow guard. **Validates: Requirements 4.6, 4.7, 4.12** */
async function overflowFullRejection() {
  const harness = createHarness({ runtimePhase: "SERVICE", economy: { cashG: Number.MAX_SAFE_INTEGER } });
  await assertRejectedUnchanged(
    harness,
    () => harness.api.apply(commandInput(
      harness,
      "qa:overflow:cmd",
      request(LEDGER_CATEGORY.SALE, 1, "qa:overflow:tx"),
    )),
    "CASH_OVERFLOW",
    "cash overflow",
  );
  return { cashG: Number.MAX_SAFE_INTEGER };
}

/** Reserve and Available_Cash guards. **Validates: Requirements 4.4, 4.6** */
async function reserveAndAvailableCashGuards() {
  const harness = createHarness({ economy: { cashG: 100, contractReserveG: 90 } });
  await assertRejectedUnchanged(
    harness,
    () => harness.api.apply(commandInput(
      harness,
      "qa:reserve:market:cmd",
      request(LEDGER_CATEGORY.MARKET, 11, "qa:reserve:market:tx"),
    )),
    "INSUFFICIENT_AVAILABLE_CASH",
    "reserved cash market guard",
  );
  await assertRejectedUnchanged(
    harness,
    () => harness.api.apply(commandInput(
      harness,
      "qa:reserve:balance:cmd",
      request(LEDGER_CATEGORY.CONTRACT_BALANCE, 91, "qa:reserve:balance:tx"),
    )),
    "INSUFFICIENT_CONTRACT_RESERVE",
    "contract balance reserve guard",
  );

  const economy = cloneValue(createEconomyState({ cashG: 100, contractReserveG: 90 }));
  const before = cloneValue(economy);
  const overReserve = applyContractReserveChangeToDraft(economy, {
    operation: CONTRACT_RESERVE_OPERATION.RESERVE,
    amountG: 11,
  });
  assert(!overReserve.ok && equivalent(economy, before), "reserve 초과 실패가 state를 변경했습니다.");
  const overRelease = applyContractReserveChangeToDraft(economy, {
    operation: CONTRACT_RESERVE_OPERATION.RELEASE,
    amountG: 91,
  });
  assert(!overRelease.ok && equivalent(economy, before), "reserve below-zero 실패가 state를 변경했습니다.");
  assert(applyContractReserveChangeToDraft(economy, {
    operation: CONTRACT_RESERVE_OPERATION.RESERVE,
    amountG: 10,
  }).ok, "Available_Cash 전액 reserve가 실패했습니다.");
  assert(calculateAvailableCashG(economy) === 0, "reserve 뒤 Available_Cash가 0이 아닙니다.");
  assert(applyContractReserveChangeToDraft(economy, {
    operation: CONTRACT_RESERVE_OPERATION.RELEASE,
    amountG: 100,
  }).ok, "reserve 전액 release가 실패했습니다.");
  assert(economy.contractReserveG === 0 && economy.ledger.length === 0, "reserve movement가 cash ledger를 만들었습니다.");
  return { cashG: economy.cashG, contractReserveG: economy.contractReserveG };
}

/** Arrears deterministic example. **Validates: Requirements 4.8, 4.9, 4.10, 4.11, 5.9, 17.2** */
async function arrearsPartialAndFullPayment() {
  const harness = createHarness({
    economy: { cashG: 100, contractReserveG: 20, arrearsG: 60, debtG: 500 },
    consecutiveArrearsCount: 1,
  });
  const accountingBefore = harness.store.getSnapshot().accounting;
  const partial = await harness.api.payArrears(commandInput(
    harness,
    "qa:arrears:partial:cmd",
    specialPayload(30, "qa:arrears:partial:tx"),
  ));
  assert(partial.ok, `partial Arrears payment 실패: ${partial.code}`);
  let snapshot = harness.store.getSnapshot();
  assert(snapshot.economy.cashG === 70 && snapshot.economy.arrearsG === 30, "partial payment 금액 이동이 잘못됐습니다.");
  assert(snapshot.campaign.consecutiveArrearsCount === 1, "partial payment가 consecutive count를 조기 reset했습니다.");
  assert(snapshot.accounting === accountingBefore, "Arrears payment가 expense/accounting slice를 변경했습니다.");

  const full = await harness.api.payArrears(commandInput(
    harness,
    "qa:arrears:full:cmd",
    specialPayload(30, "qa:arrears:full:tx"),
  ));
  assert(full.ok, `full Arrears payment 실패: ${full.code}`);
  snapshot = harness.store.getSnapshot();
  assert(snapshot.economy.cashG === 40 && snapshot.economy.arrearsG === 0, "full payment 금액 이동이 잘못됐습니다.");
  assert(snapshot.campaign.consecutiveArrearsCount === 0, "Arrears=0에서 consecutive count가 reset되지 않았습니다.");
  assert(snapshot.accounting === accountingBefore, "full payment가 expense를 재인식했습니다.");
  assert(snapshot.economy.ledger.length === 2, "Arrears ledger entry 수가 잘못됐습니다.");
  assert(full.events[0].payload.expenseRecognizedG === 0, "Arrears event가 expense 재인식을 표시했습니다.");
  return { endingCashG: snapshot.economy.cashG, endingArrearsG: 0, ledgerEntries: 2 };
}

/** Arrears rejection guards. **Validates: Requirements 4.6, 4.7, 4.9** */
async function arrearsInvalidRejections() {
  const tooMuch = createHarness({ economy: { cashG: 100, contractReserveG: 20, arrearsG: 60 } });
  await assertRejectedUnchanged(
    tooMuch,
    () => tooMuch.api.payArrears(commandInput(tooMuch, "qa:arrears:max:cmd", specialPayload(61, "qa:arrears:max:tx"))),
    "ARREARS_PAYMENT_EXCEEDS_MAXIMUM",
    "Arrears amount maximum",
  );
  const noAvailable = createHarness({ economy: { cashG: 100, contractReserveG: 100, arrearsG: 10 } });
  await assertRejectedUnchanged(
    noAvailable,
    () => noAvailable.api.payArrears(commandInput(noAvailable, "qa:arrears:available:cmd", specialPayload(1, "qa:arrears:available:tx"))),
    "ARREARS_PAYMENT_EXCEEDS_MAXIMUM",
    "Arrears Available_Cash",
  );
  const zero = createHarness({ economy: { cashG: 100, arrearsG: 10 } });
  await assertRejectedUnchanged(
    zero,
    () => zero.api.payArrears(commandInput(zero, "qa:arrears:zero:cmd", specialPayload(0, "qa:arrears:zero:tx"))),
    "INVALID_TRANSACTION_AMOUNT",
    "Arrears zero amount",
  );
  const service = createHarness({ runtimePhase: "SERVICE", economy: { cashG: 100, arrearsG: 10 } });
  await assertRejectedUnchanged(
    service,
    () => service.api.payArrears(commandInput(service, "qa:arrears:phase:cmd", specialPayload(1, "qa:arrears:phase:tx"))),
    "ILLEGAL_PHASE",
    "Arrears phase",
  );
  return { rejectedGuards: 4 };
}

/** Debt principal guard and UI projection. **Validates: Requirements 4.8, 4.9** */
async function debtBlockedByArrearsAndProjection() {
  const harness = createHarness({ economy: { cashG: 100, arrearsG: 1, debtG: 500 } });
  await assertRejectedUnchanged(
    harness,
    () => harness.api.repayDebtPrincipal(commandInput(
      harness,
      "qa:debt:blocked:cmd",
      specialPayload(1, "qa:debt:blocked:tx"),
    )),
    "ARREARS_DEBT_PRINCIPAL_BLOCKED",
    "debt principal Arrears guard",
  );
  const projection = projectEconomy(harness.store.getSnapshot().economy, "PLANNING");
  assert(!projection.controls.debtPrincipalPayment.enabled, "Arrears>0 UI debt control이 enabled입니다.");
  assert(
    projection.controls.debtPrincipalPayment.disabledReason === "ARREARS_DEBT_PRINCIPAL_BLOCKED",
    "UI debt disabled reason이 API guard와 다릅니다.",
  );
  assert(projection.controls.arrearsPayment.enabled && projection.controls.arrearsPayment.maximumG === 1, "Arrears payment UI projection이 잘못됐습니다.");
  return { debtDisabledReason: projection.controls.debtPrincipalPayment.disabledReason };
}

/** Debt success example. **Validates: Requirements 4.2, 4.3, 4.5, 4.8** */
async function debtPrincipalSuccess() {
  const harness = createHarness({ economy: { cashG: 100, contractReserveG: 20, debtG: 50 } });
  const result = await harness.api.repayDebtPrincipal(commandInput(
    harness,
    "qa:debt:success:cmd",
    specialPayload(40, "qa:debt:success:tx"),
  ));
  assert(result.ok, `debt principal payment 실패: ${result.code}`);
  const economy = harness.store.getSnapshot().economy;
  assert(economy.cashG === 60 && economy.debtG === 10 && economy.contractReserveG === 20, "debt payment state가 잘못됐습니다.");
  assert(economy.ledger[0].category === LEDGER_CATEGORY.DEBT_PRINCIPAL, "debt ledger category가 잘못됐습니다.");
  assert(calculateAvailableCashG(economy) === 40, "debt payment 뒤 Available_Cash가 잘못됐습니다.");
  return { endingCashG: economy.cashG, endingDebtG: economy.debtG };
}

/** Append-only and drill-down example. **Validates: Requirements 4.2, 4.3, 4.5, 5.14** */
function appendOnlyAndDrillDown() {
  const economy = cloneValue(createEconomyState({ cashG: 100 }));
  const first = applyCashTransactionToDraft(
    economy,
    request(LEDGER_CATEGORY.MARKET, 10, "qa:index:tx:1", "qa:index:cause:shared"),
    "PLANNING",
  );
  assert(first.ok, "drill-down first transaction 실패");
  const beforeSecond = cloneValue(economy);
  const second = applyCashTransactionToDraft(
    economy,
    request(LEDGER_CATEGORY.FACILITY_INVESTMENT, 5, "qa:index:tx:2", "qa:index:cause:shared"),
    "PLANNING",
  );
  assert(second.ok, "drill-down second transaction 실패");
  const index = buildLedgerDrillDownIndex(economy.ledger);
  assert(index.byTransactionId["qa:index:tx:1"].amountG === 10, "transaction drill-down이 잘못됐습니다.");
  assert(index.byCauseId["qa:index:cause:shared"].length === 2, "Cause_Id drill-down이 잘못됐습니다.");
  const projection = projectEconomyLedger(economy, { day: 1 });
  assert(projection.entries.length === 2 && projection.summary.outflowG === 15, "ledger projection 합계가 잘못됐습니다.");

  const corrupted = cloneValue(economy);
  corrupted.ledger[0].amountG = 11;
  const transition = validateEconomyTransition(beforeSecond, corrupted);
  assert(!transition.ok && transition.code === "LEDGER_HISTORY_MUTATED", "append-only history mutation을 탐지하지 못했습니다.");
  return { entries: projection.entries.length, causeLinks: index.byCauseId["qa:index:cause:shared"].length };
}

/** Invalid state and phase/type guards. **Validates: Requirements 4.6, 4.7** */
async function malformedStateAndPolicyRejection() {
  const wrongPhase = createHarness({ runtimePhase: "SERVICE", economy: { cashG: 100 } });
  await assertRejectedUnchanged(
    wrongPhase,
    () => wrongPhase.api.apply(commandInput(
      wrongPhase,
      "qa:policy:phase:cmd",
      request(LEDGER_CATEGORY.MARKET, 1, "qa:policy:phase:tx"),
    )),
    "ILLEGAL_CASH_TRANSACTION_PHASE",
    "category phase policy",
  );
  const wrongType = createHarness({ economy: { cashG: 100 } });
  const payload = request(LEDGER_CATEGORY.MARKET, 1, "qa:policy:type:tx");
  payload.type = "SALE_REVENUE";
  await assertRejectedUnchanged(
    wrongType,
    () => wrongType.api.apply(commandInput(wrongType, "qa:policy:type:cmd", payload)),
    "LEDGER_TYPE_MISMATCH",
    "category type policy",
  );
  const invalidState = {
    cashG: 10,
    contractReserveG: 11,
    debtG: 0,
    arrearsG: 0,
    contractPrepaidAssetG: 0,
    ledger: [],
    processedTransactionIds: [],
  };
  const validation = validateEconomyState(invalidState);
  assert(!validation.ok && validation.code === "CONTRACT_RESERVE_EXCEEDS_CASH", "invalid reserve state를 탐지하지 못했습니다.");
  return { guards: 3 };
}

export async function runEconomyProbe() {
  const definitions = [
    ["half-up-deterministic-examples", "safe-integer Half-Up 경계 예제", ["4.12"], halfUpExamples],
    ["half-up-wide-invariant", "넓은 signed rational Half-Up invariant", ["4.12"], halfUpWideInvariant],
    ["all-ledger-categories", "모든 cash-flow category/type/day/Cause_Id", ["4.1", "4.2", "4.3", "4.4", "4.5"], allLedgerCategoriesExample],
    ["cash-sequence-wide-reconciliation", "700개 승인 sequence cash/ledger 대사", ["4.1", "4.2", "4.4", "4.5", "4.12", "5.7"], cashSequenceWideReconciliation],
    ["invalid-amount-full-rejection", "0·음수·fraction·non-finite·unsafe amount 전면 거절", ["4.6", "4.7"], invalidAmountRejectionMatrix],
    ["duplicate-transaction-full-rejection", "중복 transaction ID 전면 거절", ["4.6", "4.7"], duplicateTransactionRejection],
    ["overflow-full-rejection", "cash safe-integer overflow 전면 거절", ["4.6", "4.7", "4.12"], overflowFullRejection],
    ["reserve-available-cash-guards", "reserve 음수·Available_Cash 침범 방지", ["4.4", "4.6"], reserveAndAvailableCashGuards],
    ["arrears-partial-full-no-expense", "Planning Arrears 납부·비용 불변·count reset", ["4.9", "4.10", "4.11", "5.9", "17.2"], arrearsPartialAndFullPayment],
    ["arrears-invalid-full-rejection", "Arrears amount/phase/available guard", ["4.6", "4.7", "4.9"], arrearsInvalidRejections],
    ["debt-blocked-by-arrears-ui", "Arrears debt principal API/UI guard", ["4.8", "4.9"], debtBlockedByArrearsAndProjection],
    ["debt-principal-success", "승인 debt principal cash/ledger 원자 변경", ["4.2", "4.3", "4.5", "4.8"], debtPrincipalSuccess],
    ["append-only-ledger-drilldown", "append-only 원장과 transaction/Cause drill-down", ["4.2", "4.3", "4.5", "5.14"], appendOnlyAndDrillDown],
    ["malformed-state-policy-rejection", "invalid state와 category phase/type 전면 거절", ["4.6", "4.7"], malformedStateAndPolicyRejection],
  ];
  const results = [];
  for (const [id, description, validates, execute] of definitions) {
    results.push(await runCase(id, description, validates, execute));
  }
  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({
    qaId: "task-13-economy-invariants",
    status: passed === results.length ? "PASS" : "FAIL",
    passed,
    total: results.length,
    deterministicExampleCount: 9 + Object.values(LEDGER_CATEGORY).length,
    broadInvariantSampleCount: 4_096 + 700,
    rejectedInputCount: 9 + 1 + 1 + 2 + 4 + 1 + 2,
    results: Object.freeze(results),
  });
}
