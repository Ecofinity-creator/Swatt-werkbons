/**
 * Uurivo-logo. Vervangt de eerdere CSS-only "SWATT"-tekstbadge (die er stond
 * bij gebrek aan een aangeleverde huisstijl-asset) door de echte, aangeleverde
 * beeldmerken (aug 2026): de volledige lockup (icoon + wordmark) voor grote
 * plekken zoals het loginscherm, en enkel het vierkante icoon voor compacte
 * plekken zoals de header op HomePage.
 *
 * `logo-uurivo.png` wordt bewust via een ES-import geladen (i.p.v. een vast
 * pad naar `public/`, zoals voorheen) zodat Vite er bij elke build een
 * inhoud-gebaseerde bestandsnaam aan geeft (bv. `logo-uurivo.a1b2c3d4.png`).
 * Zonder dat behoudt een bestand in `public/` altijd exact dezelfde naam,
 * waardoor een CDN/browser een gewijzigd logo (zoals de bijsnede van
 * 1/9/2026) soms stil bleef cachen — met een unieke naam per versie is dat
 * structureel onmogelijk. `icon-192.png` hieronder blijft wél op zijn vaste
 * pad, want dat staat ook los in manifest.webmanifest (PWA-icoon) en moet
 * daarom een voorspelbaar, stabiel pad behouden.
 */
import logoUurivo from '../assets/logo-uurivo.png';

export function Logo({ size = 'lg', className = '' }: { size?: 'lg' | 'md'; className?: string }) {
  if (size === 'md') {
    return (
      <img
        src="/icon-192.png"
        alt="Uurivo"
        className={['h-10 w-10 rounded-xl', className].filter(Boolean).join(' ')}
      />
    );
  }
  // Bewust GEEN hardcoded w-64 als vaste basisklasse: als de aanroeper een
  // eigen breedte meegeeft via `className` (bv. de kleinere lockup in de
  // header van HomePage.tsx), zou een tweede, conflicterende `w-*`-klasse
  // in dezelfde classlist onvoorspelbaar zijn (Tailwind lost dat op via
  // stylesheet-volgorde, niet via JSX-volgorde) — vandaar de expliciete
  // fallback hieronder i.p.v. simpelweg samen te voegen.
  const widthClassName = className.includes('w-') ? className : ['w-64', className].filter(Boolean).join(' ');
  return <img src={logoUurivo} alt="Uurivo" className={['h-auto', widthClassName].join(' ')} />;
}
