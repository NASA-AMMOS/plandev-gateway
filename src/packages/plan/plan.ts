import type { Express, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { parse } from 'csv-parse';
import fetch from 'node-fetch';
import { Readable } from 'stream';

import { auth } from '../auth/middleware.js';
import { parseJSONFile } from '../../util/fileParser.js';
import { convertDateToDoy, getTimeDifference } from '../../util/time.js';
import { HasuraError } from '../../types/hasura.js';
import { BadRequestError, isServerError } from '../../types/errors.js';
import type {
  ActivitiesJSON,
  ActivityDirective,
  ActivityDirectiveInsertInput,
  ImportPlanPayload,
  PlanInsertInput,
  PlanSchema,
  PlanTagsInsertInput,
  PlanTransfer,
  Tag,
} from '../../types/plan.js';
import {
  ProfileSegment,
  ProfileSet,
  ProfileSets,
  SimulationDatasetJSON,
  UploadActivitiesPayload,
  UploadPlanDatasetJSON,
  UploadPlanDatasetPayload,
} from '../../types/dataset.js';
import gql from './gql.js';
import getLogger from '../../logger.js';
import { getEnv } from '../../env.js';

const upload = multer();
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

function buildHeaders(req: Request): Record<string, string> {
  const authorizationHeader = req.get('authorization');
  const { 'x-hasura-role': roleHeader, 'x-hasura-user-id': userHeader } = req.headers;
  return {
    Authorization: authorizationHeader ?? '',
    'Content-Type': 'application/json',
    'x-hasura-role': roleHeader ? `${roleHeader}` : '',
    'x-hasura-user-id': userHeader ? `${userHeader}` : '',
  };
}

async function createActivities(
  activities: ActivityDirectiveInsertInput[],
  activitiesJSON: ActivitiesJSON,
  planId: number,
  headers: Record<string, string>,
): Promise<number> {
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

    return activities.length;
  }
  return 0;
}

async function createTags(
  activities: ActivitiesJSON,
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

async function remapActivities(activities: ActivitiesJSON, planId: number, tagsMap: Record<string, Tag>) {
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

async function remapAnchors(activities: ActivitiesJSON, activityRemap: Record<number, number>, planId: number) {
  return activities
    .filter(({ anchor_id: anchorId }) => anchorId !== null)
    .map(({ anchor_id: anchorId, id }) => ({
      _set: { anchor_id: activityRemap[anchorId as number] },
      where: { id: { _eq: activityRemap[id] }, plan_id: { _eq: planId } },
    }));
}

async function importPlan(req: Request, res: Response) {
  const authorizationHeader = req.get('authorization');

  const {
    headers: { 'x-hasura-role': roleHeader, 'x-hasura-user-id': userHeader },
  } = req;

  const { body, file } = req;
  const { name, model_id, start_time, duration, simulation_template_id, tags } = body as ImportPlanPayload;

  logger.info(`POST /importPlan: Importing plan: ${name}`);

  const headers: HeadersInit = {
    Authorization: authorizationHeader ?? '',
    'Content-Type': 'application/json',
    'x-hasura-role': roleHeader ? `${roleHeader}` : '',
    'x-hasura-user-id': userHeader ? `${userHeader}` : '',
  };

  let createdPlan: PlanSchema | null = null;

  let createdTags: Tag[] = [];
  let tagsMap: Record<string, Tag>;

  try {
    const { activities, simulation_arguments }: PlanTransfer = await parseJSONFile<PlanTransfer>(file);

    // create the new plan first
    logger.info(`POST /importPlan: Creating new plan: ${name}`);
    const planInsertInput: PlanInsertInput = {
      duration,
      model_id,
      name,
      start_time,
    };
    const planCreationResponse = await fetch(GQL_API_URL, {
      body: JSON.stringify({ query: gql.CREATE_PLAN, variables: { plan: planInsertInput } }),
      headers,
      method: 'POST',
    });

    const planCreationResponseJSON = (await planCreationResponse.json()) as {
      data: {
        createPlan: any;
      };
    };

    if (planCreationResponseJSON != null && planCreationResponseJSON.data != null) {
      createdPlan = planCreationResponseJSON.data.createPlan;

      if (createdPlan) {
        // associate specified simulation parameters to new plan
        logger.info(`POST /importPlan: Associating simulation parameters: ${name}`);
        const simulationInput = {
          arguments: simulation_arguments,
          simulation_template_id,
        };

        await fetch(GQL_API_URL, {
          body: JSON.stringify({
            query: gql.UPDATE_SIMULATION,
            variables: { plan_id: createdPlan.id, simulation: simulationInput },
          }),
          headers,
          method: 'POST',
        });

        // insert all the imported activities into the plan
        logger.info(`POST /importPlan: Importing activities: ${name}`);

        const tagData = await createTags(activities, headers as Record<string, string>);
        createdTags = tagData.createdTags;
        tagsMap = tagData.tagsMap;

        const activityDirectivesInsertInput = await remapActivities(activities, createdPlan.id, tagsMap);

        await createActivities(activityDirectivesInsertInput, activities, (createdPlan as PlanSchema).id, headers);

        // associate the tags with the newly created plan
        logger.info(`POST /importPlan: Importing plan tags: ${name}`);
        const parsedTags: number[] = JSON.parse(tags);

        const tagsInsert: PlanTagsInsertInput[] = parsedTags.map(tagId => ({
          plan_id: (createdPlan as PlanSchema).id,
          tag_id: tagId,
        }));

        await fetch(GQL_API_URL, {
          body: JSON.stringify({ query: gql.CREATE_PLAN_TAGS, variables: { tags: tagsInsert } }),
          headers,
          method: 'POST',
        });

        logger.info(`POST /importPlan: Imported plan: ${name}`);
      }
      res.json(createdPlan);
    } else {
      throw Error('Plan creation unsuccessful.');
    }
  } catch (error) {
    logger.error(`POST /importPlan: Error occurred during plan ${name} import`);
    logger.error(error);

    // cleanup the imported plan if it failed along the way
    if (createdPlan) {
      // delete the plan - activities associated to the plan will be automatically cleaned up
      await fetch(GQL_API_URL, {
        body: JSON.stringify({ query: gql.DELETE_PLAN, variables: { id: createdPlan.id } }),
        headers,
        method: 'POST',
      });

      // if any activity tags were created as a result of this import, remove them
      await fetch(GQL_API_URL, {
        body: JSON.stringify({ query: gql.DELETE_TAGS, variables: { tagIds: createdTags.map(({ id }) => id) } }),
        headers,
        method: 'POST',
      });
    }
    res.status(500);
    res.send((error as Error).message);
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
    const { activities: activitiesJSON }: PlanTransfer = await parseJSONFile<PlanTransfer>(file); // Activites upload is a subset of plan import

    const tagData = await createTags(activitiesJSON, headers as Record<string, string>);
    createdTags = tagData.createdTags;
    tagsMap = tagData.tagsMap;

    const activities = await remapActivities(activitiesJSON, parseInt(planIdString), tagsMap);

    const activitiesCreated = await createActivities(activities, activitiesJSON, parseInt(planIdString), headers);

    logger.info(`POST /uploadActivities: Uploaded activities`);

    res.json(activitiesCreated);
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
                        },
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

        // Repeat as long as the is at least one profile with a segment left
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

async function uploadSimulationDataset(req: Request, res: Response) {
  const { body, file } = req;
  const { plan_id: planIdString } = body as { plan_id: string };
  const headers = buildHeaders(req);

  try {
    const planId: number = parseInt(planIdString);
    if (isNaN(planId)) {
      throw new BadRequestError('plan_id is required and must be an integer');
    }
    const simulationResults = await parseJSONFile<SimulationDatasetJSON>(file);

    logger.info(`POST /uploadSimulationDataset: Uploading simulation dataset for plan ${planId}`);

    const response = await fetch(GQL_API_URL, {
      body: JSON.stringify({
        query: gql.UPLOAD_SIMULATION_DATASET,
        variables: { planId, simulationResults },
      }),
      headers,
      method: 'POST',
    });

    type UploadResponse = { data: { uploadSimulationDataset: { simulationDatasetId: number } | null } };
    const jsonResponse = (await response.json()) as UploadResponse | HasuraError;

    if ((jsonResponse as UploadResponse).data?.uploadSimulationDataset != null) {
      const { simulationDatasetId } = (jsonResponse as UploadResponse).data.uploadSimulationDataset!;
      logger.info(`POST /uploadSimulationDataset: Created simulation dataset ID=${simulationDatasetId}`);
      res.json(simulationDatasetId);
    } else if ((jsonResponse as HasuraError).errors) {
      throw new Error(JSON.stringify((jsonResponse as HasuraError).errors));
    } else {
      throw new Error('Simulation dataset upload unsuccessful.');
    }
  } catch (error) {
    logger.error(`POST /uploadSimulationDataset: Error occurred during simulation dataset upload`);
    logger.error(error);
    const status = isServerError(error) ? error.statusCode : 500;
    res.status(status).send((error as Error).message);
  }
}

async function downloadSimulationDataset(req: Request, res: Response) {
  const { plan_id: planIdString, simulation_dataset_id: datasetIdString } = req.query as {
    plan_id: string;
    simulation_dataset_id: string;
  };
  const headers = buildHeaders(req);

  try {
    const planId = parseInt(planIdString);
    const simulationDatasetId = parseInt(datasetIdString);

    if (isNaN(planId) || isNaN(simulationDatasetId)) {
      throw new BadRequestError('plan_id and simulation_dataset_id query parameters are required and must be integers');
    }

    logger.info(
      `GET /downloadSimulationDataset: Downloading simulation dataset ${simulationDatasetId} for plan ${planId}`,
    );

    const response = await fetch(GQL_API_URL, {
      body: JSON.stringify({
        query: gql.DOWNLOAD_SIMULATION_DATASET,
        variables: { planId, simulationDatasetId },
      }),
      headers,
      method: 'POST',
    });

    type DownloadResponse = { data: { downloadSimulationDataset: { simulationResults: object } | null } };
    const jsonResponse = (await response.json()) as DownloadResponse | HasuraError;

    if ((jsonResponse as DownloadResponse).data?.downloadSimulationDataset != null) {
      const { simulationResults } = (jsonResponse as DownloadResponse).data.downloadSimulationDataset!;
      logger.info(
        `GET /downloadSimulationDataset: Successfully retrieved simulation dataset ${simulationDatasetId}`,
      );

      res.setHeader('Content-Type', 'application/json');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="simulation_dataset_${simulationDatasetId}.json"`,
      );
      res.status(200).send(JSON.stringify(simulationResults));
    } else if ((jsonResponse as HasuraError).errors) {
      throw new Error(JSON.stringify((jsonResponse as HasuraError).errors));
    } else {
      throw new Error('Simulation dataset download unsuccessful.');
    }
  } catch (error) {
    logger.error(`GET /downloadSimulationDataset: Error occurred during simulation dataset download`);
    logger.error(error);
    const status = isServerError(error) ? error.statusCode : 500;
    res.status(status).send((error as Error).message);
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
   *     tags:
   *       - Hasura
   */
  app.post('/importPlan', upload.single('plan_file'), refreshLimiter, auth, importPlan);

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
  app.post('/uploadDataset', upload.single('external_dataset'), refreshLimiter, auth, uploadDataset);

  /**
   * @swagger
   * /uploadSimulationDataset:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - multipart/form-data
   *     produces:
   *       - application/json
   *     requestBody:
   *       content:
   *         multipart/form-data:
   *          schema:
   *            type: object
   *            properties:
   *              plan_id:
   *                type: integer
   *              simulation_results_file:
   *                format: binary
   *                type: string
   *     responses:
   *       200:
   *         description: The ID of the created simulation dataset
   *     summary: Upload a simulation results JSON file to a plan
   *     tags:
   *       - Hasura
   */
  app.post('/uploadSimulationDataset', upload.single('simulation_results_file'), refreshLimiter, auth, uploadSimulationDataset);

  /**
   * @swagger
   * /downloadSimulationDataset:
   *   get:
   *     security:
   *       - bearerAuth: []
   *     produces:
   *       - application/json
   *     parameters:
   *      - in: header
   *        name: x-hasura-role
   *        schema:
   *          type: string
   *          required: false
   *      - in: query
   *        name: plan_id
   *        schema:
   *          type: integer
   *        required: true
   *      - in: query
   *        name: simulation_dataset_id
   *        schema:
   *          type: integer
   *        required: true
   *     responses:
   *       200:
   *         description: The simulation results JSON file
   *       400:
   *         description: Missing or invalid query parameters
   *       403:
   *         description: Unauthorized error
   *       401:
   *         description: Unauthenticated error
   *     summary: Download a simulation dataset as a JSON file
   *     tags:
   *       - Hasura
   */
  app.get('/downloadSimulationDataset', refreshLimiter, auth, downloadSimulationDataset);

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
  app.post('/uploadActivities', upload.single('activity_file'), refreshLimiter, auth, uploadActivities);
};
