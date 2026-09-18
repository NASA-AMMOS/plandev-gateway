import Ajv from 'ajv';
import { planTransferSchema } from '../../schemas/plan-transfer-validation-schema.js';
import type { PlanTransfer } from '../../types/plan-transfer.js';

/**
 * Compatibility boundary for uploaded plan files.
 *
 * Older supported PlanTransfer versions are migrated to the current canonical
 * version and only then validated against its schema, so the rest of the
 * gateway only ever sees a current PlanTransfer.
 *
 *   raw JSON -> migrate -> validate -> PlanTransfer
 *
 * Supported inputs:
 *   v3           canonical
 *   v2           previous version; structurally a subset of v3
 *   versionless  pre-version export using the same shape as v2
 */

export const CURRENT_PLAN_TRANSFER_VERSION = '3';

const ajv = new Ajv({ allErrors: true });
const validatePlanTransfer = ajv.compile(planTransferSchema);

export class UnsupportedPlanTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedPlanTransferError';
  }
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * v2 is structurally a subset of v3, so the migration is the version bump
 * itself. A file claiming v2 must not carry fields that only exist in v3.
 */
function migrateV2ToV3(input: JsonObject): JsonObject {
  for (const field of ['model', 'results'] as const) {
    if (input[field] !== undefined) {
      throw new UnsupportedPlanTransferError(`'${field}' requires PlanTransfer version '3'.`);
    }
  }

  return { ...input, version: '3' };
}

/**
 * Migrates a supported plan file to the current canonical version. The result is
 * not yet trusted — `parsePlanTransfer` validates it before returning.
 *
 * To add v4 later, each case migrates through to the current version, e.g.
 * `case '2': return migrateV3ToV4(migrateV2ToV3(input))`.
 */
export function migratePlanTransfer(input: unknown): JsonObject {
  if (!isObject(input)) {
    throw new UnsupportedPlanTransferError('Plan file must contain a JSON object.');
  }

  const { version } = input;
  // Pre-version exports used the same plan shape that v2 later declared.
  const sourceVersion = version === undefined ? '2' : version;

  switch (sourceVersion) {
    case '2':
      return migrateV2ToV3(input);
    case '3':
      return input;
    default:
      throw new UnsupportedPlanTransferError(`Unsupported PlanTransfer version '${version}'.`);
  }
}

/**
 * Parses an uploaded plan file of any supported version into the current
 * canonical PlanTransfer. Throws UnsupportedPlanTransferError if the file cannot
 * be migrated or the migrated result does not satisfy the canonical schema.
 */
export function parsePlanTransfer(input: unknown): PlanTransfer {
  const migrated = migratePlanTransfer(input);

  if (!validatePlanTransfer(migrated)) {
    const details = (validatePlanTransfer.errors ?? []).map(({ dataPath, message }) => `${dataPath || '/'} ${message}`);
    throw new UnsupportedPlanTransferError(`Plan file is not a valid PlanTransfer v3: ${details.join('; ')}`);
  }

  return migrated as PlanTransfer;
}
