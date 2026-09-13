import { z } from 'zod';

export const requestCustomerPortalLinkBodySchema = z.object({
  email: z.string().trim().min(1, 'E-mailadres is verplicht').email('Ongeldig e-mailadres'),
});

export const verifyCustomerPortalLinkQuerySchema = z.object({
  token: z.string().trim().min(1, 'Token is verplicht'),
});

export const customerPortalWorkOrderIdParamsSchema = z.object({
  id: z.string().uuid(),
});
