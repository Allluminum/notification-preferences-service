import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { migrate } from './infrastructure/db/migrate.js';
import { createPool } from './infrastructure/db/pool.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, config.DATABASE_POOL_SIZE);
const app = createApp({
  pool,
  logger: {
    level: config.LOG_LEVEL,
    ...(config.NODE_ENV === 'development' && process.stdout.isTTY
      ? { transport: { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss.l' } } }
      : {}),
  },
});

if (config.MIGRATE_ON_START) {
  const applied = await migrate(pool);
  app.log.info({ event: 'migrations_applied', applied }, applied.length ? 'Migrations applied' : 'Database is up to date');
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.HOST, port: config.PORT });
