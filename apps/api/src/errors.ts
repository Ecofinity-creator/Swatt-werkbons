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
  /**
   * Nieuw account via uitnodiging, of anderszins nog geen wachtwoord
   * ingesteld. Dit expliciet onderscheiden van invalidCredentials() is hier
   * GEEN account-enumeratie-risico: de gebruiker probeert net met dit exacte
   * e-mailadres in te loggen, dus die weet al dat het bestaat.
   */
  passwordNotSet: () =>
    new ApiError(
      401,
      'PASSWORD_NOT_SET',
      'Voor dit account is nog geen wachtwoord ingesteld. Check je e-mail voor de uitnodigingslink, of klik hieronder op "Wachtwoord vergeten".',
    ),
  invalidOrExpiredToken: () =>
    new ApiError(
      400,
      'INVALID_OR_EXPIRED_TOKEN',
      'Deze link is ongeldig, al gebruikt, of verlopen. Vraag een nieuwe link aan.',
    ),
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
  /** Onverwacht antwoord van de Teamleader-API zelf (niet-2xx, of een onherkenbare response-vorm). */
  syncFailed: (detail: string) =>
    new ApiError(502, 'TEAMLEADER_SYNC_FAILED', `Synchroniseren met Teamleader is mislukt: ${detail}`),
};

export const UserErrors = {
  emailAlreadyInUse: () =>
    new ApiError(409, 'EMAIL_ALREADY_IN_USE', 'Dit e-mailadres is al in gebruik door een andere gebruiker.'),
  notFound: () => new ApiError(404, 'USER_NOT_FOUND', 'Deze gebruiker bestaat niet (meer).'),
};

export const ProjectErrors = {
  notFound: () =>
    new ApiError(404, 'PROJECT_NOT_FOUND', 'Dit project bestaat niet (meer) of is niet gesynchroniseerd.'),
  employeeNotFound: () => new ApiError(404, 'EMPLOYEE_NOT_FOUND', 'Deze werknemer bestaat niet (meer).'),
  /** Project bestaat wel, maar is niet aan deze werknemer gekoppeld (zie ProjectAssignment) — enkel gekoppelde projecten mogen uren boeken (Stap 5.1). */
  notAssigned: () =>
    new ApiError(
      403,
      'PROJECT_NOT_ASSIGNED',
      'Dit project is niet aan jou gekoppeld. Vraag je supervisor of beheerder om je aan dit project te koppelen.',
    ),
};

/** Phase 4 — timer ("START WERK"). Zie modules/time-entries/time-entry.service.ts voor de business-rule-logica. */
export const TimeEntryErrors = {
  /** Business rule 1 (sectie 24): één werknemer kan maar één actieve timer tegelijk hebben. */
  alreadyActive: () =>
    new ApiError(
      409,
      'TIME_ENTRY_ALREADY_ACTIVE',
      'Je hebt al een actieve tijdsregistratie lopen. Stop deze eerst voor je een nieuwe start.',
    ),
  notFound: () => new ApiError(404, 'TIME_ENTRY_NOT_FOUND', 'Deze tijdsregistratie bestaat niet (meer).'),
  notRunning: () =>
    new ApiError(409, 'TIME_ENTRY_NOT_RUNNING', 'Deze tijdsregistratie loopt niet (meer).'),
  notPaused: () =>
    new ApiError(409, 'TIME_ENTRY_NOT_PAUSED', 'Deze tijdsregistratie staat niet gepauzeerd.'),
  alreadyStopped: () =>
    new ApiError(409, 'TIME_ENTRY_ALREADY_STOPPED', 'Deze tijdsregistratie is al gestopt.'),
};

/** Phase 5 — werkbonnen (basis). Zie modules/work-orders/work-order.service.ts. */
export const WorkOrderErrors = {
  notFound: () => new ApiError(404, 'WORK_ORDER_NOT_FOUND', 'Deze werkbon bestaat niet (meer).'),
  /** Meegegeven time-entry-IDs bevatten er minstens één die niet bestaat, niet van deze werknemer is, of niet (meer) STOPPED is. */
  invalidTimeEntry: () =>
    new ApiError(
      409,
      'WORK_ORDER_INVALID_TIME_ENTRY',
      'Deze tijdsregistratie kan niet aan een werkbon toegevoegd worden. Controleer of ze van jou is en gestopt is.',
    ),
  /** Een meegegeven time entry hoort bij een ander project dan het opgegeven project van de werkbon. */
  timeEntryProjectMismatch: () =>
    new ApiError(
      409,
      'WORK_ORDER_TIME_ENTRY_PROJECT_MISMATCH',
      'Deze tijdsregistratie hoort bij een ander project dan de werkbon.',
    ),
  /** De time entry is al aan een (andere) werkbon gekoppeld — business rule (sectie 24 naar analogie): hoogstens één werkbon per tijdsregistratie. */
  timeEntryAlreadyLinked: () =>
    new ApiError(
      409,
      'WORK_ORDER_TIME_ENTRY_ALREADY_LINKED',
      'Deze tijdsregistratie is al aan een werkbon gekoppeld.',
    ),
  noTimeEntries: () =>
    new ApiError(400, 'WORK_ORDER_NO_TIME_ENTRIES', 'Een werkbon moet minstens één tijdsregistratie bevatten.'),
};

export const EmailErrors = {
  notConfigured: () =>
    new ApiError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'E-mailverzending is nog niet geconfigureerd. Neem contact op met de beheerder.',
    ),
  /** Onverwacht antwoord van de e-maildienst zelf (niet-2xx). */
  sendFailed: (detail: string) =>
    new ApiError(502, 'EMAIL_SEND_FAILED', `Het versturen van de e-mail is mislukt: ${detail}`),
};
