import type { MilestoneSummary, ProjectSummary } from '@swatt/shared-types';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { projectsApi } from '../../api/client';
import { ApiRequestError, useAuth } from '../../auth/AuthContext';

/**
 * Backoffice-scherm "Projecten" — Phase 9's "flexibele" milestone-strategie
 * (zie MilestoneSyncService en de projectoverdracht-notitie over waarom dit
 * nodig is: `timeTracking.add` vereist een legacy-`milestone` als subject,
 * niet het project zelf). Een supervisor kiest hier per project welke
 * (al-gesynchroniseerde) milestone de werkbon-uren moet ontvangen.
 *
 * Zonder expliciete keuze valt een project terug op automatische aanmaak van
 * een "Werkbon-uren (Uurivo)"-milestone bij de eerste sync (zie
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
      // Na een wijziging (bv. de facturatie-toggle hieronder) is een reeds
      // aangeklikt project in de lijst mogelijk stale — hersynchroniseren
      // zodat het rechterpaneel meteen de bijgewerkte waarde toont, i.p.v.
      // pas na opnieuw aanklikken.
      setSelectedProject((current) =>
        current ? (response.projects.find((project) => project.id === current.id) ?? current) : current,
      );
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

        <div className="flex flex-col gap-6">
          {selectedProject ? (
            <>
              <InvoicingPanel key={`invoicing-${selectedProject.id}`} project={selectedProject} onUpdated={loadProjects} />
              <OvertimeSettingsPanel key={`overtime-${selectedProject.id}`} project={selectedProject} onUpdated={loadProjects} />
              <SigningModePanel key={`signing-${selectedProject.id}`} project={selectedProject} onUpdated={loadProjects} />
              <KmDistancePanel key={`km-${selectedProject.id}`} project={selectedProject} />
              <MilestonePanel key={selectedProject.id} project={selectedProject} />
            </>
          ) : (
            <p className="rounded-xl border border-dashed border-neutral-300 p-5 text-sm text-neutral-500">
              Kies links een project om de instellingen te beheren.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}

/**
 * Phase 12, deel C (sectie 3 van de projectbrief): "facturatie uitschakelen
 * per project — enkel nacalculatie". Bewust ADMIN-only (net als de backend-
 * route, zie project.routes.ts): dit raakt of een project ooit in het
 * Facturatie-overzicht (InvoicingPage.tsx, Phase 10) kan verschijnen — een
 * SUPERVISOR ziet dit paneel dus niet, in tegenstelling tot het
 * milestone-paneel hieronder.
 */
function InvoicingPanel({ project, onUpdated }: { project: ProjectSummary; onUpdated: () => void }) {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'ADMIN';
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(invoicingEnabled: boolean) {
    setIsSaving(true);
    setError(null);
    try {
      await projectsApi.invoicing.update(project.id, invoicingEnabled);
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Opslaan van de facturatie-instelling is mislukt.');
    } finally {
      setIsSaving(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Facturatie</h2>
      <p className="mb-4 text-sm text-neutral-500">
        {project.customerName} — {project.name}
      </p>

      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <label className="flex items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={project.invoicingEnabled}
          disabled={isSaving}
          onChange={(e) => void handleToggle(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-swatt-gold"
        />
        <span>
          <span className="font-medium">Facturatie via deze app</span>
          <br />
          <span className="text-neutral-500">
            {project.invoicingEnabled
              ? 'Werkbonnen van dit project stromen door naar het Facturatie-overzicht zodra ze gesynchroniseerd zijn.'
              : 'Uren en werkbonnen worden nog steeds naar Teamleader gesynchroniseerd voor nacalculatie, maar dit project verschijnt niet in het Facturatie-overzicht.'}
          </span>
        </span>
      </label>
    </section>
  );
}

/**
 * Phase 12, deel A (sectie 1 van de projectbrief): "Overuren boven 8u/dag" of
 * "Overuren boven [x]u/week" — de daadwerkelijke drempel geldt per project,
 * los van de koppelingsinstelling (overtimeApplies/premiumType, zie
 * UserDetailPage.tsx) die enkel bepaalt óf overuren voor een bepaalde
 * medewerker meetelt. Bewust ADMIN-only, zelfde reden als InvoicingPanel
 * hierboven: financiële impact op zowel klantfactuur als
 * personeelsuitbetaling (Phase 12, deel E).
 */
function OvertimeSettingsPanel({ project, onUpdated }: { project: ProjectSummary; onUpdated: () => void }) {
  const { user: currentUser } = useAuth();
  const isAdmin = currentUser?.role === 'ADMIN';
  const [weeklyHoursInput, setWeeklyHoursInput] = useState(String(project.overtimeWeeklyThresholdHours ?? 39));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWeeklyHoursInput(String(project.overtimeWeeklyThresholdHours ?? 39));
  }, [project.overtimeWeeklyThresholdHours]);

  async function handleChange(thresholdType: 'DAILY' | 'WEEKLY') {
    setIsSaving(true);
    setError(null);
    try {
      if (thresholdType === 'DAILY') {
        await projectsApi.overtimeSettings.update(project.id, 'DAILY', null);
      } else {
        const hours = Number(weeklyHoursInput.trim().replace(',', '.'));
        if (!Number.isFinite(hours) || hours <= 0) {
          setError('Vul een geldig aantal uren per week in (bv. 39).');
          setIsSaving(false);
          return;
        }
        await projectsApi.overtimeSettings.update(project.id, 'WEEKLY', hours);
      }
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Opslaan van de overurenregeling is mislukt.');
    } finally {
      setIsSaving(false);
    }
  }

  if (!isAdmin) return null;

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Overurenregeling</h2>
      <p className="mb-4 text-sm text-neutral-500">
        {project.customerName} — {project.name}
      </p>

      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`overtime-threshold-${project.id}`}
            checked={project.overtimeThresholdType === 'DAILY'}
            disabled={isSaving}
            onChange={() => void handleChange('DAILY')}
            className="h-4 w-4 accent-swatt-gold"
          />
          Overuren boven 8u/dag
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`overtime-threshold-${project.id}`}
            checked={project.overtimeThresholdType === 'WEEKLY'}
            disabled={isSaving}
            onChange={() => void handleChange('WEEKLY')}
            className="h-4 w-4 accent-swatt-gold"
          />
          Overuren boven
          <input
            type="text"
            inputMode="decimal"
            value={weeklyHoursInput}
            onChange={(e) => setWeeklyHoursInput(e.target.value)}
            onBlur={() => project.overtimeThresholdType === 'WEEKLY' && void handleChange('WEEKLY')}
            disabled={isSaving || project.overtimeThresholdType !== 'WEEKLY'}
            className="w-16 rounded-lg border border-neutral-300 bg-white px-2 py-1 text-sm outline-none focus:border-swatt-gold disabled:bg-neutral-100"
          />
          u/week
        </label>
      </div>
    </section>
  );
}

/**
 * Phase 12, deel B (sectie 2): "Ondertekening per werkbon" (default) of
 * "Ondertekening per week" — bepaalt of een technieker op dit project na elke
 * werkbon apart laat tekenen, of via "Week aftekenen" alle openstaande
 * werkbonnen van de lopende week in één keer (zie WeeklyApprovalService).
 * Zichtbaar voor SUPERVISOR+ (net als het milestone-paneel hieronder) — geen
 * financiële impact zoals de twee panelen hierboven, dus geen ADMIN-only.
 */
function SigningModePanel({ project, onUpdated }: { project: ProjectSummary; onUpdated: () => void }) {
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(signingMode: 'PER_WORK_ORDER' | 'WEEKLY') {
    setIsSaving(true);
    setError(null);
    try {
      await projectsApi.signingMode.update(project.id, signingMode);
      onUpdated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Opslaan van de ondertekeningsmodus is mislukt.');
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Ondertekening</h2>
      <p className="mb-4 text-sm text-neutral-500">
        {project.customerName} — {project.name}
      </p>

      {error && <p className="mb-3 text-sm text-red-700">{error}</p>}

      <div className="flex flex-col gap-2 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`signing-mode-${project.id}`}
            checked={project.signingMode === 'PER_WORK_ORDER'}
            disabled={isSaving}
            onChange={() => void handleChange('PER_WORK_ORDER')}
            className="h-4 w-4 accent-swatt-gold"
          />
          Ondertekening per werkbon
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`signing-mode-${project.id}`}
            checked={project.signingMode === 'WEEKLY'}
            disabled={isSaving}
            onChange={() => void handleChange('WEEKLY')}
            className="h-4 w-4 accent-swatt-gold"
          />
          Ondertekening per week
        </label>
      </div>
    </section>
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

/**
 * Phase 12, deel D (sectie 5): read-only weergave van de berekende km-afstand
 * — géén bedrag getoond, enkel het aantal kilometer (business rule 11: het
 * tarief/bedrag blijft uitsluitend zichtbaar bij de klantfactuur zelf, admin-
 * only). Daarom bewust geen aparte rolcheck zoals bij InvoicingPanel/
 * OvertimeSettingsPanel hierboven — SUPERVISOR mag dit gewoon zien.
 */
function KmDistancePanel({ project }: { project: ProjectSummary }) {
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
      <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">Kilometerafstand</h2>
      <p className="mb-3 text-sm text-neutral-500">
        {project.customerName} — {project.name}
      </p>
      {project.kmDistanceOneWayMeters !== null ? (
        <p className="text-sm text-neutral-700">
          {(project.kmDistanceOneWayMeters / 1000).toFixed(1)} km enkel, ~{((project.kmDistanceOneWayMeters * 2) / 1000).toFixed(1)} km
          heen-terug
        </p>
      ) : (
        <p className="text-sm text-neutral-400">
          Nog niet berekend — dit gebeurt automatisch zodra het adres bekend is en de km-vergoeding is ingesteld
          (Instellingen).
        </p>
      )}
    </section>
  );
}
