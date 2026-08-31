import { EMPLOYMENT_TYPES, USER_ROLES } from '@swatt/shared-types';
import { z } from 'zod';

const userRoleSchema = z.enum(USER_ROLES);
const employmentTypeSchema = z.enum(EMPLOYMENT_TYPES);

export const createUserBodySchema = z.object({
  email: z.string().trim().min(1, 'E-mailadres is verplicht').email('Ongeldig e-mailadres'),
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
  /** Phase 9 — koppeling met een Teamleader-gebruiker (sectie 14/23), zie GET /admin/teamleader/users. `null` heft de koppeling op. */
  teamleaderUserId: z.string().trim().min(1).nullable().optional(),
  /** Facturatie: standaard uurtarief van deze medewerker (in eurocent), zie Employee.defaultHourlyRateCents. `null` wist het weer. */
  defaultHourlyRateCents: z.number().int().positive().nullable().optional(),
  /** Phase 12, deel A (sectie 1) — toeslagpercentages, admin-only, nooit zichtbaar voor de medewerker zelf (business rule 11). */
  overtimeRatePercent: z.number().int().min(100).max(500).optional(),
  shiftWorkRatePercent: z.number().int().min(100).max(500).optional(),
  nightWorkRatePercent: z.number().int().min(100).max(500).optional(),
  /** Werknemer vs. Onderaannemer (backlog-item 30/8), zie Employee.employmentType. */
  employmentType: employmentTypeSchema.optional(),
});

export type UpdateUserBody = z.infer<typeof updateUserBodySchema>;
