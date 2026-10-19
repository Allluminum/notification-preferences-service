import {
  parseUserId,
  resolvePreferences,
  type DefaultPreference,
  type GlobalPolicy,
  type NotificationTarget,
  type UserPreferences,
} from '../../src/domain/index.js';

export const target = (type: NotificationTarget['type'], channel: NotificationTarget['channel']): NotificationTarget => ({
  type,
  channel,
});

/** Same values as the initial configuration migration. */
export const DEFAULTS: DefaultPreference[] = [
  { target: target('transactional', 'email'), enabled: true },
  { target: target('transactional', 'sms'), enabled: true },
  { target: target('transactional', 'push'), enabled: true },
  { target: target('transactional', 'messenger'), enabled: false },
  { target: target('marketing', 'email'), enabled: false },
  { target: target('marketing', 'sms'), enabled: false },
  { target: target('marketing', 'push'), enabled: false },
  { target: target('marketing', 'messenger'), enabled: false },
];

export const USER = parseUserId('user-1');

export const newUser = (defaults: DefaultPreference[] = DEFAULTS): UserPreferences =>
  resolvePreferences(USER, null, defaults);

export const policy = (overrides: Partial<GlobalPolicy> = {}): GlobalPolicy => ({
  id: 'policy-1',
  notificationType: 'marketing',
  channel: 'sms',
  region: 'EU',
  description: 'No marketing SMS in the EU',
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...overrides,
});
