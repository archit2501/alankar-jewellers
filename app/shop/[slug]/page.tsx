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

/**
 * THE PRODUCT PAGE.
 *
 * A server component. Nothing on this route ships as client JavaScript except
 * the enquiry dialog, which is the one thing here that has to be interactive.
 * There is no client-side gallery, no lightbox and no image carousel, for a
 * reason that is editorial before it is technical — see THE DIPTYCH below.
 *
 * ---------------------------------------------------------------------------
 * THE DIPTYCH: THE REVERSE IS NOT A THUMBNAIL
 * ---------------------------------------------------------------------------
 *
 * In Jadau and Polki work the back of a piece is enamelled in opaque meenakari
 * — decoration the wearer knows about and the room never sees. The whole site
 * is built on that one argument, so on the page where a buyer decides, the
 * reverse cannot be a 64px chip under the hero shot waiting to be clicked.
 *
 * Face and reverse are therefore hung as a DIPTYCH: two plates of identical
 * size, side by side, each cut to the same multifoil arch, each ruled in gold,
 * each captioned, on the deepest field on the site. Neither is behind the
 * other and neither needs an interaction to be seen. On a phone they stack and
 * stay the same size as each other.
 *
 * The homepage's Flip is deliberately NOT used here. A hover-to-reveal is the
 * right device for a wall of five pieces where turning one over is a discovery;
 * on the page for a single piece it would hide half the evidence behind a
 * gesture, and a keyboard or touch visitor would have to work to see the thing
 * we claim is the point.
 *
 * When a piece has no photographed reverse the second plate is not silently
 * dropped and the grid does not collapse to one big picture. It states that the
 * reverse has not been photographed. Borrowing another piece's back to fill the
 * hole is the one thing this category's buyers are best at catching.
 *
 * ---------------------------------------------------------------------------
 * THE RECORD, AND WHAT IT REFUSES TO INVENT
 * ---------------------------------------------------------------------------
 *
 * Weight, purity, HUID, hallmark mark, certificate and laboratory all come from
 * `disclosures()` in `app/_seo/product-schema.ts`, which is also what builds the
 * JSON-LD. This is placeholder inventory, so most of those are null — and a null
 * renders as a sentence saying what is missing ("Not yet hallmarked — no HUID
 * has been issued for this piece"), never as an empty cell and never as a
 * plausible-looking number. The same null omits the property from the markup, so
 * the page and the crawler cannot drift apart.
 *
 * ---------------------------------------------------------------------------
 * THE PRICE
 * ---------------------------------------------------------------------------
 *
 * Itemised inline — rate x weight, making, stones, hallmarking, GST — because
 * that is what an Indian buyer expects to be shown and what Consumer Protection
 * (E-Commerce) Rules 2020 r.7(1)(e) and BIS (Hallmarking) Regulations 2018
 * Reg. 5(11) between them largely require. The breakup is the product feature,
 * not a debug view.
 *
 * `price` is null whenever the piece is quoted by hand or the gold rate is
 * stale. Then the panel says which of those it is, in plain language, and shows
 * no figure at all. There is no zero, no "from ₹—", no last-known price.
 *
 * ---------------------------------------------------------------------------
 * RENDERING MODE
 * ---------------------------------------------------------------------------
 *
 * `force-dynamic`: the price is computed against the prevailing gold rate at the
 * moment of the request. A prerendered product page is a page with yesterday's
 * gold rate baked into it, which is the exact failure the rate layer fails
 * closed to avoid.
 */

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cache } from "react";
import { AppointmentProvider, AppointmentTrigger } from "../../_components/appointment";
import type { Interest } from "../../_components/appointment";
/**
 * THE DATA LAYER (task 2.1.1, built alongside this page).
 *
 * The contract is `app/_data/types.ts`: one piece, by slug, priced against the
 * prevailing rate, or null when there is no such piece. Everything this page
 * knows about a piece it knows through `PricedPiece`.
 */
import { getPricedCataloguePiece, isDemonstrationPiece } from "../../_data/catalogue";
import { isHallmarkExempt, type PricedPiece } from "../../_data/types";
import { images } from "../../_media/images";
import type { ImageKey } from "../../_media/images";
import {
  disclosures,
  formatRupees,
  productJsonLd,
  productPath,
} from "../../_seo/product-schema";
import { serializeJsonLd } from "../../_seo/structured-data";
import { site } from "../../site-config";

export const dynamic = "force-dynamic";

/**
 * `generateMetadata` and the page body both need the piece. `cache` collapses
 * that into one query per request rather than two round trips to D1 for the
 * same row.
 */
const loadPiece = cache(getPricedCataloguePiece);

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const piece = await loadPiece(slug);

  if (piece === null) {
    // A 404 must not be indexed, and must not claim to be a product.
    return { title: `Not found | ${site.name}`, robots: { index: false, follow: true } };
  }

  const description = piece.description ?? piece.spec;
  const front = images[piece.mediaKey.front];

  return {
    title: `${piece.title} | ${site.name}`,
    description,
    alternates: { canonical: productPath(piece.slug) },
    openGraph: {
      type: "website",
      locale: "en_IN",
      url: productPath(piece.slug),
      siteName: site.name,
      title: `${piece.title} | ${site.name}`,
      description,
      images: [{ url: front.src, width: front.width, height: front.height, alt: piece.alt }],
    },
  };
}

/* -------------------------------------------------------------------------
 * Copy that depends on data, kept out of the markup
 * ---------------------------------------------------------------------- */

/**
 * Why there is no price, said in the shop's own voice. One entry per reason the
 * data layer can give, so a new reason is a compile error here rather than a
 * blank panel in front of a customer.
 */
const PRICE_UNAVAILABLE: Record<
  NonNullable<PricedPiece["priceUnavailableReason"]>,
  { tag: string; headline: string; body: string }
> = {
  on_request: {
    tag: "On request",
    headline: "This piece is priced by hand.",
    body: "Antique and one-off Jadau work is not quoted off a rate card — the stones are individual and so is the setting. Ask us and we will price it in front of you, itemised the same way every other piece on this site is.",
  },
  rate_stale: {
    tag: "Rate unconfirmed",
    headline: "We have not confirmed today's gold rate yet.",
    body: "A price worked out from yesterday's rate is a wrong price, so this page will not show one. The figure returns as soon as the day's rate is in. Ask us and we will quote you against the rate at the moment you ask.",
  },
  rate_missing: {
    tag: "Rate unavailable",
    headline: "No gold rate is available to price this piece.",
    body: "Rather than show a figure we cannot stand behind, this page shows none. Ask us and we will quote the piece against the prevailing rate, itemised.",
  },
};

/**
 * Which enquiry queue a request from this page should land in. A routing hint
 * for the shop, nothing more — it is never shown as a claim about the piece.
 */
function interestFor(piece: PricedPiece): Interest {
  const haystack = [piece.title, piece.spec, ...piece.collections].join(" ").toLowerCase();
  if (haystack.includes("bridal")) return "Bridal jewellery";
  if (haystack.includes("diamond")) return "Diamond jewellery";
  return "Jadau and Polki";
}

/* -------------------------------------------------------------------------
 * One plate of the diptych
 * ---------------------------------------------------------------------- */

/**
 * A photograph hung in a gold-ruled multifoil arch, with the alcove lamp over
 * it — the same four-layer treatment the hero uses, because these are the same
 * cold grey studio sweeps and at this size the sweep is the largest area on the
 * screen. The lamp warms it toward the field, drops the crown and rim into
 * shadow and lays one pool of light over the stones. It never touches the
 * stones' own colour, which is the one thing on this page that has to stay
 * honest.
 *
 * Both plates are eager: they are the content of the page and both are above
 * the fold on a laptop. Only the face is `fetchPriority="high"` — it is the LCP
 * candidate and the reverse should not compete with it for the first
 * connection.
 */
function Plate({
  mediaKey,
  alt,
  side,
  note,
  priority = false,
}: {
  mediaKey: ImageKey;
  alt: string;
  side: string;
  note: string;
  priority?: boolean;
}) {
  const asset = images[mediaKey];
  return (
    <figure className="pdp-plate">
      <div className="pdp-plate__mount arch-frame">
        <img
          className="pdp-plate__image arch"
          src={asset.src}
          srcSet={asset.srcSet}
          sizes="(max-width: 900px) 84vw, 40vw"
          width={asset.width}
          height={asset.height}
          alt={alt}
          fetchPriority={priority ? "high" : undefined}
          decoding={priority ? "sync" : "async"}
        />
        <div className="pdp-plate__lamp arch" aria-hidden="true" />
      </div>
      <figcaption className="pdp-plate__caption">
        <span className="pdp-plate__side">{side}</span>
        <span className="pdp-plate__note">{note}</span>
      </figcaption>
    </figure>
  );
}

/* -------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------- */

export default async function ProductPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const piece = await loadPiece(slug);

  // An unknown slug is a 404, not an empty product page. Anything else would
  // put a shell of a piece — and its structured data — on a URL that has no
  // piece behind it.
  if (piece === null) {
    notFound();
  }

  const rows = disclosures(piece);
  const unhallmarked = rows.find((row) => row.key === "huid")?.value === null;
  // WHY the HUID is absent, which is a different question from WHETHER it is.
  // Kundan, Polki and Jadau are outside mandatory hallmarking under QCO cl.
  // 2(3); plain gold and diamond are not. This used to be assumed rather than
  // checked, which was harmless only for as long as every piece in the
  // catalogue happened to be stone-set.
  const exemptCraft = isHallmarkExempt(piece.craft);
  const reverse = piece.mediaKey.back;
  const interest = interestFor(piece);

  // Held as a const so the null check below narrows it for the whole subtree.
  const priced = piece.price;
  // A null price with no stated reason is a data-layer defect; "priced by hand"
  // is the one fallback that is true of every piece in this shop, and it still
  // shows no figure. It is never a zero.
  const unavailable = PRICE_UNAVAILABLE[piece.priceUnavailableReason ?? "on_request"];

  return (
    <AppointmentProvider>
      <div className="pdp">
        {/* ---- DARBAR: the lintel ------------------------------------- */}
        {/* The shared SiteHeader navigates by homepage hash anchors, which are
            dead on this route, so this page carries its own bar — the same
            decision /founders made, for the same reason. */}
        <header className="pdp-topbar section--darbar-deep grained">
          <div className="wrap pdp-topbar__inner">
            <Link className="pdp-wordmark" href="/">
              <span className="pdp-wordmark__name">{site.name}</span>
              <span className="pdp-wordmark__since">Since {site.foundedYear}</span>
            </Link>
            <nav className="pdp-nav" aria-label={site.name}>
              <Link href="/">The shop</Link>
              <Link href="/shop">All pieces</Link>
              <Link href="/founders">The people</Link>
            </nav>
          </div>
          <div className="rule-gold" aria-hidden="true" />
        </header>

        <main>
          {/* ---- DARBAR: the piece, face and reverse ------------------- */}
          <section
            className="section section--darbar-deep grained pdp-stage"
            aria-labelledby="pdp-title"
          >
            <nav className="pdp-crumbs" aria-label="Breadcrumb">
              <ol>
                <li>
                  <Link href="/">Alankar</Link>
                </li>
                <li>
                  <Link href="/shop">The pieces</Link>
                </li>
                <li aria-current="page">{piece.title}</li>
              </ol>
            </nav>

            <div className="pdp-stage__head">
              <p className="label">
                {piece.isUniquePiece ? "One of a kind" : "The pieces"}
              </p>
              <h1 id="pdp-title">{piece.title}</h1>
              {piece.subtitle === null ? null : (
                <p className="pdp-subtitle">{piece.subtitle}</p>
              )}
              <div className="rule-gold rule rule--center" aria-hidden="true" />
              <p className="pdp-spec">{piece.spec}</p>

              {/* THE DISCLOSURE HAS TO BE HERE, NOT ONLY ON /shop.
                  The listing has carried a placeholder notice for weeks, but
                  this is the page a crawler resolves as authoritative and the
                  page a shared link opens. It publishes a price, a weight and
                  — since the worn shots landed — a photograph of a person
                  wearing something that has never existed. A disclosure one
                  navigation away is not a disclosure. */}
              {isDemonstrationPiece(piece.slug) ? (
                <p className="pdp-demo">
                  <span className="pdp-demo__tag">Demonstration piece</span>
                  <span className="pdp-demo__body">
                    This piece does not exist. Its weight and making charge are
                    invented and its photographs are generated, so the figures
                    below are arithmetic on a made-up object rather than a
                    quotation. The gold rate behind them is IBJA&rsquo;s real
                    published rate.
                  </span>
                </p>
              ) : null}
            </div>

            {/* THE DIPTYCH. Two plates, one size. See the header. */}
            <div className="pdp-diptych">
              <Plate
                mediaKey={piece.mediaKey.front}
                alt={piece.alt}
                side="The face"
                note="What the room sees."
                priority
              />

              <div className="pdp-diptych__seam" aria-hidden="true" />

              {reverse === null ? (
                /* No borrowed back. The gap is stated at the same size the
                   photograph would have been, because a quietly missing
                   reverse on this site of all sites is a claim in itself. */
                <div className="pdp-plate pdp-plate--absent">
                  <div className="pdp-absent illuminated">
                    <p className="pdp-absent__tag">Not photographed</p>
                    <p className="pdp-absent__body">
                      The reverse of this piece has not been photographed yet.
                    </p>
                    <p className="pdp-absent__body">
                      We are not going to put another piece&rsquo;s back here to
                      fill the space. Every reverse on this site belongs to the
                      piece it is shown with, and you can ask to turn this one
                      over in the shop.
                    </p>
                  </div>
                </div>
              ) : (
                <Plate
                  mediaKey={reverse}
                  alt={piece.altBack ?? `${piece.title}, photographed from behind`}
                  side="The reverse"
                  note="Enamelled meenakari. Only the wearer ever sees it."
                />
              )}
            </div>
          </section>

          {/* ---- ON THE WEARER ------------------------------------------
              Deliberately NOT a third plate inside the diptych. The diptych is
              a two-plate composition with a seam down its middle and one
              argument to make — face and reverse, the same object twice. A
              third panel turns a statement into a gallery.

              It is also a different KIND of photograph and is captioned as one.
              The plates are the object on a grey sweep; this is the object on a
              person, which is the only way to answer "how big is it" without
              putting a ruler in the shot. Absent for every piece not
              photographed worn, with nothing standing in its place — the same
              rule the missing reverse follows above. */}
          {piece.mediaKey.worn === null ? null : (
            <section
              className="section section--haveli grained pdp-worn"
              aria-labelledby="pdp-worn-title"
            >
              <div className="wrap pdp-worn__grid">
                <figure className="pdp-worn__figure">
                  <img
                    className="pdp-worn__image"
                    src={images[piece.mediaKey.worn].src}
                    srcSet={images[piece.mediaKey.worn].srcSet}
                    sizes="(max-width: 780px) 92vw, 46vw"
                    width={images[piece.mediaKey.worn].width}
                    height={images[piece.mediaKey.worn].height}
                    alt={piece.altWorn ?? `${piece.title}, worn`}
                    loading="lazy"
                    decoding="async"
                  />
                </figure>
                <div className="pdp-worn__note">
                  <p className="label">On the wearer</p>
                  <h2 id="pdp-worn-title">How big it actually is.</h2>
                  <div className="rule-brass rule rule--full" aria-hidden="true" />
                  <p className="pdp-worn__body">
                    A piece photographed alone on a grey sweep has no size. This
                    is the same piece on a person, which is the only honest
                    answer to how it will sit on you.
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* ---- HAVELI: the record and the price ---------------------- */}
          <section
            className="section section--haveli grained pdp-record"
            aria-labelledby="pdp-record-title"
          >
            <div className="wrap pdp-record__grid">
              <div className="pdp-record__spec">
                <p className="label">The record</p>
                <h2 id="pdp-record-title">What this piece is — and what it is not.</h2>
                <div className="rule-brass rule rule--full" aria-hidden="true" />

                {/* Tabular data, which is the one job a hairline is allowed to
                    do anywhere in this design system. */}
                <dl className="pdp-facts">
                  {rows.map((row) => (
                    <div className="pdp-facts__row" key={row.key}>
                      <dt>{row.label}</dt>
                      <dd>
                        {row.value === null ? (
                          <span className="pdp-pending">
                            <span className="pdp-tag">Not recorded</span>
                            {row.pending}
                          </span>
                        ) : (
                          row.value
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>

                {unhallmarked && exemptCraft ? (
                  <p className="pdp-footnote">
                    Kundan, Polki and Jadau are exempt from mandatory
                    hallmarking under BIS QCO cl. 2(3), so a piece of this kind
                    lawfully carries no HUID. It is still unhallmarked, and this
                    page says so rather than leaving the line blank.
                  </p>
                ) : unhallmarked ? (
                  <p className="pdp-footnote">
                    This piece is not one of the kinds BIS QCO cl. 2(3) exempts,
                    so it does need to be hallmarked before it is sold. No HUID
                    has been recorded against it here yet, and rather than leave
                    the line blank the page says so — ask us for the number
                    struck on the piece itself.
                  </p>
                ) : null}
              </div>

              {/* --- The price ---------------------------------------- */}
              <div className="pdp-price panel grained">
                <div className="pdp-price__inner illuminated illuminated--brass">
                  <p className="label">The price</p>

                  {priced === null ? (
                    <div className="pdp-price__none">
                      <p className="pdp-tag pdp-tag--block">{unavailable.tag}</p>
                      <p className="pdp-price__headline">{unavailable.headline}</p>
                      <p className="pdp-price__body">{unavailable.body}</p>
                    </div>
                  ) : (
                    <>
                      <p className="pdp-price__total">
                        {formatRupees(priced.totalPaise)}
                      </p>
                      <p className="pdp-price__body">
                        Everything included, GST paid. Priced against the gold
                        rate of {priced.rateAsOf}.
                      </p>

                      {/* The itemisation is the product feature. */}
                      <dl className="pdp-breakup">
                        {priced.breakup.map((component) => (
                          <div className="pdp-breakup__row" key={component.label}>
                            <dt>{component.label}</dt>
                            <dd>{formatRupees(component.amountPaise)}</dd>
                          </div>
                        ))}
                        <div className="pdp-breakup__row pdp-breakup__row--total">
                          <dt>Total</dt>
                          <dd>{formatRupees(priced.totalPaise)}</dd>
                        </div>
                      </dl>

                      <p className="pdp-footnote">
                        GST is a single 3% on the total transaction value of
                        finished jewellery, whether or not the making charge is
                        shown separately (CBIC Sectoral FAQ, Gems &amp;
                        Jewellery, Q7). Showing you the breakup does not split
                        the rate.
                      </p>
                    </>
                  )}

                  <p className="pdp-price__stock">
                    {piece.stockQuantity > 0
                      ? piece.isUniquePiece
                        ? "One piece exists, and it is still here."
                        : "Available in the shop."
                      : "This piece has left the shop."}
                  </p>

                  <AppointmentTrigger className="button pdp-price__cta" interest={interest}>
                    Enquire about this piece
                  </AppointmentTrigger>
                  <p className="pdp-price__aside">
                    Online ordering is not open yet. An enquiry reaches a person,
                    who will quote you and hold the piece.
                  </p>

                  {/* ADD TO CART. A plain form: no JavaScript and no client
                      island, answered with a 303 to /cart. It records intent
                      and claims the piece — it does not price it and it does
                      not charge for it. See app/_data/cart.ts.

                      Withheld once the piece is gone. The API already refuses
                      ("That piece has left the shop"), so this was never an
                      oversell — but the page was printing that sentence and
                      then offering the button directly underneath it, which
                      makes the refusal look like a fault rather than the truth.
                      Unreachable until today: no piece was `buy_online` before
                      the demonstration stock existed, so nothing had ever sold
                      out with a buy control on screen. */}
                  {piece.stockQuantity > 0 ? (
                    <form className="cart-add cart-add--pdp" method="post" action="/api/cart">
                      <input type="hidden" name="action" value="add" />
                      <input type="hidden" name="slug" value={piece.slug} />
                      <button className="button button--ghost cart-add__button" type="submit">
                        Add to cart
                        <span className="visually-hidden"> — {piece.title}</span>
                      </button>
                    </form>
                  ) : null}
                  <p className="pdp-price__aside">
                    A cart holds a one-of-a-kind piece for you while we quote it.
                    Nothing is charged, and no price is fixed until we quote it
                    against the rate at that moment.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* ---- VITRINE: the piece in its own words -------------------- */}
          {/* Rendered only when the shop has actually written something. There
              is no generated stand-in paragraph on this site. */}
          {piece.description === null ? null : (
            <section
              className="section section--vitrine grained pdp-story"
              aria-labelledby="pdp-story-title"
            >
              <div className="wrap pdp-story__inner">
                <p className="label">About the piece</p>
                <h2 id="pdp-story-title">Made slowly. Worn forever.</h2>
                <div className="rule-gold rule" aria-hidden="true" />
                <p className="prose">{piece.description}</p>
              </div>
            </section>
          )}

          <div className="jali-break" aria-hidden="true">
            <div className="jali-band" />
          </div>

          {/* ---- DARBAR: the invitation -------------------------------- */}
          <section
            className="section section--darbar grained jali-veil pdp-close"
            aria-labelledby="pdp-close-title"
          >
            <div className="opener illuminated pdp-close__panel">
              <p className="label">Come and see it</p>
              <h2 id="pdp-close-title">Turn it over yourself.</h2>
              <div className="rule-gold rule rule--center" aria-hidden="true" />
              <p className="pdp-close__body">
                Pieces are seen in the inner salon, away from the counter, with
                someone who can tell you where a stone came from and what the
                back of it looks like before you turn it over.
              </p>
              <AppointmentTrigger className="button" interest={interest}>
                Book a viewing
              </AppointmentTrigger>
            </div>
          </section>
        </main>

        <footer className="pdp-colophon section--darbar-deep grained">
          <div className="wrap pdp-colophon__inner">
            <p>
              {site.name}, since {site.foundedYear}.
            </p>
            <nav className="pdp-nav" aria-label="Elsewhere on this site">
              <Link href="/shop">All pieces</Link>
              <Link href="/founders">The people</Link>
              <Link href="/">Back to the shop</Link>
            </nav>
          </div>
        </footer>

        {/* Product + Offer, referencing the JewelryStore node that
            app/layout.tsx already publishes on every page rather than
            duplicating the business here. The price is gated inside
            productJsonLd — see app/_seo/product-schema.ts. */}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(productJsonLd(piece)) }}
        />
      </div>
    </AppointmentProvider>
  );
}
