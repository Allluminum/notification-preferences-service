/** Errors of the application layer (use-case level, not business rules). */
export class NotFoundError extends Error {
  override readonly name = 'NotFoundError';
}

export class IdempotencyKeyConflictError extends Error {
  override readonly name = 'IdempotencyKeyConflictError';

  constructor(readonly key: string) {
    super(`Idempotency key "${key}" was already used with a different request body`);
  }
}
