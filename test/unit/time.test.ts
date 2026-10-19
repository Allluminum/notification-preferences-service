import { describe, expect, it } from 'vitest';
import { DomainError, createQuietHours, formatLocalTime, isWithinQuietHours, parseLocalTime } from '../../src/domain/index.js';

const at = (iso: string) => new Date(iso);

describe('local time', () => {
  it('parses and formats HH:MM', () => {
    expect(formatLocalTime(parseLocalTime('08:05'))).toBe('08:05');
    expect(formatLocalTime(parseLocalTime('23:59'))).toBe('23:59');
  });

  it.each(['24:00', '8:00', '12:60', 'noon', ''])('rejects "%s"', (value) => {
    expect(() => parseLocalTime(value)).toThrow(DomainError);
  });
});

describe('createQuietHours', () => {
  it('rejects unknown and non-IANA time zones', () => {
    expect(() => createQuietHours({ start: '22:00', end: '08:00', timeZone: 'Mars/Olympus' })).toThrow(/time zone/);
    expect(() => createQuietHours({ start: '22:00', end: '08:00', timeZone: '+03:00' })).toThrow(/IANA/);
  });

  it('rejects an empty window', () => {
    expect(() => createQuietHours({ start: '22:00', end: '22:00', timeZone: 'UTC' })).toThrow(DomainError);
  });
});

describe('isWithinQuietHours', () => {
  describe('window over midnight 22:00-08:00 in Europe/Moscow (UTC+3)', () => {
    const quietHours = createQuietHours({ start: '22:00', end: '08:00', timeZone: 'Europe/Moscow' });

    it.each([
      ['2026-05-21T19:00:00Z', true], // 22:00 local — start is inclusive
      ['2026-05-21T21:30:00Z', true], // 00:30 local
      ['2026-05-22T04:59:00Z', true], // 07:59 local
      ['2026-05-22T05:00:00Z', false], // 08:00 local — end is exclusive
      ['2026-05-21T18:59:00Z', false], // 21:59 local
      ['2026-05-21T12:00:00Z', false], // 15:00 local
    ])('%s → %s', (instant, expected) => {
      expect(isWithinQuietHours(quietHours, at(instant))).toBe(expected);
    });
  });

  it('supports windows inside a single day', () => {
    const quietHours = createQuietHours({ start: '13:00', end: '15:00', timeZone: 'UTC' });
    expect(isWithinQuietHours(quietHours, at('2026-05-21T14:00:00Z'))).toBe(true);
    expect(isWithinQuietHours(quietHours, at('2026-05-21T16:00:00Z'))).toBe(false);
  });

  it('evaluates the same instant differently depending on the user time zone', () => {
    const instant = at('2026-05-21T21:30:00Z');
    const berlin = createQuietHours({ start: '22:00', end: '08:00', timeZone: 'Europe/Berlin' }); // 23:30 local
    const newYork = createQuietHours({ start: '22:00', end: '08:00', timeZone: 'America/New_York' }); // 17:30 local
    expect(isWithinQuietHours(berlin, instant)).toBe(true);
    expect(isWithinQuietHours(newYork, instant)).toBe(false);
  });

  it('follows daylight saving time changes', () => {
    const quietHours = createQuietHours({ start: '22:00', end: '08:00', timeZone: 'Europe/Berlin' });
    // 06:30 UTC is 07:30 in winter (CET, UTC+1) — inside, but 08:30 in summer (CEST, UTC+2) — outside.
    expect(isWithinQuietHours(quietHours, at('2026-01-15T06:30:00Z'))).toBe(true);
    expect(isWithinQuietHours(quietHours, at('2026-07-15T06:30:00Z'))).toBe(false);
  });
});
