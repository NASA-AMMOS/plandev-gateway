import type { ProfileSets } from './plan-transfer.js';

export type { ProfileSegment, ProfileSet, ProfileSets } from './plan-transfer.js';

export type UploadPlanDatasetPayload = {
  plan_id: string;
  simulation_dataset_id?: string;
};

export type UploadPlanDatasetJSON = {
  datasetStart: string;
  profileSet: ProfileSets;
};

export type UploadActivitiesPayload = {
  plan_id: string;
};
