/**
 * The import sequence's two contracts: the ORDER of the five steps, and the rollback.
 *
 * Both are tested against a fake GraphQL caller rather than a live stack, and that is the point.
 * Ordering and undo are exactly the properties a database will not reliably help you check -- you
 * cannot ask Postgres to fail step 4 on demand -- so the caller records every operation and can be
 * told which one to fail. What comes out is the actual sequence and the actual undo, in order.
 */

import { describe, expect, test } from 'vitest';

import { ImportRefused, importRun } from '../src/packages/plan/importRun';
import type { RunTransfer } from '../src/packages/plan/runTransfer';

/** The operation each mutation represents, recognized by a fragment of its text. */
const OPERATIONS: [string, string][] = [
  ['GetMissionModelByNaturalKey', 'lookupModel'],
  ['CreateMissionModel', 'createModel'],
  ['RegisterModelTypes', 'registerTypes'],
  ['CreatePlan', 'createPlan'],
  ['InitialSimulationUpdate', 'setSimulationArguments'],
  ['GetTags', 'getTags'],
  ['CreateTags', 'createTags'],
  ['CreateActivityDirectives', 'createDirectives'],
  ['UpdateActivityDirective', 'setAnchors'],
  ['IngestExternalSimulationResults', 'ingest'],
  ['DeleteMissionModel', 'deleteModel'],
  ['DeletePlan', 'deletePlan'],
  ['DeleteTags', 'deleteTags'],
];

function nameOf(query: string): string {
  const match = OPERATIONS.find(([fragment]) => query.includes(fragment));
  if (!match) {
    throw new Error(`unrecognized GraphQL operation in test: ${query.slice(0, 80)}`);
  }
  return match[1];
}

type Options = {
  /** Fail this operation, as merlin refusing it (a GraphQL `errors` response). */
  refuse?: string;
  /** An existing model for the natural-key lookup to find. */
  existingModel?: { external_identity_hash: string; id: number; model_type: string } | null;
  /** Fail this operation outright, as an internal error. */
  throwOn?: string;
};

function fakeGraphQL(options: Options = {}) {
  const calls: string[] = [];
  const call = async (query: string, variables: Record<string, unknown>) => {
    const operation = nameOf(query);
    calls.push(operation);

    if (options.throwOn === operation) {
      throw new Error(`injected failure at ${operation}`);
    }
    if (options.refuse === operation) {
      return { errors: [{ message: `${operation} refused this` }] };
    }

    switch (operation) {
      case 'lookupModel':
        return { data: { mission_model: options.existingModel ? [options.existingModel] : [] } };
      case 'createModel':
        return { data: { insert_mission_model_one: { id: 900 } } };
      case 'registerTypes':
        return { data: { registerModelTypes: { activityTypeCount: 1, parameterCount: 0, resourceTypeCount: 1 } } };
      case 'createPlan':
        return { data: { createPlan: { id: 500, revision: 0 } } };
      case 'getTags':
        return { data: { tags: [] } };
      case 'createTags':
        return { data: { insert_tags: { returning: [{ id: 77, name: 'imported' }] } } };
      case 'createDirectives': {
        const objects = (variables.activityDirectivesInsertInput ?? []) as unknown[];
        return { data: { insert_activity_directive: { returning: objects.map((_, index) => ({ id: 600 + index })) } } };
      }
      case 'ingest':
        return { data: { ingestExternalSimulationResults: { simulationDatasetId: 42 } } };
      default:
        return { data: {} };
    }
  };
  return { call, calls };
}

function run(overrides: Partial<RunTransfer> = {}): RunTransfer {
  return {
    kind: 'plandev-run',
    model: {
      activityTypes: [
        {
          computedAttributesSchema: { items: {}, type: 'struct' },
          name: 'Observe',
          parameters: [{ name: 'target', schema: { type: 'string' } }],
          requiredParameters: ['target'],
        },
      ],
      capabilities: { simulation: { reason: 'nothing to run', supported: false } },
      mission: 'M',
      name: 'm',
      parameters: [],
      resourceTypes: [{ name: '/r', schema: { type: 'real' } }],
      version: '1.0.0',
    },
    plan: {
      activities: [
        {
          anchor_id: null,
          anchored_to_start: true,
          arguments: { target: 'Europa' },
          localId: 'a1',
          start_offset: '00:00:00',
          type: 'Observe',
        },
        {
          anchor_id: 'a1',
          anchored_to_start: false,
          arguments: { target: 'Io' },
          localId: 'a2',
          start_offset: '00:05:00',
          type: 'Observe',
        },
      ],
      duration: '01:00:00',
      name: 'p',
      simulation_arguments: { x: 1 },
      start_time: '2026-01-01T00:00:00+00:00',
      version: '2',
    },
    results: {
      duration: 3600000000,
      profiles: { '/r': { schema: { type: 'real' }, segments: [], type: 'real' } },
      spans: [
        { arguments: {}, directiveLocalId: 'a2', spanId: 1, startOffset: 0, type: 'Observe' },
        { arguments: {}, parentId: 1, spanId: 2, startOffset: 0, type: 'Observe' },
      ],
      startTime: '2026-001T00:00:00',
    },
    version: '1',
    ...overrides,
  };
}

describe('the write-ordering contract', () => {
  test('results are ingested LAST', async () => {
    const { call, calls } = fakeGraphQL();
    await importRun(run(), {}, call);

    // Not "ingest happens" but "nothing happens after it". simulation_dataset stamps plan_revision
    // and model_revision from a BEFORE-insert trigger, so ANY write after this bumps plan.revision,
    // the dataset stops matching, and the plan opens showing Modified beside a Simulate button that
    // cannot work -- a failure invisible until somebody opens the plan.
    expect(calls[calls.length - 1]).toBe('ingest');
  });

  test('the model and its types precede the plan, which precedes the directives', async () => {
    const { call, calls } = fakeGraphQL();
    await importRun(run(), {}, call);

    const order = ['createModel', 'registerTypes', 'createPlan', 'createDirectives', 'ingest'];
    const positions = order.map(operation => calls.indexOf(operation));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  test('anchors are set after the directives exist, not during their insert', async () => {
    const { call, calls } = fakeGraphQL();
    await importRun(run(), {}, call);
    // The id being anchored TO may belong to a row later in the same batch, so it cannot be resolved
    // while building the insert.
    expect(calls.indexOf('setAnchors')).toBeGreaterThan(calls.indexOf('createDirectives'));
  });

  test('the simulation arguments are set before the results are ingested', async () => {
    const { call, calls } = fakeGraphQL();
    await importRun(run(), {}, call);
    // merlin reads the simulation row to stamp the dataset's configuration, so setting them after
    // would both bump the revision and leave the dataset showing no configuration.
    expect(calls.indexOf('setSimulationArguments')).toBeLessThan(calls.indexOf('ingest'));
  });

  test('spans reference directives by the ids Postgres assigned', async () => {
    const seen: Record<string, unknown>[] = [];
    const { call } = fakeGraphQL();
    const recording = async (query: string, variables: Record<string, unknown>) => {
      if (query.includes('IngestExternalSimulationResults')) {
        seen.push(variables);
      }
      return call(query, variables);
    };

    const result = await importRun(run(), {}, recording);
    const spans = (seen[0].results as { spans: Record<string, unknown>[] }).spans;

    // a2 was the SECOND directive, so it got the second id -- and the span that claimed it by localId
    // now claims that id. The localId is gone from the wire entirely.
    expect(result.localIds).toEqual({ a1: 600, a2: 601 });
    expect(spans[0].directiveId).toBe(601);
    expect(spans[0]).not.toHaveProperty('directiveLocalId');
    // A decomposition child claims no directive at all.
    expect(spans[1]).not.toHaveProperty('directiveId');
  });
});

describe('rollback', () => {
  /**
   * A failure at each step in turn. There is no transaction spanning these calls -- they are separate
   * Hasura mutations against separate merlin actions -- so every one of these is a chance to leave a
   * partial import behind, which is the thing the plan is most explicit about not doing.
   */
  const steps = ['createModel', 'registerTypes', 'createPlan', 'createDirectives', 'ingest'];

  test.each(steps)('a failure at %s leaves nothing behind', async step => {
    const { call, calls } = fakeGraphQL({ throwOn: step });
    await expect(importRun(run(), {}, call)).rejects.toThrow(/injected failure/);

    // Exactly the resources whose creating step COMPLETED are deleted -- an attempted-but-failed
    // creation has nothing to undo, and deleting for it would be a delete of something that is not
    // there. So "before the failing call" is the test, not "was called".
    const failedAt = calls.indexOf(step);
    const succeeded = (operation: string) => {
      const at = calls.indexOf(operation);
      return at >= 0 && at < failedAt;
    };
    expect(calls.includes('deleteModel'), 'deleteModel').toBe(succeeded('createModel'));
    expect(calls.includes('deletePlan'), 'deletePlan').toBe(succeeded('createPlan'));
  });

  test('the plan is deleted before the model it references', async () => {
    const { call, calls } = fakeGraphQL({ throwOn: 'ingest' });
    await expect(importRun(run(), {}, call)).rejects.toThrow();
    expect(calls.indexOf('deletePlan')).toBeLessThan(calls.indexOf('deleteModel'));
  });

  test('tags created by this import are deleted too', async () => {
    // Tags outlive a deleted plan -- they are their own rows -- so the plan's deletion does not take
    // them, and an import that failed halfway would otherwise leave named tags nobody asked for.
    const withTags = run();
    withTags.plan.activities[0].tags = [{ tag: { color: null, name: 'imported' } }];
    const { call, calls } = fakeGraphQL({ throwOn: 'ingest' });
    await expect(importRun(withTags, {}, call)).rejects.toThrow();
    expect(calls).toContain('deleteTags');
  });

  test('a REUSED model is never deleted', async () => {
    // It was somebody else's before this import arrived, and deleting it would take their plans with
    // it. This is the one case where rolling back too much is worse than rolling back too little.
    // The digest has to match for the model to be reused, so compute it the way the importer does.
    const { declarationDigest } = await import('../src/packages/plan/runTransfer');
    const { call, calls } = fakeGraphQL({
      existingModel: { external_identity_hash: declarationDigest(run().model!), id: 12, model_type: 'declared' },
      throwOn: 'ingest',
    });

    await expect(importRun(run(), {}, call)).rejects.toThrow();
    expect(calls).not.toContain('createModel');
    expect(calls).not.toContain('deleteModel');
    expect(calls).toContain('deletePlan');
  });

  test('a refusal is reported as a refusal, not as an internal failure', async () => {
    const { call } = fakeGraphQL({ refuse: 'ingest' });
    await expect(importRun(run(), {}, call)).rejects.toBeInstanceOf(ImportRefused);
  });
});

describe('an existing model with the same natural key', () => {
  test('is reused when its stored digest matches, and its types are not re-registered', async () => {
    const { declarationDigest } = await import('../src/packages/plan/runTransfer');
    const digest = declarationDigest(run().model!);
    const { call, calls } = fakeGraphQL({
      existingModel: { external_identity_hash: digest, id: 12, model_type: 'declared' },
    });

    const result = await importRun(run(), {}, call);
    expect(result.modelId).toBe(12);
    expect(result.reusedExistingModel).toBe(true);
    expect(calls).not.toContain('createModel');
    // Re-registering would be a write against a model somebody else may be using.
    expect(calls).not.toContain('registerTypes');
    expect(result.notices.some(({ message }) => message.includes('digest matches'))).toBe(true);
  });

  test('is refused when its stored digest differs, naming both digests', async () => {
    const { call } = fakeGraphQL({
      existingModel: { external_identity_hash: 'deadbeefdeadbeef', id: 12, model_type: 'declared' },
    });
    // Importing against the stored types would check this run's spans against a declaration it was
    // not produced from -- and the result would look entirely normal.
    await expect(importRun(run(), {}, call)).rejects.toThrow(/different type surface/);
    await expect(importRun(run(), {}, call)).rejects.toThrow(/deadbeefdeadbeef/);
  });

  test('is refused when it is a JAR model', async () => {
    const { call } = fakeGraphQL({
      existingModel: { external_identity_hash: '', id: 12, model_type: 'jar' },
    });
    await expect(importRun(run(), {}, call)).rejects.toThrow(/already exists as a 'jar' model/);
  });
});

describe('a file with no model declaration', () => {
  test('imports against the model id the caller chose', async () => {
    const { call, calls } = fakeGraphQL();
    const result = await importRun(run({ model: undefined }), { modelId: 31 }, call);
    expect(result.modelId).toBe(31);
    expect(calls).not.toContain('createModel');
    expect(calls).not.toContain('registerTypes');
  });

  test('is refused when the caller chose no model either', async () => {
    const { call } = fakeGraphQL();
    await expect(importRun(run({ model: undefined }), {}, call)).rejects.toBeInstanceOf(ImportRefused);
  });
});
