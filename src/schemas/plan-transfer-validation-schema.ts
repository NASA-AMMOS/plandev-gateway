/**
 * JSON Schema for the PlanTransfer v3 wire format. Kept in lockstep with the
 * TypeScript types in `src/types/plan-transfer.ts`. Validates structural
 * parts of the schema but not internal relationships and rules.
 */

/* eslint-disable sort-keys -- key order mirrors the wire format */
export const planTransferSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: 'https://nasa-ammos.github.io/plandev/schemas/plan-transfer.schema.json',
  title: 'PlanDev PlanTransfer v3',
  description: 'PlanDev plan interchange format with optional model type declarations and recorded simulation results.',
  type: 'object',
  additionalProperties: false,

  definitions: {
    tag: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tag: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: {
              type: 'string',
              minLength: 1,
            },
            color: {
              type: ['string', 'null'],
            },
          },
          required: ['name', 'color'],
        },
      },
      required: ['tag'],
    },

    // Mirrors backend ValueSchema with the exception of the `secret` variant.
    value_schema: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { enum: ['real', 'int', 'boolean', 'string', 'duration', 'path'] },
            metadata: { type: 'object' },
          },
          required: ['type'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { const: 'series' },
            items: {
              $ref: '#/definitions/value_schema',
            },
            metadata: { type: 'object' },
          },
          required: ['type', 'items'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { const: 'struct' },
            items: {
              type: 'object',
              additionalProperties: {
                $ref: '#/definitions/value_schema',
              },
            },
            metadata: { type: 'object' },
          },
          required: ['type', 'items'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: { const: 'variant' },
            variants: {
              type: 'array',
              items: {
                type: 'object',
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
              },
            },
            metadata: { type: 'object' },
          },
          required: ['type', 'variants'],
        },
      ],
    },

    model_parameter: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          minLength: 1,
        },
        schema: {
          $ref: '#/definitions/value_schema',
        },
      },
      required: ['name', 'schema'],
    },

    activity_type: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          minLength: 1,
        },
        parameters: {
          type: 'array',
          items: {
            $ref: '#/definitions/model_parameter',
          },
          description:
            'Optional. A type declaring only a name is fully supported; its arguments are preserved as raw serialized values.',
        },
        required_parameters: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
          },
        },
        computed_attributes_schema: {
          $ref: '#/definitions/value_schema',
        },
        description: {
          type: 'string',
        },
        subsystem: {
          type: 'string',
        },
      },
      required: ['name'],
      dependencies: {
        required_parameters: ['parameters'],
      },
    },

    resource_type: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: {
          type: 'string',
          minLength: 1,
        },
        schema: {
          $ref: '#/definitions/value_schema',
        },
      },
      required: ['name', 'schema'],
    },

    model: {
      type: 'object',
      additionalProperties: false,
      properties: {
        activity_types: {
          type: 'array',
          items: {
            $ref: '#/definitions/activity_type',
          },
        },
        resource_types: {
          type: 'array',
          items: {
            $ref: '#/definitions/resource_type',
          },
        },
        parameters: {
          type: 'array',
          items: {
            $ref: '#/definitions/model_parameter',
          },
        },
        metadata: {
          type: 'object',
        }
      },
      required: ['activity_types', 'resource_types'],
    },

    activity: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: {
          type: 'integer',
        },
        anchor_id: {
          type: ['integer', 'null'],
        },
        anchored_to_start: {
          type: 'boolean',
        },
        arguments: {
          type: 'object',
        },
        metadata: {
          type: 'object',
        },
        name: {
          type: 'string',
        },
        start_offset: {
          type: 'string',
        },
        tags: {
          type: 'array',
          items: {
            $ref: '#/definitions/tag',
          },
        },
        type: {
          type: 'string',
          minLength: 1,
        },
      },
      required: ['id', 'anchor_id', 'anchored_to_start', 'arguments', 'metadata', 'name', 'start_offset', 'type'],
    },

    span: {
      type: 'object',
      additionalProperties: false,
      properties: {
        span_id: {
          type: 'integer',
        },
        type: {
          type: 'string',
          minLength: 1,
        },
        start_offset: {
          type: 'integer',
          description: 'Microseconds from the result window start.',
        },
        duration: {
          type: 'integer',
          minimum: 0,
          description: 'Microseconds. Omit for an unfinished span.',
        },
        arguments: {
          type: 'object',
        },
        computed_attributes: {
          type: 'object',
        },
        directive_id: {
          type: 'integer',
          description: 'Optional reference to an activities[].id in this transfer.',
        },
        parent_id: {
          type: 'integer',
          description: 'Optional reference to another span_id.',
        },
      },
      required: ['span_id', 'type', 'start_offset', 'arguments'],
    },

    real_profile_segment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        duration: {
          type: 'integer',
          minimum: 0,
          description: 'Microseconds.',
        },
        dynamics: {
          type: 'object',
          additionalProperties: false,
          description: 'Omit dynamics to represent a profile gap.',
          properties: {
            initial: {
              type: 'number',
            },
            rate: {
              type: 'number',
              description: 'Rate per second.',
            },
          },
          required: ['initial', 'rate'],
        },
      },
      required: ['duration'],
    },

    discrete_profile_segment: {
      type: 'object',
      additionalProperties: false,
      properties: {
        duration: {
          type: 'integer',
          minimum: 0,
          description: 'Microseconds.',
        },
        dynamics: {
          description: 'Omit dynamics to represent a profile gap.',
        },
      },
      required: ['duration'],
    },

    resource_profile: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: {
              const: 'real',
            },
            segments: {
              type: 'array',
              items: {
                $ref: '#/definitions/real_profile_segment',
              },
            },
          },
          required: ['type', 'segments'],
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            type: {
              const: 'discrete',
            },
            segments: {
              type: 'array',
              items: {
                $ref: '#/definitions/discrete_profile_segment',
              },
            },
          },
          required: ['type', 'segments'],
        },
      ],
    },

    results: {
      type: 'object',
      additionalProperties: false,
      properties: {
        start_time: {
          type: 'string',
          description: 'Optional result-window start. Defaults to plan start_time.',
        },
        duration: {
          type: 'integer',
          minimum: 0,
          description: 'Optional result-window duration in microseconds. Defaults to the plan duration.',
        },
        spans: {
          type: 'array',
          items: {
            $ref: '#/definitions/span',
          },
        },
        profiles: {
          type: 'object',
          additionalProperties: {
            $ref: '#/definitions/resource_profile',
          },
        },
      },
      required: ['spans', 'profiles'],
      dependencies: {
        start_time: ['duration'],
        duration: ['start_time'],
      },
    },
  },

  properties: {
    version: {
      const: '3',
    },

    id: {
      type: 'integer',
      description: 'Optional informational source plan ID.',
    },

    model_id: {
      type: ['integer', 'null'],
      description: 'Optional informational source model ID. Not authoritative when model is embedded.',
    },

    name: {
      type: 'string',
      minLength: 1,
    },

    start_time: {
      type: 'string',
    },

    duration: {
      type: 'string',
    },

    simulation_arguments: {
      type: 'object',
    },

    activities: {
      type: 'array',
      items: {
        $ref: '#/definitions/activity',
      },
    },

    tags: {
      type: 'array',
      items: {
        $ref: '#/definitions/tag',
      },
    },

    model: {
      $ref: '#/definitions/model',
    },

    results: {
      $ref: '#/definitions/results',
    },
  },

  required: ['version', 'name', 'start_time', 'duration', 'simulation_arguments', 'activities'],

  dependencies: {
    results: ['model'],
  },
} as const;
