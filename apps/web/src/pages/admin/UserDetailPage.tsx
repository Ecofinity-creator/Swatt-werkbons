import type { AdminUserSummary, EmploymentType, ProjectSummary, TeamleaderUserOption, UserRole } from '@swatt/shared-types';
import { EMPLOYMENT_TYPES, USER_ROLES } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { projectsApi, usersApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';
import { EMPLOYMENT_TYPE_LABELS, ROLE_LABELS } from '../../constants';

/**
 * Detail van één medewerker: rol/actief-status wijzigen, en — het stuk dat nu
 * expliciet gevraagd is — koppelen aan Teamleader-projecten, zodat deze
 * medewerker enkel díe projecten kan selecteren om uren op te boeken
 * (zie GET /projects/mine, EmployeeProjectsPage.tsx).
 *
 * Er bestaat (nog) geen GET /admin/users/:id — deze pagina haalt de volledige
 * lijst op en zoekt de gevraagde gebruiker eruit. Prima voor de verwachte
 * MVP-schaal (tientallen medewerkers); een aparte detail-route is een
 * triviale latere toevoeging zodra dat niet meer volstaat.
 */
export function UserDetailPage() {
  const navigate = useNavigate();
  const { userId } = useParams<{ userId: string }>();
  const [user, setUser] = useState<AdminUserSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSavingUser, setIsSavingUser] = useState(false);

  const [allProjects, setAllProjects] = useState<ProjectSummary[] | null>(null);
  const [assignedProjectIds, setAssignedProjectIds] = useState<Set<string>>(new Set());
  const [projectSearch, setProjectSearch] = useState('');
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  // Opnieuw uitnodigen / volledig verwijderen — zie usersApi.resendInvite/remove.
  const [isResendingInvite, setIsResendingInvite] = useState(false);
  const [resendInviteMessage, setResendInviteMessage] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Phase 9 — koppeling met een Teamleader-gebruiker (sectie 14: `timeTracking.add`'s `user_id`).
  const [teamleaderUsers, setTeamleaderUsers] = useState<TeamleaderUserOption[] | null>(null);
  const [isSavingTeamleaderLink, setIsSavingTeamleaderLink] = useState(false);

  // Facturatie: standaard uurtarief per medewerker (zie Employee.defaultHourlyRateCents).
  const [hourlyRateInputValue, setHourlyRateInputValue] = useState('');
  const [isSavingHourlyRate, setIsSavingHourlyRate] = useState(false);
  const [hourlyRateError, setHourlyRateError] = useState<string | null>(null);

  // Phase 12, deel A (sectie 1) — toeslagpercentages, admin-only.
  const [overtimeRateInput, setOvertimeRateInput] = useState('150');
  const [shiftWorkRateInput, setShiftWorkRateInput] = useState('120');
  const [nightWorkRateInput, setNightWorkRateInput] = useState('150');
  const [isSavingPremiumRates, setIsSavingPremiumRates] = useState(false);
  const [premiumRatesError, setPremiumRatesError] = useState<string | null>(null);

  // Phase 12, deel A — toeslaginstelling per koppeling (projectId → instelling).
  const [assignmentPremiums, setAssignmentPremiums] = useState<Map<string, { overtimeApplies: boolean; premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK' }>>(
    new Map(),
  );
  const [pendingPremiumsProjectId, setPendingPremiumsProjectId] = useState<string | null>(null);

  // Werknemer vs. Onderaannemer (backlog-item 30/8) — bepaalt welk soort
  // document deze persoon krijgt bij de maandelijkse uren-export (zie
  // HoursExportPage.tsx).
  const [isSavingEmploymentType, setIsSavingEmploymentType] = useState(false);
  const [employmentTypeError, setEmploymentTypeError] = useState<string | null>(null);

  const loadUser = useCallback(async () => {
    if (!userId) return;
    try {
      const response = await usersApi.list();
      const found = response.users.find((u) => u.id === userId) ?? null;
      setUser(found);
      if (!found) setErrorMessage('Deze gebruiker werd niet gevonden.');
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de gebruiker niet ophalen.');
    }
  }, [userId]);

  const loadAssignments = useCallback(async (employeeId: string) => {
    const response = await projectsApi.assignments.list(employeeId);
    setAssignedProjectIds(new Set(response.projectIds));
    setAssignmentPremiums(new Map(response.assignments.map((a) => [a.projectId, { overtimeApplies: a.overtimeApplies, premiumType: a.premiumType }])));
  }, []);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

  useEffect(() => {
    if (user?.employee) {
      setHourlyRateInputValue(
        user.employee.defaultHourlyRateCents !== null ? (user.employee.defaultHourlyRateCents / 100).toFixed(2) : '',
      );
      setOvertimeRateInput(String(user.employee.overtimeRatePercent));
      setShiftWorkRateInput(String(user.employee.shiftWorkRatePercent));
      setNightWorkRateInput(String(user.employee.nightWorkRatePercent));
    }
  }, [user?.employee]);

  useEffect(() => {
    if (user?.employee) void loadAssignments(user.employee.id);
  }, [user?.employee, loadAssignments]);

  useEffect(() => {
    projectsApi
      .list(projectSearch || undefined)
      .then((response) => setAllProjects(response.projects))
      .catch(() => setAllProjects([]));
  }, [projectSearch]);

  useEffect(() => {
    usersApi
      .teamleaderUsers()
      .then((response) => setTeamleaderUsers(response.users))
      .catch(() => setTeamleaderUsers([]));
  }, []);

  async function updateTeamleaderUserId(teamleaderUserId: string) {
    if (!userId) return;
    setIsSavingTeamleaderLink(true);
    try {
      const response = await usersApi.update(userId, { teamleaderUserId: teamleaderUserId || null });
      setUser(response.user);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Koppelen aan een Teamleader-gebruiker is mislukt.');
    } finally {
      setIsSavingTeamleaderLink(false);
    }
  }

  /** Facturatie: standaard uurtarief van deze medewerker. Leeg opslaan wist het weer (dan kan het nog steeds eenmalig ingevuld worden bij het aanmaken van een factuur, zie InvoicingPage). */
  async function saveHourlyRate() {
    if (!userId) return;
    const trimmed = hourlyRateInputValue.trim().replace(',', '.');
    const euros = trimmed === '' ? null : Number(trimmed);
    if (trimmed !== '' && (Number.isNaN(euros) || (euros as number) <= 0)) {
      setHourlyRateError('Vul een geldig bedrag in (bv. 65,00), of laat leeg om het tarief te wissen.');
      return;
    }
    setIsSavingHourlyRate(true);
    setHourlyRateError(null);
    try {
      const response = await usersApi.update(userId, {
        defaultHourlyRateCents: euros === null ? null : Math.round(euros * 100),
      });
      setUser(response.user);
    } catch (err) {
      setHourlyRateError(err instanceof ApiRequestError ? err.message : 'Opslaan van het uurtarief is mislukt.');
    } finally {
      setIsSavingHourlyRate(false);
    }
  }

  /** Phase 12, deel A (sectie 1) — de drie toeslagpercentages van deze medewerker (admin-only, business rule 11). */
  async function savePremiumRates() {
    if (!userId) return;
    const parsePercent = (value: string) => {
      const n = Number(value.trim());
      return Number.isInteger(n) && n >= 100 && n <= 500 ? n : null;
    };
    const overtimeRatePercent = parsePercent(overtimeRateInput);
    const shiftWorkRatePercent = parsePercent(shiftWorkRateInput);
    const nightWorkRatePercent = parsePercent(nightWorkRateInput);
    if (overtimeRatePercent === null || shiftWorkRatePercent === null || nightWorkRatePercent === null) {
      setPremiumRatesError('Vul voor elk percentage een geheel getal tussen 100 en 500 in.');
      return;
    }
    setIsSavingPremiumRates(true);
    setPremiumRatesError(null);
    try {
      const response = await usersApi.update(userId, { overtimeRatePercent, shiftWorkRatePercent, nightWorkRatePercent });
      setUser(response.user);
    } catch (err) {
      setPremiumRatesError(err instanceof ApiRequestError ? err.message : 'Opslaan van de toeslagpercentages is mislukt.');
    } finally {
      setIsSavingPremiumRates(false);
    }
  }

  /** Phase 12, deel A — toeslaginstelling van één koppeling (overuren van toepassing + ploegen-/nachtwerk). */
  async function updateAssignmentPremiums(projectId: string, patch: Partial<{ overtimeApplies: boolean; premiumType: 'NONE' | 'SHIFT_WORK' | 'NIGHT_WORK' }>) {
    if (!user?.employee) return;
    const employeeId = user.employee.id;
    const current = assignmentPremiums.get(projectId) ?? { overtimeApplies: false, premiumType: 'NONE' as const };
    const next = { ...current, ...patch };

    setPendingPremiumsProjectId(projectId);
    setAssignmentPremiums((prev) => new Map(prev).set(projectId, next));
    try {
      await projectsApi.assignments.updatePremiums(employeeId, projectId, next.overtimeApplies, next.premiumType);
    } catch (err) {
      setAssignmentPremiums((prev) => new Map(prev).set(projectId, current)); // terugzetten bij fout
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Opslaan van de toeslaginstelling is mislukt.');
    } finally {
      setPendingPremiumsProjectId(null);
    }
  }

  async function updateEmploymentType(employmentType: EmploymentType) {
    if (!userId) return;
    setIsSavingEmploymentType(true);
    setEmploymentTypeError(null);
    try {
      const response = await usersApi.update(userId, { employmentType });
      setUser(response.user);
    } catch (err) {
      setEmploymentTypeError(err instanceof ApiRequestError ? err.message : 'Wijzigen van het type medewerker is mislukt.');
    } finally {
      setIsSavingEmploymentType(false);
    }
  }

  async function updateRole(role: UserRole) {
    if (!userId) return;
    setIsSavingUser(true);
    try {
      const response = await usersApi.update(userId, { role });
      setUser(response.user);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Wijzigen van de rol is mislukt.');
    } finally {
      setIsSavingUser(false);
    }
  }

  async function toggleActive() {
    if (!userId || !user) return;
    setIsSavingUser(true);
    try {
      const response = await usersApi.update(userId, { isActive: !user.isActive });
      setUser(response.user);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Wijzigen van de status is mislukt.');
    } finally {
      setIsSavingUser(false);
    }
  }

  /** Opnieuw uitnodigen — bv. wanneer de eerste uitnodigingsmail niet aankwam. */
  async function handleResendInvite() {
    if (!userId) return;
    setIsResendingInvite(true);
    setResendInviteMessage(null);
    try {
      const response = await usersApi.resendInvite(userId);
      setResendInviteMessage(
        response.inviteEmailSent
          ? 'Uitnodigingsmail opnieuw verstuurd.'
          : 'De uitnodiging kon niet verstuurd worden. Controleer de e-mailconfiguratie.',
      );
    } catch (err) {
      setResendInviteMessage(err instanceof ApiRequestError ? err.message : 'Opnieuw uitnodigen is mislukt.');
    } finally {
      setIsResendingInvite(false);
    }
  }

  /** Volledig verwijderen — enkel mogelijk zonder bestaande tijdregistraties/werkbonnen (zie user.routes.ts). */
  async function handleDelete() {
    if (!userId || !user) return;
    // eslint-disable-next-line no-alert
    if (!window.confirm(`${user.employee?.displayName ?? user.email} volledig verwijderen? Dit kan niet ongedaan gemaakt worden.`)) return;
    setIsDeleting(true);
    setErrorMessage(null);
    try {
      await usersApi.remove(userId);
      navigate('/backoffice/medewerkers');
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Verwijderen is mislukt.');
      setIsDeleting(false);
    }
  }

  async function toggleProject(project: ProjectSummary) {
    if (!user?.employee) return;
    const employeeId = user.employee.id;
    const isAssigned = assignedProjectIds.has(project.id);
    setPendingProjectId(project.id);

    // Optimistisch bijwerken — voelt direct aan; bij een fout zetten we terug.
    setAssignedProjectIds((prev) => {
      const next = new Set(prev);
      if (isAssigned) next.delete(project.id);
      else next.add(project.id);
      return next;
    });

    try {
      if (isAssigned) {
        await projectsApi.assignments.unassign(employeeId, project.id);
        setAssignmentPremiums((prev) => {
          const next = new Map(prev);
          next.delete(project.id); // koppeling weg → toeslaginstelling heeft geen betekenis meer, DB-rij is cascade-verwijderd
          return next;
        });
      } else {
        await projectsApi.assignments.assign(employeeId, project.id);
      }
    } catch (err) {
      setAssignedProjectIds((prev) => {
        const next = new Set(prev);
        if (isAssigned) next.add(project.id);
        else next.delete(project.id);
        return next;
      });
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Koppelen/ontkoppelen is mislukt.');
    } finally {
      setPendingProjectId(null);
    }
  }

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{user?.employee?.displayName ?? 'Medewerker'}</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">{user?.email}</p>
        </div>
        <Link to="/backoffice/medewerkers" className="text-sm text-neutral-500 underline">
          Terug naar overzicht
        </Link>
      </header>

      {errorMessage && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      {!user && !errorMessage && <p className="text-neutral-500">Laden...</p>}

      {user && (
        <>
          <section className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Rechten</h2>
            <div className="flex flex-wrap items-center gap-4">
              <label className="text-sm">
                <span className="mb-1 block text-neutral-600">Rol</span>
                <select
                  value={user.role}
                  disabled={isSavingUser}
                  onChange={(e) => void updateRole(e.target.value as UserRole)}
                  className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
                >
                  {USER_ROLES.map((role) => (
                    <option key={role} value={role}>
                      {ROLE_LABELS[role]}
                    </option>
                  ))}
                </select>
              </label>

              <button
                type="button"
                disabled={isSavingUser}
                onClick={() => void toggleActive()}
                className={`rounded-lg px-4 py-2 text-sm font-semibold ${
                  user.isActive
                    ? 'border border-neutral-300 text-neutral-700'
                    : 'bg-swatt-gold text-swatt-black'
                }`}
              >
                {user.isActive ? 'Deactiveren' : 'Heractiveren'}
              </button>

              {!user.hasSetPassword && (
                <button
                  type="button"
                  disabled={isResendingInvite}
                  onClick={() => void handleResendInvite()}
                  className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 disabled:opacity-50"
                >
                  {isResendingInvite ? 'Bezig...' : 'Opnieuw uitnodigen'}
                </button>
              )}

              <button
                type="button"
                disabled={isDeleting}
                onClick={() => void handleDelete()}
                className="rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 disabled:opacity-50"
              >
                {isDeleting ? 'Bezig...' : 'Volledig verwijderen'}
              </button>
            </div>
            {resendInviteMessage && <p className="mt-3 text-sm text-neutral-600">{resendInviteMessage}</p>}
          </section>

          <section className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Teamleader-gebruiker</h2>
            <p className="mb-4 text-sm text-neutral-500">
              Nodig om tijdsregistraties op naam van deze medewerker naar Teamleader te synchroniseren (sectie 14).
            </p>
            {teamleaderUsers === null ? (
              <p className="text-sm text-neutral-500">Teamleader-gebruikers laden...</p>
            ) : (
              <select
                value={user.teamleaderUserId ?? ''}
                disabled={isSavingTeamleaderLink}
                onChange={(e) => void updateTeamleaderUserId(e.target.value)}
                className="w-full max-w-sm rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
              >
                <option value="">Niet gekoppeld</option>
                {teamleaderUsers.map((teamleaderUser) => (
                  <option key={teamleaderUser.id} value={teamleaderUser.id}>
                    {teamleaderUser.displayName}
                  </option>
                ))}
              </select>
            )}
          </section>

          {user.employee && (
            <section className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Facturatie</h2>
              <p className="mb-4 text-sm text-neutral-500">
                Standaard uurtarief van {user.employee.displayName} voor conceptfacturen in Teamleader (sectie 17). Nog
                niet ingevuld? Dan kan een admin het tarief eenmalig invullen bij het aanmaken van de factuur zelf.
              </p>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-2 text-sm text-neutral-600">
                  €
                  <input
                    type="text"
                    inputMode="decimal"
                    value={hourlyRateInputValue}
                    onChange={(e) => setHourlyRateInputValue(e.target.value)}
                    placeholder="65,00"
                    disabled={isSavingHourlyRate}
                    className="w-24 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void saveHourlyRate()}
                  disabled={isSavingHourlyRate}
                  className="rounded-lg bg-swatt-gold-dark px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {isSavingHourlyRate ? 'Bezig...' : 'Opslaan'}
                </button>
              </div>
              {hourlyRateError && <p className="mt-2 text-xs text-red-700">{hourlyRateError}</p>}
            </section>
          )}

          {user.employee && (
            <section className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Toeslagen</h2>
              <p className="mb-4 text-sm text-neutral-500">
                Percentages van het uurtarief hierboven. Enkel hier zichtbaar/instelbaar (nooit voor {user.employee.displayName} zelf of op de
                werkbon).
              </p>
              <div className="flex flex-wrap items-end gap-4">
                <label className="text-sm text-neutral-600">
                  Overuren
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={overtimeRateInput}
                      onChange={(e) => setOvertimeRateInput(e.target.value)}
                      disabled={isSavingPremiumRates}
                      className="w-20 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
                    />
                    <span>%</span>
                  </div>
                </label>
                <label className="text-sm text-neutral-600">
                  Ploegenwerk
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={shiftWorkRateInput}
                      onChange={(e) => setShiftWorkRateInput(e.target.value)}
                      disabled={isSavingPremiumRates}
                      className="w-20 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
                    />
                    <span>%</span>
                  </div>
                </label>
                <label className="text-sm text-neutral-600">
                  Nachtwerk
                  <div className="mt-1 flex items-center gap-1">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={nightWorkRateInput}
                      onChange={(e) => setNightWorkRateInput(e.target.value)}
                      disabled={isSavingPremiumRates}
                      className="w-20 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
                    />
                    <span>%</span>
                  </div>
                </label>
                <button
                  type="button"
                  onClick={() => void savePremiumRates()}
                  disabled={isSavingPremiumRates}
                  className="rounded-lg bg-swatt-gold-dark px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                >
                  {isSavingPremiumRates ? 'Bezig...' : 'Opslaan'}
                </button>
              </div>
              {premiumRatesError && <p className="mt-2 text-xs text-red-700">{premiumRatesError}</p>}
            </section>
          )}

          {user.employee && (
            <section className="mb-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Type medewerker</h2>
              <p className="mb-4 text-sm text-neutral-500">
                Bepaalt welk document {user.employee.displayName} krijgt bij de maandelijkse uren-export: een
                werknemer komt in de gedeelde Excel-urenexport (loonverwerking); een onderaannemer krijgt een eigen
                totalisatie-met-detail-document per periode, om zelf op te factureren.
              </p>
              <div className="flex items-center gap-4">
                <select
                  value={user.employee.employmentType}
                  disabled={isSavingEmploymentType}
                  onChange={(e) => void updateEmploymentType(e.target.value as EmploymentType)}
                  className="rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
                >
                  {EMPLOYMENT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {EMPLOYMENT_TYPE_LABELS[type]}
                    </option>
                  ))}
                </select>
              </div>
              {employmentTypeError && <p className="mt-2 text-xs text-red-700">{employmentTypeError}</p>}
            </section>
          )}

          {user.employee && (
            <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
              <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">
                Gekoppelde projecten
              </h2>
              <p className="mb-4 text-sm text-neutral-500">
                Enkel aangevinkte projecten kan {user.employee.displayName} selecteren om uren op te boeken.
              </p>

              <input
                type="text"
                placeholder="Zoek op klant, project, nummer of adres..."
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                className="mb-4 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
              />

              {allProjects === null && <p className="text-sm text-neutral-500">Projecten laden...</p>}
              {allProjects?.length === 0 && (
                <p className="text-sm text-neutral-500">
                  Geen gesynchroniseerde projecten gevonden. Synchroniseer eerst via Instellingen → Teamleader-integratie.
                </p>
              )}

              <ul className="divide-y divide-neutral-100">
                {allProjects?.map((project) => {
                  const isAssigned = assignedProjectIds.has(project.id);
                  const premiums = assignmentPremiums.get(project.id) ?? { overtimeApplies: false, premiumType: 'NONE' as const };
                  const isPremiumsPending = pendingPremiumsProjectId === project.id;
                  return (
                    <li key={project.id} className="py-2">
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          id={`project-${project.id}`}
                          checked={isAssigned}
                          disabled={pendingProjectId === project.id}
                          onChange={() => void toggleProject(project)}
                          className="h-4 w-4 accent-swatt-gold"
                        />
                        <label htmlFor={`project-${project.id}`} className="flex-1 text-sm">
                          <span className="font-medium">{project.customerName}</span>
                          <span className="text-neutral-500"> — {project.name}</span>
                          {project.projectNumber && (
                            <span className="text-neutral-400"> (#{project.projectNumber})</span>
                          )}
                        </label>
                      </div>

                      {/* Phase 12, deel A (sectie 1): toeslaginstelling enkel tonen/bewerkbaar voor een aangevinkte koppeling. */}
                      {isAssigned && (
                        <div className="mt-2 ml-7 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-neutral-600">
                          <label className="flex items-center gap-1.5">
                            <input
                              type="checkbox"
                              checked={premiums.overtimeApplies}
                              disabled={isPremiumsPending}
                              onChange={(e) => void updateAssignmentPremiums(project.id, { overtimeApplies: e.target.checked })}
                              className="h-3.5 w-3.5 accent-swatt-gold"
                            />
                            Overuren van toepassing
                          </label>
                          {(['NONE', 'SHIFT_WORK', 'NIGHT_WORK'] as const).map((option) => (
                            <label key={option} className="flex items-center gap-1.5">
                              <input
                                type="radio"
                                name={`premium-${project.id}`}
                                checked={premiums.premiumType === option}
                                disabled={isPremiumsPending}
                                onChange={() => void updateAssignmentPremiums(project.id, { premiumType: option })}
                                className="h-3.5 w-3.5 accent-swatt-gold"
                              />
                              {option === 'NONE' ? 'Geen toeslag' : option === 'SHIFT_WORK' ? 'Ploegenwerk' : 'Nachtwerk'}
                            </label>
                          ))}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
