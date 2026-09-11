import type { ProjectSummary } from '@swatt/shared-types';
import { useEffect, useState } from 'react';
import { planningApi, projectsApi } from '../api/client';

/** JJJJ-MM-DD in LOKALE tijd — zelfde conventie/reden als PlanningBoardPage.tsx's `isoLocal`. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
function todayIsoLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface TodayPlannedProjectState {
  /** true zolang de onderliggende aanroepen nog niet allebei klaar zijn. */
  loading: boolean;
  /** Het vandaag-ingeplande project — enkel gezet als het ook effectief in
   *  "Mijn projecten" (ProjectAssignment) voorkomt, zie business rule 12. */
  project: ProjectSummary | null;
}

/**
 * Klantvraag 11/9/2026: "als ik als werknemer inlog komt niet automatisch
 * het project naar voor waar ik ben ingepland, maar krijg ik nog steeds de
 * mogelijkheid om te kiezen uit projecten. Dat was niet de bedoeling."
 *
 * Voorheen (Fase 13) stond het ingeplande project enkel als uitgelichte
 * banner ÓP de "Mijn projecten"-lijst — de technieker moest dus altijd eerst
 * naar die pagina navigeren en zag daar nog steeds de volledige lijst.
 * HomePage.tsx gebruikt deze hook nu om, zodra er een planning is, meteen
 * één "Start [project]"-knop te tonen i.p.v. de "Mijn projecten"-keuzeknop
 * (gekozen aanpak: "Automatisch naar START, met terugvalmogelijkheid" —
 * de volledige projectkeuze blijft bereikbaar via een kleine link, voor
 * uitzonderingen zoals een spoedopdracht die niet in de planning stond).
 * EmployeeProjectsPage.tsx (die terugvallijst) gebruikt exact dezelfde hook,
 * zodat beide schermen precies hetzelfde "vandaag"-project hanteren.
 *
 * Business rule 12 blijft gelden: een planningtoewijzing is een suggestie/
 * versnelling, geen aparte toegangsdeur. Het ingeplande project wordt enkel
 * teruggegeven als het ook effectief in `projectsApi.mine()` voorkomt
 * (dezelfde ProjectAssignment-controle als de rest van de app) — ontbreekt
 * die koppeling toch, dan geeft deze hook `project: null` terug en valt de
 * UI stil terug op de normale projectkeuze (geen foutmelding).
 *
 * `enabled=false` (geen Employee-record — bv. een zuiver kantoor-/
 * adminaccount zonder eigen tijdregistratie) slaat beide aanroepen over,
 * i.p.v. een "niet geauthenticeerd"-fout van `/planning/mine` te laten
 * optreden (die route vereist `currentUser.employee.id`, zie
 * planning.routes.ts).
 */
export function useTodayPlannedProject(enabled: boolean): TodayPlannedProjectState {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [todayProjectId, setTodayProjectId] = useState<string | null>(null);
  const [planningLoaded, setPlanningLoaded] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setProjects([]);
      setTodayProjectId(null);
      setPlanningLoaded(true);
      return;
    }

    projectsApi
      .mine()
      .then((response) => setProjects(response.projects))
      .catch(() => setProjects([]));

    // Stille best-effort ophaling — geen planning voor vandaag is een
    // normale situatie, geen foutmelding tonen; de gewone projectkeuze
    // blijft sowieso het vangnet.
    //
    // Klantvraag 11/9/2026: "ik kan nog steeds kiezen tussen de 2 projecten,
    // niet wat er op de planning staat" — bleek geen caching-probleem
    // (overleefde herinstalleren), maar een dag-mismatch: de server bepaalde
    // "vandaag" voorheen uit zijn eigen systeemklok (UTC), die rond
    // middernacht een andere kalenderdag kan aanwijzen dan de telefoon
    // (lokale tijd, bv. UTC+1/+2 in België). `today` stuurt nu expliciet de
    // lokale kalenderdag van de telefoon mee, zodat beide kanten altijd
    // dezelfde dag bedoelen.
    const todayIso = todayIsoLocal();
    planningApi
      .mine(1, todayIso)
      .then((response) => {
        setTodayProjectId(response.assignments.find((a) => a.date === todayIso)?.projectId ?? null);
      })
      .catch(() => setTodayProjectId(null))
      .finally(() => setPlanningLoaded(true));
  }, [enabled]);

  const loading = projects === null || !planningLoaded;
  const project = todayProjectId ? (projects?.find((p) => p.id === todayProjectId) ?? null) : null;
  return { loading, project };
}
