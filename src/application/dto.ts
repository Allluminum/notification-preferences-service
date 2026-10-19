import {
  CHANNELS,
  NOTIFICATION_TYPES,
  formatLocalTime,
  getChannelPreference,
  targetKey,
  type Channel,
  type NotificationType,
  type PreferenceChange,
  type PreferenceSource,
  type QuietHours,
  type UserPreferences,
} from '../domain/index.js';

/** Public representation of quiet hours. */
export interface QuietHoursDto {
  readonly start: string;
  readonly end: string;
  readonly timezone: string;
}

/** Public representation of user preferences (the API contract). */
export interface PreferencesDto {
  readonly userId: string;
  readonly version: number;
  readonly channels: Record<NotificationType, Record<Channel, { enabled: boolean; source: PreferenceSource }>>;
  readonly quietHours: QuietHoursDto | null;
}

export const toQuietHoursDto = (quietHours: QuietHours | null): QuietHoursDto | null =>
  quietHours && {
    start: formatLocalTime(quietHours.start),
    end: formatLocalTime(quietHours.end),
    timezone: quietHours.timeZone,
  };

export const toPreferencesDto = (preferences: UserPreferences): PreferencesDto => {
  const channels = Object.fromEntries(
    NOTIFICATION_TYPES.map((type) => [
      type,
      Object.fromEntries(
        CHANNELS.map((channel) => {
          const { enabled, source } = getChannelPreference(preferences, { type, channel });
          return [channel, { enabled, source }];
        }),
      ),
    ]),
  ) as PreferencesDto['channels'];

  return {
    userId: preferences.userId,
    version: preferences.version,
    channels,
    quietHours: toQuietHoursDto(preferences.quietHours),
  };
};

/** Flat, log-friendly description of a change. */
export const describeChange = (change: PreferenceChange): Record<string, unknown> =>
  change.kind === 'channel'
    ? { kind: change.kind, key: targetKey(change.target), from: change.from, to: change.to }
    : { kind: change.kind, from: toQuietHoursDto(change.from), to: toQuietHoursDto(change.to) };
