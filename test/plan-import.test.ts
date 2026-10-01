import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import fetch from 'node-fetch';
import { decodeJwt, generateJwt } from '../src/packages/auth/functions';
import { removeUploadedFile, storeUploadedFile } from '../src/packages/files/store';
import { importPlan } from '../src/packages/plan/plan';
import type { PlanTransfer } from '../src/types/plan-transfer';

vi.mock('node-fetch', () => ({ default: vi.fn() }));
// the gateway writes plan_import_request rows directly, like uploaded files
vi.mock('../src/packages/db/db', () => ({
  DbMerlin: { getDb: () => ({ query: (sql: string, params: unknown[]) => dbQuery(sql, params) }) },
}));
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
const REQUEST_ID = 70;
const FIRST_DIRECTIVE_ID = 581;
const FIRST_TAG_ID = 300;

type Call = { headers?: Record<string, string>; operation: string; variables: any };
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
  CreatePlan: ({ plan }) => ({ data: { createPlan: { ...plan, id: PLAN_ID } } }),
  CreatePlanTags: ({ tags }) => ({ data: { insert_plan_tags: { affected_rows: tags.length } } }),
  CreateTags: ({ tags }) => ({
    data: {
      insert_tags: { returning: tags.map((tag: object, index: number) => ({ ...tag, id: FIRST_TAG_ID + index })) },
    },
  }),
  GetPlanByName: () => ({ data: { plan: [] } }),
  MutationRootFields: () => mutationRoot('insert_activity_directive', 'insert_plan_one', 'insert_tags'),
  GetTags: () => ({ data: { tags: [] } }),
  InitialSimulationUpdate: () => ({ data: { update_simulation: { returning: [{ id: 1 }] } } }),
  InsertNonExecutableModel: () => ({ data: { insert_mission_model_one: { id: MODEL_ID } } }),
  ModelTypeRefreshStatus: () => refreshStatus(succeeded, succeeded, succeeded),
  // merlin marks the request complete once it has ingested the results
  InsertExternalSimulationDataset: ({ requestId }) => {
    merlinSetsStatus(requestId, 'complete');
    return { text: '' };
  },
  MarkPlanReadOnly: () => ({ text: '' }),
  UpdateActivityDirective: ({ updates }) => ({
    data: { update_activity_directive_many: updates.map(() => ({ affected_rows: 1 })) },
  }),
  DeleteMissionModel: ({ id }) => ({ data: { delete_mission_model_by_pk: { id } } }),
  DeletePlan: ({ id }) => ({ data: { deletePlan: { id } } }),
  DeleteTags: ({ tagIds }) => ({ data: { delete_tags: { affected_rows: tagIds.length } } }),
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

type ImportRequest = { model_id: number; plan_id: number; reason: any; requester: string; status: string };
let importRequests: Record<number, ImportRequest>;
/** Every status the import request has been given, by the gateway or merlin, in order. */
let statusHistory: string[];

/** Merlin advancing the import request, as it does once it has ingested (or failed to ingest) the results. */
function merlinSetsStatus(id: number, status: string, reason: unknown = null) {
  Object.assign(importRequests[id], { reason, status });
  statusHistory.push(status);
}

/** The fake database's answer to the gateway's plan_import_request queries, recorded like the other calls. */
async function dbQuery(sql: string, params: any[]) {
  if (sql.includes('extract(epoch from $1::interval)')) {
    // the fixture's 24:00:00
    return { rows: [{ microseconds: params[0] === '24:00:00' ? '86400000000' : undefined }] };
  }
  if (sql.includes('insert into merlin.plan_import_request')) {
    const [requester, status, model_id, plan_id] = params;
    importRequests[REQUEST_ID] = { model_id, plan_id, reason: null, requester, status };
    statusHistory.push(status);
    calls.push({ operation: 'InsertPlanImportRequest', variables: importRequests[REQUEST_ID] });
    return { rows: [{ id: REQUEST_ID }] };
  }
  if (sql.includes('update merlin.plan_import_request')) {
    const [id, status, reason] = params;
    calls.push({ operation: `SetImportStatus:${status}`, variables: { id, reason } });
    // like the database, updating a request that is gone changes nothing
    if (importRequests[id]) {
      Object.assign(importRequests[id], { reason, status });
      statusHistory.push(status);
    }
    return { rows: [] };
  }
  if (sql.includes('select status, reason from merlin.plan_import_request')) {
    calls.push({ operation: 'PollImportRequest', variables: { id: params[0] } });
    const request = importRequests[params[0]];
    return { rows: request ? [{ reason: request.reason, status: request.status }] : [] };
  }
  throw new Error(`unexpected query: ${sql}`);
}

const callsTo = (operation: string) => calls.filter(call => call.operation === operation);
const operations = () => calls.map(({ operation }) => operation);

beforeEach(() => {
  vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', JWT_SECRET);
  token = generateJwt('importer', 'user', ['user', 'viewer'])!;
  calls = [];
  importRequests = {};
  statusHistory = [];
  responders = { ...defaultResponders };
  vi.mocked(storeUploadedFile).mockClear();
  vi.mocked(removeUploadedFile).mockReset();
  // recorded alongside the GraphQL calls, so tests can check when a staged file is removed
  vi.mocked(removeUploadedFile).mockImplementation(async file => {
    calls.push({ operation: 'removeUploadedFile', variables: file });
  });
  vi.mocked(fetch).mockClear();
  vi.mocked(fetch).mockImplementation((async (
    url: unknown,
    init: { body: string; headers: Record<string, string> },
  ) => {
    if (String(url).startsWith(`${MERLIN_URL}/`)) {
      const endpoint = String(url).slice(MERLIN_URL.length + 1);
      // labelled like the GraphQL operations, e.g. markPlanReadOnly -> MarkPlanReadOnly
      const operation = endpoint[0].toUpperCase() + endpoint.slice(1);
      const body = JSON.parse(init.body);
      calls.push({ operation, variables: body });
      const { status = 200, text } = responders[operation](body) as { status?: number; text: string };
      return { ok: status < 300, status, text: async () => text };
    }

    const { query, variables } = JSON.parse(init.body);
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1] ?? 'unknown';
    calls.push({ headers: init.headers, operation, variables });
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

  const failed = res.send.mock.calls.length > 0;
  return {
    body: failed ? undefined : res.json.mock.calls[0]?.[0],
    error: failed ? (res.send.mock.calls[0]?.[0] as string) : undefined,
    /** The import request's final state, for an import with an embedded model. */
    request: importRequests[REQUEST_ID] as ImportRequest | undefined,
    res,
  };
}

describe('importPlan without an embedded model', () => {
  test.each([
    ['v2', v2Fixture],
    ['v3 plan-only', v3PlanOnly],
  ])('%s imports onto the requested model, tracked by an import request', async (_, transfer) => {
    const { body, error, request, res } = await runImport(transfer);

    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(body).toEqual({ model_id: form.model_id, plan_id: PLAN_ID, plan_import_request_id: REQUEST_ID });
    expect(operations()).toEqual([
      'CreatePlan',
      'InsertPlanImportRequest',
      'InitialSimulationUpdate',
      'GetTags',
      'CreateTags',
      'CreateActivityDirectives',
      'UpdateActivityDirective',
      'CreatePlanTags',
      'SetImportStatus:complete',
    ]);
    // no model to wait for, so it starts at importing_plan
    expect(statusHistory).toEqual(['importing_plan', 'complete']);
    expect(request).toEqual({
      model_id: form.model_id,
      plan_id: PLAN_ID,
      reason: null,
      requester: 'importer',
      status: 'complete',
    });
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

/** The operations before `/importPlan` responds to an embedded-model import. */
const STARTED = [
  'MutationRootFields',
  'GetPlanByName',
  'InsertNonExecutableModel',
  'CreatePlan',
  'InsertPlanImportRequest',
] as const;

/** Filling the plan, once the model's types are registered. */
const FILLED = [
  'SetImportStatus:importing_plan',
  'InitialSimulationUpdate',
  'GetTags',
  'CreateTags',
  'CreateActivityDirectives',
  'UpdateActivityDirective',
  'CreatePlanTags',
  'MarkPlanReadOnly',
] as const;

describe('importPlan with an embedded model', () => {
  test('responds with the import request once the model and an empty plan exist, then completes it', async () => {
    const { body, error, request, res } = await runImport(v3PlanAndModel);

    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(body).toEqual({ model_id: MODEL_ID, plan_id: PLAN_ID, plan_import_request_id: REQUEST_ID });
    expect(operations()).toEqual([...STARTED, 'ModelTypeRefreshStatus', ...FILLED, 'SetImportStatus:complete']);
    expect(statusHistory).toEqual(['extracting_model', 'importing_plan', 'complete']);
    expect(request).toEqual({
      model_id: MODEL_ID,
      plan_id: PLAN_ID,
      reason: null,
      requester: 'importer',
      status: 'complete',
    });

    expect(storeUploadedFile).toHaveBeenCalledWith('plan-transfer-model.json', JSON.stringify(v3Fixture.model));
    expect(callsTo('InsertNonExecutableModel')[0].variables).toEqual({
      definition_file_id: MODEL_FILE.id,
      description:
        'Non-executable model imported with the plan "Imported plan". It declares 3 activity type(s) and 2 resource ' +
        'type(s) and cannot be simulated.',
      mission: '',
      name: form.name,
      owner: 'importer',
      version: expect.any(String),
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
    expect(callsTo('MarkPlanReadOnly')[0].variables).toEqual({ planId: PLAN_ID });

    // without results merlin has nothing to ingest
    expect(callsTo('InsertExternalSimulationDataset')).toHaveLength(0);
    expect(vi.mocked(storeUploadedFile).mock.calls.map(([name]) => name)).toEqual(['plan-transfer-model.json']);
    expect(removeUploadedFile).not.toHaveBeenCalled();
  });

  test("falls back to the file's plan name", async () => {
    await runImport(v3PlanAndModel, { ...form, name: undefined });

    expect(callsTo('GetPlanByName')[0].variables).toEqual({ name: v3Fixture.name });
    expect(callsTo('CreatePlan')[0].variables.plan.name).toBe(v3Fixture.name);
  });

  test('makes the plan read-only, then has merlin ingest the remapped results and waits for it', async () => {
    const { error, request } = await runImport(v3Fixture);

    expect(error).toBeUndefined();
    expect(request?.status).toBe('complete');
    expect(statusHistory).toEqual(['extracting_model', 'importing_plan', 'importing_dataset', 'complete']);
    expect(operations()).toEqual([
      ...STARTED,
      'ModelTypeRefreshStatus',
      ...FILLED,
      'SetImportStatus:importing_dataset',
      'InsertExternalSimulationDataset',
      'PollImportRequest',
      // removed only once merlin is done with it; the model's definition file stays
      'removeUploadedFile',
    ]);
    expect(callsTo('removeUploadedFile').map(({ variables }) => variables)).toEqual([RESULTS_FILE]);
    // through merlin itself, not Hasura
    const merlinUrls = vi
      .mocked(fetch)
      .mock.calls.map(([url]) => String(url))
      .filter(url => url.startsWith(MERLIN_URL));
    expect(merlinUrls).toEqual([`${MERLIN_URL}/markPlanReadOnly`, `${MERLIN_URL}/insertExternalSimulationDataset`]);

    // merlin's day-of-year timestamps, and the plan's 24:00:00 in microseconds; the fixture's results inherit the
    // plan's window
    expect(callsTo('InsertExternalSimulationDataset')[0].variables).toEqual({
      planId: PLAN_ID,
      planStartTime: '2030-001T00:00:00',
      requestId: REQUEST_ID,
      requester: 'importer',
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
  });

  test('writes each profile with type and schema before segments, keeping segment order', async () => {
    const transfer = structuredClone(v3Fixture);
    const [name, { schema, segments, type }] = Object.entries(transfer.results!.profiles)[0];
    transfer.results!.profiles[name] = { segments, schema, type } as never;

    await runImport(transfer);

    const staged = stagedResults().profiles[name];
    expect(Object.keys(staged)).toEqual(['type', 'schema', 'segments']);
    expect(staged.segments).toEqual(segments);
  });
});

describe('importPlan refusing an embedded-model import before responding', () => {
  test.each([
    ['a role without insert_plan_one', mutationRoot('insert_tags')],
    ['a role with no mutations at all', { data: { __type: null } }],
  ])('refuses %s before staging or creating anything', async (_, response) => {
    responders.MutationRootFields = () => response;

    const { error, res } = await runImport(v3Fixture);

    expect(res.status).toHaveBeenCalledWith(500);
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

  test.each([
    ['fails', { errors: [{ message: 'model declaration rejected' }] }, 'model declaration rejected'],
    [
      'returns no model',
      { data: { insert_mission_model_one: null } },
      'Non-executable model creation returned no model id.',
    ],
  ])('a model insert that %s creates no plan and discards the staged definition', async (_, response, message) => {
    responders.InsertNonExecutableModel = () => response;

    const { error, request } = await runImport(v3Fixture);

    expect(error).toBe(message);
    expect(callsTo('CreatePlan')).toHaveLength(0);
    expect(callsTo('DeleteMissionModel')).toHaveLength(0);
    expect(removeUploadedFile).toHaveBeenCalledWith(MODEL_FILE);
    expect(request).toBeUndefined();
  });

  test('a failed plan creation deletes the model and records no request', async () => {
    responders.CreatePlan = () => ({ errors: [{ message: 'Uniqueness violation' }] });

    const { error, request } = await runImport(v3Fixture);

    expect(error).toBe('Uniqueness violation');
    expect(callsTo('DeletePlan')).toHaveLength(0);
    expect(callsTo('DeleteMissionModel')[0].variables).toEqual({ id: MODEL_ID });
    expect(removeUploadedFile).toHaveBeenCalledWith(MODEL_FILE);
    expect(request).toBeUndefined();
  });

  test('a span referencing an unknown directive fails before anything is created', async () => {
    const transfer = structuredClone(v3Fixture);
    transfer.results!.spans[0].directive_id = 99;

    const { error } = await runImport(transfer);

    expect(error).toBe('Result span 1 references directive 99, which is not an activity in this plan file.');
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(operations()).toEqual([]);
  });

  test('leaves the model alone on a plan-only import', async () => {
    responders.CreatePlan = () => ({ errors: [{ message: 'Uniqueness violation' }] });

    await runImport(v3PlanOnly);

    expect(callsTo('DeleteMissionModel')).toHaveLength(0);
  });

  test('a plan-only import that fails after responding deletes only its plan and tags', async () => {
    responders.CreateActivityDirectives = () => ({ data: { insert_activity_directive: null } });

    const { request, res } = await runImport(v3PlanOnly);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(request?.status).toBe('failed');
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
    expect(callsTo('DeleteMissionModel')).toHaveLength(0);
  });
});

describe('importPlan failing after responding', () => {
  /** A failure is reported through the request, which is marked failed before the import is rolled back. */
  async function expectFailedAndRolledBack(transfer: unknown, message: string) {
    const { error, request, res } = await runImport(transfer);

    expect(error).toBeUndefined();
    expect(res.status).toHaveBeenCalledWith(202);
    expect(request?.status).toBe('failed');
    expect(request?.reason).toMatchObject({ message });
    expect(statusHistory).not.toContain('complete');

    const ops = operations();
    expect(ops.indexOf('SetImportStatus:failed')).toBeLessThan(ops.indexOf('DeletePlan'));
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
    expect(callsTo('DeleteMissionModel')[0].variables).toEqual({ id: MODEL_ID });
    expect(callsTo('removeUploadedFile').at(-1)?.variables).toEqual(MODEL_FILE);

    // as the requester's admin token, so a caller's token that expired mid-import can still be cleaned up after
    for (const { headers } of [...callsTo('DeletePlan'), ...callsTo('DeleteTags')]) {
      expect(headers?.['x-hasura-role']).toBe('admin');
      expect(decodeJwt(headers?.Authorization).jwtPayload?.username).toBe('importer');
    }
  }

  test('a failed type registration', async () => {
    responders.ModelTypeRefreshStatus = () =>
      refreshStatus(succeeded, failed('Resource "/battery/state_of_charge" has an invalid schema'), succeeded);

    await expectFailedAndRolledBack(
      v3Fixture,
      `Registering the model's resource types failed: Resource "/battery/state_of_charge" has an invalid schema`,
    );
    expect(callsTo('InitialSimulationUpdate')).toHaveLength(0);
    // the plan was still empty, so there were no tags to remove
    expect(callsTo('DeleteTags')[0].variables).toEqual({ tagIds: [] });
  });

  test('a plan that cannot be made read-only, removing the tags the import created', async () => {
    responders.MarkPlanReadOnly = () => merlinError('plan cannot be marked read only');

    await expectFailedAndRolledBack(v3Fixture, 'plan cannot be marked read only');
    // every activity, anchor and tag had already been written, and the plan holding them is deleted
    const ops = operations();
    for (const write of ['CreateActivityDirectives', 'UpdateActivityDirective', 'CreatePlanTags']) {
      expect(ops.indexOf(write)).toBeLessThan(ops.indexOf('SetImportStatus:failed'));
    }
    expect(callsTo('DeleteTags')[0].variables).toEqual({ tagIds: [FIRST_TAG_ID] });
    expect(callsTo('InsertExternalSimulationDataset')).toHaveLength(0);
  });

  test.each([
    ['simulation arguments', 'InitialSimulationUpdate'],
    // e.g. the database refusing an activity's type or arguments
    ['activities', 'CreateActivityDirectives'],
    ['activity anchors', 'UpdateActivityDirective'],
    ['plan tags', 'CreatePlanTags'],
  ])('a rejected %s write', async (_, operation) => {
    responders[operation] = () => ({ errors: [{ message: `${operation} rejected` }] });

    await expectFailedAndRolledBack(v3Fixture, `${operation} rejected`);
    expect(callsTo('MarkPlanReadOnly')).toHaveLength(0);
  });

  test('an anchor update that affects no row', async () => {
    responders.UpdateActivityDirective = ({ updates }) => ({
      data: { update_activity_directive_many: updates.map(() => ({ affected_rows: 0 })) },
    });

    await expectFailedAndRolledBack(v3Fixture, 'Not all activity anchors were updated.');
    expect(callsTo('MarkPlanReadOnly')).toHaveLength(0);
  });

  test('merlin refusing the results', async () => {
    responders.InsertExternalSimulationDataset = () => merlinError('profile rejected');

    await expectFailedAndRolledBack(v3Fixture, 'profile rejected');
    expect(removeUploadedFile).toHaveBeenCalledWith(RESULTS_FILE);
  });

  test('merlin marking the request failed, with its reason', async () => {
    responders.InsertExternalSimulationDataset = ({ requestId }) => {
      merlinSetsStatus(requestId, 'failed', { message: 'duplicate profile segment', type: 'SQL_EXCEPTION' });
      return { text: '' };
    };

    await expectFailedAndRolledBack(v3Fixture, 'duplicate profile segment');
    expect(importRequests[REQUEST_ID].reason).toEqual({ message: 'duplicate profile segment', type: 'SQL_EXCEPTION' });
    expect(statusHistory).toEqual(['extracting_model', 'importing_plan', 'importing_dataset', 'failed', 'failed']);
    // the staged results are removed before the plan they were for
    const ops = operations();
    expect(ops.indexOf('removeUploadedFile')).toBeLessThan(ops.indexOf('DeletePlan'));
    expect(callsTo('removeUploadedFile')[0].variables).toEqual(RESULTS_FILE);
  });

  // the plan's contents were all written, and cleanup is best-effort: whatever is left behind, the request still says
  // the import failed, and why
  test.each([
    ['the plan cannot be deleted', 'DeletePlan', { errors: [{ message: 'database unavailable' }] }, 0],
    ['deleting the plan returns null', 'DeletePlan', { data: { deletePlan: null } }, 0],
    ['the model cannot be deleted', 'DeleteMissionModel', { errors: [{ message: 'database unavailable' }] }, 1],
  ])('keeps the request failed, and the model definition, when %s', async (_, operation, response, modelDeletes) => {
    responders.MarkPlanReadOnly = () => merlinError('plan cannot be marked read only');
    responders[operation] = () => response;

    const { request } = await runImport(v3Fixture);

    expect(request).toMatchObject({ reason: { message: 'plan cannot be marked read only' }, status: 'failed' });
    expect(statusHistory).not.toContain('complete');
    expect(callsTo('DeleteMissionModel')).toHaveLength(modelDeletes);
    expect(removeUploadedFile).not.toHaveBeenCalledWith(MODEL_FILE);
  });
});

describe('importPlan calling the backend', () => {
  test("inserts the model with a short-lived admin token for the caller, not the caller's own token", async () => {
    await runImport(v3Fixture);

    const { headers } = callsTo('InsertNonExecutableModel')[0];
    expect(headers?.['x-hasura-role']).toBe('admin');
    expect(headers?.Authorization).not.toBe(`Bearer ${token}`);

    const { jwtPayload } = decodeJwt(headers?.Authorization);
    expect(jwtPayload?.['https://hasura.io/jwt/claims']).toEqual({
      'x-hasura-allowed-roles': ['admin'],
      'x-hasura-default-role': 'admin',
      'x-hasura-user-id': 'importer',
    });
    expect(jwtPayload!.exp! - jwtPayload!.iat!).toBe(10);

    // acceptance uses the caller's token; background writes use fresh gateway-owned tokens with the accepted role
    expect(callsTo('CreatePlan')[0].headers?.Authorization).toBe(`Bearer ${token}`);
    for (const call of [
      ...callsTo('ModelTypeRefreshStatus'),
      ...callsTo('InitialSimulationUpdate'),
      ...callsTo('UpdateActivityDirective'),
      ...callsTo('CreatePlanTags'),
    ]) {
      expect(call.headers?.Authorization).not.toBe(`Bearer ${token}`);
      expect(call.headers?.['x-hasura-role']).toBe('user');
      expect(decodeJwt(call.headers?.Authorization).jwtPayload?.username).toBe('importer');
    }
  });

  test('takes the requester from the token, not the x-hasura-user-id header', async () => {
    const { request } = await runImport(v3Fixture, form, {
      'x-hasura-role': 'user',
      'x-hasura-user-id': 'someone-else',
    });

    expect(callsTo('InsertNonExecutableModel')[0].variables).toMatchObject({ owner: 'importer' });
    expect(callsTo('InsertExternalSimulationDataset')[0].variables).toMatchObject({ requester: 'importer' });
    expect(request?.requester).toBe('importer');
  });

  test("accepts the token's default role when the request names none", async () => {
    const { error } = await runImport(v3Fixture, form, {});

    expect(error).toBeUndefined();
    expect(callsTo('InsertNonExecutableModel')[0].variables).toMatchObject({ owner: 'importer' });
  });

  test('refuses a role the token does not allow, before staging or creating anything', async () => {
    const { error } = await runImport(v3Fixture, form, { 'x-hasura-role': 'aerie_admin' });

    expect(error).toBe('Role "aerie_admin" is not in the allowed roles.');
    expect(storeUploadedFile).not.toHaveBeenCalled();
    expect(operations()).toEqual([]);
  });
});

describe('importPlan polling', () => {
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

  test('keeps polling while a type refresh is unlogged or pending, and only then fills the plan', async () => {
    const statuses = [
      refreshStatus(undefined, pending, undefined),
      refreshStatus(succeeded, pending, pending),
      refreshStatus(succeeded, succeeded, succeeded),
    ];
    let poll = 0;
    responders.ModelTypeRefreshStatus = () => statuses[Math.min(poll++, statuses.length - 1)];

    const { request } = await runImportAdvancing(v3Fixture, 2_000);

    expect(request?.status).toBe('complete');
    expect(callsTo('ModelTypeRefreshStatus')).toHaveLength(3);
    expect(callsTo('ModelTypeRefreshStatus')[0].variables).toEqual({ modelId: MODEL_ID });
    const ops = operations();
    expect(ops.lastIndexOf('ModelTypeRefreshStatus')).toBeLessThan(ops.indexOf('SetImportStatus:importing_plan'));
  });

  test('gives up on the types after 300 s and rolls back', async () => {
    responders.ModelTypeRefreshStatus = () => refreshStatus(succeeded, pending, succeeded);

    const { request } = await runImportAdvancing(v3Fixture, 301_000);

    expect(request?.reason).toEqual({
      message: "Timed out after 300 s waiting for the model's types to be registered.",
    });
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
  });

  test('keeps polling the request until merlin has ingested the results', async () => {
    responders.InsertExternalSimulationDataset = ({ requestId }) => {
      setTimeout(() => merlinSetsStatus(requestId, 'complete'), 2_500);
      return { text: '' };
    };

    const { request } = await runImportAdvancing(v3Fixture, 5_000);

    expect(request?.status).toBe('complete');
    expect(callsTo('PollImportRequest')).toHaveLength(4);
    expect(operations().at(-1)).toBe('removeUploadedFile');
  });

  test('gives up on the results after an hour and rolls back', async () => {
    // merlin accepts the results but never finishes the request
    responders.InsertExternalSimulationDataset = () => ({ text: '' });

    const { request } = await runImportAdvancing(v3Fixture, 3_601_000);

    expect(request).toMatchObject({
      reason: { message: 'Timed out after 3600 s waiting for the results to be ingested.' },
      status: 'failed',
    });
    expect(statusHistory).not.toContain('complete');
    expect(removeUploadedFile).toHaveBeenCalledWith(RESULTS_FILE);
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
    expect(callsTo('DeleteMissionModel')[0].variables).toEqual({ id: MODEL_ID });
  });

  test('treats an import request that disappears during ingestion as a failure and rolls back', async () => {
    responders.InsertExternalSimulationDataset = ({ requestId }) => {
      delete importRequests[requestId];
      return { text: '' };
    };

    const { request } = await runImport(v3Fixture);

    // there is no row left to record the failure in
    expect(request).toBeUndefined();
    expect(callsTo('SetImportStatus:failed')[0].variables.reason).toEqual({
      message: `Import request ${REQUEST_ID} was not found while waiting for its results to be ingested.`,
    });
    expect(statusHistory).not.toContain('complete');
    expect(removeUploadedFile).toHaveBeenCalledWith(RESULTS_FILE);
    expect(callsTo('DeletePlan')[0].variables).toEqual({ id: PLAN_ID });
    expect(callsTo('DeleteMissionModel')[0].variables).toEqual({ id: MODEL_ID });
  });
});

/**
 * The gateway hands activity and span values to the backend as the file gives them. It does not check them against the
 * embedded model's declarations: whether they are accepted is the backend's decision (see the rejected activities
 * write above), and any type or arguments the model does not declare are kept for the backend and UI to present.
 */
describe('importPlan passing file values through', () => {
  test('nested, scalar and null values, and types and arguments the model does not declare', async () => {
    const transfer = structuredClone(v3Fixture);
    // TakeImage declares none of these, and Calibrate declares no parameters at all
    const extra = { calibrated: true, exposure: { gains: [1.5, -2, 0], profile: null }, note: 'MANUAL' };
    Object.assign(transfer.activities[1].arguments, extra);
    Object.assign(transfer.results!.spans[1].arguments, extra);
    transfer.activities[1].metadata.flags = [false, null];
    const args = { heater: { zone: 3 } };
    transfer.activities.push({ ...transfer.activities[0], arguments: args, id: 3, name: 'warm', type: 'Undeclared' });
    transfer.results!.spans.push({ arguments: args, directive_id: 3, span_id: 5, start_offset: 0, type: 'Undeclared' });

    const { request } = await runImport(transfer);

    expect(request?.status).toBe('complete');
    const pick = ({ arguments: a, metadata, type }: any) => ({ arguments: a, metadata, type });
    expect(callsTo('CreateActivityDirectives')[0].variables.activityDirectivesInsertInput.map(pick)).toEqual(
      transfer.activities.map(pick),
    );
    const withoutDirective = ({ directive_id: _, ...span }: any) => span;
    expect(stagedResults().spans.map(withoutDirective)).toEqual(transfer.results!.spans.map(withoutDirective));
    // the model is created as declared, with no type inferred for the activity
    expect(storeUploadedFile).toHaveBeenCalledWith('plan-transfer-model.json', JSON.stringify(transfer.model));
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

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json.mock.calls[0][0].plan_id).toBe(PLAN_ID);
    expect(existsSync(path)).toBe(false);
  });
});
