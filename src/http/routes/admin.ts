import type { FastifyInstance } from 'fastify';
import type { AdminService } from '../../application/admin-service.js';
import { targetKey, type DefaultPreference, type GlobalPolicy } from '../../domain/index.js';
import {
  CreatePolicyBody,
  PolicyParams,
  UpdateDefaultsBody,
  toDefaultPreferences,
  toPolicyScope,
} from '../schemas.js';

const toPolicyDto = (policy: GlobalPolicy) => ({
  id: policy.id,
  notificationType: policy.notificationType,
  channel: policy.channel,
  region: policy.region,
  description: policy.description,
  createdAt: policy.createdAt.toISOString(),
});

const toDefaultDto = (item: DefaultPreference) => ({
  key: targetKey(item.target),
  notificationType: item.target.type,
  channel: item.target.channel,
  enabled: item.enabled,
});

/**
 * Platform configuration endpoints. In production they would live behind admin authentication
 * (or be managed via a separate admin service / config-as-code).
 */
export const adminRoutes = (app: FastifyInstance, service: AdminService): void => {
  app.get('/policies', async () => (await service.listPolicies()).map(toPolicyDto));

  app.post('/policies', async (request, reply) => {
    const body = CreatePolicyBody.parse(request.body);
    const policy = await service.createPolicy(toPolicyScope(body), body.description);
    return reply.status(201).send(toPolicyDto(policy));
  });

  app.delete('/policies/:id', async (request, reply) => {
    await service.deletePolicy(PolicyParams.parse(request.params).id);
    return reply.status(204).send();
  });

  app.get('/default-preferences', async () => (await service.listDefaults()).map(toDefaultDto));

  app.put('/default-preferences', async (request) => {
    const items = toDefaultPreferences(UpdateDefaultsBody.parse(request.body));
    return (await service.updateDefaults(items)).map(toDefaultDto);
  });
};
