import { DomainError } from './errors.js';
import {
  ALL_TARGETS,
  NOTIFICATION_TYPE_TRAITS,
  targetKey,
  type NotificationKey,
  type NotificationTarget,
} from './notification.js';
import { quietHoursEqual, type QuietHours } from './time.js';
import type { UserId } from './user.js';

/**
 * Where an effective preference value comes from:
 * - `default`   — snapshot of the default preferences taken when the user was created
 *                 (or the current defaults if the user has never been stored);
 * - `user`      — explicitly chosen by the user;
 * - `mandatory` — the notification type is not user-configurable and is always on.
 */
export type PreferenceSource = 'default' | 'user' | 'mandatory';

export interface ChannelPreference {
  readonly target: NotificationTarget;
  readonly enabled: boolean;
  readonly source: PreferenceSource;
}

/** Default value for one (type × channel) pair, applied to new users. */
export interface DefaultPreference {
  readonly target: NotificationTarget;
  readonly enabled: boolean;
}

/** Persisted state of a user. Only exists after the user has been created. */
export interface StoredUserPreferences {
  readonly userId: UserId;
  /** Monotonic version, incremented on every effective change. */
  readonly version: number;
  readonly channels: ReadonlyMap<NotificationKey, { enabled: boolean; source: 'default' | 'user' }>;
  readonly quietHours: QuietHours | null;
}

/** Fully resolved preferences: every (type × channel) pair has a value. */
export interface UserPreferences {
  readonly userId: UserId;
  /** 0 means the user is not stored yet and sees the current defaults. */
  readonly version: number;
  readonly channels: ReadonlyMap<NotificationKey, ChannelPreference>;
  readonly quietHours: QuietHours | null;
}

/**
 * Builds the effective preferences of a user.
 *
 * Defaults are *snapshotted* when a user is created, so changing defaults later affects only new users
 * (important for marketing consent: an existing user must not be silently opted in).
 * Pairs missing in the snapshot (e.g. a channel added after the user was created) fall back to the
 * current defaults; pairs missing everywhere are disabled (fail closed).
 */
export const resolvePreferences = (
  userId: UserId,
  stored: StoredUserPreferences | null,
  defaults: readonly DefaultPreference[],
): UserPreferences => {
  const defaultsByKey = new Map(defaults.map((d) => [targetKey(d.target), d.enabled]));
  const channels = new Map<NotificationKey, ChannelPreference>();

  for (const target of ALL_TARGETS) {
    const key = targetKey(target);
    if (!NOTIFICATION_TYPE_TRAITS[target.type].userConfigurable) {
      channels.set(key, { target, enabled: true, source: 'mandatory' });
      continue;
    }
    const own = stored?.channels.get(key);
    channels.set(
      key,
      own
        ? { target, enabled: own.enabled, source: own.source }
        : { target, enabled: defaultsByKey.get(key) ?? false, source: 'default' },
    );
  }

  return {
    userId,
    version: stored?.version ?? 0,
    channels,
    quietHours: stored?.quietHours ?? null,
  };
};

export const getChannelPreference = (
  preferences: UserPreferences,
  target: NotificationTarget,
): ChannelPreference => {
  const preference = preferences.channels.get(targetKey(target));
  if (!preference) {
    // resolvePreferences always fills the full matrix; this guards against a broken invariant.
    throw new Error(`Invariant violated: no preference for ${targetKey(target)}`);
  }
  return preference;
};

/** Declarative command: describes the desired state, not a delta, which makes it naturally idempotent. */
export interface UpdatePreferencesCommand {
  readonly channels: readonly { readonly target: NotificationTarget; readonly enabled: boolean }[];
  /** `undefined` — leave as is, `null` — turn quiet hours off, value — set. */
  readonly quietHours?: QuietHours | null;
}

export type PreferenceChange =
  | {
      readonly kind: 'channel';
      readonly target: NotificationTarget;
      readonly from: { enabled: boolean; source: PreferenceSource };
      readonly to: { enabled: boolean; source: PreferenceSource };
    }
  | { readonly kind: 'quiet_hours'; readonly from: QuietHours | null; readonly to: QuietHours | null };

export interface UpdateOutcome {
  readonly preferences: UserPreferences;
  /** Empty when the command did not change anything (e.g. it was applied before). */
  readonly changes: readonly PreferenceChange[];
}

/** Validates the command against business rules; throws DomainError on violation. */
export const validateUpdateCommand = (command: UpdatePreferencesCommand): void => {
  const requested = new Map<NotificationKey, boolean>();
  for (const { target, enabled } of command.channels) {
    if (!NOTIFICATION_TYPE_TRAITS[target.type].userConfigurable) {
      throw new DomainError(
        'notification_type_not_configurable',
        `Notification type "${target.type}" is mandatory and cannot be changed by the user`,
      );
    }
    const key = targetKey(target);
    const previous = requested.get(key);
    if (previous !== undefined && previous !== enabled) {
      throw new DomainError('conflicting_changes', `Conflicting values for "${key}" in one request`);
    }
    requested.set(key, enabled);
  }
};

/**
 * Applies a command to the current preferences. Pure function.
 *
 * Idempotency: applying the same command to its own result yields no changes,
 * and the version is incremented only when something actually changed.
 * An explicit choice equal to the default value is still recorded (source `default` → `user`):
 * it is the user's consent decision and must survive future changes of defaults.
 */
export const applyUpdate = (current: UserPreferences, command: UpdatePreferencesCommand): UpdateOutcome => {
  validateUpdateCommand(command);

  const channels = new Map(current.channels);
  const changes: PreferenceChange[] = [];

  for (const { target, enabled } of command.channels) {
    const key = targetKey(target);
    const before = getChannelPreference(current, target);
    if (before.enabled === enabled && before.source === 'user') {
      continue;
    }
    if (changes.some((c) => c.kind === 'channel' && targetKey(c.target) === key)) {
      continue; // duplicate entry with the same value
    }
    channels.set(key, { target, enabled, source: 'user' });
    changes.push({
      kind: 'channel',
      target,
      from: { enabled: before.enabled, source: before.source },
      to: { enabled, source: 'user' },
    });
  }

  let quietHours = current.quietHours;
  if (command.quietHours !== undefined && !quietHoursEqual(current.quietHours, command.quietHours)) {
    changes.push({ kind: 'quiet_hours', from: current.quietHours, to: command.quietHours });
    quietHours = command.quietHours;
  }

  if (changes.length === 0) {
    return { preferences: current, changes };
  }
  return {
    preferences: { ...current, channels, quietHours, version: current.version + 1 },
    changes,
  };
};
