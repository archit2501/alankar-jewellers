/**
 * THE CART: the data layer, the endpoint, and the page at /cart.
 *
 * ===========================================================================
 * THE ONE THING THAT IS NOT MOCKED
 * ===========================================================================
 * The reservation race is the whole reason `stock_reservations` exists, and it
 * is arbitrated by a PARTIAL UNIQUE INDEX inside SQLite — not by application
 * code. A test that stubbed the claim and asserted "the second caller was told
 * no" would prove nothing except that the stub returns what it was told to.
 *
 * So every test below runs against a REAL SQLite database built from this
 * project's own migration (`drizzle/*.sql`), seeded with this project's own
 * seed, through the SAME `d1CartDb()` adapter production uses. The index that
 * decides the race is the real one, the `ON CONFLICT (variant_id) WHERE
 * status = 'held' DO NOTHING` is the real statement, and `changes` comes back
 * from SQLite. One test additionally asserts the raw, unguarded insert THROWS
 * a UNIQUE constraint error — that is what proves the database is the arbiter
 * rather than the code being polite.
 *
 * Nothing here touches `.wrangler`, D1, or the network. The database is
 * `:memory:`.
 *
 * ===========================================================================
 * FOUR KINDS OF TEST
 * ===========================================================================
 *  1. THE TOKEN, pure. A cart token is a bearer credential; its validation
 *     must not need a database and must reject before one is reached.
 *  2. THE DATA LAYER, against the real schema. Adding, re-adding, removing,
 *     the race, release, expiry, isolation, and the invariant that no price is
 *     ever written to a cart line.
 *  3. THE ENDPOINT, driven through the built Worker with the same SQLite
 *     database injected as `env.DB`. This is where cookie behaviour, the
 *     no-JavaScript form flow and the "no fake success" rule are proved.
 *  4. THE RENDERED PAGE.
 *
 * `scripts/seed-catalogue.mjs` is imported before the data layer because it
 * registers the module hooks that let plain Node resolve the TypeScript module
 * graph (`../../db` -> `db/index.ts`, `cloudflare:workers` -> the test stub).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { env } from "cloudflare:workers";

import { buildSeedSql } from "../scripts/seed-catalogue.mjs";
import { fetchWorker, renderPage } from "./helpers.mjs";

const {
  CART_COOKIE,
  HOLD_MINUTES,
  addToCart,
  cartCookieHeader,
  cartHref,
  d1CartDb,
  formatHoldExpiry,
  isWellFormedCartToken,
  newCartToken,
  readCart,
  readCartTokenFromCookieHeader,
  removeFromCart,
  toCartNotice,
} = await import("../app/_data/cart.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* =========================================================================
 * A D1-shaped client over node:sqlite
 *
 * This is TEST INFRASTRUCTURE, not a stand-in for the guarantees under test.
 * It translates the D1 client surface (`prepare().bind().run()/all()/raw()`
 * and `batch()`) onto a real SQLite database, and nothing more:
 *
 *   - `meta.changes` is SQLite's own change count, which is what the claim
 *     path checks. It is never synthesised.
 *   - `batch()` is BEGIN/COMMIT with a ROLLBACK on throw, which is D1's
 *     "one batch is one transaction". Every statement in it runs
 *     synchronously, so nothing can interleave inside a transaction.
 *
 * Miniflare's own D1 is SQLite too, so this is the same engine the local
 * development database runs on.
 * ====================================================================== */

/** node:sqlite binds null/number/string/bigint only. */
function toBindable(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

const READS = /^\s*(?:select|pragma|with)\b/i;

function makeStatement(sqlite, sql, params) {
  const execute = () => {
    const bound = params.map(toBindable);
    const prepared = sqlite.prepare(sql);

    if (READS.test(sql) || /\breturning\b/i.test(sql)) {
      const results = prepared.all(...bound);
      return { results, success: true, meta: { changes: 0, rows_read: results.length } };
    }

    const info = prepared.run(...bound);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        rows_written: Number(info.changes),
      },
    };
  };

  return {
    execute,
    bind: (...next) => makeStatement(sqlite, sql, next),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => execute().results.map((row) => Object.values(row)),
    first: async (column) => {
      const [row] = execute().results;
      if (row === undefined) return null;
      return column === undefined ? row : (row[column] ?? null);
    },
  };
}

function d1Over(sqlite) {
  return {
    prepare: (sql) => makeStatement(sqlite, sql, []),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        // Synchronous on purpose: an await in here would let another request
        // interleave inside the transaction, which D1 does not do.
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/* =========================================================================
 * The database, built from the project's own migration and seed
 * ====================================================================== */

function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const dir = path.join(ROOT, "drizzle");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no migration to test the cart against");

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }

  sqlite.exec("BEGIN");
  for (const statement of buildSeedSql({ now: "2026-08-09T00:00:00.000Z" })) {
    sqlite.exec(statement);
  }
  sqlite.exec("COMMIT");

  return sqlite;
}

/** A fresh database, and the production adapter over it. */
function freshCart() {
  const sqlite = migratedDatabase();
  return { sqlite, db: d1CartDb(d1Over(sqlite)) };
}

const HAAR = "jadau-haar";
const CHOKER = "polki-choker";
const HAAR_VARIANT = "var_jadau-haar";

function count(sqlite, sql, ...params) {
  return sqlite.prepare(sql).get(...params).c;
}

/* =========================================================================
 * 1. The token — a bearer credential, validated before any query
 * ====================================================================== */

test("a cart token is a random UUID and nothing else is accepted", () => {
  const token = newCartToken();
  assert.equal(token.length, 36);
  assert.ok(isWellFormedCartToken(token));

  for (const forged of [
    "",
    "cart-1",
    "1",
    "00000000-0000-0000-0000-000000000000", // version nibble is not 4
    "3f7c1d2e-8a4b-1c9d-9e6f-1a2b3c4d5e6f", // v1, not v4
    `${newCartToken()}x`,
    newCartToken().slice(0, 35),
    newCartToken().toUpperCase(),
    "' OR 1=1 --",
    "../../etc/passwd",
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(isWellFormedCartToken(forged), false, `accepted ${String(forged)}`);
  }
});

test("two tokens generated back to back never collide", () => {
  const tokens = new Set();
  for (let index = 0; index < 500; index += 1) tokens.add(newCartToken());
  assert.equal(tokens.size, 500);
});

test("the cookie is HttpOnly, Secure and SameSite=Lax", () => {
  const header = cartCookieHeader(newCartToken());
  assert.match(header, /^aj_cart=[0-9a-f-]{36}; /);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
});

test("the token is read out of a cookie header, and only when well formed", () => {
  const token = newCartToken();
  assert.equal(
    readCartTokenFromCookieHeader(`theme=dark; ${CART_COOKIE}=${token}; other=1`),
    token
  );
  assert.equal(readCartTokenFromCookieHeader(`${CART_COOKIE}=${token}`), token);
  assert.equal(readCartTokenFromCookieHeader(null), null);
  assert.equal(readCartTokenFromCookieHeader(""), null);
  assert.equal(readCartTokenFromCookieHeader("theme=dark"), null);
  assert.equal(readCartTokenFromCookieHeader(`${CART_COOKIE}=not-a-uuid`), null);
  assert.equal(readCartTokenFromCookieHeader(`${CART_COOKIE}=' OR 1=1 --`), null);
});

test("only notice codes the shop publishes survive the round trip", () => {
  assert.equal(toCartNotice("added"), "added");
  assert.equal(toCartNotice("unavailable"), "unavailable");
  assert.equal(toCartNotice("<script>alert(1)</script>"), null);
  assert.equal(toCartNotice("toString"), null);
  assert.equal(toCartNotice("constructor"), null);
  assert.equal(toCartNotice(undefined), null);
  assert.equal(cartHref(), "/cart");
  assert.equal(cartHref("added"), "/cart?notice=added");
});

/* =========================================================================
 * 2. The data layer, against the real schema
 * ====================================================================== */

test("adding a piece creates a cart, a line, and a hold", async () => {
  const { sqlite, db } = freshCart();

  const result = await addToCart(db, { token: null, slug: HAAR });

  assert.equal(result.ok, true);
  assert.equal(result.cartCreated, true);
  assert.equal(result.alreadyInCart, false);
  assert.equal(result.quantity, 1);
  assert.equal(result.claimed, true);
  assert.equal(result.heldByAnother, false);
  assert.ok(isWellFormedCartToken(result.cartId));

  assert.equal(count(sqlite, "SELECT count(*) AS c FROM carts"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM cart_items"), 1);
  assert.equal(
    count(sqlite, "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held'"),
    1
  );

  const line = sqlite.prepare("SELECT * FROM cart_items").get();
  assert.equal(line.cart_id, result.cartId);
  assert.equal(line.variant_id, HAAR_VARIANT);
  assert.equal(line.quantity, 1);
});

test("NO PRICE IS EVER WRITTEN TO A CART LINE", async () => {
  const { sqlite, db } = freshCart();

  const first = await addToCart(db, { token: null, slug: HAAR });
  await addToCart(db, { token: first.cartId, slug: HAAR });
  await addToCart(db, { token: first.cartId, slug: CHOKER });
  await readCart(db, { token: first.cartId });

  const lines = sqlite.prepare("SELECT * FROM cart_items").all();
  assert.equal(lines.length, 2);
  for (const line of lines) {
    // `quoted_unit_price_paise` exists in the schema for a "the rate has moved
    // since you added this" disclosure only, and NOTHING may read it to compute
    // money. Today nothing writes it either — the cart is intent, and the price
    // is resolved at render time and again at order time.
    assert.equal(line.quoted_unit_price_paise, null, "a price was snapshotted into the cart");
    assert.equal(line.quoted_at, null, "a quote time was snapshotted into the cart");
  }

  // And the table carries no other money column that could be filled in later.
  const columns = sqlite
    .prepare("PRAGMA table_info(cart_items)")
    .all()
    .map((column) => column.name);
  assert.deepEqual(columns.filter((name) => name.includes("paise")), [
    "quoted_unit_price_paise",
  ]);
});

test("adding the same piece twice leaves one line, not two and not a quantity of two", async () => {
  const { sqlite, db } = freshCart();

  const first = await addToCart(db, { token: null, slug: HAAR });
  const second = await addToCart(db, { token: first.cartId, slug: HAAR });

  assert.equal(second.ok, true);
  assert.equal(second.cartId, first.cartId, "a second add started a new cart");
  assert.equal(second.cartCreated, false);
  assert.equal(second.alreadyInCart, true);
  // stock_quantity is 1 for a one-of-a-kind piece, so the upsert's cap holds.
  assert.equal(second.quantity, 1);

  assert.equal(count(sqlite, "SELECT count(*) AS c FROM cart_items"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM carts"), 1);
  // Re-adding conflicts with our OWN hold, so nothing new is claimed — but the
  // piece is still ours, and the result says so rather than reporting a loss.
  assert.equal(second.claimed, false);
  assert.equal(second.heldByAnother, false);
  assert.ok(second.holdExpiresAt !== null, "we stopped holding a piece we still hold");
  assert.equal(
    count(sqlite, "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held'"),
    1
  );
});

test("removing a piece deletes the line and releases the hold, in one transaction", async () => {
  const { sqlite, db } = freshCart();

  const added = await addToCart(db, { token: null, slug: HAAR });
  const removed = await removeFromCart(db, { token: added.cartId, slug: HAAR });

  assert.equal(removed.ok, true);
  assert.equal(removed.removed, true);
  assert.equal(removed.released, true);

  assert.equal(count(sqlite, "SELECT count(*) AS c FROM cart_items"), 0);
  assert.equal(
    count(sqlite, "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held'"),
    0
  );
  // The reservation row survives as an audit trail; only its status changes.
  assert.equal(
    count(sqlite, "SELECT count(*) AS c FROM stock_reservations WHERE status = 'released'"),
    1
  );

  // A second remove is not an error and is not a fake success: it reports that
  // nothing was deleted.
  const again = await removeFromCart(db, { token: added.cartId, slug: HAAR });
  assert.equal(again.ok, true);
  assert.equal(again.removed, false);
  assert.equal(again.released, false);
});

/* --- The race ------------------------------------------------------------ */

test("THE RACE: two carts claim one unique piece and exactly one wins", async () => {
  const { sqlite, db } = freshCart();

  // Both shoppers arrive with no cart, and both go for the same piece.
  const [a, b] = await Promise.all([
    addToCart(db, { token: null, slug: HAAR }),
    addToCart(db, { token: null, slug: HAAR }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.cartId, b.cartId);

  // BOTH have it in their cart. That is normal and is allowed.
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM cart_items"), 2);

  // Exactly one HOLDS it, and the winner was picked by SQLite: `claimed` is
  // `changes === 1` on the ON CONFLICT insert, nothing else.
  assert.equal([a.claimed, b.claimed].filter(Boolean).length, 1);
  assert.equal(
    count(
      sqlite,
      "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held' AND variant_id = ?",
      HAAR_VARIANT
    ),
    1
  );

  const loser = a.claimed ? b : a;
  assert.equal(loser.heldByAnother, true);
  assert.equal(loser.holdExpiresAt, null);
});

test("THE ARBITER IS THE DATABASE: a second live hold cannot be inserted at all", () => {
  const { sqlite } = freshCart();

  const insert = (id) =>
    sqlite
      .prepare(
        `INSERT INTO stock_reservations (id, variant_id, cart_id, quantity, status, expires_at)
         VALUES (?, ?, ?, 1, 'held', '2999-01-01T00:00:00.000Z')`
      )
      .run(id, HAAR_VARIANT, "cart-one");

  sqlite
    .prepare("INSERT INTO carts (id, status) VALUES ('cart-one', 'open')")
    .run();

  insert("hold-one");

  // No ON CONFLICT clause: the partial unique index refuses it outright. This
  // is the guarantee the claim path relies on, asserted directly rather than
  // inferred from the claim path's own return value.
  assert.throws(() => insert("hold-two"), /UNIQUE constraint failed/);

  // And the index really is PARTIAL: once the first hold is no longer 'held',
  // the same variant may be held again.
  sqlite.prepare("UPDATE stock_reservations SET status = 'released' WHERE id = 'hold-one'").run();
  assert.doesNotThrow(() => insert("hold-three"));
});

test("a released piece is picked up by whoever else has it in their cart", async () => {
  const { sqlite, db } = freshCart();

  const winner = await addToCart(db, { token: null, slug: HAAR });
  const waiter = await addToCart(db, { token: null, slug: HAAR });
  assert.equal(winner.claimed, true);
  assert.equal(waiter.claimed, false);

  // The winner changes their mind. The release happens in the same transaction
  // as the delete, so there is no window in which the line is gone and the
  // piece is still locked away.
  await removeFromCart(db, { token: winner.cartId, slug: HAAR });

  const snapshot = await readCart(db, { token: waiter.cartId });
  assert.equal(snapshot.lines.length, 1);
  assert.equal(snapshot.lines[0].heldByYou, true);
  assert.equal(snapshot.lines[0].heldByAnother, false);
  assert.ok(snapshot.lines[0].holdExpiresAt !== null);

  assert.equal(
    count(
      sqlite,
      "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held' AND variant_id = ?",
      HAAR_VARIANT
    ),
    1
  );
});

test("an expired hold is swept on read and the piece becomes claimable again", async () => {
  const { sqlite, db } = freshCart();

  const start = Date.parse("2026-08-09T10:00:00.000Z");
  const winner = await addToCart(db, { token: null, slug: HAAR, nowMs: start });
  const waiter = await addToCart(db, { token: null, slug: HAAR, nowMs: start });
  assert.equal(winner.claimed, true);
  assert.equal(waiter.claimed, false);

  // Still inside the window: nothing moves.
  const early = await readCart(db, {
    token: waiter.cartId,
    nowMs: start + (HOLD_MINUTES - 1) * 60_000,
  });
  assert.equal(early.lines[0].heldByAnother, true);

  // Past it: the lazy sweep releases the stale hold and the waiter claims it.
  const late = await readCart(db, {
    token: waiter.cartId,
    nowMs: start + (HOLD_MINUTES + 1) * 60_000,
  });
  assert.equal(late.lines[0].heldByYou, true);

  assert.equal(
    count(
      sqlite,
      "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held' AND cart_id = ?",
      waiter.cartId
    ),
    1
  );
  assert.equal(
    count(
      sqlite,
      "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held' AND cart_id = ?",
      winner.cartId
    ),
    0
  );
});

/* --- Identity ------------------------------------------------------------ */

test("one cart cannot read another cart", async () => {
  const { db } = freshCart();

  const mine = await addToCart(db, { token: null, slug: HAAR });
  const theirs = await addToCart(db, { token: null, slug: CHOKER });

  const minesnapshot = await readCart(db, { token: mine.cartId });
  const theirsSnapshot = await readCart(db, { token: theirs.cartId });

  assert.deepEqual(
    minesnapshot.lines.map((line) => line.slug),
    [HAAR]
  );
  assert.deepEqual(
    theirsSnapshot.lines.map((line) => line.slug),
    [CHOKER]
  );

  // And one cart cannot remove out of another.
  const attempt = await removeFromCart(db, { token: mine.cartId, slug: CHOKER });
  assert.equal(attempt.ok, true);
  assert.equal(attempt.removed, false);
  assert.equal((await readCart(db, { token: theirs.cartId })).lines.length, 1);
});

test("a forged token is never adopted as a cart id", async () => {
  const { sqlite, db } = freshCart();

  // Well formed, but it names nothing. An attacker planting this in a victim's
  // browser must not end up sharing the victim's cart.
  const forged = newCartToken();
  const result = await addToCart(db, { token: forged, slug: HAAR });

  assert.equal(result.ok, true);
  assert.equal(result.cartCreated, true);
  assert.notEqual(result.cartId, forged, "the server adopted a caller-chosen cart id");
  assert.equal(
    count(sqlite, "SELECT count(*) AS c FROM carts WHERE id = ?", forged),
    0,
    "a caller-chosen id was written into carts"
  );

  // The forged token still reads as an empty cart, so the attacker sees nothing.
  assert.deepEqual(await readCart(db, { token: forged }), { cartId: null, lines: [] });
});

test("a malformed token never reaches a query and never creates that cart", async () => {
  const { sqlite, db } = freshCart();

  for (const malformed of ["", "not-a-uuid", "' OR 1=1 --", "../../etc/passwd"]) {
    const snapshot = await readCart(db, { token: malformed });
    assert.deepEqual(snapshot, { cartId: null, lines: [] });

    const result = await addToCart(db, { token: malformed, slug: HAAR });
    assert.equal(result.ok, true);
    assert.ok(isWellFormedCartToken(result.cartId));
    assert.equal(count(sqlite, "SELECT count(*) AS c FROM carts WHERE id = ?", malformed), 0);
  }
});

test("an unknown slug is refused rather than written", async () => {
  const { sqlite, db } = freshCart();

  const result = await addToCart(db, { token: null, slug: "a-piece-that-does-not-exist" });
  assert.deepEqual(result, { ok: false, reason: "unknown_piece" });
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM carts"), 0);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM cart_items"), 0);
});

test("a sold piece cannot be added", async () => {
  const { sqlite, db } = freshCart();
  sqlite.prepare("UPDATE variants SET stock_quantity = 0 WHERE id = ?").run(HAAR_VARIANT);

  const result = await addToCart(db, { token: null, slug: HAAR });
  assert.deepEqual(result, { ok: false, reason: "sold_out" });
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM cart_items"), 0);
});

test("the hold expiry is rendered in IST, or not at all", () => {
  assert.equal(formatHoldExpiry("2026-08-09T11:05:00.000Z"), "4:35 pm IST");
  assert.equal(formatHoldExpiry("2026-08-09T02:00:00.000Z"), "7:30 am IST");
  assert.equal(formatHoldExpiry("2026-08-09T06:30:00.000Z"), "12:00 pm IST");
  assert.equal(formatHoldExpiry("not a date"), null);
});

/* =========================================================================
 * 3. The endpoint, through the built Worker
 * ====================================================================== */

let worker;

before(() => {
  worker = migratedDatabase();
  // The built bundle reaches `env.DB` through db/index.ts and app/_data/cart.ts.
  // Injecting the same SQLite database means the route, the catalogue layer and
  // the page all read one consistent store.
  env.DB = d1Over(worker);
});

/**
 * Every endpoint test starts from an empty shop floor. A hold left behind by
 * the previous test would silently change who wins the next one — which is
 * exactly the bug this feature exists to prevent, and not something a test
 * should be quietly reproducing. `carts` cascades to `cart_items` and
 * `stock_reservations`, so one delete clears all three.
 */
beforeEach(() => {
  worker?.exec("DELETE FROM carts");
});

after(() => {
  delete env.DB;
  worker?.close();
});

function setCookieOf(response) {
  const all = response.headers.getSetCookie?.() ?? [];
  if (all.length > 0) return all[0];
  return response.headers.get("set-cookie");
}

function tokenOf(response) {
  const header = setCookieOf(response);
  if (!header) return null;
  const match = header.match(/aj_cart=([^;]+)/);
  return match ? match[1] : null;
}

async function post(body, { cookie, form = false } = {}) {
  const headers = form
    ? { "Content-Type": "application/x-www-form-urlencoded" }
    : { "Content-Type": "application/json" };
  if (cookie) headers.cookie = `${CART_COOKIE}=${cookie}`;

  const response = await fetchWorker("/api/cart", {
    method: "POST",
    headers,
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    redirect: "manual",
  });

  let parsed = null;
  if ((response.headers.get("content-type") ?? "").includes("json")) {
    parsed = await response.json();
  }
  return { response, body: parsed, token: tokenOf(response) };
}

test("POST adds a piece, issues a cart cookie, and returns no price", async () => {
  const { response, body, token } = await post({ action: "add", slug: HAAR });

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.alreadyInCart, false);
  assert.equal(body.held, true);
  assert.equal(body.cart.itemCount, 1);

  const cookie = setCookieOf(response);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.ok(isWellFormedCartToken(token));

  // The cart has no price to give, so the response has none to leak.
  const serialised = JSON.stringify(body);
  assert.doesNotMatch(serialised, /paise/i);
  assert.doesNotMatch(serialised, /price/i);
});

test("POSTing the same piece twice says so instead of pretending", async () => {
  const first = await post({ action: "add", slug: CHOKER });
  assert.equal(first.response.status, 201);

  const second = await post({ action: "add", slug: CHOKER }, { cookie: first.token });

  // NOT a fabricated 201. The appointments route answers a repeat submission
  // with a fake success; a customer re-adding a piece must be told the truth.
  assert.equal(second.response.status, 200);
  assert.equal(second.body.ok, true);
  assert.equal(second.body.alreadyInCart, true);
  assert.equal(second.body.cart.itemCount, 1);
});

test("a second, different piece is added rather than throttled away", async () => {
  const first = await post({ action: "add", slug: "kundan-kada" });
  const second = await post(
    { action: "add", slug: "maang-tikka" },
    { cookie: first.token }
  );

  assert.equal(second.response.status, 201);
  assert.equal(second.body.cart.itemCount, 2);
});

test("GET returns this cart and only this cart, and mints nothing", async () => {
  const mine = await post({ action: "add", slug: "chandbali-earrings" });

  const response = await fetchWorker("/api/cart", {
    headers: { cookie: `${CART_COOKIE}=${mine.token}` },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(
    body.cart.items.map((item) => item.slug),
    ["chandbali-earrings"]
  );
  // A read must not create a cart, or a crawler mints one per request.
  assert.equal(setCookieOf(response), null);

  const stranger = await fetchWorker("/api/cart", {
    headers: { cookie: `${CART_COOKIE}=${newCartToken()}` },
  });
  assert.deepEqual((await stranger.json()).cart.items, []);
});

test("a forged cookie is replaced with a server-issued one, not honoured", async () => {
  const forged = newCartToken();
  const { response, token } = await post({ action: "add", slug: HAAR }, { cookie: forged });

  assert.equal(response.status, 201);
  assert.notEqual(token, forged);
  assert.ok(isWellFormedCartToken(token));

  // The forged token still names nothing.
  const probe = await fetchWorker("/api/cart", {
    headers: { cookie: `${CART_COOKIE}=${forged}` },
  });
  assert.deepEqual((await probe.json()).cart.items, []);
});

test("a malformed cookie is ignored rather than becoming a cart", async () => {
  const { response, token } = await post(
    { action: "add", slug: HAAR },
    { cookie: "' OR 1=1 --" }
  );

  assert.equal(response.status, 201);
  assert.ok(isWellFormedCartToken(token));
  assert.equal(count(worker, "SELECT count(*) AS c FROM carts WHERE id = ?", "' OR 1=1 --"), 0);
});

test("a browser form is answered with a redirect, and the outcome survives it", async () => {
  const added = await post({ action: "add", slug: HAAR }, { form: true });
  assert.equal(added.response.status, 303);
  assert.equal(added.response.headers.get("location"), "/cart?notice=added");
  assert.ok(isWellFormedCartToken(added.token));

  const again = await post(
    { action: "add", slug: HAAR },
    { form: true, cookie: added.token }
  );
  assert.equal(again.response.headers.get("location"), "/cart?notice=already-in-cart");

  const removed = await post(
    { action: "remove", slug: HAAR },
    { form: true, cookie: added.token }
  );
  assert.equal(removed.response.status, 303);
  assert.equal(removed.response.headers.get("location"), "/cart?notice=removed");

  const noop = await post(
    { action: "remove", slug: HAAR },
    { form: true, cookie: added.token }
  );
  // Nothing was removed, and the redirect says exactly that.
  assert.equal(noop.response.headers.get("location"), "/cart?notice=not-in-cart");
});

test("a removal through the endpoint releases the reservation", async () => {
  const added = await post({ action: "add", slug: "kundan-kada" });
  const variant = "var_kundan-kada";
  assert.equal(
    count(
      worker,
      "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held' AND variant_id = ?",
      variant
    ),
    1
  );

  const removed = await post(
    { action: "remove", slug: "kundan-kada" },
    { cookie: added.token }
  );
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.removed, true);
  assert.equal(removed.body.released, true);
  assert.equal(
    count(
      worker,
      "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held' AND variant_id = ?",
      variant
    ),
    0
  );
});

test("bad input is refused, and refused specifically", async () => {
  const unknown = await post({ action: "add", slug: "no-such-piece" });
  assert.equal(unknown.response.status, 404);
  assert.equal(unknown.body.ok, false);

  const badAction = await post({ action: "empty", slug: HAAR });
  assert.equal(badAction.response.status, 400);
  assert.equal(badAction.body.ok, false);

  const badSlug = await post({ action: "add", slug: "../../etc/passwd" });
  assert.equal(badSlug.response.status, 400);

  const notJson = await fetchWorker("/api/cart", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{",
  });
  assert.equal(notJson.status, 400);
});

test("a cross-site POST cannot swap a shopper's cart out from under them", async () => {
  const foreign = await fetchWorker("/api/cart", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      origin: "https://not-alankar.example",
      host: "localhost",
    },
    body: new URLSearchParams({ action: "add", slug: HAAR }).toString(),
  });

  assert.equal(foreign.headers.get("location"), "/cart?notice=bad-request");
  assert.equal(setCookieOf(foreign), null, "a cross-site POST was issued a cart cookie");
  assert.equal(count(worker, "SELECT count(*) AS c FROM carts"), 0);

  // The same request from this site is fine.
  const own = await fetchWorker("/api/cart", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      origin: "http://localhost",
      host: "localhost",
    },
    body: JSON.stringify({ action: "add", slug: HAAR }),
  });
  assert.equal(own.status, 201);
});

test("NO FAKE SUCCESS: an unreachable store is reported, never answered 201", async () => {
  const saved = env.DB;
  delete env.DB;

  try {
    const { response, body } = await post({ action: "add", slug: HAAR });
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.match(body.error, /nothing was changed/i);

    // And the form flow does not silently claim it worked either.
    const form = await post({ action: "add", slug: HAAR }, { form: true });
    assert.equal(form.response.headers.get("location"), "/cart?notice=unavailable");

    const read = await fetchWorker("/api/cart");
    assert.equal(read.status, 503);
  } finally {
    env.DB = saved;
  }
});

/* =========================================================================
 * 4. The rendered page
 * ====================================================================== */

async function cartHtml(cookie, query = "") {
  const response = await fetchWorker(`/cart${query}`, {
    headers: { accept: "text/html", ...(cookie ? { cookie: `${CART_COOKIE}=${cookie}` } : {}) },
  });
  return response.text();
}

test("an empty cart is an invitation, with exactly one h1", async () => {
  const body = await cartHtml(null);

  assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.ok(body.includes("Set aside for you."));
  assert.ok(body.includes("Nothing set aside yet."));
  assert.ok(body.includes("See every piece"));
  assert.ok(body.includes("/shop"));
});

test("a piece in the cart renders on request, with no zero and no total", async () => {
  const added = await post({ action: "add", slug: HAAR });
  const body = await cartHtml(added.token);

  assert.ok(body.includes("Jadau haar"));
  assert.ok(body.includes("Price on request"));
  assert.ok(body.includes("Not quoted"));

  // The whole point. Every seeded piece is `on_request`, so there is no figure
  // to show — and a zero, or a rupee sign with nothing behind it, would be a
  // claim about the price of a piece nobody has weighed.
  assert.doesNotMatch(body, /₹\s*0\b/);
  assert.doesNotMatch(body, /₹0/);
  assert.doesNotMatch(body, /Rs\.?\s*0\b/);

  assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1);
});

test("the cart never renders the cart token", async () => {
  const added = await post({ action: "add", slug: CHOKER });
  const body = await cartHtml(added.token);

  // The token is a bearer credential. It travels in an HttpOnly cookie and it
  // must not be reachable from the DOM, a copied URL or a screenshot.
  assert.ok(!body.includes(added.token), "the cart token was rendered into the page");
  assert.ok(!body.includes("aj_cart"));
});

test("every image on the cart declares intrinsic dimensions and a srcset", async () => {
  const added = await post({ action: "add", slug: "maang-tikka" });
  const body = await cartHtml(added.token);

  const tags = body.match(/<img\b[^>]*>/g) ?? [];
  assert.ok(tags.length > 0, "the cart rendered no imagery at all");
  for (const tag of tags) {
    assert.match(tag, /\swidth="\d+"/, tag);
    assert.match(tag, /\sheight="\d+"/, tag);
    assert.match(tag, /\ssrcSet="|\ssrcset="/, tag);
    assert.match(tag, /\salt="[^"]+"/, tag);
  }
});

test("the hold state is stated on the page", async () => {
  const added = await post({ action: "add", slug: "chandbali-earrings" });
  const mine = await cartHtml(added.token);
  assert.match(mine, /Held for you/);

  // A second cart holding the same piece is told the truth about it.
  const other = await post(
    { action: "add", slug: "chandbali-earrings" },
    { cookie: newCartToken() }
  );
  const theirs = await cartHtml(other.token);
  assert.match(theirs, /Someone else is looking at this one/);
});

test("only a published notice code is rendered, and a failure is not dressed up", async () => {
  const failure = await cartHtml(null, "?notice=unavailable");
  assert.match(failure, /We could not reach your cart just now/);

  // An unrecognised code renders NOTHING. The page never echoes the query
  // string: the notice element is absent altogether, and no markup from the
  // parameter reaches the document. (vinext's own navigation payload carries
  // the raw search params, unicode-escaped, which is the framework's business
  // and is inert — the assertion below is that no live tag is produced.)
  const injected = await cartHtml(null, "?notice=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.ok(!injected.includes("cart-notice"), "an unknown notice code rendered a banner");
  assert.ok(!injected.includes("<script>alert(1)"), "the query string was reflected as markup");
});

test("the cart is not indexable", async () => {
  const body = await cartHtml(null);
  assert.match(body, /name="robots"[^>]*content="[^"]*noindex/i);
});

test("the storefront carries an add-to-cart control that needs no JavaScript", async () => {
  const shop = await renderPage("/shop");
  assert.match(shop, /<form[^>]*action="\/api\/cart"[^>]*>/);
  assert.match(shop, /method="post"/i);
  assert.match(shop, /name="action"\s+value="add"/);
  assert.ok(shop.includes("Add to cart"));

  const product = await renderPage(`/shop/${HAAR}`);
  assert.match(product, /<form[^>]*action="\/api\/cart"/);
  assert.match(product, /name="slug"\s+value="jadau-haar"/);
});
