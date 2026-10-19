import { performance } from 'node:perf_hooks';
import {
  evaluate,
  resolvePreferences,
  targetKey,
  type EvaluationRequest,
  type EvaluationResult,
} from '../domain/index.js';
import type { DefaultPreferencesRepository, Logger, Metrics, PolicyRepository, UserPreferencesReader } from './ports.js';

export class EvaluationService {
  constructor(
    private readonly deps: {
      readonly users: UserPreferencesReader;
      readonly defaults: DefaultPreferencesRepository;
      readonly policies: PolicyRepository;
      readonly logger: Logger;
      readonly metrics: Metrics;
    },
  ) {}

  /** Read-only: answers "may this notification be sent right now?" with a reason. */
  async evaluate(request: EvaluationRequest): Promise<EvaluationResult> {
    const startedAt = performance.now();

    const [stored, defaults, policies] = await Promise.all([
      this.deps.users.find(request.userId),
      this.deps.defaults.list(),
      this.deps.policies.findApplicable(request.target, request.region),
    ]);
    const result = evaluate(request, resolvePreferences(request.userId, stored, defaults), policies);

    const durationSeconds = (performance.now() - startedAt) / 1000;
    this.deps.metrics.recordEvaluation(result.decision, result.reason, durationSeconds);
    this.deps.logger.info(
      {
        event: 'notification_evaluated',
        userId: request.userId,
        notification: targetKey(request.target),
        region: request.region,
        at: request.at.toISOString(),
        decision: result.decision,
        reason: result.reason,
        ...(result.decision === 'deny' && result.policyId ? { policyId: result.policyId } : {}),
        durationMs: Math.round(durationSeconds * 1000 * 100) / 100,
      },
      `Notification ${result.decision}: ${result.reason}`,
    );
    return result;
  }
}
