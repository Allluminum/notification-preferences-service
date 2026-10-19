import { z } from 'zod';
import {
  createQuietHours,
  parseNotificationScope,
  parseNotificationTarget,
  parseRegion,
  parseUserId,
  type DefaultPreference,
  type EvaluationRequest,
  type PolicyScope,
  type UpdatePreferencesCommand,
} from '../domain/index.js';

/*
 * Two-step input handling: zod checks the *shape* of the payload, then domain parsers
 * turn strings into domain types and enforce business invariants (known channel, valid zone, ...).
 */

/**
 * `notificationType` accepts a plain category (`marketing`) with a separate `channel`,
 * or the compound form (`marketing_email`) where `channel` may be omitted.
 */
const TargetShape = {
  notificationType: z.string().min(1).max(64),
  channel: z.string().min(1).max(32).optional(),
};

const QuietHoursSchema = z.strictObject({
  start: z.string().describe('HH:MM, local time'),
  end: z.string().describe('HH:MM, local time'),
  timezone: z.string().describe('IANA time zone, e.g. Europe/Berlin'),
});

export const UpdatePreferencesBody = z
  .strictObject({
    channels: z
      .array(z.strictObject({ ...TargetShape, enabled: z.boolean() }))
      .max(100)
      .default([]),
    /** Omit to keep as is, `null` to switch quiet hours off. */
    quietHours: QuietHoursSchema.nullable().optional(),
  })
  .refine((body) => body.channels.length > 0 || body.quietHours !== undefined, {
    message: 'Nothing to update: provide "channels" and/or "quietHours"',
  });

export const toUpdateCommand = (body: z.infer<typeof UpdatePreferencesBody>): UpdatePreferencesCommand => {
  const channels = body.channels.map(({ enabled, ...target }) => ({
    target: parseNotificationTarget(target),
    enabled,
  }));
  if (body.quietHours === undefined) return { channels };
  return {
    channels,
    quietHours: body.quietHours && createQuietHours({ ...body.quietHours, timeZone: body.quietHours.timezone }),
  };
};

export const EvaluateBody = z.strictObject({
  userId: z.string().min(1),
  ...TargetShape,
  region: z.string().min(1),
  /** ISO 8601 instant with an explicit offset; defaults to "now". */
  datetime: z.iso.datetime({ offset: true }).optional(),
});

export const toEvaluationRequest = (body: z.infer<typeof EvaluateBody>, now: () => Date): EvaluationRequest => ({
  userId: parseUserId(body.userId),
  target: parseNotificationTarget(body),
  region: parseRegion(body.region),
  at: body.datetime === undefined ? now() : new Date(body.datetime),
});

export const CreatePolicyBody = z.strictObject({
  notificationType: z.string().min(1).max(64).nullable().optional(),
  channel: z.string().min(1).max(32).nullable().optional(),
  region: z.string().min(1).nullable().optional(),
  description: z.string().trim().min(1).max(500),
});

export const toPolicyScope = (body: z.infer<typeof CreatePolicyBody>): PolicyScope => {
  const { type, channel } = parseNotificationScope(body);
  return { notificationType: type, channel, region: body.region == null ? null : parseRegion(body.region) };
};

export const UpdateDefaultsBody = z.strictObject({
  defaults: z
    .array(z.strictObject({ ...TargetShape, enabled: z.boolean() }))
    .min(1)
    .max(100),
});

export const toDefaultPreferences = (body: z.infer<typeof UpdateDefaultsBody>): DefaultPreference[] =>
  body.defaults.map(({ enabled, ...target }) => ({ target: parseNotificationTarget(target), enabled }));

export const UserParams = z.strictObject({ userId: z.string() });
export const PolicyParams = z.strictObject({ id: z.uuid() });

export const IdempotencyKeyHeader = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'Idempotency-Key must be printable ASCII without spaces')
  .optional();
