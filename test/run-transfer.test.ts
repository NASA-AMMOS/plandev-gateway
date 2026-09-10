/**
 * The run-transfer validation layers, against the same fixtures the format is frozen with.
 *
 * The fixtures live in plandev-examples (beside the format reference and the schema they were written
 * for) and are read from there rather than copied, so this suite cannot pass against a stale copy. If
 * that checkout is not present the fixture-driven tests skip with a reason rather than pretending to
 * have run -- but the layer-independent tests below still run everywhere.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  canonicalJSON,
  declarationDigest,
  describe as describeFile,
  findNonFiniteNumbers,
  isRunTransfer,
  RunTransferError,
  SUPPORTED_VERSIONS,
  validate,
} from '../src/packages/plan/runTransfer';
import { runTransferSchema } from '../src/schemas/run-transfer-schema';

const here = dirname(fileURLToPath(import.meta.url));
const fixtureRoot =
  process.env.RUN_TRANSFER_FIXTURES ??
  resolve(here, '../../../plandev-examples/external-model-backends/run_transfer/fixtures');

const haveFixtures = existsSync(fixtureRoot);
const withFixtures = haveFixtures ? describe : describe.skip;

function fixture(relative: string): unknown {
  return JSON.parse(readFileSync(join(fixtureRoot, relative), 'utf8'));
}

type ManifestEntry = { fixture: string; layer: string; message: string; what: string };

function manifest(): ManifestEntry[] {
  return fixture('invalid/MANIFEST.json') as ManifestEntry[];
}

describe('the schema this gateway compiles', () => {
  test('is draft-07, matching the pinned ajv ^6', () => {
    // ajv 6 does not support 2020-12, and it does not say so -- it silently ignores the keywords it
    // does not know, so a 2020-12 schema would appear to validate while enforcing almost nothing.
    expect(runTransferSchema.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  test('is in sync with the source of truth in plandev-examples', () => {
    if (!haveFixtures) {
      return;
    }
    const source = JSON.parse(
      readFileSync(resolve(fixtureRoot, '../run-transfer.v1.schema.json'), 'utf8'),
    );
    // The generated module sorts object keys, so compare parsed content rather than text.
    expect(sortKeys(runTransferSchema)).toEqual(sortKeys(source));
  });
});

withFixtures('the valid fixture', () => {
  test('validates, with no warnings', () => {
    const { run, warnings } = validate(fixture('valid/synthetic.run.json'));
    expect(warnings).toEqual([]);
    expect(run.kind).toBe('plandev-run');
    expect(run.plan.activities).toHaveLength(2);
    expect(run.results?.spans).toHaveLength(5);
  });

  test('is described as a recorded run, with counts and the model it declares', () => {
    const notices = describeFile(fixture('valid/synthetic.run.json'));
    const messages = notices.map(({ message }) => message).join('\n');
    expect(messages).toContain('Recorded run');
    expect(messages).toContain('2 directives');
    expect(messages).toContain('2 resources');
    expect(messages).toContain('5 spans');
    expect(messages).toContain('RunTransferDemo/recorded/1.0.0');
    expect(notices.every(({ severity }) => severity === 'info')).toBe(true);
    // The UI drops a notice with no subjects, so every notice must name what it is about.
    expect(notices.every(({ subjects }) => subjects.length > 0)).toBe(true);
  });
});

withFixtures('the layer split', () => {
  test('every schema-layer fixture is refused by the schema, naming a field', () => {
    for (const entry of manifest().filter(({ layer }) => layer === 'schema')) {
      let thrown: unknown;
      try {
        validate(fixture(`invalid/${entry.fixture}`));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.fixture).toBeInstanceOf(RunTransferError);
      const error = thrown as RunTransferError;
      expect(error.layer, entry.fixture).toBe('schema');
      expect(error.notices.length, entry.fixture).toBeGreaterThan(0);
      expect(error.notices.every(({ subjects }) => subjects.length > 0), entry.fixture).toBe(true);
    }
  });

  test('every importer-layer fixture is refused by the importer, not the schema', () => {
    for (const entry of manifest().filter(({ layer }) => layer === 'importer')) {
      let thrown: unknown;
      try {
        validate(fixture(`invalid/${entry.fixture}`));
      } catch (error) {
        thrown = error;
      }
      expect(thrown, entry.fixture).toBeInstanceOf(RunTransferError);
      expect((thrown as RunTransferError).layer, entry.fixture).toBe('importer');
    }
  });

  /**
   * The assertion the whole split exists for. A gate-layer fixture is admissible SHAPE and
   * inadmissible CONTENT, so everything before the gate must let it through -- if the schema quietly
   * grew a rule the gate already owns, this is where it shows up.
   */
  test('every gate-layer fixture passes the schema and the importer untouched', () => {
    for (const entry of manifest().filter(({ layer }) => layer === 'gate')) {
      // The one exception is documented in the fixture manifest: a non-finite number cannot be
      // forwarded through this gateway at all, because JSON.stringify turns it into null, which is the
      // wire spelling of a profile gap. So the importer refuses it here rather than letting merlin's
      // equivalent check be bypassed by the serializer.
      if (entry.fixture.includes('non-finite')) {
        expect(() => validate(fixture(`invalid/${entry.fixture}`))).toThrow(/non-finite/);
        continue;
      }
      expect(() => validate(fixture(`invalid/${entry.fixture}`)), entry.fixture).not.toThrow();
    }
  });
});

describe('the envelope', () => {
  const minimal = {
    kind: 'plandev-run',
    plan: {
      activities: [],
      duration: '01:00:00',
      name: 'p',
      simulation_arguments: {},
      start_time: '2026-01-01T00:00:00+00:00',
      version: '2',
    },
    version: '1',
  };

  test('a file with no kind is not a run transfer at all', () => {
    // This is the whole detection rule: a legacy plan.json has no `kind`, so it can never be
    // mistaken for a truncated run file.
    expect(isRunTransfer({ activities: [], name: 'old plan', version: '2' })).toBe(false);
    expect(isRunTransfer(minimal)).toBe(true);
  });

  test('a wrong kind is refused outright, naming what is required', () => {
    expect(() => validate({ ...minimal, kind: 'plandev-plan' })).toThrow(/must be exactly 'plandev-run'/);
  });

  test('an unknown version is refused, naming the versions that exist', () => {
    // The point of the message: a producer that hits this needs to know which versions to target,
    // and "should be equal to constant" does not tell them.
    expect(() => validate({ ...minimal, version: '3' })).toThrow(/'3' is not supported/);
    for (const supported of SUPPORTED_VERSIONS) {
      expect(() => validate({ ...minimal, version: supported })).not.toThrow();
    }
  });

  test('an unknown version is never partially understood', () => {
    // A v3 file carrying a v3 `results` member must not have its plan half imported: a
    // half-understood run lands in the database looking fine.
    const future = { ...minimal, results: { somethingNew: true }, version: '2' };
    expect(() => validate(future)).toThrow(/not supported/);
  });
});

describe('non-finite numbers', () => {
  test('are found wherever they sit, with the path that holds them', () => {
    const doc = {
      results: { profiles: { '/a': { segments: [{ dynamics: { initial: 1, rate: 1e400 } }] } } },
    };
    expect(findNonFiniteNumbers(doc)).toEqual([
      { path: 'results.profiles./a.segments[0].dynamics.rate', value: Infinity },
    ]);
  });

  test('are what JSON.stringify would silently turn into a profile gap', () => {
    // The reason this check exists, asserted rather than described: forwarding a parsed document
    // converts an infinite rate into `null`, which merlin reads as "this resource has no value here".
    // The run would store, render, and be wrong.
    expect(JSON.stringify({ rate: 1e400 })).toBe('{"rate":null}');
  });

  test('a finite document has none', () => {
    expect(findNonFiniteNumbers({ a: [1, 2.5, -0], b: { c: 0 } })).toEqual([]);
  });
});

describe('the declaration digest', () => {
  const model = {
    activityTypes: [
      {
        computedAttributesSchema: { items: {}, type: 'struct' },
        name: 'Observe',
        parameters: [
          { name: 'target', schema: { type: 'string' } },
          { name: 'priority', schema: { type: 'int' } },
        ],
        requiredParameters: ['target'],
      },
    ],
    capabilities: { simulation: { reason: 'nothing to run', supported: false } },
    mission: 'M',
    name: 'm',
    parameters: [{ name: 'initialSoc', schema: { type: 'real' } }],
    resourceTypes: [{ name: '/battery/soc', schema: { type: 'real' } }],
    version: '1.0.0',
  };

  test('is stable across key order', () => {
    const reordered = { ...model, activityTypes: [{ ...model.activityTypes[0] }] };
    expect(declarationDigest(reordered)).toBe(declarationDigest(model));
  });

  test('ignores mission, name and version', () => {
    // Those are the model's IDENTITY, not its type surface. The digest answers "are these the same
    // types?", which is the question asked when a natural key already exists.
    expect(declarationDigest({ ...model, mission: 'Other', name: 'other', version: '9' })).toBe(
      declarationDigest(model),
    );
  });

  test('changes when a parameter is REORDERED', () => {
    // Not cosmetic: merlin persists each parameter's index as its `order`, reads activity types back
    // sorted by it, and the argument form is laid out in that order. Sorting the parameters before
    // hashing would hide a reordered declaration from the check that exists to catch drift.
    const swapped = {
      ...model,
      activityTypes: [{ ...model.activityTypes[0], parameters: [...model.activityTypes[0].parameters].reverse() }],
    };
    expect(declarationDigest(swapped)).not.toBe(declarationDigest(model));
  });

  test('changes when requiredness flips, with no schema change', () => {
    // PlanDev persists requiredParameters and the gate enforces them, so this changes what PlanDev
    // believes without changing a single schema.
    const optional = { ...model, activityTypes: [{ ...model.activityTypes[0], requiredParameters: [] }] };
    expect(declarationDigest(optional)).not.toBe(declarationDigest(model));
  });

  test('changes when a computed-attribute schema changes', () => {
    const computed = {
      ...model,
      activityTypes: [
        { ...model.activityTypes[0], computedAttributesSchema: { items: { n: { type: 'int' } }, type: 'struct' } },
      ],
    };
    expect(declarationDigest(computed)).not.toBe(declarationDigest(model));
  });

  test('changes when capabilities change', () => {
    // PlanDev keeps a copy of something the file owns, and a stale copy is exactly what the digest is
    // for -- as true of capabilities as of types.
    const capable = { ...model, capabilities: { simulation: { supported: true } } };
    expect(declarationDigest(capable)).not.toBe(declarationDigest(model));
  });

  test('is 16 hex characters', () => {
    expect(declarationDigest(model)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('canonical JSON', () => {
  test('sorts object keys and preserves array order', () => {
    expect(canonicalJSON({ b: 1, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"b":1}');
  });

  test('has no whitespace, so it cannot disagree with another implementation over formatting', () => {
    expect(canonicalJSON({ a: { b: 'c' } })).toBe('{"a":{"b":"c"}}');
  });
});

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map(key => [key, sortKeys((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}
