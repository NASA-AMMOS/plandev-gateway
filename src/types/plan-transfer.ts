/**
 * PlanTransfer v3 — the PlanDev plan interchange wire format.
 *
 * A v3 transfer is either a plain plan, or a self-contained package that also
 * embeds model type declarations and (optionally) recorded simulation results.
 * There is no separate run/snapshot format.
 *
 *   plan only                VALID
 *   plan + model             VALID
 *   plan + model + results   VALID
 *   plan + results, no model INVALID
 *
 * Wire format is snake_case. The matching JSON Schema lives in
 * `src/schemas/plan-transfer-validation-schema.ts`.
 */

export type SerializedValue = null | boolean | number | string | SerializedValue[] | { [key: string]: SerializedValue };

export type TransferTag = {
  tag: {
    name: string;
    color?: string | null;
  };
};

export type ValueSchemaMetadata = {
  metadata?: Record<string, SerializedValue>;
};

/**
 * Mirrors the Merlin backend ValueSchema serialization surface
 * (`ValueSchemaJsonParser` / `ValueSchema` in aerie's merlin-driver). Keep this
 * union in lockstep with the backend rather than with the UI's broader local
 * type — notably, there is no `secret` variant on the wire.
 */
export type ValueSchema =
  | ({ type: 'real' } & ValueSchemaMetadata)
  | ({ type: 'int' } & ValueSchemaMetadata)
  | ({ type: 'boolean' } & ValueSchemaMetadata)
  | ({ type: 'string' } & ValueSchemaMetadata)
  | ({ type: 'duration' } & ValueSchemaMetadata)
  | ({ type: 'path' } & ValueSchemaMetadata)
  | ({ type: 'series'; items: ValueSchema } & ValueSchemaMetadata)
  | ({ type: 'struct'; items: Record<string, ValueSchema> } & ValueSchemaMetadata)
  | ({ type: 'variant'; variants: { key: string; label: string }[] } & ValueSchemaMetadata);

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
   * Required so PlanDev can associate directives/spans with an activity type.
   */
  name: string;

  /**
   * Optional. Missing schemas reduce type information but must not cause
   * arguments to be discarded — an argument with no declared schema is
   * preserved as a raw SerializedValue.
   */
  parameters?: ModelParameter[];

  required_parameters?: string[];

  /**
   * Required semantically when spans of this type carry computed_attributes.
   */
  computed_attributes_schema?: ValueSchema;

  description?: string;
  subsystem?: string;
};

export type ResourceTypeDeclaration = {
  name: string;
  schema: ValueSchema;
};

export type ModelDeclaration = {
  /**
   * This is a type declaration, not model identity.
   * Do not add mission/name/version fields.
   */
  activity_types: ActivityTypeDeclaration[];
  resource_types: ResourceTypeDeclaration[];

  /**
   * Optional schemas for the plan's simulation_arguments.
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
   * Optional. Simulated/generated/decomposed spans do not necessarily
   * correspond to directives.
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
 * declared once under `model.resource_types` and is never repeated here.
 */
export type ResourceProfile =
  | {
      type: 'real';
      segments: RealProfileSegment[];
    }
  | {
      type: 'discrete';
      segments: DiscreteProfileSegment[];
    };

export type SimulationResultsTransferBase = {
  spans: SimulatedActivitySpan[];
  profiles: Record<string, ResourceProfile>;
};

/**
 * Result timing either inherits the plan window or explicitly overrides both
 * start and duration for subset simulations.
 */
export type SimulationResultsTransfer =
  | (SimulationResultsTransferBase & {
      start_time?: never;
      duration?: never;
    })
  | (SimulationResultsTransferBase & {
      start_time: string;
      duration: number;
    });

export type PlanTransfer = {
  version: '3';

  /**
   * Informational source ID only.
   */
  id?: number;

  /**
   * May be present on PlanDev-originated files but is not authoritative when
   * an embedded model declaration is supplied.
   */
  model_id?: number | null;

  name: string;
  start_time: string;
  duration: string;

  simulation_arguments: Record<string, SerializedValue>;

  activities: ActivityDirectiveTransfer[];

  tags?: TransferTag[];

  /**
   * Optional self-contained type information.
   */
  model?: ModelDeclaration;

  /**
   * Optional recorded results. Requires `model`.
   */
  results?: SimulationResultsTransfer;
};
