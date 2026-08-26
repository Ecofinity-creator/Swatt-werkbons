import type { UpdateCustomerHourlyRateBody, UpdateCustomerHourlyRateResponseBody } from '@swatt/shared-types';
import type { FastifyInstance } from 'fastify';
import { requireRole } from '../rbac/rbac.middleware';
import { CustomerService } from './customer.service';
import { customerIdParamsSchema, updateCustomerHourlyRateBodySchema } from './customer.schemas';

/**
 * Phase 10b — enkel het uurtarief-veld (sectie 17-uitbreiding). ADMIN-only,
 * zelfde rechten als de rest van de facturatie-instellingen (sectie 4:
 * "facturen voorbereiden" bij Administrator).
 */
export default async function customerRoutes(app: FastifyInstance): Promise<void> {
  const service = new CustomerService(app.prisma);

  app.post(
    '/admin/customers/:id/hourly-rate',
    { preHandler: [app.authenticate, requireRole('ADMIN')] },
    async (request): Promise<UpdateCustomerHourlyRateResponseBody> => {
      const params = customerIdParamsSchema.parse(request.params);
      const body: UpdateCustomerHourlyRateBody = updateCustomerHourlyRateBodySchema.parse(request.body);
      const customer = await service.updateHourlyRate(params.id, body.hourlyRateCents);
      return { customerId: customer.id, hourlyRateCents: customer.hourlyRateCents };
    },
  );
}
