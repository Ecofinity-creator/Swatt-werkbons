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
