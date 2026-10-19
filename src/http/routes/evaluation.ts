import type { FastifyInstance } from 'fastify';
import type { EvaluationService } from '../../application/evaluation-service.js';
import { EvaluateBody, toEvaluationRequest } from '../schemas.js';

export const evaluationRoutes = (
  app: FastifyInstance,
  service: EvaluationService,
  now: () => Date = () => new Date(),
): void => {
  /** "May I send this notification?" → { decision: allow | deny, reason, message } */
  app.post('/evaluate', async (request) => {
    const evaluationRequest = toEvaluationRequest(EvaluateBody.parse(request.body), now);
    return service.evaluate(evaluationRequest);
  });
};
