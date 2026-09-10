import type { ComponentType, SVGProps } from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { roleAtLeast } from '@swatt/shared-types';
import { publicBrandingApi } from '../api/client';
import { ApiRequestError, useAuth } from '../auth/AuthContext';
import { Logo } from '../components/Logo';
import { ROLE_LABELS } from '../constants';
import {
  AlertTriangleIcon,
  BuildingIcon,
  CalendarIcon,
  ChevronDownIcon,
  ClipboardCheckIcon,
  ClockIcon,
  DocumentTextIcon,
  DownloadIcon,
  EuroIcon,
  FolderIcon,
  LinkIcon,
  LogoutIcon,
  MapPinIcon,
  QrCodeIcon,
  ShieldCheckIcon,
  UsersIcon,
  WalletIcon,
} from '../components/icons';

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

interface NavItem {
  to: string;
  label: string;
  icon: IconComponent;
}

/**
 * Klantvraag 10/9/2026 — "het menu wat ordenen ... logisch volgens workflow
 * ingedeeld, met submenus, en logo's op de menuknoppen". De platte lijst van
 * 13+ losse knoppen (één per rol simpelweg onderaan geplakt) is vervangen
 * door groepen die de echte procesvolgorde uit de projectbrief volgen:
 *
 * 1) "Mijn werk" (sectie 1/6/7 — de dagelijkse technieker-flow: project
 *    kiezen → tijd registreren → werkbon) — altijd zichtbaar, niet-inklapbaar
 *    (het is letterlijk de primaire actie van de hele app, sectie 21).
 * 2) "Planning & team" (sectie 4/5 — vóór de uitvoering: wie werkt waar).
 * 3) "Werkbonnen beheren" (sectie 20/13/9 — controle/opvolging ná uitvoering).
 * 4) "Facturatie & rapportage" (sectie 17/19/26 — de maandafsluiting).
 * 5) "Instellingen" (sectie 3/7 — configuratie, geen dagelijkse workflow-stap).
 *
 * Elke groep ná "Mijn werk" is een inklapbaar "submenu" (`MenuSection`
 * hieronder) — standaard open (niets extra verstopt vóór een eerste klik,
 * zelfde "zo weinig mogelijk klikken"-principe als de rest van de app), maar
 * wel samenklapbaar zodra een gebruiker het scherm wil opruimen. Een sectie
 * met nul zichtbare items voor de huidige rol wordt niet gerenderd — een
 * werknemer ziet dus enkel "Mijn werk" + "Instellingen".
 */
export function HomePage() {
  const { user, logout } = useAuth();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
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

  const isSupervisorPlus = roleAtLeast(user.role, 'SUPERVISOR');
  const isAdmin = roleAtLeast(user.role, 'ADMIN');

  const planningItems: NavItem[] = isSupervisorPlus
    ? [
        { to: '/backoffice/planning', label: 'Planningsbord', icon: CalendarIcon },
        { to: '/backoffice/medewerkers', label: 'Medewerkers', icon: UsersIcon },
        { to: '/backoffice/projecten', label: 'Projecten', icon: FolderIcon },
      ]
    : [];

  const workOrderManagementItems: NavItem[] = isSupervisorPlus
    ? [
        { to: '/backoffice/werkbonnen', label: 'Werkbonnenoverzicht', icon: ClipboardCheckIcon },
        { to: '/backoffice/sync-fouten', label: 'Synchronisatiefouten', icon: AlertTriangleIcon },
      ]
    : [];

  const invoicingItems: NavItem[] = isAdmin
    ? [
        { to: '/backoffice/facturatie', label: 'Facturatie', icon: EuroIcon },
        { to: '/backoffice/uren-export', label: 'Uren-export', icon: DownloadIcon },
        { to: '/backoffice/personeelsuitbetaling', label: 'Personeelsuitbetaling', icon: WalletIcon },
        { to: '/backoffice/auditlog', label: 'Auditlog', icon: ShieldCheckIcon },
      ]
    : [];

  const settingsItems: NavItem[] = [
    { to: '/app-toegang', label: 'App op smartphone (QR-code)', icon: QrCodeIcon },
    ...(isAdmin
      ? [
          { to: '/instellingen/teamleader', label: 'Teamleader-integratie', icon: LinkIcon },
          { to: '/instellingen/bedrijf', label: 'Bedrijfsgegevens', icon: BuildingIcon },
        ]
      : []),
  ];

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
    <main className="flex min-h-screen flex-col bg-swatt-black px-6 py-10 text-white">
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

      {/* "Mijn werk" — de primaire, dagelijkse flow (sectie 21): altijd
          zichtbaar en niet-inklapbaar, met "Mijn projecten" als grote
          gouden hoofdknop (het startpunt van élke werkdag). */}
      <nav aria-label="Mijn werk" className="mt-6 flex flex-col gap-3">
        <Link
          to="/mijn-projecten"
          className="flex items-center gap-3 rounded-lg bg-swatt-gold px-4 py-4 text-base font-semibold text-swatt-black active:opacity-80"
        >
          <MapPinIcon className="h-5 w-5 shrink-0" />
          Mijn projecten
        </Link>
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

      <div className="mt-6 flex flex-col gap-3">
        <MenuSection title="Planning &amp; team" icon={CalendarIcon} items={planningItems} />
        <MenuSection title="Werkbonnen beheren" icon={ClipboardCheckIcon} items={workOrderManagementItems} />
        <MenuSection title="Facturatie &amp; rapportage" icon={EuroIcon} items={invoicingItems} />
        <MenuSection title="Instellingen" icon={BuildingIcon} items={settingsItems} />
      </div>

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
    </main>
  );
}

/**
 * Eén inklapbaar menu-"submenu" — een koptekst (icoon + titel + aantal
 * items + pijltje) die de eronderliggende links toont/verbergt. Rendert
 * niets wanneer `items` leeg is (de huidige rol heeft geen toegang tot deze
 * groep) — zo blijft bv. een werknemer nooit een lege "Facturatie"-kop zien.
 * Standaard open: geen enkele bestaande knop wordt achter een extra klik
 * verstopt, dit is puur een opruim-optie voor wie het scherm compacter wil.
 */
function MenuSection({ title, icon: Icon, items }: { title: string; icon: IconComponent; items: NavItem[] }) {
  const [isOpen, setIsOpen] = useState(true);
  if (items.length === 0) return null;

  return (
    <section className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900">
      <button
        type="button"
        onClick={() => setIsOpen((previous) => !previous)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-neutral-800"
      >
        <Icon className="h-5 w-5 shrink-0 text-swatt-gold" />
        <span className="flex-1 text-sm font-semibold uppercase tracking-wide text-neutral-200">{title}</span>
        <span className="text-xs text-neutral-500">{items.length}</span>
        <ChevronDownIcon className={`h-4 w-4 shrink-0 text-neutral-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>
      {isOpen && (
        <div className="flex flex-col divide-y divide-neutral-800 border-t border-neutral-800">
          {items.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className="flex items-center gap-3 px-4 py-3.5 text-sm font-medium text-neutral-200 active:bg-neutral-800"
            >
              <item.icon className="h-5 w-5 shrink-0 text-neutral-400" />
              {item.label}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
