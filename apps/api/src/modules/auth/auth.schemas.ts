import { z } from 'zod';

export const loginBodySchema = z.object({
  email: z.string().trim().min(1, 'E-mailadres is verplicht').email('Ongeldig e-mailadres'),
  password: z.string().min(1, 'Wachtwoord is verplicht'),
  /** "Onthou mij" — bepaalt de sessieduur (30 vs. 7 dagen), zie session.service.ts. */
  rememberMe: z.boolean().optional().default(false),
});

export type LoginBody = z.infer<typeof loginBodySchema>;

export const forgotPasswordBodySchema = z.object({
  email: z.string().trim().min(1, 'E-mailadres is verplicht').email('Ongeldig e-mailadres'),
});

export type ForgotPasswordBody = z.infer<typeof forgotPasswordBodySchema>;

export const resetPasswordBodySchema = z.object({
  token: z.string().trim().min(1, 'Token is verplicht'),
  password: z.string().min(8, 'Wachtwoord moet minstens 8 tekens zijn'),
});

export type ResetPasswordBody = z.infer<typeof resetPasswordBodySchema>;
