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
 * THE CART — /cart.
 *
 * ===========================================================================
 * A SERVER COMPONENT, AND NO CLIENT JAVASCRIPT AT ALL
 * ===========================================================================
 * The remove control is a `<form method="post">`, exactly like the `/shop`
 * filters are a `<form method="get">`. `/api/cart` answers a form with a 303
 * back here, so the cart works with scripting switched off, is keyboard
 * operable for free, survives a reload without re-posting, and ships zero
 * kilobytes of client bundle. There is no island on this page because none is
 * necessary, which is the smallest island there is.
 *
 * ===========================================================================
 * THE PRICE, AND THE TOTAL THAT IS HONESTLY ABSENT
 * ===========================================================================
 * The cart stores INTENT — no price is written when a piece is added, and none
 * is read back here. See `app/_data/cart.ts` (1). Every figure on this page is
 * resolved at render time by the catalogue layer against the live rate, and
 * that layer fails closed: a piece that is quoted by hand, or whose rate is
 * stale or unreadable, comes back with `price: null` and a stated reason.
 *
 * So this page prints "Price on request" per line, and the TOTAL follows the
 * same rule with no softening:
 *
 *   every line priced   ->  one figure, GST included.
 *   anything unpriced   ->  NO figure. Not ₹0, not "from ₹—", not the sum of
 *                           the priceable half, which would be a smaller
 *                           number than the true one and therefore the most
 *                           misleading option available.
 *
 * Today every seeded piece is `on_request`, so the second branch is what a
 * visitor sees, and it says why.
 *
 * ===========================================================================
 * THE REGISTER IS HAVELI
 * ===========================================================================
 * The wall of lit alcoves, same as `/shop` and the homepage's "Turn one over."
 * — `.piece__alcove`, `.piece__mount`, `.piece__recess` and `.piece__lamp` are
 * reused UNCHANGED. Gold is text on the two Darbar bands only; on the plaster
 * field brass is ornament (the mount, the rules) and never a letterform, and
 * the accent for text is `--sindoor`.
 *
 * ===========================================================================
 * PRIVACY AND RENDERING MODE
 * ===========================================================================
 * `force-dynamic` and `robots: noindex`. This page is per-visitor: it is keyed
 * on a bearer cookie, it must never be prerendered into a shared cache, and it
 * must never be indexed. The cart token itself is HttpOnly and never appears
 * in the markup — no form on this page carries it, because the browser sends
 * the cookie on the POST.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import {
  formatPricePaise,
  listPricedCatalogue,
  priceUnavailableCopy,
} from "../_data/catalogue";
import {
  CART_COOKIE,
  CART_NOTICES,
  EMPTY_CART,
  HOLD_MINUTES,
  formatHoldExpiry,
  getCartDb,
  readCart,
  toCartNotice,
  type CartLine,
  type CartSnapshot,
} from "../_data/cart";
import type { PricedPiece } from "../_data/types";
import { images } from "../_media/images";
import { site } from "../site-config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Your cart | ${site.name}`,
  description: "The pieces you have set aside at Alankar Jewellers.",
  // A cart is one visitor's private page behind a bearer cookie. It is not a
  // URL any crawler should hold, follow or surface.
  robots: { index: false, follow: false },
};

/* -------------------------------------------------------------------------
 * One line, joined to the piece it names
 * ---------------------------------------------------------------------- */

type CartRow = {
  readonly line: CartLine;
  /** Null when a piece has been withdrawn from the catalogue since it was added. */
  readonly piece: PricedPiece | null;
};

/**
 * The alcove, identical in construction to the one on `/shop`: brass mount,
 * arch-cut teak recess, the photograph, the lamp — four layers cut to the same
 * cusped arch so the whole thing is one silhouette. The lamp is a sibling and
 * not a wrapper, because a mask clips everything its element paints.
 *
 * The face only. `/shop` turns a piece over because discovering the enamelled
 * reverse is the point of browsing; by the time a piece is in the cart that
 * discovery has happened, and a hover-to-reveal here would be an interaction
 * asking to be performed rather than information being offered.
 */
function Alcove({ piece }: { piece: PricedPiece }) {
  const asset = images[piece.mediaKey.front];

  return (
    <div className="piece__alcove cart-item__alcove">
      <span className="piece__mount arch" aria-hidden="true" />
      <span className="piece__recess arch" aria-hidden="true" />
      <img
        className="cart-item__image arch"
        src={asset.src}
        srcSet={asset.srcSet}
        sizes="(max-width: 720px) 60vw, 220px"
        width={asset.width}
        height={asset.height}
        alt={piece.alt}
        loading="lazy"
        decoding="async"
      />
      <span className="piece__lamp arch" aria-hidden="true" />
    </div>
  );
}

/** Never a zero and never a stale figure. See the header. */
function LinePrice({ piece }: { piece: PricedPiece }) {
  if (piece.price === null) {
    const copy = priceUnavailableCopy(piece.priceUnavailableReason);
    return (
      <div className="cart-item__price">
        <p className="cart-item__figure cart-item__figure--request">{copy.headline}</p>
        {copy.note ? <p className="cart-item__pricenote">{copy.note}</p> : null}
      </div>
    );
  }

  return (
    <div className="cart-item__price">
      <p className="cart-item__figure">{formatPricePaise(piece.price.totalPaise)}</p>
      <p className="cart-item__pricenote">
        Including GST. Priced from the gold rate held on{" "}
        <time dateTime={piece.price.rateAsOf}>{piece.price.rateAsOf.slice(0, 10)}</time>.
      </p>
    </div>
  );
}

/**
 * What the reservation actually says. Two carts may hold the same piece in
 * their lists — that is normal — but `stock_reservations` lets exactly one of
 * them reserve it, and this line is where that fact is told rather than hidden.
 */
function HoldState({ line }: { line: CartLine }) {
  if (line.heldByYou) {
    const until = line.holdExpiresAt ? formatHoldExpiry(line.holdExpiresAt) : null;
    return (
      <p className="cart-item__hold cart-item__hold--yours">
        Held for you{until ? ` until ${until}` : ` for ${HOLD_MINUTES} minutes`}.
      </p>
    );
  }

  if (line.heldByAnother) {
    return (
      <p className="cart-item__hold cart-item__hold--elsewhere">
        Someone else is looking at this one right now, so it is not reserved for
        you. It stays in your cart, and we will tell you the moment it is free
        again.
      </p>
    );
  }

  return (
    <p className="cart-item__hold">
      Not reserved yet. There is only one of this piece, so ask us to set it
      aside if you are certain.
    </p>
  );
}

function RemoveControl({ slug, title }: { slug: string; title: string }) {
  return (
    <form className="cart-item__remove" method="post" action="/api/cart">
      <input type="hidden" name="action" value="remove" />
      <input type="hidden" name="slug" value={slug} />
      <button className="text-action cart-item__removebutton" type="submit">
        Remove
        <span className="visually-hidden"> {title} from your cart</span>
      </button>
    </form>
  );
}

function CartItem({ row }: { row: CartRow }) {
  const { line, piece } = row;

  // A piece withdrawn from the catalogue after it was added. It is not
  // silently dropped from the cart and it is not shown with a borrowed
  // photograph — it is stated, with the control to take it out.
  if (piece === null) {
    return (
      <li className="cart-item cart-item--withdrawn">
        <div className="cart-item__body">
          <h2 className="cart-item__title">This piece is no longer listed.</h2>
          <p className="cart-item__spec">
            It was in your cart, and it has since been taken off the wall. We
            have left it here rather than removing it behind your back.
          </p>
          <RemoveControl slug={line.slug} title="the withdrawn piece" />
        </div>
      </li>
    );
  }

  return (
    <li className="cart-item">
      <Alcove piece={piece} />
      <div className="cart-item__body">
        {piece.subtitle ? <p className="cart-item__kind">{piece.subtitle}</p> : null}
        <h2 className="cart-item__title">
          <Link className="cart-item__link" href={`/shop/${piece.slug}`}>
            {piece.title}
          </Link>
        </h2>
        <p className="cart-item__spec">{piece.spec}</p>
        <LinePrice piece={piece} />
        <HoldState line={line} />
        {piece.isUniquePiece ? (
          <p className="cart-item__stock">One of a kind. There is only this one.</p>
        ) : null}
        <RemoveControl slug={piece.slug} title={piece.title} />
      </div>
    </li>
  );
}

/* -------------------------------------------------------------------------
 * The total
 * ---------------------------------------------------------------------- */

function Total({ rows }: { rows: readonly CartRow[] }) {
  const pieces = rows.map((row) => row.piece);
  const priced = pieces.filter(
    (piece): piece is PricedPiece & { price: NonNullable<PricedPiece["price"]> } =>
      piece !== null && piece.price !== null
  );
  const everythingPriced = pieces.length > 0 && priced.length === pieces.length;

  if (everythingPriced) {
    const totalPaise = priced.reduce((sum, piece) => sum + piece.price.totalPaise, 0);
    return (
      <aside className="cart-total" aria-label="Cart total">
        <p className="label">The total</p>
        <p className="cart-total__figure">{formatPricePaise(totalPaise)}</p>
        <p className="cart-total__note">
          Everything included, GST paid, priced against today&rsquo;s gold rate.
          The rate moves twice every business day, so this figure is confirmed
          when we quote you and not before.
        </p>
        {/* PROCEED TO CHECKOUT. A plain link, because going to a page is a
            navigation and not a state change. It appears in this branch only:
            every piece here carries a figure, so the control leads somewhere
            that works. */}
        <Link className="button checkout-proceed" href="/checkout">
          Go to checkout
        </Link>
      </aside>
    );
  }

  return (
    <aside className="cart-total" aria-label="Cart total">
      <p className="label">The total</p>
      {/* NOT a zero and NOT the sum of the priceable half — either would be a
          number smaller than the truth. The absence is the honest answer. */}
      <p className="cart-total__figure cart-total__figure--absent">Not quoted</p>
      <p className="cart-total__note">
        {priced.length === 0
          ? "Nothing in your cart carries a price yet. These pieces are quoted by hand, against the gold rate at the moment you ask, and we would rather show you no figure than one we cannot stand behind."
          : `${priced.length} of ${pieces.length} pieces here have a figure. A total is only shown when every piece in the cart has one, because a partial total is a smaller number than the real one.`}
      </p>
      <p className="cart-total__note">
        Ask us and we will price the whole cart in front of you, itemised:
        metal, making, stones and GST, the same way every piece on this site is
        broken up.
      </p>
      {/* The same control, told the truth. Checkout refuses to create an order
          for a piece it cannot price, so this is not offered as a button that
          would fail: it is offered as the page that explains, piece by piece,
          why it cannot and what to do instead. */}
      <Link className="text-action checkout-proceed" href="/checkout">
        Why these cannot be ordered yet
      </Link>
    </aside>
  );
}

/* -------------------------------------------------------------------------
 * The empty cart — an invitation, not a dead end
 * ---------------------------------------------------------------------- */

function EmptyCart() {
  return (
    <div className="cart-empty">
      <h2 className="cart-empty__title">Nothing set aside yet.</h2>
      <p className="cart-empty__body">
        Every piece in the catalogue is one of a kind, photographed face and
        enamelled reverse. Put one here and we will hold it for you while you
        think. {HOLD_MINUTES} minutes at a time, and nothing is charged for
        while it sits.
      </p>
      <div className="cart-empty__actions">
        <Link className="button" href="/shop">
          See every piece
        </Link>
        <Link className="text-action" href="/#visit">
          Or book a viewing in the salon
        </Link>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------- */

export default async function CartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.notice;
  const notice = toCartNotice(Array.isArray(raw) ? raw[0] : raw);

  const jar = await cookies();
  const token = jar.get(CART_COOKIE)?.value ?? null;

  let snapshot: CartSnapshot = EMPTY_CART;
  let unavailable = false;

  try {
    snapshot = await readCart(getCartDb(), { token });
  } catch (error) {
    // No fabricated empty cart. A cart we cannot read is not a cart we know to
    // be empty, and saying "nothing here" would be a claim we cannot make.
    console.error("[cart] could not read the cart:", error);
    unavailable = true;
  }

  // One catalogue read and one rate read for the whole page, rather than one
  // per line. The pieces are priced here, at render time, against the live
  // rate — the cart itself holds no figure.
  const priced = snapshot.lines.length > 0 ? await listPricedCatalogue() : [];
  const bySlug = new Map(priced.map((piece) => [piece.slug, piece]));
  const rows: CartRow[] = snapshot.lines.map((line) => ({
    line,
    piece: bySlug.get(line.slug) ?? null,
  }));

  return (
    <div className="cart-page">
      {/* The shared SiteHeader navigates by homepage hash anchors, which are
          dead on this route, so this page carries its own court band — the
          same decision /shop and /founders made, for the same reason. */}
      <header className="cart-topbar section--darbar-deep grained">
        <div className="cart-topbar__inner">
          <Link className="cart-wordmark" href="/">
            <span className="cart-wordmark__name">{site.name}</span>
            <span className="cart-wordmark__since">Since {site.foundedYear}</span>
          </Link>
          <nav className="cart-nav" aria-label={site.name}>
            <Link href="/">The shop</Link>
            <Link href="/shop">The catalogue</Link>
            <Link href="/cart" aria-current="page">
              Your cart
            </Link>
          </nav>
        </div>
        <div className="rule-gold" aria-hidden="true" />
      </header>

      <main>
        {/* HAVELI. The house, not the court: this is a working page. */}
        <section
          className="section section--haveli grained cart-section"
          aria-labelledby="cart-title"
        >
          <div className="cart-head">
            <h1 id="cart-title">Set aside for you.</h1>
            <p className="lede cart-head__lede">
              Nothing here is charged for and nothing here is priced in advance.
              Gold moves twice every business day, so a piece is quoted when you
              ask and not when you clicked.
            </p>
            <div className="rule-brass cart-head__rule" aria-hidden="true" />
          </div>

          {notice ? (
            <p
              className={`cart-notice${
                notice === "unavailable" || notice === "bad-request"
                  ? " cart-notice--problem"
                  : ""
              }`}
            >
              {CART_NOTICES[notice]}
            </p>
          ) : null}

          {unavailable ? (
            <div className="cart-wall grained">
              <div className="cart-empty">
                <h2 className="cart-empty__title">We cannot read your cart just now.</h2>
                <p className="cart-empty__body">
                  This is our end, not yours, and nothing has been lost or
                  changed. Try again in a moment, or call the shop and we will
                  set the piece aside by hand, which is how it was done here for
                  a long time before this page existed.
                </p>
                <div className="cart-empty__actions">
                  <Link className="button" href="/cart">
                    Try again
                  </Link>
                  <Link className="text-action" href="/#visit">
                    Or book a viewing in the salon
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <div className="cart-wall grained">
              {rows.length > 0 ? (
                <div className="cart-layout">
                  <ul className="cart-list">
                    {rows.map((row) => (
                      <CartItem key={row.line.variantId} row={row} />
                    ))}
                  </ul>
                  <Total rows={rows} />
                </div>
              ) : (
                <EmptyCart />
              )}
            </div>
          )}

          <div className="rule-brass cart-sill" aria-hidden="true" />
        </section>

        <div className="jali-break" aria-hidden="true">
          <div className="jali-band" />
        </div>

        {/* DARBAR. The page closes in the room it is asking you to come to. */}
        <section
          className="section section--darbar grained cart-close"
          aria-labelledby="cart-close-title"
        >
          <div className="opener illuminated cart-close__panel">
            <h2 id="cart-close-title">Ask us to price these.</h2>
            <div className="rule-gold rule rule--center" aria-hidden="true" />
            <p className="cart-close__body">
              Paying online is not open yet. What a cart does here is hold a
              piece while we quote it, itemised, against the rate at the moment
              you ask. Then you either come and see it or we send it. Every
              piece is one of a kind, so the holding is the part that matters.
            </p>
            <Link className="button" href="/#visit">
              Book a viewing
            </Link>
          </div>
        </section>
      </main>

      <footer className="cart-colophon section--darbar-deep grained">
        <p>
          {site.name}, since {site.foundedYear}.{" "}
          <Link href="/shop">Back to the catalogue</Link>
        </p>
      </footer>
    </div>
  );
}
