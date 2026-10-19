import type { FastifyInstance } from 'fastify';
import type { PreferencesService } from '../../application/preferences-service.js';
import { parseUserId } from '../../domain/index.js';
import { IdempotencyKeyHeader, UpdatePreferencesBody, UserParams, toUpdateCommand } from '../schemas.js';

export const preferencesRoutes = (app: FastifyInstance, service: PreferencesService): void => {
  /** Registers a user and freezes the current defaults as their preferences (idempotent). */
  app.put('/users/:userId', async (request, reply) => {
    const userId = parseUserId(UserParams.parse(request.params).userId);
    const { preferences, created } = await service.register(userId);
    return reply.status(created ? 201 : 200).send(preferences);
  });

  app.get('/users/:userId/preferences', async (request) => {
    const userId = parseUserId(UserParams.parse(request.params).userId);
    return service.get(userId);
  });

  /**
   * Declarative partial update: listed pairs are set to the given values, quiet hours are set/cleared.
   * Optional `Idempotency-Key` header makes retries replay the original response.
   */
  app.post('/users/:userId/preferences', async (request, reply) => {
    const userId = parseUserId(UserParams.parse(request.params).userId);
    const idempotencyKey = IdempotencyKeyHeader.parse(request.headers['idempotency-key']);
    const command = toUpdateCommand(UpdatePreferencesBody.parse(request.body));

    const result = await service.update(userId, command, idempotencyKey);
    if (result.replayed) void reply.header('Idempotent-Replayed', 'true');
    return reply.status(200).send(result.preferences);
  });
};
