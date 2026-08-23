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
}

export interface LoginResponseBody {
  user: AuthenticatedUser;
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
  password: string;
  displayName: string;
  role: UserRole;
  phone?: string;
}

export interface CreateUserResponseBody {
  user: AdminUserSummary;
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
