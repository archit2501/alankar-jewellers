/**
 * Pure presentational mark. No "use client" directive on purpose: it renders as
 * a server component inside `app/page.tsx` and is bundled into the client
 * island only where a client component (the header) imports it.
 *
 * Two things went in the rebuild. The three-line stack ("ALANKAR" / "JEWELLERS"
 * at 0.58em tracking / "SINCE 1980" flanked by two rules) spread nine letters
 * across eleven character-widths of air, and the flanking rules were sized
 * against a fixed min-width, so they overhung the name in the compact footer
 * variant. It is now name plus one line of qualifier at the site's single
 * uppercase tracking value.
 */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className={`brand-mark${compact ? " brand-mark--compact" : ""}`}
      href="#top"
      aria-label="Alankar Jewellers, back to top"
    >
      <span className="brand-mark__name">Alankar</span>
      <span className="brand-mark__meta">Jewellers · Since 1980</span>
    </a>
  );
}
