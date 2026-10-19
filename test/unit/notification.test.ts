import { describe, expect, it } from 'vitest';
import {
  DomainError,
  parseNotificationScope,
  parseNotificationTarget,
  parseRegion,
  parseUserId,
} from '../../src/domain/index.js';

const errorCode = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.code;
    throw error;
  }
  return undefined;
};

describe('parseNotificationTarget', () => {
  it('accepts a plain type with an explicit channel', () => {
    expect(parseNotificationTarget({ notificationType: 'marketing', channel: 'email' })).toEqual({
      type: 'marketing',
      channel: 'email',
    });
  });

  it('accepts the compound form and derives the channel', () => {
    expect(parseNotificationTarget({ notificationType: 'marketing_sms' })).toEqual({ type: 'marketing', channel: 'sms' });
  });

  it('accepts the compound form with a matching channel (as in the /evaluate example)', () => {
    expect(parseNotificationTarget({ notificationType: 'transactional_email', channel: 'email' })).toEqual({
      type: 'transactional',
      channel: 'email',
    });
  });

  it('rejects a compound type that contradicts the channel', () => {
    expect(errorCode(() => parseNotificationTarget({ notificationType: 'marketing_sms', channel: 'email' }))).toBe(
      'channel_mismatch',
    );
  });

  it('requires a channel for a plain type', () => {
    expect(errorCode(() => parseNotificationTarget({ notificationType: 'marketing' }))).toBe('channel_required');
  });

  it('rejects unknown types and channels', () => {
    expect(errorCode(() => parseNotificationTarget({ notificationType: 'promo_email' }))).toBe(
      'invalid_notification_type',
    );
    expect(errorCode(() => parseNotificationTarget({ notificationType: 'marketing', channel: 'fax' }))).toBe(
      'invalid_channel',
    );
  });
});

describe('parseNotificationScope', () => {
  it('allows partial scopes for global policies', () => {
    expect(parseNotificationScope({ channel: 'sms' })).toEqual({ type: null, channel: 'sms' });
    expect(parseNotificationScope({ notificationType: 'marketing' })).toEqual({ type: 'marketing', channel: null });
    expect(parseNotificationScope({})).toEqual({ type: null, channel: null });
  });
});

describe('parseRegion / parseUserId', () => {
  it('normalizes region case and rejects unknown regions', () => {
    expect(parseRegion('eu')).toBe('EU');
    expect(errorCode(() => parseRegion('Mars'))).toBe('invalid_region');
  });

  it('validates user ids', () => {
    expect(parseUserId('user-1')).toBe('user-1');
    expect(errorCode(() => parseUserId(''))).toBe('invalid_user_id');
    expect(errorCode(() => parseUserId('a b'))).toBe('invalid_user_id');
  });
});
