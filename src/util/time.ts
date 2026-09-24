import { ParsedDoyString, ParsedYmdString } from '../types/time';
import parseInterval from 'postgres-interval';

function parseNumber(number: number | string): number {
  return parseInt(`${number}`, 10);
}

/**
 * Changes the timezone representation of a UTC ISO 8601 between 'Z' and '+00:00'.
 * @param {string} time - The time string to convert
 * @returns {string} - The new string with the opposite timezone representation
 * @example
 * switchISOTimezoneRepresentation('2024-001T01:02:03Z'); // 2024-001T01:02:03+00:00
 * switchISOTimezoneRepresentation('2024-001T01:02:03+00:00'); // 2024-001T01:02:03Z
 */
export function switchISOTimezoneRepresentation(time: string): string {
  if (time.endsWith('Z')) {
    return time.replace('Z', '+00:00');
  } else if (time.endsWith('+00:00')) {
    return time.replace('+00:00', 'Z');
  }
  return time; // No changes if not a valid ISO 8601 representation
}

/**
 * padBefore - function to pad leading 0s to a number
 *
 * @param {number} number - number to pad
 * @param {number} numOfZeroes - number of zeroes to pad
 * @return {string}
 */
function padBefore(number: number | string, numOfZeroes: number, shouldTruncate: boolean = true) {
  return `${[...Array(numOfZeroes).keys()].map(() => '0').join('')}${number}`.slice(
    -(shouldTruncate ? numOfZeroes : Math.max(numOfZeroes, `${number}`.length)),
  );
}

/**
 * padDoy - function to pad leading 0s for DOY format
 * Note: This should only be used for Earth based time types, e.g. SCET and ERT
 *
 * @param {number | string} dayNumber - the day of year
 * @return {string}
 */
function padDoy(dayNumber: number | string) {
  return padBefore(parseNumber(dayNumber), 3);
}

function getDOY(date: Date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const diff = date.valueOf() - start.valueOf();
  const oneDay = 1000 * 60 * 60 * 24;
  return padDoy(Math.floor(diff / oneDay));
}

/**
 * Parses a date string (YYYY-MM-DDTHH:mm:ss) or DOY string (YYYY-DDDDTHH:mm:ss) into its separate components
 */
export function parseDoyOrYmdTime(dateString: string, numDecimals = 6): null | ParsedDoyString | ParsedYmdString {
  const matches = (dateString ?? '').match(
    new RegExp(
      `^(?<year>\\d{4})-(?:(?<month>(?:[0]?[0-9])|(?:[1][1-2]))-(?<day>(?:[0-2]?[0-9])|(?:[3][0-1]))|(?<doy>\\d{1,3}))(?:T(?<time>(?<hour>[0-9]|[0-2][0-9])(?::(?<min>[0-9]|(?:[0-5][0-9])))?(?::(?<sec>[0-9]|(?:[0-5][0-9]))(?<dec>\\.\\d{1,${numDecimals}})?)?)?)?$`,
      'i',
    ),
  );
  if (matches) {
    const msPerSecond = 1000;

    const { groups: { year, month, day, doy, time = '00:00:00', hour = '0', min = '0', sec = '0', dec = '.0' } = {} } =
      matches;

    const partialReturn = {
      hour: parseInt(hour),
      min: parseInt(min),
      ms: parseFloat((parseFloat(dec) * msPerSecond).toFixed(numDecimals)),
      sec: parseInt(sec),
      time: time,
      year: parseInt(year),
    };

    if (doy !== undefined) {
      return {
        ...partialReturn,
        doy: parseInt(doy),
      };
    }

    return {
      ...partialReturn,
      day: parseInt(day),
      month: parseInt(month),
    };
  }

  return null;
}

/**
 * Returns a Postgres Interval duration in milliseconds.
 * If duration is null, undefined, or empty string then we just return 0.
 * @note This function assumes 24-hour days.
 */
export function getIntervalInMs(interval: string | null | undefined): number {
  if (interval !== null && interval !== undefined && interval !== '') {
    const parsedInterval = parseInterval(interval);
    const { days, hours, milliseconds, minutes, seconds } = parsedInterval;
    const daysInMs = days * 24 * 60 * 60 * 1000;
    const hoursInMs = hours * 60 * 60 * 1000;
    const minutesInMs = minutes * 60 * 1000;
    const secondsInMs = seconds * 1000;
    return daysInMs + hoursInMs + minutesInMs + secondsInMs + milliseconds;
  }
  return 0;
}

/**
 * Converts an ISO 8601 date-time with an offset or `Z` (e.g. a plan's `start_time`) to merlin's UTC day-of-year
 * timestamp, `YYYY-DDDTHH:MM:SS[.ffffff]`. Fractional seconds are kept to the microsecond, without passing through
 * `Date`'s millisecond precision. A day-of-year timestamp is returned as is.
 */
export function isoToDoyTimestamp(dateTime: string): string {
  if (/^\d{4}-\d{3}T/.test(dateTime)) {
    return dateTime;
  }

  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(dateTime);
  const date = match ? new Date(`${match[1]}${match[3] ?? 'Z'}`) : null;
  if (match == null || date == null || Number.isNaN(date.getTime())) {
    throw new Error(`Invalid date-time: ${dateTime}`);
  }

  const pad = (value: number, width = 2) => `${value}`.padStart(width, '0');
  const year = date.getUTCFullYear();
  const dayOfYear = (Date.UTC(year, date.getUTCMonth(), date.getUTCDate()) - Date.UTC(year, 0, 1)) / 86_400_000 + 1;
  const fraction = match[2] ? `.${match[2].slice(0, 6)}` : '';

  return `${year}-${pad(dayOfYear, 3)}T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(
    date.getUTCSeconds(),
  )}${fraction}`;
}

/** Converts a Postgres interval (e.g. a plan's `duration`) to microseconds. */
export function intervalToMicroseconds(interval: string): number {
  return Math.round(getIntervalInMs(interval) * 1000);
}

export function convertDateToDoy(dateString: string, numDecimals = 6): string | null {
  const parsedTime = parseDoyOrYmdTime(dateString, numDecimals);

  if (parsedTime) {
    if ((parsedTime as ParsedDoyString).doy) {
      return dateString;
    }

    const { year, month, day, time } = parsedTime as ParsedYmdString;
    return `${year}-${getDOY(new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)))}T${time}`;
  }

  return null;
}

export function convertDoyToYmd(doyString: string, numDecimals = 6, includeMsecs = true): string | null {
  const parsedDoy: ParsedDoyString = parseDoyOrYmdTime(doyString, numDecimals) as ParsedDoyString;

  if (parsedDoy !== null) {
    if (parsedDoy.doy !== undefined) {
      const date = new Date(parsedDoy.year, 0, parsedDoy.doy);
      const ymdString = `${[
        date.getFullYear(),
        padBefore(`${date.getUTCMonth() + 1}`, 2),
        padBefore(`${date.getUTCDate()}`, 2),
      ].join('-')}T${parsedDoy.time}`;
      if (includeMsecs) {
        return `${ymdString}Z`;
      }
      return `${ymdString.replace(/(\.\d+)/, '')}Z`;
    } else {
      // doyString is already in ymd format
      return `${doyString}Z`;
    }
  }

  return null;
}

export function getTimeDifference(dateString1: string, dateString2: string, numDecimals = 6): number | null {
  const dateString = convertDoyToYmd(dateString1, numDecimals, true);
  const nextDateString = convertDoyToYmd(dateString2, numDecimals, true);

  if (dateString && nextDateString) {
    const date = new Date(dateString);
    const nextDate = new Date(nextDateString);

    return Math.abs(date.getTime() * 1000 - nextDate.getTime() * 1000);
  }
  return null;
}
