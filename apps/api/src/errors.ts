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
  /**
   * Phase 9 — een project heeft nog geen "werkbon-uren"-milestone (gekozen of
   * automatisch aangemaakt) én er is geen `defaultMilestoneResponsibleTeamleaderUserId`
   * geconfigureerd om er automatisch één aan te maken (zie MilestoneSyncService).
   * Actiegerichte fout (sectie 27) i.p.v. te gokken wie verantwoordelijk is.
   */
  milestoneNotConfigured: () =>
    new ApiError(
      409,
      'TEAMLEADER_MILESTONE_NOT_CONFIGURED',
      'Er is nog geen Teamleader-milestone gekozen voor dit project, en er is geen standaard verantwoordelijke ingesteld om er automatisch één aan te maken. Kies een milestone bij het project, of stel een standaard verantwoordelijke in via Instellingen → Teamleader-integratie.',
    ),
  /** Deze Teamleader-gebruiker is al aan een andere lokale gebruiker gekoppeld (User.teamleaderUserId is uniek). */
  teamleaderUserAlreadyLinked: () =>
    new ApiError(
      409,
      'TEAMLEADER_USER_ALREADY_LINKED',
      'Deze Teamleader-gebruiker is al aan een andere medewerker gekoppeld.',
    ),
  /** Een medewerker heeft nog geen gekoppelde Teamleader-gebruiker (nodig voor `timeTracking.add`'s `user_id`, sectie 14). */
  employeeNotLinkedToTeamleaderUser: (displayName: string) =>
    new ApiError(
      409,
      'TEAMLEADER_EMPLOYEE_NOT_LINKED',
      `${displayName} is nog niet gekoppeld aan een Teamleader-gebruiker. Koppel dit eerst via Medewerkers → ${displayName} → Teamleader-koppeling.`,
    ),
  /** Phase 10b — de vier vaste keuzes voor invoices.draft staan nog niet (volledig) ingesteld (zie TeamleaderConnection.invoice*). */
  invoiceSettingsNotConfigured: () =>
    new ApiError(
      409,
      'TEAMLEADER_INVOICE_SETTINGS_NOT_CONFIGURED',
      'De facturatie-instellingen (departement, btw-tarief, betalingstermijn) zijn nog niet volledig ingesteld. Stel deze eerst in via Instellingen → Teamleader-integratie.',
    ),
};

/** Phase 10b — Customer.hourlyRateCents (zie modules/customers/customer.service.ts). */
export const CustomerErrors = {
  notFound: () => new ApiError(404, 'CUSTOMER_NOT_FOUND', 'Deze klant bestaat niet (meer).'),
};

export const UserErrors = {
  emailAlreadyInUse: () =>
    new ApiError(409, 'EMAIL_ALREADY_IN_USE', 'Dit e-mailadres is al in gebruik door een andere gebruiker.'),
  notFound: () => new ApiError(404, 'USER_NOT_FOUND', 'Deze gebruiker bestaat niet (meer).'),
  /** Opnieuw uitnodigen heeft geen zin (en geen betekenis) zodra iemand al zelf een wachtwoord heeft ingesteld. */
  alreadyActivated: () =>
    new ApiError(409, 'USER_ALREADY_ACTIVATED', 'Deze gebruiker heeft al een wachtwoord ingesteld — een nieuwe uitnodiging is niet nodig. Gebruik "Wachtwoord vergeten" op het inlogscherm indien nodig.'),
  /** Licentiebeperking (betaalplan) — zie CompanySettings.maxEmployees. */
  maxEmployeesReached: (max: number) =>
    new ApiError(
      403,
      'USER_MAX_EMPLOYEES_REACHED',
      `Het maximum aantal medewerkers voor dit abonnement (${max}) is bereikt. Deactiveer een bestaande medewerker of neem contact op om je abonnement uit te breiden.`,
    ),
  /** Verwijderen mag enkel als er nog geen tijdregistraties/werkbonnen aan deze medewerker hangen (business rule 8/9 — historiek mag nooit beschadigd worden). */
  cannotDeleteWithHistory: () =>
    new ApiError(
      409,
      'USER_CANNOT_DELETE_WITH_HISTORY',
      'Deze medewerker heeft al tijdregistraties of werkbonnen en kan daarom niet volledig verwijderd worden. Gebruik "Deactiveren" in plaats daarvan.',
    ),
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
  /**
   * Sectie 6 — "Tijd manueel ingeven". Deze drie business-controles stonden
   * eerst als zod `.refine()` in time-entry.schemas.ts, maar elke ZodError
   * wordt door de globale errorhandler (app.ts, sectie 27) bewust herleid
   * tot de generieke "De ingevoerde gegevens zijn niet geldig" — een
   * werknemer kreeg zo geen idee wélk veld het probleem was (bv. een
   * eindtijd die maar enkele minuten in de toekomst ligt, iets wat in de
   * praktijk makkelijk gebeurt door klokverschil tussen telefoon en server
   * of door op een rond uur af te ronden). Verplaatst naar de service-laag
   * zodat de specifieke, mensentaal-foutmelding wél bij de werknemer
   * terechtkomt.
   */
  manualEndBeforeStart: () =>
    new ApiError(422, 'TIME_ENTRY_MANUAL_END_BEFORE_START', 'De eindtijd moet na de starttijd liggen.'),
  manualStartInFuture: () =>
    new ApiError(422, 'TIME_ENTRY_MANUAL_START_IN_FUTURE', 'De starttijd kan niet in de toekomst liggen.'),
  manualEndInFuture: () =>
    new ApiError(422, 'TIME_ENTRY_MANUAL_END_IN_FUTURE', 'De eindtijd kan niet in de toekomst liggen.'),
  manualPauseTooLong: () =>
    new ApiError(
      422,
      'TIME_ENTRY_MANUAL_PAUSE_TOO_LONG',
      'De pauze kan niet even lang of langer zijn dan de volledige periode.',
    ),
  /**
   * Wettelijke arbeidstijdregistratie (vanaf 1/1/2027) + sectie 4: correctie
   * kan enkel op een STOPPED registratie — een lopende/gepauzeerde timer
   * corrigeer je via pause/resume/stop, niet via deze route.
   */
  notStoppedYet: () =>
    new ApiError(
      409,
      'TIME_ENTRY_NOT_STOPPED_YET',
      'Deze tijdsregistratie loopt nog. Stop ze eerst voor je ze kan corrigeren.',
    ),
  correctionEndBeforeStart: () =>
    new ApiError(422, 'TIME_ENTRY_CORRECTION_END_BEFORE_START', 'De eindtijd moet na de starttijd liggen.'),
  correctionPauseTooLong: () =>
    new ApiError(
      422,
      'TIME_ENTRY_CORRECTION_PAUSE_TOO_LONG',
      'De pauze kan niet even lang of langer zijn dan de volledige periode.',
    ),
  /**
   * Business rule (bevestigd door Steven, aug 2026): een werkbon mag na
   * ondertekening niet meer aangepast worden — géén uitzondering, ook niet
   * via een aparte correctie-rij. Zie WORK_ORDER_STATUSES_ALLOWING_DIRECT_EDIT
   * in TimeEntryService: alles voorbij DRAFT/READY_FOR_SIGNATURE blokkeert.
   */
  correctionBlockedSigned: () =>
    new ApiError(
      409,
      'TIME_ENTRY_CORRECTION_BLOCKED_SIGNED',
      'Deze werkbon is al ondertekend en kan niet meer aangepast worden.',
    ),
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
  /** Phase 6/7 — business rule 3 (sectie 24): een ondertekende werkbon is immutable. */
  alreadySigned: () =>
    new ApiError(
      409,
      'WORK_ORDER_ALREADY_SIGNED',
      'Deze werkbon is al ondertekend en kan niet meer gewijzigd worden.',
    ),
  photoNotFound: () =>
    new ApiError(404, 'WORK_ORDER_PHOTO_NOT_FOUND', 'Deze foto bestaat niet (meer) op deze werkbon.'),
  /** Phase 8 — PDF-generatie kan enkel voor een ondertekende werkbon (die heeft altijd ook een handtekening, zie WorkOrderSignatureService.sign()). */
  notSignedForPdf: () =>
    new ApiError(
      409,
      'WORK_ORDER_NOT_SIGNED',
      'Deze werkbon is nog niet ondertekend — er is nog geen PDF om te genereren.',
    ),
  pdfGenerationInProgress: () =>
    new ApiError(409, 'WORK_ORDER_PDF_GENERATING', 'De PDF wordt momenteel al gegenereerd. Even geduld.'),
  pdfNotReady: () =>
    new ApiError(
      409,
      'WORK_ORDER_PDF_NOT_READY',
      'De PDF van deze werkbon is nog niet beschikbaar. Probeer het zo dadelijk opnieuw, of gebruik "PDF opnieuw genereren".',
    ),
  /** Phase 9 — een "opnieuw synchroniseren"-aanvraag op een werkbon die nog niet ondertekend is (dus nooit gesynchroniseerd kán zijn). */
  notSignedForSync: () =>
    new ApiError(
      409,
      'WORK_ORDER_NOT_SIGNED_FOR_SYNC',
      'Deze werkbon is nog niet ondertekend — er is nog niets om naar Teamleader te synchroniseren.',
    ),
  /** Op vraag (3/9/2026): "PDF via een knop naar de klant sturen" — enkel mogelijk op een ondertekende werkbon met een klaarstaande PDF. */
  notReadyToSendToCustomer: () =>
    new ApiError(
      409,
      'WORK_ORDER_NOT_READY_TO_SEND',
      'Deze werkbon moet eerst ondertekend zijn en een klaarstaande PDF hebben vóór je ze naar de klant kan sturen.',
    ),
  /** De klant heeft geen e-mailadres bij Teamleader — kan enkel opgelost worden door het daar in te vullen en opnieuw te synchroniseren. */
  noCustomerEmail: () =>
    new ApiError(
      409,
      'WORK_ORDER_NO_CUSTOMER_EMAIL',
      'Voor deze klant is geen e-mailadres gekend bij Teamleader. Vul dit in bij Teamleader en synchroniseer opnieuw.',
    ),
};

/** Phase 10 — facturatie-overzicht (sectie 17/29). Zie modules/invoice-batches/invoice-batch.service.ts. */
export const InvoiceBatchErrors = {
  noWorkOrders: () =>
    new ApiError(400, 'INVOICE_BATCH_NO_WORK_ORDERS', 'Selecteer minstens één werkbon om te factureren.'),
  /** Eén of meer meegegeven werkbon-IDs bestaan niet (meer), of staan niet (meer) op READY_FOR_INVOICING. */
  workOrderNotInvoiceable: () =>
    new ApiError(
      409,
      'INVOICE_BATCH_WORK_ORDER_NOT_INVOICEABLE',
      'Eén of meer geselecteerde werkbonnen zijn niet (meer) klaar voor facturatie. Ververs de pagina en probeer opnieuw.',
    ),
  workOrderCustomerMismatch: () =>
    new ApiError(
      409,
      'INVOICE_BATCH_CUSTOMER_MISMATCH',
      'Alle geselecteerde werkbonnen moeten bij dezelfde klant horen.',
    ),
  /** Business rule 7: een werkbon mag maar één keer gefactureerd worden. */
  workOrderAlreadyBatched: () =>
    new ApiError(
      409,
      'INVOICE_BATCH_WORK_ORDER_ALREADY_BATCHED',
      'Eén of meer geselecteerde werkbonnen zijn al in een facturatiebatch opgenomen.',
    ),
  notFound: () =>
    new ApiError(404, 'INVOICE_BATCH_NOT_FOUND', 'Deze facturatiebatch bestaat niet (meer).'),
  cannotRemoveNonDraft: () =>
    new ApiError(
      409,
      'INVOICE_BATCH_CANNOT_REMOVE',
      'Deze facturatiebatch is al naar Teamleader gestuurd en kan niet meer verwijderd worden.',
    ),
  /** Phase 10b — "Maak conceptfactuur in Teamleader" aangeroepen op een batch die al SUBMITTED_TO_TEAMLEADER/INVOICED is. */
  alreadySubmittedToTeamleader: () =>
    new ApiError(
      409,
      'INVOICE_BATCH_ALREADY_SUBMITTED',
      'Voor deze facturatiebatch is al een conceptfactuur aangemaakt in Teamleader.',
    ),
  /** @deprecated Sinds de overstap naar tarief-per-medewerker niet meer gebruikt — zie employeeHourlyRateNotSet hieronder. Blijft bestaan zodat CustomerService/customer.routes.ts (nog steeds een geldig, apart uurtarief-veld op Customer) een passende fout kunnen gooien. */
  hourlyRateNotSet: (customerName: string) =>
    new ApiError(
      409,
      'INVOICE_BATCH_HOURLY_RATE_NOT_SET',
      `Er is nog geen uurtarief ingesteld voor ${customerName}. Vul dit eerst in bij deze facturatiebatch.`,
    ),
  /** Eén of meer medewerkers op deze batch hebben nog geen standaard- of eenmalig uurtarief (zie InvoiceBatchService.resolveEmployeeRates). */
  employeeHourlyRateNotSet: (employeeNames: string[]) =>
    new ApiError(
      409,
      'INVOICE_BATCH_EMPLOYEE_HOURLY_RATE_NOT_SET',
      `Er is nog geen uurtarief ingesteld voor ${employeeNames.join(', ')}. Vul dit in bij "Medewerkers", of eenmalig hier bij deze facturatiebatch.`,
    ),
  /** De opgegeven medewerker komt niet voor op een werkbon van deze batch — een tarief zou dus niets betekenen. */
  employeeNotOnBatch: () =>
    new ApiError(
      404,
      'INVOICE_BATCH_EMPLOYEE_NOT_ON_BATCH',
      'Deze medewerker komt niet voor op een werkbon van deze facturatiebatch.',
    ),
};

/** Phase 12, deel E — personeelsuitbetaling (maandoverzicht per medewerker). */
export const PayrollErrors = {
  noTimeEntries: () =>
    new ApiError(400, 'PAYROLL_BATCH_NO_TIME_ENTRIES', 'Er zijn geen openstaande, ondertekende uren gevonden voor deze medewerker in deze periode.'),
  /** Business rule 12: elke tijdregistratie mag maar één keer uitbetaald worden. */
  timeEntryAlreadyPaid: () =>
    new ApiError(409, 'PAYROLL_BATCH_TIME_ENTRY_ALREADY_PAID', 'Eén of meer uren van deze medewerker zijn al in een andere personeelsuitbetaling opgenomen.'),
  employeeHourlyRateNotSet: (displayName: string) =>
    new ApiError(
      409,
      'PAYROLL_BATCH_EMPLOYEE_HOURLY_RATE_NOT_SET',
      `Er is nog geen uurtarief ingesteld voor ${displayName}. Vul dit eerst in bij "Medewerkers".`,
    ),
  notFound: () => new ApiError(404, 'PAYROLL_BATCH_NOT_FOUND', 'Deze personeelsuitbetaling bestaat niet (meer).'),
  cannotRemoveNonDraft: () =>
    new ApiError(409, 'PAYROLL_BATCH_CANNOT_REMOVE', 'Deze personeelsuitbetaling is al afgesloten en kan niet meer verwijderd worden.'),
};

/** Phase 12, deel B — werkbonnen per week laten ondertekenen (sectie 2). */
export const WeeklyApprovalErrors = {
  noPendingWorkOrders: () =>
    new ApiError(400, 'WEEKLY_APPROVAL_NO_PENDING_WORK_ORDERS', 'Er staan deze week nog geen werkbonnen klaar om te ondertekenen op dit project.'),
  alreadySigned: () =>
    new ApiError(409, 'WEEKLY_APPROVAL_ALREADY_SIGNED', 'Deze week is ondertussen al door iemand anders afgetekend.'),
  notFound: () => new ApiError(404, 'WEEKLY_APPROVAL_NOT_FOUND', 'Deze weekgoedkeuring bestaat niet (meer).'),
  notSigned: () =>
    new ApiError(409, 'WEEKLY_APPROVAL_NOT_SIGNED', 'Deze week is nog niet ondertekend en kan daarom niet heropend worden.'),
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

/** Werknemer vs. Onderaannemer — maandelijkse uren-export (zie hours-export.service.ts). */
export const HoursExportErrors = {
  invalidPeriod: () =>
    new ApiError(
      400,
      'HOURS_EXPORT_INVALID_PERIOD',
      'Ongeldige periode. Gebruik het formaat JJJJ-MM, bijvoorbeeld 2026-08.',
    ),
  employeeNotFound: () =>
    new ApiError(404, 'HOURS_EXPORT_EMPLOYEE_NOT_FOUND', 'Deze medewerker bestaat niet (meer).'),
  /** Excel-export is enkel voor EMPLOYEE, het PDF-totalisatiedocument enkel voor SUBCONTRACTOR — zie EmploymentType. */
  wrongEmploymentType: (expectedLabel: string) =>
    new ApiError(
      409,
      'HOURS_EXPORT_WRONG_EMPLOYMENT_TYPE',
      `Deze export is enkel beschikbaar voor medewerkers van het type "${expectedLabel}".`,
    ),
};
