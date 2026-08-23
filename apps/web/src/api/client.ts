import type {
  ApiErrorBody,
  CreateUserBody,
  CreateUserResponseBody,
  ListProjectAssignmentsResponseBody,
  ListProjectsResponseBody,
  ListUsersResponseBody,
  LoginResponseBody,
  ProjectSyncResponseBody,
  TeamleaderStatusResponseBody,
  UpdateUserBody,
  UpdateUserResponseBody,
} from '@swatt/shared-types';

/**
 * Lege string in dev (Vite-proxy stuurt /auth en /health door naar de API,
 * zie vite.config.ts); in productie zet je VITE_API_URL naar de Render-backend-URL.
 */
const API_BASE_URL: string = import.meta.env.VITE_API_URL ?? '';

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
   * Bewust GEEN `request()`-fetch-call: dit moet een echte browser-navigatie
   * zijn (`<a href={...}>`), niet een `fetch()` — de backend antwoordt met
   * een 302-redirect naar Teamleader's eigen toestemmingsscherm, en enkel
   * een top-level navigatie kan die browser daadwerkelijk volgen.
   */
  authorizeUrl: (): string => `${API_BASE_URL}/teamleader/oauth/authorize`,
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
