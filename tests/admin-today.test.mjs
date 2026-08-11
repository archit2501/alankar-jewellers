const { known } = await import("../app/site-config.ts");

/**
 * TODAY — the queue, the empty state, the torn order, and the read log.
 *
 * ===========================================================================
 * WHAT IS NOT MOCKED
 * ===========================================================================
 * The queue is a union across three real tables with real CHECK constraints, so
 * every test below runs against a REAL SQLite database built from this
 * project's own `drizzle/*.sql` and seeded with this project's own seed,
 * through the SAME `d1CartDb()` adapter production uses. A stubbed row would
 * prove only that the stub returned what it was told to — and two of the things
 * under test here (a torn order, and the catalogue gap) are properties of what
 * is actually on disk.
 *
 * The gate and the rendered page are exercised through the BUILT Worker
 * (`npm test` builds first), so `proxy.ts`, the layout's `requireAdmin()` call
 * and the markup are tested as bundled rather than as source.
 *
 * ===========================================================================
 * THE SECTIONS
 * ===========================================================================
 *  1. Time, in the shop's zone and the shop's words.
 *  2. The queue: the merge, the order, and the two rules it must never break —
 *     an ordinary order carries no deadline, and is never called a complaint.
 *  3. The torn order: reported, never totalled.
 *  4. The empty state: the four real gaps, each checked against code.
 *  5. The read log: written, and carrying no customer's data.
 *  6. The gate and the rendered page, through the built Worker.
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

const { ADMIN_SESSION_COOKIE, toCookieValue, newSessionToken } = await import(
  "../app/_admin/session.ts"
);

const {
  TORN_ORDER_SUMMARY,
  formatIstClock,
  formatWhen,
  listAdminOrders,
  readAdminOrderDetail,
  readRateStanding,
  readSetupGaps,
  readTodayQueue,
  readTodayTally,
  resolveAdmin,
  toIso,
} = await import("../app/_admin/data.ts");

const { d1CartDb } = await import("../app/_data/cart.ts");
const { SITE_DETAILS_PENDING } = await import("../app/site-config.ts");
const { PAYMENT_CAPTURE_ENABLED } = await import("../app/_data/orders.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* =========================================================================
 * Fixtures
 * ====================================================================== */

const PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const SESSION_SECRET = "test-session-secret-fedcba9876543210";
const ADMIN_EMAIL = "owner@alankar.test";
const ORIGIN = "http://localhost";

/** T0 for every clock in this file. Nothing here reads the wall clock. */
const T0 = Date.parse("2026-08-09T09:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/** The people in the fixtures. Their details must never reach the audit log. */
const PRIYA = { name: "Priya Sharma", phone: "+919876543210", email: "priya@example.test" };
const RAKESH = { name: "Rakesh Mehta", phone: "+919812345678" };
const ANJALI = { name: "Anjali Rao", phone: "+919800000001" };

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

/** The same D1-shaped client over node:sqlite the other suites use. */
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

function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const dir = path.join(ROOT, "drizzle");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no migration to build the fixture from");

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

let sqlite;
let db;
let passphrase;

/**
 * One valid order. The money legs foot because the CHECK constraints are real:
 * taxable = the components, total = taxable + gst, gst = cgst + sgst, and
 * advance + balance = total.
 */
function insertOrder({
  id,
  orderNumber,
  contact,
  placedAt,
  totalPaise = 103_000,
  lineItemCount = 1,
  lines = 1,
  status = "pending_payment",
  fulfilmentStatus = "unfulfilled",
}) {
  const gst = Math.round((totalPaise * 3) / 103);
  const taxable = totalPaise - gst;

  sqlite
    .prepare(
      `INSERT INTO orders
         (id, order_number, contact_name, contact_phone, contact_email,
          metal_value_paise, making_charges_paise, stone_value_paise,
          taxable_paise, gst_paise, cgst_paise, sgst_paise, total_paise,
          payment_plan, fulfilment_mode, advance_due_paise, balance_due_paise,
          status, fulfilment_status, line_item_count, placed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 'full_prepaid', 'store_pickup',
               ?, 0, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      orderNumber,
      contact.name,
      contact.phone,
      contact.email ?? null,
      taxable,
      taxable,
      gst,
      Math.floor(gst / 2),
      gst - Math.floor(gst / 2),
      totalPaise,
      totalPaise,
      status,
      fulfilmentStatus,
      lineItemCount,
      placedAt,
      placedAt
    );

  for (let index = 0; index < lines; index += 1) {
    sqlite
      .prepare(
        `INSERT INTO order_items
           (id, order_id, sku, title_snapshot, metal_snapshot, fineness_snapshot,
            purity_carat_label_snapshot, net_metal_weight_mg,
            metal_value_paise, quantity, unit_price_paise,
            line_subtotal_paise, line_gst_paise, line_total_paise)
         VALUES (?, ?, ?, ?, 'gold', 916, '22K (916)', 18400, ?, 1, ?, ?, ?, ?)`
      )
      .run(
        `${id}-item-${index}`,
        id,
        `AJ-SKU-${index}`,
        "Polki necklace",
        taxable,
        taxable,
        taxable,
        gst,
        totalPaise
      );
  }
}

function insertAppointment({ contact, interest, preferredTime, createdAt, status = "new" }) {
  sqlite
    .prepare(
      `INSERT INTO appointments (name, phone, interest, preferred_time, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(contact.name, contact.phone, interest, preferredTime, createdAt, status);
}

function insertTicket({
  id,
  ticketNumber,
  contact,
  kind = "complaint",
  subject,
  acknowledgeDueAt,
  acknowledgedAt = null,
  redressDueAt,
  createdAt,
  status = "open",
}) {
  sqlite
    .prepare(
      `INSERT INTO support_tickets
         (id, ticket_number, contact_name, contact_phone, kind, subject, status,
          acknowledge_due_at, acknowledged_at, redress_due_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      id,
      ticketNumber,
      contact.name,
      contact.phone,
      kind,
      subject,
      status,
      acknowledgeDueAt,
      acknowledgedAt,
      redressDueAt,
      createdAt,
      createdAt
    );
}

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
       VALUES ('adm_owner', ?, 'Shop owner', 'owner', 1, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      ADMIN_EMAIL,
      new Date(T0 - DAY).toISOString(),
      hash,
      salt,
      ADMIN_KDF_ALGO,
      iterations,
      new Date(T0 - DAY).toISOString()
    );
}

const ACTOR = { email: ADMIN_EMAIL, adminUserId: "adm_owner", ip: null, userAgent: null };

function auditRows() {
  return sqlite.prepare("SELECT * FROM admin_audit_log ORDER BY created_at, id").all();
}

function setCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

/** Sign in through the real endpoint and return the cookie header to reuse. */
async function signedInCookie() {
  const response = await fetchWorker("/api/admin/session", {
    method: "POST",
    headers: {
      host: "localhost",
      origin: ORIGIN,
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: passphrase }),
    redirect: "manual",
  });

  const [cookie] = setCookies(response);
  assert.ok(cookie, `expected a session cookie, got status ${response.status}`);
  return cookie.split(";")[0];
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
  sqlite.exec("DELETE FROM order_items;");
  sqlite.exec("DELETE FROM orders;");
  sqlite.exec("DELETE FROM appointments;");
  sqlite.exec("DELETE FROM support_tickets;");
  sqlite.exec("DELETE FROM gold_rates;");
  sqlite.exec("DELETE FROM admin_audit_log;");
  sqlite.exec("DELETE FROM admin_sessions;");
  sqlite.exec("DELETE FROM admin_users;");
  await seatAdmin(passphrase);
});

after(() => {
  delete env.DB;
  delete env.ADMIN_PASSWORD_PEPPER;
  delete env.ADMIN_SESSION_SECRET;
  delete env.ADMIN_KDF_ITERATIONS;
  sqlite?.close();
});

/* =========================================================================
 * 1. Time
 * ====================================================================== */

test("either timestamp form normalises to the same instant", () => {
  // The application writes ISO with a Z; CURRENT_TIMESTAMP writes a space and
  // no zone, which Date.parse would read as LOCAL time.
  assert.equal(toIso("2026-08-09 09:00:00"), "2026-08-09T09:00:00.000Z");
  assert.equal(toIso("2026-08-09T09:00:00.000Z"), "2026-08-09T09:00:00.000Z");
  assert.equal(
    Date.parse(toIso("2026-08-09 09:00:00")),
    Date.parse("2026-08-09T09:00:00.000Z")
  );
  assert.equal(toIso(null), null);
});

test("moments are spoken in Indian time, never in ISO", () => {
  // 09:00 UTC is 2:30 pm IST.
  assert.equal(formatIstClock(T0), "2:30 pm");
  assert.equal(formatWhen(new Date(T0).toISOString(), T0), "today, 2:30 pm");
  assert.equal(formatWhen(new Date(T0 - DAY).toISOString(), T0), "yesterday, 2:30 pm");
  assert.equal(formatWhen(new Date(T0 + DAY).toISOString(), T0), "tomorrow, 2:30 pm");
  assert.match(formatWhen(new Date(T0 + 3 * DAY).toISOString(), T0), /^[A-Z][a-z]+, 2:30 pm$/);
  assert.match(formatWhen(new Date(T0 + 40 * DAY).toISOString(), T0), /^\d{1,2} [A-Z][a-z]{2}, /);

  // A timestamp just after 6:30 pm UTC is the NEXT day in IST, and the screen
  // must say so — the owner is standing in Jaipur, not in UTC.
  assert.equal(formatIstClock(Date.parse("2026-08-09T19:00:00.000Z")), "12:30 am");
});

/* =========================================================================
 * 2. The queue
 * ====================================================================== */

test("the queue merges orders, enquiries and open complaints into one list", async () => {
  insertOrder({
    id: "ord_1",
    orderNumber: "AJ-2608-AAAAAA",
    contact: PRIYA,
    placedAt: new Date(T0 - 3 * HOUR).toISOString(),
  });
  insertAppointment({
    contact: ANJALI,
    interest: "Polki",
    preferredTime: "Saturday evening",
    createdAt: new Date(T0 - 2 * HOUR).toISOString(),
  });
  insertTicket({
    id: "tkt_1",
    ticketNumber: "AJ-C-2608-BBBBBB",
    contact: RAKESH,
    subject: "The clasp came loose",
    acknowledgeDueAt: new Date(T0 + 20 * HOUR).toISOString(),
    redressDueAt: new Date(T0 + 30 * DAY).toISOString(),
    createdAt: new Date(T0 - HOUR).toISOString(),
  });

  const queue = await readTodayQueue(db, { actor: ACTOR, nowMs: T0 });

  assert.equal(queue.length, 3, "all three tables reach the one list");
  assert.deepEqual(
    [...new Set(queue.map((item) => item.kind))].sort(),
    ["appointment", "complaint", "order"]
  );

  // The unit of work is a person: every row carries one.
  for (const item of queue) {
    assert.ok(item.name, "a queue row without a name is not a person");
    assert.ok(item.phone, "the row must be callable");
  }
});

test("the queue sorts by obligation, not by recency or by money", async () => {
  // A ₹40,000 order placed three hours ago outranks nothing; a statutory clock
  // outranks everything.
  insertOrder({
    id: "ord_new",
    orderNumber: "AJ-2608-NEWEST",
    contact: PRIYA,
    placedAt: new Date(T0 - 5 * 60 * 1000).toISOString(),
    totalPaise: 41_200_000,
  });
  insertOrder({
    id: "ord_old",
    orderNumber: "AJ-2608-OLDEST",
    contact: RAKESH,
    placedAt: new Date(T0 - 3 * DAY).toISOString(),
    totalPaise: 4_000_000,
  });
  insertTicket({
    id: "tkt_late",
    ticketNumber: "AJ-C-2608-LATEST",
    contact: ANJALI,
    subject: "Nobody has rung back",
    acknowledgeDueAt: new Date(T0 - 3 * HOUR).toISOString(),
    redressDueAt: new Date(T0 + 20 * DAY).toISOString(),
    createdAt: new Date(T0 - 51 * HOUR).toISOString(),
  });
  insertTicket({
    id: "tkt_soon",
    ticketNumber: "AJ-C-2608-SOONER",
    contact: PRIYA,
    subject: "Wrong size",
    acknowledgeDueAt: new Date(T0 + 6 * HOUR).toISOString(),
    redressDueAt: new Date(T0 + 29 * DAY).toISOString(),
    createdAt: new Date(T0 - 42 * HOUR).toISOString(),
  });

  const queue = await readTodayQueue(db, { actor: ACTOR, nowMs: T0 });

  assert.deepEqual(
    queue.map((item) => item.reference),
    ["AJ-C-2608-LATEST", "AJ-C-2608-SOONER", "AJ-2608-OLDEST", "AJ-2608-NEWEST"],
    "deadlines first and earliest-first; then the longest wait, whatever it is worth"
  );

  assert.equal(queue[0].overdue, true, "a breached deadline is marked, not merely first");
  assert.equal(queue[1].overdue, false);
});

test("an ordinary order carries no deadline and is never called a complaint", async () => {
  insertOrder({
    id: "ord_1",
    orderNumber: "AJ-2608-AAAAAA",
    contact: PRIYA,
    placedAt: new Date(T0 - HOUR).toISOString(),
  });
  insertAppointment({
    contact: ANJALI,
    interest: "Jadau",
    preferredTime: "Sunday",
    createdAt: new Date(T0 - HOUR).toISOString(),
  });

  const queue = await readTodayQueue(db, { actor: ACTOR, nowMs: T0 });

  for (const item of queue) {
    assert.equal(
      item.dueAt,
      null,
      "phase 0 removed the clock every order used to open; nothing here may put it back"
    );
    assert.equal(item.overdue, false);
    assert.doesNotMatch(
      item.summary,
      /complaint/i,
      "an owner who reads '14 complaints' against 14 orders closes the app"
    );
  }
});

test("a genuine complaint keeps its clock, and switches to the redress clock once answered", async () => {
  insertTicket({
    id: "tkt_open",
    ticketNumber: "AJ-C-2608-OPENED",
    contact: PRIYA,
    subject: "The stone is loose",
    acknowledgeDueAt: new Date(T0 + 10 * HOUR).toISOString(),
    redressDueAt: new Date(T0 + 29 * DAY).toISOString(),
    createdAt: new Date(T0 - 38 * HOUR).toISOString(),
  });
  insertTicket({
    id: "tkt_ack",
    ticketNumber: "AJ-C-2608-ANSWER",
    contact: RAKESH,
    subject: "Wants a different size",
    kind: "exchange",
    status: "acknowledged",
    acknowledgeDueAt: new Date(T0 - 10 * HOUR).toISOString(),
    acknowledgedAt: new Date(T0 - 11 * HOUR).toISOString(),
    redressDueAt: new Date(T0 + 25 * DAY).toISOString(),
    createdAt: new Date(T0 - 58 * HOUR).toISOString(),
  });

  const queue = await readTodayQueue(db, { actor: ACTOR, nowMs: T0 });
  const open = queue.find((item) => item.reference === "AJ-C-2608-OPENED");
  const answered = queue.find((item) => item.reference === "AJ-C-2608-ANSWER");

  assert.equal(open.dueAt, new Date(T0 + 10 * HOUR).toISOString(), "Rule 4(5), 48 hours");
  assert.equal(open.overdue, false);
  assert.match(open.summary, /^Problem raised/, "a real complaint is named as a problem raised");

  assert.equal(
    answered.dueAt,
    new Date(T0 + 25 * DAY).toISOString(),
    "once acknowledged the live clock is the one-month redressal clock"
  );
  assert.equal(answered.overdue, false);
  assert.doesNotMatch(answered.summary, /complaint/i, "an exchange is not a complaint");
});

test("a resolved ticket, a booked enquiry and a delivered order leave the queue", async () => {
  insertOrder({
    id: "ord_done",
    orderNumber: "AJ-2608-DONEDN",
    contact: PRIYA,
    placedAt: new Date(T0 - DAY).toISOString(),
    status: "delivered",
    fulfilmentStatus: "fulfilled",
  });
  insertAppointment({
    contact: ANJALI,
    interest: "Kundan",
    preferredTime: "Friday",
    createdAt: new Date(T0 - DAY).toISOString(),
    status: "booked",
  });
  insertTicket({
    id: "tkt_done",
    ticketNumber: "AJ-C-2608-CLOSED",
    contact: RAKESH,
    subject: "Sorted at the counter",
    status: "resolved",
    acknowledgeDueAt: new Date(T0 - DAY).toISOString(),
    redressDueAt: new Date(T0 + 20 * DAY).toISOString(),
    createdAt: new Date(T0 - 2 * DAY).toISOString(),
  });

  const queue = await readTodayQueue(db, { actor: ACTOR, nowMs: T0 });
  assert.deepEqual(queue, [], "the queue is work outstanding, not a table view");
});

/* =========================================================================
 * 3. The torn order
 * ====================================================================== */

test("a torn order is reported, never rendered as a figure", async () => {
  insertOrder({
    id: "ord_torn",
    orderNumber: "AJ-2608-TORNNN",
    contact: PRIYA,
    placedAt: new Date(T0 - 2 * HOUR).toISOString(),
    totalPaise: 777_777,
    lineItemCount: 2,
    lines: 1,
  });

  const queue = await readTodayQueue(db, { actor: ACTOR, nowMs: T0 });
  assert.equal(queue.length, 1);
  assert.equal(queue[0].summary, TORN_ORDER_SUMMARY);
  assert.doesNotMatch(queue[0].summary, /₹|\d[\d,]*\.\d\d/, "no figure is quoted for a torn order");

  const [row] = await listAdminOrders(db, { actor: ACTOR, nowMs: T0 });
  assert.equal(row.intact, false);
  assert.equal(row.totalPaise, null, "a partial sum is never presented as a total");
  assert.equal(row.lineCount, 2, "what the order SAYS it holds is still reported");

  const detail = await readAdminOrderDetail(db, "AJ-2608-TORNNN", { actor: ACTOR, nowMs: T0 });
  assert.equal(detail.intact, false);
  assert.equal(detail.totalPaise, null);
  assert.deepEqual(detail.lines, [], "half a bill is worse than an error message");
});

test("an intact order totals, itemises, and offers no payment action while capture is off", async () => {
  insertOrder({
    id: "ord_ok",
    orderNumber: "AJ-2608-INTACT",
    contact: PRIYA,
    placedAt: new Date(T0 - 2 * HOUR).toISOString(),
    totalPaise: 103_000,
  });

  const detail = await readAdminOrderDetail(db, "AJ-2608-INTACT", { actor: ACTOR, nowMs: T0 });

  assert.equal(detail.intact, true);
  assert.equal(detail.totalPaise, 103_000);
  assert.equal(detail.lines.length, 1);
  assert.equal(detail.contact.phone, PRIYA.phone);
  assert.ok(
    detail.lines[0].breakup.some((part) => part.label === "GST"),
    "the breakup is a statutory document and has to itemise"
  );

  assert.equal(PAYMENT_CAPTURE_ENABLED, false, "the flag is on; this test's premise is gone");
  assert.ok(
    detail.paymentActionsBlockedReason,
    "with capture off the screen must say why no money can be recorded"
  );
  for (const action of detail.allowedActions) {
    assert.ok(
      ["cancel", "mark_ready", "mark_collected"].includes(action),
      "no admin action may express a payment state nobody authorised"
    );
  }

  assert.equal(
    await readAdminOrderDetail(db, "AJ-2608-MISSING", { actor: ACTOR, nowMs: T0 }),
    null
  );
});

/* =========================================================================
 * 4. The empty state
 * ====================================================================== */

test("the empty state lists the four real gaps, each checked against code", async () => {
  const gaps = await readSetupGaps(db);

  assert.deepEqual(
    gaps.map((gap) => gap.id),
    ["contact_details", "catalogue", "gold_rate", "payment_capture"]
  );

  const by = Object.fromEntries(gaps.map((gap) => [gap.id, gap]));

  // Each of these mirrors a fact that is true in this repo today.
  assert.equal(by.contact_details.resolved, !SITE_DETAILS_PENDING);
  assert.equal(by.contact_details.resolved, false);

  assert.equal(by.payment_capture.resolved, PAYMENT_CAPTURE_ENABLED);
  assert.equal(by.payment_capture.resolved, false);

  // The seeded catalogue is the five heirloom pieces plus four demonstration
  // pieces that DO carry a weight and a fineness. The gap reports the database
  // rather than an opinion about it, so it resolves — and the wording has to
  // follow, because "none has been weighed" is now simply false.
  const active = sqlite
    .prepare("SELECT COUNT(*) AS n FROM products WHERE status = 'active'")
    .get().n;
  const priceable = sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM variants
        WHERE pricing_mode = 'dynamic_metal'
          AND net_metal_weight_mg IS NOT NULL AND fineness IS NOT NULL`
    )
    .get().n;
  assert.ok(active > 0, "the fixture has no catalogue, so this proves nothing");
  assert.ok(priceable > 0, "the fixture has no priceable piece, so this proves nothing");
  assert.equal(by.catalogue.resolved, true);
  assert.doesNotMatch(
    by.catalogue.title,
    /weighed or assayed/,
    "the gap claims nothing has been weighed while the fixture holds pieces that have"
  );

  assert.equal(by.gold_rate.resolved, false, "no rate has ever been ingested");

  for (const gap of gaps) {
    assert.ok(gap.title.length > 0 && gap.detail.length > 0, "a gap with no action is a blank slate");
  }
});

test("a gap resolves itself out of the list when the thing it names is done", async () => {
  sqlite
    .prepare(
      `INSERT INTO gold_rates
         (id, metal, fineness, rate_per_ten_grams_paise, source, effective_from, created_at)
       VALUES ('rate_1', 'gold', 916, 7324000, 'ibja', ?, ?)`
    )
    .run(new Date(T0 - HOUR).toISOString(), new Date(T0 - HOUR).toISOString());

  const gaps = await readSetupGaps(db);
  const rate = gaps.find((gap) => gap.id === "gold_rate");
  assert.equal(rate.resolved, true);

  // And once a piece is priceable, so does the catalogue gap. The seed is
  // restored afterwards: it is the fixture every other test reads, and a test
  // that leaves the catalogue sellable would quietly delete the gap the empty
  // state exists to show.
  const before = sqlite
    .prepare("SELECT id, pricing_mode, net_metal_weight_mg, fineness FROM variants LIMIT 1")
    .get();

  sqlite
    .prepare(
      `UPDATE variants
          SET pricing_mode = 'dynamic_metal', net_metal_weight_mg = 18400, fineness = 916
        WHERE id = ?`
    )
    .run(before.id);

  try {
    const after = await readSetupGaps(db);
    assert.equal(after.find((gap) => gap.id === "catalogue").resolved, true);
  } finally {
    sqlite
      .prepare(
        `UPDATE variants
            SET pricing_mode = ?, net_metal_weight_mg = ?, fineness = ?
          WHERE id = ?`
      )
      .run(before.pricing_mode, before.net_metal_weight_mg, before.fineness, before.id);
  }
});

test("the rate is one quiet line until it is wrong, and nothing at all before it exists", async () => {
  const missing = await readRateStanding(db, { nowMs: T0 });
  assert.equal(missing.everRecorded, false);
  assert.equal(missing.lookup, null, "no rate at all is a setup gap, not an alarm");

  sqlite
    .prepare(
      `INSERT INTO gold_rates
         (id, metal, fineness, rate_per_ten_grams_paise, source, effective_from, created_at)
       VALUES ('rate_1', 'gold', 916, 7324000, 'ibja', ?, ?)`
    )
    .run(new Date(T0 - 30 * 60 * 1000).toISOString(), new Date(T0).toISOString());

  const fresh = await readRateStanding(db, { nowMs: T0 });
  assert.equal(fresh.everRecorded, true);
  assert.equal(fresh.lookup.ok, true);

  // Four days later the same row is stale, and the storefront cannot price.
  const stale = await readRateStanding(db, { nowMs: T0 + 5 * DAY });
  assert.equal(stale.lookup.ok, false);
  assert.equal(stale.lookup.reason, "rate_stale");
});

test("today's tally counts what was recorded, and refuses to total a torn order", async () => {
  insertOrder({
    id: "ord_today",
    orderNumber: "AJ-2608-TODAY1",
    contact: PRIYA,
    placedAt: new Date(T0 - HOUR).toISOString(),
    totalPaise: 200_000,
  });
  insertOrder({
    id: "ord_torn",
    orderNumber: "AJ-2608-TORNNN",
    contact: RAKESH,
    placedAt: new Date(T0 - HOUR).toISOString(),
    totalPaise: 777_777,
    lineItemCount: 2,
    lines: 1,
  });
  // The SQLite default writes `YYYY-MM-DD HH:MM:SS`; the tally must still see it.
  insertAppointment({
    contact: ANJALI,
    interest: "Polki",
    preferredTime: "Saturday",
    createdAt: new Date(T0 - HOUR).toISOString().replace("T", " ").slice(0, 19),
  });

  const tally = await readTodayTally(db, { nowMs: T0 });
  assert.equal(tally.orders, 2);
  assert.equal(tally.ordersTotalPaise, 200_000, "the torn order is not in the sum");
  assert.equal(tally.tornOrders, 1, "and it is reported rather than dropped");
  assert.equal(tally.enquiries, 1);
});

/* =========================================================================
 * 5. The read log
 * ====================================================================== */

test("reading the queue writes a read log, and opening a record writes another", async () => {
  insertOrder({
    id: "ord_1",
    orderNumber: "AJ-2608-AAAAAA",
    contact: PRIYA,
    placedAt: new Date(T0 - HOUR).toISOString(),
  });

  await readTodayQueue(db, { actor: ACTOR, nowMs: T0 });
  await readAdminOrderDetail(db, "AJ-2608-AAAAAA", { actor: ACTOR, nowMs: T0 });

  const rows = auditRows();
  const actions = rows.map((row) => row.action);

  assert.ok(
    actions.includes("customer_data.search_run"),
    "DPDP Rule 6(1)(c) obliges visibility on ACCESS, not only on change"
  );
  assert.ok(actions.includes("customer_data.record_opened"));

  const opened = rows.find((row) => row.action === "customer_data.record_opened");
  assert.equal(opened.entity_type, "order");
  assert.equal(opened.entity_id, "ord_1", "the internal id, so the read is answerable");
  assert.equal(opened.actor_email, ADMIN_EMAIL);
  assert.equal(opened.result, "ok");

  const searched = rows.find((row) => row.action === "customer_data.search_run");
  assert.deepEqual(JSON.parse(searched.diff_json), {
    fields: { from: null, to: "today_queue" },
    results: { from: null, to: 1 },
  });
});

test("the read log carries no customer's data — that is the whole point of it", async () => {
  insertOrder({
    id: "ord_1",
    orderNumber: "AJ-2608-AAAAAA",
    contact: PRIYA,
    placedAt: new Date(T0 - HOUR).toISOString(),
  });
  insertAppointment({
    contact: ANJALI,
    interest: "Polki",
    preferredTime: "Saturday evening",
    createdAt: new Date(T0 - HOUR).toISOString(),
  });
  insertTicket({
    id: "tkt_1",
    ticketNumber: "AJ-C-2608-BBBBBB",
    contact: RAKESH,
    subject: "The clasp came loose",
    acknowledgeDueAt: new Date(T0 + HOUR).toISOString(),
    redressDueAt: new Date(T0 + 20 * DAY).toISOString(),
    createdAt: new Date(T0 - HOUR).toISOString(),
  });

  await readTodayQueue(db, { actor: ACTOR, nowMs: T0 });
  await readAdminOrderDetail(db, "AJ-2608-AAAAAA", { actor: ACTOR, nowMs: T0 });
  await listAdminOrders(db, { actor: ACTOR, search: PRIYA.phone, nowMs: T0 });

  const dump = JSON.stringify(auditRows());

  for (const secret of [
    PRIYA.name,
    PRIYA.phone,
    PRIYA.email,
    RAKESH.name,
    RAKESH.phone,
    ANJALI.name,
    ANJALI.phone,
    "The clasp came loose",
    "Saturday evening",
  ]) {
    assert.ok(
      !dump.includes(secret),
      `the audit log is a second copy of "${secret}", outside the erasure job's reach`
    );
  }

  // A search records WHICH FIELDS were looked in, never what was typed.
  const search = auditRows()
    .filter((row) => row.action === "customer_data.search_run")
    .map((row) => JSON.parse(row.diff_json));
  assert.ok(
    search.some((diff) => diff.fields.to.includes("contact_phone")),
    "the fields searched are recorded"
  );
});

test("nothing can read a customer without an admin to attribute the read to", async () => {
  // `resolveAdmin` is what a screen must call before it may read anything, and
  // every failing shape of request has to come back the same way: null.
  assert.equal(await resolveAdmin({ cookie: null }, { db }), null);
  assert.equal(await resolveAdmin({ cookie: "not-a-cookie" }, { db }), null);
  assert.equal(
    await resolveAdmin(
      { cookie: `${ADMIN_SESSION_COOKIE}=${await toCookieValue(newSessionToken())}` },
      { db }
    ),
    null,
    "a correctly-signed token with no row behind it is not a session"
  );
});

/* =========================================================================
 * 6. The gate, and the rendered page
 * ====================================================================== */

test("an unauthenticated request to /admin is refused", async () => {
  const response = await fetchWorker("/admin", {
    headers: { accept: "text/html" },
    redirect: "manual",
  });

  assert.ok(
    [301, 302, 303, 307, 308].includes(response.status),
    `an anonymous request must not be answered with a page (got ${response.status})`
  );
  assert.match(response.headers.get("location") ?? "", /\/admin\/login/);

  const body = await response.text();
  assert.doesNotMatch(body, /Needs you/, "no part of the screen leaks before the gate");
});

test("a correctly-signed cookie for a session that does not exist is refused too", async () => {
  // proxy.ts checks only the signature and lets this through; the layout's
  // requireAdmin() is what refuses it. This is the test that the second gate
  // exists at all.
  const cookie = `${ADMIN_SESSION_COOKIE}=${await toCookieValue(newSessionToken())}`;

  const response = await fetchWorker("/admin", {
    headers: { accept: "text/html", cookie },
    redirect: "manual",
  });

  assert.ok(
    [301, 302, 303, 307, 308].includes(response.status),
    `a session that is not in the database must be refused (got ${response.status})`
  );
  assert.match(response.headers.get("location") ?? "", /\/admin\/login/);
});

test("signed in with nothing waiting, Today is a to-do list for opening the shop", async () => {
  const cookie = await signedInCookie();
  const response = await fetchWorker("/admin", {
    headers: { accept: "text/html", cookie },
    redirect: "manual",
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);

  const html = await response.text();

  assert.equal((html.match(/<h1/g) ?? []).length, 1, "exactly one h1 per screen");
  assert.equal((html.match(/<main/g) ?? []).length, 1, "one main landmark, owned by the layout");
  assert.match(html, /Nothing is waiting/);

  // The screen that matters most: the four real gaps, in words, with the fact
  // that makes each one true.
  assert.match(html, /Before the shop can take orders/);

  // The contact gap reports the state it is ACTUALLY in. It used to collapse
  // "we have a phone but no address" into the same sentence as "we have
  // nothing", which is how an owner who has already supplied a number is told
  // the site still has none — and stops trusting the list. Asserted off the
  // real flags so this keeps meaning something as facts arrive.
  if (known.phone && !known.address) {
    assert.match(html, /has a phone number, but no address/);
    assert.doesNotMatch(
      html,
      /no phone number or address/,
      "a supplied number must not still be reported as missing"
    );
  } else if (!known.phone) {
    assert.match(html, /no phone number or address/);
  }
  // The catalogue gap is RESOLVED in this fixture — the demonstration pieces
  // carry a weight and a fineness — and a resolved gap drops off the list
  // rather than sitting there claiming the shop still has work to do. Asserting
  // its absence is what proves resolution actually removes it.
  assert.doesNotMatch(
    html,
    /weighed or assayed/,
    "the panel says nothing has been weighed while the fixture holds pieces that have"
  );
  assert.match(html, /No gold rate has been recorded/);
  assert.match(html, /Card and UPI are switched off/);

  // Placeholder honesty: nothing on the screen invents a figure of takings.
  assert.doesNotMatch(html, /takings|revenue/i);
});

test("the rendered queue shows people, and never a deadline or the word complaint on an order", async () => {
  const now = Date.now();
  insertOrder({
    id: "ord_1",
    orderNumber: "AJ-2608-AAAAAA",
    contact: PRIYA,
    placedAt: new Date(now - HOUR).toISOString(),
    totalPaise: 18_450_000,
  });
  insertOrder({
    id: "ord_torn",
    orderNumber: "AJ-2608-TORNNN",
    contact: RAKESH,
    placedAt: new Date(now - 2 * HOUR).toISOString(),
    totalPaise: 777_777,
    lineItemCount: 2,
    lines: 1,
  });
  insertAppointment({
    contact: ANJALI,
    interest: "Polki",
    preferredTime: "Saturday evening",
    createdAt: new Date(now - 30 * 60 * 1000).toISOString(),
  });

  const cookie = await signedInCookie();
  const response = await fetchWorker("/admin", {
    headers: { accept: "text/html", cookie },
    redirect: "manual",
  });
  assert.equal(response.status, 200);
  const html = await response.text();

  // The person is what the owner recognises, and the row is callable.
  assert.match(html, /Priya Sharma/);
  assert.match(html, /Anjali Rao/);
  assert.match(html, new RegExp(`href="tel:\\${PRIYA.phone}"`));
  assert.match(html, /href="https:\/\/wa\.me\/919876543210/);

  // THE TWO RULES.
  assert.doesNotMatch(html, /complaint/i, "the word never appears against ordinary work");
  assert.doesNotMatch(html, /Reply (due|overdue|by)/, "an order carries no statutory clock");

  // The torn order is reported and its figure is refused.
  assert.match(html, /did not save fully/);
  assert.ok(!html.includes("7,777.77"), "a torn order is never totalled on screen");
  assert.match(html, /1,84,500/, "an intact order is, in Indian grouping");

  // And the read was logged.
  const actions = auditRows().map((row) => row.action);
  assert.ok(actions.includes("customer_data.search_run"), "rendering the queue is a read");
});

test("an overdue complaint reaches the top of the screen, in words as well as colour", async () => {
  const now = Date.now();
  insertOrder({
    id: "ord_1",
    orderNumber: "AJ-2608-AAAAAA",
    contact: PRIYA,
    placedAt: new Date(now - 3 * DAY).toISOString(),
  });
  insertTicket({
    id: "tkt_late",
    ticketNumber: "AJ-C-2608-LATEST",
    contact: RAKESH,
    subject: "Nobody has rung back",
    acknowledgeDueAt: new Date(now - 3 * HOUR).toISOString(),
    redressDueAt: new Date(now + 20 * DAY).toISOString(),
    createdAt: new Date(now - 51 * HOUR).toISOString(),
  });

  const cookie = await signedInCookie();
  const html = await (
    await fetchWorker("/admin", {
      headers: { accept: "text/html", cookie },
      redirect: "manual",
    })
  ).text();

  assert.match(html, /Reply overdue/, "the state is a word, never colour alone");
  assert.ok(
    html.indexOf("Rakesh Mehta") < html.indexOf("Priya Sharma"),
    "the statutory clock is above the order, whatever the order is worth"
  );
});
