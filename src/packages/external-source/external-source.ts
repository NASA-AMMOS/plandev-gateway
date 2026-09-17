import type { Express, Request, Response } from 'express';
import type {
  ExternalSourceTypeInsertInput,
  CreateExternalSourceResponse,
  ExternalEventTypeInsertInput,
  CreateExternalSourceEventTypeResponse,
  GetSourceEventTypeAttributeSchemasResponse,
  AttributeSchema,
  DerivationGroupInsertInput,
  ExternalSourceInsertInput,
  ExternalSourceJson,
  ExternalEventInsertInput,
} from '../../types/external-source.js';
import Ajv from 'ajv';
import { getEnv } from '../../env.js';
import getLogger from '../../logger.js';
import gql from './gql.js';
import {
  attributeSchemaMetaschema,
  baseExternalSourceSchema,
} from '../../schemas/external-event-validation-schemata.js';
import { HasuraError } from '../../types/hasura.js';
import { auth } from '../auth/middleware.js';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { parseJSONFile } from '../../util/fileParser.js';
import { convertDoyToYmd, getIntervalInMs, switchISOTimezoneRepresentation } from '../../util/time.js';

const upload = multer();
const logger = getLogger('packages/external-source/external-source');
const { RATE_LIMITER_LOGIN_MAX, HASURA_API_URL } = getEnv();
const GQL_API_URL = `${HASURA_API_URL}/v1/graphql`;
const ajv = new Ajv();
const compiledAttributeMetaschema = ajv.compile(attributeSchemaMetaschema);
const refreshLimiter = rateLimit({
  legacyHeaders: false,
  max: RATE_LIMITER_LOGIN_MAX,
  standardHeaders: true,
  windowMs: 15 * 60 * 1000, // 15 minutes
});

export function updateSchemaWithDefs(defs: { event_types: any; source_type: any }): Ajv.ValidateFunction {
  // Build if statement
  const ifThenElse: { [key: string]: any } = {};
  let ifThenElsePointer = ifThenElse;
  const keys = Object.keys(defs.event_types);

  // Handle single event type (don't bother with $defs, just update attributes' properties directly)
  if (keys.length === 1) {
    const localSchemaCopy = structuredClone(baseExternalSourceSchema);

    const eventTypeName = keys[0];
    const eventTypeSchema = {
      ...defs.event_types[eventTypeName],
      additionalProperties: false,
    };
    const sourceTypeName = Object.keys(defs.source_type)[0];
    const sourceTypeSchema = {
      ...defs.source_type[sourceTypeName],
      additionalProperties: false,
    };

    localSchemaCopy.properties.events.items.properties.attributes = eventTypeSchema;
    localSchemaCopy.properties.events.items.properties.event_type_name = { const: eventTypeName };

    // Insert def for "source" attributes
    localSchemaCopy.properties.source.properties.attributes = sourceTypeSchema;

    const localAjv = new Ajv();
    return localAjv.compile(localSchemaCopy);
  }

  // Handle n event types
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    // Create tree of if/else/then statements to support validating different types
    ifThenElsePointer['if'] = {
      properties: {
        event_type_name: {
          const: key,
        },
      },
    };
    ifThenElsePointer['then'] = {
      properties: {
        attributes: {
          $ref: `#/$defs/event_types/${key}`,
        },
      },
    };
    ifThenElsePointer['else'] = {};
    ifThenElsePointer = ifThenElsePointer['else'];
  }

  const key = keys[keys.length - 1];
  ifThenElsePointer['properties'] = {
    attributes: {
      $ref: `#/$defs/event_types/${key}`,
    },
  };

  const localSchemaCopy = structuredClone(baseExternalSourceSchema);
  localSchemaCopy.properties.events.items['if'] = ifThenElse['if'];
  localSchemaCopy.properties.events.items['then'] = ifThenElse['then'];
  localSchemaCopy.properties.events.items['else'] = ifThenElse['else'];

  // Insert def for "source" attributes
  const sourceTypeKey = Object.keys(defs.source_type)[0];
  localSchemaCopy.properties.source.properties.attributes = { $ref: `#/$defs/source_type/${sourceTypeKey}` };

  // Add defs
  localSchemaCopy.$defs = {
    event_types: {},
    source_type: {
      [sourceTypeKey]: {
        ...defs.source_type[sourceTypeKey],
        additionalProperties: false,
      },
    },
  };
  for (const eventType of keys) {
    localSchemaCopy.$defs.event_types[eventType] = {
      ...defs.event_types[eventType],
      additionalProperties: false,
    };
  }

  // Compile & return full schema with 'defs' added
  const localAjv = new Ajv();
  return localAjv.compile(localSchemaCopy);
}

async function uploadExternalSourceEventTypes(req: Request, res: Response) {
  const authorizationHeader = req.get('authorization');

  const {
    body: { event_types, source_types },
    headers: { 'x-hasura-role': roleHeader, 'x-hasura-user-id': userHeader },
  } = req;

  let parsedEventTypes: { [x: string]: object } | undefined = undefined;
  if (event_types !== undefined) {
    parsedEventTypes = JSON.parse(event_types);
  }
  let parsedSourceTypes: { [x: string]: object } | undefined = undefined;
  if (source_types !== undefined) {
    parsedSourceTypes = JSON.parse(source_types);
  }

  logger.info(`POST /uploadExternalSourceEventTypes: Uploading External Source and Event Types...`);

  const headers: HeadersInit = {
    Authorization: authorizationHeader ?? '',
    'Content-Type': 'application/json',
    'x-hasura-role': roleHeader ? `${roleHeader}` : '',
    'x-hasura-user-id': userHeader ? `${userHeader}` : '',
  };

  // Validate uploaded attribute schemas are formatted validly
  const metaschema: { [x: string]: object } = {};
  if (parsedEventTypes !== undefined) {
    metaschema['event_types'] = parsedEventTypes;
  }
  if (parsedSourceTypes !== undefined) {
    metaschema['source_types'] = parsedSourceTypes;
  }
  const schemasAreValid: boolean = await compiledAttributeMetaschema(metaschema);
  if (!schemasAreValid) {
    const errorMsg = `Schema validation failed for uploaded source and event types:\n${JSON.stringify(
      compiledAttributeMetaschema.errors,
    )}`;
    logger.error(`POST /uploadExternalSourceEventTypes: ${errorMsg}`);
    res.status(500).send({ message: errorMsg });
    return;
  }

  logger.info(`POST /uploadExternalSourceEventTypes: Uploaded attribute schema(s) are VALID.`);

  // extract the external sources and event types
  const externalSourceTypeInput: ExternalSourceTypeInsertInput[] = [];
  const externalEventTypeInput: ExternalEventTypeInsertInput[] = [];

  let eventTypeKeys: string[] = [];
  if (parsedEventTypes !== undefined) {
    eventTypeKeys = Object.keys(parsedEventTypes);
    for (const externalEventType of eventTypeKeys) {
      externalEventTypeInput.push({
        attribute_schema: parsedEventTypes[externalEventType],
        name: externalEventType,
      });
    }
  }

  let sourceTypeKeys: string[] = [];
  if (parsedSourceTypes !== undefined) {
    sourceTypeKeys = Object.keys(parsedSourceTypes);
    for (const externalSourceType of sourceTypeKeys) {
      externalSourceTypeInput.push({
        attribute_schema: parsedSourceTypes[externalSourceType],
        name: externalSourceType,
      });
    }
  }

  // Run the Hasura mutation for creating all types, in one go
  const response = await fetch(GQL_API_URL, {
    body: JSON.stringify({
      query: gql.CREATE_EXTERNAL_SOURCE_EVENT_TYPES,
      variables: { externalEventTypes: externalEventTypeInput, externalSourceTypes: externalSourceTypeInput },
    }),
    headers,
    method: 'POST',
  });

  const createExternalSourceEventTypesResponse = await response.json();
  if (createExternalSourceEventTypesResponse?.data !== undefined) {
    res.json(createExternalSourceEventTypesResponse.data as CreateExternalSourceEventTypeResponse);
  } else {
    res.json(createExternalSourceEventTypesResponse as HasuraError);
  }
}

async function uploadExternalSource(req: Request, res: Response) {
  const authorizationHeader = req.get('authorization');

  const {
    headers: { 'x-hasura-role': roleHeader, 'x-hasura-user-id': userHeader },
  } = req;

  const { body, file } = req;
  const { derivation_group_name } = body;
  if (!file) {
    const errorMsg = 'No file given';
    logger.error(`POST /uploadExternalSource: ${errorMsg}`);
    res.status(500).send({
      message: errorMsg,
    });
    return;
  }

  const headers: HeadersInit = {
    Authorization: authorizationHeader ?? '',
    'Content-Type': 'application/json',
    'x-hasura-role': roleHeader ? `${roleHeader}` : '',
    'x-hasura-user-id': userHeader ? `${userHeader}` : '',
  };

  try {
    const externalSourceJson = await parseJSONFile<ExternalSourceJson>(file);
    const { source, events } = externalSourceJson;
    logger.info(`POST /uploadExternalSource: Uploading External Source: ${source.key}`);
    const derivationGroupName =
      derivation_group_name !== undefined ? derivation_group_name : source.derivation_group_name;

    // Validate the input source/events, convert times
    const startTimeFormatted: string | undefined = switchISOTimezoneRepresentation(
      convertDoyToYmd(source.period.start_time.replace('Z', '')) ?? '',
    );
    const endTimeFormatted: string | undefined = switchISOTimezoneRepresentation(
      convertDoyToYmd(source.period.end_time.replace('Z', '')) ?? '',
    );
    const validAtFormatted: string | undefined = switchISOTimezoneRepresentation(
      convertDoyToYmd(source.valid_at.replace('Z', '')) ?? '',
    );

    if (!startTimeFormatted || !endTimeFormatted || !validAtFormatted) {
      throw new Error(
        `Parsing failed - parsing dates in input failed. ${source.period.start_time}, ${source.period.end_time}, ${source.valid_at}`,
      );
    }

    // Check that the start and end times are logical
    if (new Date(startTimeFormatted) > new Date(endTimeFormatted)) {
      throw new Error(`Parsing failed - start time ${startTimeFormatted} after end time ${endTimeFormatted}.`);
    }

    // Set to formatted values for validation
    externalSourceJson.source.period.start_time = startTimeFormatted;
    externalSourceJson.source.period.end_time = endTimeFormatted;
    externalSourceJson.source.valid_at = validAtFormatted;

    // Create parsed external events
    const parsedExternalEvents: ExternalEventInsertInput[] = [];
    for (const externalEvent of events) {
      // Ensure duration is valid
      try {
        getIntervalInMs(externalEvent.duration);
      } catch (error) {
        throw new Error(`Event duration has invalid format: ${externalEvent.key}\n${(error as Error).message}`);
      }

      // Validate external event is in the external source's time bounds
      const externalEventStart = Date.parse(convertDoyToYmd(externalEvent.start_time.replace('Z', '')) ?? '');
      const externalEventEnd = externalEventStart + getIntervalInMs(externalEvent.duration);
      if (!(externalEventStart >= Date.parse(startTimeFormatted) && externalEventEnd <= Date.parse(endTimeFormatted))) {
        throw new Error(
          `Event (${externalEvent.key}) not in bounds of source start and end: occurs from [${new Date(
            externalEventStart,
          )}, ${new Date(externalEventEnd)}], not subset of [${new Date(startTimeFormatted)}, ${new Date(
            endTimeFormatted,
          )}].`,
        );
      }

      parsedExternalEvents.push(externalEvent);
    }

    // Get the attribute schema for the source's external source type and all contained event types
    let eventTypeNamesPresentInSource = events.map(e => e.event_type_name);
    eventTypeNamesPresentInSource = eventTypeNamesPresentInSource.filter(
      (e, i) => eventTypeNamesPresentInSource.indexOf(e) === i,
    );
    const attributeSchemas = await fetch(GQL_API_URL, {
      body: JSON.stringify({
        query: gql.GET_SOURCE_EVENT_TYPE_ATTRIBUTE_SCHEMAS,
        variables: {
          externalEventTypes: eventTypeNamesPresentInSource,
          externalSourceType: source.source_type_name,
        },
      }),
      headers,
      method: 'POST',
    });

    const attributeSchemaJson = await attributeSchemas.json();
    const { external_event_type, external_source_type } =
      attributeSchemaJson.data as GetSourceEventTypeAttributeSchemasResponse;
    // If the source type doesn't exist, and there are attributes - the source cannot be uploaded
    const newSourceType = [];
    if (external_source_type.length === 0) {
      if (Object.keys(source.attributes || {}).length > 0) {
        throw new Error(`The source type in your source, '${source.source_type_name}', do not exist in the database.`);
      } else {
        // Create External Source Type w. empty attribute schema
        // These are useful for getting a full list of source types and event types for UI timeline event filtering
        newSourceType.push({
          attribute_schema: {
            properties: {},
            required: [],
            type: 'object',
          },
          name: source.source_type_name,
        });
      }
    }

    // Loop through all events and if any event has attributes but no schema, throw, otherwise
    // add all event types that are missing schema to the db
    const eventTypesWithoutSchema: Set<string> = new Set();
    for (const event of events) {
      const eventHasSchemaInDB = external_event_type.find(eventType => eventType.name === event.event_type_name);
      if (!eventHasSchemaInDB) {
        if (Object.keys(event.attributes || {}).length > 0) {
          // Reject the upload if we find any events with attributes that don't have a schema
          throw new Error(`The event type in your source, '${event.event_type_name}', do not exist in the database.`);
        } else {
          eventTypesWithoutSchema.add(event.event_type_name);
        }
      }
    }
    const newEventTypes = Array.from(eventTypesWithoutSchema.values()).map(eventTypeName => ({
      attribute_schema: {
        properties: {},
        required: [],
        type: 'object',
      },
      name: eventTypeName,
    }));

    const eventTypeNamesMappedToSchemas = external_event_type.reduce(
      (acc: Record<string, AttributeSchema>, eventType: ExternalEventTypeInsertInput) => {
        acc[eventType.name] = eventType.attribute_schema;
        return acc;
      },
      {},
    );
    const sourceTypeNamesMappedToSchemas = external_source_type.reduce(
      (acc: Record<string, AttributeSchema>, sourceType: ExternalSourceTypeInsertInput) => {
        acc[sourceType.name] = sourceType.attribute_schema;
        return acc;
      },
      {},
    );

    // Assemble megaschema from attribute schemas
    const compiledExternalSourceMegaschema: Ajv.ValidateFunction = updateSchemaWithDefs({
      event_types: eventTypeNamesMappedToSchemas,
      source_type: sourceTypeNamesMappedToSchemas,
    });

    // Verify that this is a valid external source
    const sourceIsValid: boolean = await compiledExternalSourceMegaschema(externalSourceJson);
    if (sourceIsValid) {
      logger.info(`POST /uploadExternalSource: External Source ${source.key}'s formatting is valid`);
    } else {
      const errorMsg = `External Source ${source.key}'s formatting is invalid:\n${JSON.stringify(
        compiledExternalSourceMegaschema.errors,
      )}`;
      logger.error(`POST /uploadExternalSource: ${errorMsg}`);
      res.status(500).send({ message: errorMsg });
      return;
    }

    // Create new, empty types in DB if required
    if (Object.keys(newEventTypes).length > 0 || Object.keys(newSourceType).length > 0) {
      const response = await fetch(GQL_API_URL, {
        body: JSON.stringify({
          query: gql.CREATE_EXTERNAL_SOURCE_EVENT_TYPES,
          variables: { externalEventTypes: newEventTypes, externalSourceTypes: newSourceType },
        }),
        headers,
        method: 'POST',
      });
      const createExternalSourceEventTypesResponse = await response.json();
      if (createExternalSourceEventTypesResponse?.data === undefined) {
        throw new Error((createExternalSourceEventTypesResponse as HasuraError).errors[0].message);
      }
    }

    // Run the Hasura mutation for creating an external source
    const derivationGroupInsert: DerivationGroupInsertInput = {
      name: derivationGroupName,
      source_type_name: source.source_type_name,
    };

    const externalSourceInsert: ExternalSourceInsertInput = {
      attributes: source.attributes || {},
      derivation_group_name: derivationGroupName,
      end_time: endTimeFormatted,
      external_events: {
        data: parsedExternalEvents,
      },
      key: source.key,
      source_type_name: source.source_type_name,
      start_time: startTimeFormatted,
      valid_at: validAtFormatted,
    };

    const response = await fetch(GQL_API_URL, {
      body: JSON.stringify({
        query: gql.CREATE_EXTERNAL_SOURCE,
        variables: {
          derivation_group: derivationGroupInsert,
          source: externalSourceInsert,
        },
      }),
      headers,
      method: 'POST',
    });

    const createExternalSourceResponse = await response.json();
    if (createExternalSourceResponse?.data !== undefined) {
      res.json(createExternalSourceResponse.data as CreateExternalSourceResponse);
    } else {
      res.json(createExternalSourceResponse as HasuraError);
    }
  } catch (e) {
    const error = e as Error;
    logger.error(`POST /uploadExternalSource: Error occurred during External Source ${file.filename} upload`);
    logger.error(error.message);
    if (error.stack) logger.info(error.stack);
    res.status(500).send({
      message: error.message || 'Unknown error',
    });
    return;
  }
}

export default (app: Express) => {
  /**
   * @swagger
   * /uploadExternalSourceEventTypes:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - application/json
   *     produces:
   *       - application/json
   *     parameters:
   *       - in: header
   *         name: x-hasura-role
   *         schema:
   *           type: string
   *           required: false
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               event_types:
   *                 description: An object representing the JSON Schema definition(s) for all external event types to be uploaded.
   *                 type: object
   *               source_types:
   *                 description: An object representing the JSON Schema definition(s) for all external event types to be uploaded.
   *                 type: object
   *             required:
   *               - event_types
   *               - source_types
   *     responses:
   *       200:
   *         description: Created External Source & Event Types
   *         content:
   *           application/json:
   *             schema:
   *                properties:
   *                  createExternalEventTypes:
   *                    description: Names of all the event types that were created in this request.
   *                    type: object
   *                  createExternalSourceTypes:
   *                    description: Names of all the source types that were created in this request.
   *                    type: object
   *       403:
   *         description: Unauthorized error
   *       401:
   *         description: Unauthenticated error
   *     summary: Uploads & validates a combination of External Event & Source types to Hasura.
   *     tags:
   *       - Hasura
   */
  app.post('/uploadExternalSourceEventTypes', refreshLimiter, auth, uploadExternalSourceEventTypes);

  /**
   * @swagger
   * /uploadExternalSource:
   *   post:
   *     security:
   *       - bearerAuth: []
   *     consumes:
   *       - multipart/form-data
   *     produces:
   *       - application/json
   *     parameters:
   *       - in: header
   *         name: x-hasura-role
   *         schema:
   *           type: string
   *           required: false
   *     requestBody:
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             properties:
   *               external_source_file:
   *                  format: binary
   *                  type: string
   *               derivation_group_name:
   *                  type: string
   *     responses:
   *       200:
   *         description: Created External Source
   *         content:
   *           application/json:
   *             schema:
   *                properties:
   *                  createExternalSource:
   *                    type: object
   *                    properties:
   *                      name:
   *                        description: Name of the created External Source
   *                        type: string
   *       403:
   *         description: Unauthorized error
   *       401:
   *         description: Unauthenticated error
   *     summary: Uploads an External Source to Hasura.
   *     tags:
   *       - Hasura
   */
  app.post('/uploadExternalSource', upload.single('external_source_file'), refreshLimiter, auth, uploadExternalSource);
};
