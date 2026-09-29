import { describe, expect, test } from 'vitest';
import { convertDateToDoy, getTimeDifference, parseDoyOrYmdTime } from './time';

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

    expect(parseDoyOrYmdTime('2019-10-31T08:10:03.9')).toEqual({
      day: 31,
      hour: 8,
      min: 10,
      month: 10,
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
