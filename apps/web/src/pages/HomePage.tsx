import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { publicBrandingApi } from '../api/client';
import { ApiRequestError, useAuth } from '../auth/AuthContext';
import { ChevronRightIcon, ClockIcon, DocumentTextIcon, LogoutIcon, MapPinIcon, PlayIcon } from '../components/icons';
import { Logo } from '../components/Logo';
import { ROLE_LABELS } from '../constants';
import { useTodayPlannedProject } from '../hooks/useTodayPlannedProject';
import { getMenuSections } from '../navigation/menuSections';

/**
 * Klantvraag 10/9/2026 (herzien): "grote knoppen met de tekst en icoon
 * erop, als je erop klikt krijg je dan het submenu te zien" — de eerdere
 * inklapbare accordeon-groepen zijn vervangen door een echt tweetrapsmenu.
 *
 * "Mijn werk" (project kiezen -> tijd registreren -> werkbon, sectie 21 van
 * de projectbrief) blijft de primaire, dagelijkse flow: drie grote knoppen
 * rechtstreeks op dit scherm, niet achter een submenu-klik verstopt.
 *
 * Alle andere groepen ("Planning & team", "Werkbonnen beheren", "Facturatie
 * & rapportage", "Instellingen") staan hier zelf ook als één grote knop
 * (icoon + titel + aantal items) — een klik navigeert naar
 * `/menu/:sectionId` (SubmenuPage.tsx) waar de onderliggende items als
 * grote knoppen staan. De indeling zelf staat in `navigation/menuSections.ts`,
 * gedeeld tussen dit scherm en SubmenuPage.
 *
 * Klantvraag 11/9/2026 — "als ik inlog komt niet automatisch het project
 * naar voor waar ik ben ingepland... dat was niet de bedoeling": is er via
 * de planning een project voor vandaag toegewezen, dan vervangt een gouden
 * "Start [project]"-knop de "Mijn projecten"-keuzeknop hierboven — één tik
 * en de timer start (zie ProjectTimerPage.tsx). Een kleine link "Ander
 * project kiezen" blijft staan voor uitzonderingen (bv. een spoedopdracht
 * die niet in de planning stond); zie useTodayPlannedProject.ts.
 */
export function HomePage() {
  const { user, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const { project: todayProject } = useTodayPlannedProject(Boolean(user?.employee));
  // Sectie 21/33 — klantlogo (Bedrijfsgegevens) i.p.v. de eerder generieke
  // "Technical Support Team"-tekst, zelfde publieke route als LoginPage.tsx
  // (werkt voor élke rol, niet enkel ADMIN — company-settings.routes.ts zelf
  // blijft ADMIN-only).
  const [branding, setBranding] = useState<{ companyName: string; logoDataUrl: string | null } | null>(null);

  useEffect(() => {
    publicBrandingApi
      .get()
      .then(setBranding)
      .catch(() => setBranding(null));
  }, []);

  if (!user) return null;

  const menuSections = getMenuSections(user.role);

  const handleLogout = async () => {
    setIsLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
    } catch (err) {
      // Zonder deze afhandeling deed de knop bij een mislukte/trage aanroep
      // (bv. Render's gratis instance die na inactiviteit ~50s nodig heeft om
      // op te starten) ogenschijnlijk niets — geen foutmelding, geen laadstatus.
      setLogoutError(err instanceof ApiRequestError ? err.message : 'Uitloggen is mislukt. Probeer opnieuw.');
    } finally {
      setIsLoggingOut(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center bg-swatt-black px-6 py-10 text-white">
      {/* Zelfde gecentreerde `max-w-sm`-kolom als LoginPage.tsx — op een
          smartphone vult dit vanzelf de breedte, maar op een breed
          (desktop-)scherm blijven de knoppen zo in het midden staan i.p.v.
          edge-to-edge uit te rekken. */}
      <div className="w-full max-w-sm">
        <header className="mb-8 flex flex-col items-center gap-3">
          {/* Volledige lockup (icoon + "UURIVO"-woordmerk) zoals op het loginscherm,
              i.p.v. enkel het compacte icoon — zelfde goudomrande lichte kaart
              nodig voor zichtbaarheid (donkere tekst/pictogram op transparante
              achtergrond versmelt anders met bg-swatt-black, zie LoginPage.tsx). */}
          <div className="rounded-xl border-2 border-swatt-gold bg-neutral-50 p-4">
            <Logo size="lg" className="w-40" />
          </div>
          {branding?.logoDataUrl && (
            <img src={branding.logoDataUrl} alt={branding.companyName} className="h-10 w-auto object-contain" />
          )}
        </header>

        <section className="rounded-xl border border-neutral-800 bg-neutral-900 p-5">
          <p className="text-sm text-neutral-400">Ingelogd als</p>
          <p className="mt-1 text-lg font-semibold">{user.employee?.displayName ?? user.email}</p>
          <p className="text-sm text-swatt-gold">{ROLE_LABELS[user.role] ?? user.role}</p>
        </section>

        {/* "Mijn werk" — de primaire, dagelijkse flow (sectie 21). Is er via
            de planning een project voor vandaag toegewezen, dan vervangt een
            uitgelichte "Start"-kaart de gewone "Mijn projecten"-keuzeknop
            (klantvraag 11/9/2026) — de volledige keuzelijst blijft één tik
            verderop bereikbaar via "Ander project kiezen". */}
        <nav aria-label="Mijn werk" className="mt-6 flex flex-col gap-3">
          {todayProject ? (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-swatt-gold">Vandaag ingepland</p>
              <Link
                to={`/projecten/${todayProject.id}`}
                state={{ project: todayProject }}
                className="block rounded-xl border-2 border-swatt-gold bg-neutral-900 p-5 transition active:bg-neutral-800"
              >
                <p className="text-xs font-medium uppercase tracking-wide text-swatt-gold">
                  {todayProject.customerName}
                </p>
                <p className="mt-1 text-xl font-bold">{todayProject.name}</p>
                {todayProject.address && <p className="mt-1 text-sm text-neutral-400">{todayProject.address}</p>}
                <p className="mt-3 flex items-center justify-center gap-2 rounded-lg bg-swatt-gold px-4 py-3 text-base font-semibold text-swatt-black">
                  <PlayIcon className="h-5 w-5 shrink-0" />
                  Start werk
                </p>
              </Link>
              <Link to="/mijn-projecten" className="self-center text-sm text-neutral-400 underline">
                Ander project kiezen
              </Link>
            </div>
          ) : (
            <Link
              to="/mijn-projecten"
              className="flex items-center gap-3 rounded-lg bg-swatt-gold px-4 py-4 text-base font-semibold text-swatt-black active:opacity-80"
            >
              <MapPinIcon className="h-5 w-5 shrink-0" />
              Mijn projecten
            </Link>
          )}
          <Link
            to="/mijn-werkbonnen"
            className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-base font-semibold text-neutral-200 active:bg-neutral-800"
          >
            <DocumentTextIcon className="h-5 w-5 shrink-0 text-swatt-gold" />
            Mijn werkbonnen
          </Link>
          <Link
            to="/algemene-tijdregistratie"
            className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-base font-semibold text-neutral-200 active:bg-neutral-800"
          >
            <ClockIcon className="h-5 w-5 shrink-0 text-swatt-gold" />
            Algemene tijdregistratie
          </Link>
        </nav>

        {/* Overige groepen — elk als één grote knop die naar het submenu
            navigeert. Een groep zonder items voor deze rol zit hier al niet
            meer in (gefilterd in getMenuSections). */}
        {menuSections.length > 0 && (
          <nav aria-label="Meer" className="mt-6 flex flex-col gap-3">
            {menuSections.map((section) => (
              <Link
                key={section.id}
                to={`/menu/${section.id}`}
                className="flex items-center gap-3 rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-4 text-base font-semibold text-neutral-200 active:bg-neutral-800"
              >
                <section.icon className="h-5 w-5 shrink-0 text-swatt-gold" />
                <span className="flex-1 text-left">{section.title}</span>
                <span className="text-xs font-normal text-neutral-500">{section.items.length}</span>
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-neutral-500" />
              </Link>
            ))}
          </nav>
        )}

        {logoutError && (
          <p role="alert" className="mt-6 rounded-lg bg-red-950 px-4 py-3 text-sm text-red-300">
            {logoutError}
          </p>
        )}

        <button
          type="button"
          onClick={() => void handleLogout()}
          disabled={isLoggingOut}
          className="mt-6 flex items-center justify-center gap-2 rounded-lg border border-neutral-700 px-4 py-4 text-base font-semibold text-neutral-200 active:bg-neutral-900 disabled:opacity-50"
        >
          <LogoutIcon className="h-5 w-5 shrink-0" />
          {isLoggingOut ? 'Bezig met uitloggen...' : 'Uitloggen'}
        </button>
      </div>
    </main>
  );
}
