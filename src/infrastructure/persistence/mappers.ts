import {
  isChannel,
  isNotificationType,
  isRegion,
  type Channel,
  type GlobalPolicy,
  type LocalTime,
  type NotificationTarget,
  type NotificationType,
  type QuietHours,
  type Region,
  type TimeZone,
} from '../../domain/index.js';

/**
 * Row → domain mapping. Rows referring to values the code no longer knows
 * (e.g. a removed channel) are skipped rather than crashing every request.
 */
export const toTarget = (row: { notification_type: string; channel: string }): NotificationTarget | null =>
  isNotificationType(row.notification_type) && isChannel(row.channel)
    ? { type: row.notification_type, channel: row.channel }
    : null;

/** Postgres `time` is returned as `HH:MM:SS`. */
const timeToLocal = (value: string): LocalTime => {
  const [hours = '0', minutes = '0'] = value.split(':');
  return (Number(hours) * 60 + Number(minutes)) as LocalTime;
};

export const localToTime = (value: LocalTime): string =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}:00`;

export interface QuietHoursColumns {
  quiet_hours_start: string | null;
  quiet_hours_end: string | null;
  quiet_hours_timezone: string | null;
}

export const toQuietHours = (row: QuietHoursColumns): QuietHours | null =>
  row.quiet_hours_start !== null && row.quiet_hours_end !== null && row.quiet_hours_timezone !== null
    ? {
        start: timeToLocal(row.quiet_hours_start),
        end: timeToLocal(row.quiet_hours_end),
        // Validated on write; the DB is trusted here.
        timeZone: row.quiet_hours_timezone as TimeZone,
      }
    : null;

export interface PolicyRow {
  id: string;
  notification_type: string | null;
  channel: string | null;
  region: string | null;
  description: string;
  created_at: Date;
}

export const toPolicy = (row: PolicyRow): GlobalPolicy | null => {
  const known =
    (row.notification_type === null || isNotificationType(row.notification_type)) &&
    (row.channel === null || isChannel(row.channel)) &&
    (row.region === null || isRegion(row.region));
  if (!known) return null;
  return {
    id: row.id,
    notificationType: row.notification_type as NotificationType | null,
    channel: row.channel as Channel | null,
    region: row.region as Region | null,
    description: row.description,
    createdAt: row.created_at,
  };
};

export const notNull = <T>(value: T | null): value is T => value !== null;
