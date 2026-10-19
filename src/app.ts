import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { AdminService } from './application/admin-service.js';
import { EvaluationService } from './application/evaluation-service.js';
import { PreferencesService } from './application/preferences-service.js';
import type { DbPool } from './infrastructure/db/pool.js';
import { PrometheusMetrics } from './infrastructure/observability/metrics.js';
import { ContextualLogger } from './infrastructure/observability/request-logger.js';
import {
  PgDefaultPreferencesRepository,
  PgPolicyRepository,
  PgUnitOfWork,
  PgUserPreferencesReader,
} from './infrastructure/persistence/pg-repositories.js';
import { registerErrorHandler } from './http/error-handler.js';
import { adminRoutes } from './http/routes/admin.js';
import { evaluationRoutes } from './http/routes/evaluation.js';
import { preferencesRoutes } from './http/routes/preferences.js';

export interface AppOptions {
  readonly pool: DbPool;
  readonly logger?: FastifyServerOptions['logger'];
  readonly metrics?: PrometheusMetrics;
  /** Injectable clock for `/evaluate` requests without an explicit datetime. */
  readonly now?: () => Date;
}

/** Composition root: wires infrastructure adapters into application services and HTTP routes. */
export const createApp = (options: AppOptions): FastifyInstance => {
  const app = Fastify({
    logger: options.logger ?? true,
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' && header.length > 0 && header.length <= 128 ? header : randomUUID();
    },
    requestIdHeader: false,
  });

  const { pool } = options;
  const metrics = options.metrics ?? new PrometheusMetrics();
  const logger = new ContextualLogger(app.log);
  app.addHook('onRequest', (request, _reply, done) => {
    logger.runWith(request.log, done);
  });

  const users = new PgUserPreferencesReader(pool);
  const defaults = new PgDefaultPreferencesRepository(pool);
  const policies = new PgPolicyRepository(pool);
  const unitOfWork = new PgUnitOfWork(pool);

  const preferencesService = new PreferencesService({ users, defaults, unitOfWork, logger, metrics });
  const evaluationService = new EvaluationService({ users, defaults, policies, logger, metrics });
  const adminService = new AdminService({ defaults, policies, logger });

  registerErrorHandler(app);
  app.addHook('onSend', async (request, reply) => {
    void reply.header('x-request-id', request.id);
  });

  app.get('/health/live', (_request, reply) => reply.send({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    }
  });
  app.get('/metrics', async (_request, reply) =>
    reply.type(metrics.registry.contentType).send(await metrics.registry.metrics()),
  );

  preferencesRoutes(app, preferencesService);
  evaluationRoutes(app, evaluationService, options.now);
  adminRoutes(app, adminService);

  return app;
};
