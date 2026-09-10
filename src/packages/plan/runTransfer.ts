/**
 * Importing a run transfer: a simulation PlanDev did not perform, as a first-class run.
 *
 * A `.run.json` file carries a model type declaration, a plan's directives, and the results (activity
 * spans and resource profiles) of a simulation somebody else already ran. This module turns that file
 * into a mission model, a plan, its directives, and one `simulation_dataset` with status `success`.
 *
 * The format reference is `RUN_TRANSFER.md` in plandev-examples/external-model-backends, and
 * `run-transfer.v1.schema.json` there is the source of truth for the schema vendored beside this file.
 *
 * Three things here are load-bearing and easy to undo by accident:
 *
 *  1. **Write order.** `simulation_dataset` stamps `plan_revision` and `model_revision` from a
 *     BEFORE-insert trigger, so results must be ingested LAST. Any write after that bumps
 *     `plan.revision` and the plan opens showing `Modified` with a Simulate button that cannot work.
 *
 *  2. **`localId`.** Spans reference directives by a file-local id, because Postgres assigns real ids
 *     on insert and a file cannot know them. The map is built after inserting and every span reference
 *     and anchor is rewritten through it.
 *
 *  3. **Non-finite numbers.** `JSON.stringify(Infinity)` is `null`. A run whose profile carries
 *     `1e400` would therefore reach merlin as a profile GAP -- a wrong run, stored, with nothing
 *     complaining. See {@link findNonFiniteNumbers}.
 */

import Ajv from 'ajv';
import { createHash } from 'node:crypto';

import { runTransferSchema } from '../../schemas/run-transfer-schema.js';

/** The only `kind` this reader accepts. Anything else is refused outright, never sniffed. */
export const RUN_TRANSFER_KIND = 'plandev-run';

/**
 * The run transfer major versions this reader understands.
 *
 * A version outside this list is refused, naming what it got and what is supported. It is never
 * best-effort parsed: a half-understood run lands in the database looking fine, which is worse than a
 * rejected one. `results` becomes time-major NDJSON in version 2 with the streaming work, and both
 * will be accepted for a transition period.
 */
export const SUPPORTED_VERSIONS = ['1'];

/** The PlanTransfer version a run transfer's `plan` member is, independent of the envelope's. */
export const PLAN_TRANSFER_VERSION = '2';

// Draft-07, matching the pinned `ajv ^6`. Authoring 2020-12 and discovering the mismatch at runtime is
// the failure this avoids; the schema file asserts its own $schema and the test suite checks it.
const ajv = new Ajv({ allErrors: true, verbose: false });
const validateRunTransfer = ajv.compile(runTransferSchema);

export type Severity = 'error' | 'warning' | 'info';

/**
 * One thing to tell the user about a file, in the shape plandev-ui already renders.
 *
 * `subjects` names what the notice is about -- a field path, an activity's localId, a span id -- so the
 * UI can point at it. Note the UI drops a notice with an EMPTY subjects list, so a whole-file notice
 * needs a subject even if it is only the filename.
 */
export type Notice = {
  message: string;
  severity: Severity;
  subjects: string[];
};

export class RunTransferError extends Error {
  readonly notices: Notice[];
  /** Which layer refused it: `schema`, `importer`, or `gate`. */
  readonly layer: 'schema' | 'importer' | 'gate';

  constructor(layer: 'schema' | 'importer' | 'gate', notices: Notice[]) {
    super(notices.map(({ message }) => message).join('\n'));
    this.layer = layer;
    this.notices = notices;
  }
}

export type ActivityTypeDeclaration = {
  computedAttributesSchema: unknown;
  description?: string;
  name: string;
  parameters: { name: string; schema: unknown }[];
  requiredParameters: string[];
  subsystem?: string;
};

export type ModelDeclaration = {
  activityTypes: ActivityTypeDeclaration[];
  capabilities?: Record<string, { reason?: string; supported: boolean }>;
  description?: string;
  mission: string;
  name: string;
  parameters: { name: string; schema: unknown }[];
  resourceTypes: { name: string; schema: unknown }[];
  version: string;
};

export type RunActivity = {
  anchor_id?: string | null;
  anchored_to_start?: boolean;
  arguments: Record<string, unknown>;
  localId: string;
  metadata?: Record<string, unknown>;
  name?: string;
  tags?: { tag: { color?: string | null; name: string } }[];
  start_offset: string;
  type: string;
};

export type RunResults = {
  duration: number;
  profiles: Record<string, { schema: unknown; segments: unknown[]; type: 'discrete' | 'real' }>;
  spans: {
    arguments: Record<string, unknown>;
    computedAttributes?: unknown;
    directiveLocalId?: string;
    duration?: number;
    parentId?: number;
    spanId: number;
    startOffset: number;
    type: string;
  }[];
  startTime: string;
};

export type RunTransfer = {
  kind: string;
  model?: ModelDeclaration;
  plan: {
    activities: RunActivity[];
    duration: string;
    name: string;
    simulation_arguments: Record<string, unknown>;
    start_time: string;
    tags?: { tag: { color?: string | null; name: string } }[];
    version: string;
  };
  results?: RunResults;
  version: string;
};

/** Whether a parsed JSON document claims to be a run transfer at all. */
export function isRunTransfer(doc: unknown): boolean {
  return typeof doc === 'object' && doc !== null && 'kind' in doc;
}

/**
 * What a file is, for the UI to say before anything is imported.
 *
 * Keyed on `kind` and `version`, never guessed from shape, so a legacy plan.json and a TRUNCATED run
 * file are distinguishable -- and the second is an error rather than a silent partial import.
 */
export function describe(doc: unknown): Notice[] {
  if (!isRunTransfer(doc)) {
    return [
      {
        message: 'Plan only. This is a plan file with no model declaration and no recorded results, and it imports exactly as it does today.',
        severity: 'info',
        subjects: ['file'],
      },
    ];
  }

  const run = doc as RunTransfer;
  const notices: Notice[] = [];

  if (run.kind !== RUN_TRANSFER_KIND) {
    notices.push({
      message: `Unrecognized file kind '${run.kind}'. A run transfer must declare kind '${RUN_TRANSFER_KIND}'.`,
      severity: 'error',
      subjects: ['kind'],
    });
    return notices;
  }
  if (!SUPPORTED_VERSIONS.includes(run.version)) {
    notices.push({
      message: `Run transfer version '${run.version}' is not supported. This PlanDev accepts ${SUPPORTED_VERSIONS.map(v => `'${v}'`).join(', ')}.`,
      severity: 'error',
      subjects: ['version'],
    });
    return notices;
  }

  if (run.results) {
    const directives = run.plan?.activities?.length ?? 0;
    const resources = Object.keys(run.results.profiles ?? {}).length;
    const spans = run.results.spans?.length ?? 0;
    notices.push({
      message:
        `Recorded run — ${directives} directives, ${resources} resources, ${spans} spans. ` +
        `The plan opens with these results already attached, and cannot be re-simulated.`,
      severity: 'info',
      subjects: ['results'],
    });
  } else {
    notices.push({
      message: 'Plan only. This run transfer carries no recorded results.',
      severity: 'info',
      subjects: ['file'],
    });
  }

  if (run.model) {
    notices.push({
      message:
        `Includes a new mission model declaration: ${run.model.mission}/${run.model.name}/${run.model.version} ` +
        `(${run.model.activityTypes?.length ?? 0} activity types, ${run.model.resourceTypes?.length ?? 0} resource types).`,
      severity: 'info',
      subjects: ['model'],
    });
  }

  return notices;
}

/**
 * Refuse an unknown `kind` or `version` before the schema runs.
 *
 * Ahead of ajv deliberately: its `const`/`enum` message for these two is "should be equal to constant",
 * which tells a producer nothing about which versions actually exist. These are also the two failures
 * where a precise answer is most useful, because they are what a producer hits after the format moves.
 */
function checkEnvelope(doc: unknown): void {
  if (typeof doc !== 'object' || doc === null) {
    throw new RunTransferError('schema', [
      { message: 'Run transfer file is not a JSON object.', severity: 'error', subjects: ['file'] },
    ]);
  }
  const { kind, version } = doc as Partial<RunTransfer>;
  if (kind !== RUN_TRANSFER_KIND) {
    throw new RunTransferError('schema', [
      {
        message: `Run transfer 'kind' must be exactly '${RUN_TRANSFER_KIND}', but this file declares ${
          kind === undefined ? 'no kind at all' : `'${kind}'`
        }.`,
        severity: 'error',
        subjects: ['kind'],
      },
    ]);
  }
  if (typeof version !== 'string' || !SUPPORTED_VERSIONS.includes(version)) {
    throw new RunTransferError('schema', [
      {
        message: `Run transfer version ${
          version === undefined ? 'is missing' : `'${version}' is not supported`
        }. This PlanDev accepts ${SUPPORTED_VERSIONS.map(v => `'${v}'`).join(', ')}. A version this reader does not know is refused rather than partially understood.`,
        severity: 'error',
        subjects: ['version'],
      },
    ]);
  }
}

/** Validate the whole document against the JSON Schema, reporting every failure with its field path. */
function checkSchema(doc: unknown): void {
  if (validateRunTransfer(doc)) {
    return;
  }
  const notices: Notice[] = (validateRunTransfer.errors ?? []).map(error => {
    // ajv 6 spells the location `dataPath` (`instancePath` arrived in 7), and an empty one means the
    // root, which reads better as the file itself than as ''.
    const path = error.dataPath === '' ? 'file' : error.dataPath.replace(/^\./, '');
    const detail =
      error.keyword === 'additionalProperties'
        ? `${error.message} (${JSON.stringify((error.params as { additionalProperty?: string }).additionalProperty)})`
        : error.message ?? 'is invalid';
    return { message: `${path} ${detail}`, severity: 'error' as Severity, subjects: [path] };
  });
  throw new RunTransferError('schema', notices);
}

/**
 * Every non-finite number in the document, with the path that holds it.
 *
 * This exists because of a specific, silent data-loss path rather than out of caution. A non-finite
 * value cannot be written as `NaN` or `Infinity` (not JSON), so a producer writes `1e400` -- valid
 * JSON that every reader parses to `+Infinity`. Then:
 *
 *   `JSON.stringify(Infinity)` === `'null'`
 *
 * So forwarding a parsed document to Hasura converts an infinite rate into a `null` dynamics, which is
 * the wire spelling of a profile GAP. The run stores, renders, and is wrong, and merlin's own
 * non-finite check never sees the value that would have tripped it.
 *
 * Refusing here reaches the same conclusion as `ExternalResultsGate` and borrows its wording, because
 * the rule is the gate's -- this is just the last point at which the evidence still exists.
 */
export function findNonFiniteNumbers(node: unknown, path = ''): { path: string; value: number }[] {
  if (typeof node === 'number') {
    return Number.isFinite(node) ? [] : [{ path: path || 'file', value: node }];
  }
  if (Array.isArray(node)) {
    return node.flatMap((item, index) => findNonFiniteNumbers(item, `${path}[${index}]`));
  }
  if (typeof node === 'object' && node !== null) {
    return Object.entries(node).flatMap(([key, value]) =>
      findNonFiniteNumbers(value, path === '' ? key : `${path}.${key}`),
    );
  }
  return [];
}

/**
 * Everything the file's own cross-references must satisfy, checked before anything is written.
 *
 * The schema cannot express any of these -- they are relationships between parts of one document --
 * and merlin cannot check the first two at all, because by the time it sees the results the localIds
 * have been replaced by real ids. So this layer is genuinely its own, not a duplicate of either
 * neighbour.
 */
export function checkCrossReferences(run: RunTransfer): Notice[] {
  const notices: Notice[] = [];
  const localIds = new Set<string>();

  for (const activity of run.plan.activities) {
    if (localIds.has(activity.localId)) {
      notices.push({
        message: `localId '${activity.localId}' is declared by more than one activity; it must be unique within the file.`,
        severity: 'error',
        subjects: [activity.localId],
      });
    }
    localIds.add(activity.localId);
  }

  for (const activity of run.plan.activities) {
    const anchor = activity.anchor_id;
    if (anchor !== undefined && anchor !== null && !localIds.has(anchor)) {
      notices.push({
        message: `activity '${activity.localId}' is anchored to '${anchor}', which no activity in this file declares.`,
        severity: 'error',
        subjects: [activity.localId],
      });
    }
  }

  // A directive whose type the file's OWN model declaration does not declare. Nothing downstream
  // catches this at import: there is no foreign key from activity_directive.type to activity_type, so
  // the insert succeeds and the plan opens with a directive carrying a validation error instead. The
  // gate cannot catch it either -- it sees spans, not directives. But the file contains both halves,
  // so the inconsistency is visible right here, which makes it this layer's to report.
  if (run.model) {
    const declared = new Set(run.model.activityTypes.map(({ name }) => name));
    for (const activity of run.plan.activities) {
      if (!declared.has(activity.type)) {
        notices.push({
          message: `activity '${activity.localId}' has type '${activity.type}', which this file's model declaration does not declare.`,
          severity: 'error',
          subjects: [activity.localId],
        });
      }
    }
  }

  for (const span of run.results?.spans ?? []) {
    const directive = span.directiveLocalId;
    if (directive !== undefined && !localIds.has(directive)) {
      notices.push({
        message: `span ${span.spanId} references directiveLocalId '${directive}', which no activity in this file declares.`,
        severity: 'error',
        subjects: [String(span.spanId)],
      });
    }
    if (span.parentId !== undefined && span.directiveLocalId !== undefined) {
      // Not fatal, and merlin will store it, but it means the file is describing something that cannot
      // be true: a decomposition child belongs to its parent, not to a directive.
      notices.push({
        message: `span ${span.spanId} has both a parentId and a directiveLocalId. A decomposition child belongs to its parent span, so its directive link is ignored.`,
        severity: 'warning',
        subjects: [String(span.spanId)],
      });
    }
  }

  for (const { path, value } of findNonFiniteNumbers(run.results ?? {}, 'results')) {
    notices.push({
      message: `${path} is a non-finite value (${value}), which merlin refuses. It cannot be forwarded either: JSON.stringify turns it into null, which is the wire spelling of a profile gap.`,
      severity: 'error',
      subjects: [path],
    });
  }

  if (notices.some(({ severity }) => severity === 'error')) {
    throw new RunTransferError('importer', notices);
  }
  // Whatever is left is a warning: it does not stop the import, but the caller must still surface it.
  return notices;
}

/**
 * Validate a parsed document as a run transfer, in layer order, and return it typed.
 *
 * Order matters for the message the user gets: envelope first (so a wrong version says which versions
 * exist), then shape, then the file's own cross-references. Each layer's failure is reported on its
 * own rather than merged, because "you are on the wrong version" and "span 4's parent is missing" call
 * for completely different actions.
 */
export function validate(doc: unknown): { run: RunTransfer; warnings: Notice[] } {
  checkEnvelope(doc);
  checkSchema(doc);
  const run = doc as RunTransfer;
  return { run, warnings: checkCrossReferences(run) };
}

/**
 * A digest of a model's declared type surface.
 *
 * What it answers: were these results produced against the model PlanDev has, or a drifted one? It is
 * the same question `external_identity_hash` answers for a live backend, computed from a file instead
 * of fetched from a service, which is why it shares that column.
 *
 * The canonical form is deliberately spelled out rather than left to `JSON.stringify`, because the
 * digest has to agree with the one `adapter_core.digest` computes in Python. Sorted keys, no
 * whitespace, and arrays left in ORDER -- parameter order is part of the declaration (merlin persists
 * each parameter's index as its `order` and the argument form is laid out in it), so sorting the
 * parameter arrays would hide a reordered declaration from the very check that exists to catch drift.
 */
export function declarationDigest(model: ModelDeclaration): string {
  const payload = {
    acts: Object.fromEntries(
      model.activityTypes.map(activityType => [
        activityType.name,
        {
          computed: activityType.computedAttributesSchema ?? null,
          params: activityType.parameters.map(({ name, schema }) => [name, schema]),
          required: activityType.requiredParameters,
        },
      ]),
    ),
    caps: model.capabilities ?? {},
    cfg: model.parameters.map(({ name, schema }) => [name, schema]),
    res: Object.fromEntries(model.resourceTypes.map(({ name, schema }) => [name, schema])),
  };
  return createHash('sha256').update(canonicalJSON(payload)).digest('hex').slice(0, 16);
}

/** Sorted-key, whitespace-free JSON. Arrays keep their order; only object keys are sorted. */
export function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJSON((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
