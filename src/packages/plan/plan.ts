import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { parse } from 'csv-parse';
import fetch from 'node-fetch';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { Readable } from 'stream';

import { getSessionVariables } from '../auth/functions.js';
import { auth } from '../auth/middleware.js';
import { parseJSONFile } from '../../util/fileParser.js';
import { convertDateToDoy, getTimeDifference } from '../../util/time.js';
import { HasuraError } from '../../types/hasura.js';
import type { ActivityDirectiveTransfer, PlanTransfer } from '../../types/plan-transfer.js';
import type {
  ActivityDirective,
  ActivityDirectiveInsertInput,
  ImportPlanPayload,
  PlanInsertInput,
  CreatedPlan,
  PlanTagsInsertInput,
  Tag,
} from '../../types/plan.js';
import {
  ProfileSegment,
  ProfileSet,
  ProfileSets,
  UploadActivitiesPayload,
  UploadPlanDatasetJSON,
  UploadPlanDatasetPayload,
} from '../../types/dataset.js';
import { parsePlanTransfer, remapResultDirectiveIds } from './plan-transfer.js';
import {
  createNonExecutableModel,
  deleteNonExecutableModel,
  createPlanImportRequest,
  insertExternalSimulationDataset,
  markPlanReadOnly,
  postGraphQL,
  setPlanImportRequestStatus,
  tokenHeaders,
  waitForModelTypes,
} from './non-executable-import.js';
import gql from './gql.js';
import getLogger from '../../logger.js';
import { getEnv } from '../../env.js';

const upload = multer();
// Plan files can embed large simulation results, so they are buffered to disk rather than memory.
// note: the parsed file and the re-stringified results are still whole in memory, and V8 caps a string at ~512 MB,
// so results past that fail; streaming `results` from the upload into the file store is the upgrade path.
const planFileUpload = multer({ dest: tmpdir() });
const logger = getLogger('packages/plan/plan');
const { RATE_LIMITER_LOGIN_MAX, HASURA_API_URL } = getEnv();

const GQL_API_URL = `${HASURA_API_URL}/v1/graphql`;

// Limit imposed by Jetty server
const EXTERNAL_DATASET_MAX_SIZE = 1024;

const refreshLimiter = rateLimit({
  legacyHeaders: false,
  max: RATE_LIMITER_LOGIN_MAX,
  standardHeaders: true,
  windowMs: 15 * 60 * 1000, // 15 minutes
});

const timeColumnKey = 'time_utc';

type Headers = Record<string, string> | (() => Record<string, string>);
const resolveHeaders = (headers: Headers) => (typeof headers === 'function' ? headers() : headers);

async function createActivities(
  activities: ActivityDirectiveInsertInput[],
  activitiesJSON: ActivityDirectiveTransfer[],
  planId: number,
  headers: Headers,
): Promise<Record<number, number>> {
  const activityRemap: Record<number, number> = {};

  const { insert_activity_directive: inserted } = await postGraphQL<{
    insert_activity_directive: { returning: ActivityDirective[] };
  }>(gql.CREATE_ACTIVITY_DIRECTIVES, { activityDirectivesInsertInput: activities }, resolveHeaders(headers));
  inserted.returning.forEach((createdActivity, index) => {
    activityRemap[activitiesJSON[index].id] = createdActivity.id;
  });

  logger.info(`POST /uploadActivities: Re-assigning anchors`);
  const updates = await remapAnchors(activitiesJSON, activityRemap, planId);
  // Hasura answers an empty `updates` with a single object rather than an array
  if (updates.length === 0) {
    return activityRemap;
  }
  const { update_activity_directive_many: updated } = await postGraphQL<{
    update_activity_directive_many: { affected_rows: number }[];
  }>(gql.UPDATE_ACTIVITY_DIRECTIVES, { updates }, resolveHeaders(headers));
  if (updated.length !== updates.length || updated.some(({ affected_rows }) => affected_rows !== 1)) {
    throw new Error('Not all activity anchors were updated.');
  }

  return activityRemap;
}

async function createTags(
  activities: ActivityDirectiveTransfer[],
  headers: Headers,
): Promise<{ createdTags: Tag[]; tagsMap: Record<string, Tag> }> {
  let createdTags: Tag[] = [];
  const { tags } = await postGraphQL<{ tags: Tag[] }>(gql.GET_TAGS, {}, resolveHeaders(headers));
  let tagsMap: Record<string, Tag> = {};
  tagsMap = tags.reduce((prevTagsMap: Record<string, Tag>, tag) => ({ ...prevTagsMap, [tag.name]: tag }), {});

  // derive a map of uniquely named tags from the list of activities that doesn't already exist in the database
  const activityTags = activities.reduce(
    (prevActivitiesTagsMap: Record<string, Pick<Tag, 'color' | 'name'>>, { tags }) => {
      const currentTagsMap =
        tags?.reduce((prevTagsMap: Record<string, Pick<Tag, 'color' | 'name'>>, { tag: { name: tagName, color } }) => {
          // If the tag doesn't exist already, add it
          if (tagsMap[tagName] === undefined) {
            return {
              ...prevTagsMap,
              [tagName]: {
                color,
                name: tagName,
              },
            };
          }
          return prevTagsMap;
        }, {}) ?? {};

      return {
        ...prevActivitiesTagsMap,
        ...currentTagsMap,
      };
    },
    {},
  );

  const { insert_tags: inserted } = await postGraphQL<{ insert_tags: { returning: Tag[] } }>(
    gql.CREATE_TAGS,
    { tags: Object.values(activityTags) },
    resolveHeaders(headers),
  );
  createdTags = inserted.returning;

  // add the newly created tags to the `tagsMap`
  tagsMap = createdTags.reduce(
    (prevTagsMap: Record<string, Tag>, tag) => ({
      ...prevTagsMap,
      [tag.name]: tag,
    }),
    tagsMap,
  );

  return { createdTags, tagsMap };
}

async function remapActivities(activities: ActivityDirectiveTransfer[], planId: number, tagsMap: Record<string, Tag>) {
  return activities.map(
    ({
      anchored_to_start: anchoredToStart,
      arguments: activityArguments,
      metadata,
      name: activityName,
      start_offset: startOffset,
      tags,
      type,
    }) => {
      const activityDirectiveInsertInput: ActivityDirectiveInsertInput = {
        anchor_id: null,
        anchored_to_start: anchoredToStart,
        arguments: activityArguments,
        metadata,
        name: activityName,
        plan_id: planId,
        start_offset: startOffset,
        tags: {
          data:
            tags?.map(({ tag: { name } }) => ({
              tag_id: tagsMap[name].id,
            })) ?? [],
        },
        type,
      };

      return activityDirectiveInsertInput;
    },
  );
}

async function remapAnchors(
  activities: ActivityDirectiveTransfer[],
  activityRemap: Record<number, number>,
  planId: number,
) {
  return activities
    .filter(({ anchor_id: anchorId }) => anchorId !== null)
    .map(({ anchor_id: anchorId, id }) => ({
      _set: { anchor_id: activityRemap[anchorId as number] },
      where: { id: { _eq: activityRemap[id] }, plan_id: { _eq: planId } },
    }));
}

type PlanContents = {
  activities: ActivityDirectiveTransfer[];
  /** The request's JSON array of plan tag ids. */
  planTags: string;
  simulationArguments: PlanTransfer['simulation_arguments'];
  simulationTemplateId?: number;
};

/** Creates an empty plan. */
async function createPlan(planInsertInput: PlanInsertInput, headers: Record<string, string>): Promise<CreatedPlan> {
  logger.info(`POST /importPlan: Creating new plan: ${planInsertInput.name}`);
  const { createPlan: createdPlan } = await postGraphQL<{ createPlan: CreatedPlan | null }>(
    gql.CREATE_PLAN,
    { plan: planInsertInput },
    headers,
  );
  if (createdPlan == null) {
    throw Error('Plan creation unsuccessful.');
  }
  return createdPlan;
}

/**
 * Fills a new plan with simulation arguments, activities (and their tags) and plan tags. Returns the ids the activities were given, by their id in the file.
 */
async function fillPlan(
  plan: CreatedPlan,
  { activities, planTags, simulationArguments, simulationTemplateId }: PlanContents,
  headers: Headers,
): Promise<Record<number, number>> {
  // 1. Set its simulation arguments.
  logger.info(`POST /importPlan: Associating simulation parameters: plan ${plan.id}`);
  const simulationInput = {
    arguments: simulationArguments,
    simulation_template_id: simulationTemplateId,
  };

  const { update_simulation: updatedSimulation } = await postGraphQL<{
    update_simulation: { returning: { id: number }[] };
  }>(gql.UPDATE_SIMULATION, { plan_id: plan.id, simulation: simulationInput }, resolveHeaders(headers));
  if (updatedSimulation.returning.length === 0) {
    throw new Error(`No simulation was updated for plan ${plan.id}.`);
  }

  // 2. Create missing activity tags, then the activities, then re-link their anchors.
  logger.info(`POST /importPlan: Importing activities: plan ${plan.id}`);

  const { tagsMap } = await createTags(activities, headers);

  const activityDirectivesInsertInput = await remapActivities(activities, plan.id, tagsMap);

  const activityIdMap = await createActivities(activityDirectivesInsertInput, activities, plan.id, headers);

  // 3. Attach the plan tags.
  logger.info(`POST /importPlan: Importing plan tags: plan ${plan.id}`);
  const parsedTags: number[] = JSON.parse(planTags);

  const tagsInsert: PlanTagsInsertInput[] = parsedTags.map(tagId => ({
    plan_id: plan.id,
    tag_id: tagId,
  }));

  await postGraphQL(gql.CREATE_PLAN_TAGS, { tags: tagsInsert }, resolveHeaders(headers));

  return activityIdMap;
}

/**
 * Being able to create a plan is what permits the whole self-contained import, including the non-executable model
 * created for it. Hasura shows a role only the mutations it may run, so this asks Hasura, as the caller, whether
 * `insert_plan_one` is among them, rather than repeating Hasura's permission rules here.
 */
async function assertCanCreatePlan(headers: Record<string, string>): Promise<void> {
  const { __type: mutationRoot } = await postGraphQL<{ __type: { fields: { name: string }[] } | null }>(
    gql.GET_MUTATION_ROOT_FIELDS,
    {},
    headers,
  );

  if (!mutationRoot?.fields.some(({ name }) => name === 'insert_plan_one')) {
    throw new Error('You do not have permission to create a plan.');
  }
}

async function assertPlanNameAvailable(name: string, headers: Record<string, string>): Promise<void> {
  const { plan } = await postGraphQL<{ plan: { id: number }[] }>(gql.GET_PLAN_BY_NAME, { name }, headers);

  if (plan.length > 0) {
    throw new Error(`Plan name "${name}" is already in use.`);
  }
}

/** An import once its (empty) plan and import request exist. */
type StartedImport = {
  modelId: number;
  plan: CreatedPlan;
  requestId: number;
  requester: string;
  role: string;
  simulationTemplateId?: number;
  transfer: PlanTransfer;
};

/**
 * Creates an empty plan and a `plan_import_request` row to track the rest (see `finishImport`). A file that embeds its
 * model is imported onto a new non-executable model, created first.
 */
async function startImport(
  transfer: PlanTransfer,
  { duration, model_id, name, simulation_template_id, start_time }: ImportPlanPayload,
  headers: Record<string, string>,
): Promise<StartedImport> {
  // The admin-token model insert and merlin trust the requester they are given, so it comes from the verified token,
  // not `x-hasura-user-id`.
  const { 'x-hasura-role': role, 'x-hasura-user-id': requester } = getSessionVariables(
    headers.Authorization,
    headers['x-hasura-role'],
  );
  const { model } = transfer;

  let modelId: number;
  let plan: CreatedPlan;
  if (model === undefined) {
    plan = await createPlan({ duration, model_id, name, start_time }, headers);
    // multipart form fields arrive as strings
    modelId = Number(model_id);
  } else {
    // Refuse a caller who can't create plans, or a taken name, before creating a model for them.
    const planName = name || transfer.name;
    await assertCanCreatePlan(headers);
    await assertPlanNameAvailable(planName, headers);

    logger.info(`POST /importPlan: Creating non-executable model: ${planName}`);
    const createdModel = await createNonExecutableModel(model, { name: planName, owner: requester });
    modelId = createdModel.id;
    try {
      plan = await createPlan(
        { duration: transfer.duration, model_id: modelId, name: planName, start_time: transfer.start_time },
        headers,
      );
    } catch (error) {
      // with no plan, the user has nothing to delete the model through
      await deleteNonExecutableModel(createdModel).catch(deleteError => logger.error(deleteError));
      throw error;
    }
  }

  const requestId = await createPlanImportRequest({
    modelId,
    planId: plan.id,
    requester,
    status: model === undefined ? 'importing_plan' : 'extracting_model',
  });

  return {
    modelId,
    plan,
    requestId,
    requester,
    role,
    simulationTemplateId: model === undefined ? simulation_template_id : undefined,
    transfer,
  };
}

/**
 * The rest of an import, after `/importPlan` has responded: fills the plan and, for a self-contained import, first
 * waits for the model's types, then makes the plan read-only and has merlin ingest the results. A failure marks the
 * request failed and keeps the plan for the user to delete.
 */
async function finishImport(
  { modelId, plan, requestId, requester, role, simulationTemplateId, transfer }: StartedImport,
  planTags: string,
): Promise<void> {
  const selfContained = transfer.model !== undefined;
  const getHeaders = () => tokenHeaders(requester, role);
  try {
    if (selfContained) {
      logger.info(`POST /importPlan: Waiting for model types to be registered: request ${requestId}`);
      await waitForModelTypes(modelId, getHeaders);
      await setPlanImportRequestStatus(requestId, 'importing_plan');
    }

    const activityIdMap = await fillPlan(
      plan,
      {
        activities: transfer.activities,
        planTags,
        simulationArguments: transfer.simulation_arguments,
        simulationTemplateId,
      },
      getHeaders,
    );

    if (selfContained) {
      logger.info(`POST /importPlan: Marking plan read-only: request ${requestId}`);
      await markPlanReadOnly(plan.id);
    }

    if (transfer.results === undefined) {
      await setPlanImportRequestStatus(requestId, 'complete');
    } else {
      // merlin marks the request complete or failed once it has ingested the results
      await setPlanImportRequestStatus(requestId, 'importing_dataset');
      logger.info(`POST /importPlan: Ingesting simulation results: request ${requestId}`);
      await insertExternalSimulationDataset({
        planDuration: transfer.duration,
        planId: plan.id,
        planImportRequestId: requestId,
        planStartTime: transfer.start_time,
        requester,
        results: remapResultDirectiveIds(transfer.results, activityIdMap),
        simulationArguments: transfer.simulation_arguments,
      });
    }

    logger.info(`POST /importPlan: Imported plan: request ${requestId}`);
  } catch (error) {
    logger.error(`POST /importPlan: Import request ${requestId} failed`);
    logger.error(error);
    await setPlanImportRequestStatus(requestId, 'failed', { message: (error as Error).message }).catch(e =>
      logger.error(e),
    );
    if (selfContained) {
      await markPlanReadOnly(plan.id).catch(e => logger.error(e));
    }
  }
}

export async function importPlan(req: Request, res: Response) {
  const authorizationHeader = req.get('authorization');

  const {
    headers: { 'x-hasura-role': roleHeader, 'x-hasura-user-id': userHeader },
  } = req;

  const { body, file } = req;
  const payload = body as ImportPlanPayload;

  logger.info(`POST /importPlan: Importing plan: ${payload.name}`);

  const headers: Record<string, string> = {
    Authorization: authorizationHeader ?? '',
    'Content-Type': 'application/json',
    'x-hasura-role': roleHeader ? `${roleHeader}` : '',
    'x-hasura-user-id': userHeader ? `${userHeader}` : '',
  };

  try {
    // 1. Parse the file and migrate it to PlanTransfer v3.
    const transfer = parsePlanTransfer(await parseJSONFile<unknown>(file));

    // 2. Create the plan (and any model), and respond with the import request tracking the rest.
    const started = await startImport(transfer, payload, headers);

    logger.info(`POST /importPlan: Started import request ${started.requestId}`);
    res.status(202);
    res.json({ model_id: started.modelId, plan_id: started.plan.id, plan_import_request_id: started.requestId });

    // 3. Finish in the background; awaited only so the temporary upload is removed afterwards.
    await finishImport(started, payload.tags);
  } catch (error) {
    logger.error(`POST /importPlan: Error occurred during plan ${payload.name} import`);
    logger.error(error);

    res.status(500);
    res.send((error as Error).message);
  } finally {
    // plan files are uploaded to temporary disk storage
    if (file?.path) {
      await unlink(file.path).catch(error => logger.error(error));
    }
  }
}

function profileHasSegments(profileSets: ProfileSets): boolean {
  const profileKeys = Object.keys(profileSets);
  for (let i = 0; i < profileKeys.length; i++) {
    if (profileSets[profileKeys[i]].segments.length) {
      return true;
    }
  }

  return false;
}

function getSegmentByteSize(segment: ProfileSegment): number {
  return Buffer.byteLength(JSON.stringify(segment));
}

async function uploadActivities(req: Request, res: Response) {
  const authorizationHeader = req.get('authorization');

  const {
    headers: { 'x-hasura-role': roleHeader, 'x-hasura-user-id': userHeader },
  } = req;

  const { body, file } = req;
  const { plan_id: planIdString } = body as UploadActivitiesPayload;

  logger.info(`POST /uploadActivities: Uploading activities`);

  const headers: HeadersInit = {
    Authorization: authorizationHeader ?? '',
    'Content-Type': 'application/json',
    'x-hasura-role': roleHeader ? `${roleHeader}` : '',
    'x-hasura-user-id': userHeader ? `${userHeader}` : '',
  };

  let createdTags: Tag[] = [];
  let tagsMap: Record<string, Tag>;

  try {
    // Activity upload consumes only directives, so it is not part of the plan
    // version migration; the file is read as-is, as it always has been.
    const { activities: activitiesJSON } = await parseJSONFile<{ activities: ActivityDirectiveTransfer[] }>(file);

    const tagData = await createTags(activitiesJSON, headers as Record<string, string>);
    createdTags = tagData.createdTags;
    tagsMap = tagData.tagsMap;

    const activities = await remapActivities(activitiesJSON, parseInt(planIdString), tagsMap);

    const activityIdMap = await createActivities(activities, activitiesJSON, parseInt(planIdString), headers);

    logger.info(`POST /uploadActivities: Uploaded activities`);

    res.json(Object.keys(activityIdMap).length);
  } catch (error) {
    // TODO: Handle cleanup on fail, need to delete tags if they were created
    if (createdTags !== undefined && createdTags.length) {
      await fetch(GQL_API_URL, {
        body: JSON.stringify({ query: gql.DELETE_TAGS, variables: { tagIds: createdTags.map(({ id }) => id) } }),
        headers,
        method: 'POST',
      });
    }
    logger.error(`POST /uploadActivities: Error occurred during activity upload`);
    logger.error(error);
    res.status(500);
    res.send((error as Error).message);
  }
}

async function uploadDataset(req: Request, res: Response) {
  const authorizationHeader = req.get('authorization');

  const {
    headers: { 'x-hasura-role': roleHeader, 'x-hasura-user-id': userHeader },
  } = req;

  const { body, file } = req;
  const { plan_id: planIdString, simulation_dataset_id: simulationDatasetIdString } = body as UploadPlanDatasetPayload;

  const headers: HeadersInit = {
    Authorization: authorizationHeader ?? '',
    'Content-Type': 'application/json',
    'x-hasura-role': roleHeader ? `${roleHeader}` : '',
    'x-hasura-user-id': userHeader ? `${userHeader}` : '',
  };

  let createdDatasetId: number | undefined;

  try {
    const planId: number = parseInt(planIdString);
    const simulationDatasetId: number | undefined =
      simulationDatasetIdString != null ? parseInt(simulationDatasetIdString) : undefined;
    const matches = file?.originalname?.match(/\.(?<extension>\w+)$/);

    if (file && matches != null) {
      const { groups: { extension = '' } = {} } = matches;

      logger.info(`POST /uploadDataset: Uploading plan dataset`);

      let uploadedPlanDataset: UploadPlanDatasetJSON;
      switch (extension) {
        case 'json':
          uploadedPlanDataset = await parseJSONFile<UploadPlanDatasetJSON>(file);
          break;
        case 'csv':
        case 'txt': {
          const parsedCSV: string[][] = [];
          await new Promise((resolve, reject) => {
            const parser = parse({
              delimiter: ',',
            });

            parser.on('readable', () => {
              let record;
              while ((record = parser.read()) !== null) {
                parsedCSV.push(record);
              }
            });
            parser.on('error', error => {
              reject(error);
            });
            parser.on('end', () => {
              resolve(parsedCSV);
            });

            const fileStream = Readable.from(file.buffer);
            fileStream.pipe(parser);
          });

          // Keep track of the time column's index separately since the name of the column is static
          let timeColumnIndex = -1;

          // Create a lookup for the profile name's index in each CSV row
          const headerIndexMap: Record<string, number> = parsedCSV[0].reduce(
            (prevHeaderIndexMap: Record<string, number>, header: string, headerIndex: number) => {
              if (new RegExp(timeColumnKey).test(header)) {
                timeColumnIndex = headerIndex;

                return prevHeaderIndexMap;
              } else {
                return {
                  ...prevHeaderIndexMap,
                  [header]: headerIndex,
                };
              }
            },
            {},
          );

          if (timeColumnIndex === -1) {
            throw new Error(`CSV file does not contain a "${timeColumnKey}" column.`);
          }

          const parsedSegments: string[][] = parsedCSV.slice(1);

          // Use the first entry's time value in the CSV as the dataset start time
          const startTime = convertDateToDoy(parsedSegments[0][timeColumnIndex]);
          const parsedProfiles: ProfileSets = Object.keys(headerIndexMap).reduce(
            (previousProfileSet: ProfileSets, header) => {
              return {
                ...previousProfileSet,
                [header]: {
                  // default CSV profile schemas to `real` and type `discrete`
                  schema: { type: 'real' },
                  segments: [],
                  type: 'discrete',
                },
              };
            },
            {},
          );
          uploadedPlanDataset = parsedSegments.reduce(
            (
              previousPlanDataset: UploadPlanDatasetJSON,
              parsedSegment: string[],
              parsedSegmentIndex,
              parsedSegmentsArray,
            ) => {
              const nextParsedSegment = parsedSegmentsArray[parsedSegmentIndex + 1];

              // Only process entries that have an entry after it.
              // The last entry is ignored on purpose as it is only used to get the duration of the previous entry
              if (nextParsedSegment) {
                const duration = getTimeDifference(parsedSegment[timeColumnIndex], nextParsedSegment[timeColumnIndex]);
                if (duration) {
                  const profileSet: ProfileSets = Object.entries(headerIndexMap).reduce(
                    (previousProfileSet: ProfileSets, [header, index]) => {
                      const previousSegments = previousProfileSet[header].segments;
                      const value = parsedSegment[index];
                      return {
                        ...previousProfileSet,
                        [header]: {
                          ...previousProfileSet[header],
                          segments: [
                            ...previousSegments,
                            { duration, ...(value !== undefined ? { dynamics: parseFloat(value) } : {}) },
                          ],
                        } as ProfileSet,
                      };
                    },
                    previousPlanDataset.profileSet,
                  );

                  return {
                    ...previousPlanDataset,
                    profileSet,
                  } as UploadPlanDatasetJSON;
                }
              }
              return previousPlanDataset;
            },
            { datasetStart: startTime, profileSet: parsedProfiles } as UploadPlanDatasetJSON,
          );
          break;
        }
        default:
          throw new Error('File extension not supported');
      }

      const { datasetStart, profileSet } = uploadedPlanDataset;

      const profileNames = Object.keys(profileSet);

      // Insert an initial set of profiles that have empty segments
      const initialProfileSet: ProfileSets = profileNames.reduce(
        (currentProfileSet: ProfileSets, profileName: string) => {
          return {
            ...currentProfileSet,
            [profileName]: {
              ...profileSet[profileName],
              segments: [],
            },
          };
        },
        {},
      );

      const response = await fetch(GQL_API_URL, {
        body: JSON.stringify({
          query: gql.ADD_EXTERNAL_DATASET,
          variables: { datasetStart, planId, profileSet: initialProfileSet, simulationDatasetId },
        }),
        headers,
        method: 'POST',
      });

      type AddExternalDatasetResponse = { data: { addExternalDataset: { datasetId: number } | null } };
      const jsonResponse = await response.json();
      const addExternalDatasetResponse = jsonResponse as AddExternalDatasetResponse | HasuraError;

      // If the initial insert was successful, follow-up with multiple inserts to add the segments to each profile
      if ((addExternalDatasetResponse as AddExternalDatasetResponse).data?.addExternalDataset != null) {
        logger.info(`POST /uploadDataset: Uploaded initial plan dataset`);

        createdDatasetId = (addExternalDatasetResponse as AddExternalDatasetResponse).data.addExternalDataset
          ?.datasetId;

        // Repeat as long as there is at least one profile with a segment left
        while (profileHasSegments(profileSet)) {
          // Initialize profile payload
          let currentProfileSet: ProfileSets = initialProfileSet;

          // Get the initial profile payload byte size
          let currentProfileSize: number = Buffer.byteLength(JSON.stringify(currentProfileSet));

          let isMaxSizeReached: boolean = false;

          // Repeat until the maximum payload size is reached or there are no more segments left within the profile to send
          while (profileHasSegments(profileSet) && !isMaxSizeReached) {
            for (let i = 0; i < profileNames.length; i++) {
              const profileName = profileNames[i];
              const profileSegments = profileSet[profileName].segments;
              const nextProfileSegment = profileSegments[0];
              const nextProfileSegmentSize = nextProfileSegment ? getSegmentByteSize(nextProfileSegment) : 0;

              if (nextProfileSegment !== undefined) {
                // Check to see if including the next segment will be under the maximum payload size
                if (currentProfileSize + nextProfileSegmentSize < EXTERNAL_DATASET_MAX_SIZE) {
                  // Add the next segment to the current profile set
                  currentProfileSet = {
                    ...currentProfileSet,
                    [profileName]: {
                      ...currentProfileSet[profileName],
                      segments: [...currentProfileSet[profileName].segments, nextProfileSegment],
                    } as ProfileSet,
                  };
                  // Mutate the array to remove the segment that we just copied
                  profileSegments.shift();

                  currentProfileSize += nextProfileSegmentSize;
                } else {
                  isMaxSizeReached = true;
                  break;
                }
              }
            }
          }

          logger.info(`POST /uploadDataset: Uploading extended plan dataset to dataset: ${createdDatasetId}`);

          await fetch(GQL_API_URL, {
            body: JSON.stringify({
              query: gql.EXTEND_EXTERNAL_DATASET,
              variables: { datasetId: createdDatasetId, profileSet: currentProfileSet },
            }),
            headers,
            method: 'POST',
          });
          logger.info(`POST /uploadDataset: Uploaded extended plan dataset to dataset: ${createdDatasetId}`);
        }

        res.json(createdDatasetId);
      } else if ((addExternalDatasetResponse as HasuraError).errors) {
        throw new Error(JSON.stringify((addExternalDatasetResponse as HasuraError).errors));
      } else {
        throw new Error('Plan dataset upload unsuccessful.');
      }
    } else {
      throw new Error('File extension not supported');
    }
  } catch (error) {
    logger.error(`POST /uploadDataset: Error occurred during plan dataset upload`);
    logger.error(error);

    // cleanup the plan dataset if it failed along the way
    if (createdDatasetId !== undefined) {
      // delete the dataset - profiles associated to the plan will be automatically cleaned up
      await fetch(GQL_API_URL, {
        body: JSON.stringify({ query: gql.DELETE_EXTERNAL_DATASET, variables: { id: createdDatasetId } }),
        headers,
        method: 'POST',
      });
    }

    res.status(500);
    res.send((error as Error).message);
  }
}

export default (app: Express) => {
  /**
   * @swagger
   * /importPlan:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - multipart/form-data
   *     produces:
   *       - application/json
   *     parameters:
   *      - in: header
   *        name: x-hasura-role
   *        schema:
   *          type: string
   *          required: false
   *     requestBody:
   *       content:
   *         multipart/form-data:
   *          schema:
   *            type: object
   *            properties:
   *              plan_file:
   *                format: binary
   *                type: string
   *              name:
   *                type: string
   *              model_id:
   *                type: integer
   *              start_time:
   *                type: string
   *              duration:
   *                type: string
   *              sim_id:
   *                type: integer
   *              tags:
   *                type: string
   *     responses:
   *       202:
   *         description: >
   *           `{ plan_import_request_id, plan_id, model_id }` once the plan exists. The import continues in the
   *           background; follow its `plan_import_request` row for its status.
   *       403:
   *         description: Unauthorized error
   *       401:
   *         description: Unauthenticated error
   *     summary: Import a plan JSON file
   *     description: >
   *       Imports a PlanTransfer file (v2, versionless or v3). When the file embeds a `model`, the plan is imported
   *       read-only on a new non-executable model, with any recorded `results` as its simulation dataset. In that case
   *       `model_id`, `start_time`, `duration` and `simulation_template_id` are ignored and `name` defaults to the
   *       file's plan name.
   *     tags:
   *       - Hasura
   */
  app.post('/importPlan', refreshLimiter, auth, planFileUpload.single('plan_file'), importPlan);

  /**
   * @swagger
   * /uploadDataset:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - multipart/form-data
   *     produces:
   *       - application/json
   *     parameters:
   *      - in: header
   *        name: x-hasura-role
   *        schema:
   *          type: string
   *          required: false
   *     requestBody:
   *       content:
   *         multipart/form-data:
   *          schema:
   *            type: object
   *            properties:
   *              external_dataset:
   *                format: binary
   *                type: string
   *              plan_id:
   *                type: long
   *              simulation_dataset_id:
   *                type: integer
   *     responses:
   *       200:
   *         description: ImportResponse
   *       403:
   *         description: Unauthorized error
   *       401:
   *         description: Unauthenticated error
   *     summary: Upload an external dataset to a plan
   *     tags:
   *       - Hasura
   */
  app.post('/uploadDataset', refreshLimiter, auth, upload.single('external_dataset'), uploadDataset);

  /**
   * @swagger
   * /uploadActivities:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - multipart/form-data
   *     produces:
   *       - application/json
   *     parameters:
   *      - in: header
   *        name: x-hasura-role
   *        schema:
   *          type: string
   *          required: false
   *     requestBody:
   *       content:
   *         multipart/form-data:
   *          schema:
   *            type: object
   *            properties:
   *              plan_id:
   *                type: long
   *              activity_file:
   *                format: binary
   *                type: string
   *     responses:
   *       200:
   *         description: ImportResponse
   *       403:
   *         description: Unauthorized error
   *       401:
   *         description: Unauthenticated error
   *     summary: Upload a JSON of activities to a plan
   *     tags:
   *       - Hasura
   */
  app.post('/uploadActivities', refreshLimiter, auth, upload.single('activity_file'), uploadActivities);
};
