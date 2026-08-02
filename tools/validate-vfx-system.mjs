#!/usr/bin/env node
import { runVfxSystemProbe } from "../js/qa/vfx-system-probe.js";

const asJson = process.argv.includes("--json");

async function main() {
  const report = await runVfxSystemProbe();
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`VfxSystem validation: ${report.status} (${report.passed}/${report.total})`);
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
