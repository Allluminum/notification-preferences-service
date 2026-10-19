import type {
  DefaultPreferencesRepository,
  IdempotencyRecord,
  PolicyRepository,
  PreferencesTransaction,
  UnitOfWork,
  UserPreferencesReader,
} from '../../application/ports.js';
import type { PreferencesDto } from '../../application/dto.js';
import {
  targetKey,
  type DefaultPreference,
  type GlobalPolicy,
  type NotificationKey,
  type NotificationTarget,
  type PolicyScope,
  type Region,
  type StoredUserPreferences,
  type UserId,
  type UserPreferences,
} from '../../domain/index.js';
import type { DbPool, Queryable } from '../db/pool.js';
import { localToTime, notNull, toPolicy, toQuietHours, toTarget, type PolicyRow, type QuietHoursColumns } from './mappers.js';

// ---------------------------------------------------------------------------------------------
// Shared queries (usable both with the pool and with a transaction-bound client)
// ---------------------------------------------------------------------------------------------

const findUser = async (db: Queryable, userId: UserId): Promise<StoredUserPreferences | null> => {
  // One statement => one consistent snapshot of the profile and its channel rows.
  const { rows } = await db.query<
    QuietHoursColumns & {
      version: number;
      notification_type: string | null;
      channel: string | null;
      enabled: boolean | null;
      source: 'default' | 'user' | null;
    }
  >(
    `SELECT p.version,
            p.quiet_hours_start::text AS quiet_hours_start,
            p.quiet_hours_end::text   AS quiet_hours_end,
            p.quiet_hours_timezone,
            c.notification_type, c.channel, c.enabled, c.source
       FROM user_profiles p
       LEFT JOIN user_channel_preferences c ON c.user_id = p.user_id
      WHERE p.user_id = $1`,
    [userId],
  );
  const first = rows[0];
  if (!first) return null;

  const channels = new Map<NotificationKey, { enabled: boolean; source: 'default' | 'user' }>();
  for (const r of rows) {
    if (r.notification_type === null || r.channel === null || r.enabled === null || r.source === null) continue;
    const target = toTarget({ notification_type: r.notification_type, channel: r.channel });
    if (target) channels.set(targetKey(target), { enabled: r.enabled, source: r.source });
  }

  return { userId, version: first.version, channels, quietHours: toQuietHours(first) };
};

const listDefaults = async (db: Queryable): Promise<DefaultPreference[]> => {
  const { rows } = await db.query<{ notification_type: string; channel: string; enabled: boolean }>(
    'SELECT notification_type, channel, enabled FROM default_preferences ORDER BY notification_type, channel',
  );
  return rows
    .map((r) => {
      const target = toTarget(r);
      return target && { target, enabled: r.enabled };
    })
    .filter(notNull);
};

// ---------------------------------------------------------------------------------------------
// Read-side repositories
// ---------------------------------------------------------------------------------------------

export class PgUserPreferencesReader implements UserPreferencesReader {
  constructor(private readonly db: Queryable) {}

  find(userId: UserId): Promise<StoredUserPreferences | null> {
    return findUser(this.db, userId);
  }
}

export class PgDefaultPreferencesRepository implements DefaultPreferencesRepository {
  constructor(private readonly db: Queryable) {}

  list(): Promise<DefaultPreference[]> {
    return listDefaults(this.db);
  }

  async upsert(items: readonly DefaultPreference[]): Promise<void> {
    if (items.length === 0) return;
    await this.db.query(
      `INSERT INTO default_preferences (notification_type, channel, enabled)
       SELECT * FROM unnest($1::text[], $2::text[], $3::boolean[])
       ON CONFLICT (notification_type, channel)
       DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
       WHERE default_preferences.enabled IS DISTINCT FROM EXCLUDED.enabled`,
      [items.map((i) => i.target.type), items.map((i) => i.target.channel), items.map((i) => i.enabled)],
    );
  }
}

const POLICY_COLUMNS = 'id, notification_type, channel, region, description, created_at';

export class PgPolicyRepository implements PolicyRepository {
  constructor(private readonly db: Queryable) {}

  async list(): Promise<GlobalPolicy[]> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM global_policies ORDER BY created_at, id`,
    );
    return rows.map(toPolicy).filter(notNull);
  }

  async findApplicable(target: NotificationTarget, region: Region): Promise<GlobalPolicy[]> {
    const { rows } = await this.db.query<PolicyRow>(
      `SELECT ${POLICY_COLUMNS} FROM global_policies
        WHERE (notification_type IS NULL OR notification_type = $1)
          AND (channel IS NULL OR channel = $2)
          AND (region IS NULL OR region = $3)
        ORDER BY created_at, id`,
      [target.type, target.channel, region],
    );
    return rows.map(toPolicy).filter(notNull);
  }

  async create(scope: PolicyScope, description: string): Promise<GlobalPolicy> {
    const { rows } = await this.db.query<PolicyRow>(
      `INSERT INTO global_policies (notification_type, channel, region, description)
       VALUES ($1, $2, $3, $4) RETURNING ${POLICY_COLUMNS}`,
      [scope.notificationType, scope.channel, scope.region, description],
    );
    const policy = rows[0] && toPolicy(rows[0]);
    if (!policy) throw new Error('Failed to create global policy');
    return policy;
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.db.query('DELETE FROM global_policies WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }
}

// ---------------------------------------------------------------------------------------------
// Write side: transaction-bound repositories
// ---------------------------------------------------------------------------------------------

class PgPreferencesTransaction implements PreferencesTransaction {
  constructor(private readonly db: Queryable) {}

  async lockUser(userId: UserId): Promise<void> {
    // Transaction-scoped advisory lock works for users that have no row yet,
    // so two concurrent "first writes" of the same user are serialized as well.
    await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [userId]);
  }

  findUser(userId: UserId): Promise<StoredUserPreferences | null> {
    return findUser(this.db, userId);
  }

  listDefaults(): Promise<DefaultPreference[]> {
    return listDefaults(this.db);
  }

  async saveUser(preferences: UserPreferences): Promise<void> {
    const { userId, version, quietHours } = preferences;
    await this.db.query(
      `INSERT INTO user_profiles (user_id, version, quiet_hours_start, quiet_hours_end, quiet_hours_timezone)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE SET
         version = EXCLUDED.version,
         quiet_hours_start = EXCLUDED.quiet_hours_start,
         quiet_hours_end = EXCLUDED.quiet_hours_end,
         quiet_hours_timezone = EXCLUDED.quiet_hours_timezone,
         updated_at = now()`,
      [
        userId,
        version,
        quietHours && localToTime(quietHours.start),
        quietHours && localToTime(quietHours.end),
        quietHours?.timeZone ?? null,
      ],
    );

    // Mandatory pairs are derived from domain rules and never stored.
    const rows = [...preferences.channels.values()].filter(
      (c): c is typeof c & { source: 'default' | 'user' } => c.source !== 'mandatory',
    );
    await this.db.query(
      `INSERT INTO user_channel_preferences (user_id, notification_type, channel, enabled, source)
       SELECT $1, * FROM unnest($2::text[], $3::text[], $4::boolean[], $5::text[])
       ON CONFLICT (user_id, notification_type, channel) DO UPDATE SET
         enabled = EXCLUDED.enabled,
         source = EXCLUDED.source,
         updated_at = now()
       WHERE (user_channel_preferences.enabled, user_channel_preferences.source)
             IS DISTINCT FROM (EXCLUDED.enabled, EXCLUDED.source)`,
      [
        userId,
        rows.map((r) => r.target.type),
        rows.map((r) => r.target.channel),
        rows.map((r) => r.enabled),
        rows.map((r) => r.source),
      ],
    );
  }

  async findIdempotencyRecord(userId: UserId, key: string): Promise<IdempotencyRecord | null> {
    const { rows } = await this.db.query<{ request_hash: string; response: PreferencesDto }>(
      'SELECT request_hash, response FROM idempotency_keys WHERE user_id = $1 AND idempotency_key = $2',
      [userId, key],
    );
    const row = rows[0];
    return row ? { userId, key, requestHash: row.request_hash, response: row.response } : null;
  }

  async saveIdempotencyRecord(record: IdempotencyRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO idempotency_keys (user_id, idempotency_key, request_hash, response)
       VALUES ($1, $2, $3, $4)`,
      [record.userId, record.key, record.requestHash, JSON.stringify(record.response)],
    );
  }
}

export class PgUnitOfWork implements UnitOfWork {
  constructor(private readonly pool: DbPool) {}

  async run<T>(work: (tx: PreferencesTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(new PgPreferencesTransaction(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
