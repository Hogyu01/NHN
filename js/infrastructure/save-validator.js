import { DataValidator, VALIDATION_BOUNDARY } from "./data-validator.js";
import { createDefaultSchemaRegistry, DATA_SCHEMA } from "./schema-registry.js";

const SAVE_STORAGE_KEY = "dungeonRestaurant.save.current";

/**
 * Task 27 — 이미 구현된 DataValidator/SAVE_STATE_CORE_V1(schema-registry.js, "save-core"
 * invariant)을 그대로 재사용해 save payload의 field·type·ID·range·reference·invariant를
 * 검사한다. 여기서는 새 검사 규칙을 만들지 않고 배선만 한다.
 */
export function validateSavePayload(payload, { storageKey = SAVE_STORAGE_KEY } = {}) {
  const validator = new DataValidator({ registry: createDefaultSchemaRegistry() });
  const report = validator.validate({
    storageKey,
    schemaName: DATA_SCHEMA.SAVE_STATE_CORE_V1,
    boundary: VALIDATION_BOUNDARY.SAVE,
    data: payload,
  });
  return report;
}
