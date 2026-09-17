import type { UserId } from './auth';
import type { ActivityDirectiveTransfer } from './plan-transfer.js';

export type PlanSchema = {
  created_at: string;
  duration: string;
  id: number;
  model_id: number;
  name: string;
  owner: UserId;
  revision: number;
  simulations: [{ id: number }];
  start_time: string;
  updated_at: string;
  updated_by: UserId;
};

export type PlanInsertInput = Pick<PlanSchema, 'duration' | 'model_id' | 'name' | 'start_time'>;

export type PlanTagsInsertInput = {
  plan_id: number;
  tag_id: number;
};

export type ImportPlanPayload = {
  duration: string;
  model_id: number;
  name: string;
  simulation_template_id: number;
  simulation_arguments: ArgumentsMap;
  start_time: string;
  tags: string;
};

export type Argument = any;
export type ParameterName = string;
export type ArgumentsMap = Record<ParameterName, Argument>;

export type ActivityMetadataKey = string;
export type ActivityMetadataValue = any;
export type ActivityMetadata = Record<ActivityMetadataKey, ActivityMetadataValue>;

export type Tag = {
  color: string | null;
  created_at: string;
  id: number;
  name: string;
  owner: UserId;
};
export type ActivityDirectiveId = number;
export type ActivityDirective = {
  anchor_id: number | null;
  anchored_to_start: boolean;
  arguments: ArgumentsMap;
  id: ActivityDirectiveId;
  metadata: ActivityMetadata;
  name: string;
  start_offset: string;
  tags?: { tag: Tag }[];
  type: string;
};
export type TagsInsertInput = Pick<Tag, 'color' | 'name'>;
export type ActivityTagsInsertInput = {
  tag_id: number;
};
export type ActivityDirectiveInsertInput = {
  anchor_id: number | null;
  anchored_to_start: boolean;
  arguments: ArgumentsMap;
  metadata: ActivityMetadata;
  name: string;
  plan_id: number;
  start_offset: string;
  tags: {
    data: ActivityTagsInsertInput[];
  };
  type: string;
};
export type ActivityDirectiveSetInput = Pick<ActivityDirectiveInsertInput, 'anchor_id'>;

export type ActivitiesJSON = ActivityDirectiveTransfer[];

export type { PlanTransfer } from './plan-transfer.js';
