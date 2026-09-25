import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { parse } from 'csv-parse';
import fetch from 'node-fetch';
import { unlink } from 'fs/promises';
import { tmpdir } from 'os';
import { Readable } from 'stream';

import { auth } from '../auth/middleware.js';
import { parseJSONFile } from '../../util/fileParser.js';
import { convertDateToDoy, getTimeDifference } from '../../util/time.js';
import { HasuraError } from '../../types/hasura.js';
import type { ActivityDirectiveTransfer, ModelDeclaration, PlanTransfer } from '../../types/plan-transfer.js';
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
  insertExternalSimulationDataset,
  markPlanReadOnly,
  postGraphQL,
  waitForModelTypes,
} from './non-executable-import.js';
import gql from './gql.js';
import getLogger from '../../logger.js';
import { getEnv } from '../../env.js';

const upload = multer();
// Plan files can embed large simulation results, so they are buffered to disk rather than memory.
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

async function createActivities(
  activities: ActivityDirectiveInsertInput[],
  activitiesJSON: ActivityDirectiveTransfer[],
  planId: number,
  headers: Record<string, string>,
): Promise<Record<number, number>> {
  const activityRemap: Record<number, number> = {};

  const createdActivitiesResponse = await fetch(GQL_API_URL, {
    body: JSON.stringify({
      query: gql.CREATE_ACTIVITY_DIRECTIVES,
      variables: {
        activityDirectivesInsertInput: activities,
      },
    }),
    headers,
    method: 'POST',
  });

  const createdActivityDirectivesData = (await createdActivitiesResponse.json()) as {
    data: {
      insert_activity_directive: {
        returning: ActivityDirective[];
      };
    };
  } | null;

  if (createdActivityDirectivesData) {
    const {
      data: {
        insert_activity_directive: { returning: createdActivityDirectives },
      },
    } = createdActivityDirectivesData;

    if (createdActivityDirectives.length === activities.length) {
      createdActivityDirectives.forEach((createdActivityDirective, index) => {
        const { id } = activitiesJSON[index];

        activityRemap[id] = createdActivityDirective.id;
      });
    } else {
      throw new Error('Activity insertion failed.');
    }
    // remap all the anchor ids to the newly created activity directives
    logger.info(`POST /uploadActivities: Re-assigning anchors`);

    const activityDirectivesSetInput = await remapAnchors(activitiesJSON, activityRemap, planId);

    await fetch(GQL_API_URL, {
      body: JSON.stringify({
        query: gql.UPDATE_ACTIVITY_DIRECTIVES,
        variables: {
          updates: activityDirectivesSetInput,
        },
      }),
      headers,
      method: 'POST',
    });

    return activityRemap;
  }
  return {};
}

async function createTags(
  activities: ActivityDirectiveTransfer[],
  headers: Record<string, string>,
): Promise<{ createdTags: Tag[]; tagsMap: Record<string, Tag> }> {
  let createdTags: Tag[] = [];
  const tagsResponse = await fetch(GQL_API_URL, {
    body: JSON.stringify({
      query: gql.GET_TAGS,
    }),
    headers,
    method: 'POST',
  });

  const tagsResponseJSON = (await tagsResponse.json()) as {
    data: {
      tags: Tag[];
    };
  };

  let tagsMap: Record<string, Tag> = {};
  if (tagsResponseJSON != null && tagsResponseJSON.data != null) {
    const {
      data: { tags },
    } = tagsResponseJSON;
    tagsMap = tags.reduce((prevTagsMap: Record<string, Tag>, tag) => {
      return {
        ...prevTagsMap,
        [tag.name]: tag,
      };
    }, {});
  }

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

  const createdTagsResponse = await fetch(GQL_API_URL, {
    body: JSON.stringify({
      query: gql.CREATE_TAGS,
      variables: { tags: Object.values(activityTags) },
    }),
    headers,
    method: 'POST',
  });

  const { data } = (await createdTagsResponse.json()) as {
    data: {
      insert_tags: { returning: Tag[] };
    };
  };

  if (data && data.insert_tags && data.insert_tags.returning.length) {
    // track the newly created tags for cleanup if an error occurs during plan import
    createdTags = data.insert_tags.returning;
  }

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

/** What an import has persisted so far, so a failed import can be cleaned up. */
type ImportedRecords = {
  modelId: number | null;
  plan: CreatedPlan | null;
  tags: Tag[];
};

type PlanContents = {
  activities: ActivityDirectiveTransfer[];
  plan: PlanInsertInput;
  /** The request's JSON array of plan tag ids. */
  planTags: string;
  simulationArguments: PlanTransfer['simulation_arguments'];
  simulationTemplateId?: number;
};

/**
 * Creates a plan and fills it with simulation arguments, activities (and their tags) and plan tags, recording what
 * it creates in `created` as it goes.
 */
async function importPlanContents(
  { activities, plan: planInsertInput, planTags, simulationArguments, simulationTemplateId }: PlanContents,
  headers: Record<string, string>,
  created: ImportedRecords,
): Promise<{ activityIdMap: Record<number, number>; plan: CreatedPlan }> {
  const { name } = planInsertInput;

  // 1. Create the plan.
  logger.info(`POST /importPlan: Creating new plan: ${name}`);
  const planCreationResponse = await fetch(GQL_API_URL, {
    body: JSON.stringify({ query: gql.CREATE_PLAN, variables: { plan: planInsertInput } }),
    headers,
    method: 'POST',
  });

  const planCreationResponseJSON = (await planCreationResponse.json()) as {
    data: {
      createPlan: CreatedPlan | null;
    };
  };

  const createdPlan = planCreationResponseJSON?.data?.createPlan;
  if (createdPlan == null) {
    throw Error('Plan creation unsuccessful.');
  }
  created.plan = createdPlan;

  // 2. Set its simulation arguments.
  logger.info(`POST /importPlan: Associating simulation parameters: ${name}`);
  const simulationInput = {
    arguments: simulationArguments,
    simulation_template_id: simulationTemplateId,
  };

  await fetch(GQL_API_URL, {
    body: JSON.stringify({
      query: gql.UPDATE_SIMULATION,
      variables: { plan_id: createdPlan.id, simulation: simulationInput },
    }),
    headers,
    method: 'POST',
  });

  // 3. Create missing activity tags, then the activities, then re-link their anchors.
  logger.info(`POST /importPlan: Importing activities: ${name}`);

  const { createdTags, tagsMap } = await createTags(activities, headers);
  created.tags = createdTags;

  const activityDirectivesInsertInput = await remapActivities(activities, createdPlan.id, tagsMap);

  const activityIdMap = await createActivities(activityDirectivesInsertInput, activities, createdPlan.id, headers);

  // 4. Attach the plan tags.
  logger.info(`POST /importPlan: Importing plan tags: ${name}`);
  const parsedTags: number[] = JSON.parse(planTags);

  const tagsInsert: PlanTagsInsertInput[] = parsedTags.map(tagId => ({
    plan_id: createdPlan.id,
    tag_id: tagId,
  }));

  await fetch(GQL_API_URL, {
    body: JSON.stringify({ query: gql.CREATE_PLAN_TAGS, variables: { tags: tagsInsert } }),
    headers,
    method: 'POST',
  });

  return { activityIdMap, plan: createdPlan };
}

/**
 * Being able to create a plan is what permits the whole self-contained import, including the non-executable model
 * merlin creates for it. Hasura shows a role only the mutations it may run, so this asks Hasura, as the caller,
 * whether `insert_plan_one` is among them, rather than repeating Hasura's permission rules here.
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

/**
 * Imports a PlanTransfer that embeds its model as a read-only plan on a new non-executable model. The plan's window
 * and simulation arguments come from the file; only its name and plan tags come from the request, and any
 * `model_id` (in the request or the file) is ignored.
 */
async function importSelfContainedPlan(
  transfer: PlanTransfer,
  model: ModelDeclaration,
  { name, planTags }: { name: string; planTags: string },
  headers: Record<string, string>,
  created: ImportedRecords,
): Promise<CreatedPlan> {
  // 1. Refuse a caller who can't create plans, or a taken name, before creating anything.
  await assertCanCreatePlan(headers);
  await assertPlanNameAvailable(name, headers);

  // 2. Create the non-executable model; merlin then registers its types asynchronously.
  logger.info(`POST /importPlan: Creating non-executable model: ${name}`);
  const modelId = await createNonExecutableModel(model, { name }, headers);
  created.modelId = modelId;

  // 3. Wait for the types while building the plan, which needs only the model row.
  const stopWaiting = new AbortController();
  const typesRegistered = waitForModelTypes(modelId, headers, stopWaiting.signal);
  // Rethrown by the `await` below; until then, not an unhandled rejection.
  typesRegistered.catch(() => undefined);

  let contents: Awaited<ReturnType<typeof importPlanContents>>;
  try {
    contents = await importPlanContents(
      {
        activities: transfer.activities,
        plan: { duration: transfer.duration, model_id: modelId, name, start_time: transfer.start_time },
        planTags,
        simulationArguments: transfer.simulation_arguments,
      },
      headers,
      created,
    );
  } catch (error) {
    stopWaiting.abort();
    throw error;
  }

  logger.info(`POST /importPlan: Waiting for model types to be registered: ${name}`);
  await typesRegistered;

  // 4. Point result spans at the new directive ids.
  const { activityIdMap, plan } = contents;
  const results = transfer.results && remapResultDirectiveIds(transfer.results, activityIdMap);

  // 5. Ingest the results (if any).
  logger.info(`POST /importPlan: Ingesting simulation results: ${name}`);
  await insertExternalSimulationDataset({
    planDuration: transfer.duration,
    planId: plan.id,
    planStartTime: transfer.start_time,
    results,
    simulationArguments: transfer.simulation_arguments,
  });

  // 6. Make the plan read-only, now that nothing else will write to it.
  logger.info(`POST /importPlan: Marking plan read-only: ${name}`);
  await markPlanReadOnly(plan.id);

  return plan;
}

export async function importPlan(req: Request, res: Response) {
  const authorizationHeader = req.get('authorization');

  const {
    headers: { 'x-hasura-role': roleHeader, 'x-hasura-user-id': userHeader },
  } = req;

  const { body, file } = req;
  const { name, model_id, start_time, duration, simulation_template_id, tags } = body as ImportPlanPayload;

  logger.info(`POST /importPlan: Importing plan: ${name}`);

  const headers: Record<string, string> = {
    Authorization: authorizationHeader ?? '',
    'Content-Type': 'application/json',
    'x-hasura-role': roleHeader ? `${roleHeader}` : '',
    'x-hasura-user-id': userHeader ? `${userHeader}` : '',
  };

  const created: ImportedRecords = { modelId: null, plan: null, tags: [] };

  try {
    // 1. Parse the file and migrate it to PlanTransfer v3.
    const transfer = parsePlanTransfer(await parseJSONFile<unknown>(file));
    const { model } = transfer;

    let plan: CreatedPlan;
    if (model === undefined) {
      // 2a. No embedded model: import onto the requested model.
      ({ plan } = await importPlanContents(
        {
          activities: transfer.activities,
          plan: { duration, model_id, name, start_time },
          planTags: tags,
          simulationArguments: transfer.simulation_arguments,
          simulationTemplateId: simulation_template_id,
        },
        headers,
        created,
      ));
    } else {
      // 2b. Embedded model: import read-only onto a new non-executable model.
      plan = await importSelfContainedPlan(
        transfer,
        model,
        { name: name || transfer.name, planTags: tags },
        headers,
        created,
      );
    }

    logger.info(`POST /importPlan: Imported plan: ${name}`);
    res.json(plan);
  } catch (error) {
    logger.error(`POST /importPlan: Error occurred during plan ${name} import`);
    logger.error(error);

    // cleanup the imported plan if it failed along the way
    if (created.modelId !== null && created.plan === null) {
      // Deleting the plan is what cleans up its model, and there is no plan.
      logger.error(`POST /importPlan: Non-executable model ${created.modelId} was left without a plan`);
    }
    if (created.plan) {
      // delete the plan - activities associated to the plan will be automatically cleaned up
      await fetch(GQL_API_URL, {
        body: JSON.stringify({ query: gql.DELETE_PLAN, variables: { id: created.plan.id } }),
        headers,
        method: 'POST',
      });

      // if any activity tags were created as a result of this import, remove them
      await fetch(GQL_API_URL, {
        body: JSON.stringify({ query: gql.DELETE_TAGS, variables: { tagIds: created.tags.map(({ id }) => id) } }),
        headers,
        method: 'POST',
      });
    }
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
   *       200:
   *         description: ImportResponse
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
