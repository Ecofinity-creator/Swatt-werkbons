import type { PlanningAssignmentSummary, ProjectSummary } from '@swatt/shared-types';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { planningApi, projectsApi } from '../api/client';
import { ApiRequestError } from '../auth/AuthContext';

/** JJJJ-MM-DD in LOKALE tijd — zelfde conventie/reden als PlanningBoardPage.tsx's `isoLocal`. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function todayIsoLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/**
 * "Mijn projecten" (Stap 5.1, tab binnen Home) — de projecten die deze
 * werknemer mag selecteren om uren op te boeken. Toont enkel wat
 * `/projects/mine` teruggeeft: de backend filtert al op ProjectAssignment,
 * dus deze pagina hoeft zelf geen rechten-logica te kennen.
 *
 * Elke kaart linkt door naar de timerpagina (Phase 4) voor dat project. Het
 * volledige `ProjectSummary`-object wordt meegegeven als router-`state`,
 * zodat ProjectTimerPage.tsx het project meteen kan tonen zonder een extra
 * fetch — bij een rechtstreekse navigatie (geen state, bv. een herlaad) valt
 * die pagina terug op een eigen `projectsApi.mine()`-aanroep.
 *
 * Fase 13 — "Vandaag": als een supervisor deze werknemer via het
 * planningsbord vandaag aan een project gekoppeld heeft (PlanningBoardPage),
 * staat dat project hierboven meteen klaar — geen zoeken meer nodig (zie
 * planning.routes.ts). Business rule 12: dit is een suggestie/versnelling,
 * geen aparte toegangsdeur — vandaar dat de kaart enkel verschijnt wanneer
 * het project ook effectief in `projectsApi.mine()` voorkomt (dezelfde
 * ProjectAssignment-controle als de rest van deze pagina); ontbreekt die
 * koppeling toch, dan blijft de gewone "Mijn projecten"-lijst hieronder
 * gewoon werken zoals voorheen.
 */
export function EmployeeProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [todayAssignment, setTodayAssignment] = useState<PlanningAssignmentSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    projectsApi
      .mine()
      .then((response) => setProjects(response.projects))
      .catch((err) =>
        setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon je projecten niet ophalen.'),
      );

    // Stille best-effort ophaling — geen planning voor vandaag is een normale
    // situatie (geen foutmelding tonen), de bestaande projectenlijst blijft
    // sowieso het vangnet.
    planningApi
      .mine(1)
      .then((response) => {
        const todayIso = todayIsoLocal();
        setTodayAssignment(response.assignments.find((a) => a.date === todayIso) ?? null);
      })
      .catch(() => setTodayAssignment(null));
  }, []);

  const todayProject = todayAssignment ? (projects?.find((p) => p.id === todayAssignment.projectId) ?? null) : null;

  return (
    <main className="min-h-screen bg-swatt-black px-6 py-10 text-white">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Mijn projecten</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">
            Selecteer een project om uren op te boeken
          </p>
        </div>
        <Link to="/" className="text-sm text-neutral-400 underline">
          Terug
        </Link>
      </header>

      {errorMessage && (
        <p role="alert" className="mb-4 rounded-lg bg-red-950 px-4 py-3 text-sm text-red-300">
          {errorMessage}
        </p>
      )}

      {!projects && !errorMessage && <p className="text-neutral-400">Laden...</p>}

      {todayProject && (
        <div className="mb-6">
          <p className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">Vandaag ingepland</p>
          <Link
            to={`/projecten/${todayProject.id}`}
            state={{ project: todayProject }}
            className="block rounded-xl border-2 border-swatt-gold bg-neutral-900 p-5 transition active:bg-neutral-800"
          >
            <p className="text-xs font-medium uppercase tracking-wide text-swatt-gold">{todayProject.customerName}</p>
            <p className="mt-1 text-xl font-bold">{todayProject.name}</p>
            <div className="mt-1 space-y-0.5 text-sm text-neutral-400">
              {todayProject.projectNumber && <p>Projectnr. {todayProject.projectNumber}</p>}
              {todayProject.address && <p>{todayProject.address}</p>}
            </div>
            <p className="mt-3 rounded-lg bg-swatt-gold px-4 py-3 text-center text-base font-semibold text-swatt-black">
              Start deze opdracht
            </p>
          </Link>
        </div>
      )}

      {projects && projects.length === 0 && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-center text-neutral-400">
          <p>Er zijn nog geen projecten aan jou gekoppeld.</p>
          <p className="mt-1 text-sm">Vraag je supervisor of beheerder om je aan een project te koppelen.</p>
        </div>
      )}

      {todayProject && projects && projects.length > 1 && (
        <p className="mb-2 text-xs font-medium uppercase tracking-[0.2em] text-neutral-500">Mijn projecten</p>
      )}

      <ul className="flex flex-col gap-3">
        {projects
          ?.filter((project) => project.id !== todayProject?.id)
          .map((project) => (
            <li key={project.id}>
              <Link
                to={`/projecten/${project.id}`}
                state={{ project }}
                className="block rounded-xl border border-neutral-800 bg-neutral-900 p-5 transition active:border-swatt-gold"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-swatt-gold">{project.customerName}</p>
                <p className="mt-1 text-lg font-semibold">{project.name}</p>
                <div className="mt-2 space-y-0.5 text-sm text-neutral-400">
                  {project.projectNumber && <p>Projectnr. {project.projectNumber}</p>}
                  {project.address && <p>{project.address}</p>}
                </div>
              </Link>
            </li>
          ))}
      </ul>
    </main>
  );
}
