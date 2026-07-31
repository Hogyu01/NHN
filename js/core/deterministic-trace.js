function requireTraceList(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field}는 trace 배열이어야 합니다.`);
  return value;
}

function valueText(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "-";
  return String(value);
}

function uint32Hex(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) return "????????";
  return value.toString(16).padStart(8, "0");
}

export function formatSchedulerTrace(trace) {
  return requireTraceList(trace, "scheduler trace").map((record) => [
    `[scheduler#${valueText(record.traceSequence)}]`,
    `action=${valueText(record.action)}`,
    `t=${valueText(record.simulationTimeMs)}`,
    `priority=${valueText(record.priority)}`,
    `sequence=${valueText(record.insertionSequence)}`,
    `stableId=${valueText(record.stableId)}`,
    `generation=${valueText(record.generationId)}`,
    `class=${valueText(record.eventClass)}`,
    `reason=${valueText(record.reason)}`,
  ].join(" ")).join("\n");
}

export function formatRngTrace(trace) {
  return requireTraceList(trace, "RNG trace").map((record) => {
    const words = Array.isArray(record.wordsAfter)
      ? record.wordsAfter.map(uint32Hex).join(",")
      : "-";
    const fields = [
      `[rng#${valueText(record.traceSequence)}]`,
      `stream=${valueText(record.stream)}`,
      `operation=${valueText(record.operation)}`,
      `draws=${valueText(record.drawCountBefore)}->${valueText(record.drawCountAfter)}`,
      `value=${valueText(record.value)}`,
    ];
    if (record.roll !== undefined) fields.push(`roll=${valueText(record.roll)}`);
    if (record.percentage !== undefined) fields.push(`percentage=${valueText(record.percentage)}`);
    if (record.upperExclusive !== undefined) fields.push(`upper=${valueText(record.upperExclusive)}`);
    fields.push(`rejected=${valueText(record.rejectedDraws)}`, `words=${words}`);
    return fields.join(" ");
  }).join("\n");
}

export function formatDeterministicTrace({ scheduler = [], rng = [] } = {}) {
  const schedulerText = formatSchedulerTrace(scheduler);
  const rngText = formatRngTrace(rng);
  return [schedulerText, rngText].filter((text) => text.length > 0).join("\n");
}
