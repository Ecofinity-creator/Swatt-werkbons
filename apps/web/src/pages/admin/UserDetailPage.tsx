import type { AdminUserSummary, ProjectSummary, TeamleaderUserOption, UserRole } from '@swatt/shared-types';
import { USER_ROLES } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { projectsApi, usersApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';
import { ROLE_LABELS } from '../../constants';

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
  const { userId } = useParams<{ userId: string }>();
  const [user, setUser] = useState<AdminUserSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSavingUser, setIsSavingUser] = useState(false);

  const [allProjects, setAllProjects] = useState<ProjectSummary[] | null>(null);
  const [assignedProjectIds, setAssignedProjectIds] = useState<Set<string>>(new Set());
  const [projectSearch, setProjectSearch] = useState('');
  const [pendingProjectId, setPendingProjectId] = useState<string | null>(null);

  // Phase 9 — koppeling met een Teamleader-gebruiker (sectie 14: `timeTracking.add`'s `user_id`).
  const [teamleaderUsers, setTeamleaderUsers] = useState<TeamleaderUserOption[] | null>(null);
  const [isSavingTeamleaderLink, setIsSavingTeamleaderLink] = useState(false);

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
  }, []);

  useEffect(() => {
    void loadUser();
  }, [loadUser]);

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
            </div>
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
                {allProjects?.map((project) => (
                  <li key={project.id} className="flex items-center gap-3 py-2">
                    <input
                      type="checkbox"
                      id={`project-${project.id}`}
                      checked={assignedProjectIds.has(project.id)}
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
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </main>
  );
}
