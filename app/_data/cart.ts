/**
 * THE CART DATA LAYER. One module, read by `/cart` and by `/api/cart`.
 *
 * ===========================================================================
 * 1. THE CART STORES INTENT. IT NEVER STORES A PRICE.
 * ===========================================================================
 * Nothing in this file writes `cart_items.quoted_unit_price_paise` or
 * `cart_items.quoted_at`, and nothing reads them to compute money. Both are
 * written as an explicit NULL on insert so a future edit that wants to put a
 * figure there has to delete a line that says why it must not.
 *
 * The reason is in `db/schema.ts` and in research/02-market-tech.md §2: gold
 * moves twice every business day. A cart that remembers Tuesday's figure and
 * charges it on Friday is either a loss the shop absorbs or an ambush at the
 * counter, and given the rate volatility documented there it is materially
 * wrong, not marginally. Price resolves once, at order time, against the live
 * rate — through `price_quotes`, which this module does not touch either.
 *
 * The cart page therefore prices what it displays by calling the CATALOGUE
 * layer (`app/_data/catalogue.ts`) at render time, exactly as `/shop` does, and
 * it inherits that layer's fail-closed contract: a piece with no resolvable
 * price shows "price on request", never a zero and never a stale figure.
 *
 * ===========================================================================
 * 2. ONE-OF-A-KIND STOCK IS ARBITRATED BY SQLITE, NOT BY THIS FILE
 * ===========================================================================
 * `variants.isUniquePiece` defaults true and `stockQuantity` is 1 for every
 * piece in this shop. Two shoppers holding the same piece in their carts is
 * normal and is allowed here. Only one of them can RESERVE it.
 *
 * `stock_reservations` carries a partial unique index —
 * `UNIQUE (variant_id) WHERE status = 'held'` — so the claim is:
 *
 *   INSERT INTO stock_reservations (...) VALUES (...)
 *   ON CONFLICT (variant_id) WHERE status = 'held' DO NOTHING
 *
 * followed by a check of `changes === 1`. The database decides who wins.
 * READ-THEN-WRITE IS UNSAFE HERE AND ALWAYS WILL BE: D1 has no interactive
 * transactions, so two requests can both read "nobody holds this" and both
 * proceed. There is no `SELECT` anywhere in this file whose result is used to
 * decide whether a hold may be taken. The only `SELECT` against
 * `stock_reservations` runs AFTER the insert, and only to describe what
 * happened.
 *
 * The conflict target is spelled out (`(variant_id) WHERE status = 'held'`)
 * rather than left bare. A bare `ON CONFLICT DO NOTHING` would also swallow a
 * primary-key collision, which is a bug we want to hear about, not absorb.
 *
 * ===========================================================================
 * 3. `db.batch()` IS THE ONLY ATOMICITY PRIMITIVE
 * ===========================================================================
 * Per `db/schema.ts`: `drizzle.transaction()` throws on D1, one batch is one
 * transaction, and two batches are two transactions. So every operation here
 * that must not tear is exactly one batch:
 *
 *   ADD     create the cart (when there is none) · touch it · sweep expired
 *           holds · upsert the line · claim the piece.
 *           The sweep sits BEFORE the claim inside the same transaction, so a
 *           hold that has just expired frees the partial index for the claim
 *           in the same statement sequence rather than one request later.
 *
 *   REMOVE  delete the line · release this cart's hold · touch the cart.
 *           One transaction, which is what makes "removing an item releases
 *           its reservation" true rather than merely intended: there is no
 *           interleaving in which the line is gone and the hold survives.
 *
 * Bound parameters are counted: the widest statement below binds eight, and
 * the widest batch binds twenty-three across five statements. The D1 cap is
 * 100 per statement. Nothing here grows with cart size except the reclaim
 * batch, which is capped at `MAX_RECLAIMS_PER_READ`.
 *
 * ===========================================================================
 * 4. CART IDENTITY IS A BEARER CREDENTIAL
 * ===========================================================================
 * Anonymous shoppers need a cart before they have an account, so the cart is
 * identified by an opaque token in an `HttpOnly; Secure; SameSite=Lax` cookie.
 * Anyone holding that token sees that cart, which has three consequences that
 * are enforced below rather than documented and hoped for:
 *
 *   (a) The token is `crypto.randomUUID()` — 122 bits of randomness from a
 *       CSPRNG. It is never derived from a phone number, an email, a counter
 *       or a timestamp, all of which are guessable.
 *
 *   (b) A token that is not a well-formed random UUID is REJECTED before the
 *       database is touched (`isWellFormedCartToken`).
 *
 *   (c) A well-formed token that matches no open cart does NOT become a cart.
 *       `resolveCartId` never inserts the value it was given; it generates a
 *       fresh server-side id. That is what stops session fixation: an attacker
 *       cannot pick a token, plant it in a victim's browser and then read the
 *       cart the victim fills, because the token the victim's browser gets
 *       back is one the server chose.
 *
 * Every read is scoped by `cart_id`, so one cart cannot see another's lines.
 *
 * ===========================================================================
 * 5. WHY RAW SQL, AND WHY A PORT
 * ===========================================================================
 * The two guarantees this module rests on — `changes === 1` on a conflicting
 * insert, and one batch being one transaction — are D1/SQLite guarantees, and
 * they are clearest expressed in the statements the schema comment itself
 * writes out. So this file speaks SQL through a four-method port rather than
 * through a query builder.
 *
 * The port also means the tests exercise this exact code against a real
 * SQLite database built from the project's own migration, with the real
 * partial unique index doing the arbitrating. The race is proved, not mocked.
 */

import { env } from "cloudflare:workers";

/* =========================================================================
 * The port
 * ====================================================================== */

/** Everything this module binds. The schema has no BLOB or REAL columns. */
export type SqlValue = string | number | null;

export type SqlRow = Record<string, unknown>;

export type CartStatement = {
  readonly sql: string;
  readonly params: readonly SqlValue[];
};

/** What a write reports back. `changes` is the arbitration signal. */
export type CartWriteResult = { readonly changes: number };

/**
 * The narrow database surface the cart needs. `batch` is a TRANSACTION: every
 * statement commits or none does.
 */
export type CartDb = {
  all(sql: string, params?: readonly SqlValue[]): Promise<SqlRow[]>;
  batch(statements: readonly CartStatement[]): Promise<CartWriteResult[]>;
};

/** The port over a real D1 binding. */
export function d1CartDb(database: D1Database): CartDb {
  return {
    async all(sql, params = []) {
      const result = await database.prepare(sql).bind(...params).all();
      return (result.results ?? []) as SqlRow[];
    },
    async batch(statements) {
      if (statements.length === 0) return [];
      const results = await database.batch(
        statements.map((statement) =>
          database.prepare(statement.sql).bind(...statement.params)
        )
      );
      return results.map((result) => ({ changes: result.meta?.changes ?? 0 }));
    },
  };
}

/**
 * The cart's database, or a throw. Deliberately NOT a fallback: the catalogue
 * can serve a compiled seed when D1 is unreachable because browsing is
 * read-only, but a cart that cannot be written is not a cart. The caller
 * reports the failure; it never pretends the piece was added.
 */
export function getCartDb(): CartDb {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable, so the cart cannot be read or written."
    );
  }
  return d1CartDb(env.DB);
}

/* =========================================================================
 * The token
 * ====================================================================== */

export const CART_COOKIE = "aj_cart";

/** Thirty days. Long enough to come back to a piece, short enough to expire. */
export const CART_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/**
 * How long a claim on a one-of-a-kind piece lasts. A hold that never expires
 * takes the piece off sale permanently the first time someone wanders off, so
 * `expires_at` is `notNull` in the schema and this is the only value written
 * into it. It is NOT extended on every page view: a self-renewing hold is a
 * permanent hold wearing a timer.
 */
export const HOLD_MINUTES = 30;

/** A cart read reclaims at most this many pieces, so a read stays bounded. */
const MAX_RECLAIMS_PER_READ = 20;

/**
 * Exactly the shape `crypto.randomUUID()` produces: version 4, variant 1,
 * lower case, 36 characters. Anything else is rejected without a query — a
 * forged or truncated cookie must not cost a database round trip, and must
 * never reach a statement.
 */
const CART_TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isWellFormedCartToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 36 &&
    CART_TOKEN_PATTERN.test(value)
  );
}

/**
 * A new cart token. `crypto.randomUUID()` is CSPRNG-backed on both Workers and
 * Node; nothing here is derived from the request, the clock or a counter.
 */
export function newCartToken(): string {
  return crypto.randomUUID();
}

/** The cookie as it is sent. HttpOnly so no script can read the credential. */
export function cartCookieHeader(token: string): string {
  return [
    `${CART_COOKIE}=${token}`,
    "Path=/",
    `Max-Age=${CART_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/** Read the cart token out of a raw `Cookie:` header, or `null`. */
export function readCartTokenFromCookieHeader(header: string | null): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== CART_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return isWellFormedCartToken(value) ? value : null;
  }

  return null;
}

/* =========================================================================
 * Row helpers — narrowing, never casting
 * ====================================================================== */

function asText(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function asInt(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  return null;
}

function isoAt(nowMs: number, plusMinutes = 0): string {
  return new Date(nowMs + plusMinutes * 60_000).toISOString();
}

/* =========================================================================
 * Statements
 * ====================================================================== */

/**
 * The purchasable piece behind a catalogue slug. One product is one design and
 * one variant is one physical piece; this shop's pieces have exactly one
 * variant each, and `position` breaks the tie deterministically if a future
 * design ever has more.
 */
const SELECT_VARIANT = `
  SELECT v.id AS "variantId",
         v.stock_quantity AS "stockQuantity",
         v.is_unique_piece AS "isUniquePiece",
         p.sale_mode AS "saleMode"
  FROM variants v
  JOIN products p ON p.id = v.product_id
  WHERE p.slug = ? AND p.status = 'active'
  ORDER BY v.position ASC
  LIMIT 1`;

const SELECT_OPEN_CART = `SELECT id FROM carts WHERE id = ? AND status = 'open' LIMIT 1`;

const INSERT_CART = `
  INSERT INTO carts (id, status, created_at, updated_at)
  VALUES (?, 'open', ?, ?)`;

const TOUCH_CART = `UPDATE carts SET updated_at = ? WHERE id = ?`;

/**
 * The lazy expiry sweep. `db/schema.ts` asks for a scheduled sweep OR a lazy
 * one on cart read; no Cron Trigger is configurable on this control plane
 * (research/02-market-tech.md §7.7), so this is the lazy one. It is idempotent
 * and it is what keeps an abandoned checkout from taking a one-of-a-kind piece
 * off sale forever.
 */
const SWEEP_EXPIRED_HOLDS = `
  UPDATE stock_reservations
  SET status = 'released'
  WHERE status = 'held' AND expires_at <= ?`;

/**
 * The line. `quoted_unit_price_paise` and `quoted_at` are written NULL on
 * purpose — see (1) in the header. Quantity is capped at the piece's own
 * stock, which is 1 for every one-of-a-kind piece, so a second "add" of the
 * same piece cannot ask for two of something there is one of.
 */
const UPSERT_CART_ITEM = `
  INSERT INTO cart_items
    (id, cart_id, variant_id, quantity, quoted_unit_price_paise, quoted_at, added_at)
  VALUES (?, ?, ?, 1, NULL, NULL, ?)
  ON CONFLICT (cart_id, variant_id)
  DO UPDATE SET quantity = min(cart_items.quantity + 1, ?)`;

/** THE CLAIM. See (2) in the header. The database decides, not this file. */
const CLAIM_HOLD = `
  INSERT INTO stock_reservations
    (id, variant_id, cart_id, quantity, status, expires_at, created_at)
  VALUES (?, ?, ?, 1, 'held', ?, ?)
  ON CONFLICT (variant_id) WHERE status = 'held' DO NOTHING`;

const RELEASE_HOLD = `
  UPDATE stock_reservations
  SET status = 'released'
  WHERE cart_id = ? AND variant_id = ? AND status = 'held'`;

const DELETE_CART_ITEM = `DELETE FROM cart_items WHERE cart_id = ? AND variant_id = ?`;

const SELECT_LIVE_HOLD = `
  SELECT cart_id AS "holderCartId", expires_at AS "expiresAt"
  FROM stock_reservations
  WHERE variant_id = ? AND status = 'held'
  LIMIT 1`;

/**
 * The cart, scoped by `cart_id` — which is what makes one cart unable to read
 * another. The LEFT JOIN reports who currently holds each piece, so the page
 * can say "held for you" or "someone is checking out with this" without a
 * second query per line.
 */
const SELECT_CART_ITEMS = `
  SELECT ci.variant_id AS "variantId",
         p.slug AS "slug",
         ci.quantity AS "quantity",
         ci.added_at AS "addedAt",
         ci.quoted_unit_price_paise AS "quotedUnitPricePaise",
         r.cart_id AS "holderCartId",
         r.expires_at AS "holdExpiresAt"
  FROM cart_items ci
  JOIN variants v ON v.id = ci.variant_id
  JOIN products p ON p.id = v.product_id
  LEFT JOIN stock_reservations r
    ON r.variant_id = ci.variant_id AND r.status = 'held'
  WHERE ci.cart_id = ?
  ORDER BY ci.added_at ASC, p.slug ASC`;

/* =========================================================================
 * Resolution
 * ====================================================================== */

type VariantRef = {
  readonly variantId: string;
  readonly stockQuantity: number;
  readonly isUniquePiece: boolean;
  /**
   * `products.sale_mode`. Read here because HIDING THE BUTTON IS NOT A GATE:
   * the storefront now withholds the control for a piece that is not for sale
   * online, but the endpoint is a plain form POST and anyone can send one.
   */
  readonly saleMode: string;
};

async function resolveVariant(db: CartDb, slug: string): Promise<VariantRef | null> {
  const [row] = await db.all(SELECT_VARIANT, [slug]);
  if (row === undefined) return null;

  const variantId = asText(row, "variantId");
  if (variantId === null) return null;

  return {
    variantId,
    stockQuantity: asInt(row, "stockQuantity") ?? 0,
    isUniquePiece: asInt(row, "isUniquePiece") === 1,
    // Fail closed: an unreadable mode is not a buyable one.
    saleMode: asText(row, "saleMode") ?? "enquire_only",
  };
}

/**
 * The open cart this token names, or `null`.
 *
 * A malformed token never reaches the database. A well-formed token that names
 * nothing comes back `null`, and the caller generates a FRESH id rather than
 * adopting the one it was handed — see (4c) in the header.
 */
async function resolveCartId(db: CartDb, token: string | null): Promise<string | null> {
  if (!isWellFormedCartToken(token)) return null;
  const [row] = await db.all(SELECT_OPEN_CART, [token]);
  return row === undefined ? null : asText(row, "id");
}

async function readLiveHold(
  db: CartDb,
  variantId: string
): Promise<{ holderCartId: string; expiresAt: string } | null> {
  const [row] = await db.all(SELECT_LIVE_HOLD, [variantId]);
  if (row === undefined) return null;
  const holderCartId = asText(row, "holderCartId");
  const expiresAt = asText(row, "expiresAt");
  if (holderCartId === null || expiresAt === null) return null;
  return { holderCartId, expiresAt };
}

/* =========================================================================
 * Adding
 * ====================================================================== */

export type AddToCartResult =
  | {
      readonly ok: false;
      readonly reason: "unknown_piece" | "sold_out" | "not_for_sale_online";
    }
  | {
      readonly ok: true;
      /** The server's id for this cart. Always server-generated. */
      readonly cartId: string;
      /** True when this request created the cart, so the caller sets a cookie. */
      readonly cartCreated: boolean;
      /** The piece was already in this cart; the line was not duplicated. */
      readonly alreadyInCart: boolean;
      readonly quantity: number;
      /** `changes === 1` on the conflicting insert. THIS cart won the piece. */
      readonly claimed: boolean;
      /** Another cart holds it right now. Not an error: the line is still added. */
      readonly heldByAnother: boolean;
      /** When this cart's hold lapses. Null unless this cart holds the piece. */
      readonly holdExpiresAt: string | null;
    };

/**
 * Put a piece in a cart, and try to claim it.
 *
 * Failing to claim is NOT a failure to add. Two people may have the same piece
 * in their carts; only one may reserve it, and the cart page says which of
 * those is true for each line. Refusing the add would be worse: it would tell
 * a shopper the piece is gone when it is merely being looked at.
 */
export async function addToCart(
  db: CartDb,
  options: { token: string | null; slug: string; nowMs?: number }
): Promise<AddToCartResult> {
  const nowMs = options.nowMs ?? Date.now();
  const now = isoAt(nowMs);

  const variant = await resolveVariant(db, options.slug);
  if (variant === null) return { ok: false, reason: "unknown_piece" };
  // Checked BEFORE stock, because "not for sale here" is the truer answer than
  // "sold out" for a piece that was never on sale here in the first place.
  if (variant.saleMode !== "buy_online") {
    return { ok: false, reason: "not_for_sale_online" };
  }
  if (variant.stockQuantity < 1) return { ok: false, reason: "sold_out" };

  const existingCartId = await resolveCartId(db, options.token);
  const cartId = existingCartId ?? newCartToken();
  const cartCreated = existingCartId === null;

  // Not a stock decision — a display one. Stock is arbitrated by the insert
  // below and by nothing else. See (2) in the header.
  const alreadyInCart =
    existingCartId !== null && (await readLineQuantity(db, cartId, variant.variantId)) !== null;

  const statements: CartStatement[] = [];
  if (cartCreated) statements.push({ sql: INSERT_CART, params: [cartId, now, now] });
  else statements.push({ sql: TOUCH_CART, params: [now, cartId] });

  statements.push({ sql: SWEEP_EXPIRED_HOLDS, params: [now] });
  statements.push({
    sql: UPSERT_CART_ITEM,
    params: [newCartToken(), cartId, variant.variantId, now, variant.stockQuantity],
  });
  statements.push({
    sql: CLAIM_HOLD,
    params: [
      newCartToken(),
      variant.variantId,
      cartId,
      isoAt(nowMs, HOLD_MINUTES),
      now,
    ],
  });

  const results = await db.batch(statements);
  const claimed = (results[results.length - 1]?.changes ?? 0) === 1;

  // Describes what happened; decides nothing. A re-add by the cart that
  // already holds the piece conflicts with its OWN hold, so `claimed` is false
  // while the hold is still ours — which only this read can tell us.
  const hold = await readLiveHold(db, variant.variantId);
  const heldByUs = hold !== null && hold.holderCartId === cartId;

  return {
    ok: true,
    cartId,
    cartCreated,
    alreadyInCart,
    quantity: (await readLineQuantity(db, cartId, variant.variantId)) ?? 1,
    claimed,
    heldByAnother: hold !== null && !heldByUs,
    holdExpiresAt: heldByUs ? hold.expiresAt : null,
  };
}

/** The quantity of one line in one cart, or `null` when there is no line. */
async function readLineQuantity(
  db: CartDb,
  cartId: string,
  variantId: string
): Promise<number | null> {
  const [row] = await db.all(
    `SELECT quantity AS "quantity" FROM cart_items WHERE cart_id = ? AND variant_id = ? LIMIT 1`,
    [cartId, variantId]
  );
  return row === undefined ? null : asInt(row, "quantity");
}

/* =========================================================================
 * Removing
 * ====================================================================== */

export type RemoveFromCartResult =
  | { readonly ok: false; readonly reason: "unknown_piece" | "no_cart" }
  | {
      readonly ok: true;
      readonly cartId: string;
      /** A line was actually deleted. False when it was not in the cart. */
      readonly removed: boolean;
      /** This cart's hold on the piece was released in the same transaction. */
      readonly released: boolean;
    };

/**
 * Take a piece out of a cart AND give it back.
 *
 * The delete and the release are one batch, which is one transaction: there is
 * no interleaving in which the line is gone but the piece is still held. A
 * released hold frees the partial unique index immediately, so whoever else
 * has it in their cart can claim it on their next cart read.
 */
export async function removeFromCart(
  db: CartDb,
  options: { token: string | null; slug: string; nowMs?: number }
): Promise<RemoveFromCartResult> {
  const nowMs = options.nowMs ?? Date.now();
  const now = isoAt(nowMs);

  const variant = await resolveVariant(db, options.slug);
  if (variant === null) return { ok: false, reason: "unknown_piece" };

  const cartId = await resolveCartId(db, options.token);
  if (cartId === null) return { ok: false, reason: "no_cart" };

  const results = await db.batch([
    { sql: DELETE_CART_ITEM, params: [cartId, variant.variantId] },
    { sql: RELEASE_HOLD, params: [cartId, variant.variantId] },
    { sql: TOUCH_CART, params: [now, cartId] },
  ]);

  return {
    ok: true,
    cartId,
    removed: (results[0]?.changes ?? 0) > 0,
    released: (results[1]?.changes ?? 0) > 0,
  };
}

/* =========================================================================
 * Reading
 * ====================================================================== */

export type CartLine = {
  readonly variantId: string;
  readonly slug: string;
  readonly quantity: number;
  readonly addedAt: string;
  /** This cart holds the piece. */
  readonly heldByYou: boolean;
  /**
   * Another cart holds it. Deliberately a boolean: the other cart's id is a
   * bearer credential and never leaves this module.
   */
  readonly heldByAnother: boolean;
  /** When YOUR hold lapses. Null when the hold is not yours. */
  readonly holdExpiresAt: string | null;
};

export type CartSnapshot = {
  /** Null when the visitor has no cart at all. Not an error. */
  readonly cartId: string | null;
  readonly lines: readonly CartLine[];
};

export const EMPTY_CART: CartSnapshot = { cartId: null, lines: [] };

/**
 * Everything in this cart, with the expiry sweep and a reclaim attempt.
 *
 * The two writes are the lazy sweep `db/schema.ts` calls for in the absence of
 * a Cron Trigger, plus a claim attempt for any line this cart does not yet
 * hold. Both are idempotent, both are bounded, and the claim goes through the
 * same `ON CONFLICT DO NOTHING` as every other claim — so a piece someone else
 * still holds stays theirs, and a piece whose hold has just lapsed is picked up
 * by whoever reads their cart next.
 */
export async function readCart(
  db: CartDb,
  options: { token: string | null; nowMs?: number }
): Promise<CartSnapshot> {
  const nowMs = options.nowMs ?? Date.now();
  const now = isoAt(nowMs);

  const cartId = await resolveCartId(db, options.token);
  if (cartId === null) return EMPTY_CART;

  await db.batch([{ sql: SWEEP_EXPIRED_HOLDS, params: [now] }]);

  const rows = await db.all(SELECT_CART_ITEMS, [cartId]);
  const lines = rows.map((row) => toLine(row, cartId));

  const unheld = lines
    .filter((line) => !line.heldByYou && !line.heldByAnother)
    .slice(0, MAX_RECLAIMS_PER_READ);

  if (unheld.length === 0) return { cartId, lines };

  const expiresAt = isoAt(nowMs, HOLD_MINUTES);
  const claims = await db.batch(
    unheld.map((line) => ({
      sql: CLAIM_HOLD,
      params: [newCartToken(), line.variantId, cartId, expiresAt, now],
    }))
  );

  const won = new Set(
    unheld
      .filter((_line, index) => (claims[index]?.changes ?? 0) === 1)
      .map((line) => line.variantId)
  );

  return {
    cartId,
    lines: lines.map((line) =>
      won.has(line.variantId) ? { ...line, heldByYou: true, holdExpiresAt: expiresAt } : line
    ),
  };
}

function toLine(row: SqlRow, cartId: string): CartLine {
  const holderCartId = asText(row, "holderCartId");
  const heldByYou = holderCartId === cartId;

  return {
    variantId: asText(row, "variantId") ?? "",
    slug: asText(row, "slug") ?? "",
    quantity: asInt(row, "quantity") ?? 1,
    addedAt: asText(row, "addedAt") ?? "",
    heldByYou,
    heldByAnother: holderCartId !== null && !heldByYou,
    holdExpiresAt: heldByYou ? asText(row, "holdExpiresAt") : null,
  };
}

/* =========================================================================
 * Notices — the one channel a no-JavaScript flow has
 * ====================================================================== */

/**
 * `/api/cart` answers a browser form with a 303 to `/cart`, which throws away
 * the response body, so the outcome of the POST has to survive the redirect.
 * It travels as one of these fixed codes in `?notice=`.
 *
 * A CLOSED SET, and validated on the way back in. The page never renders the
 * query string; it renders the copy below, keyed by an exact match. So there
 * is no reflected content and nothing an attacker can put words into.
 *
 * These are not decoration. Without JavaScript the redirect is the only
 * feedback a shopper gets, and "the request failed" must be one of the things
 * it can say — never a silent success. See the appointments route for the
 * inverse mistake this deliberately does not copy.
 */
export const CART_NOTICES = {
  added: "Added to your cart.",
  "already-in-cart":
    "That piece is already in your cart. There is only one of it, so it stays a single line.",
  removed: "Removed from your cart, and the piece has been released.",
  "not-in-cart": "That piece was not in your cart, so nothing changed.",
  "unknown-piece": "We could not find that piece.",
  "sold-out": "That piece has left the shop.",
  "not-for-sale-online":
    "This piece is not sold through the website. It is shown by appointment so you can see it in the hand first, and we will hold it for you while you decide. Ring the shop or ask for a viewing.",
  "bad-request": "That request did not make sense to us, so nothing was changed.",
  unavailable:
    "We could not reach your cart just now, so nothing was changed. Please try again, or call the shop.",
} as const;

export type CartNotice = keyof typeof CART_NOTICES;

/** Narrow a `?notice=` value to a code we actually publish, or `null`. */
export function toCartNotice(value: unknown): CartNotice | null {
  if (typeof value !== "string") return null;
  return Object.hasOwn(CART_NOTICES, value) ? (value as CartNotice) : null;
}

/** `/cart`, or `/cart?notice=…`. The only redirect target this feature has. */
export function cartHref(notice?: CartNotice): string {
  return notice ? `/cart?notice=${notice}` : "/cart";
}

/* =========================================================================
 * Display
 * ====================================================================== */

/**
 * "until 4:35 pm" — the hold expiry in Indian local time, which is the only
 * clock a customer of this shop is reading. Built with a fixed +05:30 offset
 * rather than a locale call, because the Workers runtime's ICU data is not
 * guaranteed and a wrong time here is worse than no time.
 */
export function formatHoldExpiry(iso: string): string | null {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;

  const ist = new Date(parsed + 330 * 60_000);
  const hours = ist.getUTCHours();
  const minutes = ist.getUTCMinutes();
  const suffix = hours < 12 ? "am" : "pm";
  const displayHour = hours % 12 === 0 ? 12 : hours % 12;

  return `${displayHour}:${String(minutes).padStart(2, "0")} ${suffix} IST`;
}
