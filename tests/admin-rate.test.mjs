/**
 * THE RATE SCREEN AND THE NUMBERS SCREEN.
 *
 * ===========================================================================
 * WHAT IS NOT MOCKED
 * ===========================================================================
 *   - The database is real SQLite, built from this project's own
 *     `drizzle/*.sql` with its real CHECK constraints and its real PARTIAL
 *     UNIQUE INDEX on `(metal, fineness) WHERE effective_to IS NULL`, driven
 *     through the same `d1CartDb()` adapter production uses. That index is
 *     what arbitrates a concurrent rate write, so a test that mocked it away
 *     would be testing nothing.
 *   - The orders are placed by `placeOrder()` through a real cart and a real
 *     price quote, so `order_items.gold_rate_id` points at the row the price
 *     actually came from rather than at one a fixture asserted.
 *   - The screens are rendered by the BUILT Worker, so `proxy.ts`, the admin
 *     layout's gate and the pages are exercised as bundled.
 *   - The session is a real one, minted by the real sign-in endpoint.
 *
 * ===========================================================================
 * THE SECTIONS
 * ===========================================================================
 *  1. The gate — both screens and the endpoint, anonymous and cross-site.
 *  2. THE UNIT. A per-gram figure in a per-ten-grams box is the worst bug this
 *     system can have, and it must be refused rather than warned about.
 *  3. Append-only: there is no edit control, and a correction APPENDS.
 *  4. The consequence — a superseded rate names the orders billed from it.
 *  5. Staleness, told honestly and before it is a problem.
 *  6. The two charts: SVG, a text alternative, and no unreceived money.
 *  7. The audit trail, and the PII that must not be in it.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { env } from "cloudflare:workers";

import { buildSeedSql } from "../scripts/seed-catalogue.mjs";
import { fetchWorker } from "./helpers.mjs";

const {
  ADMIN_KDF_ALGO,
  KDF_ITERATIONS_FLOOR,
  derivePasswordHash,
  generatePassphrase,
  kdfIterations,
  newSalt,
  normalisePassphrase,
} = await import("../app/_admin/auth.ts");

const { d1CartDb, addToCart } = await import("../app/_data/cart.ts");
const { placeOrder, resolveCheckout } = await import("../app/_data/orders.ts");
const {
  checkRateFigure,
  columnPath,
  correctionRef,
  formatMilligrams,
  layOutColumns,
  layOutRows,
  readCorrectionRef,
  rowPath,
  toNumberWindow,
} = await import("../app/_admin/rate-data.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* =========================================================================
 * The D1-shaped client over node:sqlite, as every other suite here builds it
 * ====================================================================== */

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

const SEED_SQL = buildSeedSql({ now: "2026-08-09T00:00:00.000Z" });

function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const dir = path.join(ROOT, "drizzle");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no migration to test the rate screen against");

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }

  sqlite.exec("BEGIN");
  for (const statement of SEED_SQL) sqlite.exec(statement);
  sqlite.exec("COMMIT");

  return sqlite;
}

/* =========================================================================
 * Fixtures
 * ====================================================================== */

const PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const SESSION_SECRET = "test-session-secret-fedcba9876543210";
const ADMIN_EMAIL = "owner@alankar.test";
const ORIGIN = "http://localhost";

const HAAR = "jadau-haar";
const HAAR_VARIANT = "var_jadau-haar";
const SHOP_STATE = "08";

/** IBJA's 916 figure on the day this was written, as published: ₹1,37,053. */
const GOOD_916 = "137053";
const GOOD_916_PAISE = 13_705_300;

const CUSTOMER = {
  name: "Priya Sharma",
  phone: "+919812345678",
  email: "priya@example.test",
  fulfilmentMode: "store_pickup",
  paymentPlan: "full_prepaid",
  ship: null,
  pan: null,
  gstin: null,
  notes: null,
  marketingOptIn: false,
};

let sqlite;
let db;
let passphrase;
let session;

async function seatAdmin(secret) {
  const salt = newSalt();
  const iterations = kdfIterations();
  const hash = await derivePasswordHash({
    password: normalisePassphrase(secret),
    salt,
    iterations,
    pepper: PEPPER,
  });

  sqlite
    .prepare(
      `INSERT INTO admin_users
         (id, email, display_name, role, is_active, created_at,
          password_hash, password_salt, password_algo, password_iterations,
          password_updated_at, failed_login_count)
       VALUES (?, ?, ?, 'owner', 1, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      "adm_owner",
      ADMIN_EMAIL,
      "Shop owner",
      "2026-08-01T00:00:00.000Z",
      hash,
      salt,
      ADMIN_KDF_ALGO,
      iterations,
      "2026-08-01T00:00:00.000Z"
    );
}

async function signIn() {
  const response = await fetchWorker("/api/admin/session", {
    method: "POST",
    redirect: "manual",
    headers: { host: "localhost", origin: ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: passphrase }),
  });

  assert.equal(response.status, 200, "the fixture admin could not sign in");
  const body = await response.json();
  const cookies =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")];

  return { cookie: cookies[0].split(";")[0], csrf: body.csrf };
}

function one(sql, ...params) {
  return sqlite.prepare(sql).get(...params);
}

function rows(sql, ...params) {
  return sqlite.prepare(sql).all(...params);
}

/**
 * A gold rate in force, written the way the ingest writes one.
 *
 * `effectiveFromMs` is injectable so a STALE rate can be produced without
 * sleeping: staleness is slot arithmetic, not a wall-clock timer, so a rate
 * from a week ago is stale by construction.
 */
function seatRate({
  quote = GOOD_916,
  paise = GOOD_916_PAISE,
  fineness = 916,
  metal = "gold",
  source = "ibja",
  effectiveFromMs = Date.now() - 60 * 60 * 1000,
} = {}) {
  const id = crypto.randomUUID();
  const at = new Date(effectiveFromMs).toISOString();
  sqlite
    .prepare(
      `INSERT INTO gold_rates
         (id, metal, fineness, rate_per_ten_grams_paise, source, source_ref,
          source_quote_raw, effective_from, effective_to, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    )
    .run(id, metal, fineness, paise, source, `ibja:${at}:${id}`, quote, at, at);
  return id;
}

function makePriceable({ stockQuantity = 1 } = {}) {
  sqlite.prepare("UPDATE products SET sale_mode = 'buy_online' WHERE slug = ?").run(HAAR);
  sqlite
    .prepare(
      `UPDATE variants
          SET pricing_mode = 'dynamic_metal',
              fineness = 916,
              net_metal_weight_mg = 12345,
              gross_weight_mg = 14345,
              making_charge_type = 'percent',
              making_charge_value = 1200,
              stock_quantity = ?,
              is_unique_piece = 1
        WHERE id = ?`
    )
    .run(stockQuantity, HAAR_VARIANT);
}

/** One real order, placed the way a customer places one. */
async function placeAnOrder() {
  const added = await addToCart(db, { token: null, slug: HAAR });
  assert.equal(added.ok, true, `add to cart failed: ${JSON.stringify(added)}`);

  const resolution = await resolveCheckout(db, {
    token: added.cartId,
    shopStateCode: SHOP_STATE,
  });
  assert.equal(resolution.ok, true, `resolution blocked: ${JSON.stringify(resolution)}`);

  const placed = await placeOrder(db, resolution.checkout, CUSTOMER, {
    shopStateCode: SHOP_STATE,
  });
  assert.equal(placed.ok, true, `placement failed: ${JSON.stringify(placed)}`);
  return placed;
}

async function getPage(pathname, { cookie = session?.cookie } = {}) {
  const headers = { host: "localhost", accept: "text/html" };
  if (cookie) headers.cookie = cookie;
  const response = await fetchWorker(pathname, { redirect: "manual", headers });
  return { response, html: await response.text() };
}

async function postRate(body, { cookie = session?.cookie, origin = ORIGIN, form = false } = {}) {
  const headers = {
    host: "localhost",
    "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
  };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;

  const response = await fetchWorker("/api/admin/rate", {
    method: "POST",
    redirect: "manual",
    headers,
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });

  let parsed = null;
  if (!form) {
    try {
      parsed = await response.json();
    } catch {
      parsed = null;
    }
  }
  return { response, body: parsed };
}

function rateRows() {
  return rows(
    "SELECT * FROM gold_rates WHERE metal = 'gold' AND fineness = 916 ORDER BY effective_from ASC"
  );
}

before(async () => {
  env.DB = d1Over((sqlite = migratedDatabase()));
  env.ADMIN_PASSWORD_PEPPER = PEPPER;
  env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  env.ADMIN_KDF_ITERATIONS = String(KDF_ITERATIONS_FLOOR);
  delete env.ADMIN_AUDIT_MIRROR_URL;

  db = d1CartDb(env.DB);
  passphrase = generatePassphrase();
});

beforeEach(async () => {
  sqlite.exec("DELETE FROM admin_audit_log;");
  sqlite.exec("DELETE FROM admin_sessions;");
  sqlite.exec("DELETE FROM admin_users;");
  sqlite.exec("DELETE FROM order_items;");
  sqlite.exec("DELETE FROM orders;");
  sqlite.exec("DELETE FROM payments;");
  sqlite.exec("DELETE FROM price_quotes;");
  sqlite.exec("DELETE FROM cart_items;");
  sqlite.exec("DELETE FROM carts;");
  sqlite.exec("DELETE FROM webhook_events;");
  sqlite.exec("DELETE FROM support_tickets;");
  sqlite.exec("DELETE FROM customers;");
  sqlite.exec("DELETE FROM gold_rates;");

  makePriceable();
  await seatAdmin(passphrase);
  session = await signIn();
});

after(() => {
  delete env.DB;
  delete env.ADMIN_PASSWORD_PEPPER;
  delete env.ADMIN_SESSION_SECRET;
  delete env.ADMIN_KDF_ITERATIONS;
  sqlite?.close();
});

/* =========================================================================
 * 1. THE GATE
 * ====================================================================== */

test("both screens and the rate endpoint refuse an anonymous request", async () => {
  seatRate();

  for (const pathname of ["/admin/rate", "/admin/numbers"]) {
    const { response, html } = await getPage(pathname, { cookie: null });
    assert.equal(response.status, 303, `${pathname} must redirect an anonymous visitor`);
    assert.match(response.headers.get("location") ?? "", /\/admin\/login$/);
    assert.equal(html.trim().length, 0, `${pathname} rendered a body while refusing`);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }

  const anonymous = await postRate(
    { intent: "enter", slot: "gold:916", figure: "140000" },
    { cookie: null }
  );
  assert.equal(anonymous.response.status, 401);
  assert.equal(rateRows().length, 1, "an anonymous POST wrote a rate");
});

test("the rate endpoint refuses a POST with no Origin, and a cross-site one", async () => {
  seatRate();

  for (const origin of [null, "http://evil.test"]) {
    const attempt = await postRate(
      { intent: "enter", slot: "gold:916", figure: "140000", csrf: session.csrf },
      { origin }
    );
    assert.equal(attempt.response.status, 403, `origin ${origin} was not refused`);
  }

  assert.equal(rateRows().length, 1, "a cross-site POST wrote a rate");
});

test("a POST without the session's own CSRF token changes nothing", async () => {
  seatRate();

  const forged = await postRate({
    intent: "enter",
    slot: "gold:916",
    figure: "140000",
    csrf: "not-the-token",
  });

  assert.equal(forged.response.status, 403);
  assert.equal(rateRows().length, 1);
});

test("the endpoint has no GET, and says why", async () => {
  const response = await fetchWorker("/api/admin/rate", {
    redirect: "manual",
    headers: { host: "localhost", cookie: session.cookie, accept: "application/json" },
  });
  assert.equal(response.status, 405);
  const body = await response.json();
  assert.match(body.error, /superseded, never changed/i);
});

/* =========================================================================
 * 2. THE UNIT — the worst bug this system can have
 * ====================================================================== */

test("a per-gram figure is REFUSED where a per-ten-grams one is expected", async () => {
  seatRate();

  // ₹13,705 per 10 g is the per-GRAM price typed into the per-10-g box. It is
  // not a rate that moved; it is a unit mistake, and it would divide every
  // order by ten without throwing anything.
  const attempt = await postRate({
    intent: "enter",
    slot: "gold:916",
    figure: "13705",
    csrf: session.csrf,
  });

  assert.equal(attempt.response.status, 400);
  assert.equal(attempt.body.notice, "per-gram");
  assert.match(attempt.body.error, /a gram/);
  assert.equal(rateRows().length, 1, "the per-gram figure was written anyway");
});

test("the per-gram refusal cannot be confirmed away", async () => {
  seatRate();

  const attempt = await postRate({
    intent: "enter",
    slot: "gold:916",
    figure: "13705",
    confirmed: "yes",
    csrf: session.csrf,
  });

  assert.equal(attempt.response.status, 400);
  assert.equal(attempt.body.notice, "per-gram");
  assert.equal(rateRows().length, 1);
});

test("a figure ten times the rate in force is refused too", async () => {
  seatRate();

  const attempt = await postRate({
    intent: "enter",
    slot: "gold:916",
    figure: "1370530",
    csrf: session.csrf,
  });

  assert.equal(attempt.response.status, 400);
  assert.equal(attempt.body.notice, "ten-times");
  assert.equal(rateRows().length, 1);
});

test("a large-but-real move needs one confirmation, and then goes in", async () => {
  seatRate();

  const unconfirmed = await postRate({
    intent: "enter",
    slot: "gold:916",
    figure: "180000",
    csrf: session.csrf,
  });
  assert.equal(unconfirmed.body.notice, "big-move");
  assert.equal(rateRows().length, 1);

  const confirmed = await postRate({
    intent: "enter",
    slot: "gold:916",
    figure: "180000",
    confirmed: "yes",
    csrf: session.csrf,
  });
  assert.equal(confirmed.response.status, 201);
  assert.equal(rateRows().length, 2);
});

test("a manual entry records the raw quote VERBATIM, and derives the paise from it", async () => {
  seatRate();

  const typed = "1,40,500";
  const entered = await postRate({
    intent: "enter",
    slot: "gold:916",
    figure: typed,
    note: "IBJA website, 11:25 am",
    csrf: session.csrf,
  });
  assert.equal(entered.response.status, 201);

  const open = one(
    "SELECT * FROM gold_rates WHERE metal = 'gold' AND fineness = 916 AND effective_to IS NULL"
  );
  assert.equal(open.source_quote_raw, typed, "the quote was not stored as it was typed");
  // Derived from the string, never sent alongside it, so the two cannot
  // disagree: ₹1,40,500 per 10 g is 14,050,000 paise per 10 g.
  assert.equal(open.rate_per_ten_grams_paise, 14_050_000);
  assert.equal(open.source, "manual");
  assert.equal(open.created_by, ADMIN_EMAIL);
  assert.match(open.source_ref, /IBJA website/);
});

test("silver is entered per kilogram and stored per ten grams", async () => {
  // IBJA publishes silver per kg. ₹2,29,950 per kg is ₹2,299.50 per 10 g,
  // which is 229,950 paise — a division the OWNER must never be asked to do.
  const entered = await postRate({
    intent: "enter",
    slot: "silver:999",
    figure: "229950",
    csrf: session.csrf,
  });
  assert.equal(entered.response.status, 201);

  const open = one(
    "SELECT * FROM gold_rates WHERE metal = 'silver' AND fineness = 999 AND effective_to IS NULL"
  );
  assert.equal(open.rate_per_ten_grams_paise, 229_950);
  assert.equal(open.source_quote_raw, "229950");
});

test("checkRateFigure is the guard, and it is pure", () => {
  const perTen = { unit: "per_ten_grams", previousPaise: GOOD_916_PAISE };

  assert.equal(checkRateFigure({ raw: "13705", ...perTen }).code, "looks_per_gram");
  assert.equal(checkRateFigure({ raw: "1370530", ...perTen }).code, "looks_ten_times");
  assert.equal(checkRateFigure({ raw: "nonsense", ...perTen }).code, "not_a_figure");
  assert.equal(checkRateFigure({ raw: "", ...perTen }).code, "not_a_figure");

  const fine = checkRateFigure({ raw: "138000", ...perTen });
  assert.equal(fine.ok, true);
  assert.equal(fine.needsConfirmation, false);
  assert.equal(fine.paise, 13_800_000);

  const big = checkRateFigure({ raw: "180000", ...perTen });
  assert.equal(big.ok, true);
  assert.equal(big.needsConfirmation, true);
  assert.equal(
    checkRateFigure({ raw: "180000", ...perTen, confirmed: true }).needsConfirmation,
    false
  );

  // With nothing to compare against, only an absurd figure is refused.
  assert.equal(
    checkRateFigure({ raw: "137053", unit: "per_ten_grams", previousPaise: null }).ok,
    true
  );
  assert.equal(
    checkRateFigure({ raw: "3", unit: "per_ten_grams", previousPaise: null }).code,
    "out_of_band"
  );
});

/* =========================================================================
 * 3. APPEND-ONLY
 * ====================================================================== */

test("the rate screen offers no edit control anywhere", async () => {
  seatRate();
  const { html } = await getPage("/admin/rate");

  assert.match(html, /This one is wrong/);
  assert.equal(/value="edit"/i.test(html), false, "an edit intent is on the page");
  assert.equal(/>\s*Edit\b/i.test(html), false, "an Edit control is on the page");
  assert.equal(/\bDelete\b/i.test(html), false, "a Delete control is on the page");
  // The rule itself, in shop English, on the screen.
  assert.match(html, /never edited/i);
  assert.match(html, /still have to add up/i);
});

test("an edit intent has nothing to bind to", async () => {
  seatRate();

  for (const intent of ["edit", "update", "delete", "set"]) {
    const attempt = await postRate({
      intent,
      slot: "gold:916",
      figure: "140000",
      csrf: session.csrf,
    });
    assert.equal(attempt.response.status, 400, `${intent} was not refused`);
    assert.equal(attempt.body.notice, "not-allowed");
  }

  assert.equal(rateRows().length, 1);
});

test("a correction APPENDS: the wrong figure is closed, never overwritten", async () => {
  const wrongId = seatRate({ quote: "13705", paise: 1_370_530, source: "manual" });

  const corrected = await postRate({
    intent: "correct",
    supersedes: wrongId,
    figure: GOOD_916,
    reasonCode: "typo",
    csrf: session.csrf,
  });
  assert.equal(corrected.response.status, 200);
  assert.equal(corrected.body.notice, "corrected");

  const all = rateRows();
  assert.equal(all.length, 2, "a correction must append a row, not replace one");

  const [wrong, right] = all;
  assert.equal(wrong.id, wrongId);
  // The observation itself is untouched. Only the interval terminator moved.
  assert.equal(wrong.rate_per_ten_grams_paise, 1_370_530);
  assert.equal(wrong.source_quote_raw, "13705");
  assert.notEqual(wrong.effective_to, null, "the wrong row was not closed");

  assert.equal(right.rate_per_ten_grams_paise, GOOD_916_PAISE);
  assert.equal(right.effective_to, null);
  assert.equal(right.source, "manual");
  assert.equal(right.source_ref, correctionRef(wrongId, "typo"));
  assert.equal(right.created_by, ADMIN_EMAIL);

  // And exactly one row is current, which the database itself guarantees.
  assert.equal(
    rows("SELECT id FROM gold_rates WHERE effective_to IS NULL AND fineness = 916").length,
    1
  );
});

test("the history shows the corrected figure beside the one it corrected", async () => {
  const wrongId = seatRate({ quote: "13705", paise: 1_370_530, source: "manual" });
  await postRate({
    intent: "correct",
    supersedes: wrongId,
    figure: GOOD_916,
    reasonCode: "typo",
    csrf: session.csrf,
  });

  const { html } = await getPage("/admin/rate");
  assert.match(html, /Corrected to/);
  assert.match(html, /will not be/);
  // The wrong figure is still printed. It is a record, not an embarrassment.
  assert.match(html, /13,705\.30/);
  assert.match(html, /1,37,053\.00/);
});

test("a correction needs a reason, and a rate no longer in force cannot be corrected", async () => {
  const wrongId = seatRate({ source: "manual" });

  const noReason = await postRate({
    intent: "correct",
    supersedes: wrongId,
    figure: "138000",
    csrf: session.csrf,
  });
  assert.equal(noReason.response.status, 400);
  assert.equal(noReason.body.notice, "needs-reason");
  assert.equal(rateRows().length, 1);

  await postRate({
    intent: "correct",
    supersedes: wrongId,
    figure: "138000",
    reasonCode: "typo",
    csrf: session.csrf,
  });

  // The same row again: it is closed now, and correcting a closed row would be
  // a claim about the past that the orders priced from it contradict.
  const again = await postRate({
    intent: "correct",
    supersedes: wrongId,
    figure: "139000",
    reasonCode: "typo",
    csrf: session.csrf,
  });
  assert.equal(again.response.status, 409);
  assert.equal(again.body.notice, "conflict");
  assert.equal(rateRows().length, 2);
});

test("the guard measures a correction against the rate BEFORE the wrong one", async () => {
  // Yesterday's good rate, then today's per-gram typo on top of it.
  const good = seatRate({ effectiveFromMs: Date.now() - 30 * 60 * 60 * 1000 });
  sqlite
    .prepare("UPDATE gold_rates SET effective_to = ? WHERE id = ?")
    .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), good);
  const wrongId = seatRate({ quote: "13705", paise: 1_370_530, source: "manual" });

  // Putting it right means typing a figure TEN TIMES what the table says. That
  // is exactly the shape the guard refuses, so if it measured against the row
  // in force the correction itself would be impossible.
  const fixed = await postRate({
    intent: "correct",
    supersedes: wrongId,
    figure: GOOD_916,
    reasonCode: "typo",
    csrf: session.csrf,
  });
  assert.equal(fixed.response.status, 200, "the correction was refused by its own guard");
  assert.equal(
    one("SELECT rate_per_ten_grams_paise AS p FROM gold_rates WHERE effective_to IS NULL").p,
    GOOD_916_PAISE
  );

  // And the guard is still armed: a correction ten times the rate before it is
  // refused just as a fresh entry would be.
  const openId = one("SELECT id FROM gold_rates WHERE effective_to IS NULL").id;
  const absurd = await postRate({
    intent: "correct",
    supersedes: openId,
    figure: "1370530",
    reasonCode: "typo",
    csrf: session.csrf,
  });
  assert.equal(absurd.response.status, 400);
  assert.equal(absurd.body.notice, "ten-times");
});

test("the correction screen shows the figure it is measuring against", async () => {
  const good = seatRate({ effectiveFromMs: Date.now() - 30 * 60 * 60 * 1000 });
  sqlite
    .prepare("UPDATE gold_rates SET effective_to = ? WHERE id = ?")
    .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), good);
  const wrongId = seatRate({ quote: "13705", paise: 1_370_530, source: "manual" });

  const { html } = await getPage(`/admin/rate?wrong=${wrongId}`);
  assert.match(html, /The rate before it was/);
  assert.match(html, /a gram/);
  assert.match(html, /refused outright/);
  // And the append-only rule, on the screen where it is about to be relied on.
  assert.match(html, /does not erase anything/);
});

test("readCorrectionRef reads back exactly what correctionRef wrote", () => {
  const id = crypto.randomUUID();
  assert.deepEqual(readCorrectionRef(correctionRef(id, "source_wrong")), {
    supersededId: id,
    reason: "source_wrong",
  });
  assert.equal(readCorrectionRef("ibja:2026-08-08T06:35:00.000Z"), null);
  assert.equal(readCorrectionRef(null), null);
  assert.equal(readCorrectionRef("correction:abc:not-a-reason"), null);
});

/* =========================================================================
 * 4. THE CONSEQUENCE
 * ====================================================================== */

test("a rate about to be superseded NAMES the orders already billed from it", async () => {
  const rateId = seatRate();
  const placed = await placeAnOrder();

  // The order really was priced from that row — not asserted, joined.
  assert.equal(
    one("SELECT gold_rate_id AS id FROM order_items LIMIT 1").id,
    rateId,
    "the fixture order was not priced from the fixture rate"
  );

  const { html } = await getPage(`/admin/rate?wrong=${rateId}`);
  assert.match(html, /Orders already priced from this figure/);
  assert.match(html, new RegExp(CUSTOMER.name));
  assert.match(html, new RegExp(placed.orderNumber));
  assert.match(html, /Their bills do not change/);
  assert.match(html, /Ring them/);
  // A way to actually ring them, on the row.
  assert.match(html, new RegExp(`tel:\\${CUSTOMER.phone}`));
});

test("after the correction the superseded rate still names them", async () => {
  const rateId = seatRate();
  const placed = await placeAnOrder();

  const corrected = await postRate({
    intent: "correct",
    supersedes: rateId,
    figure: "138000",
    reasonCode: "source_wrong",
    csrf: session.csrf,
  });
  assert.equal(corrected.response.status, 200);

  const { html } = await getPage(`/admin/rate?billed=${rateId}`);
  assert.match(html, new RegExp(placed.orderNumber));
  assert.match(html, new RegExp(CUSTOMER.name));
  // The bill is what was recorded, and the screen says nothing was taken.
  assert.match(html, /not taken/);
});

test("the form POST comes back to the screen with the superseded rate named", async () => {
  const rateId = seatRate();
  await placeAnOrder();

  const { response } = await postRate(
    {
      intent: "correct",
      supersedes: rateId,
      figure: "138000",
      reasonCode: "typo",
      csrf: session.csrf,
    },
    { form: true }
  );

  assert.equal(response.status, 303);
  const location = response.headers.get("location") ?? "";
  assert.match(location, /^\/admin\/rate\?/);
  assert.match(location, /notice=corrected/);
  assert.match(location, new RegExp(`billed=${rateId}`));
});

test("a rate nothing was priced from says so rather than showing an empty list", async () => {
  const rateId = seatRate();
  const { html } = await getPage(`/admin/rate?wrong=${rateId}`);
  assert.match(html, /No order was priced from this rate/);
});

/* =========================================================================
 * 5. STALENESS, TOLD HONESTLY
 * ====================================================================== */

test("a fresh rate is one quiet panel with its shelf life on it", async () => {
  seatRate();
  const { html } = await getPage("/admin/rate");

  assert.match(html, /In use now/);
  assert.match(html, /1,37,053\.00/);
  assert.match(html, /Good until/);
  assert.equal(/out of date/i.test(html), false, "a fresh rate raised the alarm");
  // The figure IBJA published, kept verbatim so a bad entry is provable.
  assert.match(html, /As published/);
});

test("a stale rate takes the top of the screen and says what it costs", async () => {
  // A week old. Staleness is slot arithmetic, not a timer, so this is stale by
  // construction rather than by waiting.
  seatRate({ effectiveFromMs: Date.now() - 7 * 24 * 60 * 60 * 1000 });

  const { html } = await getPage("/admin/rate");
  assert.match(html, /out of date/i);
  assert.match(html, /cannot price anything/);
  assert.match(html, /price on request/);
  assert.match(html, /Enter today/);
  assert.equal(/Good until/.test(html), false, "a stale rate claimed a shelf life");
});

test("no rate at all is a setup gap, not an alarm about a figure", async () => {
  const { html } = await getPage("/admin/rate");
  assert.match(html, /No gold rate has been recorded/);
  assert.match(html, /Enter the first rate/);
  assert.equal(/In use now/.test(html), false);
});

test("the automatic check is reported as an event, with what is next due", async () => {
  seatRate();
  const { html } = await getPage("/admin/rate");
  assert.match(html, /The automatic check/);
  assert.match(html, /Last ran/);
  assert.match(html, /Next due/);
});

test("a rate entered by hand says the automatic check has never run", async () => {
  await postRate({ intent: "enter", slot: "gold:916", figure: GOOD_916, csrf: session.csrf });
  const { html } = await getPage("/admin/rate");
  assert.match(html, /It has never run/);
});

/* =========================================================================
 * 6. THE TWO CHARTS
 * ====================================================================== */

test("the numbers screen draws SVG charts, each with a text alternative", async () => {
  seatRate();
  await placeAnOrder();
  // A second order on a different day, so there is more than one day of shape.
  sqlite
    .prepare("UPDATE orders SET placed_at = ? WHERE 1 = 1")
    .run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
  sqlite.prepare("UPDATE variants SET stock_quantity = 1 WHERE id = ?").run(HAAR_VARIANT);
  await placeAnOrder();

  const { response, html } = await getPage("/admin/numbers");
  assert.equal(response.status, 200);

  // Server-rendered SVG, not a library.
  assert.match(html, /<svg/);
  assert.equal(/<script/i.test(html.split("<svg")[1] ?? ""), false, "a chart shipped script");

  // A chart a screen reader cannot read is a decorative image. The name is an
  // `aria-label` and not an SVG <title>, because React 19 hoists <title> to the
  // document head wherever it appears — an empty accessible name and the
  // chart's words in the browser tab.
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Orders a day/);
  assert.match(html, /aria-label="Metal committed by purity/);
  assert.match(html, /<desc/);
  // The description carries the shape in words: the busiest day, and how many
  // days had nothing — which is the whole reason these are bars.
  assert.match(html, /The busiest day had/);
  assert.match(html, /had none/);
  assert.equal(
    /<svg[^>]*>\s*<title/.test(html),
    false,
    "an SVG <title> is hoisted away by React and leaves the chart unnamed"
  );

  // And the numbers themselves, in a real table.
  assert.match(html, /See the figures/);
  assert.match(html, /<table/);
  assert.match(html, /scope="col"/);
  assert.match(html, /scope="row"/);
  assert.match(html, /<caption/);

  assert.match(html, /Orders a day/);
  assert.match(html, /Gold committed/);
  // Grams, to the milligram, because a jeweller's stock is metal.
  assert.match(html, /24\.690 g|12\.345 g/);
});

test("no chart and no tile prints money the shop has not received", async () => {
  seatRate();
  await placeAnOrder();
  sqlite
    .prepare("UPDATE orders SET placed_at = ? WHERE 1 = 1")
    .run(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString());
  sqlite.prepare("UPDATE variants SET stock_quantity = 1 WHERE id = ?").run(HAAR_VARIANT);
  await placeAnOrder();

  const { html } = await getPage("/admin/numbers");

  // No rupee figure inside any chart. The charts are counts and grams.
  for (const chunk of html.split("<svg").slice(1)) {
    const svg = chunk.split("</svg>")[0];
    assert.equal(svg.includes("₹"), false, "a chart printed a rupee figure");
  }

  // No word that would assert money arrived.
  for (const word of ["Revenue", "Takings", "Received", "Turnover", "Paid"]) {
    assert.equal(
      new RegExp(`>\\s*${word}`, "i").test(html),
      false,
      `the numbers screen printed the word ${word}`
    );
  }

  // The one total there IS travels with the sentence that says what it is.
  assert.match(html, /the shop recorded/);
  assert.match(html, /No money has come through the website/);
  assert.match(html, /what was ordered, not what was taken/);
});

test("with nothing to draw, the screen says so instead of drawing an empty axis", async () => {
  const { html } = await getPage("/admin/numbers");
  assert.match(html, /Not enough has happened yet/);
  assert.equal(/<svg/.test(html), false, "an empty axis was drawn");
});

test("the window filter is one row above both charts, and is a closed set", async () => {
  const { html } = await getPage("/admin/numbers?days=90");
  assert.match(html, /Last 90 days/);
  assert.match(html, /aria-current="true"/);

  // Anything else falls back to the default rather than reaching a query.
  assert.equal(toNumberWindow("90"), 90);
  assert.equal(toNumberWindow("365"), 365);
  assert.equal(toNumberWindow("1 OR 1=1"), 30);
  assert.equal(toNumberWindow(undefined), 30);
});

test("the column layout leaves a gap where a day had nothing", () => {
  const chart = layOutColumns([
    { dayKey: "2026-08-01", orders: 2 },
    { dayKey: "2026-08-02", orders: 0 },
    { dayKey: "2026-08-03", orders: 4 },
  ]);

  assert.equal(chart.bars.length, 2, "a day with no orders must draw no bar");
  assert.equal(chart.max, 4);
  // Exactly one bar is direct-labelled: the maximum, and nothing else.
  assert.equal(chart.bars.filter((bar) => bar.isMax).length, 1);
  // Every bar sits on the same baseline, and the tallest fills the plot.
  for (const bar of chart.bars) {
    assert.equal(Math.round(bar.y + bar.height), chart.baselineY);
    assert.ok(bar.width > 0 && bar.height > 0);
  }

  // A 2px surface gap between adjacent slots, never a stroke around a mark.
  const slot = chart.width / 3;
  assert.ok(Math.abs(chart.bars[0].width - (slot - 2)) < 0.001);

  // The data end is rounded; the baseline end is square.
  const d = columnPath(chart.bars[0]);
  assert.match(d, /^M/);
  assert.match(d, /Q/);
  assert.match(d, /Z$/);
});

test("the row layout reserves the gutter its own labels need", () => {
  const chart = layOutRows([
    { metal: "gold", fineness: 916, label: "916", milligrams: 38_400 },
    { metal: "gold", fineness: 750, label: "750", milligrams: 11_200 },
  ]);

  assert.equal(chart.bars.length, 2);
  // The longest bar still ends inside the canvas, with room for its figure.
  for (const bar of chart.bars) {
    assert.ok(bar.x + bar.width <= chart.width - 60, "a bar ran into its own label");
  }
  // Length is proportional to weight, and the bar is the only thing that is.
  assert.ok(chart.bars[0].width > chart.bars[1].width);
  assert.match(rowPath(chart.bars[0]), /Z$/);
});

test("weight is printed to the milligram, without a float", () => {
  assert.equal(formatMilligrams(38_400), "38.400");
  assert.equal(formatMilligrams(12_345), "12.345");
  assert.equal(formatMilligrams(1_000), "1.000");
  assert.equal(formatMilligrams(7), "0.007");
  assert.equal(formatMilligrams(0), "0.000");
  assert.equal(formatMilligrams(12_34_56_789), "1,23,456.789");
});

/* =========================================================================
 * 7. THE AUDIT TRAIL
 * ====================================================================== */

test("reading the orders billed from a rate is logged, and the log holds no PII", async () => {
  const rateId = seatRate();
  await placeAnOrder();

  sqlite.exec("DELETE FROM admin_audit_log;");
  await getPage(`/admin/rate?billed=${rateId}`);

  const logged = rows("SELECT * FROM admin_audit_log");
  assert.ok(logged.length >= 1, "reading a customer's record wrote no audit row");

  const read = logged.find((row) => row.action === "customer_data.search_run");
  assert.ok(read, "the read of the billed orders was not logged");
  assert.equal(read.actor_email, ADMIN_EMAIL);
  assert.equal(read.entity_id, rateId);
  assert.match(read.diff_json, /gold_rate_id/);
  assert.match(read.diff_json, /"results"/);

  for (const row of logged) {
    const blob = JSON.stringify(row);
    assert.equal(blob.includes(CUSTOMER.name), false, "a customer's name is in the audit log");
    assert.equal(blob.includes(CUSTOMER.phone), false, "a customer's phone is in the audit log");
    assert.equal(blob.includes(CUSTOMER.email), false, "a customer's email is in the audit log");
  }
});

test("a rate write is audited in the same batch, and the diff carries no PII", async () => {
  const rateId = seatRate();
  sqlite.exec("DELETE FROM admin_audit_log;");

  await postRate({
    intent: "correct",
    supersedes: rateId,
    figure: "138000",
    reasonCode: "typo",
    csrf: session.csrf,
  });

  const logged = rows("SELECT * FROM admin_audit_log WHERE entity_type = 'gold_rate'");
  assert.equal(logged.length, 1, "the correction wrote no audit row, or wrote two");
  assert.equal(logged[0].action, "rate.corrected");
  assert.equal(logged[0].actor_email, ADMIN_EMAIL);

  const diff = JSON.parse(logged[0].diff_json);
  // Workflow values are named; the money is not — no admin path may edit a
  // price, so a money value in a diff would be evidence of a bug.
  assert.equal(diff.source.to, "manual");
  assert.equal(diff.rate_per_ten_grams_paise, "changed");
  assert.equal(JSON.stringify(diff).includes("phone"), false);
  assert.equal(JSON.stringify(diff).includes("@"), false);
});

test("a refused write leaves neither a rate row nor a rate audit row", async () => {
  seatRate();
  sqlite.exec("DELETE FROM admin_audit_log;");

  await postRate({
    intent: "enter",
    slot: "gold:916",
    figure: "13705",
    csrf: session.csrf,
  });

  assert.equal(rateRows().length, 1);
  assert.equal(rows("SELECT id FROM admin_audit_log WHERE entity_type = 'gold_rate'").length, 0);
});
