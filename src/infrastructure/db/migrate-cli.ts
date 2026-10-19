import { loadConfig } from '../../config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const config = loadConfig();
const pool = createPool(config.DATABASE_URL, 1);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date');
} finally {
  await pool.end();
}
