#!/usr/bin/env node
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runEconomyProbe } from "../js/qa/economy-probe.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const supportedArguments = new Set(["--json"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !supportedArguments.has(argument));

function staticResult(id, description, condition, details = undefined) {
  return Object.freeze({
    id,
    description,
    status: condition ? "PASS" : "FAIL",
    ...(details === undefined ? {} : { details }),
    ...(!condition ? { error: description } : {}),
  });
}

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && extname(entry.name) === ".js") files.push(path);
  }
  return files;
}

async function runStaticAudit() {
  const paths = {
    money: resolve(repositoryRoot, "js/core/money.js"),
    economy: resolve(repositoryRoot, "js/domain/economy.js"),
    api: resolve(repositoryRoot, "js/domain/cash-transaction-api.js"),
    ledger: resolve(repositoryRoot, "js/domain/economy-ledger.js"),
    qa: resolve(repositoryRoot, "js/qa/economy-probe.js"),
    bootstrap: resolve(repositoryRoot, "js/app/bootstrap.js"),
  };
  const sourceEntries = await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(path, "utf8")]));
  const source = Object.fromEntries(sourceEntries);
  const deterministicSource = [source.money, source.economy, source.api, source.ledger];
  const forbidden = ["document.", "window.", "localStorage", "AudioContext", "Math.random(", "Date.now(", "performance.now("];
  const forbiddenViolations = forbidden.filter((token) => deterministicSource.some((text) => text.includes(token)));

  const productionFiles = (await javascriptFiles(resolve(repositoryRoot, "js")))
    .filter((path) => !path.includes(`${resolve(repositoryRoot, "js/qa")}`));
  const cashWritePattern = /(?:\.cashG|\[\s*["']cashG["']\s*\])\s*(?:=|\+=|-=|\*=|\/=|\+\+|--)/g;
  const cashWrites = [];
  for (const path of productionFiles) {
    const text = await readFile(path, "utf8");
    const matches = [...text.matchAll(cashWritePattern)];
    for (const match of matches) {
      cashWrites.push({ file: relative(repositoryRoot, path).replaceAll("\\", "/"), expression: match[0] });
    }
  }
  const unauthorizedCashWrites = cashWrites.filter((write) => write.file !== "js/domain/cash-transaction-api.js");

  const results = Object.freeze([
    staticResult(
      "static-domain-isolation",
      "money/economy/ledger/API는 browser·wall-clock·nondeterministic primitive를 사용하지 않는다",
      forbiddenViolations.length === 0,
      { violations: forbiddenViolations },
    ),
    staticResult(
      "static-single-cash-writer",
      "production cashG assignment는 CashTransactionAPI에만 존재한다",
      cashWrites.length > 0 && unauthorizedCashWrites.length === 0,
      { cashWrites, unauthorizedCashWrites },
    ),
    staticResult(
      "static-atomic-command-wiring",
      "세 cash command가 AtomicTransaction으로 등록되고 AppBootstrap production CommandBus에 배선된다",
      source.api.includes("defineAtomicTransaction({") &&
        source.api.includes("commandBus.register(CASH_TRANSACTION_COMMAND.APPLY") &&
        source.api.includes("CASH_TRANSACTION_COMMAND.PAY_ARREARS") &&
        source.api.includes("CASH_TRANSACTION_COMMAND.REPAY_DEBT_PRINCIPAL") &&
        source.bootstrap.includes("registerCashTransactionAPI") &&
        source.bootstrap.includes("this.cashTransactionAPI = registerCashTransactionAPI(this.commandBus)"),
    ),
    staticResult(
      "static-append-only-ledger",
      "EconomyLedger는 새 배열 append와 prefix 검증을 사용하고 destructive history API를 사용하지 않는다",
      source.ledger.includes("validateLedgerAppendOnly") &&
        source.ledger.includes("[...economy.ledger, entry]") &&
        !source.ledger.includes(".splice(") &&
        !source.ledger.includes(".shift(") &&
        !source.ledger.includes(".pop("),
    ),
    staticResult(
      "static-safe-integer-half-up",
      "Half-Up은 BigInt intermediate와 safe final guard를 사용하며 floating formatting을 사용하지 않는다",
      source.money.includes("BigInt(value) * BigInt(multiplier)") &&
        source.money.includes("safeBigIntToNumber") &&
        !source.money.includes("Math.round(") &&
        !source.money.includes("toFixed("),
    ),
    staticResult(
      "static-requirement-linked-invariants",
      "Task 13 QA에 Requirement link와 Design Property 2/3 invariant sweep가 포함된다",
      source.qa.includes("**Validates: Requirements 4.12**") &&
        source.qa.includes("Design Property 2") &&
        source.qa.includes("Design Property 3") &&
        source.qa.includes("cashSequenceWideReconciliation"),
    ),
  ]);
  const passed = results.filter((result) => result.status === "PASS").length;
  return Object.freeze({ status: passed === results.length ? "PASS" : "FAIL", passed, total: results.length, results });
}

async function run() {
  const [economy, staticAudit] = await Promise.all([runEconomyProbe(), runStaticAudit()]);
  return Object.freeze({
    status: economy.status === "PASS" && staticAudit.status === "PASS" ? "PASS" : "FAIL",
    economy,
    staticAudit,
  });
}

if (unknownArguments.length > 0) {
  console.error(`지원하지 않는 인자입니다: ${unknownArguments.join(", ")}`);
  process.exitCode = 2;
} else {
  const report = await run();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Economy validation: ${report.status}`);
    console.log(`Task 13 examples/invariants: ${report.economy.status} (${report.economy.passed}/${report.economy.total})`);
    console.log(`  deterministic examples: ${report.economy.deterministicExampleCount}`);
    console.log(`  broad invariant samples: ${report.economy.broadInvariantSampleCount}`);
    console.log(`  rejected inputs/guards: ${report.economy.rejectedInputCount}`);
    for (const result of report.economy.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
    console.log(`Task 13 static contracts: ${report.staticAudit.status} (${report.staticAudit.passed}/${report.staticAudit.total})`);
    for (const result of report.staticAudit.results) {
      console.log(`${result.status}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  if (report.status !== "PASS") process.exitCode = 1;
}
