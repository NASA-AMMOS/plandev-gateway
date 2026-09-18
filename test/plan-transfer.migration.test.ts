import Ajv from 'ajv';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, test } from 'vitest';
import { UnsupportedPlanTransferError, parsePlanTransfer } from '../src/packages/plan/plan-transfer';
import { planTransferSchema } from '../src/schemas/plan-transfer-validation-schema';

const validate = Ajv().compile(planTransferSchema);

const fixture = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf-8'));

const v3Fixture = fixture('plan-transfer-v3');
const v2Fixture = fixture('plan-transfer-v2');

const { version: v2Version, ...versionlessFixture } = v2Fixture;

const parseAndAssertCanonical = (input: unknown) => {
  const result = parsePlanTransfer(input);
  validate(result);
  expect(validate.errors ?? []).toEqual([]);
  expect(result.version).toBe('3');
  return result;
};

describe('plan transfer migration', () => {
  test('v3 passes through unchanged', () => {
    expect(parseAndAssertCanonical(v3Fixture)).toEqual(v3Fixture);
  });

  test('v2 migrates by version alone, preserving every other field', () => {
    expect(v2Version).toBe('2');
    expect(parseAndAssertCanonical(v2Fixture)).toEqual({ ...v2Fixture, version: '3' });
  });

  test('versionless input is treated as v2 and migrates the same way', () => {
    expect(parseAndAssertCanonical(versionlessFixture)).toEqual({ ...versionlessFixture, version: '3' });
  });

  test('v2 and versionless files reject v3-only fields', () => {
    for (const base of [v2Fixture, versionlessFixture]) {
      expect(() => parsePlanTransfer({ ...base, model: v3Fixture.model })).toThrow(/'model' requires/);
      expect(() => parsePlanTransfer({ ...base, results: v3Fixture.results })).toThrow(/'results' requires/);
    }
  });

  test('unsupported explicit versions are rejected', () => {
    for (const version of ['1', '4', 'foo']) {
      expect(() => parsePlanTransfer({ ...v2Fixture, version })).toThrow(
        new RegExp(`Unsupported PlanTransfer version '${version}'`),
      );
    }
  });

  test('non-object input is rejected', () => {
    for (const input of [null, 42, 'plan', [], undefined]) {
      expect(() => parsePlanTransfer(input)).toThrow(UnsupportedPlanTransferError);
    }
  });

  test('malformed v2 and versionless input fails canonical schema validation', () => {
    expect(() => parsePlanTransfer({ foo: 'bar' })).toThrow(/not a valid PlanTransfer v3/);
    expect(() => parsePlanTransfer({ ...v2Fixture, activities: [{ id: 1 }] })).toThrow(/not a valid PlanTransfer v3/);
    // The old end_time/sim_id format is no longer migrated, so it fails here.
    const { duration, simulation_arguments, ...noWindow } = v2Fixture;
    expect(duration).toBeDefined();
    expect(simulation_arguments).toBeDefined();
    expect(() => parsePlanTransfer({ ...noWindow, end_time: '2030-01-02T00:00:00+00:00', sim_id: 9 })).toThrow(
      /not a valid PlanTransfer v3/,
    );
  });
});
