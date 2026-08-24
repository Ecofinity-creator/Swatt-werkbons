import type { MilestoneSummary, ProjectSummary } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { projectsApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

/**
 * Backoffice-scherm "Projecten" — Phase 9's "flexibele" milestone-strategie
 * (zie MilestoneSyncService en de projectoverdracht-notitie over waarom dit
 * nodig is: `timeTracking.add` vereist een legacy-`milestone` als subject,
 * niet het project zelf). Een supervisor kiest hier per project welke
 * (al-gesynchroniseerde) milestone de werkbon-uren moet ontvangen.
 *
 * Zonder expliciete keuze valt een project terug op automatische aanmaak van
 * een "Werkbon-uren (SWATT app)"-milestone bij de eerste sync (zie
 * resolveOrCreateTeamleaderMilestoneId) — enkel mogelijk wanneer een admin
 * bij Instellingen → Teamleader-integratie een default-verantwoordelijke
 * heeft ingesteld.
 */
export function ProjectMilestonesPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [search, setSearch] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [selectedProject, setSelectedProject] = useState<ProjectSummary | null>(null);

  const loadProjects = useCallback(async () => {
    try {
      const response = await projectsApi.list(search || undefined);
      setProjects(response.projects);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de projectenlijst niet ophalen.');
    }
  }, [search]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Projecten</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice — werkbon-uren-milestone</p>
        </div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          Terug
        </Link>
      </header>

      {errorMessage && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      <input
        type="text"
        placeholder="Zoek op klant, project, nummer of adres..."
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        className="mb-4 w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-sm">
          {!projects && !errorMessage && <p className="p-4 text-sm text-neutral-500">Laden...</p>}
          {projects?.length === 0 && (
            <p className="p-4 text-sm text-neutral-500">
              Geen gesynchroniseerde projecten gevonden. Synchroniseer eerst via Instellingen → Teamleader-integratie.
            </p>
          )}
          <ul className="divide-y divide-neutral-100">
            {projects?.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => setSelectedProject(project)}
                  className={`block w-full px-4 py-3 text-left text-sm ${
                    selectedProject?.id === project.id ? 'bg-swatt-gold/10' : 'hover:bg-neutral-50'
                  }`}
                >
                  <span className="font-medium">{project.customerName}</span>
                  <span className="text-neutral-500"> — {project.name}</span>
                  {project.projectNumber && <span className="text-neutral-400"> (#{project.projectNumber})</span>}
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div>
          {selectedProject ? (
            <MilestonePanel key={selectedProject.id} project={selectedProject} />
          ) : (
            <p className="rounded-xl border border-dashed border-neutral-300 p-5 text-sm text-neutral-500">
              Kies links een project om de werkbon-uren-milestone te beheren.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

function MilestonePanel({ project }: { project: ProjectSummary }) {
  const [milestones, setMilestones] = useState<MilestoneSummary[] | null>(null);
  const [selectedMilestoneId, setSelectedMilestoneId] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function handleSync() {
    setIsSyncing(true);
    setError(null);
    setSaved(false);
    try {
      const response = await projectsApi.milestones.sync(project.id);
      setMilestones(response.milestones);
      setSelectedMilestoneId(response.selectedMilestoneId);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Ophalen van de milestones is mislukt.');
    } finally {
      setIsSyncing(false);
    }
  }

  async function handleSelect(milestoneId: string | null) {
    setIsSaving(true);
    setError(null);
    setSaved(false);
    try {
      const response = await projectsApi.milestones.select(project.id, milestoneId);
      setSelectedMilestoneId(response.selectedMilestoneId);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Opslaan van de keuze is mislukt.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Werkbon-uren-milestone</h2>
      <p className="mb-4 text-sm text-neutral-500">
        {project.customerName} — {project.name}
      </p>

      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}
      {saved && <p className="mb-3 text-sm text-emerald-700">Keuze opgeslagen.</p>}

      <button
        type="button"
        onClick={() => void handleSync()}
        disabled={isSyncing}
        className="mb-4 rounded-lg border border-neutral-300 px-4 py-2 text-sm font-semibold text-neutral-700 disabled:opacity-60"
      >
        {isSyncing ? 'Bezig...' : milestones === null ? 'Milestones ophalen uit Teamleader' : 'Opnieuw ophalen'}
      </button>

      {milestones !== null && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="milestone"
              checked={selectedMilestoneId === null}
              disabled={isSaving}
              onChange={() => void handleSelect(null)}
              className="h-4 w-4 accent-swatt-gold"
            />
            Geen keuze (automatisch aanmaken bij de eerste sync)
          </label>
          {milestones.length === 0 && (
            <p className="text-sm text-neutral-500">Dit project heeft nog geen milestones in Teamleader.</p>
          )}
          {milestones.map((milestone) => (
            <label key={milestone.id} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="milestone"
                checked={selectedMilestoneId === milestone.id}
                disabled={isSaving}
                onChange={() => void handleSelect(milestone.id)}
                className="h-4 w-4 accent-swatt-gold"
              />
              {milestone.name}
              {milestone.dueOn && <span className="text-neutral-400"> (t.e.m. {milestone.dueOn})</span>}
            </label>
          ))}
        </div>
      )}
    </section>
  );
}
