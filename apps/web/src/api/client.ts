import type {
  ApiErrorBody,
  CreateUserBody,
  CreateUserResponseBody,
  ListProjectAssignmentsResponseBody,
  ListProjectsResponseBody,
  ListUsersResponseBody,
  LoginResponseBody,
  PrepareAuthorizeResponseBody,
  ProjectSyncResponseBody,
  TeamleaderStatusResponseBody,
  UpdateUserBody,
  UpdateUserResponseBody,
} from '@swatt/shared-types';

/**
 * Altijd een lege string — elke `request()`-aanroep gaat dus naar een
 * relatief pad op hetzelfde domein als de frontend zelf.
 *
 * In dev stuurt de Vite-proxy /auth, /admin, /projects, /teamleader en
 * /health door naar de lokale API (zie vite.config.ts). In productie doet
 * Vercel exact hetzelfde via `rewrites` in apps/web/vercel.json, die deze
 * paden server-to-server doorsturen naar de Render-backend.
 *
 * BELANGRIJK — waarom niet gewoon rechtstreeks naar de Render-URL (zoals
 * vroeger via VITE_API_URL): frontend (Vercel) en backend (Render) staan op
 * verschillende domeinen, dus elke rechtstreekse `fetch()` was voor de
 * browser "cross-site". Dat maakte de sessiecookie afhankelijk van
 * cookie-instellingen die wij niet controleren — met SameSite=None;Secure
 * werkt dit meestal, maar zodra een gebruiker "cookies van derden
 * blokkeren" aanheeft staan (steeds vaker de standaard in Chrome/Android),
 * wordt de sessiecookie nooit opgeslagen/teruggestuurd en lijkt de
 * gebruiker random uitgelogd te raken (bevestigd: exact dit gebeurde bij
 * een test op Android Chrome — "Mijn projecten" gaf NOT_AUTHENTICATED
 * terwijl inloggen zelf leek te lukken). Door alles via hetzelfde domein
 * als de frontend te laten lopen (Vercel-rewrite-proxy), is de
 * sessiecookie voor de browser gewoon "first-party" en speelt dat
 * cookiebeleid geen rol meer.
 */
const API_BASE_URL = '';

/**
 * Enige uitzondering: de Teamleader OAuth-`/authorize`-navigatie hieronder
 * (`teamleaderApi.connect`) moet bewust rechtstreeks naar de Render-URL
 * blijven gaan, NIET via de Vercel-proxy. Die navigatie zet en leest een
 * eigen state-cookie in een Render-naar-Render-navigatieketen (browser →
 * Render/authorize → Teamleader → Render/callback) die vandaag al correct
 * werkt en hier bewust ongemoeid gelaten wordt — zie de uitgebreide
 * toelichting bij AUTHORIZE_HANDOFF_TTL_MS in teamleader.routes.ts.
 */
const TEAMLEADER_DIRECT_API_URL: string = import.meta.env.VITE_API_URL ?? '';

export class ApiRequestError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    credentials: 'include', // stuurt/ontvangt de httpOnly sessiecookie
    headers: {
      // BELANGRIJK: `text/plain` i.p.v. `application/json` als Content-Type.
      // Een cross-origin request met een JSON-content-type is nooit een
      // CORS-"simple request" en triggert dus altijd een OPTIONS-preflight.
      // Render's edge geeft op die preflight een niet-JSON 404 terug vóór
      // onze eigen backend ooit bereikt wordt (bevestigd via grondig
      // onderzoek — zie apps/api/src/app.ts). `text/plain` staat wél op de
      // CORS-safelist, dus dit vermijdt de preflight volledig; de body blijft
      // gewoon JSON (de backend parset `text/plain` expliciet als JSON, zie
      // addContentTypeParser in app.ts). Alleen toevoegen wanneer er ook echt
      // een body is — een kale GET zonder headers is sowieso al "simple".
      ...(init.body ? { 'Content-Type': 'text/plain' } : {}),
      ...init.headers,
    },
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const body = (await response.json()) as T | ApiErrorBody;

  if (!response.ok) {
    const errorBody = body as ApiErrorBody;
    throw new ApiRequestError(
      errorBody.error?.code ?? 'UNKNOWN_ERROR',
      errorBody.error?.message ?? 'Er ging iets mis. Probeer het later opnieuw.',
    );
  }

  return body as T;
}

export const authApi = {
  login: (email: string, password: string) =>
    request<LoginResponseBody>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<LoginResponseBody>('/auth/me', { method: 'GET' }),
};

export const teamleaderApi = {
  status: () => request<TeamleaderStatusResponseBody>('/teamleader/status', { method: 'GET' }),
  disconnect: () => request<void>('/teamleader/oauth/disconnect', { method: 'POST' }),
  /**
   * Twee stappen, bewust: (1) een gewone, cookie-geauthenticeerde fetch-call
   * die een kortlevend eenmalig token ophaalt, gevolgd door (2) een echte
   * top-level browsernavigatie naar onze eigen /authorize-route (die op haar
   * beurt doorstuurt naar Teamleader) met dat token in de URL. Waarom niet
   * gewoon een `<a href>` met een cookie-check op de navigatie zelf: zie de
   * uitgebreide toelichting bij AUTHORIZE_HANDOFF_TTL_MS in
   * teamleader.routes.ts — cross-site cookiebescherming in moderne browsers
   * (Firefox Total Cookie Protection e.d.) maakt de gewone sessiecookie
   * onbetrouwbaar op het exacte moment van een top-level navigatie naar een
   * ander domein (Vercel → Render).
   */
  connect: async (): Promise<void> => {
    const { token } = await request<PrepareAuthorizeResponseBody>('/teamleader/oauth/prepare-authorize', {
      method: 'POST',
    });
    window.location.href = `${TEAMLEADER_DIRECT_API_URL}/teamleader/oauth/authorize?token=${encodeURIComponent(token)}`;
  },
  syncProjects: () => request<ProjectSyncResponseBody>('/admin/teamleader/sync/projects', { method: 'POST' }),
};

/**
 * Admin-only gebruikersbeheer. Bewust POST i.p.v. PATCH voor de update-call
 * (`.../update`) — zie het commentaar bij ProjectAssignmentBody in
 * shared-types over waarom deze app PATCH/DELETE structureel vermijdt.
 */
export const usersApi = {
  list: () => request<ListUsersResponseBody>('/admin/users', { method: 'GET' }),
  create: (body: CreateUserBody) =>
    request<CreateUserResponseBody>('/admin/users', { method: 'POST', body: JSON.stringify(body) }),
  update: (userId: string, body: UpdateUserBody) =>
    request<UpdateUserResponseBody>(`/admin/users/${userId}/update`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

export const projectsApi = {
  list: (search?: string) =>
    request<ListProjectsResponseBody>(`/projects${search ? `?search=${encodeURIComponent(search)}` : ''}`, {
      method: 'GET',
    }),
  mine: () => request<ListProjectsResponseBody>('/projects/mine', { method: 'GET' }),
  assignments: {
    list: (employeeId: string) =>
      request<ListProjectAssignmentsResponseBody>(`/admin/employees/${employeeId}/project-assignments`, {
        method: 'GET',
      }),
    assign: (employeeId: string, projectId: string) =>
      request<void>(`/admin/employees/${employeeId}/project-assignments`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      }),
    unassign: (employeeId: string, projectId: string) =>
      request<void>(`/admin/employees/${employeeId}/project-assignments/remove`, {
        method: 'POST',
        body: JSON.stringify({ projectId }),
      }),
  },
};
