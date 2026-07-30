/**
 * Pure presentational mark. No "use client" directive on purpose: it renders as
 * a server component inside `app/page.tsx` and is bundled into the client
 * island only where a client component (the header) imports it.
 *
 * अलंकार (alankāra) is Sanskrit for ornament — the shop is named after the
 * thing it makes, so the mark carries the Devanagari beside the Latin rather
 * than instead of it. The Devanagari is aria-hidden: the accessible name is set
 * on the link and a screen reader should not read the house name twice.
 *
 * The self-hosted subsets are latin + latin-ext only, so the Devanagari falls
 * back to a system serif (--font-deva). That is deliberate — it is one word at
 * display size, and it is not worth a fifth font file to a visitor on 3G.
 */
export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <a
      className={`brand-mark${compact ? " brand-mark--compact" : ""}`}
      href="#top"
      aria-label="Alankar Jewellers, back to top"
    >
      <span className="brand-mark__deva" aria-hidden="true">
        अलंकार
      </span>
      <span className="brand-mark__name">Alankar</span>
      <span className="brand-mark__meta">Jewellers · Since 1980</span>
    </a>
  );
}
