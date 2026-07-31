import { freezeDeep } from "../core/result.js";
import {
  CANONICAL_CONTENT_FILE_CONTRACTS,
  DATA_SCHEMA,
} from "./schema-registry.js";
import { VALIDATION_BOUNDARY } from "./data-validator.js";

export const CANONICAL_CONTENT_MANIFEST_SPECIFICATION = freezeDeep({
  filename: "data/content-manifest.json",
  schemaName: DATA_SCHEMA.CONTENT_MANIFEST_V1,
  boundary: VALIDATION_BOUNDARY.STATIC_REQUIRED,
});

export const CANONICAL_CONTENT_SPECIFICATIONS = freezeDeep([
  ...CANONICAL_CONTENT_FILE_CONTRACTS.map((contract) => ({
    filename: contract.filename,
    schemaName: contract.schemaName,
    boundary: VALIDATION_BOUNDARY.STATIC_REQUIRED,
  })),
  CANONICAL_CONTENT_MANIFEST_SPECIFICATION,
]);

export const CANONICAL_MIGRATION_REPORT_SPECIFICATION = freezeDeep({
  filename: "reports/canonical-data-migration.json",
  schemaName: DATA_SCHEMA.CANONICAL_MIGRATION_REPORT_V1,
  boundary: VALIDATION_BOUNDARY.STATIC_REQUIRED,
});

export const CANONICAL_VALIDATION_SPECIFICATIONS = freezeDeep([
  ...CANONICAL_CONTENT_SPECIFICATIONS,
  CANONICAL_MIGRATION_REPORT_SPECIFICATION,
]);

export function canonicalSpecificationByFilename(filename) {
  const specification = CANONICAL_VALIDATION_SPECIFICATIONS.find(
    (candidate) => candidate.filename === filename,
  );
  if (!specification) throw new RangeError(`등록되지 않은 canonical filename입니다: ${filename}`);
  return specification;
}
