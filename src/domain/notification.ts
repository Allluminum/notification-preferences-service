import { DomainError } from './errors.js';

/** Delivery channels supported by the platform. */
export const CHANNELS = ['email', 'sms', 'push', 'messenger'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Notification categories. A user preference is defined for a pair
 * (notification type × channel), e.g. `marketing` over `email`.
 */
export const NOTIFICATION_TYPES = ['transactional', 'marketing', 'security'] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

/** Business traits of a notification type. */
export interface NotificationTypeTraits {
  /** Whether the user may switch this type on/off. Non-configurable types are always enabled. */
  readonly userConfigurable: boolean;
  /** Whether delivery of this type is suppressed during the user's quiet hours. */
  readonly respectsQuietHours: boolean;
}

export const NOTIFICATION_TYPE_TRAITS: Readonly<Record<NotificationType, NotificationTypeTraits>> = {
  // Receipts, order status, password reset links etc. The user may opt out per channel,
  // but they are time-sensitive, so quiet hours do not apply.
  transactional: { userConfigurable: true, respectsQuietHours: false },
  // Promotions and newsletters: opt-in per channel and silenced during quiet hours.
  marketing: { userConfigurable: true, respectsQuietHours: true },
  // Login alerts, suspicious activity: cannot be disabled and ignore quiet hours.
  // Only a global policy can block them.
  security: { userConfigurable: false, respectsQuietHours: false },
};

/** A concrete "what and where": notification type delivered over a channel. */
export interface NotificationTarget {
  readonly type: NotificationType;
  readonly channel: Channel;
}

/** Compact identifier of a target, e.g. `marketing_email`. */
export type NotificationKey = `${NotificationType}_${Channel}`;

export const targetKey = (target: NotificationTarget): NotificationKey =>
  `${target.type}_${target.channel}`;

export const isChannel = (value: string): value is Channel =>
  (CHANNELS as readonly string[]).includes(value);

export const isNotificationType = (value: string): value is NotificationType =>
  (NOTIFICATION_TYPES as readonly string[]).includes(value);

/** Full matrix of all (type × channel) pairs in a stable order. */
export const ALL_TARGETS: readonly NotificationTarget[] = NOTIFICATION_TYPES.flatMap((type) =>
  CHANNELS.map((channel) => ({ type, channel })),
);

export const parseChannel = (value: string): Channel => {
  if (!isChannel(value)) {
    throw new DomainError(
      'invalid_channel',
      `Unknown channel "${value}". Expected one of: ${CHANNELS.join(', ')}`,
    );
  }
  return value;
};

/**
 * Splits a notification type that may be given either as a plain category
 * (`marketing`) or in compound form with a channel suffix (`marketing_email`).
 */
const splitNotificationType = (
  value: string,
): { type: NotificationType; channel: Channel | null } => {
  if (isNotificationType(value)) {
    return { type: value, channel: null };
  }
  for (const channel of CHANNELS) {
    const suffix = `_${channel}`;
    if (value.endsWith(suffix)) {
      const type = value.slice(0, -suffix.length);
      if (isNotificationType(type)) {
        return { type, channel };
      }
    }
  }
  throw new DomainError(
    'invalid_notification_type',
    `Unknown notification type "${value}". Expected one of: ${NOTIFICATION_TYPES.join(', ')} ` +
      `(optionally suffixed with a channel, e.g. "marketing_email")`,
  );
};

/**
 * Resolves a (possibly partial) notification scope. Both fields are optional:
 * used by global policies, where an absent field means "any".
 * If both a compound type and an explicit channel are given, they must agree.
 */
export const parseNotificationScope = (input: {
  notificationType?: string | null | undefined;
  channel?: string | null | undefined;
}): { type: NotificationType | null; channel: Channel | null } => {
  const explicitChannel = input.channel == null ? null : parseChannel(input.channel);
  if (input.notificationType == null) {
    return { type: null, channel: explicitChannel };
  }
  const { type, channel: impliedChannel } = splitNotificationType(input.notificationType);
  if (impliedChannel && explicitChannel && impliedChannel !== explicitChannel) {
    throw new DomainError(
      'channel_mismatch',
      `Notification type "${input.notificationType}" implies channel "${impliedChannel}", ` +
        `but channel "${explicitChannel}" was given`,
    );
  }
  return { type, channel: explicitChannel ?? impliedChannel };
};

/** Resolves a fully specified target: both the type and the channel must be determined. */
export const parseNotificationTarget = (input: {
  notificationType: string;
  channel?: string | null | undefined;
}): NotificationTarget => {
  const { type, channel } = parseNotificationScope(input);
  if (type === null) {
    // Unreachable: notificationType is required by the signature.
    throw new DomainError('invalid_notification_type', 'Notification type is required');
  }
  if (channel === null) {
    throw new DomainError(
      'channel_required',
      `Channel is required for notification type "${type}"`,
    );
  }
  return { type, channel };
};
