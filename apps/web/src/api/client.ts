import type { ApiErrorBody, LoginResponseBody } from '@swatt/shared-types';

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
