import type {
  ActiveTimeEntryResponseBody,
  AddWorkOrderPhotoBody,
  ApiErrorBody,
  CompanySettingsResponseBody,
  CreateInvoiceBatchBody,
  CreateInvoiceBatchResponseBody,
  CreateManualTimeEntryBody,
  CreateTeamleaderDraftInvoiceResponseBody,
  CreateUserBody,
  CreateUserResponseBody,
  HoursExportOverviewResponseBody,
  ListInvoiceBatchesResponseBody,
  ListInvoiceableWorkOrdersResponseBody,
  ListProjectAssignmentsResponseBody,
  ListProjectsResponseBody,
  ListTeamleaderUsersResponseBody,
  ListUsersResponseBody,
  ListWorkOrderSyncIssuesResponseBody,
  LinkTeamleaderUserBody,
  LoginResponseBody,
  MilestoneSyncResponseBody,
  PrepareAuthorizeResponseBody,
  ProjectSyncResponseBody,
  CreateWorkOrderBody,
  ResendInviteResponseBody,
  RetryWorkOrderSyncResponseBody,
  SelectProjectMilestoneResponseBody,
  UpdateProjectAssignmentPremiumsResponseBody,
  UpdateProjectInvoicingEnabledResponseBody,
  UpdateProjectOvertimeSettingsResponseBody,
  UpdateProjectSigningModeResponseBody,
  SignWorkOrderBody,
  PendingWeekResponseBody,
  SignWeekBody,
  SignWeekResponseBody,
  TeamleaderInvoiceOptionsResponseBody,
  TeamleaderSettingsResponseBody,
  TeamleaderStatusResponseBody,
  TimeEntryResponseBody,
  UpdateCompanySettingsBody,
  UpdateCustomerHourlyRateBody,
  UpdateCustomerHourlyRateResponseBody,
  UpdateInvoiceBatchEmployeeRateBody,
  UpdateInvoiceBatchEmployeeRateResponseBody,
  UpdateTeamleaderSettingsBody,
  UpdateUserBody,
  UpdateUserResponseBody,
  WorkOrderResponseBody,
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
  login: (email: string, password: string, rememberMe = false) =>
    request<LoginResponseBody>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, rememberMe }),
    }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  me: () => request<LoginResponseBody>('/auth/me', { method: 'GET' }),
  /**
   * Antwoord is altijd 204, ook als het e-mailadres niet bestaat — de
   * backend geeft bewust nooit prijs of een account bestaat (voorkomt
   * account-enumeratie). De UI moet dus altijd dezelfde neutrale
   * bevestiging tonen, ongeacht wat hier terugkomt.
   */
  forgotPassword: (email: string) =>
    request<void>('/auth/forgot-password', { method: 'POST', body: JSON.stringify({ email }) }),
  /** `token` komt uit de link in de uitnodigings-/reset-e-mail (querystring). */
  resetPassword: (token: string, password: string) =>
    request<void>('/auth/reset-password', { method: 'POST', body: JSON.stringify({ token, password }) }),
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
  /**
   * Phase 9 — instelling voor automatische milestone-aanmaak (sectie 14,
   * `milestones.create`'s verplichte `responsible_user_id`), zie
   * MilestoneSyncService.resolveOrCreateTeamleaderMilestoneId.
   */
  settings: {
    get: () => request<TeamleaderSettingsResponseBody>('/admin/teamleader/settings', { method: 'GET' }),
    update: (body: UpdateTeamleaderSettingsBody) =>
      request<TeamleaderSettingsResponseBody>('/admin/teamleader/settings', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },
  /**
   * Phase 10b — vult de "Facturatie-instellingen"-dropdowns. `departmentId`
   * weglaten geeft enkel departementen/betalingstermijnen terug (taxRates
   * is dan altijd leeg — die lijst is afhankelijk van het gekozen departement).
   */
  invoiceOptions: (departmentId?: string) =>
    request<TeamleaderInvoiceOptionsResponseBody>(
      `/admin/teamleader/invoice-options${departmentId ? `?departmentId=${encodeURIComponent(departmentId)}` : ''}`,
      { method: 'GET' },
    ),
};

/** Phase 10b — enkel het uurtarief-veld van een klant (sectie 17-uitbreiding, zie Customer.hourlyRateCents). */
export const customersApi = {
  updateHourlyRate: (customerId: string, body: UpdateCustomerHourlyRateBody) =>
    request<UpdateCustomerHourlyRateResponseBody>(`/admin/customers/${customerId}/hourly-rate`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

/** Admin-instellingenscherm "Bedrijfsgegevens" (secties 7/12 — logo/adres/btw/contact op de werkbon-PDF). */
export const companySettingsApi = {
  get: () => request<CompanySettingsResponseBody>('/admin/company-settings', { method: 'GET' }),
  update: (body: UpdateCompanySettingsBody) =>
    request<CompanySettingsResponseBody>('/admin/company-settings', { method: 'POST', body: JSON.stringify(body) }),
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
  /**
   * Zelfde route accepteert zowel UpdateUserBody-velden (rol, actief, ...)
   * als de Phase 9-koppeling (teamleaderUserId) — zie LinkTeamleaderUserBody
   * in shared-types en user.routes.ts.
   */
  update: (userId: string, body: UpdateUserBody & LinkTeamleaderUserBody) =>
    request<UpdateUserResponseBody>(`/admin/users/${userId}/update`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  /** Phase 9 — live opvraging van Teamleader-gebruikers voor de koppelingsdropdown (zie teamleader-user.service.ts). */
  teamleaderUsers: () => request<ListTeamleaderUsersResponseBody>('/admin/teamleader/users', { method: 'GET' }),
  /** Opnieuw uitnodigen — bv. wanneer de eerste uitnodigingsmail niet aankwam. */
  resendInvite: (userId: string) =>
    request<ResendInviteResponseBody>(`/admin/users/${userId}/resend-invite`, { method: 'POST' }),
  /** Volledig verwijderen — enkel mogelijk zonder bestaande tijdregistraties/werkbonnen, zie user.routes.ts. */
  remove: (userId: string) => request<void>(`/admin/users/${userId}/delete`, { method: 'POST' }),
};

/**
 * Phase 4 — timer ("START WERK"). Elke aanroep werkt op de EIGEN
 * tijdsregistratie van de ingelogde gebruiker — er is bewust geen
 * `employeeId`-parameter nodig, de backend leidt dat af uit de sessie
 * (zie apps/api/src/modules/time-entries/time-entry.routes.ts).
 */
export const timeEntriesApi = {
  active: () => request<ActiveTimeEntryResponseBody>('/time-entries/active', { method: 'GET' }),
  start: (projectId: string) =>
    request<TimeEntryResponseBody>('/time-entries/start', { method: 'POST', body: JSON.stringify({ projectId }) }),
  pause: (timeEntryId: string) =>
    request<TimeEntryResponseBody>(`/time-entries/${timeEntryId}/pause`, { method: 'POST' }),
  resume: (timeEntryId: string) =>
    request<TimeEntryResponseBody>(`/time-entries/${timeEntryId}/resume`, { method: 'POST' }),
  stop: (timeEntryId: string, description?: string) =>
    request<TimeEntryResponseBody>(`/time-entries/${timeEntryId}/stop`, {
      method: 'POST',
      body: JSON.stringify(description ? { description } : {}),
    }),
  /** Sectie 6 — "manueel tijd toevoegen indien toegestaan": vaste start-/eindtijd i.p.v. de timer. */
  createManual: (body: CreateManualTimeEntryBody) =>
    request<TimeEntryResponseBody>('/time-entries/manual', { method: 'POST', body: JSON.stringify(body) }),
};

/**
 * Phase 5 — werkbonnen (basis). `create` wordt automatisch aangeroepen
 * meteen na een geslaagde `timeEntriesApi.stop()` (zie ProjectTimerPage.tsx)
 * — er is bewust geen aparte "werkbon aanmaken"-knop, in lijn met sectie 1
 * van de brief ("controleert werkbon" is een controle-stap, geen aparte
 * aanmaak-actie).
 */
export const workOrdersApi = {
  create: (body: CreateWorkOrderBody) =>
    request<WorkOrderResponseBody>('/work-orders', { method: 'POST', body: JSON.stringify(body) }),
  get: (workOrderId: string) => request<WorkOrderResponseBody>(`/work-orders/${workOrderId}`, { method: 'GET' }),
  /** Phase 7 — verplichte klanthandtekening (sectie 10). Zet de werkbon DRAFT → SIGNED. */
  sign: (workOrderId: string, body: SignWorkOrderBody) =>
    request<WorkOrderResponseBody>(`/work-orders/${workOrderId}/sign`, { method: 'POST', body: JSON.stringify(body) }),
  /**
   * Phase 8 — handmatige herstelactie bij pdfStatus === 'PDF_FAILED'
   * (sectie 13). Het downloaden van de PDF zelf gaat NIET via deze client —
   * dat is een gewone `<a href="/work-orders/:id/pdf">`-link (zie
   * WorkOrderReviewPage.tsx), die dezelfde sessiecookie meestuurt als een
   * normale paginanavigatie.
   */
  regeneratePdf: (workOrderId: string) =>
    request<WorkOrderResponseBody>(`/work-orders/${workOrderId}/pdf/regenerate`, { method: 'POST' }),
  /**
   * Phase 9 — sectie 13: "Administrator moet handmatig: Opnieuw
   * synchroniseren kunnen kiezen". Herqueuet enkel de nog-niet-geslaagde
   * synctypes (uren/PDF) — zie SyncJobService.retry.
   */
  retrySync: (workOrderId: string) =>
    request<RetryWorkOrderSyncResponseBody>(`/work-orders/${workOrderId}/sync/retry`, { method: 'POST' }),
};

/**
 * Phase 12, deel B (sectie 2) — "werkbonnen per week laten tekenen door de
 * klant". Enkel relevant op een project met `signingMode = 'WEEKLY'`
 * (zie WorkOrderSummary.projectSigningMode).
 */
export const weeklyApprovalApi = {
  /** Openstaande werkbonnen van de LOPENDE week op dit project waarbij de ingelogde medewerker betrokken is. */
  pendingWeek: (projectId: string) =>
    request<PendingWeekResponseBody>(`/work-orders/pending-week?projectId=${encodeURIComponent(projectId)}`, {
      method: 'GET',
    }),
  /** Tekent in één keer alle openstaande werkbonnen van de lopende week op dit project (over alle medewerkers heen). */
  signWeek: (projectId: string, body: SignWeekBody) =>
    request<SignWeekResponseBody>(`/weekly-approvals/${projectId}/sign`, { method: 'POST', body: JSON.stringify(body) }),
};

/** Phase 9 — overzicht "Synchronisatiefouten" (sectie 4/13). */
export const syncIssuesApi = {
  list: () => request<ListWorkOrderSyncIssuesResponseBody>('/admin/work-orders/sync-issues', { method: 'GET' }),
};

/** Phase 10 — facturatie-overzicht (sectie 17/29). */
export const invoiceBatchesApi = {
  listInvoiceable: (filters: { customerId?: string; projectId?: string; employeeId?: string; periodLabel?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.customerId) params.set('customerId', filters.customerId);
    if (filters.projectId) params.set('projectId', filters.projectId);
    if (filters.employeeId) params.set('employeeId', filters.employeeId);
    if (filters.periodLabel) params.set('periodLabel', filters.periodLabel);
    const query = params.toString();
    return request<ListInvoiceableWorkOrdersResponseBody>(
      `/admin/invoice-batches/invoiceable-work-orders${query ? `?${query}` : ''}`,
      { method: 'GET' },
    );
  },
  list: (filters: { customerId?: string; periodLabel?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.customerId) params.set('customerId', filters.customerId);
    if (filters.periodLabel) params.set('periodLabel', filters.periodLabel);
    const query = params.toString();
    return request<ListInvoiceBatchesResponseBody>(`/admin/invoice-batches${query ? `?${query}` : ''}`, { method: 'GET' });
  },
  create: (body: CreateInvoiceBatchBody) =>
    request<CreateInvoiceBatchResponseBody>('/admin/invoice-batches', { method: 'POST', body: JSON.stringify(body) }),
  remove: (id: string) => request<void>(`/admin/invoice-batches/${id}/remove`, { method: 'POST' }),
  /** Phase 10b — sectie 17: "Maak conceptfactuur in Teamleader". Geeft altijd de bijgewerkte batch terug, ook bij een mislukte Teamleader-aanroep (business rule 9). */
  createTeamleaderDraft: (id: string) =>
    request<CreateTeamleaderDraftInvoiceResponseBody>(`/admin/invoice-batches/${id}/teamleader-draft`, { method: 'POST' }),  /** Facturatie: eenmalige tariefoverride voor één medewerker op deze batch (zie InvoiceBatchService.setEmployeeRate). */
  setEmployeeRate: (batchId: string, employeeId: string, body: UpdateInvoiceBatchEmployeeRateBody) =>
    request<UpdateInvoiceBatchEmployeeRateResponseBody>(`/admin/invoice-batches/${batchId}/employee-rates/${employeeId}`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
};

/**
 * Werknemer vs. Onderaannemer — maandelijkse uren-export (backlog-item 30/8).
 * Enkel `overview` gaat via deze client (JSON) — het downloaden van de
 * Excel-/PDF-bestanden zelf gaat NIET via `request()` (die parset altijd
 * `response.json()`), maar via een gewone `<a download href="...">`-link
 * (zie HoursExportPage.tsx), zelfde patroon als de werkbon-PDF-download in
 * WorkOrderReviewPage.tsx.
 */
export const hoursExportApi = {
  overview: (periodLabel: string) =>
    request<HoursExportOverviewResponseBody>(`/admin/hours-export/overview?period=${encodeURIComponent(periodLabel)}`, {
      method: 'GET',
    }),
};

/**
 * Phase 6 — foto's op een werkbon (sectie 9). `add`/`remove` geven telkens de
 * volledige, bijgewerkte werkbon terug (i.p.v. enkel de gewijzigde foto) —
 * eenvoudiger voor de UI, die toch meteen de volledige fotolijst opnieuw wil tonen.
 */
export const workOrderPhotosApi = {
  add: (workOrderId: string, body: AddWorkOrderPhotoBody) =>
    request<WorkOrderResponseBody>(`/work-orders/${workOrderId}/photos`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  remove: (workOrderId: string, photoId: string) =>
    request<WorkOrderResponseBody>(`/work-orders/${workOrderId}/photos/${photoId}/remove`, { method: 'POST' }),
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
    /** Phase 12, deel A (sectie 1) — overuren/ploegenwerk/nachtwerk voor deze specifieke koppeling. SUPERVISOR+. */
    updatePremiums: (employeeId: string, projectId: string, overtimeApplies: boolean, premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK') =>
      request<UpdateProjectAssignmentPremiumsResponseBody>(`/admin/employees/${employeeId}/project-assignments/premiums`, {
        method: 'POST',
        body: JSON.stringify({ projectId, overtimeApplies, premiumType }),
      }),
  },
  /**
   * Phase 9 — de "flexibele" milestone-strategie (zie MilestoneSyncService):
   * een supervisor haalt de legacy-milestones van een project op en kiest er
   * eentje om de werkbon-uren van dat project te ontvangen (sectie 14).
   */
  milestones: {
    sync: (projectId: string) =>
      request<MilestoneSyncResponseBody>(`/admin/projects/${projectId}/milestones/sync`, { method: 'POST' }),
    select: (projectId: string, milestoneId: string | null) =>
      request<SelectProjectMilestoneResponseBody>(`/admin/projects/${projectId}/milestones/select`, {
        method: 'POST',
        body: JSON.stringify({ milestoneId }),
      }),
  },
  /** Phase 12, deel C (sectie 3) — facturatie uitschakelen per project (enkel nacalculatie). ADMIN-only. */
  invoicing: {
    update: (projectId: string, invoicingEnabled: boolean) =>
      request<UpdateProjectInvoicingEnabledResponseBody>(`/admin/projects/${projectId}/invoicing-enabled`, {
        method: 'POST',
        body: JSON.stringify({ invoicingEnabled }),
      }),
  },
  /** Phase 12, deel A (sectie 1) — "Overuren boven 8u/dag" of "Overuren boven [x]u/week". ADMIN-only. */
  overtimeSettings: {
    update: (projectId: string, overtimeThresholdType: 'DAILY' | 'WEEKLY', overtimeWeeklyThresholdHours: number | null) =>
      request<UpdateProjectOvertimeSettingsResponseBody>(`/admin/projects/${projectId}/overtime-settings`, {
        method: 'POST',
        body: JSON.stringify({ overtimeThresholdType, overtimeWeeklyThresholdHours }),
      }),
  },
  /** Phase 12, deel B (sectie 2) — "Ondertekening per werkbon" of "Ondertekening per week". ADMIN-only. */
  signingMode: {
    update: (projectId: string, signingMode: 'PER_WORK_ORDER' | 'WEEKLY') =>
      request<UpdateProjectSigningModeResponseBody>(`/admin/projects/${projectId}/signing-mode`, {
        method: 'POST',
        body: JSON.stringify({ signingMode }),
      }),
  },
};
