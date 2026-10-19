import { describe, expect, it } from 'vitest';
import {
  applyUpdate,
  createQuietHours,
  evaluate,
  validatePolicyScope,
  type EvaluationRequest,
  type NotificationTarget,
  type Region,
  type UserPreferences,
} from '../../src/domain/index.js';
import { USER, newUser, policy, target } from './fixtures.js';

const request = (
  notification: NotificationTarget,
  { region = 'US', at = '2026-05-21T12:00:00Z' }: { region?: Region; at?: string } = {},
): EvaluationRequest => ({ userId: USER, target: notification, region, at: new Date(at) });

const withChanges = (prefs: UserPreferences, changes: [NotificationTarget, boolean][]): UserPreferences =>
  applyUpdate(prefs, { channels: changes.map(([t, enabled]) => ({ target: t, enabled })) }).preferences;

const quiet = createQuietHours({ start: '22:00', end: '08:00', timeZone: 'Europe/Berlin' });
const NIGHT_IN_BERLIN = '2026-05-21T21:30:00Z'; // 23:30 CEST
const DAY_IN_BERLIN = '2026-05-21T10:00:00Z'; // 12:00 CEST

describe('evaluate — defaults', () => {
  it('allows transactional email and denies marketing email for a new user', () => {
    expect(evaluate(request(target('transactional', 'email')), newUser(), [])).toMatchObject({
      decision: 'allow',
      reason: 'enabled_by_default',
    });
    expect(evaluate(request(target('marketing', 'email')), newUser(), [])).toMatchObject({
      decision: 'deny',
      reason: 'disabled_by_default',
    });
  });
});

describe('evaluate — user preferences', () => {
  it('reports explicit user choices', () => {
    const prefs = withChanges(newUser(), [
      [target('marketing', 'email'), false],
      [target('marketing', 'push'), true],
    ]);
    expect(evaluate(request(target('marketing', 'email')), prefs, [])).toMatchObject({
      decision: 'deny',
      reason: 'disabled_by_user',
    });
    expect(evaluate(request(target('marketing', 'push')), prefs, [])).toMatchObject({
      decision: 'allow',
      reason: 'enabled_by_user',
    });
  });

  it('always allows mandatory security notifications', () => {
    expect(evaluate(request(target('security', 'sms')), newUser([]), [])).toMatchObject({
      decision: 'allow',
      reason: 'mandatory_notification',
    });
  });
});

describe('evaluate — quiet hours', () => {
  const prefs = applyUpdate(newUser(), {
    channels: [{ target: target('marketing', 'push'), enabled: true }],
    quietHours: quiet,
  }).preferences;

  it('blocks marketing push during quiet hours in the user time zone', () => {
    expect(evaluate(request(target('marketing', 'push'), { at: NIGHT_IN_BERLIN }), prefs, [])).toMatchObject({
      decision: 'deny',
      reason: 'quiet_hours',
    });
  });

  it('allows marketing push outside quiet hours', () => {
    expect(evaluate(request(target('marketing', 'push'), { at: DAY_IN_BERLIN }), prefs, [])).toMatchObject({
      decision: 'allow',
    });
  });

  it('does not apply quiet hours to transactional and security notifications', () => {
    for (const t of [target('transactional', 'push'), target('security', 'push')]) {
      expect(evaluate(request(t, { at: NIGHT_IN_BERLIN }), prefs, []).decision).toBe('allow');
    }
  });

  it('reports a disabled channel rather than quiet hours when both apply', () => {
    expect(evaluate(request(target('marketing', 'email'), { at: NIGHT_IN_BERLIN }), prefs, [])).toMatchObject({
      reason: 'disabled_by_default',
    });
  });
});

describe('evaluate — global policies', () => {
  const prefs = withChanges(newUser(), [[target('marketing', 'sms'), true]]);

  it('blocks marketing SMS in the EU even if the user opted in', () => {
    expect(evaluate(request(target('marketing', 'sms'), { region: 'EU' }), prefs, [policy()])).toEqual({
      decision: 'deny',
      reason: 'blocked_by_global_policy',
      message: expect.stringContaining('No marketing SMS in the EU') as string,
      policyId: 'policy-1',
    });
  });

  it('does not affect other regions, channels or types', () => {
    const policies = [policy()];
    expect(evaluate(request(target('marketing', 'sms'), { region: 'US' }), prefs, policies).decision).toBe('allow');
    expect(evaluate(request(target('transactional', 'sms'), { region: 'EU' }), prefs, policies).decision).toBe('allow');
  });

  it('treats empty scope fields as wildcards', () => {
    const allSmsInRu = policy({ notificationType: null, channel: 'sms', region: 'RU' });
    expect(evaluate(request(target('transactional', 'sms'), { region: 'RU' }), prefs, [allSmsInRu]).reason).toBe(
      'blocked_by_global_policy',
    );
  });

  it('overrides even mandatory notifications', () => {
    const noSecuritySms = policy({ notificationType: 'security', channel: 'sms', region: null });
    expect(evaluate(request(target('security', 'sms')), prefs, [noSecuritySms]).reason).toBe('blocked_by_global_policy');
  });
});

describe('validatePolicyScope', () => {
  it('rejects a policy that would block everything', () => {
    expect(() => validatePolicyScope({ notificationType: null, channel: null, region: null })).toThrow(
      /at least one/,
    );
  });

  it('accepts a policy restricted by a single field', () => {
    const scope = { notificationType: null, channel: null, region: 'EU' as const };
    expect(validatePolicyScope(scope)).toBe(scope);
  });
});
