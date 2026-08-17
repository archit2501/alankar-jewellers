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
import { founder, site } from "../site-config";
import "./founders.css";

export const metadata: Metadata = {
  title: `The people | ${site.name}`,
  description:
    "Who makes the jewellery at Alankar Jewellers: one person, the bench, the techniques that have not changed, and the things that did.",
  alternates: { canonical: "/founders" },
  openGraph: {
    type: "profile",
    locale: "en_IN",
    url: "/founders",
    siteName: site.name,
    title: `The people | ${site.name}`,
    description:
      "One person, the bench, the techniques that have not changed, and the things that did.",
  },
};

/**
 * THE ONE RULE ON THIS PAGE — unchanged in substance since the day it had
 * nothing at all to print.
 *
 * A fact is printed only when somebody actually supplied it. `null` is what
 * "not supplied" looks like, and nobody may write a value they were not given.
 * The gate is the value itself, never a site-wide flag: the shop's street
 * address has nothing to do with whether we know what a person does.
 *
 * THE PAGE CHANGED SHAPE ON 2026-08-12. It was built for two people, mirrored,
 * with a placeholder hanging in the second mount. The shop then confirmed three
 * things: he is the third generation of the family business, he oversees
 * everything — all of the operations — and there is no second person. So the
 * second mount is not a placeholder any more, it is a wall: it has been taken
 * down rather than left empty, because a stand-in for a person who does not
 * exist is a fiction of a different and worse kind. One man is now the point of
 * the page, and the composition says so.
 *
 * WHAT IS STILL NOT KNOWN, and is not inferred anywhere below: how he relates
 * to the 1980 opening, who came before him, any year at all, his own words, his
 * email, and where in the shop to stand to find him. "Third generation" plus
 * "since 1980" is a sum this page refuses to do — see app/site-config.ts.
 */
function publishable(value: string | null | undefined): value is string {
  return Boolean(value);
}

/** The one person on this page, assembled from the facts the shop supplied. */
const person = {
  name: founder.name,
  /** "The third generation of the family business." — the client's own scope. */
  generation: founder.generation,
  /** The role as a verb, never a job title. */
  doing: founder.oversees,
  whereabouts: founder.whereabouts,
  words: founder.words,
  quote: founder.quote,
  /** Describes the photograph itself. Never the sitter's role or standing. */
  portraitAlt:
    "Saksham Goel, photographed against a pale wood-panelled wall in a navy jacket with white contrast stitching over a light blue shirt",
  portrait: "founder-saksham-goel" as ImageKey,
  reverse: "workshop-bench" as ImageKey,
  reverseAlt: "Turn over to see the workshop bench",
};

/* `founder-portrait-b` — the stand-in that used to hang in the second mount —
   is no longer referenced by anything. app/_media/images.ts is generated, so
   the asset stays in the manifest and simply goes unused; there is nowhere on
   this page a picture of a person who does not exist could honestly go. */

/**
 * The hinge. It used to sit between two portraits so that they read as a pair
 * rather than a list; there is one portrait now, so its job has changed to
 * separating the man from the promises, and to saying the thing the page cannot
 * say about him — that the craft is older than whoever is holding it. These
 * captions describe the work, which is checkable, rather than the shop, which
 * is not. Set as five lit niches in the teak almirah behind the counter.
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
 * from a flag. The disclosure has to track the actual data or it becomes its
 * own falsehood — which is exactly what happened to the sentence about a
 * stand-in portrait, and why nothing on this page says that any more.
 */
const anythingPending =
  !publishable(person.name) ||
  !publishable(person.generation) ||
  !publishable(person.doing) ||
  !publishable(person.whereabouts) ||
  person.words.length === 0 ||
  !publishable(person.quote) ||
  changes.some((change) => !change.claim);

/* No signature block. Part E allows exactly one, and only if a real signature
   exists — a signature typeface standing in for a person's hand is the kind of
   thing this audience notices, and it costs more credibility than it earns. */

export default function FoundersPage() {
  const name = publishable(person.name) ? person.name : null;
  const generation = publishable(person.generation) ? person.generation : null;
  const doing = publishable(person.doing) ? person.doing : null;
  const whereabouts = publishable(person.whereabouts) ? person.whereabouts : null;
  const quote = publishable(person.quote) ? person.quote : null;

  /**
   * Part E's caption grammar, and the first time this page has been able to
   * obey it: the name, then the role as a VERB. Until 2026-08-12 the verb was
   * unknown and the caption was the bare name, because a title invented to fill
   * the gap would have been the exact failure the page exists to avoid.
   */
  const shortVerb = publishable(founder.overseesShort) ? founder.overseesShort : null;
  const caption = name ? (shortVerb ? `${name}, ${shortVerb}.` : name) : undefined;

  /**
   * The closing line the page was built around. "Ask for X" is an instruction
   * to the visitor rather than a claim about X, and it is now backed by a fact:
   * there is no second person to ask for instead.
   */
  const askFor = name;

  const record: { label: string; value: string | null; waiting: string }[] = [
    { label: "In the family business", value: generation, waiting: "his own place in it" },
    { label: "What he does", value: doing, waiting: "a verb, not a job title" },
    { label: "Where to find him", value: whereabouts, waiting: "counter, bench or both" },
  ];

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
          {/* ---- 1. DARBAR: the sentence, and the shape of the page ---- */}
          <section
            className="section section--darbar grained jali-veil f-opener"
            aria-labelledby="f-opener-title"
          >
            <div className="wrap f-opener__grid">
              <div className="f-opener__statement">
                <h1 id="f-opener-title">
                  The techniques are two hundred years old. The man who keeps
                  them is not.
                </h1>
                {/* Said here, before the scroll reaches a single portrait, so
                    that one face reads as the answer rather than as a page
                    half-built. It is also the only place the page can explain
                    its own shape. */}
                <p className="f-opener__fact">
                  There is no second person. The third generation oversees
                  everything &mdash; all of the operations.
                </p>
              </div>

              {anythingPending ? (
                <aside className="panel--lift illuminated f-notice">
                  <p>
                    <span className="f-tag">Details pending</span>
                  </p>
                  <p>
                    This page is being filled in one confirmed fact at a time,
                    and three of them are now on the record below. What is still
                    missing is a first-person account, where in the shop to find
                    him, and the four commitments further down. None of it has
                    been written on his behalf in the meantime.
                  </p>
                </aside>
              ) : null}
            </div>
          </section>

          <div className="jali-break" aria-hidden="true">
            <div className="jali-band" />
          </div>

          {/* ---- 2. HAVELI: the portrait, and the shop's record card ---
              One mount, not the first of two. The portrait takes half the
              grid rather than the five columns it used to share with a
              mirrored twin, and the column beside it is a card with real
              values in it — which is the actual fix for the void this block
              was designed around. A form with two answers and one open line
              is a full object; a form with nothing in it was only ever an
              honest one. */}
          <section
            className="section section--haveli grained f-founder"
            aria-labelledby="f-person-title"
          >
            <div className="wrap f-founder__grid">
              <div className="f-portrait">
                <Flip
                  front={person.portrait}
                  back={person.reverse}
                  alt={person.portraitAlt}
                  altBack={person.reverseAlt}
                  sizes="(max-width: 780px) 92vw, 46vw"
                  priority
                  framed
                  caption={caption}
                />
              </div>

              <div className="f-founder__words">
                <h2 id="f-person-title">{name ?? "The person at Alankar"}</h2>
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
                  <p className="label">In his own words</p>
                  {person.words.length > 0 ? (
                    person.words.map((paragraph) => (
                      <p className="prose f-said__body" key={paragraph}>
                        {paragraph}
                      </p>
                    ))
                  ) : (
                    <>
                      {/* A ruled blank page. Unmistakably empty on purpose, and
                          it holds the column open until the recording is
                          made. */}
                      <div className="f-ruled" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                        <span />
                        <span />
                      </div>
                      <p className="f-pending">
                        His own account belongs on those lines &mdash; two or
                        three short paragraphs, first person, in his words
                        rather than ours. We have not recorded it yet, and
                        nothing has been written on his behalf.
                      </p>
                    </>
                  )}
                </div>

                {quote ? <p className="f-quote">{quote}</p> : null}
              </div>
            </div>
          </section>

          {/* ---- 3. VITRINE: the hinge, five lit niches ---------------- */}
          <section
            className="section section--vitrine grained f-strip"
            aria-labelledby="f-objects-title"
          >
            <div className="wrap">
              <div className="f-strip__head">
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

          <div className="jali-break jali-break--haveli" aria-hidden="true">
            <div className="jali-band jali-band--brass" />
          </div>

          {/* ---- 4. HAVELI: the ledger --------------------------------- */}
          <section
            className="section section--haveli grained f-changed"
            aria-labelledby="f-changed-title"
          >
            <div className="wrap">
              <div className="f-changed__head">
                <h2 id="f-changed-title">Four things you can check.</h2>
                <div className="rule-brass rule rule--full" aria-hidden="true" />
                <p className="f-changed__lede">
                  Not a timeline and not a list of adjectives. Each line is
                  meant to be a concrete thing that has changed here, stated so
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

          {/* ---- 5. DARBAR: close on a named CTA ----------------------- */}
          <section
            className="section section--darbar grained jali-veil f-close"
            aria-labelledby="f-close-title"
          >
            {/* The illuminated primitive rules two corners; a mirrored copy
                completes the frame, so the invitation sits in a ruled panel
                rather than between two stray brackets. */}
            <div className="opener illuminated f-close__panel">
              <div className="illuminated f-close__corners" aria-hidden="true" />
              <h2 id="f-close-title">
                {askFor ? `Ask for ${askFor}.` : "Ask for someone by name."}
              </h2>
              <div className="rule-gold rule rule--center" aria-hidden="true" />
              <p className="f-close__body">
                {askFor
                  ? "There is no second person: he oversees all of the operations. Tell us when you would like to come and we will keep the salon free."
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
