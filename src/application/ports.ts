import type {
  DefaultPreference,
  GlobalPolicy,
  NotificationTarget,
  PolicyScope,
  Region,
  StoredUserPreferences,
  UserId,
  UserPreferences,
} from '../domain/index.js';
import type { PreferencesDto } from './dto.js';

/** Structured logger (pino-compatible subset). */
export interface Logger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  error(fields: object, message: string): void;
}

export type PreferencesUpdateOutcome = 'changed' | 'unchanged' | 'replayed';

/** Business metrics. Infrastructure decides how to export them (Prometheus, StatsD, ...). */
export interface Metrics {
  recordEvaluation(decision: string, reason: string, durationSeconds: number): void;
  recordPreferencesUpdate(outcome: PreferencesUpdateOutcome): void;
}

export interface UserPreferencesReader {
  find(userId: UserId): Promise<StoredUserPreferences | null>;
}

export interface DefaultPreferencesRepository {
  list(): Promise<DefaultPreference[]>;
  upsert(items: readonly DefaultPreference[]): Promise<void>;
}

export interface PolicyRepository {
  list(): Promise<GlobalPolicy[]>;
  /** Policies whose scope covers the given target in the given region. */
  findApplicable(target: NotificationTarget, region: Region): Promise<GlobalPolicy[]>;
  create(scope: PolicyScope, description: string): Promise<GlobalPolicy>;
  delete(id: string): Promise<boolean>;
}

export interface IdempotencyRecord {
  readonly userId: UserId;
  readonly key: string;
  /** Hash of the normalized command; the same key with a different command is rejected. */
  readonly requestHash: string;
  readonly response: PreferencesDto;
}

/** Repositories bound to a single database transaction. */
export interface PreferencesTransaction {
  /** Serializes concurrent writers of the same user until the transaction ends. */
  lockUser(userId: UserId): Promise<void>;
  findUser(userId: UserId): Promise<StoredUserPreferences | null>;
  listDefaults(): Promise<DefaultPreference[]>;
  saveUser(preferences: UserPreferences): Promise<void>;
  findIdempotencyRecord(userId: UserId, key: string): Promise<IdempotencyRecord | null>;
  saveIdempotencyRecord(record: IdempotencyRecord): Promise<void>;
}

export interface UnitOfWork {
  run<T>(work: (tx: PreferencesTransaction) => Promise<T>): Promise<T>;
}
