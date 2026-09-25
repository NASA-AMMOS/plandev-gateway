import { describe, expect, test } from 'vitest';
import {
  convertDateToDoy,
  getTimeDifference,
  intervalToMicroseconds,
  isoToDoyTimestamp,
  parseDoyOrYmdTime,
} from './time';

describe('Time utility function tests', () => {
  test('parseDoyOrYmdTime', () => {
    expect(parseDoyOrYmdTime('2019-365T08:00:00.1234')).toEqual({
      doy: 365,
      hour: 8,
      min: 0,
      ms: 123.4,
      sec: 0,
      time: '08:00:00.1234',
      year: 2019,
    });

    expect(parseDoyOrYmdTime('2019-01-20T08:10:03.9')).toEqual({
      day: 20,
      hour: 8,
      min: 10,
      month: 1,
      ms: 900,
      sec: 3,
      time: '08:10:03.9',
      year: 2019,
    });

    expect(parseDoyOrYmdTime('2022-01-2T00:00:00')).toEqual({
      day: 2,
      hour: 0,
      min: 0,
      month: 1,
      ms: 0,
      sec: 0,
      time: '00:00:00',
      year: 2022,
    });

    expect(parseDoyOrYmdTime('2019-365T08:80:00.1234')).toEqual(null);
    expect(parseDoyOrYmdTime('2022-20-2T00:00:00')).toEqual(null);
  });

  test('convertDateToDoy', () => {
    expect(convertDateToDoy('2024-01-01T00:10:00')).toEqual('2024-001T00:10:00');
    expect(convertDateToDoy('2024-04-09T00:10:00')).toEqual('2024-100T00:10:00');
    expect(convertDateToDoy('2024-09-27T00:10:00')).toEqual('2024-271T00:10:00');
  });

  test('getTimeDifference', () => {
    expect(getTimeDifference('2024-01-01T00:10:00', '2024-01-01T00:11:00', 6)).toEqual(60000000);
    expect(getTimeDifference('2024-01-01T00:01:00', '2024-01-01T00:11:00', 6)).toEqual(600000000);
    expect(getTimeDifference('2024-245T00:01:00.0', '2024-245T00:02:00.0', 6)).toEqual(60000000);
    expect(getTimeDifference('2024-245T00:01:00.0', '2024-245T12:02:00.0', 6)).toEqual(43260000000);
    expect(getTimeDifference('2024-243T00:01:00.0', '2024-245T12:02:00.0', 6)).toEqual(216060000000);
  });
});

describe('isoToDoyTimestamp', () => {
  test('converts to UTC day-of-year, keeping microseconds', () => {
    expect(isoToDoyTimestamp('2030-01-01T00:00:00+00:00')).toBe('2030-001T00:00:00');
    expect(isoToDoyTimestamp('2030-01-01T00:00:00Z')).toBe('2030-001T00:00:00');
    expect(isoToDoyTimestamp('2030-12-31T23:59:59.123456+00:00')).toBe('2030-365T23:59:59.123456');
    expect(isoToDoyTimestamp('2032-12-31T12:00:00+00:00')).toBe('2032-366T12:00:00');
    // an offset moves the instant, and here the day
    expect(isoToDoyTimestamp('2030-01-01T02:00:00+05:00')).toBe('2029-365T21:00:00');
    expect(isoToDoyTimestamp('2030-001T00:00:00')).toBe('2030-001T00:00:00');
  });

  test('refuses anything else', () => {
    expect(() => isoToDoyTimestamp('yesterday')).toThrow('Invalid date-time: yesterday');
  });
});

describe('intervalToMicroseconds', () => {
  test('converts plan durations, including hours past a day and single microseconds', () => {
    expect(intervalToMicroseconds('24:00:00')).toBe(86_400_000_000);
    expect(intervalToMicroseconds('1008:00:00')).toBe(6 * 7 * 24 * 3_600_000_000);
    expect(intervalToMicroseconds('1 day 02:00:00')).toBe(26 * 3_600_000_000);
    expect(intervalToMicroseconds('00:00:00.000001')).toBe(1);
  });
});
