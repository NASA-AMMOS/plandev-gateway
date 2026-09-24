import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import fetch from 'node-fetch';
import { generateJwt } from '../src/packages/auth/functions';
import { removeUploadedFile, storeUploadedFile } from '../src/packages/files/store';
import { importPlan } from '../src/packages/plan/plan';
import { UnsupportedPlanTransferError, remapResultDirectiveIds } from '../src/packages/plan/plan-transfer';
import type { PlanTransfer, SimulationResultsTransfer } from '../src/types/plan-transfer';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../src/packages/files/store', () => ({
  removeUploadedFile: vi.fn(),
  storeUploadedFile: vi.fn(async (originalname: string) =>
    originalname === 'plan-transfer-model.json'
      ? { id: 42, name: 'plan-transfer-model-1-abc.json' }
      : { id: 43, name: 'plan-transfer-results-1-def.json' },
  ),
}));

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf-8'));

const v2Fixture = fixture('plan-transfer-v2');
const v3Fixture: PlanTransfer = fixture('plan-transfer-v3');
const { model: _model, results: _results, ...v3PlanOnly } = v3Fixture;
const { results: _omitted, ...v3PlanAndModel } = v3Fixture;

const MODEL_ID = 900;
const PLAN_ID = 50;
const FIRST_DIRECTIVE_ID = 581;
const FIRST_TAG_ID = 300;

type Call = { operation: string; variables: any };
type RefreshLog = { error_message: string | null; pending: boolean; success: boolean };
type Responder = (variables: any) => unknown;

/**
 * A fake Hasura, merlin and database: answers each GraphQL operation by name, merlin's endpoints by path, and the
 * read-only update, recording every call in order. Merlin responders return `{ status?, text }`, since merlin
 * replies in plain text.
 */
let calls: Call[];
let responders: Record<string, Responder>;

const defaultResponders: Record<string, Responder> = {
  CreateActivityDirectives: ({ activityDirectivesInsertInput }) => ({
    data: {
      insert_activity_directive: {
        returning: activityDirectivesInsertInput.map(({ type }: { type: string }, index: number) => ({
          id: FIRST_DIRECTIVE_ID + index,
          type,
        })),
      },
    },
  }),
  InsertModel: () => ({ text: `${MODEL_ID}` }),
  CreatePlan: ({ plan }) => ({ data: { createPlan: { ...plan, id: PLAN_ID } } }),
  CreateTags: ({ tags }) => ({
    data: {
      insert_tags: { returning: tags.map((tag: object, index: number) => ({ ...tag, id: FIRST_TAG_ID + index })) },
    },
  }),
  GetPlanByName: () => ({ data: { plan: [] } }),
  MutationRootFields: () => mutationRoot('insert_activity_directive', 'insert_plan_one', 'insert_tags'),
  GetTags: () => ({ data: { tags: [] } }),
  ModelTypeRefreshStatus: () => refreshStatus(succeeded, succeeded, succeeded),
  InsertExternalSimulationDataset: () => ({ text: '' }),
  MarkPlanReadOnly: () => ({ text: '' }),
};

/** What Hasura's introspection shows a role that may run these mutations. */
const mutationRoot = (...fields: string[]) => ({ data: { __type: { fields: fields.map(name => ({ name })) } } });

const pending: RefreshLog = { error_message: null, pending: true, success: false };
const succeeded: RefreshLog = { error_message: null, pending: false, success: true };
const failed = (error_message: string): RefreshLog => ({ error_message, pending: false, success: false });

/** The latest refresh log row for each trigger; `undefined` is a trigger with no row logged yet. */
const refreshStatus = (activityTypes?: RefreshLog, resourceTypes?: RefreshLog, modelParameters?: RefreshLog) => ({
  data: {
    mission_model_by_pk: {
      refresh_activity_type_logs: activityTypes ? [activityTypes] : [],
      refresh_model_parameter_logs: modelParameters ? [modelParameters] : [],
      refresh_resource_type_logs: resourceTypes ? [resourceTypes] : [],
    },
  },
});

const MODEL_FILE = { id: 42, name: 'plan-transfer-model-1-abc.json' };
const RESULTS_FILE = { id: 43, name: 'plan-transfer-results-1-def.json' };

/** The results the import staged for merlin to read. */
const stagedResults = () => {
  const call = vi.mocked(storeUploadedFile).mock.calls.find(([name]) => name === 'plan-transfer-results.json');
  return call && JSON.parse(call[1]);
};

const MERLIN_URL = 'http://plandev_merlin:27183';

/** A merlin error, as a `FormattedError`. */
const merlinError = (message: string) => ({ status: 400, text: JSON.stringify({ message }) });

// a real signed token, since the model's owner comes from the verified JWT
const JWT_SECRET = JSON.stringify({ key: 'plan-import-test-secret-plan-import-test', type: 'HS256' });
let token: string;

const callsTo = (operation: string) => calls.filter(call => call.operation === operation);
const operations = () => calls.map(({ operation }) => operation);

beforeEach(() => {
  vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', JWT_SECRET);
  token = generateJwt('importer', 'user', ['user', 'viewer'])!;
  calls = [];
  responders = { ...defaultResponders };
  vi.mocked(storeUploadedFile).mockClear();
  vi.mocked(removeUploadedFile).mockReset();
  // recorded alongside the GraphQL calls, so tests can check when a staged file is removed
  vi.mocked(removeUploadedFile).mockImplementation(async file => {
    calls.push({ operation: 'removeUploadedFile', variables: file });
  });
  vi.mocked(fetch).mockClear();
  vi.mocked(fetch).mockImplementation((async (url: unknown, init: { body: string }) => {
    if (String(url).startsWith(`${MERLIN_URL}/`)) {
      const endpoint = String(url).slice(MERLIN_URL.length + 1);
      // labelled like the GraphQL operations, e.g. insertModel -> InsertModel
      const operation = endpoint[0].toUpperCase() + endpoint.slice(1);
      const body = JSON.parse(init.body);
      calls.push({ operation, variables: body });
      const { status = 200, text } = responders[operation](body) as { status?: number; text: string };
      return { ok: status < 300, status, text: async () => text };
    }

    const { query, variables } = JSON.parse(init.body);
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown';
    calls.push({ operation, variables });
    const body = responders[operation]?.(variables) ?? { data: {} };
    return { json: async () => body, status: 200 };
  }) as any);
});

const form = {
  duration: '48:00:00',
  model_id: 3,
  name: 'Imported plan',
  simulation_template_id: 12,
  start_time: '2031-01-01T00:00:00+00:00',
  tags: '[11]',
};

async function runImport(
  transfer: unknown,
  body: Record<string, unknown> = form,
  headers: Record<string, string> = { 'x-hasura-role': 'user', 'x-hasura-user-id': 'importer' },
) {
  const res = {
    json: vi.fn(),
    send: vi.fn(),
    status: vi.fn(),
  };
  const req = {
    body,
    file: { buffer: Buffer.from(JSON.stringify(transfer)) },
    get: (header: string) => (header === 'authorization' ? `Bearer ${token}` : undefined),
    headers,
  };

  await importPlan(req as any, res as any);

  const failed = res.status.mock.calls.length > 0;
  return {
    error: failed ? (res.send.mock.calls[0]?.[0] as string) : undefined,
    plan: failed ? undefined : res.json.mock.calls[0]?.[0],
    res,
  };
}

describe('importPlan without an embedded model', () => {
  test.each([
    ['v2', v2Fixture],
    ['v3 plan-only', v3PlanOnly],
  ])('%s takes the existing path', async (_, transfer) => {
    const { error, plan } = await runImport(transfer);

    expect(error).toBeUndefined();
    expect(plan.id).toBe(PLAN_ID);
    expect(operations()).toEqual([
      'CreatePlan',
      'InitialSimulationUpdate',
      'GetTags',
      'CreateTags',
      'CreateActivityDirectives',
      'UpdateActivityDirective',
      'CreatePlanTags',
    ]);
    expect(storeUploadedFile).not.toHaveBeenCalled();

    // the form, not the file, supplies the plan's model and window
    expect(callsTo('CreatePlan')[0].variables.plan).toEqual({
      duration: form.duration,
      model_id: form.model_id,
      name: form.name,
      start_time: form.start_time,
    });
    expect(callsTo('InitialSimulationUpdate')[0].variables.simulation).toEqual({
      arguments: transfer.simulation_arguments,
      simulation_template_id: form.simulation_template_id,
    });
    expect(callsTo('CreatePlanTags')[0].variables.tags).toEqual([{ plan_id: PLAN_ID, tag_id: 11 }]);
  });
});

describe('importPlan with an embedded model', () => {
  test('creates a non-executable model and a plan on it, then finalizes without results', async () => {
    const { error, plan } = await runImport(v3PlanAndModel);

    expect(error).toBeUndefined();
    expect(plan.id).toBe(PLAN_ID);
    expect(operations()).toEqual([
      'MutationRootFields',
      'GetPlanByName',
      'InsertModel',
      'ModelTypeRefreshStatus',
      'CreatePlan',
      'InitialSimulationUpdate',
      'GetTags',
      'CreateTags',
      'CreateActivityDirectives',
      'UpdateActivityDirective',
      'CreatePlanTags',
      'InsertExternalSimulationDataset',
      'MarkPlanReadOnly',
    ]);

    expect(storeUploadedFile).toHaveBeenCalledWith('plan-transfer-model.json', JSON.stringify(v3Fixture.model));
    expect(callsTo('InsertModel')[0].variables).toEqual({
      modelName: form.name,
      requester: 'importer',
      uploadedFileId: MODEL_FILE.id,
    });

    // the file supplies the window and simulation arguments; the form supplies only the name and plan tags
    expect(callsTo('CreatePlan')[0].variables.plan).toEqual({
      duration: v3Fixture.duration,
      model_id: MODEL_ID,
      name: form.name,
      start_time: v3Fixture.start_time,
    });
    expect(callsTo('InitialSimulationUpdate')[0].variables.simulation).toEqual({
      arguments: v3Fixture.simulation_arguments,
    });
    expect(callsTo('CreateActivityDirectives')[0].variables.activityDirectivesInsertInput).toHaveLength(2);
    expect(callsTo('CreatePlanTags')[0].variables.tags).toEqual([{ plan_id: PLAN_ID, tag_id: 11 }]);

    // merlin's day-of-year timestamps, and the plan's 24:00:00 in microseconds
    expect(callsTo('InsertExternalSimulationDataset')[0].variables).toEqual({
      planId: PLAN_ID,
      planStartTime: '2030-001T00:00:00',
      resultsFileId: null,
      simulationArguments: v3Fixture.simulation_arguments,
      simulationDuration: 86_400_000_000,
      simulationStartTime: '2030-001T00:00:00',
    });
    expect(callsTo('MarkPlanReadOnly')[0].variables).toEqual({ planId: PLAN_ID });
    expect(vi.mocked(storeUploadedFile).mock.calls.map(([name]) => name)).toEqual(['plan-transfer-model.json']);
    expect(removeUploadedFile).not.toHaveBeenCalled();
  });

  test('ignores model_id from both the file and the form', async () => {
    expect(v3Fixture.model_id).toBe(7);

    await runImport(v3Fixture, { ...form, model_id: 3 });

    expect(callsTo('CreatePlan')[0].variables.plan.model_id).toBe(MODEL_ID);
  });

  test("falls back to the file's plan name", async () => {
    await runImport(v3PlanAndModel, { ...form, name: undefined });

    expect(callsTo('GetPlanByName')[0].variables).toEqual({ name: v3Fixture.name });
    expect(callsTo('CreatePlan')[0].variables.plan.name).toBe(v3Fixture.name);
  });

  test('remaps result directive ids and passes the results to merlin as a staged file', async () => {
    const { error } = await runImport(v3Fixture);

    expect(error).toBeUndefined();
    // the fixture's results inherit the plan's window
    expect(callsTo('InsertExternalSimulationDataset')[0].variables).toEqual({
      planId: PLAN_ID,
      planStartTime: '2030-001T00:00:00',
      resultsFileId: RESULTS_FILE.id,
      simulationArguments: v3Fixture.simulation_arguments,
      simulationDuration: 86_400_000_000,
      simulationStartTime: '2030-001T00:00:00',
    });

    const results = stagedResults();
    expect(Object.keys(results).sort()).toEqual(['profiles', 'spans']);

    const spans = results.spans.map(({ span_id, directive_id, parent_id }: any) => ({
      directive_id,
      parent_id,
      span_id,
    }));
    expect(spans).toEqual([
      { directive_id: FIRST_DIRECTIVE_ID, parent_id: undefined, span_id: 1 },
      { directive_id: FIRST_DIRECTIVE_ID + 1, parent_id: undefined, span_id: 2 },
      // generated spans keep their results-namespace ids and gain no directive
      { directive_id: undefined, parent_id: 2, span_id: 3 },
      { directive_id: undefined, parent_id: 2, span_id: 4 },
    ]);
    expect(results.spans[2]).toEqual(v3Fixture.results!.spans[2]);
    expect(results.profiles).toEqual(v3Fixture.results!.profiles);

    // removed once merlin has read it, and only then is the plan made read-only; the model's definition file stays
    expect(operations().slice(-3)).toEqual([
      'InsertExternalSimulationDataset',
      'removeUploadedFile',
      'MarkPlanReadOnly',
    ]);
    expect(callsTo('removeUploadedFile').map(({ variables }) => variables)).toEqual([RESULTS_FILE]);
  });

  test("passes the results' own window in the call, not the staged file", async () => {
    // a subset simulation: two hours starting an hour into the plan
    const start_time = '2030-01-01T01:00:00+00:00';
    const transfer = {
      ...v3Fixture,
      results: { ...v3Fixture.results!, duration: 2 * 3_600_000_000, start_time },
    };

    const { error } = await runImport(transfer);

    expect(error).toBeUndefined();
    expect(callsTo('InsertExternalSimulationDataset')[0].variables).toMatchObject({
      planStartTime: '2030-001T00:00:00',
      simulationDuration: 7_200_000_000,
      simulationStartTime: '2030-001T01:00:00',
    });
    expect(Object.keys(stagedResults()).sort()).toEqual(['profiles', 'spans']);
  });

  test.each([
    ['a role without insert_plan_one', mutationRoot('insert_tags')],
    ['a role with no mutations at all', { data: { __type: null } }],
  ])('refuses %s before staging or creating anything', async (_, response) => {
    responders.MutationRootFields = () => response;

    const { error } = await runImport(v3Fixture);

    expect(error).toBe('You do not have permission to create a plan.');
    expect(operations()).toEqual(['MutationRootFields']);
    expect(storeUploadedFile).not.toHaveBeenCalled();
  });

  test('refuses a taken plan name before creating a model', async () => {
    responders.GetPlanByName = () => ({ data: { plan: [{ id: 1 }] } });

    const { error } = await runImport(v3Fixture);

    expect(error).toBe(`Plan name "${form.name}" is already in use.`);
    expect(operations()).toEqual(['MutationRootFields', 'GetPlanByName']);
    expect(storeUploadedFile).not.toHaveBeenCalled();
  });

  test('a failed model creation creates no plan and discards the staged definition', async () => {
    responders.InsertModel = () => merlinError('model declaration rejected');

    const { error } = await runImport(v3Fixture);

    expect(error).toBe('model declaration rejected');
    expect(callsTo('CreatePlan')).toHaveLength(0);
    expect(removeUploadedFile).toHaveBeenCalledWith(MODEL_FILE);
  });

  test('a span referencing an unknown directive fails and deletes the plan', async () => {
    const transfer = structuredClone(v3Fixture);
    transfer.results!.spans[0].directive_id = 99;

    const { error } = await runImport(transfer);

    expect(error).toBe('Result span 1 references directive 99, which is not an activity in this plan file.');
    expect(callsTo('InsertExternalSimulationDataset')).toHaveLength(0);
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
  });

  test('a failed results ingestion deletes the plan and the tags the import created', async () => {
    responders.InsertExternalSimulationDataset = () => merlinError('profile rejected');

    const { error } = await runImport(v3Fixture);

    expect(error).toBe('profile rejected');
    expect(removeUploadedFile).toHaveBeenCalledWith(RESULTS_FILE);
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
    expect(callsTo('DeleteTags')[0].variables).toEqual({ tagIds: [FIRST_TAG_ID] });
    expect(callsTo('MarkPlanReadOnly')).toHaveLength(0);
  });

  test('a plan that cannot be made read-only is rolled back', async () => {
    responders.MarkPlanReadOnly = () => merlinError('plan cannot be marked read only');

    const { error } = await runImport(v3Fixture);

    expect(error).toBe('plan cannot be marked read only');
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
  });

  test('a merlin reply that is not a model id fails the import', async () => {
    responders.InsertModel = () => ({ text: '' });

    const { error } = await runImport(v3Fixture);

    expect(error).toBe('Non-executable model creation returned no model id.');
    expect(removeUploadedFile).toHaveBeenCalledWith(MODEL_FILE);
  });
});

describe('importPlan calling merlin directly', () => {
  test('creates the model, inserts the results and marks the plan read-only through merlin, not Hasura', async () => {
    const { error } = await runImport(v3Fixture);

    expect(error).toBeUndefined();
    const merlinUrls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter(url => url.startsWith(MERLIN_URL));
    expect(merlinUrls).toEqual([
      `${MERLIN_URL}/insertModel`,
      `${MERLIN_URL}/insertExternalSimulationDataset`,
      `${MERLIN_URL}/markPlanReadOnly`,
    ]);
  });

  test("takes the model's owner from the token, not the request's x-hasura-user-id header", async () => {
    await runImport(v3Fixture, form, { 'x-hasura-role': 'user', 'x-hasura-user-id': 'someone-else' });

    expect(callsTo('InsertModel')[0].variables).toMatchObject({ requester: 'importer' });
  });

  test("accepts the token's default role when the request names none", async () => {
    const { error } = await runImport(v3Fixture, form, {});

    expect(error).toBeUndefined();
    expect(callsTo('InsertModel')[0].variables).toMatchObject({ requester: 'importer' });
  });

  test('refuses a role the token does not allow, before staging or creating anything', async () => {
    const { error } = await runImport(v3Fixture, form, { 'x-hasura-role': 'aerie_admin' });

    expect(error).toBe('Role "aerie_admin" is not in the allowed roles.');
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(callsTo('InsertModel')).toHaveLength(0);
    expect(callsTo('CreatePlan')).toHaveLength(0);
  });
});

describe('importPlan waiting for model types', () => {
  /** Runs an import with fake timers, advancing them by `ms` so polling can proceed. */
  async function runImportAdvancing(transfer: unknown, ms: number) {
    vi.useFakeTimers();
    try {
      const result = runImport(transfer);
      await vi.advanceTimersByTimeAsync(ms);
      return await result;
    } finally {
      vi.useRealTimers();
    }
  }

  test('keeps polling while a refresh is unlogged or pending, then imports', async () => {
    const statuses = [
      refreshStatus(undefined, pending, undefined),
      refreshStatus(succeeded, pending, pending),
      refreshStatus(succeeded, succeeded, succeeded),
    ];
    let poll = 0;
    responders.ModelTypeRefreshStatus = () => statuses[Math.min(poll++, statuses.length - 1)];

    const { error, plan } = await runImportAdvancing(v3Fixture, 2_000);

    expect(error).toBeUndefined();
    expect(plan.id).toBe(PLAN_ID);
    expect(callsTo('ModelTypeRefreshStatus')).toHaveLength(3);
    expect(callsTo('ModelTypeRefreshStatus')[0].variables).toEqual({ modelId: MODEL_ID });
    expect(operations().slice(-3)).toEqual([
      'InsertExternalSimulationDataset',
      'removeUploadedFile',
      'MarkPlanReadOnly',
    ]);
  });

  test('creates the plan and its activities before the types are registered', async () => {
    // Types register only once the whole plan has been built, so this would never finish if plan creation waited.
    responders.ModelTypeRefreshStatus = () =>
      callsTo('CreatePlanTags').length ? refreshStatus(succeeded, succeeded, succeeded) : refreshStatus(pending);

    const { error } = await runImportAdvancing(v3Fixture, 2_000);

    expect(error).toBeUndefined();
    const ops = operations();
    const firstPoll = ops.indexOf('ModelTypeRefreshStatus');
    const lastPoll = ops.lastIndexOf('ModelTypeRefreshStatus');
    expect(firstPoll).toBeLessThan(ops.indexOf('CreatePlan'));
    expect(ops.indexOf('CreateActivityDirectives')).toBeLessThan(lastPoll);
    expect(lastPoll).toBeLessThan(ops.indexOf('InsertExternalSimulationDataset'));
  });

  test('a failed refresh rolls back the import and returns its error', async () => {
    responders.ModelTypeRefreshStatus = () =>
      refreshStatus(succeeded, failed('Resource "/battery/state_of_charge" has an invalid schema'), succeeded);

    const { error } = await runImport(v3Fixture);

    expect(error).toBe(
      `Registering the model's resource types failed: Resource "/battery/state_of_charge" has an invalid schema`,
    );
    expect(callsTo('InsertExternalSimulationDataset')).toHaveLength(0);
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
    expect(callsTo('DeleteTags')[0].variables).toEqual({ tagIds: [FIRST_TAG_ID] });
  });

  test('gives up after 300 s and rolls back', async () => {
    responders.ModelTypeRefreshStatus = () => refreshStatus(succeeded, pending, succeeded);

    const { error } = await runImportAdvancing(v3Fixture, 301_000);

    expect(error).toBe("Timed out after 300 s waiting for the model's types to be registered.");
    expect(callsTo('InsertExternalSimulationDataset')).toHaveLength(0);
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
  });

  test('stops polling when the plan cannot be created', async () => {
    responders.ModelTypeRefreshStatus = () => refreshStatus(pending, pending, pending);
    responders.CreatePlan = () => ({ errors: [{ message: 'Uniqueness violation' }] });

    const { error } = await runImportAdvancing(v3Fixture, 2_000);
    const polls = callsTo('ModelTypeRefreshStatus').length;

    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(2_000);
    vi.useRealTimers();

    expect(error).toBe('Plan creation unsuccessful.');
    expect(callsTo('ModelTypeRefreshStatus')).toHaveLength(polls);
    expect(callsTo('DeletePlan')).toHaveLength(0);
  });
});

describe('importPlan upload', () => {
  test('reads a disk-backed plan file and removes it afterwards', async () => {
    const path = join(tmpdir(), `plan-import-test-${Date.now()}.json`);
    writeFileSync(path, `${JSON.stringify(v3Fixture, null, 2)}\n`);

    const res = { json: vi.fn(), send: vi.fn(), status: vi.fn() };
    const req = {
      body: form,
      file: { path },
      get: () => `Bearer ${token}`,
      headers: {},
    };
    await importPlan(req as any, res as any);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].id).toBe(PLAN_ID);
    expect(existsSync(path)).toBe(false);
  });
});

describe('remapResultDirectiveIds', () => {
  const results: SimulationResultsTransfer = v3Fixture.results!;

  test('rewrites only directive ids and leaves the input untouched', () => {
    const before = structuredClone(results);
    const remapped = remapResultDirectiveIds(results, { 1: 10, 2: 20 });

    expect(remapped.spans.map(({ directive_id }) => directive_id)).toEqual([10, 20, undefined, undefined]);
    expect(remapped.spans.map(({ span_id }) => span_id)).toEqual([1, 2, 3, 4]);
    expect(remapped.spans[2]).toBe(results.spans[2]);
    expect(remapped.profiles).toBe(results.profiles);
    expect(results).toEqual(before);
  });

  test('refuses a directive id with no mapping', () => {
    expect(() => remapResultDirectiveIds(results, { 1: 10 })).toThrow(UnsupportedPlanTransferError);
    expect(() => remapResultDirectiveIds(results, { 1: 10 })).toThrow(/span 2 references directive 2/);
  });
});
