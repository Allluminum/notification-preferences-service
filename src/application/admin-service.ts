import {
  DomainError,
  NOTIFICATION_TYPE_TRAITS,
  targetKey,
  validatePolicyScope,
  type DefaultPreference,
  type GlobalPolicy,
  type PolicyScope,
} from '../domain/index.js';
import { NotFoundError } from './errors.js';
import type { DefaultPreferencesRepository, Logger, PolicyRepository } from './ports.js';

/** Platform-level configuration: global policies and default preferences for new users. */
export class AdminService {
  constructor(
    private readonly deps: {
      readonly defaults: DefaultPreferencesRepository;
      readonly policies: PolicyRepository;
      readonly logger: Logger;
    },
  ) {}

  listPolicies(): Promise<GlobalPolicy[]> {
    return this.deps.policies.list();
  }

  async createPolicy(scope: PolicyScope, description: string): Promise<GlobalPolicy> {
    const policy = await this.deps.policies.create(validatePolicyScope(scope), description);
    this.deps.logger.info({ event: 'global_policy_created', policy }, 'Global policy created');
    return policy;
  }

  async deletePolicy(id: string): Promise<void> {
    if (!(await this.deps.policies.delete(id))) {
      throw new NotFoundError(`Global policy ${id} not found`);
    }
    this.deps.logger.info({ event: 'global_policy_deleted', policyId: id }, 'Global policy deleted');
  }

  listDefaults(): Promise<DefaultPreference[]> {
    return this.deps.defaults.list();
  }

  /** Changes defaults for users created from now on; existing users keep their snapshot. */
  async updateDefaults(items: readonly DefaultPreference[]): Promise<DefaultPreference[]> {
    for (const { target } of items) {
      if (!NOTIFICATION_TYPE_TRAITS[target.type].userConfigurable) {
        throw new DomainError(
          'notification_type_not_configurable',
          `Notification type "${target.type}" is mandatory, its default cannot be changed`,
        );
      }
    }
    await this.deps.defaults.upsert(items);
    this.deps.logger.info(
      {
        event: 'default_preferences_updated',
        changes: items.map((i) => ({ key: targetKey(i.target), enabled: i.enabled })),
      },
      'Default preferences updated',
    );
    return this.deps.defaults.list();
  }
}
