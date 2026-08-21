import { z } from 'zod';

export const loginBodySchema = z.object({
  email: z.string().trim().min(1, 'E-mailadres is verplicht').email('Ongeldig e-mailadres'),
  password: z.string().min(1, 'Wachtwoord is verplicht'),
});

export type LoginBody = z.infer<typeof loginBodySchema>;
