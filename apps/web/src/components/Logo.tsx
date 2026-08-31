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
  return (
    <img
      src="/logo-uurivo.png"
      alt="Uurivo"
      className={['h-auto w-64', className].filter(Boolean).join(' ')}
    />
  );
}
