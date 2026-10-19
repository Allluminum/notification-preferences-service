import { createHash } from 'node:crypto';
import {
  applyUpdate,
  resolvePreferences,
  targetKey,
  type UpdatePreferencesCommand,
  type UserId,
} from '../domain/index.js';
import { describeChange, toPreferencesDto, toQuietHoursDto, type PreferencesDto } from './dto.js';
import { IdempotencyKeyConflictError } from './errors.js';
import type { DefaultPreferencesRepository, Logger, Metrics, UnitOfWork, UserPreferencesReader } from './ports.js';

export interface UpdateResult {
  readonly preferences: PreferencesDto;
  /** True if the state was modified by this call. */
  readonly changed: boolean;
  /** True if the response was replayed from a previous call with the same idempotency key. */
  readonly replayed: boolean;
}

export interface RegisterResult {
  readonly preferences: PreferencesDto;
  readonly created: boolean;
}

/**
 * Normalized fingerprint of a command. Equivalent requests produce the same hash regardless of
 * field order or input form (`marketing_email` vs `marketing` + `email`).
 */
export const hashCommand = (command: UpdatePreferencesCommand): string => {
  const channels = command.channels
    .map((c) => `${targetKey(c.target)}=${String(c.enabled)}`)
    .sort();
  const canonical = JSON.stringify({
    channels: [...new Set(channels)],
    quietHours: command.quietHours === undefined ? '<unchanged>' : toQuietHoursDto(command.quietHours),
  });
  return createHash('sha256').update(canonical).digest('hex');
};

export class PreferencesService {
  constructor(
    private readonly deps: {
      readonly users: UserPreferencesReader;
      readonly defaults: DefaultPreferencesRepository;
      readonly unitOfWork: UnitOfWork;
      readonly logger: Logger;
      readonly metrics: Metrics;
    },
  ) {}

  /**
   * Effective preferences. A user unknown to the service gets the current defaults
   * (version 0) — nothing is written on the read path.
   */
  async get(userId: UserId): Promise<PreferencesDto> {
    const [stored, defaults] = await Promise.all([
      this.deps.users.find(userId),
      this.deps.defaults.list(),
    ]);
    return toPreferencesDto(resolvePreferences(userId, stored, defaults));
  }

  /**
   * Explicitly registers a user, freezing the current defaults as their initial preferences.
   * Idempotent: an already registered user is returned unchanged.
   */
  async register(userId: UserId): Promise<RegisterResult> {
    const result = await this.deps.unitOfWork.run(async (tx) => {
      await tx.lockUser(userId);
      const stored = await tx.findUser(userId);
      const defaults = await tx.listDefaults();
      if (stored) {
        return { preferences: resolvePreferences(userId, stored, defaults), created: false };
      }
      const initial = { ...resolvePreferences(userId, null, defaults), version: 1 };
      await tx.saveUser(initial);
      return { preferences: initial, created: true };
    });

    if (result.created) {
      this.deps.logger.info({ event: 'user_registered', userId }, 'User registered with default preferences');
    }
    return { preferences: toPreferencesDto(result.preferences), created: result.created };
  }

  /**
   * Applies a declarative update. Concurrency-safe (per-user lock) and idempotent on two levels:
   * - the command describes target state, so re-applying it changes nothing and keeps the version;
   * - with an idempotency key, a retried request returns the original response even if the state
   *   has been changed by later requests in the meantime (protects against late retries reverting newer changes).
   */
  async update(
    userId: UserId,
    command: UpdatePreferencesCommand,
    idempotencyKey?: string,
  ): Promise<UpdateResult> {
    const requestHash = hashCommand(command);

    const result = await this.deps.unitOfWork.run(async (tx) => {
      await tx.lockUser(userId);

      if (idempotencyKey !== undefined) {
        const previous = await tx.findIdempotencyRecord(userId, idempotencyKey);
        if (previous) {
          if (previous.requestHash !== requestHash) {
            throw new IdempotencyKeyConflictError(idempotencyKey);
          }
          return { preferences: previous.response, changes: [], replayed: true };
        }
      }

      const stored = await tx.findUser(userId);
      const defaults = await tx.listDefaults();
      const outcome = applyUpdate(resolvePreferences(userId, stored, defaults), command);
      if (outcome.changes.length > 0) {
        // The first write also materializes the default snapshot for all other pairs.
        await tx.saveUser(outcome.preferences);
      }

      const preferences = toPreferencesDto(outcome.preferences);
      if (idempotencyKey !== undefined) {
        await tx.saveIdempotencyRecord({ userId, key: idempotencyKey, requestHash, response: preferences });
      }
      return { preferences, changes: outcome.changes, replayed: false };
    });

    const changed = result.changes.length > 0;
    this.deps.metrics.recordPreferencesUpdate(result.replayed ? 'replayed' : changed ? 'changed' : 'unchanged');
    if (result.replayed) {
      this.deps.logger.info(
        { event: 'preferences_update_replayed', userId, idempotencyKey },
        'Repeated request, original response replayed',
      );
    } else if (changed) {
      this.deps.logger.info(
        {
          event: 'preferences_updated',
          userId,
          version: result.preferences.version,
          changes: result.changes.map(describeChange),
          idempotencyKey,
        },
        'User preferences updated',
      );
    } else {
      this.deps.logger.info(
        { event: 'preferences_update_noop', userId, version: result.preferences.version, idempotencyKey },
        'Preferences already in requested state, nothing changed',
      );
    }

    return { preferences: result.preferences, changed, replayed: result.replayed };
  }
}
