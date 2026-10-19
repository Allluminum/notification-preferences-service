import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.url().default('postgres://postgres:postgres@localhost:5432/notification_preferences'),
  DATABASE_POOL_SIZE: z.coerce.number().int().min(1).default(10),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Run pending migrations on startup (convenient for local/docker runs). */
  MIGRATE_ON_START: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});

export type Config = z.infer<typeof EnvSchema>;

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
};
