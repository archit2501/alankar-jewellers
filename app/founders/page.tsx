/* eslint-disable @next/next/no-img-element --
 * Raw <img> is a DELIBERATE CHOICE here, not a forced one. That distinction
 * used to be the other way round and the comment this replaces was, by the end,
 * simply false.
 *
 * The original reason was real: there was no wrangler.jsonc, vite.config.ts
 * declared neither ASSETS nor IMAGES, and /_vinext/image threw on an undefined
 * binding. Then `vinext deploy` generated a wrangler.jsonc declaring both, it
 * was committed, and the optimizer started working -- verified by driving it
 * through the built Worker with both bindings supplied: 200 image/webp at every
 * allowed width.
 *
 * We keep build-time sizing anyway, for reasons that stand on their own:
 * scripts/build-images.mjs emits every derivative ahead of time and generates
 * app/_media/images.ts, so each <img> carries intrinsic width/height and a real
 * srcSet. Layout shift is structurally zero rather than merely usually zero,
 * and no request pays for a transform. Switching to next/image would trade that
 * for per-request work and a runtime dependency on a binding this project has
 * already watched appear and disappear once.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { AppointmentProvider, AppointmentTrigger } from "../_components/appointment";
import { Flip } from "../_components/flip";
import { images, type ImageKey } from "../_media/images";
import { site } from "../site-config";
import "./founders.css";

export const metadata: Metadata = {
  title: `The people | ${site.name}`,
  description:
    "Who makes the jewellery at Alankar Jewellers: the bench, the techniques that have not changed, and the things the newer generation did change.",
  alternates: { canonical: "/founders" },
  openGraph: {
    type: "profile",
    locale: "en_IN",
    url: "/founders",
    siteName: site.name,
    title: `The people | ${site.name}`,
    description:
      "The bench, the techniques that have not changed, and the things the newer generation did change.",
  },
};

/**
 * THE ONE RULE ON THIS PAGE — unchanged in substance, changed in granularity.
 *
 * A fact is printed only when somebody actually supplied it. It used to be
 * gated on the site-wide `SITE_DETAILS_PENDING` as well, which was a second
 * lock on the same door and, once one real fact arrived, the wrong lock: the
 * shop's street address has nothing to do with whether we know a person's
 * name. The gate is now the value itself. `null` is what "not supplied" looks
 * like, and nobody may write a value they were not given.
 *
 * So: one name is now real, and everything around it is still null — no role,
 * no biography, no quote, no relationship to the 1980 founding, no dates. Every
 * slot waiting for a real answer renders as visibly unfinished rather than
 * being filled with plausible-sounding copy.
 */
function publishable(value: string | null | undefined): value is string {
  return Boolean(value);
}

type Founder = {
  /**
   * Generic scaffolding, printed ONLY while `name` is null. Deliberately null
   * for anyone whose name we have: every stand-in label available here
   * ("Founder", "Co-founder") is itself a claim about a person, and the point
   * of knowing a name is that we no longer have to make one.
   */
  standIn: string | null;
  /** Which of the two mounts on the wall this is. Structure, not biography. */
  mount: string;
  /** The proprietor's name, as they want it written. */
  name: string | null;
  /**
   * Is `portrait` a photograph of THIS person, or a stand-in for one that has
   * not been taken? The page says so either way, and says nothing about a real
   * person's picture that would be true only of a placeholder.
   */
  portraitIsReal: boolean;
  /** TODO: the role as a VERB, not a job title — "buys the stones". */
  doing: string | null;
  /** TODO: where in the shop a customer actually finds this person. */
  whereabouts: string | null;
  /** TODO: two or three short paragraphs, recorded in the first person. */
  words: string[];
  /** TODO: one line, in their own words. Set without quotation marks. */
  quote: string | null;
  /** Describes the photograph itself. Never the sitter's role or standing. */
  portraitAlt: string | null;
  portrait: ImageKey;
  reverse: ImageKey;
  reverseAlt: string;
};

const founders: Founder[] = [
  {
    // The one supplied fact about a person on this entire page.
    //
    // NOT SUPPLIED, AND NOT GUESSED AT: what he does, what he is called at the
    // shop, and how he relates to the 1980 founding. The shop dates to 1980 and
    // the photograph is plainly of a much younger man, so he is very likely the
    // next generation rather than the founder — "very likely" is not a fact,
    // and this page does not print inferences. `standIn` is therefore null
    // rather than "Founder", and no line below implies he opened the shop.
    standIn: null,
    mount: "First mount",
    name: "Saksham Goel",
    portraitIsReal: true,
    doing: null,
    whereabouts: null,
    words: [],
    quote: null,
    // Describes what is in the frame and nothing else.
    portraitAlt:
      "Saksham Goel, photographed against a pale wood-panelled wall in a navy jacket with white contrast stitching over a light blue shirt",
    portrait: "founder-saksham-goel",
    reverse: "workshop-bench",
    reverseAlt: "Turn over to see the workshop bench",
  },
  {
    // Entirely unsupplied — no name, and no photograph. Unchanged treatment.
    standIn: "Co-founder",
    mount: "Second mount",
    name: null,
    portraitIsReal: false,
    doing: null,
    whereabouts: null,
    words: [],
    quote: null,
    portraitAlt: null,
    portrait: "founder-portrait-b",
    reverse: "workshop-hands",
    reverseAlt: "Turn over to see a piece being set by hand",
  },
];

/**
 * The hinge between the two portraits. Two founder blocks in a row read as a
 * list; something that belongs to neither of them makes them read as a pair.
 * These captions describe the craft, which is checkable, rather than the shop,
 * which is not. Set as five lit niches in the teak almirah behind the counter,
 * which is exactly where a real shop keeps this row of things.
 */
const objects: { key: ImageKey; name: string; note: string }[] = [
  {
    key: "workshop-hands",
    name: "The bench",
    note: "Every stone is pushed into its seat by hand, one at a time.",
  },
  {
    key: "jadau-haar-front",
    name: "Jadau",
    note: "Uncut stones held by pressed gold rather than by claws.",
  },
  {
    key: "polki-choker-reverse",
    name: "Meenakari",
    note: "The reverse is enamelled whether or not a room ever sees it.",
  },
  {
    key: "chandbali-earrings-front",
    name: "Chandbali",
    note: "The crescent, hung so that it swings rather than sits.",
  },
  {
    key: "kundan-kada-front",
    name: "Kada",
    note: "Weight you register in the hand before you look at it.",
  },
];

/**
 * The "modern" claim, made in facts rather than adjectives — which is why the
 * facts have to be real. Each `claim` stays null until the shop confirms it in
 * writing; a null renders as an open question, never as a sentence.
 */
const changes: { label: string; claim: string | null }[] = [
  { label: "Certification", claim: null },
  { label: "Pricing", claim: null },
  { label: "Buyback", claim: null },
  { label: "The reverse", claim: null },
];

/**
 * What the page is still waiting for, derived from the data above rather than
 * from a flag. Both notices used to hang off `SITE_DETAILS_PENDING`, which
 * meant that once a real photograph arrived the page would have gone on
 * calling it a stand-in — the disclosure has to track the actual data or it
 * becomes its own falsehood.
 */
const anythingPending =
  founders.some(
    (founder) =>
      !founder.name ||
      !founder.doing ||
      !founder.whereabouts ||
      founder.words.length === 0 ||
      !founder.quote,
  ) || changes.some((change) => !change.claim);

/** True while any portrait on the wall is a placeholder for an untaken photo. */
const anyPortraitIsAStandIn = founders.some((founder) => !founder.portraitIsReal);

/* No signature block. Part E allows exactly one, and only if a real signature
   exists — a signature typeface standing in for a person's hand is the kind of
   thing this audience notices, and it costs more credibility than it earns. */

export default function FoundersPage() {
  const lead = founders[0];
  /**
   * The closing line this page was built around, and the first time it has had
   * a name to put in it. "Ask for X" is an instruction to the visitor, not a
   * claim about X — it asserts no title, no role and no position behind the
   * counter, all of which are still pending in the record card above.
   */
  const askFor = publishable(lead.name) ? lead.name : null;

  return (
    <AppointmentProvider>
      <div className="f-page">
        {/* ---- DARBAR: the lintel ------------------------------------- */}
        <header className="f-topbar section--darbar-deep grained">
          <div className="wrap f-topbar__inner">
            <Link className="f-wordmark" href="/">
              <span className="f-wordmark__name">Alankar Jewellers</span>
              <span className="f-wordmark__since">Since {site.foundedYear}</span>
            </Link>
            {/* The shared SiteHeader navigates by homepage hash anchors, which
                are dead on this route, so this page carries its own bar. */}
            <nav className="f-nav" aria-label="Alankar Jewellers">
              <Link href="/">The shop</Link>
              <Link href="/founders" aria-current="page">
                The people
              </Link>
            </nav>
          </div>
          <div className="rule-gold" aria-hidden="true" />
        </header>

        <main>
          {/* ---- 1. DARBAR: one sentence, no image --------------------- */}
          <section
            className="section section--darbar grained jali-veil f-opener"
            aria-labelledby="f-opener-title"
          >
            <div className="wrap f-opener__grid">
              <div className="f-opener__statement">
                <p className="label">The people</p>
                <h1 id="f-opener-title">
                  The techniques are two hundred years old. The people are not.
                </h1>
              </div>

              {anythingPending ? (
                <aside className="panel--lift illuminated f-notice">
                  <p>
                    <span className="f-tag">Details pending</span>
                  </p>
                  <p>
                    This page is being filled in one confirmed fact at a time.
                    One name is now real. The roles, the proprietors&rsquo; own
                    words and the specific commitments below are still being
                    confirmed with the shop, and nothing has been written on
                    their behalf in the meantime.
                  </p>
                  {anyPortraitIsAStandIn ? (
                    <p>
                      The second portrait is a stand-in for a photograph that has
                      not been taken yet, and is not a picture of a real person.
                      Every portrait on this page says which of the two it is.
                    </p>
                  ) : null}
                </aside>
              ) : null}
            </div>
          </section>

          <div className="jali-break" aria-hidden="true">
            <div className="jali-band" />
          </div>

          {/* ---- 2 & 3. HAVELI: portrait one, and their own words ------ */}
          <FounderBlock founder={founders[0]} priority />

          {/* ---- 4. VITRINE: the hinge, five lit niches ---------------- */}
          <section
            className="section section--vitrine grained f-strip"
            aria-labelledby="f-objects-title"
          >
            <div className="wrap">
              <div className="f-strip__head">
                <p className="label">Between the two of them</p>
                <h2 id="f-objects-title">
                  Five things that outlast whoever is at the bench.
                </h2>
              </div>
              <div className="rule-gold rule rule--full" aria-hidden="true" />
              <ul className="f-strip__list">
                {objects.map((object) => {
                  const asset = images[object.key];
                  return (
                    <li className="f-object" key={object.key}>
                      <figure>
                        <span className="f-object__niche arch">
                          <img
                            src={asset.src}
                            srcSet={asset.srcSet}
                            sizes="(max-width: 780px) 58vw, 18vw"
                            width={asset.width}
                            height={asset.height}
                            alt=""
                            loading="lazy"
                            decoding="async"
                          />
                        </span>
                        <figcaption>
                          <span className="f-object__name">{object.name}</span>
                          <span className="f-object__note">{object.note}</span>
                        </figcaption>
                      </figure>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          {/* ---- 5. HAVELI: portrait two, mirrored --------------------- */}
          <FounderBlock founder={founders[1]} mirrored />

          <div className="jali-break jali-break--haveli" aria-hidden="true">
            <div className="jali-band jali-band--brass" />
          </div>

          {/* ---- 6. HAVELI: the ledger --------------------------------- */}
          <section
            className="section section--haveli grained f-changed"
            aria-labelledby="f-changed-title"
          >
            <div className="wrap">
              <div className="f-changed__head">
                <p className="label">What changed</p>
                <h2 id="f-changed-title">Four things you can check.</h2>
                <div className="rule-brass rule rule--full" aria-hidden="true" />
                <p className="f-changed__lede">
                  Not a timeline and not a list of adjectives. Each line is meant
                  to be a concrete thing the newer generation changed, stated so
                  that a customer can hold us to it.
                </p>
              </div>
              <dl className="f-changed__list">
                {changes.map((change) => (
                  <div className="f-row" key={change.label}>
                    <dt>{change.label}</dt>
                    <dd>
                      {publishable(change.claim) ? (
                        change.claim
                      ) : (
                        <span className="f-pending">
                          <span className="f-tag">Pending</span>
                          Being confirmed with the shop. It will be published
                          here once it is a promise the shop has actually made.
                        </span>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          </section>

          <div className="jali-break" aria-hidden="true">
            <div className="jali-band" />
          </div>

          {/* ---- 8. DARBAR: close on a named CTA ----------------------- */}
          <section
            className="section section--darbar grained jali-veil f-close"
            aria-labelledby="f-close-title"
          >
            {/* The illuminated primitive rules two corners; a mirrored copy
                completes the frame, so the invitation sits in a ruled panel
                rather than between two stray brackets. */}
            <div className="opener illuminated f-close__panel">
              <div className="illuminated f-close__corners" aria-hidden="true" />
              <p className="label">Come and see</p>
              <h2 id="f-close-title">
                {askFor ? `Ask for ${askFor}.` : "Ask for someone by name."}
              </h2>
              <div className="rule-gold rule rule--center" aria-hidden="true" />
              <p className="f-close__body">
                {askFor
                  ? "Tell us when you would like to come and we will keep the salon free."
                  : "The name that belongs in that line is still being confirmed, so we are not going to guess at it. Tell us when you would like to come and we will call you back."}
              </p>
              <AppointmentTrigger className="button f-cta">
                Book a viewing
              </AppointmentTrigger>
            </div>
          </section>
        </main>

        <footer className="f-colophon section--darbar-deep grained">
          <div className="wrap">
            <p>
              {site.name}, since {site.foundedYear}.{" "}
              <Link href="/">Back to the shop</Link>
            </p>
          </div>
        </footer>
      </div>
    </AppointmentProvider>
  );
}

/**
 * A founder block: a portrait hung on a plaster wall, with the shop's own
 * record card beside it.
 *
 * THE PLACEHOLDER-VOID PROBLEM. With no name, no role and no recorded words, a
 * conventional heading-plus-paragraphs column is three short lines beside a tall
 * portrait — a hole. The fix here is compositional rather than editorial: the
 * column is set as a record card and a ruled blank page, because a form waiting
 * to be filled in is a *full* object and is honest by its very shape. Nothing
 * in it asserts anything about a person.
 */
function FounderBlock({
  founder,
  mirrored = false,
  priority = false,
}: {
  founder: Founder;
  mirrored?: boolean;
  priority?: boolean;
}) {
  const name = publishable(founder.name) ? founder.name : null;
  const doing = publishable(founder.doing) ? founder.doing : null;
  const whereabouts = publishable(founder.whereabouts) ? founder.whereabouts : null;
  const quote = publishable(founder.quote) ? founder.quote : null;
  const words = founder.words;

  const alt = publishable(founder.portraitAlt)
    ? founder.portraitAlt
    : `Placeholder portrait standing in for a photograph of the ${(
        founder.standIn ?? "second proprietor"
      ).toLowerCase()}, which has not been taken yet`;

  /**
   * The caption is where the real person and the placeholder sit closest
   * together, so it is the line most likely to lie by symmetry.
   *
   * A stand-in must say it is one. A real photograph must NOT inherit that
   * sentence — and must not be given a title to fill the gap where the
   * stand-in's disclaimer used to be. With a name and no role, the caption is
   * the name, full stop.
   */
  const caption = founder.portraitIsReal
    ? name && doing
      ? `${name} — ${doing}`
      : (name ?? undefined)
    : "Placeholder image. Not a photograph of a real person — turn it over for the workshop.";

  const record: { label: string; value: string | null; waiting: string }[] = [
    { label: "Name", value: name, waiting: "as they want it written" },
    // Part E's caption grammar: the role as a verb, never a job title.
    { label: "What they do", value: doing, waiting: "a verb, not a job title" },
    { label: "Where to find them", value: whereabouts, waiting: "counter, bench or both" },
  ];

  return (
    <section
      className={`section section--haveli grained f-founder${
        mirrored ? " f-founder--mirrored" : ""
      }`}
      aria-labelledby={`f-${founder.portrait}`}
    >
      <div className="wrap f-founder__grid">
        <div className="f-portrait">
          <Flip
            front={founder.portrait}
            back={founder.reverse}
            alt={alt}
            altBack={founder.reverseAlt}
            sizes="(max-width: 780px) 88vw, 40vw"
            priority={priority}
            framed
            caption={caption}
          />
        </div>

        <div className="f-founder__words">
          <p className="label">{founder.mount}</p>
          <h2 id={`f-${founder.portrait}`}>
            {name ?? founder.standIn ?? founder.mount}
          </h2>
          <div className="rule-brass rule rule--full" aria-hidden="true" />

          <dl className="panel illuminated illuminated--brass f-record">
            {record.map((row) => (
              <div className="f-record__row" key={row.label}>
                <dt>{row.label}</dt>
                <dd>
                  {row.value ?? (
                    <span className="f-pending">
                      <span className="f-tag">Pending</span>
                      {row.waiting}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>

          <div className="f-said">
            <p className="label">In their own words</p>
            {words.length > 0 ? (
              words.map((paragraph) => (
                <p className="prose f-said__body" key={paragraph}>
                  {paragraph}
                </p>
              ))
            ) : (
              <>
                {/* A ruled blank page. Unmistakably empty on purpose, and it
                    holds the column open until the recording is made. */}
                <div className="f-ruled" aria-hidden="true">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
                <p className="f-pending">
                  Their own account belongs on those lines — two or three short
                  paragraphs, first person, in their words rather than ours. We
                  have not recorded it yet, and nothing has been written on their
                  behalf.
                </p>
              </>
            )}
          </div>

          {quote ? <p className="f-quote">{quote}</p> : null}
        </div>
      </div>
    </section>
  );
}
