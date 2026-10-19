import { NOTIFICATION_TYPE_TRAITS, targetKey, type NotificationTarget } from './notification.js';
import { policyMatches, type GlobalPolicy } from './policy.js';
import { getChannelPreference, type UserPreferences } from './preferences.js';
import type { Region } from './region.js';
import { formatLocalTime, isWithinQuietHours } from './time.js';
import type { UserId } from './user.js';

export type Decision = 'allow' | 'deny';

export type DenyReason = 'blocked_by_global_policy' | 'disabled_by_user' | 'disabled_by_default' | 'quiet_hours';
export type AllowReason = 'mandatory_notification' | 'enabled_by_user' | 'enabled_by_default';

export type EvaluationResult =
  | {
      readonly decision: 'deny';
      readonly reason: DenyReason;
      readonly message: string;
      /** Set when the decision was made by a global policy. */
      readonly policyId?: string;
    }
  | { readonly decision: 'allow'; readonly reason: AllowReason; readonly message: string };

export interface EvaluationRequest {
  readonly userId: UserId;
  readonly target: NotificationTarget;
  readonly region: Region;
  /** The moment the notification is going to be delivered. */
  readonly at: Date;
}

/**
 * Decides whether a notification may be sent. Pure function; rules are applied in priority order:
 *
 * 1. Global policies — compliance rules override everything, including mandatory types.
 * 2. Mandatory types (e.g. security) — always allowed, ignore user settings and quiet hours.
 * 3. User preference for (type × channel) — explicit choice or default snapshot.
 * 4. Quiet hours — only for types that respect them (e.g. marketing), in the user's time zone.
 *
 * The first matching rule wins, so the reason always names the strongest cause of the decision.
 */
export const evaluate = (
  request: EvaluationRequest,
  preferences: UserPreferences,
  policies: readonly GlobalPolicy[],
): EvaluationResult => {
  const { target, region, at } = request;
  const key = targetKey(target);

  const policy = policies.find((p) => policyMatches(p, target, region));
  if (policy) {
    return {
      decision: 'deny',
      reason: 'blocked_by_global_policy',
      message: `"${key}" is blocked in region ${region} by global policy: ${policy.description}`,
      policyId: policy.id,
    };
  }

  const traits = NOTIFICATION_TYPE_TRAITS[target.type];
  if (!traits.userConfigurable) {
    return {
      decision: 'allow',
      reason: 'mandatory_notification',
      message: `"${target.type}" notifications are mandatory and always delivered`,
    };
  }

  const preference = getChannelPreference(preferences, target);
  if (!preference.enabled) {
    return preference.source === 'user'
      ? { decision: 'deny', reason: 'disabled_by_user', message: `User has disabled "${key}"` }
      : { decision: 'deny', reason: 'disabled_by_default', message: `"${key}" is disabled by default settings` };
  }

  const { quietHours } = preferences;
  if (traits.respectsQuietHours && quietHours && isWithinQuietHours(quietHours, at)) {
    return {
      decision: 'deny',
      reason: 'quiet_hours',
      message:
        `Within user's quiet hours ${formatLocalTime(quietHours.start)}-${formatLocalTime(quietHours.end)} ` +
        `(${quietHours.timeZone})`,
    };
  }

  return preference.source === 'user'
    ? { decision: 'allow', reason: 'enabled_by_user', message: `User has enabled "${key}"` }
    : { decision: 'allow', reason: 'enabled_by_default', message: `"${key}" is enabled by default settings` };
};
