import type { PlanningAssignmentSummary, PlanningEmployeeSummary, PlanningSeriesSummary, ProjectSummary } from '@swatt/shared-types';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { planningApi, projectsApi } from '../../api/client';
import { ApiRequestError } from '../../auth/AuthContext';

/**
 * Fase 13 (concept) — planningsmodule/dispatch (klantvraag 10/9/2026, zie
 * claude/phase13-planningsmodule-concept.md). De supervisor wijst hier per
 * dag een project toe aan een medewerker/onderaannemer — die toewijzing
 * bepaalt automatisch het "voorgestelde project" die de medewerker straks in
 * de app ziet (zie EmployeeProjectsPage.tsx — "Vandaag"), zonder dat hij
 * zelf nog moet zoeken. Een toewijzing blijft een suggestie/versnelling
 * (business rule 12): de bestaande "Mijn projecten"-zoekflow blijft gewoon
 * bestaan voor dagen zonder planning.
 *
 * Kleur = project/klant (klantvraag: "zo is meteen zichtbaar wie op
 * dezelfde werf staat", zie §8 van de projectbrief) — bewust géén dynamische
 * Tailwind-classnamen (`bg-${kleur}-50`); Tailwind's JIT-scanner ziet enkel
 * letterlijke strings in de broncode, vandaar de vaste PALETTE hieronder.
 */

const DAY_LABELS = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za', 'Zo'];
const DAY_LABELS_FULL = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];

const PALETTE = [
  { bg: 'bg-blue-50', text: 'text-blue-800', border: 'border-blue-200', dot: 'bg-blue-500' },
  { bg: 'bg-violet-50', text: 'text-violet-800', border: 'border-violet-200', dot: 'bg-violet-500' },
  { bg: 'bg-rose-50', text: 'text-rose-800', border: 'border-rose-200', dot: 'bg-rose-500' },
  { bg: 'bg-amber-50', text: 'text-amber-800', border: 'border-amber-200', dot: 'bg-amber-500' },
  { bg: 'bg-emerald-50', text: 'text-emerald-800', border: 'border-emerald-200', dot: 'bg-emerald-500' },
  { bg: 'bg-indigo-50', text: 'text-indigo-800', border: 'border-indigo-200', dot: 'bg-indigo-500' },
  { bg: 'bg-cyan-50', text: 'text-cyan-800', border: 'border-cyan-200', dot: 'bg-cyan-500' },
  { bg: 'bg-fuchsia-50', text: 'text-fuchsia-800', border: 'border-fuchsia-200', dot: 'bg-fuchsia-500' },
] as const;

function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Datum → "JJJJ-MM-DD" in LOKALE tijd (niet toISOString(), dat schuift rond middernacht in UTC+1/+2 — zie ook PlanningService op de backend, die eenzelfde dag-conventie hanteert). */
function isoLocal(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function mondayOf(date: Date): Date {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dow = (result.getDay() + 6) % 7; // 0=maandag
  result.setDate(result.getDate() - dow);
  return result;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function weekDates(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

function formatWeekdays(weekdays: number[]): string {
  const sorted = [...weekdays].sort((a, b) => a - b);
  if (sorted.length === 7) return 'Elke dag';
  const isWeekOnly = sorted.length === 5 && [0, 1, 2, 3, 4].every((d) => sorted.includes(d));
  if (isWeekOnly) return 'Ma–Vr';
  return sorted.map((d) => DAY_LABELS[d]).join(', ');
}

const MONTHS = ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];

interface ModalContext {
  employeeId: string;
  employeeDisplayName: string;
  date: string;
  currentProjectId: string | null;
}

export function PlanningBoardPage() {
  const [weekStart, setWeekStart] = useState<Date>(() => mondayOf(new Date()));
  const [employees, setEmployees] = useState<PlanningEmployeeSummary[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [assignments, setAssignments] = useState<PlanningAssignmentSummary[] | null>(null);
  const [series, setSeries] = useState<PlanningSeriesSummary[] | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [modalCtx, setModalCtx] = useState<ModalContext | null>(null);

  const load = useCallback(async (currentWeekStart: Date) => {
    try {
      const [employeesRes, projectsRes, weekRes, seriesRes] = await Promise.all([
        planningApi.admin.employees(),
        projectsApi.list(),
        planningApi.admin.week(isoLocal(currentWeekStart)),
        planningApi.admin.series(),
      ]);
      setEmployees(employeesRes.employees);
      setProjects(projectsRes.projects);
      setAssignments(weekRes.assignments);
      setSeries(seriesRes.series);
      setErrorMessage(null);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon de planning niet ophalen.');
    }
  }, []);

  useEffect(() => {
    void load(weekStart);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `load` is stabiel (useCallback zonder deps), enkel weekStart moet een herlaad triggeren.
  }, [weekStart]);

  const projectColor = useMemo(() => {
    const map = new Map<string, (typeof PALETTE)[number]>();
    (projects ?? []).forEach((project, index) => {
      map.set(project.id, PALETTE[index % PALETTE.length]!);
    });
    return map;
  }, [projects]);

  const assignmentByKey = useMemo(() => {
    const map = new Map<string, PlanningAssignmentSummary>();
    (assignments ?? []).forEach((a) => map.set(`${a.employeeId}_${a.date}`, a));
    return map;
  }, [assignments]);

  const dates = weekDates(weekStart);
  const todayIso = isoLocal(new Date());

  const weekLabel = (() => {
    const first = dates[0]!;
    const last = dates[6]!;
    const sameMonth = first.getMonth() === last.getMonth();
    return sameMonth
      ? `${first.getDate()}–${last.getDate()} ${MONTHS[first.getMonth()] ?? ''} ${first.getFullYear()}`
      : `${first.getDate()} ${MONTHS[first.getMonth()] ?? ''} – ${last.getDate()} ${MONTHS[last.getMonth()] ?? ''} ${last.getFullYear()}`;
  })();

  const openModalFor = (employeeId: string, employeeDisplayName: string, date: string) => {
    const existing = assignmentByKey.get(`${employeeId}_${date}`);
    setModalCtx({ employeeId, employeeDisplayName, date, currentProjectId: existing?.projectId ?? null });
  };

  const openWeekdayCount = dates.filter((d) => d.getDay() !== 0 && d.getDay() !== 6).length;
  const filledWeekdaySlots = (employees ?? []).reduce((total, emp) => {
    return (
      total +
      dates.filter((d) => d.getDay() !== 0 && d.getDay() !== 6 && assignmentByKey.has(`${emp.employeeId}_${isoLocal(d)}`)).length
    );
  }, 0);
  const totalWeekdaySlots = (employees?.length ?? 0) * openWeekdayCount;

  return (
    <main className="min-h-screen bg-neutral-50 px-6 py-10 text-neutral-900">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">Planningsbord</h1>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold-dark">Backoffice</p>
          <p className="mt-2 max-w-xl text-sm text-neutral-500">
            Wijs per dag een project toe aan een medewerker of onderaannemer. Zodra dat ingevuld staat, ziet hij dat
            project automatisch bovenaan in de app — geen zoeken meer nodig.
          </p>
        </div>
        <Link to="/" className="text-sm text-neutral-500 underline">
          Terug
        </Link>
      </header>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 rounded-lg border border-neutral-200 bg-white px-2 py-1.5 shadow-sm">
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w, -7))}
            className="rounded-md px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            aria-label="Vorige week"
          >
            ‹
          </button>
          <span className="min-w-[14ch] text-center text-sm font-semibold">Week {weekLabel}</span>
          <button
            type="button"
            onClick={() => setWeekStart((w) => addDays(w, 7))}
            className="rounded-md px-2 py-1 text-sm text-neutral-600 hover:bg-neutral-100"
            aria-label="Volgende week"
          >
            ›
          </button>
        </div>
        <button
          type="button"
          onClick={() => setWeekStart(mondayOf(new Date()))}
          className="text-sm font-semibold text-swatt-gold-dark hover:underline"
        >
          Vandaag
        </button>
        {totalWeekdaySlots > 0 && (
          <span className="rounded-full border border-neutral-200 bg-white px-3 py-1 text-xs font-medium text-neutral-600 shadow-sm">
            {filledWeekdaySlots} / {totalWeekdaySlots} werkdagen ingepland
          </span>
        )}
      </div>

      {errorMessage && (
        <p role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {errorMessage}
        </p>
      )}

      {(!employees || !projects || !assignments) && !errorMessage && <p className="text-neutral-500">Laden...</p>}

      {employees && employees.length === 0 && (
        <p className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm text-neutral-500">
          Er zijn nog geen actieve medewerkers om in te plannen.
        </p>
      )}

      {employees && employees.length > 0 && projects && assignments && (
        <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white shadow-sm">
          <table className="w-full min-w-[880px] border-collapse text-left text-sm">
            <thead className="border-b border-neutral-200 text-xs uppercase tracking-wide text-neutral-500">
              <tr>
                <th className="w-48 px-4 py-3">Medewerker</th>
                {dates.map((date) => {
                  const iso = isoLocal(date);
                  const isToday = iso === todayIso;
                  const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                  return (
                    <th
                      key={iso}
                      className={`px-2 py-3 text-center ${isWeekend ? 'bg-neutral-50' : ''} ${isToday ? 'text-swatt-gold-dark' : ''}`}
                    >
                      <div className="text-sm font-semibold normal-case text-neutral-700">
                        {DAY_LABELS[(date.getDay() + 6) % 7] ?? ''}
                      </div>
                      <div>
                        {date.getDate()} {MONTHS[date.getMonth()] ?? ''}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {employees.map((employee) => (
                <tr key={employee.employeeId} className="border-b border-neutral-100 last:border-b-0">
                  <td className="px-4 py-2 align-top">
                    <p className="font-medium">{employee.displayName}</p>
                    <p className="text-xs text-neutral-400">
                      {employee.employmentType === 'SUBCONTRACTOR' ? 'Onderaannemer' : 'Werknemer'}
                    </p>
                  </td>
                  {dates.map((date) => {
                    const iso = isoLocal(date);
                    const isWeekend = date.getDay() === 0 || date.getDay() === 6;
                    const assignment = assignmentByKey.get(`${employee.employeeId}_${iso}`);
                    const color = assignment ? projectColor.get(assignment.projectId) : undefined;
                    return (
                      <td key={iso} className={`px-1.5 py-1.5 align-top ${isWeekend ? 'bg-neutral-50' : ''}`}>
                        {assignment && color ? (
                          <button
                            type="button"
                            onClick={() => openModalFor(employee.employeeId, employee.displayName, iso)}
                            className={`w-full rounded-lg border px-2 py-2 text-left text-xs leading-tight ${color.bg} ${color.text} ${color.border} hover:brightness-95`}
                          >
                            <span className="flex items-center gap-1 font-semibold">
                              {assignment.seriesId && <span aria-hidden="true">🔁</span>}
                              {assignment.customerName}
                            </span>
                            <span className="block opacity-80">{assignment.projectName}</span>
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openModalFor(employee.employeeId, employee.displayName, iso)}
                            className="w-full rounded-lg border border-dashed border-neutral-300 px-2 py-2 text-xs text-neutral-400 hover:border-swatt-gold hover:text-swatt-gold-dark"
                          >
                            + Toewijzen
                          </button>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>

          {projects.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t border-neutral-100 px-4 py-3">
              {projects.map((project) => {
                const color = projectColor.get(project.id);
                if (!color) return null;
                return (
                  <span key={project.id} className="flex items-center gap-1.5 text-xs text-neutral-500">
                    <span className={`h-2.5 w-2.5 rounded-sm ${color.dot}`} />
                    {project.customerName} — {project.name}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {series && series.length > 0 && (
        <section className="mt-6 rounded-xl border border-neutral-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-500">Actieve herhalingen</h2>
          <p className="mb-3 mt-1 text-sm text-neutral-500">Reeksen die de planner niet elke week opnieuw hoeft in te vullen.</p>
          <ul className="flex flex-col gap-2">
            {series.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{s.employeeDisplayName}</span> → {s.customerName} ({s.projectName})
                  <span className="text-neutral-400"> — {formatWeekdays(s.weekdays)} t/m {s.endDate}</span>
                </span>
                <button
                  type="button"
                  onClick={() => void stopSeries(s.id)}
                  className="rounded-md border border-neutral-300 px-2 py-1 text-xs font-semibold text-red-700 hover:border-red-300 hover:bg-red-50"
                >
                  Stopzetten
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {modalCtx && projects && (
        <AssignmentModal
          context={modalCtx}
          projects={projects}
          onClose={() => setModalCtx(null)}
          onSaved={() => {
            setModalCtx(null);
            void load(weekStart);
          }}
        />
      )}
    </main>
  );

  async function stopSeries(seriesId: string) {
    try {
      await planningApi.admin.stopSeries(seriesId);
      await load(weekStart);
    } catch (err) {
      setErrorMessage(err instanceof ApiRequestError ? err.message : 'Kon deze herhaling niet stopzetten.');
    }
  }
}

function AssignmentModal({
  context,
  projects,
  onClose,
  onSaved,
}: {
  context: ModalContext;
  projects: ProjectSummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [search, setSearch] = useState('');
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(context.currentProjectId);
  const [recurring, setRecurring] = useState(false);
  const contextWeekday = (new Date(`${context.date}T00:00:00`).getDay() + 6) % 7;
  const [selectedDays, setSelectedDays] = useState<number[]>([contextWeekday]);
  const [untilDate, setUntilDate] = useState<string>(isoLocal(addDays(new Date(`${context.date}T00:00:00`), 56)));
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filteredProjects = projects.filter((p) => {
    if (!search.trim()) return true;
    const haystack = `${p.customerName} ${p.name} ${p.address ?? ''}`.toLowerCase();
    return haystack.includes(search.trim().toLowerCase());
  });

  const toggleDay = (day: number) => {
    setSelectedDays((current) => {
      if (current.includes(day)) {
        return current.length > 1 ? current.filter((d) => d !== day) : current;
      }
      return [...current, day];
    });
  };

  const handleSave = async () => {
    if (!selectedProjectId) return;
    setIsSaving(true);
    setError(null);
    try {
      if (recurring) {
        await planningApi.admin.createSeries({
          employeeId: context.employeeId,
          projectId: selectedProjectId,
          weekdays: selectedDays,
          startDate: context.date,
          endDate: untilDate,
        });
      } else {
        await planningApi.admin.setAssignment({
          employeeId: context.employeeId,
          projectId: selectedProjectId,
          date: context.date,
        });
      }
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Kon deze toewijzing niet opslaan.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleClear = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await planningApi.admin.clearAssignment({ employeeId: context.employeeId, date: context.date });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Kon deze toewijzing niet wissen.');
      setIsSaving(false);
    }
  };

  const dateLabel = (() => {
    const d = new Date(`${context.date}T00:00:00`);
    const name = DAY_LABELS_FULL[(d.getDay() + 6) % 7] ?? '';
    return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${d.getFullYear()}`;
  })();

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-5">
      <div className="flex max-h-[85vh] w-full max-w-md flex-col rounded-t-2xl border border-neutral-200 bg-white shadow-xl sm:rounded-2xl">
        <div className="border-b border-neutral-100 px-5 py-4">
          <p className="text-lg font-semibold">{context.employeeDisplayName}</p>
          <p className="text-sm text-neutral-500">{dateLabel}</p>
        </div>

        <input
          type="text"
          placeholder="Zoek op klant, project of adres..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="mx-5 mt-4 rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-swatt-gold"
        />

        <ul className="flex-1 overflow-y-auto px-3 py-2">
          {filteredProjects.length === 0 && <li className="px-2 py-3 text-sm text-neutral-400">Geen project gevonden.</li>}
          {filteredProjects.map((project) => {
            const isSelected = project.id === selectedProjectId;
            return (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => setSelectedProjectId(project.id)}
                  className={`my-0.5 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm ${
                    isSelected ? 'bg-swatt-gold/20' : 'hover:bg-neutral-50'
                  }`}
                >
                  <span>
                    <span className="font-medium">{project.customerName}</span>
                    <span className="text-neutral-500"> — {project.name}</span>
                  </span>
                  {isSelected && <span className="text-swatt-gold-dark">✓</span>}
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mx-5 mb-1 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={recurring}
              onChange={(e) => setRecurring(e.target.checked)}
              className="h-4 w-4 accent-swatt-gold"
            />
            Herhaal deze toewijzing wekelijks
          </label>

          {recurring && (
            <div className="mt-3 flex flex-col gap-3 border-t border-neutral-200 pt-3">
              <div className="flex flex-wrap gap-1">
                {DAY_LABELS.map((label, day) => (
                  <button
                    key={label}
                    type="button"
                    onClick={() => toggleDay(day)}
                    className={`h-8 w-9 rounded-md border text-xs font-semibold ${
                      selectedDays.includes(day)
                        ? 'border-swatt-gold bg-swatt-gold text-swatt-black'
                        : 'border-neutral-300 bg-white text-neutral-500 hover:border-swatt-gold'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedDays([contextWeekday])}
                  className="rounded-md bg-swatt-gold/15 px-2 py-1 text-xs font-semibold text-swatt-gold-dark hover:bg-swatt-gold/25"
                >
                  Enkel deze dag
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedDays([0, 1, 2, 3, 4])}
                  className="rounded-md bg-swatt-gold/15 px-2 py-1 text-xs font-semibold text-swatt-gold-dark hover:bg-swatt-gold/25"
                >
                  Hele week (Ma–Vr)
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedDays([0, 1, 2, 3, 4, 5, 6])}
                  className="rounded-md bg-swatt-gold/15 px-2 py-1 text-xs font-semibold text-swatt-gold-dark hover:bg-swatt-gold/25"
                >
                  Elke dag (Ma–Zo)
                </button>
              </div>
              <label className="flex items-center gap-2 text-sm text-neutral-600">
                tot en met
                <input
                  type="date"
                  value={untilDate}
                  min={context.date}
                  onChange={(e) => setUntilDate(e.target.value)}
                  className="rounded-md border border-neutral-300 px-2 py-1 text-sm outline-none focus:border-swatt-gold"
                />
              </label>
            </div>
          )}
        </div>

        {error && <p className="mx-5 mb-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

        <div className="flex items-center gap-2 border-t border-neutral-100 px-5 py-4">
          {context.currentProjectId && (
            <button
              type="button"
              disabled={isSaving}
              onClick={() => void handleClear()}
              className="rounded-lg border border-neutral-300 px-3 py-2 text-sm font-semibold text-red-700 hover:border-red-300 hover:bg-red-50 disabled:opacity-50"
            >
              Wissen
            </button>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            disabled={isSaving}
            className="rounded-lg px-3 py-2 text-sm font-semibold text-neutral-500 hover:bg-neutral-100 disabled:opacity-50"
          >
            Annuleren
          </button>
          <button
            type="button"
            disabled={isSaving || !selectedProjectId || (recurring && selectedDays.length === 0)}
            onClick={() => void handleSave()}
            className="rounded-lg bg-swatt-gold px-4 py-2 text-sm font-semibold text-swatt-black disabled:opacity-50"
          >
            {isSaving ? 'Bezig...' : 'Toewijzen'}
          </button>
        </div>
      </div>
    </div>
  );
}
