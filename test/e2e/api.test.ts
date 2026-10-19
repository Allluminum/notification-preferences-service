import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PreferencesDto } from '../../src/application/dto.js';
import { createTestContext, resetDatabase, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetDatabase(ctx.pool);
  ctx.logs.length = 0;
});

// --- small API client -------------------------------------------------------------------------

const getPreferences = async (userId: string) => {
  const res = await ctx.app.inject({ method: 'GET', url: `/users/${userId}/preferences` });
  expect(res.statusCode).toBe(200);
  return res.json<PreferencesDto>();
};

const updatePreferences = (userId: string, body: unknown, idempotencyKey?: string) =>
  ctx.app.inject({
    method: 'POST',
    url: `/users/${userId}/preferences`,
    payload: body as object,
    headers: idempotencyKey ? { 'idempotency-key': idempotencyKey } : {},
  });

const setChannels = async (userId: string, channels: Record<string, boolean>) => {
  const res = await updatePreferences(userId, {
    channels: Object.entries(channels).map(([notificationType, enabled]) => ({ notificationType, enabled })),
  });
  expect(res.statusCode).toBe(200);
  return res.json<PreferencesDto>();
};

interface EvaluationResponse {
  decision: 'allow' | 'deny';
  reason: string;
  message: string;
  policyId?: string;
}

const evaluate = async (body: {
  userId: string;
  notificationType: string;
  channel?: string;
  region?: string;
  datetime?: string;
}) => {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/evaluate',
    payload: { region: 'US', datetime: '2026-05-21T12:00:00Z', ...body },
  });
  expect(res.statusCode).toBe(200);
  return res.json<EvaluationResponse>();
};

// --- scenarios from the specification ---------------------------------------------------------

describe('Scenario 1: new user gets default preferences', () => {
  it('returns defaults for a user the service has never seen (without persisting anything)', async () => {
    const prefs = await getPreferences('new-user');

    expect(prefs.version).toBe(0);
    expect(prefs.channels.transactional.email).toEqual({ enabled: true, source: 'default' });
    expect(prefs.channels.marketing.email).toEqual({ enabled: false, source: 'default' });
    expect(prefs.channels.security.email).toEqual({ enabled: true, source: 'mandatory' });
    expect(prefs.quietHours).toBeNull();

    const { rowCount } = await ctx.pool.query('SELECT 1 FROM user_profiles');
    expect(rowCount).toBe(0);
  });

  it('applies defaults when evaluating', async () => {
    expect(await evaluate({ userId: 'new-user', notificationType: 'transactional_email', channel: 'email' })).toMatchObject(
      { decision: 'allow', reason: 'enabled_by_default' },
    );
    expect(await evaluate({ userId: 'new-user', notificationType: 'marketing_email', channel: 'email' })).toMatchObject({
      decision: 'deny',
      reason: 'disabled_by_default',
    });
  });

  it('registers a user idempotently, freezing the current defaults', async () => {
    const first = await ctx.app.inject({ method: 'PUT', url: '/users/user-1' });
    expect(first.statusCode).toBe(201);
    expect(first.json<PreferencesDto>().version).toBe(1);

    const second = await ctx.app.inject({ method: 'PUT', url: '/users/user-1' });
    expect(second.statusCode).toBe(200);
    expect(second.json<PreferencesDto>()).toEqual(first.json());
  });

  it('changing defaults affects new users only', async () => {
    await ctx.app.inject({ method: 'PUT', url: '/users/existing' });

    const res = await ctx.app.inject({
      method: 'PUT',
      url: '/default-preferences',
      payload: { defaults: [{ notificationType: 'marketing_email', enabled: true }] },
    });
    expect(res.statusCode).toBe(200);

    expect((await getPreferences('existing')).channels.marketing.email.enabled).toBe(false);
    expect((await getPreferences('brand-new')).channels.marketing.email.enabled).toBe(true);
  });
});

describe('Scenario 2: user changes preferences', () => {
  it('disabling marketing email is reflected in preferences; transactional email stays allowed', async () => {
    await setChannels('user-1', { marketing_email: true });
    const updated = await setChannels('user-1', { marketing_email: false });

    expect(updated.channels.marketing.email).toEqual({ enabled: false, source: 'user' });
    expect(updated.channels.transactional.email).toEqual({ enabled: true, source: 'default' });
    expect(await getPreferences('user-1')).toEqual(updated);

    expect(await evaluate({ userId: 'user-1', notificationType: 'marketing_email' })).toMatchObject({
      decision: 'deny',
      reason: 'disabled_by_user',
    });
    expect(await evaluate({ userId: 'user-1', notificationType: 'transactional_email' })).toMatchObject({
      decision: 'allow',
    });
  });

  it('accepts both "marketing" + channel and the compound "marketing_push" forms', async () => {
    const res = await updatePreferences('user-1', {
      channels: [
        { notificationType: 'marketing', channel: 'email', enabled: true },
        { notificationType: 'marketing_push', enabled: true },
      ],
    });
    expect(res.statusCode).toBe(200);
    const prefs = res.json<PreferencesDto>();
    expect(prefs.channels.marketing.email.enabled).toBe(true);
    expect(prefs.channels.marketing.push.enabled).toBe(true);
  });

  it('lets the user opt out of transactional notifications on a channel', async () => {
    await setChannels('user-1', { transactional_sms: false });
    expect(await evaluate({ userId: 'user-1', notificationType: 'transactional', channel: 'sms' })).toMatchObject({
      decision: 'deny',
      reason: 'disabled_by_user',
    });
  });

  it('does not allow disabling mandatory security notifications', async () => {
    const res = await updatePreferences('user-1', { channels: [{ notificationType: 'security_email', enabled: false }] });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ error: 'notification_type_not_configurable' });
  });

  it('is atomic: an invalid item rejects the whole request', async () => {
    const res = await updatePreferences('user-1', {
      channels: [
        { notificationType: 'marketing_email', enabled: true },
        { notificationType: 'marketing', channel: 'fax', enabled: true },
      ],
    });
    expect(res.statusCode).toBe(400);
    expect((await getPreferences('user-1')).channels.marketing.email.enabled).toBe(false);
  });
});

describe('Scenario 3: quiet hours', () => {
  const NIGHT_IN_MOSCOW = '2026-05-21T21:30:00Z'; // 00:30 MSK
  const DAY_IN_MOSCOW = '2026-05-21T09:00:00Z'; // 12:00 MSK

  beforeEach(async () => {
    const res = await updatePreferences('user-1', {
      channels: [{ notificationType: 'marketing_push', enabled: true }],
      quietHours: { start: '22:00', end: '08:00', timezone: 'Europe/Moscow' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<PreferencesDto>().quietHours).toEqual({ start: '22:00', end: '08:00', timezone: 'Europe/Moscow' });
  });

  it('blocks marketing push during quiet hours in the user time zone', async () => {
    expect(
      await evaluate({ userId: 'user-1', notificationType: 'marketing_push', channel: 'push', datetime: NIGHT_IN_MOSCOW }),
    ).toMatchObject({ decision: 'deny', reason: 'quiet_hours' });
  });

  it('respects the offset of the requested datetime', async () => {
    // 01:30+03:00 is the same instant as 22:30Z the day before: inside quiet hours.
    expect(
      await evaluate({ userId: 'user-1', notificationType: 'marketing_push', datetime: '2026-05-22T01:30:00+03:00' }),
    ).toMatchObject({ reason: 'quiet_hours' });
  });

  it('allows marketing push outside quiet hours', async () => {
    expect(
      await evaluate({ userId: 'user-1', notificationType: 'marketing_push', datetime: DAY_IN_MOSCOW }),
    ).toMatchObject({ decision: 'allow', reason: 'enabled_by_user' });
  });

  it('keeps transactional notifications allowed during quiet hours', async () => {
    expect(
      await evaluate({ userId: 'user-1', notificationType: 'transactional_push', datetime: NIGHT_IN_MOSCOW }),
    ).toMatchObject({ decision: 'allow' });
  });

  it('can be turned off with null', async () => {
    const res = await updatePreferences('user-1', { quietHours: null });
    expect(res.json<PreferencesDto>().quietHours).toBeNull();
    expect(
      await evaluate({ userId: 'user-1', notificationType: 'marketing_push', datetime: NIGHT_IN_MOSCOW }),
    ).toMatchObject({ decision: 'allow' });
  });

  it('rejects invalid time zones and times', async () => {
    const badZone = await updatePreferences('user-1', { quietHours: { start: '22:00', end: '08:00', timezone: 'Moon/Base' } });
    expect(badZone.statusCode).toBe(400);
    expect(badZone.json()).toMatchObject({ error: 'invalid_timezone' });

    const badTime = await updatePreferences('user-1', { quietHours: { start: '25:00', end: '08:00', timezone: 'UTC' } });
    expect(badTime.statusCode).toBe(400);
    expect(badTime.json()).toMatchObject({ error: 'invalid_local_time' });
  });
});

describe('Scenario 4: global policies', () => {
  beforeEach(async () => {
    await setChannels('user-1', { marketing_sms: true, marketing_email: true });
  });

  it('blocks marketing SMS in the EU (seeded policy) despite the user opt-in', async () => {
    const result = await evaluate({ userId: 'user-1', notificationType: 'marketing_sms', channel: 'sms', region: 'EU' });
    expect(result).toMatchObject({ decision: 'deny', reason: 'blocked_by_global_policy' });
    expect(result.policyId).toBeDefined();
  });

  it('does not block the same notification in other regions', async () => {
    expect(await evaluate({ userId: 'user-1', notificationType: 'marketing_sms', region: 'US' })).toMatchObject({
      decision: 'allow',
    });
  });

  it('supports managing policies through the API', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/policies',
      payload: { notificationType: 'marketing', region: 'UK', description: 'Marketing freeze' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    expect(await evaluate({ userId: 'user-1', notificationType: 'marketing_email', region: 'UK' })).toMatchObject({
      decision: 'deny',
      reason: 'blocked_by_global_policy',
      policyId: id,
    });

    const listed = await ctx.app.inject({ method: 'GET', url: '/policies' });
    expect(listed.json<{ id: string }[]>().map((p) => p.id)).toContain(id);

    expect((await ctx.app.inject({ method: 'DELETE', url: `/policies/${id}` })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/policies/${id}` })).statusCode).toBe(404);
    expect(await evaluate({ userId: 'user-1', notificationType: 'marketing_email', region: 'UK' })).toMatchObject({
      decision: 'allow',
    });
  });

  it('rejects a policy without any scope', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/policies', payload: { description: 'block everything' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'empty_policy_scope' });
  });
});

describe('Scenario 5: idempotency', () => {
  it('disabling marketing email twice gives the same result as once', async () => {
    await setChannels('user-1', { marketing_email: true });

    const first = await setChannels('user-1', { marketing_email: false });
    const second = await setChannels('user-1', { marketing_email: false });

    expect(second).toEqual(first);
    expect(second.version).toBe(2);
    expect(await getPreferences('user-1')).toEqual(first);
  });

  it('repeating a quiet hours command does not bump the version', async () => {
    const body = { quietHours: { start: '22:00', end: '08:00', timezone: 'Europe/Berlin' } };
    const first = (await updatePreferences('user-1', body)).json<PreferencesDto>();
    const second = (await updatePreferences('user-1', body)).json<PreferencesDto>();
    expect(second).toEqual(first);
    expect(second.version).toBe(1);
  });

  it('with Idempotency-Key, a late retry replays the original response and does not revert newer changes', async () => {
    const disable = { channels: [{ notificationType: 'marketing_email', enabled: false }] };
    const original = await updatePreferences('user-1', disable, 'req-1');
    expect(original.statusCode).toBe(200);

    await setChannels('user-1', { marketing_email: true }); // a newer change by the user

    const retry = await updatePreferences('user-1', disable, 'req-1');
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.json()).toEqual(original.json());
    expect((await getPreferences('user-1')).channels.marketing.email.enabled).toBe(true);
  });

  it('treats equivalent payload forms as the same request', async () => {
    await updatePreferences('user-1', { channels: [{ notificationType: 'marketing_email', enabled: true }] }, 'req-2');
    const retry = await updatePreferences(
      'user-1',
      { channels: [{ notificationType: 'marketing', channel: 'email', enabled: true }] },
      'req-2',
    );
    expect(retry.statusCode).toBe(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
  });

  it('rejects reuse of an Idempotency-Key with a different payload', async () => {
    await updatePreferences('user-1', { channels: [{ notificationType: 'marketing_email', enabled: true }] }, 'req-3');
    const conflict = await updatePreferences(
      'user-1',
      { channels: [{ notificationType: 'marketing_email', enabled: false }] },
      'req-3',
    );
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: 'idempotency_key_conflict' });
  });

  it('handles concurrent identical requests as a single change', async () => {
    const body = { channels: [{ notificationType: 'marketing_push', enabled: true }] };
    const responses = await Promise.all(Array.from({ length: 10 }, () => updatePreferences('race-user', body)));

    expect(responses.every((r) => r.statusCode === 200)).toBe(true);
    const prefs = await getPreferences('race-user');
    expect(prefs.version).toBe(1);
    expect(prefs.channels.marketing.push).toEqual({ enabled: true, source: 'user' });
  });
});

describe('Validation', () => {
  it.each([
    ['unknown channel', { userId: 'u', notificationType: 'marketing', channel: 'fax', region: 'EU' }, 'invalid_channel'],
    ['unknown type', { userId: 'u', notificationType: 'spam_email', region: 'EU' }, 'invalid_notification_type'],
    ['unknown region', { userId: 'u', notificationType: 'marketing_email', region: 'Mars' }, 'invalid_region'],
    ['type/channel mismatch', { userId: 'u', notificationType: 'marketing_sms', channel: 'email', region: 'EU' }, 'channel_mismatch'],
    ['datetime without offset', { userId: 'u', notificationType: 'marketing_email', region: 'EU', datetime: '2026-05-21T21:30:00' }, 'validation_error'],
    ['missing region', { userId: 'u', notificationType: 'marketing_email' }, 'validation_error'],
  ])('rejects /evaluate with %s', async (_name, payload, error) => {
    const res = await ctx.app.inject({ method: 'POST', url: '/evaluate', payload });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error });
  });

  it('rejects an empty update and unknown fields', async () => {
    expect((await updatePreferences('user-1', {})).statusCode).toBe(400);
    expect((await updatePreferences('user-1', { channels: [], foo: 1 })).statusCode).toBe(400);
  });

  it('rejects invalid user ids', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/users/%20bad%20/preferences' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'invalid_user_id' });
  });
});

describe('Observability', () => {
  it('logs preference changes and evaluation decisions as structured events', async () => {
    await setChannels('user-1', { marketing_email: true });
    await setChannels('user-1', { marketing_email: true });
    await evaluate({ userId: 'user-1', notificationType: 'marketing_sms', region: 'EU' });

    const events = ctx.logs.filter((l) => typeof l.event === 'string');
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'preferences_updated',
        userId: 'user-1',
        version: 1,
        changes: [
          {
            kind: 'channel',
            key: 'marketing_email',
            from: { enabled: false, source: 'default' },
            to: { enabled: true, source: 'user' },
          },
        ],
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ event: 'preferences_update_noop', userId: 'user-1' }));
    expect(events).toContainEqual(
      expect.objectContaining({
        event: 'notification_evaluated',
        notification: 'marketing_sms',
        region: 'EU',
        decision: 'deny',
        reason: 'blocked_by_global_policy',
      }),
    );
  });

  it('exposes Prometheus metrics and health checks', async () => {
    await evaluate({ userId: 'user-1', notificationType: 'transactional_email' });
    const metrics = await ctx.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('notification_evaluations_total{decision="allow",reason="enabled_by_default"}');

    expect((await ctx.app.inject({ method: 'GET', url: '/health/ready' })).json()).toEqual({ status: 'ok' });
  });
});
