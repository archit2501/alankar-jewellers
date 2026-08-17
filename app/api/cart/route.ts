/**
 * THE CART ENDPOINT — /api/cart.
 *
 * ===========================================================================
 * WHAT THIS ROUTE DELIBERATELY DOES *NOT* COPY FROM /api/appointments
 * ===========================================================================
 * The appointments route is a considered design for a LEAD. This is commerce,
 * and two of its rules invert here. Both are recorded as hazards in
 * `.claude-protocol/state.json`; neither is an oversight there or here.
 *
 *  1. NO DUAL SINK. Appointments treat "the database OR the webhook accepted
 *     it" as success, because a lead that reached a human is a captured lead.
 *     A cart line that is not in D1 is not in the cart. There is exactly one
 *     sink, and if it fails this route says so — 503, `ok: false`, and the
 *     visitor is told nothing was changed. It never answers 201 on a write it
 *     did not make.
 *
 *  2. NO SILENT THROTTLE. Appointments answer a repeat submission with a
 *     fabricated `201 {ok:true}` so a bot learns nothing. Doing that here
 *     would tell a customer adding their second piece — or re-adding after a
 *     misclick — that it worked when nothing happened. Every response below
 *     reports what actually occurred: `alreadyInCart`, `removed: false`, and
 *     the matching notice code all exist so that nothing has to be faked.
 *
 * ===========================================================================
 * TWO CALLERS, TWO SHAPES, ONE CODE PATH
 * ===========================================================================
 * The storefront has no JavaScript on it. The add and remove controls are
 * plain `<form method="post">` elements, exactly like the `/shop` filters, so
 * the cart works with scripting switched off, is keyboard-operable for free
 * and needs no client island at all.
 *
 *   application/x-www-form-urlencoded  ->  303 See Other to /cart?notice=…
 *                                          (POST/redirect/GET: a refresh on
 *                                          the cart page re-renders, it does
 *                                          not re-submit)
 *   application/json  (or Accept: json)->  JSON, the house `{ok, …}` shape
 *
 * The redirect target is built by `cartHref()` from a closed set of notice
 * codes. Nothing from the request is ever reflected into a `Location` header,
 * so there is no open redirect here and nothing to inject into.
 *
 * ===========================================================================
 * THE COOKIE
 * ===========================================================================
 * The cart token is a bearer credential: HttpOnly (no script can read it),
 * Secure, SameSite=Lax, and generated with `crypto.randomUUID()`. It is set
 * here on the response rather than through `cookies()` so the header is
 * attached to the exact Response this handler returns — including the 303.
 *
 * A token that is malformed, or that names no open cart, is DISCARDED: the
 * data layer generates a fresh server-side id and this route overwrites the
 * cookie with it. A caller can never choose its own cart id, which is what
 * closes session fixation. See `app/_data/cart.ts` (4).
 */

import { getCataloguePiece } from "../../_data/catalogue";
import {
  addToCart,
  cartCookieHeader,
  cartHref,
  getCartDb,
  readCart,
  readCartTokenFromCookieHeader,
  removeFromCart,
  type CartNotice,
} from "../../_data/cart";

/** A slug is a catalogue identifier, not free text. Anything else is refused. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Same-origin check for the one state-changing method here.
 *
 * `SameSite=Lax` already stops the cart cookie riding along on a cross-site
 * POST, so a forged submission cannot reach anyone's existing cart. What it
 * does NOT stop is a third-party page POSTing here and having the browser
 * accept the fresh `Set-Cookie` that comes back — which would silently swap a
 * shopper's cart for an empty one. That is a nuisance rather than a breach,
 * and it costs one header comparison to close.
 *
 * Deliberately permissive in one direction: a request with NO `Origin` at all
 * is allowed through. Browsers have sent `Origin` on POST for years, but
 * `curl`, a server-to-server call and the test harness do not, and refusing
 * those would break the JSON API for no security gain — the attack needs a
 * browser, and a browser sends the header.
 */
function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;

  // The Host the browser addressed, which is the value its Origin must match.
  let host = request.headers.get("host");
  if (!host) {
    try {
      host = new URL(request.url).host;
    } catch {
      return false;
    }
  }

  try {
    return new URL(origin).host !== host;
  } catch {
    // An Origin header that is not a URL was not written by a browser.
    return true;
  }
}

function isFormPost(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  );
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type Answer = { status: number; body: Record<string, unknown>; notice: CartNotice | null };

/**
 * One outcome, rendered for whichever caller asked.
 *
 * A JSON caller gets the real status code. A BROWSER FORM always gets the 303,
 * including on failure, because a 4xx with a `Location` is a blank page — the
 * browser does not follow it — and a blank page tells a customer nothing at
 * all. The failure is not swallowed by that: it travels as the notice code and
 * `/cart` renders it as an error banner in the shop's own words. The redirect
 * says "go and look at your cart", never "that worked".
 */
function respond(request: Request, answer: Answer, setCookie: string | null): Response {
  const headers = new Headers();
  if (setCookie) headers.append("Set-Cookie", setCookie);

  if (isFormPost(request)) {
    headers.set("Location", cartHref(answer.notice ?? undefined));
    // 303 forces the follow-up to be a GET, so a reload or a back button does
    // not re-post the form.
    return new Response(null, { status: 303, headers });
  }

  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(answer.body), { status: answer.status, headers });
}

function badRequest(
  request: Request,
  error: string,
  notice: CartNotice = "bad-request"
): Response {
  return respond(request, { status: 400, body: { ok: false, error }, notice }, null);
}

/** Read `{ action, slug }` from either body shape. */
async function readIntent(
  request: Request
): Promise<{ action: string; slug: string } | null> {
  if (isFormPost(request)) {
    const form = await request.formData();
    return {
      action: asTrimmedString(form.get("action")),
      slug: asTrimmedString(form.get("slug")),
    };
  }

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    if (!payload || typeof payload !== "object") return null;
    return { action: asTrimmedString(payload.action), slug: asTrimmedString(payload.slug) };
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) {
    return respond(
      request,
      {
        status: 403,
        body: { ok: false, error: "Cart changes must come from this site." },
        notice: "bad-request",
      },
      null
    );
  }

  const intent = await readIntent(request);
  if (intent === null) {
    return badRequest(request, "Request body must be valid JSON or a form submission.");
  }

  const { action, slug } = intent;

  if (action !== "add" && action !== "remove") {
    return badRequest(request, 'Field "action" must be "add" or "remove".');
  }
  if (!slug || slug.length > 120 || !SLUG_PATTERN.test(slug)) {
    return badRequest(request, "That is not a piece we recognise.", "unknown-piece");
  }

  // The catalogue layer is the one place that knows what a piece IS. Asking it
  // first means an unknown slug is a clean 404 with the shop's own copy rather
  // than a foreign-key error surfacing from the cart tables.
  const piece = await getCataloguePiece(slug);
  if (piece === null) {
    return respond(
      request,
      {
        status: 404,
        body: { ok: false, error: "We could not find that piece." },
        notice: "unknown-piece",
      },
      null
    );
  }

  const token = readCartTokenFromCookieHeader(request.headers.get("cookie"));

  try {
    const db = getCartDb();

    if (action === "remove") {
      const result = await removeFromCart(db, { token, slug });

      if (!result.ok) {
        // "no_cart" is not an error the visitor caused: there is simply
        // nothing to remove from. Say that rather than inventing a failure.
        const known = result.reason === "unknown_piece";
        return respond(
          request,
          {
            status: known ? 404 : 200,
            body: known
              ? { ok: false, error: "We could not find that piece." }
              : { ok: true, removed: false, cart: { itemCount: 0 } },
            notice: known ? "unknown-piece" : "not-in-cart",
          },
          null
        );
      }

      const snapshot = await readCart(db, { token: result.cartId });
      return respond(
        request,
        {
          status: 200,
          // `removed` is reported, not assumed. A second click on Remove
          // answers `removed: false`, which is true, instead of pretending.
          body: {
            ok: true,
            removed: result.removed,
            released: result.released,
            cart: { itemCount: snapshot.lines.length },
          },
          notice: result.removed ? "removed" : "not-in-cart",
        },
        cartCookieHeader(result.cartId)
      );
    }

    const result = await addToCart(db, { token, slug });

    if (!result.ok) {
        // Three refusals, three different truths. A piece the shop never put
        // on sale online is not "sold out" and not "unknown"; saying either
        // sends a customer away from a piece that is available, just not here.
        const REFUSALS = {
          sold_out: {
            status: 409,
            error: "That piece has left the shop.",
            notice: "sold-out" as const,
          },
          not_for_sale_online: {
            status: 403,
            error:
              "This piece is not sold through the website. Ring the shop or ask for a viewing.",
            notice: "not-for-sale-online" as const,
          },
          unknown_piece: {
            status: 404,
            error: "We could not find that piece.",
            notice: "unknown-piece" as const,
          },
        };
        const refusal = REFUSALS[result.reason];
        return respond(
          request,
          {
            status: refusal.status,
            body: { ok: false, error: refusal.error },
            notice: refusal.notice,
          },
          null
        );
    }

    const snapshot = await readCart(db, { token: result.cartId });

    return respond(
      request,
      {
        status: result.alreadyInCart ? 200 : 201,
        body: {
          ok: true,
          // No price anywhere in this response, because there is no price in
          // the cart. The figure is resolved when /cart renders, against the
          // live rate, and again at order time.
          alreadyInCart: result.alreadyInCart,
          held: result.claimed || result.holdExpiresAt !== null,
          heldByAnother: result.heldByAnother,
          holdExpiresAt: result.holdExpiresAt,
          cart: { itemCount: snapshot.lines.length },
        },
        notice: result.alreadyInCart ? "already-in-cart" : "added",
      },
      cartCookieHeader(result.cartId)
    );
  } catch (error) {
    // The single sink failed. There is no second one, and no pretending.
    console.error("[cart] the cart store is unavailable:", error);
    return respond(
      request,
      {
        status: 503,
        body: {
          ok: false,
          error:
            "We could not reach your cart just now, so nothing was changed. Please try again, or call the shop and we will set the piece aside by hand.",
        },
        notice: "unavailable",
      },
      null
    );
  }
}

/**
 * The cart as JSON. Read-only: it issues no cookie and creates no cart, so a
 * crawler or a probe cannot mint carts by polling this.
 */
export async function GET(request: Request): Promise<Response> {
  const token = readCartTokenFromCookieHeader(request.headers.get("cookie"));

  try {
    const snapshot = await readCart(getCartDb(), { token });
    return Response.json({
      ok: true,
      cart: {
        itemCount: snapshot.lines.length,
        // Slugs and hold state only. No price: the cart has none to give.
        items: snapshot.lines.map((line) => ({
          slug: line.slug,
          quantity: line.quantity,
          heldByYou: line.heldByYou,
          heldByAnother: line.heldByAnother,
          holdExpiresAt: line.holdExpiresAt,
        })),
      },
    });
  } catch (error) {
    console.error("[cart] the cart store is unavailable:", error);
    return Response.json(
      { ok: false, error: "We could not reach your cart just now." },
      { status: 503 }
    );
  }
}
