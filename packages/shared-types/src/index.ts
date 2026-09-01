/**
 * Types die gedeeld worden tussen apps/api en apps/web.
 * Bron van waarheid voor de rol-enum en de vorm van de "ingelogde gebruiker"-payload
 * die de backend teruggeeft aan de frontend (GET /auth/me).
 *
 * Let op: dit zijn *transport*-types (wat over de API-grens gaat), niet de volledige
 * Prisma-modellen. De Prisma-modellen (zie apps/api/prisma/schema.prisma) zijn de bron
 * van waarheid voor de database-vorm; deze types zijn er bewust een klein, expliciet
 * afgeleid subset van, zodat we nooit per ongeluk een password_hash o.i.d. lekken.
 */

export const USER_ROLES = ['EMPLOYEE', 'SUPERVISOR', 'ADMIN'] as const;

export type UserRole = (typeof USER_ROLES)[number];

/** Rolhiërarchie: index in deze array bepaalt "minstens zo veel rechten als". */
export const ROLE_HIERARCHY: readonly UserRole[] = ['EMPLOYEE', 'SUPERVISOR', 'ADMIN'];

export function roleAtLeast(role: UserRole, minimum: UserRole): boolean {
  return ROLE_HIERARCHY.indexOf(role) >= ROLE_HIERARCHY.indexOf(minimum);
}

/**
 * Werknemer vs. Onderaannemer op de medewerkerskaart (backlog-item 30/8, zie
 * claude/projectoverdracht-samenvatting_2.md sectie 3.3 en
 * Employee.employmentType in schema.prisma). Bepaalt welk soort document
 * deze persoon krijgt bij de maandelijkse uren-export — zie
 * HoursExportEmployeeSummary hieronder.
 */
export const EMPLOYMENT_TYPES = ['EMPLOYEE', 'SUBCONTRACTOR'] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/** Publieke, veilige weergave van de ingelogde gebruiker (nooit een password hash e.d.). */
export interface AuthenticatedUser {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  employee: {
    id: string;
    displayName: string;
  } | null;
}

export interface LoginRequestBody {
  email: string;
  password: string;
  /** "Onthou mij" — bepaalt de sessieduur (30 vs. 7 dagen), zie session.service.ts. */
  rememberMe?: boolean;
}

export interface LoginResponseBody {
  user: AuthenticatedUser;
}

/** Body van POST /auth/forgot-password. Response is altijd 204, ongeacht of het e-mailadres bestaat (voorkomt account-enumeratie). */
export interface ForgotPasswordBody {
  email: string;
}

/** Body van POST /auth/reset-password — `token` komt uit de link in de uitnodigings-/reset-e-mail. */
export interface ResetPasswordBody {
  token: string;
  password: string;
}

export interface ApiErrorBody {
  error: {
    /** Machine-leesbare code, bv. "INVALID_CREDENTIALS" — voor i18n/UI-logica. */
    code: string;
    /** Mensentaal-boodschap, geschikt om rechtstreeks te tonen (zie sectie 27 van de brief). */
    message: string;
  };
}

/** Phase 2 — Teamleader OAuth. Zie apps/api/src/modules/teamleader/. */
export const TEAMLEADER_CONNECTION_STATUSES = ['DISCONNECTED', 'CONNECTED', 'ERROR'] as const;

export type TeamleaderConnectionStatus = (typeof TEAMLEADER_CONNECTION_STATUSES)[number];

/** Response van GET /teamleader/status — data-only (nooit tokens), datums als ISO-strings over de wire. */
export interface TeamleaderStatusResponseBody {
  status: TeamleaderConnectionStatus;
  connectedAt: string | null;
  tokenExpiresAt: string | null;
  lastError: string | null;
}

/**
 * Response van POST /teamleader/oauth/prepare-authorize — een kortlevend,
 * eenmalig bruikbaar token (zie de uitgebreide toelichting in
 * apps/api/src/modules/teamleader/teamleader.routes.ts bij
 * AUTHORIZE_HANDOFF_TTL_MS) dat de frontend meegeeft in de daaropvolgende
 * top-level navigatie naar /teamleader/oauth/authorize. Nodig omdat cross-site
 * cookiebescherming in moderne browsers (Firefox Total Cookie Protection e.d.)
 * de normale sessiecookie op dát exacte moment onbetrouwbaar maakt.
 */
export interface PrepareAuthorizeResponseBody {
  token: string;
}

/**
 * Phase 3 (slice) — gebruikersbeheer (admin) + projectcache/koppeling.
 * Zie apps/api/src/modules/users/ en apps/api/src/modules/projects/.
 *
 * BELANGRIJK — bewust geen PATCH/DELETE-routes: deze app vermijdt CORS-preflights
 * structureel (zie apps/api/src/app.ts / apps/web/src/api/client.ts, Render's edge
 * geeft op een preflight een niet-JSON 404 vóór onze eigen backend). Alle
 * schrijfacties hieronder lopen daarom via POST, ook wat conceptueel een
 * update/delete is (bv. `.../update`, `.../remove`) — net als het bestaande
 * `/teamleader/oauth/disconnect`-patroon.
 */

/** Publieke weergave van een door een admin beheerde gebruiker (nooit een password hash). */
export interface AdminUserSummary {
  id: string;
  email: string;
  role: UserRole;
  isActive: boolean;
  employee: {
    id: string;
    displayName: string;
    phone: string | null;
    /** Facturatie: standaard uurtarief van deze medewerker (in eurocent) — de VERKOOPPRIJS, gebruikt om de klant te factureren, zie Employee.defaultHourlyRateCents. */
    defaultHourlyRateCents: number | null;
    /** Fase 12-herziening: KOSTPRIJS — wat effectief uitbetaald wordt aan deze medewerker/onderaannemer (Phase 12, deel E), zie Employee.payrollRateCents. Los van defaultHourlyRateCents hierboven. */
    payrollRateCents: number | null;
    /** Werknemer vs. Onderaannemer, zie EmploymentType. */
    employmentType: EmploymentType;
  } | null;
  createdAt: string;
  /** Phase 9 — gekoppelde Teamleader-gebruiker (sectie 14), `null` = nog niet gekoppeld. */
  teamleaderUserId: string | null;
  /** `false` zolang deze gebruiker nog geen wachtwoord heeft ingesteld (uitnodiging nog niet opgepikt) — nooit de hash zelf blootstellen, enkel dit boolean. */
  hasSetPassword: boolean;
}

export interface ListUsersResponseBody {
  users: AdminUserSummary[];
}

export interface CreateUserBody {
  email: string;
  displayName: string;
  role: UserRole;
  phone?: string;
}

/** `inviteEmailSent` is false wanneer het account wél is aangemaakt maar de uitnodigingsmail niet kon worden verstuurd (zie business rule 9 — externe-dienst-storing mag nooit lokale data laten verloren gaan). */
export interface CreateUserResponseBody {
  user: AdminUserSummary;
  inviteEmailSent: boolean;
  /** Technische foutmelding (van Resend of "niet geconfigureerd") wanneer `inviteEmailSent` false is — anders `null`. Enkel zichtbaar voor de admin die de gebruiker aanmaakt. */
  inviteEmailError: string | null;
}

/** Response van POST /admin/users/:id/resend-invite. */
export interface ResendInviteResponseBody {
  inviteEmailSent: boolean;
  /** Technische foutmelding wanneer `inviteEmailSent` false is — anders `null`. */
  inviteEmailError: string | null;
}

/** Body van POST /admin/users/:id/update — alle velden optioneel (partial update). */
export interface UpdateUserBody {
  role?: UserRole;
  isActive?: boolean;
  displayName?: string;
  phone?: string | null;
  /** Facturatie: standaard uurtarief van deze medewerker (in eurocent) — VERKOOPPRIJS, `null` wist het weer. */
  defaultHourlyRateCents?: number | null;
  /** Fase 12-herziening: KOSTPRIJS (uitbetaling), `null` wist het weer. Los van defaultHourlyRateCents hierboven. */
  payrollRateCents?: number | null;
  /** Werknemer vs. Onderaannemer, zie EmploymentType. */
  employmentType?: EmploymentType;
}

export interface UpdateUserResponseBody {
  user: AdminUserSummary;
}

/** Publieke weergave van een uit Teamleader gesynchroniseerd project. */
export interface ProjectSummary {
  id: string;
  teamleaderId: string;
  projectNumber: string | null;
  name: string;
  description: string | null;
  address: string | null;
  status: string | null;
  customerName: string;
  isArchivedInTl: boolean;
  /** Phase 12, deel C — false = enkel nacalculatie (sync naar Teamleader blijft lopen, verschijnt nooit in het Facturatie-overzicht). */
  invoicingEnabled: boolean;
  /** Phase 12, deel A (sectie 1) — "Overuren boven 8u/dag" (DAILY) of "Overuren boven [x]u/week" (WEEKLY). */
  overtimeThresholdType: 'DAILY' | 'WEEKLY';
  overtimeWeeklyThresholdHours: number | null;
  /** Fase 12-herziening: toeslagregeling zit uniform op Project — geldt voor iedereen die er werkt (geen aparte keuze meer per medewerker/koppeling). */
  overtimeApplies: boolean;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
  overtimeRatePercent: number;
  shiftWorkRatePercent: number;
  nightWorkRatePercent: number;
  /** Phase 12, deel B (sectie 2) — "Ondertekening per werkbon" (default) of "Ondertekening per week". */
  signingMode: 'PER_WORK_ORDER' | 'WEEKLY';
  /** Phase 12, deel D (sectie 5) — rijafstand ÉÉN richting in meter tussen het Swatt-adres en dit project, `null` zolang nog niet berekend. */
  kmDistanceOneWayMeters: number | null;
}

export interface ListProjectsResponseBody {
  projects: ProjectSummary[];
}

/** Body/response van POST /admin/projects/:id/invoicing-enabled (Phase 12, deel C — ADMIN-only). */
export interface UpdateProjectInvoicingEnabledBody {
  invoicingEnabled: boolean;
}

export interface UpdateProjectInvoicingEnabledResponseBody {
  invoicingEnabled: boolean;
}

/**
 * Body/response van POST /admin/projects/:id/overtime-settings (Fase
 * 12-herziening — ADMIN-only). Bevat sinds de herziening de VOLLEDIGE
 * toeslagregeling van het project (drempel + of overuren/ploegenwerk/
 * nachtwerk van toepassing is + de percentages), niet meer enkel de drempel.
 */
export interface UpdateProjectOvertimeSettingsBody {
  overtimeThresholdType: 'DAILY' | 'WEEKLY';
  /** Verplicht wanneer overtimeThresholdType='WEEKLY', genegeerd bij 'DAILY'. */
  overtimeWeeklyThresholdHours?: number | null;
  overtimeApplies: boolean;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
  overtimeRatePercent: number;
  shiftWorkRatePercent: number;
  nightWorkRatePercent: number;
}

export interface UpdateProjectOvertimeSettingsResponseBody {
  overtimeThresholdType: 'DAILY' | 'WEEKLY';
  overtimeWeeklyThresholdHours: number | null;
  overtimeApplies: boolean;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
  overtimeRatePercent: number;
  shiftWorkRatePercent: number;
  nightWorkRatePercent: number;
}

/** Body/response van POST /admin/projects/:id/signing-mode (Phase 12, deel B — ADMIN-only). */
export interface UpdateProjectSigningModeBody {
  signingMode: 'PER_WORK_ORDER' | 'WEEKLY';
}

export interface UpdateProjectSigningModeResponseBody {
  signingMode: 'PER_WORK_ORDER' | 'WEEKLY';
}

/** Response van GET /work-orders/pending-week?projectId=... (Phase 12, deel B) — enkel relevant op een project met signingMode='WEEKLY'. */
export interface PendingWeekResponseBody {
  weekStartDate: string;
  weekEndDate: string;
  /** Werkbonnen van DEZE medewerker die deze week nog wachten op weekondertekening. */
  workOrderIds: string[];
}

/** Body van POST /weekly-approvals/:projectId/sign — zelfde velden als het bestaande /work-orders/:id/sign, nu voor de hele lopende week. */
export interface SignWeekBody {
  signerName: string;
  signerFunction?: string;
  confirmed: true;
  signatureDataBase64: string;
  mimeType: 'image/png';
}

export interface WeeklyApprovalSummary {
  id: string;
  projectId: string;
  weekStartDate: string;
  weekEndDate: string;
  status: 'OPEN' | 'SIGNED' | 'REOPENED';
  signerName: string | null;
  signerFunction: string | null;
  confirmedAt: string | null;
  workOrderIds: string[];
}

export interface SignWeekResponseBody {
  weeklyApproval: WeeklyApprovalSummary;
}

/** Response van GET /admin/employees/:employeeId/project-assignments. */
export interface ListProjectAssignmentsResponseBody {
  projectIds: string[];
}

/** Body van POST .../project-assignments en .../project-assignments/remove. */
export interface ProjectAssignmentBody {
  projectId: string;
}

export const TEAMLEADER_PROJECTS_MODULES = ['LEGACY', 'PROJECTS_V2'] as const;
export type TeamleaderProjectsModule = (typeof TEAMLEADER_PROJECTS_MODULES)[number];

/** Response van POST /admin/teamleader/sync/projects. */
export interface ProjectSyncResponseBody {
  module: TeamleaderProjectsModule;
  syncedCount: number;
  skippedWithoutCustomerCount: number;
  archivedCount: number;
}

/**
 * Phase 4 — timer ("START WERK"). Zie apps/api/src/modules/time-entries/.
 *
 * RUNNING → PAUSED (herhaaldelijk mogelijk) → RUNNING, en uiteindelijk
 * RUNNING/PAUSED → STOPPED (eindstatus). Business rule 1 (sectie 24): een
 * werknemer heeft nooit meer dan één RUNNING/PAUSED-registratie tegelijk.
 */
export const TIME_ENTRY_STATUSES = ['RUNNING', 'PAUSED', 'STOPPED'] as const;
export type TimeEntryStatus = (typeof TIME_ENTRY_STATUSES)[number];

/**
 * Publieke weergave van een tijdsregistratie. Bevat bewust enkel de ruwe
 * tijdstippen (`startedAt`/`pausedSeconds`/`currentPauseStartedAt`), geen
 * kant-en-klare "verstreken tijd" — die is tijdsafhankelijk en zou meteen
 * verouderd zijn. De frontend berekent en toont de live tellende tijd zelf
 * (zie ProjectTimerPage.tsx), op basis van deze velden + het huidige moment.
 */
export interface TimeEntrySummary {
  id: string;
  projectId: string;
  projectName: string;
  customerName: string;
  status: TimeEntryStatus;
  startedAt: string;
  endedAt: string | null;
  /** Som van alle afgeronde pauze-intervallen, in seconden. */
  pausedSeconds: number;
  /** Enkel gezet wanneer status = PAUSED — start van de huidige, nog lopende pauze. */
  currentPauseStartedAt: string | null;
  description: string | null;
  /** Sectie 6: true wanneer aangemaakt via POST /time-entries/manual (vaste start-/eindtijd) i.p.v. de START/PAUZE/STOP-timerflow. Zuiver informatief. */
  isManual: boolean;
}

/** Response van GET /time-entries/active — null wanneer de werknemer geen actieve (RUNNING/PAUSED) registratie heeft. */
export interface ActiveTimeEntryResponseBody {
  timeEntry: TimeEntrySummary | null;
}

/** Response van POST /time-entries/start, .../pause, .../resume en .../stop. */
export interface TimeEntryResponseBody {
  timeEntry: TimeEntrySummary;
}

export interface StartTimeEntryBody {
  projectId: string;
}

/** Body van POST /time-entries/:id/stop — `description` is optioneel. */
export interface StopTimeEntryBody {
  description?: string;
}

/**
 * Body van POST /time-entries/manual (sectie 6: "manueel tijd toevoegen
 * indien toegestaan"). `startedAt`/`endedAt` zijn volledige ISO-tijdstippen
 * (UTC) — de frontend zet een lokale datum + start-/einduur zelf om vóór
 * verzending. `pausedMinutes` is optioneel (standaard 0).
 */
export interface CreateManualTimeEntryBody {
  projectId: string;
  startedAt: string;
  endedAt: string;
  pausedMinutes?: number;
  description?: string;
}

/**
 * Phase 5 — werkbonnen (basis). Zie apps/api/src/modules/work-orders/.
 * Statusnamen matchen het overzicht uit sectie 20 van de projectbrief; deze
 * ronde gebruikt enkel DRAFT.
 */
export const WORK_ORDER_STATUSES = [
  'DRAFT',
  'READY_FOR_SIGNATURE',
  'SIGNED',
  'SYNC_PENDING',
  'SYNC_FAILED',
  'READY_FOR_INVOICING',
  'INVOICED',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/** Eén tijdsregistratie zoals opgenomen in een werkbon (sectie 8 — meerdere werknemers per werf). */
export interface WorkOrderTimeEntrySummary {
  id: string;
  employeeId: string;
  employeeDisplayName: string;
  startedAt: string;
  endedAt: string | null;
  pausedSeconds: number;
}

/**
 * Phase 6 — foto's op een werkbon (sectie 9). Matcht de voorbeeldcategorieën
 * uit sectie 9 letterlijk; categorie is optioneel (`null`).
 */
export const WORK_ORDER_PHOTO_CATEGORIES = [
  'SITUATIE_VOOR',
  'UITVOERING',
  'SITUATIE_NA',
  'SERIENUMMER',
  'TECHNISCHE_INSTALLATIE',
  'PROBLEEM_SCHADE',
  'OVERIGE',
] as const;
export type WorkOrderPhotoCategory = (typeof WORK_ORDER_PHOTO_CATEGORIES)[number];

/** Mensentaal-labels voor de categorie-kiezer in de UI. */
export const WORK_ORDER_PHOTO_CATEGORY_LABELS: Record<WorkOrderPhotoCategory, string> = {
  SITUATIE_VOOR: 'Situatie voor werken',
  UITVOERING: 'Uitvoering',
  SITUATIE_NA: 'Situatie na werken',
  SERIENUMMER: 'Serienummer',
  TECHNISCHE_INSTALLATIE: 'Technische installatie',
  PROBLEEM_SCHADE: 'Probleem/schade',
  OVERIGE: 'Overige',
};

/**
 * Publieke weergave van één foto. Bevat de foto-bytes rechtstreeks als
 * data-URLs (i.p.v. een aparte GET-route per foto) — bewuste keuze voor
 * architecturale eenvoud, aanvaardbaar omdat dit enkel opgehaald wordt bij
 * het bekijken van één specifieke werkbon, nooit in een lijstweergave.
 */
export interface WorkOrderPhotoSummary {
  id: string;
  category: WorkOrderPhotoCategory | null;
  description: string | null;
  /** ~1600px, JPEG kwaliteit 0.8 — client-side gecomprimeerd vóór upload (zie apps/web/src/lib/image.ts). */
  optimizedDataUrl: string;
  /** ~320px, JPEG kwaliteit 0.7. */
  thumbnailDataUrl: string;
  uploadedByEmployeeDisplayName: string;
  createdAt: string;
}

/** Body van POST /work-orders/:id/photos — foto's als base64 in de gewone JSON-body (zie work-order.schemas.ts). */
export interface AddWorkOrderPhotoBody {
  category?: WorkOrderPhotoCategory | null;
  description?: string;
  optimizedMimeType: 'image/jpeg';
  optimizedDataBase64: string;
  thumbnailMimeType: 'image/jpeg';
  thumbnailDataBase64: string;
}

/**
 * Phase 7 — digitale handtekening van de klant (sectie 10). Ten hoogste één
 * per werkbon; zodra aanwezig is de werkbon SIGNED en dus immutable
 * (business rule 3).
 */
export interface WorkOrderSignatureSummary {
  signerName: string;
  signerFunction: string | null;
  signedAt: string;
  /** PNG van het handtekening-canvas, als data-URL. */
  imageDataUrl: string;
}

/** Body van POST /work-orders/:id/sign. */
export interface SignWorkOrderBody {
  signerName: string;
  signerFunction?: string;
  /** Sectie 10: "Ik bevestig dat bovenstaande werkzaamheden werden uitgevoerd." — verplicht `true`. */
  confirmed: true;
  mimeType: 'image/png';
  signatureDataBase64: string;
}

/**
 * Phase 8 — PDF-generatie (secties 12/13/31). Bewust losgekoppeld van de
 * Teamleader-upload-statussen (die horen bij Phase 9).
 */
export const WORK_ORDER_PDF_STATUSES = ['PDF_PENDING', 'PDF_GENERATING', 'PDF_READY', 'PDF_FAILED'] as const;
export type WorkOrderPdfStatus = (typeof WORK_ORDER_PDF_STATUSES)[number];

/** Mensentaal-labels voor de PDF-statusbadge in de UI. */
export const WORK_ORDER_PDF_STATUS_LABELS: Record<WorkOrderPdfStatus, string> = {
  PDF_PENDING: 'PDF nog niet aangevraagd',
  PDF_GENERATING: 'PDF wordt gegenereerd...',
  PDF_READY: 'PDF beschikbaar',
  PDF_FAILED: 'PDF genereren mislukt',
};

/**
 * Phase 9 — Teamleader-sync (secties 13-15/31). Bewust losgekoppeld van
 * pdfStatus (Phase 8) — zie het uitgebreide commentaar bij
 * WorkOrderTeamleaderUploadStatus in schema.prisma over waarom er géén
 * gedocumenteerde manier bestaat om dit rechtstreeks aan een `nextgenProject`
 * (Projects V2) te koppelen; Swatt/Ecofinity's account gebruikt de legacy-module.
 */
export const WORK_ORDER_TEAMLEADER_UPLOAD_STATUSES = [
  'TEAMLEADER_UPLOAD_PENDING',
  'TEAMLEADER_UPLOADED',
  'TEAMLEADER_UPLOAD_FAILED',
] as const;
export type WorkOrderTeamleaderUploadStatus = (typeof WORK_ORDER_TEAMLEADER_UPLOAD_STATUSES)[number];

export const WORK_ORDER_TEAMLEADER_UPLOAD_STATUS_LABELS: Record<WorkOrderTeamleaderUploadStatus, string> = {
  TEAMLEADER_UPLOAD_PENDING: 'Nog niet naar Teamleader geüpload',
  TEAMLEADER_UPLOADED: 'Geüpload naar Teamleader',
  TEAMLEADER_UPLOAD_FAILED: 'Uploaden naar Teamleader mislukt',
};

/** Phase 9 — sync-status per tijdsregistratie (sectie 14). */
export const TIME_ENTRY_SYNC_STATUSES = ['NOT_SYNCED', 'PENDING', 'SYNCED', 'FAILED'] as const;
export type TimeEntrySyncStatus = (typeof TIME_ENTRY_SYNC_STATUSES)[number];

/**
 * Samengestelde weergave van de tijdregistratie-sync over de hele werkbon
 * (i.p.v. een aparte status per tijdregistratie in de UI) — berekend in de
 * backend (zie work-order.service.ts, `deriveTimeTrackingSyncStatus`):
 * SYNCED enkel als élke gekoppelde tijdregistratie SYNCED is, FAILED als er
 * minstens één FAILED is (ongeacht de rest), anders PENDING/NOT_SYNCED naar
 * de "minst gevorderde" toestand.
 */
export const WORK_ORDER_TIME_TRACKING_SYNC_STATUS_LABELS: Record<TimeEntrySyncStatus, string> = {
  NOT_SYNCED: 'Uren nog niet gesynchroniseerd',
  PENDING: 'Uren worden gesynchroniseerd...',
  SYNCED: 'Uren gesynchroniseerd',
  FAILED: 'Synchroniseren van uren mislukt',
};

export interface WorkOrderSummary {
  id: string;
  workOrderNumber: string;
  projectId: string;
  projectName: string;
  /** Phase 12, deel B (sectie 2) — bepaalt of de werknemersflow "Werkbon tekenen" of "Week aftekenen" toont. */
  projectSigningMode: 'PER_WORK_ORDER' | 'WEEKLY';
  customerName: string;
  status: WorkOrderStatus;
  description: string | null;
  createdByEmployeeDisplayName: string;
  createdAt: string;
  timeEntries: WorkOrderTimeEntrySummary[];
  photos: WorkOrderPhotoSummary[];
  signature: WorkOrderSignatureSummary | null;
  pdfStatus: WorkOrderPdfStatus;
  pdfFileName: string | null;
  pdfGeneratedAt: string | null;
  /** Mensentaal-boodschap (sectie 27) — enkel gezet wanneer pdfStatus === 'PDF_FAILED'. */
  pdfError: string | null;
  /** Phase 9 — zie WORK_ORDER_TIME_TRACKING_SYNC_STATUS_LABELS hierboven. */
  timeTrackingSyncStatus: TimeEntrySyncStatus;
  /** Mensentaal-boodschap van de laatst mislukte tijdregistratie-sync, indien van toepassing. */
  timeTrackingSyncError: string | null;
  teamleaderUploadStatus: WorkOrderTeamleaderUploadStatus;
  teamleaderUploadedAt: string | null;
  teamleaderUploadError: string | null;
}

/** Body van POST /work-orders. */
export interface CreateWorkOrderBody {
  projectId: string;
  timeEntryIds: string[];
  description?: string;
}

/** Response van POST /work-orders, GET /work-orders/:id, .../photos, .../photos/:photoId/remove en .../sign. */
export interface WorkOrderResponseBody {
  workOrder: WorkOrderSummary;
}

// ============================================================
// Phase 9 — Teamleader-sync. Zie apps/api/src/modules/sync/,
// apps/api/src/modules/teamleader/{milestone,time-tracking,file}-sync.service.ts.
// ============================================================

/** Publieke weergave van een uit Teamleader gesynchroniseerde (legacy) milestone. */
export interface MilestoneSummary {
  id: string;
  teamleaderId: string;
  name: string;
  status: string;
  dueOn: string | null;
  isArchivedInTl: boolean;
}

/** Response van POST /admin/projects/:id/milestones/sync. */
export interface MilestoneSyncResponseBody {
  milestones: MilestoneSummary[];
  /** De op dit moment ingestelde "werkbon-uren"-milestone voor dit project, indien gekozen (zie project.timeTrackingMilestoneId). */
  selectedMilestoneId: string | null;
}

/** Body van POST /admin/projects/:id/milestones/select. */
export interface SelectProjectMilestoneBody {
  /** `null` = koppeling opheffen (project valt terug op automatische aanmaak bij de volgende sync). */
  milestoneId: string | null;
}

export interface SelectProjectMilestoneResponseBody {
  selectedMilestoneId: string | null;
}

/** Eén Teamleader-gebruiker zoals live opgehaald via `users.list` (GET /admin/teamleader/users) — geen lokale cache/tabel, zie teamleader-user.service.ts. */
export interface TeamleaderUserOption {
  id: string;
  /** Voor- en achternaam samengevoegd, of het e-mailadres wanneer Teamleader geen naam teruggeeft. */
  displayName: string;
}

export interface ListTeamleaderUsersResponseBody {
  users: TeamleaderUserOption[];
}

/** Body van POST /admin/users/:id/update — uitgebreid met de Phase 9-koppeling (los van UpdateUserBody hierboven, dezelfde route accepteert beide). */
export interface LinkTeamleaderUserBody {
  /** `null` = koppeling opheffen. */
  teamleaderUserId?: string | null;
}

/**
 * Body van POST /admin/teamleader/settings. Phase 10b breidde dit uit met de
 * vier vaste keuzes die `invoices.draft` verplicht vraagt (zie
 * TeamleaderConnection in schema.prisma / claude/phase10-facturatie-onderzoek.md).
 * De frontend stuurt bij elke save altijd het volledige object mee (zelfde
 * patroon als UpdateCompanySettingsBody) — geen losse PATCH-semantiek nodig.
 */
export interface UpdateTeamleaderSettingsBody {
  defaultMilestoneResponsibleTeamleaderUserId: string | null;
  invoiceDepartmentId: string | null;
  invoiceTaxRateId: string | null;
  invoicePaymentTermType: string | null;
  invoicePaymentTermDays: number | null;
}

export interface TeamleaderSettingsResponseBody {
  defaultMilestoneResponsibleTeamleaderUserId: string | null;
  invoiceDepartmentId: string | null;
  invoiceTaxRateId: string | null;
  invoicePaymentTermType: string | null;
  invoicePaymentTermDays: number | null;
}

/** Eén departement/vestiging — GET /admin/teamleader/invoice-options (departments.list). */
export interface TeamleaderInvoiceDepartmentOption {
  id: string;
  name: string;
}

/** Eén btw-tarief — enkel gevuld wanneer een departementId meegegeven werd (taxRates.list is filterbaar op department_id). */
export interface TeamleaderInvoiceTaxRateOption {
  id: string;
  /** Mensentaal-label, bv. "21% (Standaard btw-tarief)" — opgebouwd uit taxRates.list's `rate`+`description`. */
  label: string;
}

/** Eén betalingstermijn — `value` is `"<type>:<days>"`, gebouwd/ontleed door de frontend (zie TeamleaderSettingsPage.tsx). */
export interface TeamleaderInvoicePaymentTermOption {
  type: string;
  days: number;
  label: string;
  isDefault: boolean;
}

export interface TeamleaderInvoiceOptionsResponseBody {
  departments: TeamleaderInvoiceDepartmentOption[];
  taxRates: TeamleaderInvoiceTaxRateOption[];
  paymentTerms: TeamleaderInvoicePaymentTermOption[];
}

/** Body van POST /admin/customers/:id/hourly-rate (sectie 17/29-uitbreiding — zie Customer.hourlyRateCents in schema.prisma). */
export interface UpdateCustomerHourlyRateBody {
  /** In eurocent; `null` wist het tarief weer. */
  hourlyRateCents: number | null;
}

export interface UpdateCustomerHourlyRateResponseBody {
  customerId: string;
  hourlyRateCents: number | null;
}

/** Eén regel in het overzicht "Synchronisatiefouten" (sectie 4/13 — supervisor behandelt sync-fouten). */
export interface WorkOrderSyncIssueSummary {
  id: string;
  workOrderNumber: string;
  projectName: string;
  customerName: string;
  status: WorkOrderStatus;
  timeTrackingSyncStatus: TimeEntrySyncStatus;
  timeTrackingSyncError: string | null;
  teamleaderUploadStatus: WorkOrderTeamleaderUploadStatus;
  teamleaderUploadError: string | null;
  updatedAt: string;
}

/** Response van GET /admin/work-orders/sync-issues. */
export interface ListWorkOrderSyncIssuesResponseBody {
  workOrders: WorkOrderSyncIssueSummary[];
}

/**
 * Response van POST /work-orders/:id/sync/retry — handmatige herstelactie
 * (sectie 13: "Administrator moet handmatig: Opnieuw synchroniseren kunnen
 * kiezen"), herbruikt dezelfde WorkOrderResponseBody-vorm als de rest van de
 * werkbon-routes zodat de UI na een retry gewoon de bijgewerkte werkbon toont.
 */
export type RetryWorkOrderSyncResponseBody = WorkOrderResponseBody;

/**
 * Bedrijfsgegevens voor de werkbon-PDF-header (secties 7/12 — "Configureerbaar
 * door administrator"), zie CompanySettingsService. `logoDataUrl` is `null`
 * zolang er geen logo geüpload is (de PDF valt dan terug op een gestileerd
 * "UURIVO"-tekstlogo, zie work-order-pdf-document.ts).
 */
/**
 * Publieke, niet-geauthenticeerde branding voor het loginscherm — enkel
 * bedrijfsnaam + logo, nooit gevoelige instellingen (zie
 * company-settings.routes.ts, /public/branding).
 */
export interface PublicBrandingResponseBody {
  companyName: string;
  logoDataUrl: string | null;
}

export interface CompanySettingsResponseBody {
  companyName: string;
  addressLine: string | null;
  vatNumber: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  workOrderLegalText: string;
  logoDataUrl: string | null;
  /** Licentiebeperking (betaalplan) — `null` = geen limiet. */
  maxEmployees: number | null;
  /** Phase 12, deel D (sectie 5) — tarief per km (eurocent). `null` = km-vergoeding niet actief. */
  kmRateCents: number | null;
}

/**
 * Body van POST /admin/company-settings. Het logo is optioneel als base64 in
 * dezelfde JSON-body (zelfde reden als foto's/handtekening — zie
 * AddWorkOrderPhotoBody hierboven): weglaten laat het bestaande logo
 * ongemoeid, `removeLogo: true` verwijdert het (enkel relevant zonder nieuw
 * logo erbij).
 */
export interface UpdateCompanySettingsBody {
  companyName: string;
  addressLine?: string | null;
  vatNumber?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  workOrderLegalText?: string;
  logoMimeType?: 'image/png' | 'image/jpeg';
  logoDataBase64?: string;
  removeLogo?: boolean;
  /** Licentiebeperking (betaalplan) — `null` wist de limiet weer. */
  maxEmployees?: number | null;
  /** Phase 12, deel D (sectie 5) — tarief per km in eurocent. `null` schakelt de km-vergoeding uit. */
  kmRateCents?: number | null;
}

// ============================================================
// Phase 10 — facturatie-overzicht (sectie 17/29). Zie
// claude/phase10-facturatie-onderzoek.md (project docs): het effectief
// aanmaken van een Teamleader-conceptfactuur (`invoices.draft`) is bewust
// GEEN onderdeel van deze ronde — dit is enkel de lokale "voorbereid voor
// facturatie"-groepering.
// ============================================================

/** Enkel DRAFT is deze ronde bereikbaar — de rest staat al klaar voor de latere Teamleader-uitbreiding, zie InvoiceBatchStatus in schema.prisma. */
export type InvoiceBatchStatus = 'DRAFT' | 'SUBMITTED_TO_TEAMLEADER' | 'INVOICED';

/** Eén werkbon die klaar is om in een facturatiebatch opgenomen te worden — GET /admin/invoice-batches/invoiceable-work-orders. */
export interface InvoiceableWorkOrderSummary {
  id: string;
  workOrderNumber: string;
  /** ISO-datum, of `null` als de werkbon (uitzonderlijk) nog geen handtekening heeft — kan niet voorkomen bij status READY_FOR_INVOICING, maar het veld blijft defensief nullable. */
  signedAt: string | null;
  invoiceableSeconds: number;
  /** `hourlyRateCents` erbij sinds Phase 10b — zie Customer.hourlyRateCents. */
  customer: { id: string; name: string; hourlyRateCents: number | null };
  project: { id: string; name: string; projectNumber: string | null };
  employeeDisplayNames: string[];
}

export interface ListInvoiceableWorkOrdersResponseBody {
  workOrders: InvoiceableWorkOrderSummary[];
}

export interface InvoiceBatchLineSummary {
  id: string;
  workOrderId: string;
  workOrderNumber: string;
  projectName: string;
  invoiceableSeconds: number;
}

/**
 * Eén medewerker die op minstens één werkbon van deze InvoiceBatch voorkomt,
 * met het tarief waarmee zijn/haar uren geprijsd worden op de conceptfactuur.
 * `effectiveHourlyRateCents` is `overrideHourlyRateCents ?? defaultHourlyRateCents`
 * — `null` betekent dat er voor deze medewerker nog geen tarief is (noch een
 * standaardtarief in de instellingen, noch een eenmalige override op deze
 * batch) en "Maak conceptfactuur in Teamleader" dus nog niet mogelijk is.
 */
export interface InvoiceBatchEmployeeRateSummary {
  employeeId: string;
  displayName: string;
  defaultHourlyRateCents: number | null;
  overrideHourlyRateCents: number | null;
  effectiveHourlyRateCents: number | null;
}

/** Eén "voorbereiden voor facturatie"-groepering (InvoiceBatch). */
export interface InvoiceBatchSummary {
  id: string;
  customerId: string;
  customerName: string;
  /** @deprecated Sinds de overstap naar tarief-per-medewerker niet meer gebruikt om de conceptfactuur te prijzen — zie `employeeRates`. Blijft bestaan als Customer-veld, puur informatief. */
  customerHourlyRateCents: number | null;
  /** Medewerker(s) op deze batch en hun (standaard- of eenmalig ingevuld) uurtarief — zie InvoiceBatchEmployeeRateSummary. */
  employeeRates: InvoiceBatchEmployeeRateSummary[];
  periodLabel: string;
  status: InvoiceBatchStatus;
  totalInvoiceableSeconds: number;
  createdAt: string;
  lines: InvoiceBatchLineSummary[];
  /** Sinds Phase 10b — resultaat van de laatste `invoices.draft`-poging, zie InvoiceBatch in schema.prisma. */
  teamleaderInvoiceId: string | null;
  teamleaderSyncError: string | null;
  teamleaderSubmittedAt: string | null;
}

export interface ListInvoiceBatchesResponseBody {
  batches: InvoiceBatchSummary[];
}

/** Body van POST /admin/invoice-batches — de admin-actie "Voorbereiden voor facturatie". */
export interface CreateInvoiceBatchBody {
  customerId: string;
  /** bv. "2026-08" — vrije tekst, zie InvoiceBatch.periodLabel in schema.prisma. */
  periodLabel: string;
  workOrderIds: string[];
}

export interface CreateInvoiceBatchResponseBody {
  batch: InvoiceBatchSummary;
}

/**
 * Response van POST /admin/invoice-batches/:id/teamleader-draft (Phase 10b —
 * "Maak conceptfactuur in Teamleader", zie TeamleaderInvoiceService). Geeft
 * altijd de bijgewerkte batch terug, ook bij een mislukte Teamleader-aanroep
 * (business rule 9: de batch zelf gaat nooit verloren — `syncResult.success`
 * is dan `false` en `batch.teamleaderSyncError` bevat de mensentaal-fout).
 */
export interface CreateTeamleaderDraftInvoiceResponseBody {
  batch: InvoiceBatchSummary;
  syncResult: { success: boolean; message: string | null };
}

/** Body van POST /admin/invoice-batches/:id/employee-rates/:employeeId — `null` wist de override weer (valt dan terug op `Employee.defaultHourlyRateCents`, indien ingevuld). */
export interface UpdateInvoiceBatchEmployeeRateBody {
  hourlyRateCents: number | null;
}

export interface UpdateInvoiceBatchEmployeeRateResponseBody {
  batch: InvoiceBatchSummary;
}

/**
 * Phase 12, deel E — "Personeelsuitbetaling". Eén rij per medewerker voor een
 * gekozen periode; `totalAmountCents` is `null` zolang de medewerker geen
 * `Employee.defaultHourlyRateCents` heeft (zie UserDetailPage.tsx) — dan is
 * het uren-overzicht wel al bruikbaar, maar kan er nog geen batch van
 * gemaakt worden.
 */
export interface PayableEmployeeSummary {
  employeeId: string;
  displayName: string;
  normalHours: number;
  overtimeHours: number;
  shiftHours: number;
  nightHours: number;
  totalAmountCents: number | null;
}

export interface ListPayableSummaryResponseBody {
  employees: PayableEmployeeSummary[];
}

export interface PayrollBatchLineSummary {
  id: string;
  timeEntryId: string;
  projectName: string;
  normalHours: number;
  overtimeHours: number;
  premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK';
  amountCents: number;
}

export interface PayrollBatchSummary {
  id: string;
  employeeId: string;
  employeeDisplayName: string;
  periodLabel: string;
  status: 'DRAFT' | 'CLOSED';
  totalAmountCents: number;
  createdAt: string;
  closedAt: string | null;
  lines: PayrollBatchLineSummary[];
}

export interface ListPayrollBatchesResponseBody {
  batches: PayrollBatchSummary[];
}

/** Body van POST /admin/payroll/batches — de admin-actie "Afsluiten voor deze medewerker". */
export interface CreatePayrollBatchBody {
  employeeId: string;
  /** bv. "2026-08" — vrije tekst, zelfde conventie als InvoiceBatch.periodLabel. */
  periodLabel: string;
}

export interface CreatePayrollBatchResponseBody {
  batch: PayrollBatchSummary;
}

/**
 * Werknemer vs. Onderaannemer — maandelijkse uren-export (backlog-item 30/8).
 * Zie HoursExportService: dezelfde onderliggende urendata als het
 * facturatie-/loonoverzicht, maar twee verschillende exportvormen naargelang
 * `employmentType`:
 * - EMPLOYEE: opgenomen in de gedeelde Excel-export (GET /admin/hours-export/employees/excel).
 * - SUBCONTRACTOR: eigen totalisatie-met-detail-PDF (GET /admin/hours-export/subcontractors/:employeeId/pdf).
 */
export interface HoursExportEmployeeSummary {
  employeeId: string;
  displayName: string;
  employmentType: EmploymentType;
  /** Som van alle gewerkte seconden binnen de opgevraagde periode (enkel gestopte tijdregistraties op een ondertekende werkbon — zie HoursExportService). */
  totalSeconds: number;
  workOrderCount: number;
}

export interface HoursExportOverviewResponseBody {
  /** bv. "2026-08" — zelfde notatie als InvoiceBatch.periodLabel. */
  periodLabel: string;
  employees: HoursExportEmployeeSummary[];
}
