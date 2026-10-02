import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fetch from 'node-fetch';
import { removeUploadedFile, storeUploadedFile } from '../src/packages/files/store';
import {
  deleteNonExecutableModel,
  insertExternalSimulationDataset,
  waitForModelTypes,
} from '../src/packages/plan/non-executable-import';

/** The polling, staging and cleanup details of a self-contained import, below `/importPlan`. */

vi.mock('node-fetch', () => ({ default: vi.fn() }));
vi.mock('../src/packages/db/db', () => ({ DbMerlin: { getDb: () => ({ query: vi.fn(async () => dbAnswer()) }) } }));
vi.mock('../src/packages/files/store', () => ({
  removeUploadedFile: vi.fn(),
  storeUploadedFile: vi.fn(async () => RESULTS_FILE),
}));

const RESULTS_FILE = { id: 43, name: 'plan-transfer-results-1-def.json' };

/** What the database answers the import request poll with. */
let dbAnswer: () => { rows: unknown[] };
/** What Hasura or merlin answers, as `{ json }` or `{ text, status }`. */
let backend: (url: string, body: any) => { json?: unknown; status?: number; text?: string };

beforeEach(() => {
  vi.stubEnv(
    'HASURA_GRAPHQL_JWT_SECRET',
    JSON.stringify({ key: 'helper-test-secret-helper-test-secret', type: 'HS256' }),
  );
  vi.mocked(storeUploadedFile).mockClear();
  vi.mocked(removeUploadedFile).mockReset();
  vi.mocked(fetch).mockReset();
  vi.mocked(fetch).mockImplementation((async (url: string, init: { body: string }) => {
    const { json, status = 200, text = '' } = backend(String(url), JSON.parse(init.body));
    return { json: async () => json, ok: status < 300, status, text: async () => text };
  }) as any);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets fake time pass while `promise` runs. */
async function advancing<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {}); // awaited by the caller; this only stops it being reported as unhandled meanwhile
  await vi.advanceTimersByTimeAsync(ms);
  return promise;
}

describe('waitForModelTypes', () => {
  type Log = { error_message: string | null; pending: boolean; success: boolean } | undefined;
  const pending: Log = { error_message: null, pending: true, success: false };
  const succeeded: Log = { error_message: null, pending: false, success: true };

  /** Answers successive polls with the latest log for activity types, resource types and model parameters. */
  function polls(...answers: [Log, Log, Log][]) {
    let poll = 0;
    backend = () => {
      const [activity, resource, parameter] = answers[Math.min(poll++, answers.length - 1)];
      const logs = (log: Log) => (log ? [log] : []);
      return {
        json: {
          data: {
            mission_model_by_pk: {
              refresh_activity_type_logs: logs(activity),
              refresh_model_parameter_logs: logs(parameter),
              refresh_resource_type_logs: logs(resource),
            },
          },
        },
      };
    };
  }

  test('keeps polling while a refresh is unlogged or pending', async () => {
    polls([undefined, pending, undefined], [succeeded, pending, pending], [succeeded, succeeded, succeeded]);

    await advancing(
      waitForModelTypes(900, () => ({})),
      2_000,
    );

    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('fails on a failed refresh, with its message', async () => {
    polls([succeeded, { error_message: 'invalid schema', pending: false, success: false }, succeeded]);

    await expect(waitForModelTypes(900, () => ({}))).rejects.toThrow(
      "Registering the model's resource types failed: invalid schema",
    );
  });

  test('times out after 300 s', async () => {
    polls([succeeded, pending, succeeded]);

    await expect(
      advancing(
        waitForModelTypes(900, () => ({})),
        301_000,
      ),
    ).rejects.toThrow("Timed out after 300 s waiting for the model's types to be registered.");
  });
});

describe('insertExternalSimulationDataset', () => {
  const results = {
    duration: 7_200_000_000,
    // the profile's keys out of order, as a file may give them
    profiles: { '/power': { segments: [{ dynamics: 1, duration: 10 }], schema: { type: 'real' }, type: 'discrete' } },
    spans: [{ arguments: {}, directive_id: 581, span_id: 1, start_offset: 0, type: 'Calibrate' }],
    // a subset simulation, an hour into the plan
    start_time: '2030-01-01T01:00:00+00:00',
  } as any;

  const ingest = () =>
    insertExternalSimulationDataset({
      planDuration: '24:00:00',
      planId: 50,
      planImportRequestId: 70,
      planStartTime: '2030-01-01T00:00:00+00:00',
      requester: 'importer',
      results,
      simulationArguments: {},
    });

  let merlinCalls: any[];
  beforeEach(() => {
    merlinCalls = [];
    backend = (_, body) => {
      merlinCalls.push(body);
      return {};
    };
  });

  test("stages profiles with type and schema first, passes the results' window, and waits for merlin", async () => {
    let status = 'importing_dataset';
    dbAnswer = () => ({ rows: [{ reason: null, status }] });
    setTimeout(() => (status = 'complete'), 2_500);

    await advancing(ingest(), 5_000);

    const staged = JSON.parse(vi.mocked(storeUploadedFile).mock.calls[0][1]);
    expect(Object.keys(staged.profiles['/power'])).toEqual(['type', 'schema', 'segments']);
    expect(staged.spans).toEqual(results.spans);
    expect(merlinCalls[0]).toMatchObject({
      planStartTime: '2030-001T00:00:00',
      resultsFileId: RESULTS_FILE.id,
      simulationDuration: 7_200_000_000,
      simulationStartTime: '2030-001T01:00:00',
    });
    expect(removeUploadedFile).toHaveBeenCalledWith(RESULTS_FILE);
  });

  test.each([
    [
      'merlin refuses the results',
      () => ({ status: 400, text: JSON.stringify({ message: 'profile rejected' }) }),
      {},
      'profile rejected',
    ],
    [
      'the request is marked failed',
      () => ({}),
      { rows: [{ reason: { message: 'bad segment' }, status: 'failed' }] },
      'bad segment',
    ],
    [
      'the request disappears',
      () => ({}),
      { rows: [] },
      'Import request 70 was not found while waiting for its results to be ingested.',
    ],
  ])('fails, removing the staged file, when %s', async (_, merlin, rows, message) => {
    backend = merlin;
    dbAnswer = () => rows as { rows: unknown[] };

    await expect(ingest()).rejects.toThrow(message);
    expect(removeUploadedFile).toHaveBeenCalledWith(RESULTS_FILE);
  });

  test('times out after an hour, removing the staged file only then', async () => {
    dbAnswer = () => ({ rows: [{ reason: null, status: 'importing_dataset' }] });

    const ingesting = ingest();
    await vi.advanceTimersByTimeAsync(3_599_000);
    expect(removeUploadedFile).not.toHaveBeenCalled();

    await expect(advancing(ingesting, 2_000)).rejects.toThrow(
      'Timed out after 3600 s waiting for the results to be ingested.',
    );
    expect(removeUploadedFile).toHaveBeenCalledWith(RESULTS_FILE);
  });
});

describe('deleteNonExecutableModel', () => {
  const model = { definitionFile: { id: 42, name: 'model.json' }, id: 900, owner: 'importer' };

  test('removes the definition file once the model is deleted', async () => {
    backend = () => ({ json: { data: { delete_mission_model_by_pk: { id: 900 } } } });

    await deleteNonExecutableModel(model);

    expect(removeUploadedFile).toHaveBeenCalledWith(model.definitionFile);
  });

  test.each([
    ['fails', { errors: [{ message: 'database unavailable' }] }],
    ['deletes nothing', { data: { delete_mission_model_by_pk: null } }],
  ])('keeps the definition file, without throwing, when the delete %s', async (_, json) => {
    backend = () => ({ json });

    await deleteNonExecutableModel(model);

    expect(removeUploadedFile).not.toHaveBeenCalled();
  });
});
