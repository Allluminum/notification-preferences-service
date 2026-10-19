import pg from 'pg';

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: the pool itself or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'>;

export const createPool = (connectionString: string, max = 10): DbPool => new pg.Pool({ connectionString, max });
