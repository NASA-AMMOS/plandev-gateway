import { existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { decodeJwt, generateJwt } from '../src/packages/auth/functions';
import {
  PlanImportRequestFailedError,
  createNonExecutableModel,
  createPlanImportRequest,
  deleteNonExecutableModel,
  insertExternalSimulationDataset,
  markPlanReadOnly,
  postGraphQL,
  setPlanImportRequestStatus,
} from '../src/packages/plan/non-executable-import';
import { importPlan } from '../src/packages/plan/plan';
import type { PlanTransfer } from '../src/types/plan-transfer';

/**
 * `/importPlan`'s orchestration, with its backend calls mocked: the non-executable-import helpers (tested in
 * `non-executable-import.test.ts`) and Hasura, answered by operation name.
 */

vi.mock('../src/packages/plan/non-executable-import', async importOriginal => ({
  ...(await importOriginal<object>()),
  createNonExecutableModel: vi.fn(),
  createPlanImportRequest: vi.fn(),
  deleteNonExecutableModel: vi.fn(),
  insertExternalSimulationDataset: vi.fn(),
  markPlanReadOnly: vi.fn(),
  postGraphQL: vi.fn(),
  setPlanImportRequestStatus: vi.fn(),
  waitForModelTypes: vi.fn(),
}));

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf-8'));

const v2Fixture = fixture('plan-transfer-v2');
const v3Fixture: PlanTransfer = fixture('plan-transfer-v3');
const { model: _model, results: _results, ...v3PlanOnly } = v3Fixture;
const { results: _omitted, ...v3PlanAndModel } = v3Fixture;

const MODEL = { definitionFile: { id: 42, name: 'model.json' }, id: 900, owner: 'importer' };
const PLAN_ID = 50;
const REQUEST_ID = 70;
const FIRST_DIRECTIVE_ID = 581;

/** Hasura's answers, by operation name; a responder throws to fail the operation. */
let responders: Record<string, (variables: any) => unknown>;

const defaultResponders: typeof responders = {
  CreateActivityDirectives: ({ activityDirectivesInsertInput }) => ({
    insert_activity_directive: {
      returning: activityDirectivesInsertInput.map(({ type }: any, i: number) => ({
        id: FIRST_DIRECTIVE_ID + i,
        type,
      })),
    },
  }),
  CreatePlan: ({ plan }) => ({ createPlan: { ...plan, id: PLAN_ID } }),
  CreatePlanTags: ({ tags }) => ({ insert_plan_tags: { affected_rows: tags.length } }),
  CreateTags: ({ tags }) => ({ insert_tags: { returning: tags.map((tag: object, i: number) => ({ ...tag, id: i })) } }),
  DeletePlan: ({ id }) => ({ deletePlan: { id } }),
  DeleteTags: () => ({}),
  GetPlanByName: () => ({ plan: [] }),
  GetTags: () => ({ tags: [] }),
  InitialSimulationUpdate: () => ({ update_simulation: { returning: [{ id: 1 }] } }),
  MutationRootFields: () => ({ __type: { fields: [{ name: 'insert_plan_one' }] } }),
  UpdateActivityDirective: ({ updates }) => ({
    update_activity_directive_many: updates.map(() => ({ affected_rows: 1 })),
  }),
};

const operationName = (query: string) => /(?:query|mutation)\s+(\w+)/.exec(query)![1];

/** The GraphQL calls made for `operation`, as [query, variables, headers]. */
const callsTo = (operation: string) =>
  vi.mocked(postGraphQL).mock.calls.filter(([query]) => operationName(query) === operation);

/** When `fn` was first called (with arguments matching `match`), comparable across mocks; `Infinity` if never. */
function whenCalled(fn: unknown, match: (args: any[]) => boolean = () => true): number {
  const { calls, invocationCallOrder } = vi.mocked(fn as (...args: any[]) => unknown).mock;
  const index = calls.findIndex(match);
  return index < 0 ? Infinity : invocationCallOrder[index];
}
const whenOperation = (operation: string) => whenCalled(postGraphQL, ([query]) => operationName(query) === operation);
const whenStatus = (status: string) => whenCalled(setPlanImportRequestStatus, ([, s]) => s === status);

/** Every status the gateway gave the import request, in order. Merlin completes or fails a dataset import itself. */
const statuses = () => [
  ...vi.mocked(createPlanImportRequest).mock.calls.map(([{ status }]) => status),
  ...vi.mocked(setPlanImportRequestStatus).mock.calls.map(([, status]) => status),
];

// a real signed token, since the requester comes from the verified JWT
const JWT_SECRET = JSON.stringify({ key: 'plan-import-test-secret-plan-import-test', type: 'HS256' });
let token: string;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('HASURA_GRAPHQL_JWT_SECRET', JWT_SECRET);
  token = generateJwt('importer', 'user', ['user', 'viewer'])!;
  responders = { ...defaultResponders };
  vi.mocked(postGraphQL).mockImplementation(async (query, variables) => responders[operationName(query)](variables));
  vi.mocked(createNonExecutableModel).mockResolvedValue(MODEL);
  vi.mocked(createPlanImportRequest).mockResolvedValue(REQUEST_ID);
  vi.mocked(setPlanImportRequestStatus).mockResolvedValue();
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
  const res = { json: vi.fn(), send: vi.fn(), status: vi.fn() };
  const req = { body, file: { buffer: Buffer.from(JSON.stringify(transfer)) }, get: () => `Bearer ${token}`, headers };

  await importPlan(req as any, res as any);

  return {
    body: res.json.mock.calls[0]?.[0],
    error: res.send.mock.calls[0]?.[0],
    status: res.status.mock.calls[0]?.[0],
  };
}

describe('importPlan succeeding', () => {
  test.each([
    ['v2', v2Fixture],
    ['v3 plan-only', v3PlanOnly],
  ])('%s imports onto the requested model', async (_, transfer) => {
    const { body, status } = await runImport(transfer);

    expect(status).toBe(202);
    expect(body).toEqual({ model_id: form.model_id, plan_id: PLAN_ID, plan_import_request_id: REQUEST_ID });
    expect(statuses()).toEqual(['importing_plan', 'complete']);
    // the form, not the file, supplies the plan's model and window
    expect(callsTo('CreatePlan')[0][1].plan).toEqual({
      duration: form.duration,
      model_id: form.model_id,
      name: form.name,
      start_time: form.start_time,
    });
    expect(createNonExecutableModel).not.toHaveBeenCalled();
    expect(markPlanReadOnly).not.toHaveBeenCalled();
  });

  test('an embedded model without results gives a read-only plan on a new non-executable model', async () => {
    // with no name in the form, the file's is used
    const { body, status } = await runImport(v3PlanAndModel, { ...form, name: undefined });

    expect(status).toBe(202);
    expect(body).toEqual({ model_id: MODEL.id, plan_id: PLAN_ID, plan_import_request_id: REQUEST_ID });
    expect(statuses()).toEqual(['extracting_model', 'importing_plan', 'complete']);
    expect(createNonExecutableModel).toHaveBeenCalledWith(v3Fixture.model, { name: v3Fixture.name, owner: 'importer' });
    // the file supplies the window
    expect(callsTo('CreatePlan')[0][1].plan).toEqual({
      duration: v3Fixture.duration,
      model_id: MODEL.id,
      name: v3Fixture.name,
      start_time: v3Fixture.start_time,
    });
    expect(callsTo('CreateActivityDirectives')[0][1].activityDirectivesInsertInput).toHaveLength(2);
    expect(markPlanReadOnly).toHaveBeenCalledWith(PLAN_ID);
    expect(whenCalled(markPlanReadOnly)).toBeLessThan(whenStatus('complete'));
    expect(insertExternalSimulationDataset).not.toHaveBeenCalled();
  });

  test('an embedded model with results has merlin ingest the remapped results into the read-only plan', async () => {
    const { status } = await runImport(v3Fixture);

    expect(status).toBe(202);
    // merlin marks the request complete once it has ingested the results, never the gateway
    expect(statuses()).toEqual(['extracting_model', 'importing_plan', 'importing_dataset']);
    // the plan is fully written and read-only before merlin ingests results into it
    expect(whenOperation('CreatePlanTags')).toBeLessThan(whenCalled(markPlanReadOnly));
    expect(whenCalled(markPlanReadOnly)).toBeLessThan(whenCalled(insertExternalSimulationDataset));

    const [[ingest]] = vi.mocked(insertExternalSimulationDataset).mock.calls;
    expect(ingest).toMatchObject({
      planDuration: v3Fixture.duration,
      planId: PLAN_ID,
      planImportRequestId: REQUEST_ID,
      planStartTime: v3Fixture.start_time,
      requester: 'importer',
      simulationArguments: v3Fixture.simulation_arguments,
    });
    expect(ingest.results.spans.map(({ span_id, directive_id }) => [span_id, directive_id])).toEqual([
      [1, FIRST_DIRECTIVE_ID],
      [2, FIRST_DIRECTIVE_ID + 1],
      // generated spans keep their results-namespace ids and gain no directive
      [3, undefined],
      [4, undefined],
    ]);
    expect(ingest.results.spans[2]).toEqual(v3Fixture.results!.spans[2]);
    expect(ingest.results.profiles).toEqual(v3Fixture.results!.profiles);
  });

  test('passes types, arguments and values the model does not declare through unchanged', async () => {
    // the backend, not the gateway, decides whether they are accepted
    const transfer = structuredClone(v3Fixture);
    const extra = { calibrated: true, exposure: { gains: [1.5, -2, 0], profile: null }, note: 'MANUAL' };
    Object.assign(transfer.activities[1].arguments, extra);
    Object.assign(transfer.results!.spans[1].arguments, extra);
    const args = { heater: { zone: 3 } };
    transfer.activities.push({ ...transfer.activities[0], arguments: args, id: 3, name: 'warm', type: 'Undeclared' });
    transfer.results!.spans.push({ arguments: args, directive_id: 3, span_id: 5, start_offset: 0, type: 'Undeclared' });

    await runImport(transfer);

    const pick = ({ arguments: a, type }: any) => ({ arguments: a, type });
    expect(callsTo('CreateActivityDirectives')[0][1].activityDirectivesInsertInput.map(pick)).toEqual(
      transfer.activities.map(pick),
    );
    const withoutDirective = ({ directive_id: _, ...span }: any) => span;
    const [[{ results }]] = vi.mocked(insertExternalSimulationDataset).mock.calls;
    expect(results.spans.map(withoutDirective)).toEqual(transfer.results!.spans.map(withoutDirective));
    // no type is inferred for the model
    expect(createNonExecutableModel).toHaveBeenCalledWith(transfer.model, expect.anything());
  });

  test('reads a disk-backed plan file and removes it afterwards', async () => {
    const path = join(tmpdir(), `plan-import-test-${Date.now()}.json`);
    writeFileSync(path, JSON.stringify(v3Fixture));

    const res = { json: vi.fn(), send: vi.fn(), status: vi.fn() };
    await importPlan({ body: form, file: { path }, get: () => `Bearer ${token}`, headers: {} } as any, res as any);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(existsSync(path)).toBe(false);
  });
});

describe('importPlan credentials', () => {
  test("uses the token's requester, and fresh tokens with the accepted role after responding", async () => {
    // the header names someone else, and is ignored
    await runImport(v3Fixture, form, { 'x-hasura-role': 'user', 'x-hasura-user-id': 'someone-else' });

    expect(createNonExecutableModel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ owner: 'importer' }),
    );
    expect(createPlanImportRequest).toHaveBeenCalledWith(expect.objectContaining({ requester: 'importer' }));
    expect(insertExternalSimulationDataset).toHaveBeenCalledWith(expect.objectContaining({ requester: 'importer' }));

    // so a caller's token expiring mid-import does not matter
    expect(callsTo('CreatePlan')[0][2].Authorization).toBe(`Bearer ${token}`);
    const [, , headers] = callsTo('CreatePlanTags')[0];
    expect(headers.Authorization).not.toBe(`Bearer ${token}`);
    expect(headers['x-hasura-role']).toBe('user');
    expect(decodeJwt(headers.Authorization).jwtPayload?.username).toBe('importer');
  });
});

describe('importPlan refusing before responding', () => {
  test('a caller who cannot create plans, before anything is created', async () => {
    responders.MutationRootFields = () => ({ __type: { fields: [{ name: 'insert_tags' }] } });

    const { error, status } = await runImport(v3Fixture);

    expect(status).toBe(500);
    expect(error).toBe('You do not have permission to create a plan.');
    expect(createNonExecutableModel).not.toHaveBeenCalled();
    expect(callsTo('CreatePlan')).toHaveLength(0);
  });

  test('a file whose results reference an unknown directive, before any backend call', async () => {
    const transfer = structuredClone(v3Fixture);
    transfer.results!.spans[0].directive_id = 99;

    const { error, status } = await runImport(transfer);

    expect(status).toBe(500);
    expect(error).toBe('Result span 1 references directive 99, which is not an activity in this plan file.');
    expect(postGraphQL).not.toHaveBeenCalled();
  });
});

describe('importPlan failing after responding', () => {
  /** A failed import is recorded as failed, with its reason, before being rolled back, and never completes. */
  function expectFailedThenRolledBack(reason: object) {
    expect(setPlanImportRequestStatus).toHaveBeenCalledWith(REQUEST_ID, 'failed', reason);
    expect(statuses()).not.toContain('complete');
    expect(whenStatus('failed')).toBeLessThan(whenOperation('DeletePlan'));
    expect(callsTo('DeletePlan')[0][1]).toEqual({ id: PLAN_ID });
  }

  test('a plan that cannot be made read-only, once its contents are written', async () => {
    vi.mocked(markPlanReadOnly).mockRejectedValue(new Error('plan cannot be marked read only'));

    const { status } = await runImport(v3Fixture);

    expect(status).toBe(202);
    expectFailedThenRolledBack({ message: 'plan cannot be marked read only' });
    expect(insertExternalSimulationDataset).not.toHaveBeenCalled();
    expect(deleteNonExecutableModel).toHaveBeenCalledWith(MODEL);
  });

  test('merlin failing to ingest the results, keeping its reason whole', async () => {
    const reason = { message: 'duplicate profile segment', type: 'SQL_EXCEPTION' };
    vi.mocked(insertExternalSimulationDataset).mockRejectedValue(new PlanImportRequestFailedError(reason));

    await runImport(v3Fixture);

    expect(statuses()).toContain('importing_dataset');
    expectFailedThenRolledBack(reason);
    expect(deleteNonExecutableModel).toHaveBeenCalledWith(MODEL);
  });

  test('a cleanup failure leaves the request failed with its original reason, and keeps the model', async () => {
    vi.mocked(markPlanReadOnly).mockRejectedValue(new Error('plan cannot be marked read only'));
    responders.DeletePlan = () => {
      throw new Error('database unavailable');
    };

    await runImport(v3Fixture);

    expectFailedThenRolledBack({ message: 'plan cannot be marked read only' });
    // the plan still uses the model
    expect(deleteNonExecutableModel).not.toHaveBeenCalled();
  });
});
