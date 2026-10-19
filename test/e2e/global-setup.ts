import { migrate } from '../../src/infrastructure/db/migrate.js';
import { createPool } from '../../src/infrastructure/db/pool.js';
import { TEST_DATABASE_URL } from './env.js';

/** Applies migrations to the test database once before all e2e suites. */
export default async function setup(): Promise<void> {
  const pool = createPool(TEST_DATABASE_URL, 1);
  try {
    await migrate(pool);
  } catch (error) {
    throw new Error(
      `Cannot prepare test database at ${TEST_DATABASE_URL}. ` +
        'Start PostgreSQL with `docker compose up -d postgres` or set TEST_DATABASE_URL.',
      { cause: error },
    );
  } finally {
    await pool.end();
  }
}
