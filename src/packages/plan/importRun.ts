/**
 * The five-step run import, and the rollback that makes it atomic from the outside.
 *
 * Kept apart from `plan.ts` because it is a sequence with an undo rather than a request handler: the
 * ordering constraints and what has to be unwound are the whole content, and they are easier to check
 * when nothing else is in the file.
 *
 * See `runTransfer.ts` for the format and the validation layers.
 */

import type { ModelDeclaration, Notice, RunTransfer } from './runTransfer.js';
import { declarationDigest } from './runTransfer.js';

import getLogger from '../../logger.js';
import gql from './gql.js';

const logger = getLogger('packages/plan/importRun');

export type GraphQLCaller = (query: string, variables: Record<string, unknown>) => Promise<any>;

export type ImportedRun = {
  localIds: Record<string, number>;
  modelId: number;
  notices: Notice[];
  plan: { id: number; [key: string]: unknown };
  reusedExistingModel: boolean;
  simulationDatasetId: number | null;
};

/** Raised for a refusal that is the caller's to fix, as opposed to an internal failure. */
export class ImportRefused extends Error {
  readonly notices: Notice[];
  readonly layer: 'importer' | 'gate';

  constructor(layer: 'importer' | 'gate', notices: Notice[]) {
    super(notices.map(({ message }) => message).join('\n'));
    this.layer = layer;
    this.notices = notices;
  }
}

/**
 * Everything created so far, so a failure can be undone in reverse.
 *
 * Note what is NOT here: the `simulation_dataset`. It is written inside merlin's own transaction and
 * it is the last step, so either it never existed or the import succeeded. There is no window in
 * which a dataset needs unwinding.
 */
type Created = {
  modelId?: number;
  planId?: number;
  tagIds: number[];
};

/**
 * Import a validated run transfer.
 *
 * The order is the contract. `simulation_dataset` stamps `plan_revision` and `model_revision` from a
 * BEFORE-insert trigger, so the results go LAST: any write after them bumps `plan.revision`, the
 * dataset stops matching the plan, and the plan opens showing `Modified` beside a Simulate button
 * that cannot work. That failure is invisible until somebody opens the plan, which is why the order
 * is spelled out step by step here rather than left to read off the code.
 */
export async function importRun(
  run: RunTransfer,
  overrides: { duration?: string; modelId?: number; name?: string; simulationTemplateId?: number; startTime?: string },
  callGraphQL: GraphQLCaller,
  warnings: Notice[] = [],
): Promise<ImportedRun> {
  const created: Created = { tagIds: [] };
  const notices: Notice[] = [...warnings];

  try {
    // ---- 1. the mission model -----------------------------------------------------------------
    let modelId: number;
    let reusedExistingModel = false;

    if (run.model) {
      const resolved = await resolveModel(run.model, callGraphQL);
      modelId = resolved.modelId;
      reusedExistingModel = resolved.reused;
      if (resolved.reused) {
        notices.push({
          message:
            `Attached to the existing mission model ${run.model.mission}/${run.model.name}/${run.model.version} ` +
            `(id ${modelId}): its stored declaration digest matches this file's, so it is the same model.`,
          severity: 'info',
          subjects: [String(modelId)],
        });
      } else {
        created.modelId = modelId;
      }
    } else if (overrides.modelId !== undefined) {
      modelId = overrides.modelId;
    } else {
      throw new ImportRefused('importer', [
        {
          message: 'This file declares no mission model, so an existing one must be chosen to import it against.',
          severity: 'error',
          subjects: ['model'],
        },
      ]);
    }

    // ---- 2. the types ---------------------------------------------------------------------------
    // Writes none of `mission_model`, so it does not bump `model_revision` -- which matters, because
    // step 5 stamps that revision onto the dataset.
    if (run.model && !reusedExistingModel) {
      await registerModelTypes(modelId, run.model, callGraphQL);
    }

    // ---- 3. the plan ----------------------------------------------------------------------------
    const planName = overrides.name ?? run.plan.name;
    const plan = await createPlan(
      {
        duration: overrides.duration ?? run.plan.duration,
        model_id: modelId,
        name: planName,
        start_time: overrides.startTime ?? run.plan.start_time,
      },
      callGraphQL,
    );
    created.planId = plan.id;

    // A merlin.simulation row already exists -- simulation_row_for_new_plan_trigger created it with the
    // plan -- so this UPDATES it. The arguments matter beyond display: merlin stamps them onto the
    // dataset in step 5, so a run imported without them reads as having been configured with nothing.
    await callGraphQL(gql.UPDATE_SIMULATION, {
      plan_id: plan.id,
      simulation: {
        arguments: run.plan.simulation_arguments,
        ...(overrides.simulationTemplateId !== undefined
          ? { simulation_template_id: overrides.simulationTemplateId }
          : {}),
      },
    });

    // ---- 4. the directives, and the localId map ------------------------------------------------
    const localIds = await createDirectives(run, plan.id, created, callGraphQL);

    // ---- 5. the results, LAST -------------------------------------------------------------------
    let simulationDatasetId: number | null = null;
    if (run.results) {
      simulationDatasetId = await ingestResults(run, plan.id, localIds, callGraphQL);
    }

    return { localIds, modelId, notices, plan, reusedExistingModel, simulationDatasetId };
  } catch (error) {
    await rollback(created, callGraphQL);
    throw error;
  }
}

/**
 * The mission model this run belongs to: an existing one, or a new one.
 *
 * `mission_model_natural_key` is unique on (mission, name, version), so a second import of the same
 * file would otherwise fail on a raw constraint violation. That is worth more than a nicer error
 * message, because the right answer differs:
 *
 *  - the stored digest MATCHES this file's declaration -> the same model. Reuse it, and the import is
 *    idempotent at the model level: re-importing a file, or importing two runs of one model, works.
 *  - the digest DIFFERS -> two different models are claiming one identity, and importing against the
 *    stored types would produce a run whose spans are checked against a declaration that is not the
 *    one it was produced from. Refuse, and say which.
 *
 * This is the whole reason the digest is worth computing in v0, before anything reads it for
 * permissions.
 */
async function resolveModel(
  model: ModelDeclaration,
  callGraphQL: GraphQLCaller,
): Promise<{ modelId: number; reused: boolean }> {
  const digest = declarationDigest(model);

  const existing = await callGraphQL(gql.GET_MISSION_MODEL_BY_NATURAL_KEY, {
    mission: model.mission,
    name: model.name,
    version: model.version,
  });
  const [found] = existing?.data?.mission_model ?? [];

  if (found) {
    if (found.model_type !== 'declared') {
      throw new ImportRefused('importer', [
        {
          message:
            `Mission model ${model.mission}/${model.name}/${model.version} already exists as a ` +
            `'${found.model_type}' model (id ${found.id}). A run transfer cannot redeclare the types of a ` +
            `model PlanDev already holds; give the file a different model version.`,
          severity: 'error',
          subjects: [String(found.id)],
        },
      ]);
    }
    if (found.external_identity_hash !== digest) {
      throw new ImportRefused('importer', [
        {
          message:
            `Mission model ${model.mission}/${model.name}/${model.version} already exists (id ${found.id}) ` +
            `but declares a different type surface: stored digest ${found.external_identity_hash ?? 'none'}, ` +
            `this file ${digest}. Importing against the stored types would check this run's spans against a ` +
            `declaration it was not produced from. Bump the model version in the file, or delete the ` +
            `existing model.`,
          severity: 'error',
          subjects: [String(found.id)],
        },
      ]);
    }
    return { modelId: found.id, reused: true };
  }

  const response = await callGraphQL(gql.CREATE_MISSION_MODEL, {
    model: {
      description: model.description ?? '',
      // Written ON INSERT rather than by a follow-up update: any update to mission_model bumps its
      // revision, and step 5 stamps that revision onto the dataset.
      external_capabilities: model.capabilities ?? {},
      external_identity_hash: digest,
      mission: model.mission,
      // No jar_id: there is nothing to compile and nothing to run.
      model_type: 'declared',
      name: model.name,
      version: model.version,
    },
  });
  const createdModel = response?.data?.insert_mission_model_one;
  if (!createdModel) {
    throw new Error(`Could not create mission model: ${JSON.stringify(response?.errors ?? response)}`);
  }
  return { modelId: createdModel.id, reused: false };
}

async function registerModelTypes(modelId: number, model: ModelDeclaration, callGraphQL: GraphQLCaller): Promise<void> {
  const response = await callGraphQL(gql.REGISTER_MODEL_TYPES, {
    activityTypes: model.activityTypes,
    missionModelId: modelId,
    parameters: model.parameters,
    resourceTypes: model.resourceTypes,
  });
  if (response?.errors) {
    // The gate refuses a declaration that cannot work downstream -- an activity type name the generated
    // typings cannot carry, a required parameter that is not declared. Its message is the product.
    throw new ImportRefused('gate', asNotices(response.errors, 'model'));
  }
  logger.info(
    `POST /importRun: registered types for model ${modelId}: ${JSON.stringify(response?.data?.registerModelTypes)}`,
  );
}

async function createPlan(
  plan: { duration: string; model_id: number; name: string; start_time: string },
  callGraphQL: GraphQLCaller,
): Promise<{ id: number; [key: string]: unknown }> {
  const response = await callGraphQL(gql.CREATE_PLAN, { plan });
  const created = response?.data?.createPlan;
  if (!created) {
    const message = String(response?.errors?.[0]?.message ?? '');
    // plan_natural_key is UNIQUE (name) -- plan names are unique across the whole deployment, not per
    // model -- so this is a collision a user can actually fix, and it deserves to say so.
    if (message.includes('plan_natural_key')) {
      throw new ImportRefused('importer', [
        {
          message: `A plan named '${plan.name}' already exists. Plan names are unique, so give this import a different name.`,
          severity: 'error',
          subjects: ['name'],
        },
      ]);
    }
    throw new Error(`Could not create plan: ${JSON.stringify(response?.errors ?? response)}`);
  }
  return created;
}

/**
 * Insert the directives, then build `localId -> id` and resolve the anchors through it.
 *
 * The map is built by pairing the returned rows with the input rows POSITIONALLY, which is what
 * `/importPlan` already does. That holds because Hasura compiles one `objects:` insert into a single
 * multi-row INSERT ... RETURNING, and Postgres returns those rows in VALUES order -- but it is an
 * assumption rather than a guarantee in the API, so the count is checked and a mismatch is a hard
 * failure rather than a silently shifted map.
 */
async function createDirectives(
  run: RunTransfer,
  planId: number,
  created: Created,
  callGraphQL: GraphQLCaller,
): Promise<Record<string, number>> {
  const activities = run.plan.activities;
  if (activities.length === 0) {
    return {};
  }

  const tagsMap = await createTags(run, created, callGraphQL);

  const objects = activities.map(activity => ({
    // Anchors are set in a second pass: the id being anchored TO may not exist yet.
    anchor_id: null,
    anchored_to_start: activity.anchored_to_start ?? true,
    arguments: activity.arguments,
    metadata: activity.metadata ?? {},
    name: activity.name ?? activity.localId,
    plan_id: planId,
    start_offset: activity.start_offset,
    tags: { data: (activity.tags ?? []).map(({ tag }) => ({ tag_id: tagsMap[tag.name].id })) },
    type: activity.type,
  }));

  const response = await callGraphQL(gql.CREATE_ACTIVITY_DIRECTIVES, {
    activityDirectivesInsertInput: objects,
  });
  const returned = response?.data?.insert_activity_directive?.returning;
  if (!returned) {
    throw new Error(`Could not create activity directives: ${JSON.stringify(response?.errors ?? response)}`);
  }
  if (returned.length !== objects.length) {
    throw new Error(
      `Inserted ${objects.length} directives but got ${returned.length} back, so the localId map cannot be built reliably.`,
    );
  }

  const localIds: Record<string, number> = {};
  activities.forEach((activity, index) => {
    localIds[activity.localId] = returned[index].id;
  });

  const anchored = activities.filter(({ anchor_id }) => anchor_id !== undefined && anchor_id !== null);
  if (anchored.length > 0) {
    await callGraphQL(gql.UPDATE_ACTIVITY_DIRECTIVES, {
      updates: anchored.map(activity => ({
        _set: { anchor_id: localIds[activity.anchor_id as string] },
        where: { id: { _eq: localIds[activity.localId] }, plan_id: { _eq: planId } },
      })),
    });
  }

  return localIds;
}

/** Tags named in the file that do not exist yet. Tracked for rollback: they outlive a deleted plan. */
async function createTags(
  run: RunTransfer,
  created: Created,
  callGraphQL: GraphQLCaller,
): Promise<Record<string, { id: number }>> {
  const named = new Map<string, string | null>();
  for (const activity of run.plan.activities) {
    for (const { tag } of activity.tags ?? []) {
      named.set(tag.name, tag.color ?? null);
    }
  }
  if (named.size === 0) {
    return {};
  }

  const existingResponse = await callGraphQL(gql.GET_TAGS, {});
  const tagsMap: Record<string, { id: number }> = {};
  for (const tag of existingResponse?.data?.tags ?? []) {
    tagsMap[tag.name] = tag;
  }

  const missing = [...named.entries()].filter(([name]) => !(name in tagsMap));
  if (missing.length > 0) {
    const response = await callGraphQL(gql.CREATE_TAGS, {
      tags: missing.map(([name, color]) => ({ color, name })),
    });
    for (const tag of response?.data?.insert_tags?.returning ?? []) {
      tagsMap[tag.name] = tag;
      created.tagIds.push(tag.id);
    }
  }
  return tagsMap;
}

/**
 * Ingest the results, with every `directiveLocalId` rewritten to the id Postgres assigned.
 *
 * A span with a `parentId` is a decomposition child and carries no directive link, so nothing is
 * rewritten for it. `simulationId` is left out: merlin resolves the plan's own simulation row, which
 * is also where the configuration it stamps on the dataset comes from.
 */
async function ingestResults(
  run: RunTransfer,
  planId: number,
  localIds: Record<string, number>,
  callGraphQL: GraphQLCaller,
): Promise<number> {
  const results = run.results as NonNullable<RunTransfer['results']>;
  const spans = results.spans.map(span => {
    const { directiveLocalId, ...rest } = span;
    return directiveLocalId === undefined ? rest : { ...rest, directiveId: localIds[directiveLocalId] };
  });

  const response = await callGraphQL(gql.INGEST_EXTERNAL_SIMULATION_RESULTS, {
    planId,
    results: {
      duration: results.duration,
      profiles: results.profiles,
      spans,
      startTime: results.startTime,
    },
  });
  if (response?.errors) {
    // The gate is the authority on whether these results are admissible against the declared model,
    // and its findings are the actionable part -- they name what disagreed.
    throw new ImportRefused('gate', asNotices(response.errors, 'results'));
  }
  const ingested = response?.data?.ingestExternalSimulationResults;
  if (!ingested) {
    throw new Error(`Could not ingest results: ${JSON.stringify(response)}`);
  }
  return ingested.simulationDatasetId;
}

/**
 * Undo everything this import created, in reverse.
 *
 * A failure at any step must leave no partial plan, model, or dataset behind, and there is no
 * transaction spanning these calls -- they are separate Hasura mutations against separate merlin
 * actions -- so the undo is explicit. Each delete is attempted independently: one failing must not
 * strand the others, because the alternative is a half-cleaned import that is harder to reason about
 * than either outcome.
 */
async function rollback(created: Created, callGraphQL: GraphQLCaller): Promise<void> {
  const { modelId, planId, tagIds } = created;

  // The plan first, since it references the model. Deleting it takes its directives, its simulation
  // and any dataset with it.
  if (planId !== undefined) {
    await attempt('plan', planId, () => callGraphQL(gql.DELETE_PLAN, { id: planId }));
  }
  if (tagIds.length > 0) {
    await attempt('tags', tagIds.join(','), () => callGraphQL(gql.DELETE_TAGS, { tagIds }));
  }
  // The model last, and only if THIS import created it. A reused model was somebody else's before we
  // arrived, and deleting it would take their plans with it.
  if (modelId !== undefined) {
    await attempt('mission model', modelId, () => callGraphQL(gql.DELETE_MISSION_MODEL, { id: modelId }));
  }
}

async function attempt(what: string, id: number | string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
    logger.info(`POST /importRun: rolled back ${what} ${id}`);
  } catch (error) {
    logger.error(`POST /importRun: could not roll back ${what} ${id}; it may need removing by hand`);
    logger.error(error);
  }
}

/** GraphQL errors as notices, keeping merlin's own message intact. */
function asNotices(errors: { extensions?: { code?: string }; message?: string }[], subject: string): Notice[] {
  return errors.map(error => ({
    message: error.message ?? 'refused, with no message',
    severity: 'error' as const,
    subjects: [subject],
  }));
}
