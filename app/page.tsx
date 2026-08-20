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
import Link from "next/link";

import { AppointmentProvider, AppointmentTrigger } from "./_components/appointment";
import type { Interest } from "./_components/appointment";
import { BrandMark } from "./_components/brand-mark";
import { ContactDetails } from "./_components/contact-details";
import { Flip } from "./_components/flip";
import { SiteHeader } from "./_components/site-header";
import { images } from "./_media/images";
import type { ImageKey } from "./_media/images";

/**
 * The catalogue. Every entry has a photographed reverse of its own. If a future
 * piece does not, give it no `back` and the Flip degrades to a plain figure —
 * never borrow another piece's back to fill the gap.
 * Nothing here asserts a weight, a karat, a stone count or a price, because
 * none of those numbers is known yet and inventing them is the one thing this
 * category's buyers are best at catching.
 */
const pieces: {
  id: string;
  name: string;
  front: ImageKey;
  back?: ImageKey;
  alt: string;
  altBack?: string;
  spec: string;
  copy: string;
  interest: Interest;
}[] = [
  {
    id: "jadau",
    name: "Jadau haar",
    front: "jadau-haar-front",
    back: "jadau-haar-reverse",
    alt: "Jadau haar of uncut polki closed-set in gold, hung with carved ruby and emerald drops on a red silk cord",
    altBack:
      "The same haar turned over: every plate enamelled on a red ground with a white and green lotus",
    spec: "Uncut polki · carved ruby and emerald drops · silk cord",
    copy: "Gold and stone on the face. On the back, a lotus fired into every single plate.",
    interest: "Jadau and Polki",
  },
  {
    id: "polki",
    name: "Polki choker",
    front: "polki-choker-front",
    back: "polki-choker-reverse",
    alt: "Polki choker of kundan-set uncut diamonds with a pearl fringe, strung on a red silk cord and tassel",
    altBack:
      "The same choker turned over: a green enamel ground carrying one white and red flower per cell",
    spec: "Kundan-set polki · pearl fringe · silk cord and tassel",
    copy: "Close-set stones sit shoulder to shoulder in front. Behind them, green enamel and thirty small flowers.",
    interest: "Jadau and Polki",
  },
  {
    id: "chandbali",
    name: "Chandbali earrings",
    front: "chandbali-earrings-front",
    back: "chandbali-earrings-reverse",
    alt: "Pair of crescent chandbali earrings in granulated gold with rose-cut polki and pearl and emerald bead drops",
    altBack:
      "The same pair turned over: a green, red and white lotus spread across the whole of each crescent",
    spec: "Crescent chandbali · rose-cut polki · pearl and emerald drops",
    copy: "Worn, the reverse faces the wearer's neck. It is still the more decorated of the two sides.",
    interest: "Bridal jewellery",
  },
  {
    id: "kada",
    name: "Kundan kada",
    front: "kundan-kada-front",
    back: "kundan-kada-reverse",
    alt: "Hinged gold kada set with kundan flowerheads, rimmed in seed pearls, with carved emerald terminals",
    altBack:
      "The same kada turned over: a red and green flowering vine enamelled around the inner face",
    spec: "Closed-set kundan · seed-pearl rim · carved emerald terminals",
    copy: "The inside of a bangle touches only the wrist, which is exactly why this one is enamelled.",
    interest: "Jadau and Polki",
  },
  {
    id: "tikka",
    name: "Maang tikka",
    front: "maang-tikka-front",
    back: "maang-tikka-reverse",
    alt: "Round gold maang tikka set with kundan around a ruby centre, a polki drop below and a woven chain above",
    altBack: "Turn over to see the concentric floral meenakari rosette on the back of the disc",
    spec: "Kundan-set polki · ruby centre · woven chain",
    copy: "The smallest piece here, and the back of it is worked as carefully as the front nobody questions.",
    interest: "Bridal jewellery",
  },
];

/**
 * Three statements that are checkable on this page rather than asserted about
 * the past. The founding year is not a row here because it is set as the
 * display figure beside the table.
 *
 * "How to buy" states a CURRENT STATE, not a principle. The previous wording —
 * "There is no cart on this site" — was a promise about the architecture, made
 * inside the one table whose whole argument is that every line in it can be
 * verified; the storefront now being built would have turned it into the only
 * false line on the page. What is written below stays true the day ordering
 * opens, because it describes what is open today rather than what will never
 * exist.
 *
 * It was rewritten again when /checkout landed, for the same reason. "Online
 * ordering is not open yet" had become half false: checkout exists, it creates
 * real orders, and it takes no money. What it will not do is create an order
 * for a piece with no resolvable price, and every piece in this catalogue is
 * still quoted by hand — so the line now names the thing a visitor can check
 * for themselves in two clicks (the cart says "Not quoted"; checkout says why),
 * rather than a blanket claim about the software. Every clause below is
 * verifiable from this site as it stands today:
 *
 *   "by appointment"     the dialog below books one.
 *   "by enquiry here"    the same dialog, from any product page.
 *   "takes no payment"   PAYMENT_CAPTURE_ENABLED is false in _data/orders.ts,
 *                        and /checkout says so before it asks for a name.
 *   "no piece is priced" every seeded variant is pricing_mode 'on_request'.
 */
const facts = [
  { label: "Techniques", value: "Jadau, Polki and Kundan, set by hand" },
  { label: "Every piece", value: "Shown face and reverse, or not shown" },
  {
    label: "How to buy",
    value:
      "In the shop by appointment, or by enquiry here. Checkout takes no payment, and no piece is priced yet, so nothing can be ordered today.",
  },
];

/**
 * THE HERO IS A PIECE ON A PERSON, NOT AN OBJECT ON A SWEEP.
 *
 * It was `jadau-haar-front`: a necklace on the flat grey studio sweep every
 * catalogue photograph is shot on. At hero size that sweep was the largest
 * single area on the screen, and the lamp overlay below exists entirely to stop
 * it reading as a grey slab dropped on the meena green. That is a fix for a
 * problem the photograph should not have had.
 *
 * A worn shot has no sweep to hide. It also answers the question a jewellery
 * hero is actually being asked -- how big is it, how does it sit -- which no
 * amount of lighting on an object can.
 */
const heroImage = images["rani-haar-worn"];

/**
 * The three pieces shown on a person, chosen to span the scale rather than to
 * flatter: the smallest everyday earring, a wrist, and a full bridal collar.
 */
const WORN = [
  {
    key: "gold-jhumka-worn",
    alt: "A small gold jhumka with a seed-pearl fringe, worn in the ear",
    caption: "Gold jhumka. Small enough for a working day.",
  },
  {
    key: "jadau-kangan-worn",
    alt: "A wide jadau kangan set with uncut polki, worn on the wrist",
    caption: "Jadau kangan. The width is the point.",
  },
  {
    key: "bridal-tikka-worn",
    alt: "A bridal maang tikka resting at the hairline, its chain over the parting",
    caption: "Bridal tikka. It sits where the parting starts.",
  },
] as const;

type Piece = (typeof pieces)[number];

/**
 * ONE ALCOVE in the catalogue wall — see the #collections section below for why
 * the wall is built the way it is. Four layers, back to front, and every one of
 * them cut to the SAME cusped arch so the whole thing is one silhouette rather
 * than a photograph parked on a dark rectangle:
 *
 *   .piece__mount   a brass rule a couple of pixels outside the opening, the
 *                   metal edge of a real shop niche. Ornament, never a letter.
 *   .piece__recess  the recess itself: teak-deep, cut into the plaster wall,
 *                   with a cusped shadow falling from it back onto the wall.
 *   Flip            the piece, already arch-masked by flip.css.
 *   .piece__lamp    the light in the alcove. The hero's `.hero__lamp`, retuned
 *                   from meena green to teak.
 *
 * The lamp is a sibling rather than an ancestor wrapper on purpose: a mask
 * clips everything its element paints, so masking anything above the Flip's
 * button would delete the keyboard focus ring.
 */
function Alcove({ piece, sizes }: { piece: Piece; sizes: string }) {
  return (
    <div className="piece__alcove">
      <span className="piece__mount arch" aria-hidden="true" />
      <span className="piece__recess arch" aria-hidden="true" />
      <Flip
        front={piece.front}
        back={piece.back}
        alt={piece.alt}
        altBack={piece.altBack}
        sizes={sizes}
      />
      <span className="piece__lamp arch" aria-hidden="true" />
    </div>
  );
}

/** The label under an alcove. */
function PieceBody({ piece }: { piece: Piece }) {
  return (
    <div className="piece__body">
      <h3>{piece.name}</h3>
      <p className="piece__spec">{piece.spec}</p>
      <p className="piece__copy">{piece.copy}</p>
      {/* The visible word is "Enquire" — under a heading that already reads
          "Jadau haar", a link reading "Enquire about Jadau haar" says the name
          twice. The accessible name keeps the full phrase, because out of
          context (a screen-reader link list) "Enquire" five times over is
          useless. */}
      <AppointmentTrigger className="text-action" interest={piece.interest}>
        <span className="visually-hidden">Enquire about {piece.name}</span>
        <span aria-hidden="true">Enquire</span>
      </AppointmentTrigger>
    </div>
  );
}

/**
 * Server component. Only three things ship to the browser as JavaScript:
 * `SiteHeader` (menu toggle), `AppointmentTrigger` (the buttons that open the
 * dialog) and `AppointmentProvider`, which owns the appointment dialog itself
 * (`role="dialog"`, focus trap, POST to /api/appointments). `Flip` is the
 * fourth and it is the point of the design. Everything else is rendered on the
 * server and forwarded through the provider as children.
 *
 * THE JOURNEY: court → workshop → family → court. The register of each section
 * is named in its comment, and the field classes in globals.css are what carry
 * it — .section--darbar / --darbar-deep are the court, .section--haveli is the
 * family house, .section--vitrine is the bench.
 */
export default function Home() {
  return (
    <AppointmentProvider>
      <main id="top">
        <SiteHeader />

        {/* DARBAR. The court, and the only symmetrical composition on the page.
            It is built as a DOORWAY YOU ARE LOOKING THROUGH rather than as a
            column of type: the name and the headline are the inscription over
            the opening, two doubled gold rules are the lintel and the sill, and
            between them a jali wall runs to both edges of the screen with one
            multifoil arch cut through it. The piece stands inside that arch and
            is the brightest thing on the page, because the field darkens toward
            the corners while a warm glow sits behind the stone.

            The arch is not decoration — every catalogue photograph was shot on
            an inconsistent grey studio sweep, so cutting each one to the arch
            turns a rectangle that cannot match any field colour into a mounted
            miniature that does not have to. Here it does a second job: it is
            the hole in the wall, so the grey sweep reads as light coming from
            inside the alcove.

            Order matters for depth. Field and grain, then the jali wall, then
            the vignette that pushes the wall back into shadow, then the glow,
            then the arch and the piece. Five planes, not one. */}
        <section className="hero grained" aria-labelledby="hero-title">
          <div className="hero__head">
            <p className="deva hero__deva" aria-hidden="true">
              अलंकार
            </p>
            <h1 id="hero-title">Jewels that become heirlooms.</h1>
          </div>

          <div className="rule-gold hero__rule" aria-hidden="true" />

          <div className="hero__stage">
            <div className="jali-veil hero__flank hero__flank--start" aria-hidden="true" />
            <div className="jali-veil hero__flank hero__flank--end" aria-hidden="true" />
            <div className="hero__vignette" aria-hidden="true" />
            <div className="hero__niche">
              <div className="hero__glow" aria-hidden="true" />
              <div className="hero__arch arch-frame">
                <img
                  className="hero__image arch"
                  src={heroImage.src}
                  srcSet={heroImage.srcSet}
                  sizes="(max-width: 780px) 74vw, 440px"
                  width={heroImage.width}
                  height={heroImage.height}
                  alt="Jadau haar of uncut polki with carved ruby and emerald drops, photographed on a grey sweep"
                  fetchPriority="high"
                  decoding="sync"
                />
                {/* The alcove. Every catalogue photograph was shot on a flat,
                    cold grey sweep, and at this size that sweep is the largest
                    single area on the screen — it was reading as a grey slab
                    dropped on the meena green. This overlay is cut to the same arch
                    and does three things to it: warms it toward the field,
                    darkens it at the crown and the rim so it recedes like the
                    back of a niche, and lays one soft pool of light over the
                    piece itself. It never touches the stones' own colour, which
                    is the one thing on this page that has to stay honest. */}
                <div className="hero__lamp arch" aria-hidden="true" />
              </div>
            </div>
          </div>

          <div className="rule-gold hero__rule hero__rule--sill" aria-hidden="true" />

          <div className="hero__foot">
            <p className="hero__caption">
              The rani haar, worn. Like everything below it, it turns over.
            </p>
            <p className="hero__lede">
              Every piece here is shown from both sides. The front is what the
              room sees. The back is enamelled, and only the person wearing it
              ever knows it is there.
            </p>
            <div className="hero__actions">
              <a className="button" href="#collections">
                See the pieces
              </a>
              <AppointmentTrigger className="button button--ghost">
                Book a viewing
              </AppointmentTrigger>
            </div>
          </div>
        </section>

        {/* The screen between the court and the house. */}
        <div className="jali-break" aria-hidden="true">
          <div className="jali-band" />
        </div>

        {/* HAVELI, and the one place on the page that is a room rather than a
            page: a jeweller's shop wall of arched alcoves cut into lime
            plaster, each holding one piece, each lit.

            The previous version stacked three shapes per piece — a teak
            RECTANGLE, an arch-masked photograph inside it, and the cold grey
            studio sweep inside that — which read as a dark box with a sticker
            on it. Here the RECESS ITSELF is the arch: one silhouette, cut into
            a sunk-plaster wall, ruled in brass and casting its own cusped
            shadow back onto the wall. `.piece__lamp` is the same device the
            hero uses (`.hero__lamp`): a second arch-masked layer that warms
            the sweep toward the wood, drops the empty crown and the rim into
            shadow, and lays one pool of light over the stones.

            The wall is one object rather than five: a lead band (the haar,
            its note, and the commission card stacked in the column beside it)
            over a shelf of four, all four sills on one line and only their
            crowns staggering. Nothing floats in a plaster void any more,
            because the void is now the wall. */}
        <section
          className="section section--haveli grained"
          id="collections"
          aria-labelledby="collections-title"
        >
          <div className="section-head pieces__head">
            <div>
              <h2 id="collections-title">Turn one over.</h2>
            </div>
            <p className="lede">
              Each one is photographed twice, face and reverse, on the same grey
              sweep. Hover on a desktop, tap on a phone.
            </p>
            <div className="rule-brass section-head__rule" aria-hidden="true" />
          </div>

          <div className="pieces">
            <div className="pieces__wall grained">
              {/* The lead band: the haar in the deepest alcove, its label at
                  the crown line and the commission card down at the sill, so
                  the column beside it is full top to bottom. */}
              <div className="pieces__band pieces__band--lead">
                <article className="piece piece--lead" id={pieces[0].id}>
                  <Alcove piece={pieces[0]} sizes="(max-width: 780px) 78vw, (max-width: 1100px) 44vw, 480px" />
                  <PieceBody piece={pieces[0]} />
                </article>

                <div className="pieces__note panel grained">
                  <div className="pieces__note-inner illuminated illuminated--brass">
                    <h3>Something else in mind?</h3>
                    <p>
                      Bridal sets and one-off commissions start with a
                      conversation rather than a catalogue. Tell us what the
                      occasion is and we will show you what is possible.
                    </p>
                    <AppointmentTrigger className="text-action" interest="A bespoke piece">
                      Start a commission
                    </AppointmentTrigger>
                  </div>
                </div>
              </div>

              {/* The shelf. Four alcoves on one sill line, sized down the row —
                  the choker widest, the tikka narrowest — so the crowns
                  stagger and the row still closes flush. */}
              <div className="pieces__band pieces__band--shelf">
                {pieces.slice(1).map((piece) => (
                  <article className="piece" id={piece.id} key={piece.id}>
                    <Alcove
                      piece={piece}
                      sizes="(max-width: 780px) 78vw, (max-width: 1100px) 38vw, 280px"
                    />
                    <PieceBody piece={piece} />
                  </article>
                ))}
              </div>
            </div>

            <div className="rule-brass pieces__sill" aria-hidden="true" />
          </div>
        </section>

        {/* DARBAR, and the deepest field on the site. This section carries the
            brand's one real argument, so it is made from the centre the way an
            argument is made in a court: the piece stands in the middle under a
            gold arch and the case for it is set in two columns either side. */}
        <section
          className="section section--darbar-deep grained"
          id="reverse"
          aria-labelledby="reverse-title"
        >
          <div className="opener">
            <h2 id="reverse-title">The part with no audience.</h2>
            <div className="rule-gold rule rule--center" aria-hidden="true" />
          </div>

          <div className="reverse">
            <div className="reverse__aside reverse__aside--start">
              <p className="prose">
                In Jadau and Polki work the back of a piece is enamelled:
                opaque green, red and white meenakari fired into gold that
                nobody but the wearer will ever see.
              </p>
            </div>

            <div className="reverse__media">
              <Flip
                framed
                front="rani-haar-front"
                back="rani-haar-reverse"
                alt="Three-strand rani haar of kundan-set polki roundels strung with carved ruby and emerald beads and pearls"
                altBack="The same haar turned over: every roundel and the pendant enamelled with a green and pink lotus"
                caption="Lotus meenakari on the reverse of every roundel"
                sizes="(max-width: 1100px) 84vw, 420px"
              />
            </div>

            <div className="reverse__aside">
              <p className="prose">
                It is the half of the craft that cannot be sold on sight, which
                is exactly why it tells you the most about who made the thing.
              </p>
              <p className="reverse__pull">
                You should not have to take our word for the side you cannot
                see.
              </p>
            </div>
          </div>
        </section>

        {/* The screen between the court and the workshop. */}
        <div className="jali-break" aria-hidden="true">
          <div className="jali-band" />
        </div>

          {/* ON A PERSON.
              The rest of this page is objects: an alcove, a diptych, a bench.
              That is the right register for showing what a piece IS, and it is
              useless for showing what a piece is LIKE to wear -- scale, weight,
              where it sits. Every photograph above is on a studio sweep, and a
              sweep has no size.

              Cropped tight and faces out of frame on purpose. The subject is the
              jewellery; a model looking down the lens turns a jeweller's page
              into a fashion campaign, which this shop is not. */}
          <section
            className="section section--haveli grained worn-band"
            id="worn"
            aria-labelledby="worn-title"
          >
            <div className="wrap">
              <div className="worn-band__head">
                <h2 id="worn-title">On, rather than under glass.</h2>
                <div className="rule-brass rule rule--center" aria-hidden="true" />
                <p className="lede worn-band__lede">
                  A piece photographed alone has no size. These are the same
                  pieces on a person, which is the only honest answer to how they
                  will sit on you.
                </p>
              </div>

              <ul className="worn-band__list">
                {WORN.map((entry) => {
                  const asset = images[entry.key];
                  return (
                    <li className="worn-band__item" key={entry.key}>
                      <figure className="worn-band__figure">
                        <img
                          className="worn-band__image"
                          src={asset.src}
                          srcSet={asset.srcSet}
                          sizes="(max-width: 780px) 86vw, 30vw"
                          width={asset.width}
                          height={asset.height}
                          alt={entry.alt}
                          loading="lazy"
                          decoding="async"
                        />
                        <figcaption className="worn-band__caption">{entry.caption}</figcaption>
                      </figure>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>


        {/* VITRINE — the inside of the case. Warm dark teak rather than red:
            this is the workroom, not the showroom. The bench photograph stays a
            rectangle on purpose. The arch is reserved for the jewellery, and
            dressing a documentary photograph as a miniature would be the first
            dishonest thing on the page. */}
        <section
          className="section section--vitrine section--bleed-end grained"
          id="craft"
          aria-labelledby="craft-title"
        >
          <div className="craft">
            <div className="craft__copy">
              <h2 id="craft-title">Made slowly. Worn forever.</h2>
              <div className="rule-gold rule" aria-hidden="true" />
              <p className="prose">
                A jadau setting is not claw work. The stone is bedded into
                shellac and the gold is worked up around it in thin foil, one
                stone at a time, until the metal closes on the girdle by itself.
              </p>
              <p className="prose">
                The enamel goes on before any of that, because it has to be
                fired hot enough that no stone could survive it. Which is to
                say: the back of the piece is made first.
              </p>
              <AppointmentTrigger className="text-action" interest="A bespoke piece">
                Begin a bespoke conversation
              </AppointmentTrigger>
            </div>
            <figure className="craft__media">
              <img
                src={images["workshop-hands"].src}
                srcSet={images["workshop-hands"].srcSet}
                sizes="(max-width: 1100px) 100vw, 50vw"
                width={images["workshop-hands"].width}
                height={images["workshop-hands"].height}
                alt="Two hands at a wooden bench, setting a rose-cut stone into a gold bezel with a steel tool"
                loading="lazy"
                decoding="async"
              />
              <figcaption>
                Closing gold around a rose-cut stone, by hand, at the bench.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* Back out of the workshop into the house. Brass on plaster, because
            the screen belongs to the register it opens onto. */}
        <div className="jali-break jali-break--haveli" aria-hidden="true">
          <div className="jali-band jali-band--brass" />
        </div>

        {/* HAVELI. The family, and the one date the business can evidence, set
            as the display figure it is on a raised plaster panel with
            illuminated brass corners. */}
        <section
          className="section section--haveli grained"
          id="legacy"
          aria-labelledby="legacy-title"
        >
          <div className="house">
            <div className="house__intro">
              <h2 id="legacy-title">One date, and no mythology.</h2>
              <div className="rule-brass rule" aria-hidden="true" />
              <p className="prose">
                Alankar has been setting stones by hand since 1980. Everything
                else a jeweller usually writes on a page like this (heritage,
                integrity, generations of trust) could be said by anyone and
                checked by no one, so here is only the part you can check.
              </p>
              <p className="prose">
                The people who have run the counter since then have their own
                page, because a family business is a list of people before it is
                a list of claims.
              </p>
              <a className="text-action" href="/founders">
                Meet the people behind the counter
              </a>
            </div>

            <div className="house__record grained">
              <div className="house__record-inner illuminated illuminated--brass">
                <p className="house__since">Founded</p>
                <p className="house__year">1980</p>
                {/* Tabular, which is the one job a hairline is allowed to do
                    anywhere in this design. */}
                <dl className="facts">
                  {facts.map((fact) => (
                    <div className="facts__row" key={fact.label}>
                      <dt>{fact.label}</dt>
                      <dd>{fact.value}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </div>
        </section>

        {/* The screen back into the court. */}
        <div className="jali-break" aria-hidden="true">
          <div className="jali-band" />
        </div>

        {/* DARBAR. The page closes in the room it is asking you to come to, and
            it closes ceremonially: this is the invitation, so it is red and
            gold again rather than a pale contact footer. */}
        <section
          className="section visit section--darbar section--bleed-start grained"
          id="visit"
          aria-labelledby="visit-title"
        >
          <div className="visit__intro">
            <figure className="visit__media">
              <img
                src={images["workshop-bench"].src}
                srcSet={images["workshop-bench"].srcSet}
                sizes="(max-width: 1100px) 100vw, 50vw"
                width={images["workshop-bench"].width}
                height={images["workshop-bench"].height}
                alt="A jeweller's bench with a dish of uncut stones, files, tweezers and a part-finished gold pendant"
                loading="lazy"
                decoding="async"
              />
            </figure>
            <div className="visit__copy">
              <h2 id="visit-title">A private experience, on your own time.</h2>
              <div className="rule-gold rule" aria-hidden="true" />
              <p className="prose">
                Pieces are seen in the inner salon, away from the counter, with
                someone who can tell you where a stone came from and what the
                back of it looks like before you turn it over.
              </p>
              <AppointmentTrigger className="button">
                Book an Appointment
              </AppointmentTrigger>
            </div>
          </div>

          <div className="rule-gold rule rule--full visit__break" aria-hidden="true" />

          <ContactDetails />
        </section>

        <div className="jali-break" aria-hidden="true">
          <div className="jali-band" />
        </div>

        <footer className="site-footer grained">
          <div className="footer__brand">
            <BrandMark compact />
            <p>
              Antique Jadau, Polki and Kundan. Set by hand, and shown from both
              sides.
            </p>
          </div>
          <div className="footer__column">
            <p className="label">The pieces</p>
            {pieces.map((piece) => (
              <a href={`#${piece.id}`} key={piece.id}>
                {piece.name}
              </a>
            ))}
          </div>
          <div className="footer__column">
            <p className="label">Alankar</p>
            <a href="#reverse">The reverse</a>
            <a href="#craft">Craft</a>
            <a href="#legacy">The house</a>
            <Link href="/shop">The shop</Link>
            <Link href="/founders">The people</Link>
            <a href="#visit">Visit us</a>
            <AppointmentTrigger>Private appointments</AppointmentTrigger>
          </div>
          <div className="rule-gold footer__rule" aria-hidden="true" />
          <div className="footer__closing">
            <p>Jewels that become heirlooms.</p>
            <small>© {new Date().getFullYear()} Alankar Jewellers.</small>
          </div>
        </footer>
      </main>
    </AppointmentProvider>
  );
}
