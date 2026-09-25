import fetch from 'node-fetch';
import type { HasuraError } from '../../types/hasura.js';
import type { ModelDeclaration, SerializedValue, SimulationResultsTransfer } from '../../types/plan-transfer.js';
import { generateJwt, getSessionVariables } from '../auth/functions.js';
import { removeUploadedFile, storeUploadedFile } from '../files/store.js';
import { getEnv } from '../../env.js';
import { intervalToMicroseconds, isoToDoyTimestamp } from '../../util/time.js';
import gql from './gql.js';

/**
 * Backend calls for importing a self-contained PlanTransfer as a non-executable, read-only plan.
 *
 * The gateway creates the non-executable model's row through Hasura, whose event triggers then have merlin register
 * its types. Merlin owns the imported simulation dataset and the plan's read-only flag; the gateway stages files, says
 * who the caller is, and asks for the plan to be made read-only once it has finished writing to it. How each payload
 * reaches the backend is kept inside these helpers so it can change without touching `/importPlan`.
 */

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

/**
 * Stages the model declaration as a JSON definition file and inserts a non-executable model for it, owned by the
 * caller. Its types are registered asynchronously afterwards; see `waitForModelTypes`.
 *
 * Only admins may insert models through Hasura, so the insert uses a short-lived admin token. The caller must already
 * be known to be allowed to create plans, and since the admin role skips Hasura's column presets, the owner comes from
 * the caller's verified token rather than the request's `x-hasura-user-id` header.
 */
export async function createNonExecutableModel(
  model: ModelDeclaration,
  { name }: { name: string },
  headers: Record<string, string>,
): Promise<number> {
  // resolved first, so a bad token fails before anything is staged
  const { 'x-hasura-user-id': owner } = getSessionVariables(headers.Authorization, headers['x-hasura-role']);
  const adminToken = generateJwt(owner, 'admin', ['admin'], '10s');
  if (adminToken === null) {
    throw new Error('Could not create a token to insert the non-executable model.');
  }

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
      { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', 'x-hasura-role': 'admin' },
    );
    if (inserted == null) {
      throw new Error('Non-executable model creation returned no model id.');
    }

    return inserted.id;
  } catch (error) {
    await removeUploadedFile(definitionFile);
    throw error;
  }
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
 * Waits until merlin has registered a new model's activity types, resource types and parameters. Inserting the
 * model fires the `refreshActivityTypes`, `refreshResourceTypes` and `refreshModelParameters` event triggers, and
 * each writes one row to its log view: not there yet or `pending` means keep waiting, and since the triggers use
 * `num_retries: 0`, the first finished row is final.
 *
 * The log views read `hdb_catalog.event_log`. The rows read here are only seconds old, so this stays safe even if
 * Hasura's event-log cleanup is turned on later.
 *
 * Stops polling once `signal` is aborted.
 */
export async function waitForModelTypes(
  modelId: number,
  headers: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + MODEL_TYPE_REFRESH_TIMEOUT_MS;

  while (!signal?.aborted) {
    const { mission_model_by_pk: model } = await postGraphQL<ModelTypeRefreshStatus>(
      gql.MODEL_TYPE_REFRESH_STATUS,
      { modelId },
      headers,
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

/**
 * Has merlin store `results` (if any) as a successful simulation dataset for the plan.
 *
 * Spans and profiles are staged as a file merlin reads
 * from the shared file store, and removed once merlin is done with them. The simulation's window and arguments go in
 * the call itself, so merlin has them before reading the file: timestamps in merlin's UTC day-of-year format, the
 * duration in microseconds.
 *
 * `results` must already reference the plan's directive ids (see `remapResultDirectiveIds`).
 */
export async function insertExternalSimulationDataset({
  planDuration,
  planId,
  planStartTime,
  results,
  simulationArguments,
}: {
  /** A Postgres interval, as on the plan. */
  planDuration: string;
  planId: number;
  /** ISO 8601, as on the plan. */
  planStartTime: string;
  results: SimulationResultsTransfer | undefined;
  simulationArguments: Record<string, SerializedValue>;
}): Promise<void> {
  const resultsFile =
    results &&
    (await storeUploadedFile(
      'plan-transfer-results.json',
      JSON.stringify({ profiles: results.profiles, spans: results.spans }),
    ));

  try {
    await postMerlin('insertExternalSimulationDataset', {
      planId,
      planStartTime: isoToDoyTimestamp(planStartTime),
      resultsFileId: resultsFile?.id ?? null,
      simulationArguments,
      // results either carry their own window or inherit the plan's
      simulationDuration: results?.duration ?? intervalToMicroseconds(planDuration),
      simulationStartTime: isoToDoyTimestamp(results?.start_time ?? planStartTime),
    });
  } finally {
    if (resultsFile) {
      await removeUploadedFile(resultsFile);
    }
  }
}

/**
 * Has merlin mark the imported plan read-only, once the gateway has finished writing to it: from then on the database
 * refuses changes to its activities, simulation and bounds, the gateway's included.
 */
export async function markPlanReadOnly(planId: number): Promise<void> {
  await postMerlin('markPlanReadOnly', { planId });
}
