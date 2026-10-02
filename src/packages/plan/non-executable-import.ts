import fetch from 'node-fetch';
import type { HasuraError } from '../../types/hasura.js';
import type { ModelDeclaration, SerializedValue, SimulationResultsTransfer } from '../../types/plan-transfer.js';
import { generateJwt } from '../auth/functions.js';
import { DbMerlin } from '../db/db.js';
import getLogger from '../../logger.js';
import { removeUploadedFile, storeUploadedFile } from '../files/store.js';
import { getEnv } from '../../env.js';
import { isoToDoyTimestamp } from '../../util/time.js';
import gql from './gql.js';

/**
 * Backend calls for importing a self-contained PlanTransfer as a non-executable, read-only plan.
 *
 * The gateway creates the non-executable model's row through Hasura, whose event triggers then have merlin register
 * its types. Merlin owns the imported simulation dataset and the plan's read-only flag; the gateway stages files, says
 * who the caller is, and asks for the plan to be made read-only once it has finished writing to it. The import's
 * progress is tracked in a `merlin.plan_import_request` row, which the gateway and merlin both advance. How each
 * payload reaches the backend is kept inside these helpers so it can change without touching `/importPlan`.
 */

const logger = getLogger('packages/plan/non-executable-import');

const { HASURA_API_URL, PLANDEV_MERLIN_URL } = getEnv();

const GQL_API_URL = `${HASURA_API_URL}/v1/graphql`;

export async function postGraphQL<T>(
  query: string,
  variables: Record<string, unknown>,
  headers: Record<string, string>,
): Promise<T> {
  const response = await fetch(GQL_API_URL, {
    body: JSON.stringify({ query, variables }),
    headers,
    method: 'POST',
  });
  const json = (await response.json()) as { data?: T } & Partial<HasuraError>;

  if (json.errors?.length) {
    throw new Error(json.errors.map(({ message }) => message).join('; '));
  }
  if (json.data == null) {
    throw new Error(`GraphQL request failed with status ${response.status}.`);
  }

  return json.data;
}

/**
 * Calls one of merlin's endpoints directly rather than through Hasura, so it is not exposed to other clients, and
 * returns the response body as text. Merlin's errors are `FormattedError`s, whose `message` is thrown.
 */
async function postMerlin(endpoint: string, body: Record<string, unknown>): Promise<string> {
  const response = await fetch(`${PLANDEV_MERLIN_URL}/${endpoint}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });
  const text = await response.text();

  if (!response.ok) {
    let message: string | undefined;
    try {
      message = (JSON.parse(text) as { message?: string }).message;
    } catch {
      // not a FormattedError
    }
    throw new Error(message ?? `merlin ${endpoint} failed with status ${response.status}.`);
  }

  return text;
}

/** A non-executable model an import created. */
export type CreatedNonExecutableModel = {
  definitionFile: { id: number; name: string };
  id: number;
  owner: string;
};

/**
 * Headers for a short-lived admin token acting as `user`. Only admins may insert or delete models through Hasura; the
 * caller must already be known to be allowed to create plans.
 */
export function adminHeaders(user: string): Record<string, string> {
  const adminToken = generateJwt(user, 'admin', ['admin'], '10s');
  if (adminToken === null) {
    throw new Error('Could not create a token to manage the non-executable model.');
  }

  return { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'x-hasura-role': 'admin' };
}

/** Fresh gateway-owned credentials for background work, retaining the role authorized on the request. */
export function backgroundHeaders(user: string, role: string): Record<string, string> {
  const token = generateJwt(user, role, [role], '10s');
  if (token === null) {
    throw new Error('Could not create a token to continue the plan import.');
  }

  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'x-hasura-role': role,
    'x-hasura-user-id': user,
  };
}

/**
 * Stages the model declaration as a JSON definition file and inserts a non-executable model for it, owned by the
 * caller. Its types are registered asynchronously afterwards; see `waitForModelTypes`.
 *
 * The insert uses a short-lived admin token (see `adminHeaders`). Since the admin role skips Hasura's column presets,
 * `owner` must be the user from the caller's verified token rather than the request's `x-hasura-user-id` header.
 */
export async function createNonExecutableModel(
  model: ModelDeclaration,
  { name, owner }: { name: string; owner: string },
): Promise<CreatedNonExecutableModel> {
  const headers = adminHeaders(owner);
  const definitionFile = await storeUploadedFile('plan-transfer-model.json', JSON.stringify(model));

  try {
    const { insert_mission_model_one: inserted } = await postGraphQL<{
      insert_mission_model_one: { id: number } | null;
    }>(
      gql.INSERT_NON_EXECUTABLE_MODEL,
      {
        definition_file_id: definitionFile.id,
        description: describeNonExecutableModel(model, name),
        mission: typeof model.metadata?.mission === 'string' ? model.metadata.mission : '',
        name,
        owner,
        // unique for the (mission, name, version) key, and tells the user when it was imported
        version: new Date().toISOString(),
      },
      headers,
    );
    if (inserted == null) {
      throw new Error('Non-executable model creation returned no model id.');
    }

    return { definitionFile, id: inserted.id, owner };
  } catch (error) {
    await removeUploadedFile(definitionFile);
    throw error;
  }
}

/**
 * Deletes a non-executable model a failed import created, and then its definition file. Only for a model whose plan could not be
 * created; once a plan exists, deleting the plan deletes its model.
 *
 * Best-effort, since it runs while handling another failure: problems are logged, never thrown.
 */
export async function deleteNonExecutableModel({
  definitionFile,
  id,
  owner,
}: CreatedNonExecutableModel): Promise<void> {
  try {
    const { delete_mission_model_by_pk: deleted } = await postGraphQL<{
      delete_mission_model_by_pk: { id: number } | null;
    }>(gql.DELETE_MISSION_MODEL, { id }, adminHeaders(owner));
    if (deleted?.id !== id) {
      throw new Error('Delete returned no model.');
    }
  } catch (error) {
    // the model still references its definition file, so the file stays too
    logger.error(`Could not delete non-executable model ${id}: ${(error as Error).message}`);
    return;
  }

  await removeUploadedFile(definitionFile);
}

function describeNonExecutableModel({ activity_types, resource_types }: ModelDeclaration, planName: string): string {
  return (
    `Non-executable model imported with the plan "${planName}". It declares ${activity_types.length} activity ` +
    `type(s) and ${resource_types.length} resource type(s) and cannot be simulated.`
  );
}

const MODEL_TYPE_REFRESH_POLL_MS = 250;
// Matches the refresh triggers' `timeout_sec`.
const MODEL_TYPE_REFRESH_TIMEOUT_MS = 300_000;

type RefreshLog = { error_message: string | null; pending: boolean; success: boolean };

type ModelTypeRefreshStatus = {
  mission_model_by_pk: {
    refresh_activity_type_logs: RefreshLog[];
    refresh_model_parameter_logs: RefreshLog[];
    refresh_resource_type_logs: RefreshLog[];
  } | null;
};

/**
 * Waits until merlin has registered a new model's activity types, resource types and parameters.
 */
export async function waitForModelTypes(modelId: number, getHeaders: () => Record<string, string>): Promise<void> {
  const deadline = Date.now() + MODEL_TYPE_REFRESH_TIMEOUT_MS;

  for (;;) {
    const { mission_model_by_pk: model } = await postGraphQL<ModelTypeRefreshStatus>(
      gql.MODEL_TYPE_REFRESH_STATUS,
      { modelId },
      getHeaders(),
    );
    if (model == null) {
      throw new Error(`Model ${modelId} was not found while waiting for its types to be registered.`);
    }

    const latestLogs: [string, RefreshLog | undefined][] = [
      ['activity types', model.refresh_activity_type_logs[0]],
      ['resource types', model.refresh_resource_type_logs[0]],
      ['model parameters', model.refresh_model_parameter_logs[0]],
    ];

    const failed = latestLogs.find(([, log]) => log !== undefined && !log.pending && !log.success);
    if (failed) {
      const [what, log] = failed;
      throw new Error(`Registering the model's ${what} failed: ${log?.error_message ?? 'no error message given'}`);
    }

    if (latestLogs.every(([, log]) => log !== undefined && !log.pending && log.success)) {
      return;
    }

    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${MODEL_TYPE_REFRESH_TIMEOUT_MS / 1000} s waiting for the model's types to be registered.`,
      );
    }

    await new Promise(resolve => setTimeout(resolve, MODEL_TYPE_REFRESH_POLL_MS));
  }
}

/** Uses PostgreSQL's interval semantics, matching the value accepted for the plan duration column. */
async function postgresIntervalToMicroseconds(interval: string): Promise<number> {
  const { rows } = await DbMerlin.getDb().query(
    'select round(extract(epoch from $1::interval) * 1000000)::text as microseconds;',
    [interval],
  );
  const microseconds = Number(rows[0]?.microseconds);
  if (!Number.isSafeInteger(microseconds)) {
    throw new Error(`Plan duration cannot be represented in microseconds: ${interval}`);
  }
  return microseconds;
}

export type PlanImportRequestStatus =
  | 'complete'
  | 'extracting_model'
  | 'failed'
  | 'importing_dataset'
  | 'importing_plan';

/** Why an import request failed, as stored in its `reason`. */
type PlanImportRequestReason = { message?: string } & Record<string, unknown>;

/** Merlin marked an import request failed; `reason` is what it stored, kept whole on the failed request. */
export class PlanImportRequestFailedError extends Error {
  constructor(readonly reason: PlanImportRequestReason | null) {
    super(reason?.message ?? `Ingesting the results failed: ${JSON.stringify(reason)}`);
  }
}

/**
 * Records a new import, whose (empty) plan exists, in its first status. Clients follow the import through this row.
 * Written directly, like `merlin.uploaded_file`.
 */
export async function createPlanImportRequest({
  modelId,
  planId,
  requester,
  status,
}: {
  modelId: number;
  planId: number;
  requester: string;
  status: PlanImportRequestStatus;
}): Promise<number> {
  const { rows } = await DbMerlin.getDb().query(
    `
      insert into merlin.plan_import_request (requester, status, model_id, plan_id)
      values ($1, $2, $3, $4)
      returning id;
    `,
    [requester, status, modelId, planId],
  );

  return rows[0].id;
}

export async function setPlanImportRequestStatus(
  id: number,
  status: PlanImportRequestStatus,
  reason: PlanImportRequestReason | null = null,
): Promise<void> {
  await DbMerlin.getDb().query('update merlin.plan_import_request set status = $2, reason = $3 where id = $1;', [
    id,
    status,
    reason,
  ]);
}

const IMPORT_REQUEST_POLL_MS = 1_000;
// Recovery needs a durable worker lease/payload and the ids of every import-created record. A status-only startup
// sweep cannot distinguish this process's abandoned work from another Gateway instance's live import.
const IMPORT_REQUEST_TIMEOUT_MS = 3_600_000;

/** Waits for merlin to mark an import request complete, and throws its reason if merlin marks it failed. */
async function waitForPlanImportRequest(id: number): Promise<void> {
  const deadline = Date.now() + IMPORT_REQUEST_TIMEOUT_MS;

  for (;;) {
    const { rows } = await DbMerlin.getDb().query(
      'select status, reason from merlin.plan_import_request where id = $1;',
      [id],
    );
    const [request] = rows as { reason: PlanImportRequestReason | null; status: PlanImportRequestStatus }[];

    if (request === undefined) {
      throw new Error(`Import request ${id} was not found while waiting for its results to be ingested.`);
    }
    if (request.status === 'complete') {
      return;
    }
    if (request.status === 'failed') {
      throw new PlanImportRequestFailedError(request.reason);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${IMPORT_REQUEST_TIMEOUT_MS / 1000} s waiting for the results to be ingested.`);
    }

    await new Promise(resolve => setTimeout(resolve, IMPORT_REQUEST_POLL_MS));
  }
}

/**
 * Has merlin store `results` as a successful simulation dataset for the plan, and waits until it has.
 *
 * Spans and profiles are staged as a file merlin reads from the shared file store. Merlin accepts the request, ingests
 * the file in the background and marks the import request complete or failed; the file is removed once it has. The
 * simulation's window and arguments go in the call itself, so merlin has them before reading the file: timestamps in
 * merlin's UTC day-of-year format, the duration in microseconds.
 *
 * `results` must already reference the plan's directive ids (see `remapResultDirectiveIds`).
 */
export async function insertExternalSimulationDataset({
  planDuration,
  planId,
  planImportRequestId,
  planStartTime,
  requester,
  results,
  simulationArguments,
}: {
  /** A Postgres interval, as on the plan. */
  planDuration: string;
  planId: number;
  planImportRequestId: number;
  /** ISO 8601, as on the plan. */
  planStartTime: string;
  /** The user from the caller's verified token. */
  requester: string;
  results: SimulationResultsTransfer;
  simulationArguments: Record<string, SerializedValue>;
}): Promise<void> {
  const resultsFile = await storeUploadedFile(
    'plan-transfer-results.json',
    JSON.stringify({
      // merlin streams each profile once, so it needs `type` and `schema` before `segments`
      profiles: Object.fromEntries(
        Object.entries(results.profiles).map(([name, { type, schema, segments }]) => [
          name,
          // eslint-disable-next-line sort-keys -- key order is what merlin's parser needs
          { type, schema, segments },
        ]),
      ),
      spans: results.spans,
    }),
  );

  try {
    await postMerlin('insertExternalSimulationDataset', {
      planId,
      planStartTime: isoToDoyTimestamp(planStartTime),
      requestId: planImportRequestId,
      requester,
      resultsFileId: resultsFile.id,
      simulationArguments,
      // results either carry their own window or inherit the plan's
      simulationDuration: results.duration ?? (await postgresIntervalToMicroseconds(planDuration)),
      simulationStartTime: isoToDoyTimestamp(results.start_time ?? planStartTime),
    });
    await waitForPlanImportRequest(planImportRequestId);
  } finally {
    await removeUploadedFile(resultsFile);
  }
}

/**
 * Has merlin mark the imported plan read-only, once the gateway has finished writing to it: from then on the database
 * refuses changes to its activities, simulation and bounds, the gateway's included.
 */
export async function markPlanReadOnly(planId: number): Promise<void> {
  await postMerlin('markPlanReadOnly', { planId });
}
