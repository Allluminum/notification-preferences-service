import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DbPool } from './pool.js';

/** Repository-level `migrations/` directory; resolves the same from `src/` (tsx) and `dist/` (node). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

// Arbitrary constant: serializes concurrent migration runs (e.g. several replicas starting at once).
const MIGRATION_LOCK_ID = 4_242_001;

/**
 * Minimal forward-only migrator: applies `migrations/*.sql` in lexical order,
 * each file in its own transaction, and records applied files in `schema_migrations`.
 */
export const migrate = async (pool: DbPool, dir: string = MIGRATIONS_DIR): Promise<string[]> => {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ name: string }>('SELECT name FROM schema_migrations');
    const done = new Set(rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(join(dir, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
};
