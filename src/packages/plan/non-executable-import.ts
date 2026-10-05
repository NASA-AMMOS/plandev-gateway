import fetch from 'node-fetch';
import type { HasuraError } from '../../types/hasura.js';
import type { ModelDeclaration, SerializedValue, SimulationResultsTransfer } from '../../types/plan-transfer.js';
import { generateJwt } from '../auth/functions.js';
import { DbMerlin } from '../db/db.js';
import { removeUploadedFile, storeUploadedFile } from '../files/store.js';
import { getEnv } from '../../env.js';
import { getIntervalInMs, isoToDoyTimestamp } from '../../util/time.js';
import gql from './gql.js';

/** Backend calls for importing a self-contained PlanTransfer as a non-executable, read-only plan. */

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

/** Calls merlin directly rather than through Hasura, so the endpoint is not exposed to other clients. */
async function postMerlin(endpoint: string, body: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${PLANDEV_MERLIN_URL}/${endpoint}`, {
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
    method: 'POST',
  });

  if (!response.ok) {
    const { message } = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(message ?? `merlin ${endpoint} failed with status ${response.status}.`);
  }
}

export type CreatedNonExecutableModel = {
  definitionFile: { id: number; name: string };
  id: number;
  owner: string;
};

/**
 * Headers for a fresh short-lived gateway-signed token acting as `user` in `role`. Only admins may insert or delete
 * models through Hasura, so model writes use `admin`; the caller must already be known to be allowed to create plans.
 */
export function tokenHeaders(user: string, role: string): Record<string, string> {
  const token = generateJwt(user, role, [role], '10s');
  if (token === null) {
    throw new Error('Could not create a token for the plan import.');
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
  const headers = tokenHeaders(owner, 'admin');
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

/** Deletes a model whose plan could not be created; once a plan exists, deleting the plan deletes its model. */
export async function deleteNonExecutableModel({ definitionFile, id, owner }: CreatedNonExecutableModel): Promise<void> {
  await postGraphQL(gql.DELETE_MISSION_MODEL, { id }, tokenHeaders(owner, 'admin'));
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

/** Waits until merlin has registered a new model's activity types, resource types and parameters. */
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

    const latestLogs: Record<string, RefreshLog | undefined> = {
      'activity types': model.refresh_activity_type_logs[0],
      'model parameters': model.refresh_model_parameter_logs[0],
      'resource types': model.refresh_resource_type_logs[0],
    };

    const failed = Object.entries(latestLogs).find(([, log]) => log && !log.pending && !log.success);
    if (failed) {
      throw new Error(`Registering the model's ${failed[0]} failed: ${failed[1]?.error_message}`);
    }
    if (Object.values(latestLogs).every(log => log?.success)) {
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

export type PlanImportRequestStatus =
  | 'complete'
  | 'extracting_model'
  | 'failed'
  | 'importing_dataset'
  | 'importing_plan';

/** Records a new import, whose (empty) plan exists. Clients follow the import through this row. */
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

/** Never overwrites a failure, so a reason merlin recorded is kept whole. */
export async function setPlanImportRequestStatus(
  id: number,
  status: PlanImportRequestStatus,
  reason: { message: string } | null = null,
): Promise<void> {
  await DbMerlin.getDb().query(
    `update merlin.plan_import_request set status = $2, reason = $3 where id = $1 and status <> 'failed';`,
    [id, status, reason],
  );
}

const IMPORT_REQUEST_POLL_MS = 1_000;
// note: an import abandoned by a gateway restart stays in progress
const IMPORT_REQUEST_TIMEOUT_MS = 3_600_000;

/** Waits for merlin to mark an import request complete, and throws its reason if merlin marks it failed. */
async function waitForPlanImportRequest(id: number): Promise<void> {
  const deadline = Date.now() + IMPORT_REQUEST_TIMEOUT_MS;

  for (;;) {
    const { rows } = await DbMerlin.getDb().query(
      'select status, reason from merlin.plan_import_request where id = $1;',
      [id],
    );
    const [request] = rows as { reason: { message?: string } | null; status: PlanImportRequestStatus }[];

    if (request === undefined) {
      throw new Error(`Import request ${id} was not found while waiting for its results to be ingested.`);
    }
    if (request.status === 'complete') {
      return;
    }
    if (request.status === 'failed') {
      throw new Error(request.reason?.message ?? 'Ingesting the results failed.');
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${IMPORT_REQUEST_TIMEOUT_MS / 1000} s waiting for the results to be ingested.`);
    }

    await new Promise(resolve => setTimeout(resolve, IMPORT_REQUEST_POLL_MS));
  }
}

/**
 * Has merlin ingest `results` (already remapped to the plan's directive ids) as a simulation dataset for the plan, via
 * a staged file, and waits until merlin marks the import request complete or failed.
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
      simulationDuration: results.duration ?? Math.round(getIntervalInMs(planDuration) * 1000),
      simulationStartTime: isoToDoyTimestamp(results.start_time ?? planStartTime),
    });
    await waitForPlanImportRequest(planImportRequestId);
  } finally {
    await removeUploadedFile(resultsFile);
  }
}

/** Once the gateway has finished writing to the plan, has merlin make it read-only. */
export async function markPlanReadOnly(planId: number): Promise<void> {
  await postMerlin('markPlanReadOnly', { planId });
}
