import { describe, expect, it } from 'vitest';
import type {
  DomainError} from '../../src/domain/index.js';
import {
  applyUpdate,
  createQuietHours,
  getChannelPreference,
  resolvePreferences,
  targetKey,
  type StoredUserPreferences,
} from '../../src/domain/index.js';
import { DEFAULTS, USER, newUser, target } from './fixtures.js';

const marketingEmail = target('marketing', 'email');
const transactionalEmail = target('transactional', 'email');

describe('resolvePreferences — defaults for a new user', () => {
  it('gives an unknown user the current defaults with version 0', () => {
    const prefs = newUser();
    expect(prefs.version).toBe(0);
    expect(prefs.quietHours).toBeNull();
    expect(getChannelPreference(prefs, transactionalEmail)).toMatchObject({ enabled: true, source: 'default' });
    expect(getChannelPreference(prefs, marketingEmail)).toMatchObject({ enabled: false, source: 'default' });
  });

  it('always contains the full type × channel matrix', () => {
    expect(newUser().channels.size).toBe(12);
  });

  it('marks non-configurable (security) notifications as mandatory and enabled', () => {
    expect(getChannelPreference(newUser([]), target('security', 'sms'))).toMatchObject({
      enabled: true,
      source: 'mandatory',
    });
  });

  it('keeps the stored snapshot when defaults change later', () => {
    const stored: StoredUserPreferences = {
      userId: USER,
      version: 1,
      channels: new Map([[targetKey(marketingEmail), { enabled: false, source: 'default' as const }]]),
      quietHours: null,
    };
    const changedDefaults = DEFAULTS.map((d) =>
      targetKey(d.target) === 'marketing_email' ? { ...d, enabled: true } : d,
    );
    const prefs = resolvePreferences(USER, stored, changedDefaults);
    expect(getChannelPreference(prefs, marketingEmail).enabled).toBe(false);
    // Pairs absent from the snapshot fall back to the current defaults.
    expect(getChannelPreference(prefs, transactionalEmail).enabled).toBe(true);
  });

  it('fails closed for pairs without any default', () => {
    expect(getChannelPreference(newUser([]), transactionalEmail).enabled).toBe(false);
  });
});

describe('applyUpdate — user changes', () => {
  it('disables marketing email without touching transactional email', () => {
    const enabled = applyUpdate(newUser(), { channels: [{ target: marketingEmail, enabled: true }] }).preferences;
    const { preferences, changes } = applyUpdate(enabled, { channels: [{ target: marketingEmail, enabled: false }] });

    expect(getChannelPreference(preferences, marketingEmail)).toMatchObject({ enabled: false, source: 'user' });
    expect(getChannelPreference(preferences, transactionalEmail)).toMatchObject({ enabled: true, source: 'default' });
    expect(changes).toHaveLength(1);
    expect(preferences.version).toBe(2);
  });

  it('records an explicit choice equal to the default as a user decision', () => {
    const { preferences, changes } = applyUpdate(newUser(), { channels: [{ target: marketingEmail, enabled: false }] });
    expect(changes).toHaveLength(1);
    expect(getChannelPreference(preferences, marketingEmail)).toMatchObject({ enabled: false, source: 'user' });
  });

  it('sets and clears quiet hours', () => {
    const quietHours = createQuietHours({ start: '22:00', end: '08:00', timeZone: 'Europe/Berlin' });
    const withQuiet = applyUpdate(newUser(), { channels: [], quietHours }).preferences;
    expect(withQuiet.quietHours).toEqual(quietHours);

    const cleared = applyUpdate(withQuiet, { channels: [], quietHours: null }).preferences;
    expect(cleared.quietHours).toBeNull();
    expect(cleared.version).toBe(2);
  });

  it('leaves quiet hours untouched when the command omits them', () => {
    const quietHours = createQuietHours({ start: '22:00', end: '08:00', timeZone: 'UTC' });
    const withQuiet = applyUpdate(newUser(), { channels: [], quietHours }).preferences;
    const next = applyUpdate(withQuiet, { channels: [{ target: marketingEmail, enabled: true }] }).preferences;
    expect(next.quietHours).toEqual(quietHours);
  });

  it('rejects changes of mandatory notification types', () => {
    expect(() => applyUpdate(newUser(), { channels: [{ target: target('security', 'email'), enabled: false }] })).toThrow(
      expect.objectContaining({ code: 'notification_type_not_configurable' }) as DomainError,
    );
  });

  it('rejects contradictory values for the same pair in one command', () => {
    expect(() =>
      applyUpdate(newUser(), {
        channels: [
          { target: marketingEmail, enabled: true },
          { target: marketingEmail, enabled: false },
        ],
      }),
    ).toThrow(expect.objectContaining({ code: 'conflicting_changes' }) as DomainError);
  });
});

describe('applyUpdate — idempotency', () => {
  const command = {
    channels: [{ target: marketingEmail, enabled: false }],
    quietHours: createQuietHours({ start: '22:00', end: '08:00', timeZone: 'Europe/Berlin' }),
  };

  it('applying the same command twice equals applying it once', () => {
    const once = applyUpdate(newUser(), command);
    const twice = applyUpdate(once.preferences, command);

    expect(twice.changes).toEqual([]);
    expect(twice.preferences).toBe(once.preferences);
    expect(twice.preferences.version).toBe(1);
  });

  it('ignores duplicate entries with the same value', () => {
    const { changes } = applyUpdate(newUser(), {
      channels: [
        { target: marketingEmail, enabled: true },
        { target: marketingEmail, enabled: true },
      ],
    });
    expect(changes).toHaveLength(1);
  });
});
