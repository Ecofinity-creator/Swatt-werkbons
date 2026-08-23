import { USER_ROLES } from '@swatt/shared-types';
import { z } from 'zod';

const userRoleSchema = z.enum(USER_ROLES);

export const createUserBodySchema = z.object({
  email: z.string().trim().min(1, 'E-mailadres is verplicht').email('Ongeldig e-mailadres'),
  password: z.string().min(8, 'Wachtwoord moet minstens 8 tekens zijn'),
  displayName: z.string().trim().min(1, 'Naam is verplicht'),
  role: userRoleSchema,
  phone: z.string().trim().min(1).optional(),
});

export type CreateUserBody = z.infer<typeof createUserBodySchema>;

/** Partial update — alle velden optioneel, enkel meegegeven velden worden gewijzigd. */
export const updateUserBodySchema = z.object({
  role: userRoleSchema.optional(),
  isActive: z.boolean().optional(),
  displayName: z.string().trim().min(1, 'Naam mag niet leeg zijn').optional(),
  phone: z.string().trim().min(1).nullable().optional(),
});

export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
