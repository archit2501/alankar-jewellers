/**
 * THE ORDERS SCREENS — the list, the order, and the one endpoint that changes
 * an order.
 *
 * ===========================================================================
 * WHAT IS NOT MOCKED
 * ===========================================================================
 * Everything that decides what an owner is told about money.
 *
 *   - The database is real SQLite, built from this project's own
 *     `drizzle/*.sql` with its real CHECK constraints, seeded with the
 *     project's own seed, and driven through the same `d1CartDb()` adapter
 *     production uses.
 *   - The orders under test are placed by `placeOrder()` through a real cart
 *     and a real price quote, so their snapshots foot because the database
 *     made them foot.
 *   - The screens are rendered by the BUILT Worker (`npm test` builds first),
 *     so `proxy.ts`, the admin layout's gate and the pages are exercised as
 *     bundled rather than as source.
 *   - The session is a real one, minted by the real sign-in endpoint.
 *
 * ===========================================================================
 * THE SECTIONS
 * ===========================================================================
 *  1. The gate — both pages and the endpoint, anonymous.
 *  2. The list.
 *  3. The order, and the bill.
 *  4. THE PAYMENT CLAIM — the top-rated risk in research/04. The status
 *     control must not be able to express a state nobody authorised.
 *  5. Cancelling: the actor, the reason, and the stock that comes back once.
 *  6. The audit trail, and the PII that must not be in it.
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
const { mostRecentPublicationAtOrBefore } = await import("../app/_pricing/rates.ts");
const {
  CANCELLABLE_ORDER_STATUSES,
  PAYMENT_CAPTURE_ENABLED,
  placeOrder,
  resolveCheckout,
} = await import("../app/_data/orders.ts");
const { readAdminOrderDetail } = await import("../app/_admin/data.ts");
const {
  PAYMENT_BEARING_STATUSES,
  STATUS_ACTIONS,
  isPaymentBearingStatus,
  statusWord,
} = await import("../app/admin/orders/orders-data.ts");

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
  assert.ok(files.length > 0, "no migration to test the admin screens against");

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
const SHOP_STATE = "08"; // Rajasthan.

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
/** A signed-in session: the cookie header and the CSRF token bound to it. */
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

/** Turn a placeholder seed piece into a real, priceable, buyable one. */
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

  const effectiveFrom = new Date(mostRecentPublicationAtOrBefore(Date.now())).toISOString();
  const existing = sqlite
    .prepare(
      "SELECT count(*) AS c FROM gold_rates WHERE metal = 'gold' AND fineness = 916 AND effective_to IS NULL"
    )
    .get().c;
  if (existing === 0) {
    sqlite
      .prepare(
        `INSERT INTO gold_rates
           (id, metal, fineness, rate_per_ten_grams_paise, source, source_ref,
            source_quote_raw, effective_from, effective_to, created_at)
         VALUES ('rate_916', 'gold', 916, 13705300, 'ibja', ?, '137053', ?, NULL, ?)`
      )
      .run(`ibja:${effectiveFrom}`, effectiveFrom, effectiveFrom);
  }
}

/** One real order, placed the way a customer places one. */
async function placeAnOrder() {
  makePriceable();
  const added = await addToCart(db, { token: null, slug: HAAR });
  assert.equal(added.ok, true);

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

/** Tear an order the way a half-committed D1 batch would: a line goes missing
 *  while `line_item_count` still claims it. */
function tear(orderNumber) {
  const { id } = one("SELECT id FROM orders WHERE order_number = ?", orderNumber);
  sqlite.prepare("DELETE FROM order_items WHERE order_id = ?").run(id);
  return id;
}

function one(sql, ...params) {
  return sqlite.prepare(sql).get(...params);
}

function rows(sql, ...params) {
  return sqlite.prepare(sql).all(...params);
}

function stockOf(variantId = HAAR_VARIANT) {
  return one("SELECT stock_quantity AS q FROM variants WHERE id = ?", variantId).q;
}

async function getPage(pathname, { cookie = session?.cookie } = {}) {
  const headers = { host: "localhost", accept: "text/html" };
  if (cookie) headers.cookie = cookie;
  const response = await fetchWorker(pathname, { redirect: "manual", headers });
  return { response, html: await response.text() };
}

async function postAction(body, { cookie = session?.cookie, origin = ORIGIN, form = false } = {}) {
  const headers = {
    host: "localhost",
    "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
  };
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;

  const response = await fetchWorker("/api/admin/orders", {
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

before(async () => {
  env.DB = d1Over((sqlite = migratedDatabase()));
  env.ADMIN_PASSWORD_PEPPER = PEPPER;
  env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  // The algorithm is under test, not the work factor.
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

test("both order screens and the action endpoint refuse an anonymous request", async () => {
  const placed = await placeAnOrder();

  for (const pathname of ["/admin/orders", `/admin/orders/${placed.orderNumber}`]) {
    const { response, html } = await getPage(pathname, { cookie: null });
    assert.equal(response.status, 303, `${pathname} must redirect an anonymous visitor`);
    assert.match(response.headers.get("location") ?? "", /\/admin\/login$/);
    // Nothing about the customer may travel in the refusal.
    assert.equal(html.includes(CUSTOMER.name), false);
    assert.equal(html.includes(CUSTOMER.phone), false);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/);
  }

  const anonymous = await postAction(
    { intent: "cancel", orderNumber: placed.orderNumber, reasonCode: "customer_request" },
    { cookie: null }
  );
  assert.equal(anonymous.response.status, 401);
  assert.equal(one("SELECT status FROM orders WHERE order_number = ?", placed.orderNumber).status, "pending_payment");
});

test("the endpoint refuses a POST with no Origin, and a cross-site one", async () => {
  const placed = await placeAnOrder();

  for (const origin of [null, "http://evil.test"]) {
    const attempt = await postAction(
      { intent: "cancel", orderNumber: placed.orderNumber, reasonCode: "customer_request", csrf: session.csrf },
      { origin }
    );
    assert.equal(attempt.response.status, 403);
  }

  assert.equal(one("SELECT cancelled_at AS at FROM orders").at, null);
});

test("an action without the session's own CSRF token changes nothing", async () => {
  const placed = await placeAnOrder();

  const forged = await postAction({
    intent: "cancel",
    orderNumber: placed.orderNumber,
    reasonCode: "customer_request",
    csrf: "not-the-token",
  });

  assert.equal(forged.response.status, 403);
  assert.equal(one("SELECT status FROM orders").status, "pending_payment");
  assert.equal(stockOf(), 0, "and nothing went back on the wall");
});

test("the endpoint is not readable by GET — a GET that changed state would be a link", async () => {
  const response = await fetchWorker("/api/admin/orders", {
    redirect: "manual",
    headers: { host: "localhost", cookie: session.cookie, accept: "application/json" },
  });
  assert.equal(response.status, 405);
  assert.match(response.headers.get("allow") ?? "", /POST/);
});

/* =========================================================================
 * 2. THE LIST
 * ====================================================================== */

test("the list shows the person, the amount and the number, and can be searched by phone", async () => {
  const placed = await placeAnOrder();
  const { response, html } = await getPage("/admin/orders");

  assert.equal(response.status, 200);
  assert.ok(html.includes(CUSTOMER.name), "the customer's name is the row");
  assert.ok(html.includes(placed.orderNumber));
  assert.ok(html.includes(`tel:${CUSTOMER.phone}`), "ringing them is on the row");
  assert.ok(html.includes("wa.me/919812345678"));

  // The one state that exists today is not printed on every row: the same word
  // everywhere teaches nothing.
  assert.equal(/class="ord__state"/.test(html), false);

  const found = await getPage("/admin/orders?q=9812345678");
  assert.equal(found.response.status, 200);
  assert.ok(found.html.includes(placed.orderNumber), "a bare ten-digit number must find it");

  const missing = await getPage("/admin/orders?q=9999999999");
  assert.equal(missing.html.includes(placed.orderNumber), false);
  assert.ok(missing.html.includes("Nothing matches that"));
});

test("with no orders the list teaches the mechanic instead of showing a blank", async () => {
  const { html } = await getPage("/admin/orders");
  assert.ok(html.includes("No orders yet"));
  // The empty screen must not promise money it cannot take.
  assert.ok(/not switched on/i.test(html));
  assert.equal(/no payment (has been )?received/i.test(html), false);
});

test("both screens meet the accessibility floor the panel promised", async () => {
  const placed = await placeAnOrder();

  for (const pathname of ["/admin/orders", `/admin/orders/${placed.orderNumber}`]) {
    const { html } = await getPage(pathname);

    // Exactly one <h1>. The shell opens the <main> and deliberately carries no
    // heading, so the count per screen is the screen's own.
    assert.equal((html.match(/<h1\b/g) ?? []).length, 1, `${pathname} needs exactly one h1`);
    assert.equal((html.match(/<main\b/g) ?? []).length, 1, `${pathname} must not open a second main`);

    // Colour is never the only channel: the alert mark is decorative and the
    // word beside it carries the meaning.
    if (html.includes("ord__mark")) assert.ok(/aria-hidden="true"/.test(html));
  }

  const list = await getPage("/admin/orders");
  // The queue is a list, and the search field has a real bound label rather
  // than a placeholder standing in for one.
  assert.ok(list.html.includes("<ol"), "a queue is a list");
  assert.ok(list.html.includes('for="ord-q"'));
  assert.ok(list.html.includes('id="ord-q"'));

  // Every date is machine-readable as well as readable.
  assert.ok(/<time dateTime="|<time datetime="/i.test(list.html));

  const detail = await getPage(`/admin/orders/${placed.orderNumber}`);
  // Figures are a table with row headers, not a grid of divs.
  assert.ok(detail.html.includes('scope="row"'));
  // And the cancellation reasons are a fieldset with a legend.
  const confirm = await getPage(`/admin/orders/${placed.orderNumber}?action=cancel`);
  assert.ok(confirm.html.includes("<fieldset"));
  assert.ok(confirm.html.includes("<legend"));
});

/* =========================================================================
 * 3. THE ORDER, AND THE BILL
 * ====================================================================== */

test("THE BREAKUP RENDERS EVERY COMPONENT AND FOOTS", async () => {
  const placed = await placeAnOrder();

  // First against the reader, where footing is arithmetic rather than markup.
  const detail = await readAdminOrderDetail(db, placed.orderNumber, {
    actor: { email: ADMIN_EMAIL, adminUserId: "adm_owner" },
  });
  assert.ok(detail, "the order must be readable by an admin");
  assert.equal(detail.intact, true);
  assert.equal(detail.lines.length, 1);

  for (const line of detail.lines) {
    assert.equal(line.quantity, 1, "the footing below assumes the one-of-a-kind case");
    const summed = line.breakup.reduce((total, entry) => total + entry.amountPaise, 0);
    assert.equal(summed, line.lineTotalPaise, "the column must add up to the line total");

    // BIS Reg. 5(11) itemisation is a fixed shape: metal, making, stones and
    // hallmarking are all present, even at zero, because a missing row reads
    // as an omission rather than as a nil charge.
    const labels = line.breakup.map((entry) => entry.label);
    for (const required of ["Gold", "Making", "Stones", "Hallmarking", "GST"]) {
      assert.ok(
        labels.some((label) => label.startsWith(required)),
        `the bill has no ${required} row`
      );
    }
  }

  const lineTotals = detail.lines.reduce((total, line) => total + line.lineTotalPaise, 0);
  assert.equal(lineTotals, detail.totalPaise, "the lines must add up to the order");

  // And then against the document the owner actually sees.
  const { response, html } = await getPage(`/admin/orders/${placed.orderNumber}`);
  assert.equal(response.status, 200);
  assert.ok(html.includes("Bill of sale"));
  assert.ok(html.includes("Taxable value"));
  assert.ok(html.includes("Line total"));
  // Ornament marks the statutory, and marks nothing else.
  assert.ok(html.includes("illuminated--brass"), "the bill carries the brass brackets");
  // Ornament marks the statutory and marks nothing else: no other motif from
  // app/_ornament.css appears anywhere on the screen.
  for (const motif of ["rule-gold", "jali-veil", "arch", "flip"]) {
    assert.equal(html.includes(`class="${motif}`), false, `${motif} has no business here`);
  }
  // Every `.illuminated` on the page is the bill: the plain motif never
  // appears without the brass modifier that marks a statutory document.
  const brackets = (html.match(/illuminated(?!--brass)/g) ?? []).length;
  const brass = (html.match(/illuminated--brass/g) ?? []).length;
  assert.equal(brackets, brass, "every illuminated panel on the page is the bill");

  // The rate that justifies the invoice prints inside the invoice.
  assert.ok(/Rate used: Gold 916/.test(html), "the rate provenance is missing from the bill");
  assert.ok(/per 10 grams/.test(html));
});

test("A MISSING HALLMARK NUMBER EXPLAINS ITSELF AND IS NEVER LEFT BLANK", async () => {
  const placed = await placeAnOrder();
  assert.equal(
    one("SELECT huid_snapshot AS h FROM order_items").h,
    null,
    "this fixture is the exempt case, which is the shop's normal one"
  );

  const { html } = await getPage(`/admin/orders/${placed.orderNumber}`);
  assert.ok(html.includes("Hallmark number (HUID)"));
  assert.ok(
    html.includes("exempt from hallmarking (QCO cl. 2(3))"),
    "a missing HUID must print the reason, never a blank"
  );

  // And when a hallmarking charge WAS raised, the sentence is the other one:
  // a number is owed against it.
  sqlite.exec(
    `UPDATE order_items
        SET hallmarking_paise = 4500,
            unit_price_paise = unit_price_paise + 4500,
            line_subtotal_paise = line_subtotal_paise + 4500,
            line_total_paise = line_total_paise + 4500`
  );
  sqlite.exec(
    `UPDATE orders
        SET hallmarking_paise = 4500,
            taxable_paise = taxable_paise + 4500,
            total_paise = total_paise + 4500,
            advance_due_paise = advance_due_paise + 4500`
  );

  const charged = await getPage(`/admin/orders/${placed.orderNumber}`);
  assert.ok(charged.html.includes("a number is owed against it"));
});

test("THERE IS NO DELETE, AND THE SCREEN SAYS WHY", async () => {
  const placed = await placeAnOrder();
  const { html } = await getPage(`/admin/orders/${placed.orderNumber}`);

  assert.equal(/>\s*Delete\b/i.test(html), false, "there must be no delete control");
  assert.equal(/name="intent" value="delete"/i.test(html), false);
  assert.ok(
    html.includes("cannot be deleted or edited"),
    "the absence has to be stated, not merely be an absence"
  );
  assert.ok(html.includes("five years"));

  // And the endpoint has no such intent either.
  const attempt = await postAction({
    intent: "delete",
    orderNumber: placed.orderNumber,
    csrf: session.csrf,
  });
  assert.equal(attempt.response.status, 400);
  assert.equal(one("SELECT count(*) AS c FROM orders").c, 1, "the order is still there");
});

test("A TORN ORDER IS REPORTED, NEVER TOTALLED — on the list and on the order", async () => {
  const placed = await placeAnOrder();
  const total = one("SELECT total_paise AS t FROM orders").t;
  tear(placed.orderNumber);

  const list = await getPage("/admin/orders");
  assert.ok(list.html.includes("did not save fully"));
  assert.ok(list.html.includes("Do not invoice it"));
  assert.equal(
    list.html.includes(`/admin/orders/${placed.orderNumber}"`),
    false,
    "a torn row must not tap through to a bill"
  );

  const detail = await getPage(`/admin/orders/${placed.orderNumber}`);
  assert.equal(detail.response.status, 200);
  assert.ok(detail.html.includes("This order did not save fully"));
  assert.ok(detail.html.includes("no total is given"));
  assert.equal(detail.html.includes("Bill of sale"), false, "the bill is replaced, not annotated");
  assert.equal(detail.html.includes("illuminated--brass"), false);
  assert.equal(detail.html.includes("Print"), false, "not even a disabled print control");

  // No figure anywhere on either page. Rupees, groups of digits, the lot.
  const rupees = String(Math.floor(total / 100)).replace(/\B(?=(\d{2})+(?!\d)$)/g, ",");
  for (const html of [list.html, detail.html]) {
    assert.equal(html.includes(rupees), false, "a torn order must show no figure at all");
  }

  // And nothing may be done to it.
  assert.equal(detail.html.includes("Cancel this order"), false);
  const attempt = await postAction({
    intent: "cancel",
    orderNumber: placed.orderNumber,
    reasonCode: "customer_request",
    csrf: session.csrf,
  });
  assert.equal(attempt.response.status, 409);
  assert.equal(attempt.body.notice, "torn");
  assert.equal(one("SELECT status FROM orders").status, "pending_payment");
});

/* =========================================================================
 * 4. THE PAYMENT CLAIM — the top-rated risk
 * ====================================================================== */

test("the transition table cannot express a payment state, by construction", () => {
  assert.equal(PAYMENT_CAPTURE_ENABLED, false, "this whole section assumes capture is off");

  for (const intent of Object.keys(STATUS_ACTIONS)) {
    const action = STATUS_ACTIONS[intent];
    assert.equal(
      isPaymentBearingStatus(action.toStatus),
      false,
      `${intent} writes ${action.toStatus}, which asserts money arrived`
    );
    for (const from of action.from) {
      assert.ok(typeof from === "string" && from.length > 0);
    }
  }

  // PINNED TO LITERALS, NOT TO ITSELF.
  //
  // This used to loop PAYMENT_BEARING_STATUSES asserting isPaymentBearingStatus
  // returned true for each -- but that function IS `ARRAY.includes(x)`, so the
  // loop reduced to "every member of A is in A", which holds for any contents
  // of A. Mutation-checked: dropping "paid" from the array left all 436 tests
  // green, and `assertNoPaymentClaim()` in app/api/admin/orders/route.ts is
  // described in its own header as the check that survives someone editing this
  // table later. It did not survive one.
  assert.deepEqual(
    [...PAYMENT_BEARING_STATUSES].sort(),
    ["advance_paid", "paid", "refunded"],
    "the set of statuses that assert money arrived changed. That is either a " +
      "deliberate decision about what counts as payment, or a mistake that " +
      "just disarmed the guard protecting it."
  );

  // The predicate still has to agree with the table, in both directions.
  for (const status of ["advance_paid", "paid", "refunded"]) {
    assert.equal(isPaymentBearingStatus(status), true, `${status} asserts money arrived`);
  }
  for (const status of ["placed", "confirmed", "making", "ready", "collected", "cancelled"]) {
    assert.equal(isPaymentBearingStatus(status), false, `${status} claims no money`);
  }

  // The three cancellable-from states that ARE payment states stay reachable
  // for CANCELLATION — the money question must never strand a piece off sale.
  assert.ok(CANCELLABLE_ORDER_STATUSES.includes("paid"));
});

test("THE SCREEN OFFERS NO CONTROL THAT COULD CLAIM MONEY WAS RECEIVED", async () => {
  const placed = await placeAnOrder();
  const { html } = await getPage(`/admin/orders/${placed.orderNumber}`);

  // No status control at all in the raw sense: the form posts an INTENT, and
  // an intent cannot name a status.
  assert.equal(/name="status"/.test(html), false, "a status must never be submittable");
  assert.equal(/<select/i.test(html), false, "a dropdown over the enum is the failure mode");

  for (const claim of ["advance_paid", "paid", "refunded"]) {
    assert.equal(
      new RegExp(`value="${claim}"`).test(html),
      false,
      `${claim} must not be expressible from this page`
    );
  }

  // Nothing on the page tells the customer, or the owner, that money arrived.
  assert.equal(/\bpayment received\b/i.test(html), false);
  assert.equal(/\bmark as paid\b/i.test(html), false);

  // And the absence is EXPLAINED rather than silent — in the data layer's own
  // words, so the screen cannot drift from the reason it was given.
  const detail = await readAdminOrderDetail(db, placed.orderNumber, {
    actor: { email: ADMIN_EMAIL, adminUserId: "adm_owner" },
  });
  assert.ok(detail.paymentActionsBlockedReason, "capture is off, so there must be a reason");
  assert.ok(
    html.includes(detail.paymentActionsBlockedReason),
    "the blocked reason must be printed on the screen, not merely computed"
  );
});

test("the endpoint refuses every attempt to name a payment state directly", async () => {
  const placed = await placeAnOrder();

  const attempts = [
    { intent: "paid" },
    { intent: "mark_paid" },
    { intent: "advance_paid" },
    { intent: "refunded" },
    { intent: "mark_ready", status: "paid" },
    { intent: "", status: "paid" },
  ];

  for (const attempt of attempts) {
    const result = await postAction({
      ...attempt,
      orderNumber: placed.orderNumber,
      csrf: session.csrf,
    });

    const row = one("SELECT status, payment_status AS pay FROM orders");
    assert.equal(row.pay, "unpaid", `payment_status moved on ${JSON.stringify(attempt)}`);
    if (attempt.intent === "mark_ready") {
      // A legal intent stays legal; the stray `status` field is simply not read.
      assert.equal(result.response.status, 200);
      assert.equal(row.status, "ready_for_pickup");
    } else {
      assert.equal(result.response.status, 400, `${attempt.intent} must be refused`);
      assert.equal(result.body.notice, "not-allowed");
    }
  }
});

test("the two status writes move the order and are audited with an allowlisted diff", async () => {
  const placed = await placeAnOrder();

  const ready = await postAction({
    intent: "mark_ready",
    orderNumber: placed.orderNumber,
    csrf: session.csrf,
  });
  assert.equal(ready.response.status, 200);
  assert.equal(one("SELECT status FROM orders").status, "ready_for_pickup");

  // The second one is only reachable from the first, which is the state
  // machine doing the refusing rather than the markup.
  const collected = await postAction({
    intent: "mark_collected",
    orderNumber: placed.orderNumber,
    csrf: session.csrf,
  });
  assert.equal(collected.response.status, 200);
  const row = one("SELECT status, fulfilment_status AS f, payment_status AS pay FROM orders");
  assert.equal(row.status, "delivered");
  assert.equal(row.f, "fulfilled");
  assert.equal(row.pay, "unpaid", "handing the piece over is not a payment");

  const changes = rows("SELECT * FROM admin_audit_log WHERE action = 'order.status_changed'");
  assert.equal(changes.length, 2);
  for (const entry of changes) {
    assert.equal(entry.actor_email, ADMIN_EMAIL);
    const diff = JSON.parse(entry.diff_json);
    assert.ok(diff.status.to, "the workflow state is recorded by value");
    const serialised = JSON.stringify(entry);
    for (const secret of [CUSTOMER.name, CUSTOMER.phone, CUSTOMER.email]) {
      assert.equal(serialised.includes(secret), false, "no PII in the audit row");
    }
  }

  // A repeat of a transition that is no longer legal is refused, and the
  // refusal is the database's, not a WHERE clause quietly doing nothing.
  const again = await postAction({
    intent: "mark_ready",
    orderNumber: placed.orderNumber,
    csrf: session.csrf,
  });
  assert.equal(again.response.status, 409);
  assert.equal(one("SELECT status FROM orders").status, "delivered");
});

/* =========================================================================
 * 5. CANCELLING
 * ====================================================================== */

test("CANCELLING RECORDS WHO AND WHY, AND PUTS THE PIECE BACK", async () => {
  const placed = await placeAnOrder();
  assert.equal(stockOf(), 0, "placing an order takes the piece off the wall");

  // The confirmation is a page, and it repeats the number so a mis-tap from
  // the list cannot cancel the wrong order.
  const confirm = await getPage(`/admin/orders/${placed.orderNumber}?action=cancel`);
  assert.equal(confirm.response.status, 200);
  assert.ok(confirm.html.includes(`Yes, cancel ${placed.orderNumber}`));
  assert.ok(confirm.html.includes("cannot be removed"));
  assert.ok(confirm.html.includes('name="reasonCode"'), "the reason is asked for, not assumed");

  const cancelled = await postAction({
    intent: "cancel",
    orderNumber: placed.orderNumber,
    reasonCode: "customer_request",
    note: "Rang and said she would come in instead.",
    csrf: session.csrf,
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.notice, "cancelled");

  const order = one(
    `SELECT status, cancelled_at AS at, cancelled_by AS by, cancellation_reason_code AS code,
            cancellation_note AS note
       FROM orders`
  );
  assert.equal(order.status, "cancelled");
  assert.ok(order.at);
  assert.equal(order.by, ADMIN_EMAIL, "a cancellation nobody is named for is a false trail");
  assert.equal(order.code, "customer_request");
  assert.ok(order.note && order.note.length > 0, "Rule 4(8) turns on why the order ended");
  assert.equal(stockOf(), 1, "the piece is back on the wall");

  const audit = one("SELECT * FROM admin_audit_log WHERE action = 'order.cancelled'");
  assert.ok(audit, "the machine record of the act");
  assert.equal(audit.actor_email, ADMIN_EMAIL);
  assert.equal(
    JSON.stringify(audit).includes(order.note),
    false,
    "the human sentence stays on the order and out of the log"
  );
});

test("cancelling twice restores the stock once — the guarantee is upstream and is not defeated here", async () => {
  const placed = await placeAnOrder();

  const body = {
    intent: "cancel",
    orderNumber: placed.orderNumber,
    reasonCode: "customer_request",
    note: "Changed her mind.",
    csrf: session.csrf,
  };

  const first = await postAction(body);
  assert.equal(first.body.notice, "cancelled");
  assert.equal(stockOf(), 1);

  const second = await postAction(body);
  assert.equal(second.response.status, 200);
  assert.equal(second.body.notice, "already-cancelled");
  assert.equal(second.body.ok, false, "the second call placed nothing and says so");

  assert.equal(stockOf(), 1, "a one-of-a-kind piece must never be restored twice");
  assert.equal(
    one("SELECT count(*) AS c FROM admin_audit_log WHERE action = 'order.cancelled'").c,
    1,
    "and the act is recorded once"
  );

  // The order stays in the book. There is no delete anywhere.
  assert.equal(one("SELECT count(*) AS c FROM orders").c, 1);
  assert.equal(one("SELECT count(*) AS c FROM order_items").c, 1);
});

test("a cancellation with no reason is refused, and changes nothing", async () => {
  const placed = await placeAnOrder();

  for (const reasonCode of ["", "because", "customer-request"]) {
    const attempt = await postAction({
      intent: "cancel",
      orderNumber: placed.orderNumber,
      reasonCode,
      csrf: session.csrf,
    });
    assert.equal(attempt.response.status, 400);
    assert.equal(attempt.body.notice, "needs-reason");
  }

  assert.equal(one("SELECT status FROM orders").status, "pending_payment");
  assert.equal(stockOf(), 0);
});

test("a cancelled order says so in the shop's words and offers nothing further", async () => {
  const placed = await placeAnOrder();
  await postAction({
    intent: "cancel",
    orderNumber: placed.orderNumber,
    reasonCode: "piece_unavailable",
    note: "Promised to another customer.",
    csrf: session.csrf,
  });

  const { html } = await getPage(`/admin/orders/${placed.orderNumber}`);
  assert.ok(html.includes(statusWord("cancelled")));
  assert.equal(html.includes("Cancel this order"), false);
  assert.ok(html.includes("nothing left to do"));
  // The bill survives a cancellation: it is still a record.
  assert.ok(html.includes("Bill of sale"));
});

/* =========================================================================
 * 6. THE AUDIT TRAIL
 * ====================================================================== */

test("OPENING AN ORDER IS LOGGED, AND THE LOG ROW CARRIES NO PII", async () => {
  const placed = await placeAnOrder();
  const orderId = one("SELECT id FROM orders").id;

  await getPage(`/admin/orders/${placed.orderNumber}`);

  const opened = rows("SELECT * FROM admin_audit_log WHERE action = 'customer_data.record_opened'");
  assert.ok(opened.length >= 1, "DPDP Rule 6(1)(c): a read of personal data must be visible");

  for (const entry of opened) {
    assert.equal(entry.actor_email, ADMIN_EMAIL, "who looked");
    assert.equal(entry.entity_type, "order");
    assert.equal(entry.entity_id, orderId, "which record");
    assert.equal(entry.diff_json, null, "and nothing about the customer themselves");

    const serialised = JSON.stringify(entry);
    for (const secret of [CUSTOMER.name, CUSTOMER.phone, CUSTOMER.email, placed.orderNumber]) {
      assert.equal(
        serialised.includes(secret),
        false,
        "the audit table is outside the erasure job's reach and must hold no copy"
      );
    }
  }
});

test("a search is logged by the fields it used, never by what was typed", async () => {
  await placeAnOrder();
  await getPage("/admin/orders?q=9812345678");

  const searches = rows("SELECT * FROM admin_audit_log WHERE action = 'customer_data.search_run'");
  assert.ok(searches.length >= 1);

  const last = searches[searches.length - 1];
  const diff = JSON.parse(last.diff_json);
  assert.ok(diff.fields, "which fields were searched");
  assert.equal(typeof diff.results.to, "number", "and how many rows came back");

  const serialised = JSON.stringify(last);
  assert.equal(serialised.includes("9812345678"), false, "the term itself is personal data");
  assert.equal(serialised.includes(CUSTOMER.name), false);
});
