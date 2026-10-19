import { DateTime, IANAZone } from 'luxon';
import { DomainError } from './errors.js';

declare const timeZoneBrand: unique symbol;
/** Validated IANA time zone name, e.g. `Europe/Berlin`. */
export type TimeZone = string & { readonly [timeZoneBrand]: true };

declare const localTimeBrand: unique symbol;
/** Wall-clock time of day without a date or zone, stored as minutes since midnight (0..1439). */
export type LocalTime = number & { readonly [localTimeBrand]: true };

export const parseTimeZone = (value: string): TimeZone => {
  // Only real IANA zones are accepted: fixed offsets like "+03:00" would silently ignore DST.
  if (!value.includes('/') && value !== 'UTC') {
    throw new DomainError('invalid_timezone', `"${value}" is not an IANA time zone (e.g. "Europe/Berlin")`);
  }
  if (!IANAZone.isValidZone(value)) {
    throw new DomainError('invalid_timezone', `Unknown time zone "${value}"`);
  }
  return value as TimeZone;
};

const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** Parses `HH:MM` (24h). */
export const parseLocalTime = (value: string): LocalTime => {
  const match = LOCAL_TIME_PATTERN.exec(value);
  if (!match) {
    throw new DomainError('invalid_local_time', `"${value}" is not a valid time, expected HH:MM (00:00-23:59)`);
  }
  return (Number(match[1]) * 60 + Number(match[2])) as LocalTime;
};

export const formatLocalTime = (time: LocalTime): string => {
  const hours = Math.floor(time / 60);
  const minutes = time % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

/**
 * Daily do-not-disturb window in the user's own time zone.
 * The window is half-open: [start, end). If `start > end` it wraps over midnight (22:00-08:00).
 */
export interface QuietHours {
  readonly start: LocalTime;
  readonly end: LocalTime;
  readonly timeZone: TimeZone;
}

export const createQuietHours = (input: { start: string; end: string; timeZone: string }): QuietHours => {
  const start = parseLocalTime(input.start);
  const end = parseLocalTime(input.end);
  if (start === end) {
    throw new DomainError(
      'invalid_quiet_hours',
      'Quiet hours start and end must differ (an empty or 24h window is ambiguous)',
    );
  }
  return { start, end, timeZone: parseTimeZone(input.timeZone) };
};

export const quietHoursEqual = (a: QuietHours | null, b: QuietHours | null): boolean =>
  a === b || (a !== null && b !== null && a.start === b.start && a.end === b.end && a.timeZone === b.timeZone);

/** Converts an absolute instant into the wall-clock time of day in the given zone (DST-aware). */
export const toLocalTime = (instant: Date, timeZone: TimeZone): LocalTime => {
  const local = DateTime.fromJSDate(instant, { zone: timeZone });
  return (local.hour * 60 + local.minute) as LocalTime;
};

export const isWithinQuietHours = (quietHours: QuietHours, instant: Date): boolean => {
  const now = toLocalTime(instant, quietHours.timeZone);
  const { start, end } = quietHours;
  return start < end ? now >= start && now < end : now >= start || now < end;
};
