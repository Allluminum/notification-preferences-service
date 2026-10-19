import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { createApp } from '../../src/app.js';
import { MIGRATIONS_DIR } from '../../src/infrastructure/db/migrate.js';
import { createPool, type DbPool } from '../../src/infrastructure/db/pool.js';
import { PrometheusMetrics } from '../../src/infrastructure/observability/metrics.js';
import { TEST_DATABASE_URL } from './env.js';

export interface TestContext {
  readonly app: FastifyInstance;
  readonly pool: DbPool;
  /** Structured log lines emitted by the app (for observability assertions). */
  readonly logs: Record<string, unknown>[];
  close(): Promise<void>;
}

export const createTestContext = async (): Promise<TestContext> => {
  const pool = createPool(TEST_DATABASE_URL, 5);
  const logs: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        logs.push(JSON.parse(line) as Record<string, unknown>);
      }
      callback();
    },
  });
  const app = createApp({
    pool,
    logger: { level: 'info', stream },
    metrics: new PrometheusMetrics({ collectDefaults: false }),
  });
  await app.ready();
  return {
    app,
    pool,
    logs,
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
};

/** Wipes all data and re-applies the initial configuration (default preferences + EU marketing SMS policy). */
export const resetDatabase = async (pool: DbPool): Promise<void> => {
  await pool.query(
    'TRUNCATE user_channel_preferences, user_profiles, idempotency_keys, global_policies, default_preferences',
  );
  await pool.query(await readFile(join(MIGRATIONS_DIR, '002_initial_configuration.sql'), 'utf8'));
};
