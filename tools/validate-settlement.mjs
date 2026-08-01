#!/usr/bin/env node
import { runSettlementProbe } from "../js/qa/settlement-probe.js";

const asJson = process.argv.includes("--json");

async function main() {
  const report = await runSettlementProbe();
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Settlement validation: ${report.status}`);
    console.log(`Task 23 examples: ${report.status} (${report.passed}/${report.total})`);
    for (const result of report.results) {
      console.log(`${result.status === "PASS" ? "PASS" : "FAIL"}  ${result.id}${result.error ? ` — ${result.error}` : ""}`);
    }
  }
  process.exit(report.status === "PASS" ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
