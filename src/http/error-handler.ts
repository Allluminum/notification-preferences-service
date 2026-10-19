import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, z } from 'zod';
import { IdempotencyKeyConflictError, NotFoundError } from '../application/errors.js';
import { DomainError, type DomainErrorCode } from '../domain/index.js';

/** Business-rule violations on a well-formed request → 422; malformed values → 400. */
const UNPROCESSABLE: ReadonlySet<DomainErrorCode> = new Set(['notification_type_not_configurable']);

export interface ErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

export const registerErrorHandler = (app: FastifyInstance): void => {
  app.setErrorHandler<FastifyError | Error>((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_error',
        message: z.prettifyError(error),
        details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      } satisfies ErrorBody);
    }
    if (error instanceof DomainError) {
      return reply
        .status(UNPROCESSABLE.has(error.code) ? 422 : 400)
        .send({ error: error.code, message: error.message } satisfies ErrorBody);
    }
    if (error instanceof NotFoundError) {
      return reply.status(404).send({ error: 'not_found', message: error.message } satisfies ErrorBody);
    }
    if (error instanceof IdempotencyKeyConflictError) {
      return reply
        .status(409)
        .send({ error: 'idempotency_key_conflict', message: error.message } satisfies ErrorBody);
    }
    // Errors produced by Fastify itself (malformed JSON, unsupported media type, ...).
    const statusCode = 'statusCode' in error ? error.statusCode : undefined;
    if (statusCode !== undefined && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({ error: 'bad_request', message: error.message } satisfies ErrorBody);
    }

    request.log.error({ err: error }, 'Unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Internal server error' } satisfies ErrorBody);
  });

  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send({ error: 'not_found', message: `Route ${request.method} ${request.url} not found` } satisfies ErrorBody),
  );
};
