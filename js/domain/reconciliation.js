import { validationFailure, validationSuccess } from "../core/result.js";
import { checkedAddG } from "../core/money.js";
import { LEDGER_DIRECTION } from "./economy-ledger.js";
import { COST_MOVEMENT_TYPE } from "./inventory-accounting.js";

const MESSAGE_BY_CODE = Object.freeze({
  CASH_RECONCILIATION_MISMATCH: "당일 현금 원장 합계가 현금 잔액 변화와 일치하지 않습니다.",
  INVENTORY_RECONCILIATION_MISMATCH: "당일 재고 원가 이동 합계가 회계 누적치와 일치하지 않습니다.",
});

function failure(code, details = undefined) {
  return validationFailure(code, [], {
    message: MESSAGE_BY_CODE[code] ?? "대사 검증에 실패했습니다.",
    ...(details && typeof details === "object" ? details : {}),
  });
}

/**
 * 당일 원장(economy.ledger)만 독립적으로 다시 합산해, economy 상태가 누적해 온
 * inflow/outflow 합계와 일치하는지 대사한다. Requirement 4.5, 5.7, 5.11.
 */
export function reconcileCash(economy, day) {
  let inflowG = 0;
  let outflowG = 0;
  for (const entry of economy.ledger) {
    if (entry.day !== day) continue;
    if (entry.direction === LEDGER_DIRECTION.INFLOW) {
      inflowG = checkedAddG(inflowG, entry.amountG, "reconcileCash inflow");
    } else {
      outflowG = checkedAddG(outflowG, entry.amountG, "reconcileCash outflow");
    }
  }
  const netCashChangeG = inflowG - outflowG;
  return { ok: true, plan: { inflowG, outflowG, netCashChangeG } };
}

const WASTE_TYPES = new Set([COST_MOVEMENT_TYPE.ESCROW_TO_WASTE, COST_MOVEMENT_TYPE.DISH_TO_WASTE]);

/**
 * 당일 원가 이동(costMovements)만 독립적으로 다시 합산해, inventoryAccounting이
 * 누적해 온 marketAcquisitionG/successfulContractAcquisitionG/cogsG/cookingWasteExpenseG와
 * 일치하는지 대사한다. Requirement 5.10, 5.11.
 */
export function reconcileInventory(inventoryAccounting, day) {
  const totals = {
    marketAcquisitionG: 0,
    successfulContractAcquisitionG: 0,
    cogsG: 0,
    cookingWasteExpenseG: 0,
  };
  for (const movement of inventoryAccounting.costMovements) {
    if (movement.day !== day) continue;
    if (movement.type === COST_MOVEMENT_TYPE.MARKET_ACQUISITION) {
      totals.marketAcquisitionG = checkedAddG(totals.marketAcquisitionG, movement.amountG, "reconcileInventory market");
    } else if (movement.type === COST_MOVEMENT_TYPE.CONTRACT_ACQUISITION) {
      totals.successfulContractAcquisitionG =
        checkedAddG(totals.successfulContractAcquisitionG, movement.amountG, "reconcileInventory contract");
    } else if (movement.type === COST_MOVEMENT_TYPE.DISH_TO_COGS) {
      totals.cogsG = checkedAddG(totals.cogsG, movement.amountG, "reconcileInventory cogs");
    } else if (WASTE_TYPES.has(movement.type)) {
      totals.cookingWasteExpenseG = checkedAddG(totals.cookingWasteExpenseG, movement.amountG, "reconcileInventory waste");
    }
  }
  return { ok: true, plan: totals };
}

/**
 * 독립 재집계 결과가 accounting/economy가 유지해 온 누적치와 정확히 일치하는지 확인한다.
 * 하나라도 어긋나면 결산을 봉인하지 않는다 (Requirement 5.11).
 */
export function verifyDaySettlementReconciliation({ economy, inventoryAccounting, day }) {
  const cash = reconcileCash(economy, day);
  const inventory = reconcileInventory(inventoryAccounting, day);
  if (inventoryAccounting.marketAcquisitionG !== inventory.plan.marketAcquisitionG ||
      inventoryAccounting.successfulContractAcquisitionG !== inventory.plan.successfulContractAcquisitionG ||
      inventoryAccounting.cogsG !== inventory.plan.cogsG ||
      inventoryAccounting.cookingWasteExpenseG !== inventory.plan.cookingWasteExpenseG) {
    return failure("INVENTORY_RECONCILIATION_MISMATCH", {
      accumulated: {
        marketAcquisitionG: inventoryAccounting.marketAcquisitionG,
        successfulContractAcquisitionG: inventoryAccounting.successfulContractAcquisitionG,
        cogsG: inventoryAccounting.cogsG,
        cookingWasteExpenseG: inventoryAccounting.cookingWasteExpenseG,
      },
      recomputed: inventory.plan,
    });
  }
  return validationSuccess({ cash: cash.plan, inventory: inventory.plan });
}
