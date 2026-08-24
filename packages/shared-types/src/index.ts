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
  } | null;
  createdAt: string;
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
}

/** Body van POST /admin/users/:id/update — alle velden optioneel (partial update). */
export interface UpdateUserBody {
  role?: UserRole;
  isActive?: boolean;
  displayName?: string;
  phone?: string | null;
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
}

export interface ListProjectsResponseBody {
  projects: ProjectSummary[];
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

export interface WorkOrderSummary {
  id: string;
  workOrderNumber: string;
  projectId: string;
  projectName: string;
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
