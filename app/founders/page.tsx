/* eslint-disable @next/next/no-img-element --
 * This site is served from Cloudflare Workers via vinext. `next/image` cannot
 * work here: worker/index.ts routes /_vinext/image through `env.IMAGES`, but
 * vite.config.ts declares no such binding, so the optimizer throws before its
 * own error handling runs (research/01-codebase.md). Every <img> below therefore
 * takes its intrinsic width/height and srcSet from the generated manifest in
 * app/_media/images.ts, which keeps cumulative layout shift at zero.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { AppointmentProvider, AppointmentTrigger } from "../_components/appointment";
import { Flip } from "../_components/flip";
import { images, type ImageKey } from "../_media/images";
import { SITE_DETAILS_PENDING, site } from "../site-config";
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
 * `SITE_DETAILS_PENDING` is a literal `true` today; widening it to `boolean`
 * keeps both branches type-checked, exactly as app/_components/appointment.tsx
 * and app/_components/contact-details.tsx do, so flipping the single flag in
 * site-config.ts is all that is needed to take this page live.
 */
const detailsPending: boolean = SITE_DETAILS_PENDING;

/**
 * THE ONE RULE ON THIS PAGE — unchanged by the redesign.
 *
 * A fact is printed only when the flag is off AND somebody has actually filled
 * the value in. Nothing below is invented: there are no names, no biographies,
 * no quotes, no ages, no awards and no dates on this page, because none were
 * supplied. Every slot that is waiting for a real answer renders as visibly
 * unfinished instead of being filled with plausible-sounding copy.
 *
 * The visual language changed completely. The honesty behaviour did not.
 */
function publishable(value: string | null | undefined): value is string {
  return !detailsPending && Boolean(value);
}

type Founder = {
  /** Generic scaffolding. Safe to print while the real name is unknown. */
  standIn: string;
  /** Which of the two mounts this is. Structure, not biography. */
  mount: string;
  /** TODO: the proprietor's name, as they want it written. */
  name: string | null;
  /** TODO: the role as a VERB, not a job title — "buys the stones". */
  doing: string | null;
  /** TODO: where a customer actually finds this person in the shop. */
  whereabouts: string | null;
  /** TODO: two or three short paragraphs, recorded in the first person. */
  words: string[];
  /** TODO: one line, in their own words. Set without quotation marks. */
  quote: string | null;
  /** TODO: describe the finished photograph once it has been taken. */
  portraitAlt: string | null;
  portrait: ImageKey;
  reverse: ImageKey;
  reverseAlt: string;
};

const founders: Founder[] = [
  {
    standIn: "Founder",
    mount: "First mount",
    name: null,
    doing: null,
    whereabouts: null,
    words: [],
    quote: null,
    portraitAlt: null,
    portrait: "founder-portrait-a",
    reverse: "workshop-bench",
    reverseAlt: "Turn over to see the workshop bench",
  },
  {
    standIn: "Co-founder",
    mount: "Second mount",
    name: null,
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
 * which is not. Set as five lit niches in a teak wall — the almirah behind the
 * counter, which is where a real shop keeps exactly this row of things.
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

/* No signature block. Part E allows exactly one, and only if a real signature
   exists — a signature typeface standing in for a person's hand is the kind of
   thing this audience notices, and it costs more credibility than it earns. */

export default function FoundersPage() {
  const lead = founders[0];
  const askFor = publishable(lead.name) ? lead.name : null;

  return (
    <AppointmentProvider>
      <div className="f-page">
        {/* ---- DARBAR: the lintel ------------------------------------- */}
        <header className="f-topbar f-dark grained">
          <div className="f-shell f-topbar__inner">
            <Link className="f-wordmark" href="/">
              <span className="f-wordmark__name">Alankar Jewellers</span>
              <span className="f-wordmark__since">Since {site.foundedYear}</span>
            </Link>
            <nav className="f-nav" aria-label="Alankar Jewellers">
              <Link href="/">The shop</Link>
              {/* The shared SiteHeader navigates by homepage hash anchors, which
                  are dead on this route, so this page carries its own bar. */}
              <Link href="/founders" aria-current="page">
                The people
              </Link>
            </nav>
          </div>
          <div className="rule-gold f-rule" aria-hidden="true" />
        </header>

        <main>
          {/* ---- 1. DARBAR: one sentence, no image --------------------- */}
          <section className="f-opener f-dark grained jali-veil" aria-labelledby="f-opener-title">
            <div className="f-shell f-opener__grid">
              <div className="f-opener__statement">
                <p className="f-label">The people</p>
                <h1 id="f-opener-title">
                  The techniques are two hundred years old. The people are not.
                </h1>
              </div>

              {detailsPending ? (
                <aside className="f-notice illuminated">
                  <p className="f-notice__head">
                    <span className="f-tag">Details pending</span>
                  </p>
                  <p>
                    This page is built but not yet filled in. The names, the
                    proprietors&rsquo; own words and the specific commitments
                    below are being confirmed with the shop, and nothing has been
                    written on their behalf.
                  </p>
                  <p>
                    The photographs, including both portraits, are stand-ins for
                    pictures that have not been taken yet. They are not
                    photographs of the proprietors.
                  </p>
                </aside>
              ) : null}
            </div>
            <div className="jali-band f-seam" aria-hidden="true" />
          </section>

          {/* ---- 2 & 3. HAVELI: portrait one, and their own words ------ */}
          <FounderBlock founder={founders[0]} priority />

          {/* ---- 4. HAVELI: the hinge, five lit niches ----------------- */}
          <section className="f-strip f-dark grained" aria-labelledby="f-objects-title">
            <div className="f-shell">
              <div className="f-strip__head">
                <p className="f-label">Between the two of them</p>
                <h2 id="f-objects-title">
                  Five things that outlast whoever is at the bench.
                </h2>
              </div>
              <div className="rule-brass f-rule f-strip__rule" aria-hidden="true" />
              <ul className="f-strip__list">
                {objects.map((object) => {
                  const asset = images[object.key];
                  return (
                    <li className="f-object" key={object.key}>
                      <figure>
                        <span className="f-object__niche">
                          <img
                            className="arch"
                            src={asset.src}
                            srcSet={asset.srcSet}
                            sizes="(max-width: 780px) 62vw, 18vw"
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

          {/* ---- 6. HAVELI: the ledger --------------------------------- */}
          <div className="jali-band jali-band--brass f-seam f-seam--light" aria-hidden="true" />
          <section className="f-changed grained" aria-labelledby="f-changed-title">
            <div className="f-shell">
              <div className="f-changed__head">
                <p className="f-label">What changed</p>
                <h2 id="f-changed-title">Four things you can check.</h2>
                <div className="rule-brass f-rule" aria-hidden="true" />
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

          {/* ---- 8. DARBAR: close on a named CTA ----------------------- */}
          <section className="f-close f-dark grained jali-veil" aria-labelledby="f-close-title">
            <div className="jali-band f-seam" aria-hidden="true" />
            <div className="f-shell">
              {/* The illuminated primitive rules two corners; the panel is
                  turned through 180° a second time so the invitation sits in a
                  complete manuscript frame rather than two stray brackets. */}
              <div className="f-close__inner illuminated">
                <div className="illuminated f-close__corners" aria-hidden="true" />
                <p className="f-label">Come and see</p>
                <h2 id="f-close-title">
                  {askFor ? `Ask for ${askFor}.` : "Ask for someone by name."}
                </h2>
                <div className="rule-gold f-rule f-rule--centred" aria-hidden="true" />
                <p className="f-close__body">
                  {askFor
                    ? "Tell us when you would like to come and we will keep the salon free."
                    : "The name that belongs in that line is still being confirmed, so we are not going to guess at it. Tell us when you would like to come and we will call you back."}
                </p>
                <AppointmentTrigger className="f-cta">
                  Book a viewing
                </AppointmentTrigger>
              </div>
            </div>
          </section>
        </main>

        <footer className="f-colophon f-dark grained">
          <div className="f-shell">
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
 * A founder block is a framed portrait hung on a plaster wall, with a record
 * card beside it.
 *
 * THE PLACEHOLDER-VOID PROBLEM. With no name, no role and no recorded words,
 * a conventional heading-plus-paragraphs column is three short lines beside a
 * 4:5 portrait — a hole. The fix here is compositional rather than editorial:
 * the column is set as the shop's own record card and a ruled blank page,
 * because a form waiting to be filled in is a *full* object and is honest by
 * its very shape. Nothing in it asserts anything about a person.
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
  const words = detailsPending ? [] : founder.words;
  const alt = publishable(founder.portraitAlt)
    ? founder.portraitAlt
    : `Placeholder portrait standing in for a photograph of the ${founder.standIn.toLowerCase()}, which has not been taken yet`;

  const record: { label: string; value: string | null; waiting: string }[] = [
    { label: "Name", value: name, waiting: "as they want it written" },
    // Part E's caption grammar: the role as a verb, never a job title.
    { label: "What they do", value: doing, waiting: "a verb, not a job title" },
    { label: "Where to find them", value: whereabouts, waiting: "counter, bench or both" },
  ];

  return (
    <section
      className={`f-founder grained${mirrored ? " f-founder--mirrored" : ""}`}
      aria-labelledby={`f-${founder.portrait}`}
    >
      <div className="f-shell f-founder__grid">
        <div className="f-portrait">
          <div className="f-portrait__hang">
            <div className="f-portrait__mount">
              <Flip
                front={founder.portrait}
                back={founder.reverse}
                alt={alt}
                altBack={founder.reverseAlt}
                sizes="(max-width: 780px) 92vw, 42vw"
                priority={priority}
              />
            </div>
          </div>
          <p className="f-portrait__caption">
            {name && doing
              ? `${name} — ${doing}`
              : "Placeholder image — not a photograph of a real person. Turn it over for the workshop."}
          </p>
        </div>

        <div className="f-founder__words">
          <p className="f-label">{founder.mount}</p>
          <h2 id={`f-${founder.portrait}`}>{name ?? founder.standIn}</h2>
          <div className="rule-brass f-rule" aria-hidden="true" />

          <dl className="f-record illuminated illuminated--brass">
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
            <p className="f-label">In their own words</p>
            {words.length > 0 ? (
              words.map((paragraph) => (
                <p className="f-said__body" key={paragraph}>
                  {paragraph}
                </p>
              ))
            ) : (
              <>
                {/* A ruled blank page. It is unmistakably empty on purpose, and
                    it holds the column open until the recording is made. */}
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
