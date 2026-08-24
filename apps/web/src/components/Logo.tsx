/**
 * Gestileerd "logo" — zwarte badge met gouden lettertype (Stevens verzoek:
 * "logo wat blitser maken, zwarte achtergrond, gouden tekst"). Geen apart
 * beeldbestand (nog geen aangeleverde huisstijl-asset), maar een lichtgewicht
 * CSS-only badge i.p.v. de eerdere kale, witte tekst — met een subtiele
 * gouden gloed. Dezelfde zwart/goud-behandeling wordt ook gebruikt als
 * fallback-logo in de werkbon-PDF wanneer er geen bedrijfslogo geconfigureerd
 * is (zie apps/api/.../work-order-pdf-document.ts) — consistente huisstijl
 * op beide plekken.
 */
export function Logo({ size = 'lg', className = '' }: { size?: 'lg' | 'md'; className?: string }) {
  const isLarge = size === 'lg';
  return (
    <div
      className={[
        'inline-flex items-center justify-center rounded-2xl border border-swatt-gold/30 bg-black shadow-[0_0_30px_-8px_rgba(240,185,11,0.55)]',
        isLarge ? 'px-8 py-5' : 'px-4 py-2.5',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <span
        className={[
          'font-extrabold text-swatt-gold',
          isLarge ? 'text-4xl tracking-[0.2em]' : 'text-xl tracking-[0.15em]',
        ].join(' ')}
      >
        SWATT
      </span>
    </div>
  );
}
