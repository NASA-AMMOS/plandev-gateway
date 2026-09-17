/**
 * PlanTransfer v3 — the PlanDev plan interchange format.
 *
 * A v3 transfer contains a plan and may additionally embed model type
 * declarations and recorded simulation results.
 *
 *   plan only                VALID
 *   plan + model             VALID
 *   plan + model + results   VALID
 *   plan + results, no model INVALID
 *
 * The wire format uses snake_case. The matching JSON Schema lives in
 * `src/schemas/plan-transfer-validation-schema.ts`.
 */

export type SerializedValue = null | boolean | number | string | SerializedValue[] | { [key: string]: SerializedValue };

/**
 * Matches the tag shape PlanDev already exports (`Pick<Tag, 'color' | 'name'>`):
 * `color` is required but nullable, not optional.
 */
export type TransferTag = {
  tag: {
    name: string;
    color: string | null;
  };
};

/**
 * Mirrors the Merlin backend ValueSchema serialization format.
 * Keep this type aligned with the backend representation rather than the
 * UI's broader local type. In particular, `secret` is not part of this
 * wire format.
 */
export type ValueSchema = { metadata?: Record<string, SerializedValue> } & (
  | { type: 'real' | 'int' | 'boolean' | 'string' | 'duration' | 'path' }
  | { type: 'series'; items: ValueSchema }
  | { type: 'struct'; items: Record<string, ValueSchema> }
  | { type: 'variant'; variants: { key: string; label: string }[] }
);

export type ActivityDirectiveTransfer = {
  id: number;

  anchor_id: number | null;
  anchored_to_start: boolean;

  arguments: Record<string, SerializedValue>;
  metadata: Record<string, SerializedValue>;

  name: string;
  start_offset: string;
  type: string;

  tags?: TransferTag[];
};

export type ModelParameter = {
  name: string;
  schema: ValueSchema;
};

export type ActivityTypeDeclaration = {
  /**
   * Associates directives and spans with an activity type.
   */
  name: string;

  /**
   * Declaring parameters is optional. A type with only a name is fully
   * supported: its arguments are preserved as raw SerializedValues, with less
   * type information available downstream.
   */
  parameters?: ModelParameter[];

  required_parameters?: string[];

  /**
   * Required when spans of this type carry `computed_attributes`.
   */
  computed_attributes_schema?: ValueSchema;

  description?: string;
  subsystem?: string;
};

export type ResourceTypeDeclaration = {
  name: string;
  schema: ValueSchema;
};

/**
 * Model type information required to interpret the transferred plan and
 * results. Model source identity is managed separately.
 */
export type ModelDeclaration = {
  activity_types: ActivityTypeDeclaration[];
  resource_types: ResourceTypeDeclaration[];

  /**
   * Optional schemas for `simulation_arguments`.
   */
  parameters?: ModelParameter[];
};

export type SimulatedActivitySpan = {
  span_id: number;
  type: string;

  /**
   * Microseconds from the result window start.
   */
  start_offset: number;

  /**
   * Microseconds. Omitted for unfinished spans.
   */
  duration?: number;

  arguments: Record<string, SerializedValue>;

  computed_attributes?: Record<string, SerializedValue>;

  /**
   * Simulated, generated and decomposed spans do not necessarily correspond to
   * directives.
   */
  directive_id?: number;

  parent_id?: number;
};

export type RealProfileSegment = {
  /**
   * Microseconds.
   */
  duration: number;

  /**
   * Omitted for a gap.
   */
  dynamics?: {
    initial: number;
    rate: number;
  };
};

export type DiscreteProfileSegment = {
  /**
   * Microseconds.
   */
  duration: number;

  /**
   * Omitted for a gap.
   */
  dynamics?: SerializedValue;
};

/**
 * `type` determines the dynamics representation. The resource's ValueSchema is
 * declared once under `model.resource_types` and never repeated here.
 */
export type ResourceProfile =
  | { type: 'real'; segments: RealProfileSegment[] }
  | { type: 'discrete'; segments: DiscreteProfileSegment[] };

/**
 * Result timing inherits the plan window, or overrides it with both a start
 * time and a duration for a subset simulation.
 */
export type SimulationResultsTransfer = {
  spans: SimulatedActivitySpan[];
  profiles: Record<string, ResourceProfile>;
} & ({ start_time: string; duration: number } | { start_time?: never; duration?: never });

export type PlanTransfer = {
  version: '3';

  /**
   * Informational source ID only.
   */
  id?: number;

  /**
   * Informational. Not authoritative when an embedded model declaration is
   * supplied.
   */
  model_id?: number | null;

  name: string;
  start_time: string;
  duration: string;

  simulation_arguments: Record<string, SerializedValue>;

  activities: ActivityDirectiveTransfer[];

  tags?: TransferTag[];

  /**
   * Optional model type declarations, making the transfer self-contained.
   */
  model?: ModelDeclaration;

  /**
   * Optional recorded simulation results. Valid only when `model` is present.
   */
  results?: SimulationResultsTransfer;
};
