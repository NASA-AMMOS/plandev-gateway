import Ajv from 'ajv';
import { planTransferSchema } from '../../schemas/plan-transfer-validation-schema.js';
import type { PlanTransfer, SimulationResultsTransfer } from '../../types/plan-transfer.js';

const ajv = new Ajv({ allErrors: true });
const validatePlanTransfer = ajv.compile(planTransferSchema);

/**
 * Migrates a v3, v2 or versionless (v2-shaped) plan file to v3. v2 is a subset of v3, so migrating is the version bump.
 */
function migratePlanTransfer(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Plan file must contain a JSON object.');
  }

  const { version } = input as Record<string, unknown>;
  if (version === '3') {
    return input as Record<string, unknown>;
  }
  if (version !== undefined && version !== '2') {
    throw new Error(`Unsupported PlanTransfer version '${version}'.`);
  }
  for (const field of ['model', 'results']) {
    if (field in input) {
      throw new Error(`'${field}' requires PlanTransfer version '3'.`);
    }
  }
  return { ...input, version: '3' };
}

/** Parses an uploaded plan file of any supported version into a validated v3 PlanTransfer. */
export function parsePlanTransfer(input: unknown): PlanTransfer {
  const migrated = migratePlanTransfer(input);

  if (!validatePlanTransfer(migrated)) {
    const details = (validatePlanTransfer.errors ?? []).map(({ dataPath, message }) => `${dataPath || '/'} ${message}`);
    throw new Error(`Plan file is not a valid PlanTransfer v3: ${details.join('; ')}`);
  }

  const transfer = migrated as PlanTransfer;
  assertActivityIdsUnique(transfer);
  assertSpansConsistent(transfer);

  return transfer;
}

/** Activity ids are file-local keys used by anchors and result spans, so they must be unambiguous. */
function assertActivityIdsUnique({ activities }: PlanTransfer): void {
  const seen = new Set<number>();
  for (const { id } of activities) {
    if (seen.has(id)) {
      throw new Error(`Activity id ${id} is used more than once.`);
    }
    seen.add(id);
  }
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
      throw new Error(`Result span id ${span_id} is used more than once.`);
    }
    parentOf.set(span_id, parent_id);

    if (directive_id === undefined) {
      continue;
    }
    if (parent_id !== undefined) {
      throw new Error(
        `Result span ${span_id} has both a directive_id and a parent_id; a directive's span must be a root.`,
      );
    }
    if (!activityIds.has(directive_id)) {
      throw new Error(
        `Result span ${span_id} references directive ${directive_id}, which is not an activity in this plan file.`,
      );
    }
    const otherSpan = spanOfDirective.get(directive_id);
    if (otherSpan !== undefined) {
      throw new Error(
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
        throw new Error(
          `A result span's parent_id references span ${id}, which is not in the results.`,
        );
      }
      if (chain.has(id)) {
        throw new Error(`Result span ${id}'s parent_id chain loops back on itself.`);
      }
      chain.add(id);
    }
    chain.forEach(id => reachesRoot.add(id));
  }
}

/**
 * Rewrites `results.spans[].directive_id` from the file's activity ids to the imported ones. Every `directive_id` was
 * checked against the file's activities by `parsePlanTransfer`.
 */
export function remapResultDirectiveIds(
  results: SimulationResultsTransfer,
  activityIdMap: Record<number, number>,
): SimulationResultsTransfer {
  const spans = results.spans.map(span =>
    span.directive_id === undefined ? span : { ...span, directive_id: activityIdMap[span.directive_id] },
  );
  return { ...results, spans };
}
