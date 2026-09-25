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
 * The matching JSON Schema lives in
 * `src/schemas/plan-transfer-validation-schema.ts`.
 */

export type SerializedValue = null | boolean | number | string | SerializedValue[] | { [key: string]: SerializedValue };

export type TransferTag = {
  tag: {
    name: string;
    color: string | null;
  };
};

/**
 * Mirrors backend ValueSchema with the exception of the `secret` variant.
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

  /**
   * Optional user-provided metadata object.
   */
  metadata?: Record<string, SerializedValue>;
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

  /**
   * A single SerializedValue of any type, not a map like `arguments`.
   */
  computed_attributes?: SerializedValue;

  /**
   * Simulated, generated and decomposed spans do not necessarily correspond to
   * directives.
   */
  directive_id?: number;

  parent_id?: number;
};

/**
 * Profile types match what `addExternalDataset` accepts, what simulation writes to `merlin.profile.type`, and what the
 * UI reads back as `profile.type` (`{ type, schema }`), so `results.profiles` is a ProfileSet as-is.
 */
export type RealProfileSegment = {
  /**
   * Microseconds.
   */
  duration: number;

  /**
   * Rate is per second. Omitted for a gap.
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
   * Omitted for a gap. `null` is a value, not a gap.
   */
  dynamics?: SerializedValue;
};

export type ProfileSegment = RealProfileSegment | DiscreteProfileSegment;

/**
 * `schema` is the resource's ValueSchema and should equal its `model.resource_types` declaration. Simulated real
 * resources use `{ type: 'struct', items: { initial: { type: 'real' }, rate: { type: 'real' } } }`.
 */
export type ProfileSet =
  | { type: 'real'; schema: ValueSchema; segments: RealProfileSegment[] }
  | { type: 'discrete'; schema: ValueSchema; segments: DiscreteProfileSegment[] };

export type ProfileSets = Record<string, ProfileSet>;

/**
 * Result timing inherits the plan window, or overrides it with both a start
 * time and a duration for a subset simulation.
 */
export type SimulationResultsTransfer = {
  spans: SimulatedActivitySpan[];
  profiles: ProfileSets;
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
