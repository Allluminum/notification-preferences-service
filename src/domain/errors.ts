/**
 * Errors raised by domain rules. They carry a stable machine-readable `code`
 * which the HTTP layer maps to a status code; the domain itself knows nothing about HTTP.
 */
export type DomainErrorCode =
  | 'invalid_user_id'
  | 'invalid_notification_type'
  | 'invalid_channel'
  | 'channel_mismatch'
  | 'channel_required'
  | 'invalid_region'
  | 'invalid_timezone'
  | 'invalid_local_time'
  | 'invalid_quiet_hours'
  | 'conflicting_changes'
  | 'notification_type_not_configurable'
  | 'empty_policy_scope';

export class DomainError extends Error {
  override readonly name = 'DomainError';

  constructor(
    readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
  }
}
