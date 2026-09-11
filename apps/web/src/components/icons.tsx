/**
 * Kleine, met de hand getekende lijn-iconen voor de menuknoppen op HomePage.tsx
 * (klantvraag 10/9/2026 — "logo's op de menuknoppen zodat het er wat goed
 * uitziet"). Bewust GEEN icoon-bibliotheek toegevoegd als dependency (bv.
 * lucide-react/heroicons) — een handvol eenvoudige, generieke UI-symbolen
 * (klok, map-pin, document, ...) is precies genoeg voor dit menu en voorkomt
 * een extra dependency + bundle-gewicht voor iets zo kleins.
 *
 * Alle iconen delen dezelfde stijl: 24×24 viewBox, `currentColor`-lijnen
 * (erven dus de tekstkleur van de knop), `strokeWidth={1.75}`, ronde
 * lijnuiteinden/-hoeken. `className` bepaalt de effectieve grootte (bv.
 * `h-5 w-5`) — geen vaste breedte/hoogte hier, zodat elke aanroeper zelf de
 * juiste maat kiest.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function base(props: IconProps, children: React.ReactNode) {
  const { className, ...rest } = props;
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-5 w-5'}
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** Mijn projecten — locatie/werf. */
export function MapPinIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M12 21s7-7.5 7-12a7 7 0 1 0-14 0c0 4.5 7 12 7 12Z" />
      <circle cx="12" cy="9" r="2.5" />
    </>,
  );
}

/** Mijn werkbonnen. */
export function DocumentTextIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M7 3h7l4 4v14H7V3Z" />
      <path d="M14 3v4h4" />
      <path d="M9.5 12h6M9.5 15.5h6M9.5 8.5h3" />
    </>,
  );
}

/** Algemene tijdregistratie. */
export function ClockIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7v5l3.5 2" />
    </>,
  );
}

/** Vandaag ingepland — "Start [project]"-knop op HomePage.tsx. */
export function PlayIcon(props: IconProps) {
  return base(props, <path d="M7 4.5v15l13-7.5-13-7.5Z" strokeLinejoin="round" />);
}

/** QR-code — app op smartphone. */
export function QrCodeIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="14" y="3.5" width="6.5" height="6.5" rx="1" />
      <rect x="3.5" y="14" width="6.5" height="6.5" rx="1" />
      <path d="M14 14h3v3M14 20.5h3M20.5 14v3M20.5 20.5h.01" />
    </>,
  );
}

/** Planningsbord. */
export function CalendarIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      <path d="M4 9.5h16M8 3v4M16 3v4" />
    </>,
  );
}

/** Medewerkers. */
export function UsersIcon(props: IconProps) {
  return base(
    props,
    <>
      <circle cx="9" cy="8" r="3" />
      <path d="M3.5 19c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
      <circle cx="17.3" cy="9" r="2.3" />
      <path d="M15.8 14.2c2.4.4 4.2 2.1 4.2 4.8" />
    </>,
  );
}

/** Projecten (beheer). */
export function FolderIcon(props: IconProps) {
  return base(
    props,
    <path d="M3.5 6.5A1.5 1.5 0 0 1 5 5h4.2l1.6 2h8.2A1.5 1.5 0 0 1 20.5 8.5v9A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />,
  );
}

/** Werkbonnenoverzicht. */
export function ClipboardCheckIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="6" y="4" width="12" height="17" rx="1.8" />
      <path d="M9 4V3.2A1.2 1.2 0 0 1 10.2 2h3.6A1.2 1.2 0 0 1 15 3.2V4" />
      <path d="M9 13.2l2 2 4-4.5" />
    </>,
  );
}

/** Synchronisatiefouten. */
export function AlertTriangleIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M12 4 21 19H3L12 4Z" />
      <path d="M12 10v3.5" />
      <path d="M12 16.5v.01" />
    </>,
  );
}

/** Facturatie — eurosymbool. */
export function EuroIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M15.5 7.2a5.5 5.5 0 1 0 0 9.6" />
      <path d="M6 10.2h6M6 13.4h5" />
    </>,
  );
}

/** Uren-export. */
export function DownloadIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M12 3v12" />
      <path d="M7.5 10.5 12 15l4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </>,
  );
}

/** Personeelsuitbetaling. */
export function WalletIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="3" y="6.5" width="18" height="13" rx="2" />
      <path d="M3 10.2h18" />
      <path d="M17 14.2h.01" />
    </>,
  );
}

/** Auditlog. */
export function ShieldCheckIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3Z" />
      <path d="M9 12l2 2 4-4.5" />
    </>,
  );
}

/** Teamleader-integratie — koppeling. */
export function LinkIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M9 15l6-6" />
      <path d="M8 12.5 5.8 14.7a3 3 0 0 0 4.2 4.2L12.2 16.7" />
      <path d="M16 11.5l2.2-2.2a3 3 0 0 0-4.2-4.2L11.8 7.3" />
    </>,
  );
}

/** Bedrijfsgegevens — gebouw. */
export function BuildingIcon(props: IconProps) {
  return base(
    props,
    <>
      <rect x="5" y="3.5" width="14" height="17" rx="1" />
      <path d="M9 7.5h1.2M13.8 7.5H15M9 11h1.2M13.8 11H15M9 14.5h1.2M13.8 14.5H15" />
      <path d="M10 20.5v-4h4v4" />
    </>,
  );
}

/** Uitloggen. */
export function LogoutIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M9 21H5.5A1.5 1.5 0 0 1 4 19.5v-15A1.5 1.5 0 0 1 5.5 3H9" />
      <path d="M16.5 16.5 21 12l-4.5-4.5" />
      <path d="M21 12H9" />
    </>,
  );
}

/** Uitklap-pijltje (bv. voor een select of accordeon elders in de app). */
export function ChevronDownIcon(props: IconProps) {
  return base(props, <path d="M6 9l6 6 6-6" />);
}

/** Wijst naar een submenu — rechts op de grote menuknoppen op HomePage. */
export function ChevronRightIcon(props: IconProps) {
  return base(props, <path d="M9 6l6 6-6 6" />);
}

/** Terug-knop op SubmenuPage. */
export function ArrowLeftIcon(props: IconProps) {
  return base(
    props,
    <>
      <path d="M19 12H5" />
      <path d="M11 6l-6 6 6 6" />
    </>,
  );
}
