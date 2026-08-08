import type { Metadata } from "next";
import Link from "next/link";
import { Flip } from "../_components/flip";
import {
  CATALOGUE_IS_PLACEHOLDER,
  PRICE_BANDS,
  catalogueFacets,
  catalogueHref,
  collectionTitle,
  formatPricePaise,
  isFiltered,
  listCatalogue,
  listPricedCatalogue,
  parseCatalogueFilter,
  priceUnavailableCopy,
  withoutFilter,
  type CatalogueQuery,
  type FilterParam,
} from "../_data/catalogue";
import type { PricedPiece } from "../_data/types";
import { site } from "../site-config";

/**
 * THE CATALOGUE — /shop.
 *
 * ===========================================================================
 * A SERVER COMPONENT. THE ONLY JAVASCRIPT ON THIS PAGE IS THE FLIP.
 * ===========================================================================
 * Browsing costs nothing: the filters are a plain `<form method="get">` and a
 * set of links, so every combination of metal / purity / collection / price is a
 * real URL that works with JavaScript switched off, is shareable, and is back-
 * buttonable. There is no client-side filtering, no router push, no state.
 *
 * `Flip` is the one client island, and it is the reason this site exists: the
 * enamelled meenakari reverse is the product knowledge, not an embellishment.
 * Without JavaScript a Flip still renders the face with correct intrinsic
 * dimensions; only the turn is lost.
 *
 * ===========================================================================
 * THE REGISTER IS HAVELI — a wall of lit alcoves
 * ===========================================================================
 * This is the same room as the homepage's "Turn one over." section, and it is
 * built from the same primitives rather than a new look: `.piece__alcove` with
 * its brass mount, its arch-cut teak recess and its lamp, all from
 * `app/globals.css`, unchanged. Only the grid around them is new (`.shop-*`),
 * because a filterable catalogue needs a uniform wall where the homepage needs a
 * lead piece and a shelf.
 *
 * Gold is never a letterform on the plaster field — `--brass` measures 2.85:1
 * there and is ornament only. The light-field accent is `--sindoor`.
 *
 * ===========================================================================
 * PRICE DISPLAY IS FAIL-CLOSED
 * ===========================================================================
 * `PricedPiece.price` is null whenever the piece is quoted on request OR the
 * gold rate is stale, missing or unreadable. This page prints "Price on request"
 * and, where there is something useful to say, WHY. It never prints a zero and
 * never prints a stale figure — see `app/_pricing/rates.ts` for the fail-closed
 * contract that makes a stale rate unreadable as a number in the first place.
 */

const TITLE = `The catalogue | ${site.name}`;
const DESCRIPTION =
  "Every piece Alankar Jewellers has photographed, shown face and enamelled reverse. Filter by metal, purity, collection or price.";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<Metadata> {
  const { query } = parseCatalogueFilter(await searchParams);
  const filtered = isFiltered(query);

  return {
    title: TITLE,
    description: DESCRIPTION,
    alternates: { canonical: "/shop" },
    // A filtered view is a slice of the same five pieces. Letting a crawler
    // index every metal x purity x collection x band combination is duplicate
    // content and crawl budget spent on nothing.
    ...(filtered ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: "website",
      locale: "en_IN",
      url: "/shop",
      siteName: site.name,
      title: TITLE,
      description: DESCRIPTION,
    },
  };
}

/* -------------------------------------------------------------------------
 * The lit alcove. Identical construction to the homepage's `Alcove`: four
 * layers cut to the SAME cusped arch — brass mount, teak recess, the piece, the
 * lamp — so the whole thing is one silhouette rather than a photograph parked on
 * a dark rectangle. The lamp is a sibling and not a wrapper, because a mask
 * clips everything its element paints and would delete the focus ring.
 * ---------------------------------------------------------------------- */
function Alcove({ piece }: { piece: PricedPiece }) {
  return (
    <div className="piece__alcove shop-card__alcove">
      <span className="piece__mount arch" aria-hidden="true" />
      <span className="piece__recess arch" aria-hidden="true" />
      <Flip
        front={piece.mediaKey.front}
        back={piece.mediaKey.back ?? undefined}
        alt={piece.alt}
        altBack={piece.altBack ?? undefined}
        sizes="(max-width: 620px) 78vw, (max-width: 1100px) 40vw, 300px"
      />
      <span className="piece__lamp arch" aria-hidden="true" />
    </div>
  );
}

/** The price line. Never a zero, never a stale figure — see the header. */
function Price({ piece }: { piece: PricedPiece }) {
  if (piece.price === null) {
    const copy = priceUnavailableCopy(piece.priceUnavailableReason);
    return (
      <div className="shop-card__price">
        <p className="shop-card__figure shop-card__figure--request">{copy.headline}</p>
        {copy.note ? <p className="shop-card__pricenote">{copy.note}</p> : null}
      </div>
    );
  }

  return (
    <div className="shop-card__price">
      <p className="shop-card__figure">{formatPricePaise(piece.price.totalPaise)}</p>
      <p className="shop-card__pricenote">
        Including GST. Priced from the gold rate held on{" "}
        <time dateTime={piece.price.rateAsOf}>{piece.price.rateAsOf.slice(0, 10)}</time>.
      </p>
    </div>
  );
}

function ShopCard({ piece }: { piece: PricedPiece }) {
  return (
    <article className="shop-card" id={piece.slug}>
      <Alcove piece={piece} />
      <div className="shop-card__body">
        {piece.subtitle ? <p className="shop-card__kind">{piece.subtitle}</p> : null}
        <h3 className="shop-card__title">
          <Link className="shop-card__link" href={`/shop/${piece.slug}`}>
            {piece.title}
          </Link>
        </h3>
        <p className="shop-card__spec">{piece.spec}</p>
        <Price piece={piece} />
        {piece.isUniquePiece ? (
          <p className="shop-card__stock">One of a kind — there is only this one.</p>
        ) : null}
        {/* ADD TO CART. A plain form, like the filters above it: no JavaScript,
            no client island, and it works with scripting switched off.
            /api/cart answers a form with a 303 to /cart. Adding does not price
            anything — the cart stores intent, and the figure is resolved when
            the cart renders. See app/_data/cart.ts. */}
        <form className="cart-add" method="post" action="/api/cart">
          <input type="hidden" name="action" value="add" />
          <input type="hidden" name="slug" value={piece.slug} />
          <button className="button cart-add__button" type="submit">
            Add to cart
            <span className="visually-hidden"> — {piece.title}</span>
          </button>
        </form>
      </div>
    </article>
  );
}

/* -------------------------------------------------------------------------
 * Filters. A GET form and a set of links: no JavaScript is involved at any
 * point, and every state of this page has its own URL.
 * ---------------------------------------------------------------------- */

const METAL_LABELS: Readonly<Record<string, string>> = {
  gold: "Gold",
  silver: "Silver",
  platinum: "Platinum",
  none: "No metal",
};

const CHIP_LABELS: Readonly<Record<FilterParam, string>> = {
  metal: "Metal",
  purity: "Purity",
  collection: "Collection",
  price: "Price",
};

function chipValue(key: FilterParam, query: CatalogueQuery): string {
  if (key === "metal") return METAL_LABELS[query.metal] ?? query.metal;
  if (key === "purity") return `${query.purity} fineness`;
  if (key === "price") {
    return PRICE_BANDS.find((band) => band.key === query.price)?.label ?? query.price;
  }
  return collectionTitle(query.collection);
}

function Filters({
  query,
  facets,
  shown,
  total,
}: {
  query: CatalogueQuery;
  facets: ReturnType<typeof catalogueFacets>;
  shown: number;
  total: number;
}) {
  const filtered = isFiltered(query);
  const active = (["metal", "purity", "collection", "price"] as const).filter(
    (key) => query[key] !== ""
  );

  return (
    <section className="shop-filters" aria-labelledby="shop-filters-title">
      <div className="shop-filters__head">
        {/* h3, not h2: this section is nested inside the catalogue's own h2, and
            the card titles below sit at the same level. */}
        <h3 className="label" id="shop-filters-title">
          Narrow the wall
        </h3>
        {/* Deliberately NOT a live region. Nothing on this page updates without
            a full navigation, so `role="status"` would be a promise of dynamic
            behaviour that does not exist. */}
        <p className="shop-filters__count">
          Showing {shown} of {total} {total === 1 ? "piece" : "pieces"}.
        </p>
      </div>

      {/* method="get" is the whole no-JavaScript story: the browser builds the
          query string, the server reads it, and the result has a URL. */}
      <form className="shop-filters__form" method="get" action="/shop">
        <div className="shop-field">
          <label htmlFor="filter-metal">Metal</label>
          <select id="filter-metal" name="metal" defaultValue={query.metal}>
            <option value="">Any metal</option>
            {facets.metals.map((metal) => (
              <option key={metal} value={metal}>
                {METAL_LABELS[metal] ?? metal}
              </option>
            ))}
          </select>
        </div>

        <div className="shop-field">
          <label htmlFor="filter-purity">Purity</label>
          <select
            id="filter-purity"
            name="purity"
            defaultValue={query.purity}
            disabled={facets.finenesses.length === 0}
            aria-describedby={facets.finenesses.length === 0 ? "filter-purity-note" : undefined}
          >
            <option value="">Any purity</option>
            {facets.finenesses.map((fineness) => (
              <option key={fineness} value={String(fineness)}>
                {fineness} fineness
              </option>
            ))}
          </select>
          {facets.finenesses.length === 0 ? (
            // Millesimal fineness is an assay result. Offering 999/916/750 as
            // options against inventory nobody has assayed would be inviting a
            // filter to imply a fact.
            <p className="shop-field__note" id="filter-purity-note">
              No piece has a recorded fineness yet.
            </p>
          ) : null}
        </div>

        <div className="shop-field">
          <label htmlFor="filter-collection">Collection</label>
          <select id="filter-collection" name="collection" defaultValue={query.collection}>
            <option value="">Any collection</option>
            {facets.collections.map((collection) => (
              <option key={collection.slug} value={collection.slug}>
                {collection.title}
              </option>
            ))}
          </select>
        </div>

        <div className="shop-field">
          <label htmlFor="filter-price">Price</label>
          <select id="filter-price" name="price" defaultValue={query.price}>
            <option value="">Any price</option>
            {PRICE_BANDS.map((band) => (
              <option key={band.key} value={band.key}>
                {band.label}
              </option>
            ))}
          </select>
        </div>

        <div className="shop-filters__actions">
          <button className="button" type="submit">
            Show pieces
          </button>
          {filtered ? (
            <Link className="text-action" href="/shop">
              Clear all filters
            </Link>
          ) : null}
        </div>
      </form>

      {active.length > 0 ? (
        <ul className="shop-chips" aria-label="Filters applied">
          {active.map((key) => (
            <li key={key}>
              {/* Each chip is a link to the same page minus one filter, so a
                  filter can be removed with the keyboard and without script. */}
              <Link
                className="shop-chip"
                href={catalogueHref(withoutFilter(query, key))}
                rel="nofollow"
              >
                <span className="shop-chip__label">{CHIP_LABELS[key]}:</span>{" "}
                {chipValue(key, query)}
                <span className="shop-chip__x" aria-hidden="true">
                  ×
                </span>
                <span className="visually-hidden">— remove this filter</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------- */

export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { filter, query } = parseCatalogueFilter(await searchParams);

  // Two reads, deliberately: the facets and the "N of M" count describe the
  // WHOLE catalogue, so removing a filter is never a leap in the dark.
  const everything = await listCatalogue();
  const pieces = await listPricedCatalogue(filter);
  const facets = catalogueFacets(everything);
  const priceFiltered = query.price !== "";

  return (
    <div className="shop-page">
      {/* The shared SiteHeader navigates by homepage hash anchors, which are
          dead on this route, so this page carries its own court band — the same
          decision /founders made, for the same reason. */}
      <header className="shop-topbar section--darbar-deep grained">
        <div className="shop-topbar__inner">
          <Link className="shop-wordmark" href="/">
            <span className="shop-wordmark__name">Alankar Jewellers</span>
            <span className="shop-wordmark__since">Since {site.foundedYear}</span>
          </Link>
          <nav className="shop-nav" aria-label="Alankar Jewellers">
            <Link href="/">The shop</Link>
            <Link href="/shop" aria-current="page">
              The catalogue
            </Link>
            <Link href="/founders">The people</Link>
          </nav>
        </div>
        <div className="rule-gold" aria-hidden="true" />
      </header>

      <main>
        {/* DARBAR. The court, because this is the page announcing itself. */}
        <section
          className="section section--darbar grained jali-veil shop-opener"
          aria-labelledby="shop-title"
        >
          <div className="shop-opener__grid">
            <div className="shop-opener__statement">
              <p className="label">The catalogue</p>
              <h1 id="shop-title">Every piece, from both sides.</h1>
              <p className="lede shop-opener__lede">
                The front is what the room sees. The back is enamelled, and only
                the person wearing it ever knows it is there. Hover on a desktop,
                tap on a phone.
              </p>
            </div>

            {CATALOGUE_IS_PLACEHOLDER ? (
              <aside className="panel--lift illuminated shop-notice">
                <p>
                  <span className="shop-tag">Placeholder catalogue</span>
                </p>
                <p>
                  These five pieces stand in for a catalogue that has not been
                  photographed or weighed yet. Nothing here carries a weight, a
                  purity, a hallmark number or a certificate, because none of
                  those has been recorded — so every piece is priced on request
                  rather than given a figure we would be making up.
                </p>
                <p>
                  <Link className="text-action" href="/#visit">
                    Come and see the real ones
                  </Link>
                </p>
              </aside>
            ) : null}
          </div>
        </section>

        <div className="jali-break jali-break--haveli" aria-hidden="true">
          <div className="jali-band jali-band--brass" />
        </div>

        {/* HAVELI. The wall. */}
        <section
          className="section section--haveli grained shop-section"
          id="catalogue"
          aria-labelledby="catalogue-title"
        >
          <div className="shop-section__head">
            <div>
              <p className="label">The pieces</p>
              <h2 id="catalogue-title">Turn one over.</h2>
            </div>
            <p className="lede">
              Each one is photographed twice, face and reverse, on the same grey
              sweep. Every piece is one of a kind, so what is on the wall is what
              there is.
            </p>
            <div className="rule-brass section-head__rule" aria-hidden="true" />
          </div>

          <Filters query={query} facets={facets} shown={pieces.length} total={everything.length} />

          {pieces.length > 0 ? (
            <div className="shop-wall grained">
              <div className="shop-grid">
                {pieces.map((piece) => (
                  <ShopCard key={piece.slug} piece={piece} />
                ))}
              </div>
            </div>
          ) : (
            <div className="shop-wall grained">
              <div className="shop-empty">
                <h3>Nothing on the wall matches that.</h3>
                {priceFiltered ? (
                  <p>
                    Every piece in the catalogue today is priced on request,
                    because none of them has been weighed. A price band therefore
                    matches nothing at all — it is not an empty shelf, it is an
                    unrecorded one.
                  </p>
                ) : (
                  <p>
                    Try removing a filter. The catalogue is small and
                    one-of-a-kind by nature, so most combinations narrow to
                    nothing quickly.
                  </p>
                )}
                <Link className="button" href="/shop">
                  Show every piece
                </Link>
              </div>
            </div>
          )}

          <div className="rule-brass shop-sill" aria-hidden="true" />
        </section>

        <div className="jali-break" aria-hidden="true">
          <div className="jali-band" />
        </div>

        {/* DARBAR. The page closes in the room it is asking you to come to. */}
        <section
          className="section section--darbar grained shop-close"
          aria-labelledby="shop-close-title"
        >
          <div className="opener illuminated shop-close__panel">
            <p className="label">By appointment</p>
            <h2 id="shop-close-title">Seen properly, in the salon.</h2>
            <div className="rule-gold rule rule--center" aria-hidden="true" />
            <p className="shop-close__body">
              Online ordering is not open yet. Pieces are seen in the inner
              salon, away from the counter, with someone who can tell you where a
              stone came from and what the back of it looks like before you turn
              it over.
            </p>
            <Link className="button" href="/#visit">
              Book a viewing
            </Link>
          </div>
        </section>
      </main>

      <footer className="shop-colophon section--darbar-deep grained">
        <p>
          {site.name}, since {site.foundedYear}. <Link href="/">Back to the shop</Link>
        </p>
      </footer>
    </div>
  );
}
