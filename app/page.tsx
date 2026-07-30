/* eslint-disable @next/next/no-img-element --
 * next/image cannot work on this deployment, and this is verified rather than
 * assumed: worker/index.ts routes /_vinext/image through `env.IMAGES`, but
 * vite.config.ts's localBindingConfig never declares IMAGES, so the optimizer
 * throws before its own error handling runs. Sizing is therefore done ahead of
 * time by scripts/build-images.mjs, and every raw <img> below takes its
 * intrinsic width/height and srcSet straight from the generated manifest, so
 * cumulative layout shift stays at zero.
 */
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
 */
const facts = [
  { label: "Techniques", value: "Jadau, Polki and Kundan, set by hand" },
  { label: "Every piece", value: "Shown face and reverse, or not shown" },
  {
    label: "How to buy",
    value: "In the shop by appointment, or by enquiry here. Online ordering is not open yet.",
  },
];

const heroImage = images["jadau-haar-front"];

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

        {/* DARBAR. The court, and the only symmetrical composition above the
            fold: eyebrow, name, headline, invitation, then a jali screen you
            pass through to reach the piece itself, which stands in a multifoil
            arch ruled in gold. The arch is not decoration — every catalogue
            photograph was shot on an inconsistent grey studio sweep, so cutting
            each one to the arch turns a rectangle that cannot match any field
            colour into a mounted miniature that does not have to. */}
        <section className="hero grained" aria-labelledby="hero-title">
          <div className="hero__inner">
            <p className="deva hero__deva" aria-hidden="true">
              अलंकार
            </p>
            <p className="label">Jadau · Polki · Kundan — since 1980</p>
            <h1 id="hero-title">Jewels that become heirlooms.</h1>
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
            <div className="jali-band hero__screen" aria-hidden="true" />
            <div className="hero__arch arch-frame">
              <img
                className="hero__image arch"
                src={heroImage.src}
                srcSet={heroImage.srcSet}
                sizes="(max-width: 780px) 78vw, 440px"
                width={heroImage.width}
                height={heroImage.height}
                alt="Jadau haar of uncut polki with carved ruby and emerald drops, photographed on a grey sweep"
                fetchPriority="high"
                decoding="sync"
              />
            </div>
            <p className="hero__caption">
              The Jadau haar, face up. Like everything below it, it turns over.
            </p>
          </div>
        </section>

        {/* The screen between the court and the house. */}
        <div className="jali-break" aria-hidden="true">
          <div className="jali-band" />
        </div>

        {/* HAVELI. The family house: lime plaster, brass rather than gold,
            asymmetric and editorial rather than centred. Each piece stands in a
            teak-deep niche with illuminated corners, so the grey of the sweep
            reads at 6.4:1 against the wood — a lit alcove instead of a
            mismatched rectangle. */}
        <section
          className="section section--haveli grained"
          id="collections"
          aria-labelledby="collections-title"
        >
          <div className="section-head">
            <div>
              <p className="label">The pieces</p>
              <h2 id="collections-title">Turn one over.</h2>
            </div>
            <p className="lede">
              Each one is photographed twice, face and reverse, on the same grey
              sweep. Hover on a desktop, tap on a phone.
            </p>
            <div className="rule-brass section-head__rule" aria-hidden="true" />
          </div>

          {/* Five pieces at four different sizes rather than five identical
              cells: the haar runs seven columns wide, the tikka three. Nothing
              in the middle, and the rows are bottom-aligned so the tops
              stagger. The commission note takes the last cell as text, which is
              why there is no sixth, empty one. */}
          <div className="pieces">
            {pieces.map((piece, index) => (
              <article className="piece" id={piece.id} key={piece.id}>
                <div className="piece__niche grained">
                  <div className="piece__niche-inner illuminated">
                    <Flip
                      front={piece.front}
                      back={piece.back}
                      alt={piece.alt}
                      altBack={piece.altBack}
                      sizes={
                        index === 0
                          ? "(max-width: 1100px) 56vw, 52vw"
                          : "(max-width: 1100px) 46vw, 30vw"
                      }
                    />
                  </div>
                </div>
                <div className="piece__body">
                  <h3>{piece.name}</h3>
                  <p className="piece__spec">{piece.spec}</p>
                  <p className="piece__copy">{piece.copy}</p>
                  {/* The visible word is "Enquire" — under a heading that
                      already reads "Jadau haar", a link reading "Enquire about
                      Jadau haar" says the name twice. The accessible name keeps
                      the full phrase, because out of context (a screen-reader
                      link list) "Enquire" five times over is useless. */}
                  <AppointmentTrigger className="text-action" interest={piece.interest}>
                    <span className="visually-hidden">Enquire about {piece.name}</span>
                    <span aria-hidden="true">Enquire</span>
                  </AppointmentTrigger>
                </div>
              </article>
            ))}

            <div className="pieces__note panel grained">
              <div className="pieces__note-inner illuminated illuminated--brass">
                <h3>Something else in mind?</h3>
                <p>
                  Bridal sets and one-off commissions start with a conversation
                  rather than a catalogue. Tell us what the occasion is and we
                  will show you what is possible.
                </p>
                <AppointmentTrigger className="text-action" interest="A bespoke piece">
                  Start a commission
                </AppointmentTrigger>
              </div>
            </div>
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
            <p className="label">The reverse</p>
            <h2 id="reverse-title">The part with no audience.</h2>
            <div className="rule-gold rule rule--center" aria-hidden="true" />
          </div>

          <div className="reverse">
            <div className="reverse__aside reverse__aside--start">
              <p className="prose">
                In Jadau and Polki work the back of a piece is enamelled —
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
              <p className="label">At the bench</p>
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
              <p className="label">The house</p>
              <h2 id="legacy-title">One date, and no mythology.</h2>
              <div className="rule-brass rule" aria-hidden="true" />
              <p className="prose">
                Alankar has been setting stones by hand since 1980. Everything
                else a jeweller usually writes on a page like this — heritage,
                integrity, generations of trust — could be said by anyone and
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
              <p className="label">By appointment</p>
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
            <a href="/founders">The people</a>
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
