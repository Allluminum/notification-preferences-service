import { Counter, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Metrics, PreferencesUpdateOutcome } from '../../application/ports.js';

/** Prometheus implementation of the application Metrics port; exposed via GET /metrics. */
export class PrometheusMetrics implements Metrics {
  readonly registry = new Registry();

  private readonly decisions = new Counter({
    name: 'notification_evaluations_total',
    help: 'Send-permission decisions by outcome and reason',
    labelNames: ['decision', 'reason'] as const,
    registers: [this.registry],
  });

  private readonly evaluationDuration = new Histogram({
    name: 'notification_evaluation_duration_seconds',
    help: 'Time to evaluate a send-permission request, including storage reads',
    buckets: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25],
    registers: [this.registry],
  });

  private readonly updates = new Counter({
    name: 'preference_updates_total',
    help: 'Preference update requests by outcome (changed / unchanged / replayed)',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  constructor({ collectDefaults = true }: { collectDefaults?: boolean } = {}) {
    if (collectDefaults) collectDefaultMetrics({ register: this.registry });
  }

  recordEvaluation(decision: string, reason: string, durationSeconds: number): void {
    this.decisions.inc({ decision, reason });
    this.evaluationDuration.observe(durationSeconds);
  }

  recordPreferencesUpdate(outcome: PreferencesUpdateOutcome): void {
    this.updates.inc({ outcome });
  }
}
