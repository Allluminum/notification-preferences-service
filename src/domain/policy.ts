import { DomainError } from './errors.js';
import type { Channel, NotificationTarget, NotificationType } from './notification.js';
import type { Region } from './region.js';

/**
 * Global (platform-wide) deny rule. Each scope field narrows the rule; `null` means "any".
 * Example: `{ notificationType: 'marketing', channel: 'sms', region: 'EU' }` blocks marketing SMS in the EU.
 */
export interface GlobalPolicy {
  readonly id: string;
  readonly notificationType: NotificationType | null;
  readonly channel: Channel | null;
  readonly region: Region | null;
  /** Human-readable justification, e.g. a reference to a regulation. */
  readonly description: string;
  readonly createdAt: Date;
}

export interface PolicyScope {
  readonly notificationType: NotificationType | null;
  readonly channel: Channel | null;
  readonly region: Region | null;
}

/** A policy without any scope would block every notification on the platform — reject it as a likely mistake. */
export const validatePolicyScope = (scope: PolicyScope): PolicyScope => {
  if (scope.notificationType === null && scope.channel === null && scope.region === null) {
    throw new DomainError(
      'empty_policy_scope',
      'A global policy must restrict at least one of: notificationType, channel, region',
    );
  }
  return scope;
};

export const policyMatches = (policy: PolicyScope, target: NotificationTarget, region: Region): boolean =>
  (policy.notificationType === null || policy.notificationType === target.type) &&
  (policy.channel === null || policy.channel === target.channel) &&
  (policy.region === null || policy.region === region);
