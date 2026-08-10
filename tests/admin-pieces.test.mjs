/**
 * THE PIECES SCREENS — the list, the piece, the three sections, and the one
 * endpoint that changes a piece.
 *
 * ===========================================================================
 * WHAT IS NOT MOCKED
 * ===========================================================================
 * Everything that decides whether a half-finished piece is safe.
 *
 *   - The database is real SQLite, built from this project's own `drizzle/*.sql`
 *     with its real CHECK constraints — including `variants_pricing_inputs_ck`,
 *     which is the whole reason this screen is shaped the way it is — seeded
 *     with the project's own seed and driven through the same `d1CartDb()`
 *     adapter production uses.
 *   - The screens are rendered by the BUILT Worker (`npm test` builds first), so
 *     `proxy.ts`, the admin layout's gate and the pages are exercised as bundled
 *     rather than as source.
 *   - The session is a real one, minted by the real sign-in endpoint.
 *   - The money in the echo comes from `priceLine()`, the same engine that
 *     prices the storefront and the invoice.
 *
 * ===========================================================================
 * THE SECTIONS
 * ===========================================================================
 *  1. The gate — every screen and the endpoint, anonymous and cross-site.
 *  2. TWO FIELDS. A piece exists, is valid, and is invisible to the shop.
 *  3. THE ECHO. The ten-times guard, in words and in money.
 *  4. THE HONESTY RULE. A HUID is never invented, and its absence is explained.
 *  5. THE PRICING CHECK. It cannot be violated in a way nobody can diagnose.
 *  6. The audit trail, and what must never be in it.
 *  7. The floor: one h1, bound labels, fieldsets, machine-readable dates.
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

const { AUDIT_VALUE_ALLOWLIST } = await import("../app/_admin/audit.ts");
const { d1CartDb } = await import("../app/_data/cart.ts");
const { mostRecentPublicationAtOrBefore } = await import("../app/_pricing/rates.ts");

const {
  BIS_GOLD_HALLMARKING_PAISE,
  PIECE_NOTICES,
  canPublish,
  constraintNotice,
  formatGrams,
  gapsFor,
  goldValuePaise,
  hallmarkAnswered,
  isPieceSku,
  newPieceSku,
  numberInWords,
  parseGrams,
  parseRupees,
  previewPrice,
  pricingNotice,
  readPiece,
  setPieceStatus,
  slugify,
  stillNeeds,
  stockNotice,
  weightInWords,
} = await import("../app/_admin/pieces-data.ts");

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
  assert.ok(files.length > 0, "no migration to test the pieces screens against");

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

/** IBJA quotes gold per 10 g in whole rupees; ₹73,240 is 7,324,000 paise. */
const RATE_916_PAISE = 7_324_000;

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

function recordRate({ fineness = 916, paise = RATE_916_PAISE } = {}) {
  const effectiveFrom = new Date(mostRecentPublicationAtOrBefore(Date.now())).toISOString();
  sqlite
    .prepare(
      `INSERT INTO gold_rates
         (id, metal, fineness, rate_per_ten_grams_paise, source, source_ref,
          source_quote_raw, effective_from, effective_to, created_at)
       VALUES (?, 'gold', ?, ?, 'ibja', ?, ?, ?, NULL, ?)`
    )
    .run(
      `rate_${fineness}`,
      fineness,
      paise,
      `ibja:${effectiveFrom}`,
      String(Math.floor(paise / 100)),
      effectiveFrom,
      effectiveFrom
    );
}

function one(sql, ...params) {
  return sqlite.prepare(sql).get(...params);
}

function rows(sql, ...params) {
  return sqlite.prepare(sql).all(...params);
}

async function getPage(pathname, { cookie = session?.cookie } = {}) {
  const headers = { host: "localhost", accept: "text/html" };
  if (cookie) headers.cookie = cookie;
  const response = await fetchWorker(pathname, { redirect: "manual", headers });
  return { response, html: await response.text() };
}

async function post(body, { cookie = session?.cookie, origin = ORIGIN, form = false } = {}) {
  const headers = {
    host: "localhost",
    "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
  };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;

  const response = await fetchWorker("/api/admin/pieces", {
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
  return { response, body: parsed, location: response.headers.get("location") };
}

/** Start a piece the way the form starts one, and hand back its handle. */
async function startPiece({ title = "Polki necklace", craft = "polki" } = {}) {
  const created = await post({ intent: "create", title, craft, csrf: session.csrf });
  assert.equal(created.response.status, 200, JSON.stringify(created.body));

  const row = one(
    `SELECT v.sku AS sku FROM variants v
       JOIN products p ON p.id = v.product_id
      WHERE p.title = ?
      ORDER BY v.rowid DESC LIMIT 1`,
    title
  );
  assert.ok(row, "the piece was reported created but is not in the database");
  return row.sku;
}

function variantOf(sku) {
  return one("SELECT * FROM variants WHERE sku = ?", sku);
}

function productOf(sku) {
  return one(
    "SELECT p.* FROM products p JOIN variants v ON v.product_id = p.id WHERE v.sku = ?",
    sku
  );
}

before(async () => {
  env.DB = d1Over((sqlite = migratedDatabase()));
  env.ADMIN_PASSWORD_PEPPER = PEPPER;
  env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  // The algorithm is under test elsewhere, not the work factor.
  env.ADMIN_KDF_ITERATIONS = String(KDF_ITERATIONS_FLOOR);
  delete env.ADMIN_AUDIT_MIRROR_URL;

  db = d1CartDb(env.DB);
  passphrase = generatePassphrase();
});

beforeEach(async () => {
  sqlite.exec("DELETE FROM admin_audit_log;");
  sqlite.exec("DELETE FROM admin_sessions;");
  sqlite.exec("DELETE FROM admin_users;");
  sqlite.exec("DELETE FROM gold_rates;");
  // Only pieces this suite created. The five seeded ones stay, because the
  // panel has to manage stock it did not enter.
  sqlite.exec("DELETE FROM variants WHERE sku LIKE 'AJ-P-%';");
  sqlite.exec("DELETE FROM products WHERE id NOT IN (SELECT product_id FROM variants);");

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

test("every pieces screen and the endpoint refuse an anonymous request", async () => {
  const sku = await startPiece();

  for (const pathname of [
    "/admin/pieces",
    "/admin/pieces?add=1",
    `/admin/pieces/${sku}`,
    `/admin/pieces/${sku}?section=weight`,
    `/admin/pieces/${sku}?section=price`,
    `/admin/pieces/${sku}?section=hallmark`,
  ]) {
    const { response, html } = await getPage(pathname, { cookie: null });
    assert.equal(response.status, 303, `${pathname} must redirect an anonymous visitor`);
    assert.match(response.headers.get("location") ?? "", /\/admin\/login$/);
    assert.equal(html.trim().length, 0, `${pathname} rendered a body while refusing`);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }

  const anonymous = await post(
    { intent: "put_away", sku, csrf: session.csrf },
    { cookie: null }
  );
  assert.equal(anonymous.response.status, 401);
  assert.equal(productOf(sku).status, "draft", "nothing may move for a stranger");
});

test("the endpoint refuses a POST with no Origin, and a cross-site one", async () => {
  const sku = await startPiece();

  for (const origin of [null, "http://evil.test"]) {
    const attempt = await post({ intent: "put_away", sku, csrf: session.csrf }, { origin });
    assert.equal(attempt.response.status, 403);
  }

  assert.equal(productOf(sku).status, "draft");
  assert.equal(
    one("SELECT COUNT(*) AS c FROM variants WHERE sku LIKE 'AJ-P-%'").c,
    1,
    "and a cross-site create made no piece either"
  );
});

test("an action without the session's own CSRF token changes nothing", async () => {
  const sku = await startPiece();

  const forged = await post({ intent: "put_away", sku, csrf: "not-the-token" });
  assert.equal(forged.response.status, 403);
  assert.equal(productOf(sku).status, "draft");

  const forgedCreate = await post({
    intent: "create",
    title: "Smuggled in",
    craft: "gold",
    csrf: "not-the-token",
  });
  assert.equal(forgedCreate.response.status, 403);
  assert.equal(one("SELECT COUNT(*) AS c FROM products WHERE title = 'Smuggled in'").c, 0);
});

test("the endpoint is not readable by GET — a GET that changed state would be a link", async () => {
  const response = await fetchWorker("/api/admin/pieces", {
    redirect: "manual",
    headers: { host: "localhost", cookie: session.cookie, accept: "application/json" },
  });
  assert.equal(response.status, 405);
  assert.match(response.headers.get("allow") ?? "", /POST/);
});

/* =========================================================================
 * 2. TWO FIELDS — and a half-finished piece that is safe
 * ====================================================================== */

test("A PIECE IS CREATED FROM TWO FIELDS, AND IS LEGAL THE MOMENT IT EXISTS", async () => {
  const { html } = await getPage("/admin/pieces?add=1");
  // The form asks for two things and no more. Anything else on it would be a
  // field the owner has to get past before the piece exists at all.
  assert.ok(html.includes('name="title"'));
  assert.ok(html.includes('name="craft"'));
  for (const absent of ["net", "gross", "fineness", "huid", "pricingMode", "fixed"]) {
    assert.equal(
      new RegExp(`name="${absent}"`).test(html),
      false,
      `${absent} must not be on the screen that starts a piece`
    );
  }

  const sku = await startPiece({ title: "Polki necklace", craft: "polki" });
  const variant = variantOf(sku);
  const product = productOf(sku);

  assert.ok(isPieceSku(sku), "the piece carries a handle of the shop's own shape");
  assert.equal(product.status, "draft", "a new piece is a draft, which is the schema's default");
  assert.equal(product.sale_mode, "enquire_only");
  assert.equal(product.craft, "polki");
  assert.equal(product.slug, "polki-necklace");

  // THE ONE THING THAT MAKES THE INSERT LEGAL. `pricing_mode` defaults to
  // `dynamic_metal`, and `variants_pricing_inputs_ck` refuses that with no
  // weight and no fineness — so the row could not exist at the default.
  assert.equal(variant.pricing_mode, "on_request");
  assert.equal(variant.net_metal_weight_mg, null);
  assert.equal(variant.fineness, null);
  assert.equal(variant.huid, null, "and nothing was invented on the way in");
  assert.equal(variant.certificate_number, null);
  assert.equal(variant.hallmarking_paise, BIS_GOLD_HALLMARKING_PAISE);
  assert.equal(variant.is_unique_piece, 1);
  assert.equal(variant.stock_quantity, 1);
});

test("a second piece with the same name gets its own address rather than a failure", async () => {
  const first = await startPiece({ title: "Polki necklace" });
  const second = await startPiece({ title: "Polki necklace" });

  assert.notEqual(first, second);
  assert.equal(productOf(first).slug, "polki-necklace");
  assert.equal(productOf(second).slug, "polki-necklace-2");
});

test("a piece with no Latin letters in its name still gets a usable address", () => {
  assert.equal(slugify("अलंकार"), "");
  assert.equal(slugify("  Polki  Necklace! "), "polki-necklace");
});

test("A HALF-FINISHED PIECE IS INVISIBLE TO THE STOREFRONT, AND NEVER A BROKEN LISTING", async () => {
  const sku = await startPiece({ title: "Unfinished bridal set", craft: "jadau" });

  // Draft: filtered out by `readCommerceRows()`, which selects on status.
  const draftShop = await getPage("/shop", { cookie: null });
  assert.equal(draftShop.response.status, 200);
  assert.equal(
    draftShop.html.includes("Unfinished bridal set"),
    false,
    "a draft reached the shop window"
  );

  // Answer the hallmark question so it becomes publishable, then publish it.
  const answered = await post({
    intent: "save_hallmark",
    sku,
    answer: "exempt",
    csrf: session.csrf,
  });
  assert.equal(answered.response.status, 200, JSON.stringify(answered.body));

  const published = await post({ intent: "publish", sku, csrf: session.csrf });
  assert.equal(published.response.status, 200, JSON.stringify(published.body));
  assert.equal(productOf(sku).status, "active");

  // AND IT IS STILL NOT A BROKEN LISTING. The storefront skips any product with
  // no imagery manifest entry, because it would have no photograph and no alt
  // text — so a published piece with no photograph is left out rather than being
  // rendered as an empty card.
  const liveShop = await getPage("/shop", { cookie: null });
  assert.equal(liveShop.response.status, 200);
  assert.equal(
    liveShop.html.includes("Unfinished bridal set"),
    false,
    "a piece with no photograph was listed"
  );

  // And the panel says so, rather than letting the owner think it is up.
  const { html } = await getPage(`/admin/pieces/${sku}`);
  assert.ok(html.includes("will not actually appear"));
  assert.ok(/photographs cannot be added yet/i.test(html));
});

test("the list says what a draft still needs, without it having to be opened", async () => {
  const sku = await startPiece({ title: "Polki necklace" });
  const { html } = await getPage("/admin/pieces");

  assert.ok(html.includes("Polki necklace"));
  assert.ok(html.includes("Still needs:"));
  assert.ok(html.includes("weight and purity"));
  assert.ok(html.includes("the hallmark answer"));
  assert.ok(html.includes("a photograph"));

  // And the same list, as data, so the screen cannot drift from the rule.
  const piece = await readPiece(db, sku);
  assert.deepEqual([...stillNeeds(piece)], ["a photograph", "weight and purity", "the hallmark answer"]);

  // A price is NOT a gap until the piece could carry one. "Price on request" is
  // a real answer for an unweighed piece, not an unfinished one.
  assert.equal(stillNeeds(piece).includes("a price"), false);
});

test("an empty catalogue explains itself instead of showing a blank", async () => {
  sqlite.exec("DELETE FROM variants;");
  sqlite.exec("DELETE FROM products;");
  try {
    const { html } = await getPage("/admin/pieces");
    assert.ok(html.includes("No pieces yet"));
    assert.ok(html.includes("rather than showing pictures that are not of anything"));
    assert.ok(html.includes("Add a piece"));
  } finally {
    sqlite.exec("BEGIN");
    for (const statement of SEED_SQL) sqlite.exec(statement);
    sqlite.exec("COMMIT");
  }
});

/* =========================================================================
 * 3. THE ECHO — the ten-times guard
 * ====================================================================== */

test("a weight is read the way it is weighed, and a comma is refused rather than guessed", () => {
  assert.deepEqual(parseGrams("18.4"), { ok: true, value: 18400 });
  assert.deepEqual(parseGrams("18.400"), { ok: true, value: 18400 });
  assert.deepEqual(parseGrams("184"), { ok: true, value: 184000 });
  assert.deepEqual(parseGrams("  12.345 "), { ok: true, value: 12345 });
  assert.deepEqual(parseGrams(""), { ok: true, value: null }, "not weighed yet is an answer");

  // `18,400` reads as eighteen thousand four hundred here and as 18.4 elsewhere.
  // A separator with two meanings must never be resolved silently on a weight.
  assert.equal(parseGrams("18,400").ok, false);
  assert.equal(parseGrams("18.4000").ok, false, "four decimals is not a trade weight");
  assert.equal(parseGrams("0").ok, false);
  assert.equal(parseGrams("abc").ok, false);
  assert.equal(parseGrams("6000").notice, "weight-too-big");

  // Money is the other way round, and deliberately so.
  assert.deepEqual(parseRupees("22,400"), { ok: true, value: 2_240_000 });
});

test("the words for a weight share nothing between a figure and its ten-times typo", () => {
  assert.equal(weightInWords(18_400), "eighteen grams and four hundred milligrams");
  assert.equal(weightInWords(184_000), "one hundred and eighty-four grams");
  assert.equal(weightInWords(1_840_000), "one thousand eight hundred and forty grams");
  assert.equal(weightInWords(1_000), "one gram");
  assert.equal(weightInWords(1), "one milligram");
  assert.equal(numberInWords(0), "zero");

  // The property that matters is that the two cannot be mistaken for one
  // another at a glance: they open with different words, neither contains the
  // other, and the unit words differ. Sharing "and" or "hundred" somewhere in
  // the middle is not what makes a ten-times error slip past.
  const right = weightInWords(18_400);
  const wrong = weightInWords(184_000);

  assert.notEqual(right, wrong);
  assert.equal(wrong.includes(right), false);
  assert.equal(right.includes(wrong), false);
  assert.notEqual(right.split(" ")[0], wrong.split(" ")[0], "they must not even start alike");
  assert.ok(right.includes("milligrams"));
  assert.equal(wrong.includes("milligrams"), false);
});

test("THE ECHO STATES THE WEIGHT IN WORDS AND IN RUPEES, AND WRITES NOTHING YET", async () => {
  recordRate();
  const sku = await startPiece();

  const asked = await post(
    { intent: "save_weight", sku, net: "18.400", gross: "24.100", fineness: "916", csrf: session.csrf },
    { form: true }
  );
  assert.equal(asked.response.status, 303);
  assert.match(asked.location, /section=weight/);
  assert.match(asked.location, /confirm=1/);

  // NOTHING HAS BEEN WRITTEN. The first post is a question, not a save.
  assert.equal(variantOf(sku).net_metal_weight_mg, null, "the echo must not write");
  assert.equal(variantOf(sku).fineness, null);

  const { response, html } = await getPage(asked.location);
  assert.equal(response.status, 200);

  assert.ok(html.includes("Save 18.400 g?"), "the figure, as typed");
  assert.ok(
    html.includes("eighteen grams and four hundred milligrams"),
    "the figure, in words"
  );

  // The figure, in money — and it is the pricing engine's own answer rather than
  // arithmetic the screen did for itself.
  const expected = goldValuePaise(18_400, 916, RATE_916_PAISE);
  assert.equal(expected, 13_476_160);
  assert.ok(html.includes("1,34,761.60"), "the figure, in rupees");
  assert.ok(html.includes("24.100 g"), "and the gross weight it will save alongside");

  // Confirming is what writes.
  const confirmed = await post({
    intent: "save_weight",
    sku,
    net: "18.400",
    gross: "24.100",
    fineness: "916",
    confirm: "yes",
    csrf: session.csrf,
  });
  assert.equal(confirmed.response.status, 200);
  const variant = variantOf(sku);
  assert.equal(variant.net_metal_weight_mg, 18_400);
  assert.equal(variant.gross_weight_mg, 24_100);
  assert.equal(variant.fineness, 916);
});

test("A TEN-TIMES TYPO IS UNMISSABLE IN THE CONFIRMATION", async () => {
  recordRate();
  const sku = await startPiece();

  const ask = async (net) => {
    const asked = await post(
      { intent: "save_weight", sku, net, gross: "", fineness: "916", csrf: session.csrf },
      { form: true }
    );
    assert.equal(asked.response.status, 303);
    return (await getPage(asked.location)).html;
  };

  const right = await ask("18.400");
  const wrong = await ask("184.000");

  assert.ok(right.includes("eighteen grams and four hundred milligrams"));
  assert.ok(wrong.includes("one hundred and eighty-four grams"));
  assert.equal(
    wrong.includes("eighteen grams and four hundred milligrams"),
    false,
    "the two confirmations must not read alike"
  );

  // And the money differs by an order of magnitude, in the figure the owner
  // actually reads.
  assert.ok(right.includes("1,34,761.60"));
  assert.ok(wrong.includes("13,47,616.00"));
  assert.equal(wrong.includes("1,34,761.60"), false);

  // Neither wrote anything.
  assert.equal(variantOf(sku).net_metal_weight_mg, null);
});

test("with no gold rate the echo says so rather than showing a zero", async () => {
  const sku = await startPiece();

  const asked = await post(
    { intent: "save_weight", sku, net: "18.400", gross: "", fineness: "916", csrf: session.csrf },
    { form: true }
  );
  const { html } = await getPage(asked.location);

  assert.ok(html.includes("eighteen grams and four hundred milligrams"));
  assert.ok(html.includes("no gold rate in force"));
  assert.equal(/₹0\b/.test(html), false, "a zero would be a guess dressed as a fact");
  assert.equal(/of gold in this piece/.test(html), false);
});

test("a weight that cannot be read is refused with the fix, and loses nothing else", async () => {
  const sku = await startPiece();

  const refused = await post(
    { intent: "save_weight", sku, net: "18,400", gross: "", fineness: "916", csrf: session.csrf },
    { form: true }
  );
  assert.equal(refused.response.status, 303);
  assert.match(refused.location, /notice=bad-weight/);

  const { html } = await getPage(refused.location);
  assert.ok(html.includes("Write it in grams the way it reads on the scale"));
  assert.ok(html.includes("18.4 and 18.400 both work"));
  assert.equal(variantOf(sku).net_metal_weight_mg, null);
});

/* =========================================================================
 * 4. THE HONESTY RULE
 * ====================================================================== */

test("NOTHING ON THE HALLMARK SCREEN IS FILLED IN, SUGGESTED OR PATTERNED", async () => {
  const sku = await startPiece({ title: "Polki choker set", craft: "polki" });
  const { html } = await getPage(`/admin/pieces/${sku}?section=hallmark`);

  // The field exists, is empty, and offers the browser nothing to complete it
  // from. A HUID is issued by BIS against a physical article; the only correct
  // one is the one read off the piece.
  assert.ok(html.includes('name="huid"'));
  assert.ok(/id="huid"[^>]*value=""/.test(html) || !/id="huid"[^>]*value="[^"]/.test(html));
  assert.ok(/id="huid"[^>]*autoComplete="off"|id="huid"[^>]*autocomplete="off"/i.test(html));
  assert.equal(/id="huid"[^>]*placeholder="[^"]+"/.test(html), false, "no example to copy");

  // The exemption is stated as law beside a choice; it does not MAKE the choice,
  // even for a craft the exemption covers.
  assert.ok(html.includes("QCO cl. 2(3)"));
  assert.equal(
    /id="answer-exempt"[^>]*checked/i.test(html),
    false,
    "an exempt craft must not pre-answer a question about a physical piece"
  );
  assert.ok(html.includes("nothing is worked out from anything else"));
});

test("saying there is a number and giving none is refused, and no number is made up", async () => {
  const sku = await startPiece();

  const refused = await post({
    intent: "save_hallmark",
    sku,
    answer: "recorded",
    huid: "",
    csrf: session.csrf,
  });
  assert.equal(refused.response.status, 400);
  assert.equal(refused.body.notice, "needs-huid");
  assert.equal(variantOf(sku).huid, null, "no number, and none invented");
});

test("the three hallmark answers each say something true, and only one records a number", async () => {
  const sku = await startPiece();

  // "It is hallmarked, and the number is not to hand." Honest, and it keeps the
  // piece off the website.
  await post({ intent: "save_hallmark", sku, answer: "not_to_hand", csrf: session.csrf });
  let variant = variantOf(sku);
  assert.equal(variant.huid, null);
  assert.ok(variant.hallmarking_paise > 0, "a charge stands, and a number is owed against it");
  assert.equal(hallmarkAnswered(await readPiece(db, sku)), false);
  assert.equal(canPublish(await readPiece(db, sku)), false);

  // "It is exempt." No charge, no number, and the absence is not a gap.
  await post({ intent: "save_hallmark", sku, answer: "exempt", huid: "", csrf: session.csrf });
  variant = variantOf(sku);
  assert.equal(variant.huid, null);
  assert.equal(variant.hallmarking_paise, 0);
  assert.equal(canPublish(await readPiece(db, sku)), true);

  // "Here is the number." Recorded exactly as typed, and nothing else changes.
  await post({
    intent: "save_hallmark",
    sku,
    answer: "recorded",
    huid: "  HA1B2C  ",
    certificateNumber: "IGI-778812",
    certificateLab: "IGI",
    charge: "45",
    csrf: session.csrf,
  });
  variant = variantOf(sku);
  assert.equal(variant.huid, "HA1B2C", "trimmed, and otherwise untouched");
  assert.equal(variant.certificate_number, "IGI-778812");
  assert.equal(variant.certificate_lab, "IGI");
  assert.equal(variant.hallmarking_paise, 4500);

  // Going back to exempt CLEARS the number, because the two facts must not
  // disagree on one row — a bill that prints a number beside "exempt" is worse
  // than either fact on its own.
  await post({ intent: "save_hallmark", sku, answer: "exempt", csrf: session.csrf });
  assert.equal(variantOf(sku).huid, null);
});

test("an empty identifier box is stored as nothing at all, never as an empty number", async () => {
  const sku = await startPiece();
  await post({
    intent: "save_hallmark",
    sku,
    answer: "not_to_hand",
    huid: "   ",
    purityMark: "",
    certificateNumber: "",
    certificateLab: "",
    csrf: session.csrf,
  });

  const variant = variantOf(sku);
  for (const column of ["huid", "hallmark_purity_mark", "certificate_number", "certificate_lab"]) {
    assert.equal(variant[column], null, `${column} must be NULL and never ""`);
  }
});

test("a missing hallmark number is EXPLAINED on the piece, never left blank", async () => {
  const sku = await startPiece({ title: "Jadau haar set", craft: "jadau" });

  // Unanswered: the charge stands and the screen says a number is owed.
  let page = await getPage(`/admin/pieces/${sku}`);
  assert.ok(page.html.includes("A hallmarking charge is set on this piece"));
  assert.ok(page.html.includes("no number is on record"));

  // Exempt: the reason is printed, and it is the same reason the bill prints.
  await post({ intent: "save_hallmark", sku, answer: "exempt", csrf: session.csrf });
  page = await getPage(`/admin/pieces/${sku}`);
  assert.ok(page.html.includes("QCO cl. 2(3)"));
  assert.ok(page.html.includes("does not have to be"));
  assert.equal(page.html.includes("no number is on record"), false);
});

test("A PIECE WITH A CHARGE AND NO NUMBER CANNOT BE PUBLISHED — AND THE DATABASE IS WHAT REFUSES", async () => {
  const sku = await startPiece();

  // Through the endpoint, refused before the write.
  const refused = await post({ intent: "publish", sku, csrf: session.csrf });
  assert.equal(refused.response.status, 409);
  assert.equal(refused.body.notice, "not-publishable");
  assert.equal(productOf(sku).status, "draft");

  // And the screen replaces the control with the reason rather than disabling
  // it: a disabled control with no explanation is what makes people give up.
  const { html } = await getPage(`/admin/pieces/${sku}`);
  assert.equal(html.includes('value="publish"'), false, "no control that cannot succeed");
  assert.equal(/<button[^>]*disabled/i.test(html), false, "and no disabled one either");
  assert.ok(html.includes("The hallmark question has not been answered"));

  // NOW THE STRUCTURAL HALF. Hand `setPieceStatus()` a row it believes is
  // exempt while the database says otherwise — which is what a race, or a
  // future edit to the pre-check, would look like. The UPDATE writes NULL into
  // a NOT NULL column, the batch aborts, and the audit row dies with it.
  const piece = await readPiece(db, sku);
  const lying = { ...piece, hallmarkingPaise: 0 };
  assert.equal(canPublish(lying), true, "the pre-check is fooled, as intended by this test");

  const outcome = await setPieceStatus(db, {
    piece: lying,
    intent: "publish",
    actor: { email: ADMIN_EMAIL, adminUserId: "adm_owner" },
  });

  assert.equal(outcome.ok, false, "the database must refuse what the pre-check let through");
  assert.equal(outcome.notice, "not-publishable");
  assert.equal(productOf(sku).status, "draft", "and nothing moved");
  assert.equal(
    one("SELECT COUNT(*) AS c FROM admin_audit_log WHERE action = 'piece.status_changed'").c,
    0,
    "the audit row went down with the batch, so nothing claims it was published"
  );

  // And the refusal is a sentence, not a constraint name.
  assert.ok(PIECE_NOTICES["not-publishable"].copy.includes("hallmark"));
  assert.equal(/constraint|NOT NULL|CHECK/i.test(PIECE_NOTICES["not-publishable"].copy), false);
});

/* =========================================================================
 * 5. THE PRICING CHECK
 * ====================================================================== */

test("variants_pricing_inputs_ck CANNOT BE VIOLATED IN A WAY THE OWNER CANNOT DIAGNOSE", async () => {
  const sku = await startPiece();

  // (a) Priced by weight with no weight: refused BEFORE the database, in words
  // that name the missing thing, the place to add it, and a way out.
  const byWeight = await post({
    intent: "save_pricing",
    sku,
    pricingMode: "dynamic_metal",
    makingChargeType: "percent",
    makingCharge: "12",
    csrf: session.csrf,
  });
  assert.equal(byWeight.response.status, 400);
  assert.equal(byWeight.body.notice, "needs-weight");
  assert.match(byWeight.body.message, /weight/);
  assert.match(byWeight.body.message, /purity/);
  assert.match(byWeight.body.message, /price on request/);
  assert.equal(/variants_pricing_inputs_ck|CHECK/i.test(byWeight.body.message), false);
  assert.equal(variantOf(sku).pricing_mode, "on_request", "and the piece stayed legal");

  // (b) A fixed price with no figure: the other arm of the same constraint.
  const fixed = await post({
    intent: "save_pricing",
    sku,
    pricingMode: "fixed",
    fixed: "",
    csrf: session.csrf,
  });
  assert.equal(fixed.response.status, 400);
  assert.equal(fixed.body.notice, "needs-price");
  assert.match(fixed.body.message, /fixed price needs a figure/);

  // (c) THE WAY OUT IS ALWAYS OPEN. `on_request` has no precondition, which is
  // what makes the constraint a sequence rather than a wall.
  const safe = await post({
    intent: "save_pricing",
    sku,
    pricingMode: "on_request",
    csrf: session.csrf,
  });
  assert.equal(safe.response.status, 200);

  // (d) And the sequence completes: weigh it, then price it.
  await post({
    intent: "save_weight",
    sku,
    net: "18.400",
    fineness: "916",
    confirm: "yes",
    csrf: session.csrf,
  });
  const priced = await post({
    intent: "save_pricing",
    sku,
    pricingMode: "dynamic_metal",
    makingChargeType: "percent",
    makingCharge: "12",
    stones: "22400",
    csrf: session.csrf,
  });
  assert.equal(priced.response.status, 200, JSON.stringify(priced.body));
  const variant = variantOf(sku);
  assert.equal(variant.pricing_mode, "dynamic_metal");
  assert.equal(variant.making_charge_type, "percent");
  assert.equal(variant.making_charge_value, 1200, "12% is 1200 basis points");
  assert.equal(variant.stone_value_paise, 2_240_000);
});

test("the pricing rule is one function, and the constraint's own message maps to a sentence", () => {
  assert.equal(
    pricingNotice({ pricingMode: "on_request", netMetalWeightMg: null, fineness: null, fixedPricePaise: null }),
    null,
    "the safe mode has no precondition at all"
  );
  assert.equal(
    pricingNotice({ pricingMode: "dynamic_metal", netMetalWeightMg: 18400, fineness: null, fixedPricePaise: null }),
    "needs-weight"
  );
  assert.equal(
    pricingNotice({ pricingMode: "dynamic_metal", netMetalWeightMg: 18400, fineness: 916, fixedPricePaise: null }),
    null
  );
  assert.equal(
    pricingNotice({ pricingMode: "fixed", netMetalWeightMg: null, fineness: null, fixedPricePaise: null }),
    "needs-price"
  );

  // The BACKSTOP. Even a constraint the pre-checks never anticipated comes back
  // as words, because a constraint name in front of a shop owner is a dead end.
  for (const [message, expected] of [
    ["CHECK constraint failed: variants_pricing_inputs_ck", "bad-pricing"],
    ["CHECK constraint failed: variants_unique_piece_stock_ck", "unique-stock"],
    ["CHECK constraint failed: variants_fineness_range_ck", "bad-purity"],
    ["CHECK constraint failed: variants_money_non_negative_ck", "negative-money"],
    ["CHECK constraint failed: variants_stock_non_negative_ck", "bad-count"],
    ["UNIQUE constraint failed: products.slug", "name-taken"],
    ["NOT NULL constraint failed: products.status", "not-publishable"],
  ]) {
    const notice = constraintNotice(new Error(`D1_ERROR: ${message}`));
    assert.equal(notice, expected, message);
    const copy = PIECE_NOTICES[notice].copy;
    assert.ok(copy.length > 20);
    assert.equal(/constraint|_ck\b|NULL/i.test(copy), false, `${notice} leaks database language`);
  }
});

test("the database really does hold the constraint this screen is shaped around", async () => {
  const sku = await startPiece();
  const variant = variantOf(sku);

  assert.throws(
    () =>
      sqlite
        .prepare("UPDATE variants SET pricing_mode = 'dynamic_metal' WHERE id = ?")
        .run(variant.id),
    /variants_pricing_inputs_ck/,
    "if this ever stops throwing, the whole incremental design is unnecessary"
  );
  assert.equal(variantOf(sku).pricing_mode, "on_request");
});

test("a one-of-a-kind piece cannot be given a stock of two, and is told why", async () => {
  const sku = await startPiece();

  const refused = await post({
    intent: "save_pricing",
    sku,
    pricingMode: "on_request",
    unique: "yes",
    stock: "2",
    csrf: session.csrf,
  });
  assert.equal(refused.response.status, 400);
  assert.equal(refused.body.notice, "unique-stock");
  assert.match(refused.body.message, /one of a kind|one-of-a-kind/i);
  assert.equal(variantOf(sku).stock_quantity, 1);

  assert.equal(stockNotice({ isUniquePiece: true, stockQuantity: 1 }), null);
  assert.equal(stockNotice({ isUniquePiece: false, stockQuantity: 6 }), null);
  assert.equal(stockNotice({ isUniquePiece: true, stockQuantity: 2 }), "unique-stock");

  const allowed = await post({
    intent: "save_pricing",
    sku,
    pricingMode: "on_request",
    unique: "no",
    stock: "6",
    csrf: session.csrf,
  });
  assert.equal(allowed.response.status, 200);
  assert.equal(variantOf(sku).stock_quantity, 6);
  assert.equal(variantOf(sku).is_unique_piece, 0);
});

test("a piece nobody can price cannot be put up for sale online", async () => {
  const sku = await startPiece();
  const refused = await post({
    intent: "save_pricing",
    sku,
    pricingMode: "on_request",
    saleMode: "buy_online",
    csrf: session.csrf,
  });
  assert.equal(refused.response.status, 400);
  assert.equal(refused.body.notice, "online-on-request");
  assert.equal(productOf(sku).sale_mode, "enquire_only");
});

test("the preview foots, and is the pricing engine's answer rather than the screen's", async () => {
  recordRate();
  const sku = await startPiece();

  await post({
    intent: "save_weight",
    sku,
    net: "18.400",
    fineness: "916",
    confirm: "yes",
    csrf: session.csrf,
  });
  await post({
    intent: "save_pricing",
    sku,
    pricingMode: "dynamic_metal",
    makingChargeType: "percent",
    makingCharge: "12",
    stones: "22400",
    csrf: session.csrf,
  });
  await post({ intent: "save_hallmark", sku, answer: "exempt", csrf: session.csrf });

  const piece = await readPiece(db, sku);
  const preview = previewPrice(piece, RATE_916_PAISE);
  assert.equal(preview.ok, true);

  // The rows ARE the engine's breakup, GST line included. A screen that added
  // its own GST row would print the tax twice and show a total that does not
  // foot — which is a compliance defect, not a cosmetic one.
  const summed = preview.rows.reduce((total, row) => total + row.amountPaise, 0);
  assert.equal(summed, preview.totalPaise, "the breakup must add up to the total");
  assert.equal(
    preview.rows.filter((row) => row.label === "GST").length,
    1,
    "exactly one tax line, and it comes from the engine"
  );
  assert.equal(preview.rows[0].amountPaise, goldValuePaise(18_400, 916, RATE_916_PAISE));

  // An exempt piece raises NO hallmarking line, rather than a zero one that
  // would read as though the piece had been hallmarked.
  assert.equal(
    preview.rows.some((row) => row.label === "Hallmarking"),
    false
  );

  const { html } = await getPage(`/admin/pieces/${sku}`);
  assert.ok(html.includes("would show on the website as"));
  assert.ok(html.includes(formatGrams(18_400)));
});

test("a piece with no rate is shown at price on request rather than at a guess", async () => {
  const sku = await startPiece();
  await post({
    intent: "save_weight",
    sku,
    net: "18.400",
    fineness: "916",
    confirm: "yes",
    csrf: session.csrf,
  });
  await post({
    intent: "save_pricing",
    sku,
    pricingMode: "dynamic_metal",
    makingChargeType: "percent",
    makingCharge: "12",
    csrf: session.csrf,
  });

  const piece = await readPiece(db, sku);
  assert.deepEqual(previewPrice(piece, null), { ok: false, reason: "no_rate" });

  const { html } = await getPage(`/admin/pieces/${sku}`);
  assert.ok(html.includes("no gold rate in force"));
  assert.equal(/₹0\.00/.test(html), false);
});

/* =========================================================================
 * 6. THE AUDIT TRAIL
 * ====================================================================== */

test("EVERY CHANGE IS AUDITED, AND THE ROW CARRIES NO PII AND NO MONEY VALUE", async () => {
  recordRate();
  const sku = await startPiece({ title: "Kundan kada pair", craft: "kundan" });

  await post({
    intent: "save_weight",
    sku,
    net: "18.400",
    gross: "24.100",
    fineness: "916",
    confirm: "yes",
    csrf: session.csrf,
  });
  await post({
    intent: "save_pricing",
    sku,
    pricingMode: "dynamic_metal",
    makingChargeType: "percent",
    makingCharge: "12",
    stones: "22400",
    csrf: session.csrf,
  });
  await post({
    intent: "save_hallmark",
    sku,
    answer: "recorded",
    huid: "HA1B2C",
    certificateNumber: "IGI-778812",
    certificateLab: "IGI",
    // Deliberately not ₹45: the charge has to MOVE for the diff to have an
    // entry for it, and what is under test is what that entry may contain.
    charge: "50",
    csrf: session.csrf,
  });
  await post({ intent: "publish", sku, csrf: session.csrf });

  const entries = rows("SELECT * FROM admin_audit_log WHERE action LIKE 'piece.%'");
  assert.equal(entries.length, 5, "created, weight, pricing, hallmark, status");

  const dump = JSON.stringify(entries);

  // NO MONEY, IN ANY UNIT. Not the weight, not the making charge, not the stone
  // value, and not the figure any of them would produce.
  for (const secret of ["18400", "24100", "1200", "2240000", "22400", "5000", "13476160"]) {
    assert.equal(dump.includes(secret), false, `${secret} reached the audit table`);
  }

  // AND NO IDENTIFIER FOR A PHYSICAL OBJECT. A HUID and a certificate number
  // both live outside the erasure job's reach once they are in here.
  for (const secret of ["HA1B2C", "IGI-778812"]) {
    assert.equal(dump.includes(secret), false, `${secret} reached the audit table`);
  }

  // What IS recorded: who, what kind of change, and which row.
  for (const entry of entries) {
    assert.equal(entry.actor_email, ADMIN_EMAIL);
    assert.ok(["product", "variant"].includes(entry.entity_type));
    assert.ok(entry.entity_id, "a change must name the row it changed");
    assert.equal(entry.result, "ok");
  }

  // Allowlisted columns carry values; everything else carries only "changed".
  const weight = entries.find((entry) => entry.action === "piece.weight_changed");
  const diff = JSON.parse(weight.diff_json);
  assert.deepEqual(diff.fineness, { from: null, to: 916 }, "purity is a workflow value");
  assert.equal(diff.net_metal_weight_mg, "changed");
  assert.equal(diff.gross_weight_mg, "changed");

  const hallmark = entries.find((entry) => entry.action === "piece.hallmark_changed");
  const hallmarkDiff = JSON.parse(hallmark.diff_json);
  assert.equal(hallmarkDiff.huid, "changed", "a HUID is proof of change, never a value");
  assert.equal(hallmarkDiff.certificate_number, "changed");
  assert.equal(hallmarkDiff.hallmarking_paise, "changed");

  const status = entries.find((entry) => entry.action === "piece.status_changed");
  assert.deepEqual(JSON.parse(status.diff_json).status, { from: "draft", to: "active" });
});

test("no identifier or money column is on the allowlist that could carry it", () => {
  for (const column of [
    "huid",
    "certificate_number",
    "certificate_lab",
    "hallmark_purity_mark",
    "net_metal_weight_mg",
    "gross_weight_mg",
    "making_charge_value",
    "stone_value_paise",
    "fixed_price_paise",
    "hallmarking_paise",
  ]) {
    assert.equal(
      AUDIT_VALUE_ALLOWLIST.variant.includes(column),
      false,
      `${column} must never be loggable by value`
    );
  }
});

/* =========================================================================
 * 7. THE FLOOR
 * ====================================================================== */

test("every pieces screen meets the accessibility floor the panel promised", async () => {
  const sku = await startPiece();

  const screens = [
    "/admin/pieces",
    "/admin/pieces?add=1",
    `/admin/pieces/${sku}`,
    `/admin/pieces/${sku}?section=weight`,
    `/admin/pieces/${sku}?section=price`,
    `/admin/pieces/${sku}?section=hallmark`,
    `/admin/pieces/${sku}?section=weight&confirm=1&net=18.400&fineness=916`,
  ];

  for (const pathname of screens) {
    const { html } = await getPage(pathname);
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${pathname} needs exactly one h1`);
    assert.equal(
      (html.match(/<main\b/g) ?? []).length,
      1,
      `${pathname} must not open a second main`
    );
    // The tick and the dot are decorative; the word beside them carries the
    // state, so colour and shape are never the only channel.
    if (html.includes("pcs__dot")) assert.ok(/aria-hidden="true"/.test(html));
  }

  // Every group of choices is a fieldset with a legend, and every input has a
  // label bound with `for` rather than a placeholder standing in for one.
  const weight = await getPage(`/admin/pieces/${sku}?section=weight`);
  assert.ok(weight.html.includes("<fieldset"));
  assert.ok(weight.html.includes("<legend"));
  assert.ok(weight.html.includes('for="net-weight"'));
  assert.ok(weight.html.includes('id="net-weight"'));
  // The wrong keyboard on a weight field is how a decimal point goes missing.
  assert.ok(/id="net-weight"[^>]*inputMode="decimal"|inputmode="decimal"/i.test(weight.html));

  const list = await getPage("/admin/pieces");
  assert.ok(list.html.includes("<ol"), "a catalogue is a list");
  assert.ok(/<time dateTime="|<time datetime="/i.test(list.html), "dates are machine-readable");

  // Both purity labels on every pill: Reg. 5(11) needs carat AND fineness, and
  // 995 has no carat at all.
  assert.ok(weight.html.includes("22K (916)"));
  assert.ok(weight.html.includes("995 fineness"));
  assert.equal(weight.html.includes("24K (995)"), false, "995 must never be rounded to 24K");
});

test("no piece screen offers a delete, and the absence is stated rather than merely absent", async () => {
  const sku = await startPiece();
  const { html } = await getPage(`/admin/pieces/${sku}`);

  assert.equal(/>\s*Delete\b/i.test(html), false);
  assert.equal(/name="intent" value="delete"/i.test(html), false);
  assert.ok(html.includes("never deletes it"));

  const attempt = await post({ intent: "delete", sku, csrf: session.csrf });
  assert.equal(attempt.response.status, 400);
  assert.equal(one("SELECT COUNT(*) AS c FROM variants WHERE sku = ?", sku).c, 1);
});

test("a piece can be put away and brought back without losing anything", async () => {
  recordRate();
  const sku = await startPiece();
  await post({
    intent: "save_weight",
    sku,
    net: "18.400",
    fineness: "916",
    confirm: "yes",
    csrf: session.csrf,
  });

  const away = await post({ intent: "put_away", sku, csrf: session.csrf });
  assert.equal(away.response.status, 200);
  assert.equal(productOf(sku).status, "archived");

  const list = await getPage("/admin/pieces");
  assert.ok(list.html.includes("Put away (1)"));

  const back = await post({ intent: "bring_back", sku, csrf: session.csrf });
  assert.equal(back.response.status, 200);
  assert.equal(productOf(sku).status, "draft");
  assert.equal(variantOf(sku).net_metal_weight_mg, 18_400, "and the weight survived both");
});

test("a handle the shop never issued is refused before the database is asked", async () => {
  const bad = await post({ intent: "put_away", sku: "../../etc/passwd", csrf: session.csrf });
  assert.equal(bad.response.status, 400);
  assert.equal(bad.body.notice, "not-found");

  const missing = await getPage("/admin/pieces/AJ-P-2608-ZZZZZZ");
  assert.equal(missing.response.status, 200);
  assert.ok(missing.html.includes("No piece with that number"));

  // A drawn handle is a drawn handle: two never collide, and none is a counter.
  const drawn = new Set();
  for (let i = 0; i < 200; i += 1) drawn.add(newPieceSku(Date.parse("2026-08-10T00:00:00Z")));
  assert.equal(drawn.size, 200, "a sequential handle would leak how much stock came in");
  assert.ok(isPieceSku(newPieceSku()));
});

test("the panel can also manage stock it did not enter", async () => {
  // The five seeded pieces carry their own SKUs. A panel that only understood
  // its own handles would orphan everything already in the database.
  const piece = await readPiece(db, "AJ-JADAU-HAAR-01");
  assert.ok(piece, "the seeded stock must be readable");
  assert.equal(piece.status, "active");
  assert.equal(piece.pricingMode, "on_request");
  assert.equal(piece.huid, null);
  // Seeded as exempt, which is the truth for Jadau — so it has no gap there.
  assert.equal(hallmarkAnswered(piece), true);
  assert.deepEqual(
    gapsFor(piece)
      .filter((gap) => !gap.done)
      .map((gap) => gap.id),
    ["photograph", "weight"]
  );

  const { response, html } = await getPage("/admin/pieces/AJ-JADAU-HAAR-01");
  assert.equal(response.status, 200);
  assert.ok(html.includes("Jadau haar"));
});
