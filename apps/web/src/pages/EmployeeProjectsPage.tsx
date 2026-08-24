import type { ProjectSummary } from '@swatt/shared-types';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { projectsApi } from '../api/client';
import { ApiRequestError } from '../auth/AuthContext';

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
 */
export function EmployeeProjectsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    projectsApi
      .mine()
      .then((response) => setProjects(response.projects))
      .catch((err) =>
        setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon je projecten niet ophalen.'),
      );
  }, []);

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

      {projects && projects.length === 0 && (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900 p-5 text-center text-neutral-400">
          <p>Er zijn nog geen projecten aan jou gekoppeld.</p>
          <p className="mt-1 text-sm">Vraag je supervisor of beheerder om je aan een project te koppelen.</p>
        </div>
      )}

      <ul className="flex flex-col gap-3">
        {projects?.map((project) => (
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
