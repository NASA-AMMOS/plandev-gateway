import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';
import { planTransferSchema } from '../src/schemas/plan-transfer-validation-schema';

const ajv = Ajv();
const validate = ajv.compile(planTransferSchema);

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/plan-transfer-v3.json', import.meta.url)), 'utf-8'),
);

/** Minimal valid v3 plan transfer, with no embedded model or results. */
const plainPlan = {
  activities: [
    {
      anchor_id: null,
      anchored_to_start: true,
      arguments: { target: 'Crater Rim A' },
      id: 1,
      metadata: {},
      name: 'image crater rim',
      start_offset: '01:00:00',
      type: 'TakeImage',
    },
  ],
  duration: '24:00:00',
  name: 'Orbit 112',
  simulation_arguments: {},
  start_time: '2030-01-01T00:00:00+00:00',
  version: '3',
};

/** The ValueSchema simulation gives real (linear) resources. */
const realSchema = { items: { initial: { type: 'real' }, rate: { type: 'real' } }, type: 'struct' };

const emptyModel = { activity_types: [], resource_types: [] };

const expectValid = (transfer: unknown) => {
  validate(transfer);
  expect(validate.errors ?? []).toEqual([]);
};

const expectInvalid = (transfer: unknown) => expect(validate(transfer)).toBe(false);

/** Wraps an activity type declaration in an otherwise-minimal valid transfer. */
const withActivityType = (activityType: unknown) => ({
  ...plainPlan,
  model: { ...emptyModel, activity_types: [activityType] },
});

/** Wraps a ValueSchema in an otherwise-minimal valid transfer. */
const withValueSchema = (schema: unknown) => ({
  ...plainPlan,
  model: { ...emptyModel, parameters: [{ name: 'param', schema }] },
});

/** Wraps a results object in an otherwise-minimal valid transfer that has a model. */
const withResults = (results: unknown) => ({ ...plainPlan, model: emptyModel, results });

/*
 * Structural validity only.
 */
describe('PlanTransfer v3 schema', () => {
  describe('valid', () => {
    test('the representative fixture', () => {
      expectValid(fixture);
    });

    test('a plain plan with no model or results', () => {
      expectValid(plainPlan);
    });

    test('optional id, model_id and tags', () => {
      expectValid({
        ...plainPlan,
        id: 42,
        model_id: null,
        tags: [{ tag: { color: null, name: 'imaging' } }, { tag: { color: '#2a9d8f', name: 'external' } }],
      });
    });

    test('a plan with a model and no results', () => {
      expectValid({ ...plainPlan, model: emptyModel });
    });

    test('a plan with a model with metadata', () => {
      expectValid({ ...plainPlan, model: { ...emptyModel, metadata: { test: 'metadata' } } });
    });

    test('a plan with a model and results, inheriting the plan window', () => {
      expectValid(withResults({ profiles: {}, spans: [] }));
    });

    test('an activity type declaring only a name', () => {
      expectValid(withActivityType({ name: 'Calibrate' }));
    });

    test('an activity type with full parameter schemas', () => {
      expectValid(
        withActivityType({
          computed_attributes_schema: { items: { image_id: { type: 'string' } }, type: 'struct' },
          description: 'Point the camera and capture a burst of frames.',
          name: 'TakeImage',
          parameters: [
            { name: 'target', schema: { type: 'string' } },
            { name: 'count', schema: { type: 'int' } },
          ],
          required_parameters: ['target'],
          subsystem: 'imaging',
        }),
      );
    });

    test('a span without directive_id', () => {
      expectValid(
        withResults({
          profiles: {},
          spans: [{ arguments: {}, duration: 10, parent_id: 1, span_id: 2, start_offset: 0, type: 'DownlinkChunk' }],
        }),
      );
    });

    test('an unfinished span without duration', () => {
      expectValid(
        withResults({
          profiles: {},
          spans: [{ arguments: {}, span_id: 1, start_offset: 0, type: 'DownlinkChunk' }],
        }),
      );
    });

    test('computed attributes as an object', () => {
      expectValid(
        withResults({
          profiles: {},
          spans: [
            {
              arguments: {},
              computed_attributes: { bytes: 24576000, image_id: 'IMG-0001' },
              span_id: 1,
              start_offset: 0,
              type: 'TakeImage',
            },
          ],
        }),
      );
    });

    // computed attributes are a single SerializedValue, so any JSON value
    test.each([
      ['a number', 42],
      ['a string', 'IMG-0001'],
      ['an array', ['a']],
      ['a boolean', true],
      ['null', null],
    ])('computed attributes as %s', (_, computed_attributes) => {
      expectValid(
        withResults({
          profiles: {},
          spans: [{ arguments: {}, computed_attributes, span_id: 1, start_offset: 0, type: 'TakeImage' }],
        }),
      );
    });

    test('a real resource profile, including a gap segment', () => {
      expectValid(
        withResults({
          profiles: {
            '/battery/state_of_charge': {
              schema: realSchema,
              segments: [{ dynamics: { initial: 0.92, rate: -0.00002 }, duration: 600 }, { duration: 300 }],
              type: 'real',
            },
          },
          spans: [],
        }),
      );
    });

    test('a discrete resource profile, including a gap segment', () => {
      expectValid(
        withResults({
          profiles: {
            '/camera/mode': {
              schema: { type: 'string' },
              segments: [{ dynamics: 'IMAGING', duration: 600 }, { duration: 300 }, { dynamics: null, duration: 1 }],
              type: 'discrete',
            },
          },
          spans: [],
        }),
      );
    });

    test('results with both an explicit start_time and duration', () => {
      expectValid(
        withResults({
          duration: 21600000000,
          profiles: {},
          spans: [],
          start_time: '2030-01-01T06:00:00+00:00',
        }),
      );
    });

    test('recursive series, struct and variant ValueSchemas', () => {
      expectValid(
        withValueSchema({
          items: {
            items: {
              counts: { items: { type: 'int' }, type: 'series' },
              mode: { type: 'variant', variants: [{ key: 'AUTO', label: 'Automatic' }] },
            },
            type: 'struct',
          },
          type: 'series',
        }),
      );
    });

    test('every scalar ValueSchema type', () => {
      for (const type of ['real', 'int', 'boolean', 'string', 'duration', 'path']) {
        expectValid(withValueSchema({ type }));
      }
    });

    test('ValueSchema metadata', () => {
      expectValid(withValueSchema({ metadata: { multiline: true, unit: 'frames' }, type: 'int' }));
    });
  });

  describe('invalid', () => {
    test('a missing version', () => {
      const { version, ...noVersion } = plainPlan;
      expect(version).toBe('3');
      expectInvalid(noVersion);
    });

    test('v2 does not directly validate as canonical PlanTransfer v3', () => {
      // v2 is accepted at the import boundary, which normalizes it to v3 first.
      // See test/plan-transfer.migration.test.ts.
      expectInvalid({ ...plainPlan, version: '2' });
    });

    test('a tag omitting color', () => {
      // `color` is required but nullable, matching what PlanDev already exports.
      expectInvalid({ ...plainPlan, tags: [{ tag: { name: 'imaging' } }] });
    });

    test('an unknown top-level property', () => {
      expectInvalid({ ...plainPlan, end_time: '2030-01-02T00:00:00+00:00' });
    });

    test('results without a model', () => {
      expectInvalid({ ...plainPlan, results: { profiles: {}, spans: [] } });
    });

    test('a result start_time without a duration', () => {
      expectInvalid(withResults({ profiles: {}, spans: [], start_time: '2030-01-01T06:00:00+00:00' }));
    });

    test('a result duration without a start_time', () => {
      expectInvalid(withResults({ duration: 21600000000, profiles: {}, spans: [] }));
    });

    test('required_parameters without parameters', () => {
      expectInvalid(withActivityType({ name: 'TakeImage', required_parameters: ['target'] }));
    });

    test('an activity type without a name', () => {
      expectInvalid(withActivityType({ parameters: [{ name: 'target', schema: { type: 'string' } }] }));
    });

    test('a malformed ValueSchema', () => {
      expectInvalid(withValueSchema({ type: 'series' }));
      expectInvalid(withValueSchema({ items: { type: 'string' }, type: 'string' }));
      expectInvalid(withValueSchema('string'));
    });

    test('an unsupported ValueSchema type such as secret', () => {
      expectInvalid(withValueSchema({ type: 'secret' }));
    });

    test('a malformed variant entry', () => {
      expectInvalid(withValueSchema({ type: 'variant', variants: [{ key: 'AUTO' }] }));
      expectInvalid(withValueSchema({ type: 'variant', variants: ['AUTO'] }));
    });

    test('malformed real-profile dynamics', () => {
      expectInvalid(
        withResults({
          profiles: {
            '/battery/state_of_charge': {
              schema: realSchema,
              segments: [{ dynamics: 0.92, duration: 600 }],
              type: 'real',
            },
          },
          spans: [],
        }),
      );
      expectInvalid(
        withResults({
          profiles: {
            '/battery/state_of_charge': {
              schema: realSchema,
              segments: [{ dynamics: { initial: 0.92 }, duration: 600 }],
              type: 'real',
            },
          },
          spans: [],
        }),
      );
    });

    test('a resource profile without its ValueSchema', () => {
      expectInvalid(
        withResults({ profiles: { '/battery/state_of_charge': { segments: [], type: 'real' } }, spans: [] }),
      );
      expectInvalid(withResults({ profiles: { '/camera/mode': { segments: [], type: 'discrete' } }, spans: [] }));
    });

    test('an unknown profile type', () => {
      expectInvalid(
        withResults({
          profiles: { '/camera/mode': { schema: { type: 'string' }, segments: [], type: 'variant' } },
          spans: [],
        }),
      );
    });

    test('an activity missing anchor fields', () => {
      const [activity] = plainPlan.activities;
      const { anchor_id, ...noAnchor } = activity;
      expect(anchor_id).toBe(null);
      expectInvalid({ ...plainPlan, activities: [noAnchor] });
    });

    test('a non-integer span start_offset', () => {
      expectInvalid(
        withResults({
          profiles: {},
          spans: [{ arguments: {}, span_id: 1, start_offset: '01:00:00', type: 'TakeImage' }],
        }),
      );
    });
  });
});
