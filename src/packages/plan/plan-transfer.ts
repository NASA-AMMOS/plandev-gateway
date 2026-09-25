import Ajv from 'ajv';
import { planTransferSchema } from '../../schemas/plan-transfer-validation-schema.js';
import type { PlanTransfer, SimulationResultsTransfer } from '../../types/plan-transfer.js';

/**
 * Compatibility boundary for uploaded plan files.
 *
 * Older supported PlanTransfer versions are migrated to the current
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
function migratePlanTransfer(input: unknown): JsonObject {
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

  const transfer = migrated as PlanTransfer;
  assertSpansConsistent(transfer);

  return transfer;
}

/**
 * Checks the rules between `results.spans` that the schema cannot express, so a bad file fails before anything is
 * created:
 *   - `span_id`s are unique, and each directive has at most one span
 *   - a span with a `directive_id` is a root: it references an activity in this file and has no `parent_id`
 *   - every `parent_id` chain ends at a root, without dangling references or loops
 * A span with neither (e.g. one spawned by model code) is a root that no directive owns.
 */
function assertSpansConsistent({ activities, results }: PlanTransfer): void {
  if (results === undefined) {
    return;
  }

  const activityIds = new Set(activities.map(({ id }) => id));
  const parentOf = new Map<number, number | undefined>();
  const spanOfDirective = new Map<number, number>();

  for (const { directive_id, parent_id, span_id } of results.spans) {
    if (parentOf.has(span_id)) {
      throw new UnsupportedPlanTransferError(`Result span id ${span_id} is used more than once.`);
    }
    parentOf.set(span_id, parent_id);

    if (directive_id === undefined) {
      continue;
    }
    if (parent_id !== undefined) {
      throw new UnsupportedPlanTransferError(
        `Result span ${span_id} has both a directive_id and a parent_id; a directive's span must be a root.`,
      );
    }
    if (!activityIds.has(directive_id)) {
      throw new UnsupportedPlanTransferError(
        `Result span ${span_id} references directive ${directive_id}, which is not an activity in this plan file.`,
      );
    }
    const otherSpan = spanOfDirective.get(directive_id);
    if (otherSpan !== undefined) {
      throw new UnsupportedPlanTransferError(
        `Result spans ${otherSpan} and ${span_id} both reference directive ${directive_id}.`,
      );
    }
    spanOfDirective.set(directive_id, span_id);
  }

  // Each chain is walked once: spans already known to reach a root end the walk early.
  const reachesRoot = new Set<number>();
  for (const start of parentOf.keys()) {
    const chain = new Set<number>();
    for (let id: number | undefined = start; id !== undefined && !reachesRoot.has(id); id = parentOf.get(id)) {
      if (!parentOf.has(id)) {
        throw new UnsupportedPlanTransferError(
          `A result span's parent_id references span ${id}, which is not in the results.`,
        );
      }
      if (chain.has(id)) {
        throw new UnsupportedPlanTransferError(`Result span ${id}'s parent_id chain loops back on itself.`);
      }
      chain.add(id);
    }
    chain.forEach(id => reachesRoot.add(id));
  }
}

/**
 * Rewrites `results.spans[].directive_id` from the transfer's activity ids to the ids the activities were given
 * on import. Spans without a directive (simulated, generated, decomposed) pass through unchanged, and `span_id` /
 * `parent_id` stay in the results' own namespace. Profiles are shared with the input, not copied.
 *
 * `parsePlanTransfer` has already checked every `directive_id` is an activity in the file; the check here only
 * guards against an incomplete `activityIdMap`.
 */
export function remapResultDirectiveIds(
  results: SimulationResultsTransfer,
  activityIdMap: Record<number, number>,
): SimulationResultsTransfer {
  const spans = results.spans.map(span => {
    if (span.directive_id === undefined) {
      return span;
    }

    const directiveId = activityIdMap[span.directive_id];
    if (directiveId === undefined) {
      throw new UnsupportedPlanTransferError(
        `Result span ${span.span_id} references directive ${span.directive_id}, which is not an activity in this plan file.`,
      );
    }

    return { ...span, directive_id: directiveId };
  });

  return { ...results, spans };
}
