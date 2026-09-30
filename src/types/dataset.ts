export type ProfileSegment = {
  duration: number;
  dynamics?: number | string | boolean | object; // `dynamics` should match `schema`
};

export type ProfileSet = {
  type: 'discrete' | 'real';
  schema: object; // ValueSchema type
  segments: ProfileSegment[];
};

export type ProfileSets = Record<string, ProfileSet>;

export type UploadPlanDatasetPayload = {
  plan_id: string;
  simulation_dataset_id?: string;
};

export type UploadPlanDatasetJSON = {
  datasetStart: string;
  profileSet: ProfileSets;
};

export type SimulatedActivity = {
  id: number;
  directiveId: number | null;
  parentId: number | null;
  childIds: number[];
  type: string;
  duration: string;
  attributes: object;
  arguments: Record<string, unknown>;
  startTime: string;
  startOffset?: string;
  endTime?: string;
};

export type UnfinishedActivity = {
  id: number;
  directiveId: number | null;
  parentId: number | null;
  childIds: number[];
  type: string;
  arguments: Record<string, unknown>;
  startTime: string;
  startOffset?: string;
};

export type SimulationEvent = {
  causalTime: string;
  realTime: string;
  transactionIndex: number;
  value: unknown;
  topic: string;
  spanId: number | null;
};

export type SimulationDatasetJSON = {
  simulationStartTime: string;
  simulationEndTime: string;
  profiles: {
    realProfiles: { name: string; schema: object; segments: { extent: string; dynamics: unknown }[] }[];
    discreteProfiles: { name: string; schema: object; segments: { extent: string; dynamics: unknown }[] }[];
  };
  spans: {
    simulatedActivities: SimulatedActivity[];
    unfinishedActivities: UnfinishedActivity[];
  };
  simulationArguments?: Record<string, unknown>;
  topics?: Record<string, { schema: object }>;
  events?: SimulationEvent[];
};

export type UploadActivitiesPayload = {
  plan_id: string;
};
