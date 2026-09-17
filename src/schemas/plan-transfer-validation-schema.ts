/**
 * JSON Schema for the PlanTransfer v3 wire format. Kept in lockstep with the
 * TypeScript types in `src/types/plan-transfer.ts`.
 *
 * This validates structure only. Cross-object relationships (unique activity
 * IDs, anchor/directive/parent resolution, activity & resource types existing
 * in the embedded model, values conforming to their declared ValueSchemas)
 * belong to the later semantic import validator.
 */
export const planTransferSchema = {
  $id: 'https://nasa-ammos.github.io/plandev/schemas/plan-transfer.schema.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  additionalProperties: false,
  definitions: {
    activity: {
      additionalProperties: false,
      properties: {
        anchor_id: {
          type: ['integer', 'null'],
        },
        anchored_to_start: {
          type: 'boolean',
        },
        arguments: {
          additionalProperties: {
            $ref: '#/definitions/serialized_value',
          },
          type: 'object',
        },
        id: {
          type: 'integer',
        },
        metadata: {
          additionalProperties: {
            $ref: '#/definitions/serialized_value',
          },
          type: 'object',
        },
        name: {
          type: 'string',
        },
        start_offset: {
          type: 'string',
        },
        tags: {
          items: {
            $ref: '#/definitions/tag',
          },
          type: 'array',
        },
        type: {
          minLength: 1,
          type: 'string',
        },
      },
      required: ['id', 'anchor_id', 'anchored_to_start', 'arguments', 'metadata', 'name', 'start_offset', 'type'],
      type: 'object',
    },
    activity_type: {
      additionalProperties: false,
      dependencies: {
        required_parameters: ['parameters'],
      },
      properties: {
        computed_attributes_schema: {
          $ref: '#/definitions/value_schema',
        },
        description: {
          type: 'string',
        },
        name: {
          minLength: 1,
          type: 'string',
        },
        parameters: {
          items: {
            $ref: '#/definitions/model_parameter',
          },
          type: 'array',
        },
        required_parameters: {
          items: {
            minLength: 1,
            type: 'string',
          },
          type: 'array',
        },
        subsystem: {
          type: 'string',
        },
      },
      required: ['name'],
      type: 'object',
    },
    discrete_profile_segment: {
      additionalProperties: false,
      properties: {
        duration: {
          description: 'Microseconds.',
          minimum: 0,
          type: 'integer',
        },
        dynamics: {
          $ref: '#/definitions/serialized_value',
          description: 'Omit dynamics to represent a profile gap.',
        },
      },
      required: ['duration'],
      type: 'object',
    },
    model: {
      additionalProperties: false,
      properties: {
        activity_types: {
          items: {
            $ref: '#/definitions/activity_type',
          },
          type: 'array',
        },
        parameters: {
          items: {
            $ref: '#/definitions/model_parameter',
          },
          type: 'array',
        },
        resource_types: {
          items: {
            $ref: '#/definitions/resource_type',
          },
          type: 'array',
        },
      },
      required: ['activity_types', 'resource_types'],
      type: 'object',
    },
    model_parameter: {
      additionalProperties: false,
      properties: {
        name: {
          minLength: 1,
          type: 'string',
        },
        schema: {
          $ref: '#/definitions/value_schema',
        },
      },
      required: ['name', 'schema'],
      type: 'object',
    },
    real_profile_segment: {
      additionalProperties: false,
      properties: {
        duration: {
          description: 'Microseconds.',
          minimum: 0,
          type: 'integer',
        },
        dynamics: {
          additionalProperties: false,
          description: 'Omit dynamics to represent a profile gap.',
          properties: {
            initial: {
              type: 'number',
            },
            rate: {
              description: 'Rate per second.',
              type: 'number',
            },
          },
          required: ['initial', 'rate'],
          type: 'object',
        },
      },
      required: ['duration'],
      type: 'object',
    },
    resource_profile: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            segments: {
              items: {
                $ref: '#/definitions/real_profile_segment',
              },
              type: 'array',
            },
            type: {
              const: 'real',
            },
          },
          required: ['type', 'segments'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            segments: {
              items: {
                $ref: '#/definitions/discrete_profile_segment',
              },
              type: 'array',
            },
            type: {
              const: 'discrete',
            },
          },
          required: ['type', 'segments'],
          type: 'object',
        },
      ],
    },
    resource_type: {
      additionalProperties: false,
      properties: {
        name: {
          minLength: 1,
          type: 'string',
        },
        schema: {
          $ref: '#/definitions/value_schema',
        },
      },
      required: ['name', 'schema'],
      type: 'object',
    },
    results: {
      additionalProperties: false,
      dependencies: {
        duration: ['start_time'],
        start_time: ['duration'],
      },
      properties: {
        duration: {
          description: 'Optional result-window duration in microseconds. Defaults to the plan duration.',
          minimum: 0,
          type: 'integer',
        },
        profiles: {
          additionalProperties: {
            $ref: '#/definitions/resource_profile',
          },
          type: 'object',
        },
        spans: {
          items: {
            $ref: '#/definitions/span',
          },
          type: 'array',
        },
        start_time: {
          description: 'Optional result-window start. Defaults to plan start_time.',
          type: 'string',
        },
      },
      required: ['spans', 'profiles'],
      type: 'object',
    },
    serialized_value: {},
    span: {
      additionalProperties: false,
      properties: {
        arguments: {
          additionalProperties: {
            $ref: '#/definitions/serialized_value',
          },
          type: 'object',
        },
        computed_attributes: {
          additionalProperties: {
            $ref: '#/definitions/serialized_value',
          },
          type: 'object',
        },
        directive_id: {
          description: 'Optional reference to an activities[].id in this transfer.',
          type: 'integer',
        },
        duration: {
          description: 'Microseconds. Omit for an unfinished span.',
          minimum: 0,
          type: 'integer',
        },
        parent_id: {
          description: 'Optional reference to another span_id.',
          type: 'integer',
        },
        span_id: {
          type: 'integer',
        },
        start_offset: {
          description: 'Microseconds from the result window start.',
          type: 'integer',
        },
        type: {
          minLength: 1,
          type: 'string',
        },
      },
      required: ['span_id', 'type', 'start_offset', 'arguments'],
      type: 'object',
    },
    tag: {
      additionalProperties: false,
      properties: {
        tag: {
          additionalProperties: false,
          properties: {
            color: {
              type: ['string', 'null'],
            },
            name: {
              minLength: 1,
              type: 'string',
            },
          },
          required: ['name'],
          type: 'object',
        },
      },
      required: ['tag'],
      type: 'object',
    },
    // Mirrors the Merlin backend ValueSchema serialization surface. Notably there
    // is no `secret` variant on the wire, even though the UI's local type is broader.
    value_schema: {
      oneOf: [
        {
          additionalProperties: false,
          properties: {
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'real',
            },
          },
          required: ['type'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'int',
            },
          },
          required: ['type'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'boolean',
            },
          },
          required: ['type'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'string',
            },
          },
          required: ['type'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'duration',
            },
          },
          required: ['type'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'path',
            },
          },
          required: ['type'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            items: {
              $ref: '#/definitions/value_schema',
            },
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'series',
            },
          },
          required: ['type', 'items'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            items: {
              additionalProperties: {
                $ref: '#/definitions/value_schema',
              },
              type: 'object',
            },
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'struct',
            },
          },
          required: ['type', 'items'],
          type: 'object',
        },
        {
          additionalProperties: false,
          properties: {
            metadata: {
              $ref: '#/definitions/value_schema_metadata',
            },
            type: {
              const: 'variant',
            },
            variants: {
              items: {
                additionalProperties: false,
                properties: {
                  key: {
                    type: 'string',
                  },
                  label: {
                    type: 'string',
                  },
                },
                required: ['key', 'label'],
                type: 'object',
              },
              type: 'array',
            },
          },
          required: ['type', 'variants'],
          type: 'object',
        },
      ],
    },
    value_schema_metadata: {
      additionalProperties: {
        $ref: '#/definitions/serialized_value',
      },
      type: 'object',
    },
  },
  dependencies: {
    results: ['model'],
  },
  description:
    'PlanDev plan interchange format. A transfer may optionally embed model type declarations and recorded simulation results.',
  properties: {
    activities: {
      items: {
        $ref: '#/definitions/activity',
      },
      type: 'array',
    },
    duration: {
      type: 'string',
    },
    id: {
      description: 'Optional informational source plan ID.',
      type: 'integer',
    },
    model: {
      $ref: '#/definitions/model',
    },
    model_id: {
      description: 'Optional informational source model ID. Not authoritative when model is embedded.',
      type: ['integer', 'null'],
    },
    name: {
      minLength: 1,
      type: 'string',
    },
    results: {
      $ref: '#/definitions/results',
    },
    simulation_arguments: {
      additionalProperties: {
        $ref: '#/definitions/serialized_value',
      },
      type: 'object',
    },
    start_time: {
      type: 'string',
    },
    tags: {
      items: {
        $ref: '#/definitions/tag',
      },
      type: 'array',
    },
    version: {
      const: '3',
    },
  },
  required: ['version', 'name', 'start_time', 'duration', 'simulation_arguments', 'activities'],
  title: 'PlanDev PlanTransfer v3',
  type: 'object',
} as const;
