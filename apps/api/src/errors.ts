/**
 * Eén centrale foutklasse voor "verwachte" fouten (verkeerd wachtwoord,
 * geen rechten, ...) — deze krijgen altijd een mensentaal-boodschap
 * (sectie 27 van de projectbrief: nooit kaal "HTTP 422" tonen aan de gebruiker).
 * Onverwachte fouten (bugs, DB down, ...) lopen NIET via deze klasse en worden
 * door de globale Fastify error handler afgevangen met een generieke melding.
 */
export class ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    /** Mensentaal-boodschap, rechtstreeks toonbaar in de UI. */
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const AuthErrors = {
  invalidCredentials: () =>
    new ApiError(401, 'INVALID_CREDENTIALS', 'E-mailadres of wachtwoord is onjuist.'),
  accountDeactivated: () =>
    new ApiError(
      403,
      'ACCOUNT_DEACTIVATED',
      'Dit account is gedeactiveerd. Neem contact op met je beheerder.',
    ),
  notAuthenticated: () =>
    new ApiError(401, 'NOT_AUTHENTICATED', 'Je bent niet (meer) ingelogd. Log opnieuw in.'),
  insufficientRole: () =>
    new ApiError(403, 'INSUFFICIENT_ROLE', 'Je hebt geen rechten voor deze actie.'),
};

export const TeamleaderErrors = {
  notConfigured: () =>
    new ApiError(
      503,
      'TEAMLEADER_NOT_CONFIGURED',
      'De Teamleader-integratie is nog niet geconfigureerd. Neem contact op met de beheerder.',
    ),
  notConnected: () =>
    new ApiError(
      409,
      'TEAMLEADER_NOT_CONNECTED',
      'Er is nog geen actieve Teamleader-koppeling. Verbind eerst met Teamleader via de instellingen.',
    ),
  reconnectRequired: () =>
    new ApiError(
      409,
      'TEAMLEADER_RECONNECT_REQUIRED',
      'De Teamleader-koppeling is verlopen of ingetrokken. Verbind opnieuw via de instellingen.',
    ),
};
