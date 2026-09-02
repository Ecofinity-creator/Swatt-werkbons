/**
 * Uurivo-logo. Vervangt de eerdere CSS-only "SWATT"-tekstbadge (die er stond
 * bij gebrek aan een aangeleverde huisstijl-asset) door de echte, aangeleverde
 * beeldmerken (aug 2026): de volledige lockup (icoon + wordmark) voor grote
 * plekken zoals het loginscherm, en enkel het vierkante icoon voor compacte
 * plekken zoals de header op HomePage.
 */
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
  return <img src="/logo-uurivo.png" alt="Uurivo" className={['h-auto', widthClassName].join(' ')} />;
}
