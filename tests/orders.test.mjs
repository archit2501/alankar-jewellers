/**
 * CHECKOUT AND ORDER CREATION: the data layer, the endpoint, and /checkout.
 *
 * ===========================================================================
 * WHAT IS NOT MOCKED, AND WHY IT CANNOT BE
 * ===========================================================================
 * Two of the guarantees this feature rests on belong to SQLite, not to the
 * application, and a test that stubbed either would prove only that the stub
 * returned what it was told to:
 *
 *   THE IDEMPOTENCY COLLISION. `webhook_events.id` is a PRIMARY KEY and its
 *   insert sits inside the order batch, so a replay must destroy the entire
 *   duplicate placement — order, line items, payment row and stock decrement
 *   together. That is a property of a real transaction against a real primary
 *   key, so the test below places the same checkout twice against a real
 *   database and then counts rows.
 *
 *   THE OVERSELL REFUSAL. `CHECK (stock_quantity >= 0)` is what stops a
 *   one-of-a-kind piece being sold twice; the decrement deliberately carries no
 *   `WHERE stock_quantity >= ?` guard, because a WHERE clause would turn the
 *   violation into a silent no-op. The test below takes the piece away AFTER
 *   the quote is resolved and asserts that the constraint — not application
 *   code — destroys the placement.
 *
 * So every test in sections 2 to 4 runs against a REAL SQLite database built
 * from this project's own migration (`drizzle/*.sql`) and seeded with this
 * project's own seed, through the SAME `d1CartDb()` adapter production uses.
 * Nothing here touches `.wrangler`, D1, or the network. The database is
 * `:memory:`.
 *
 * ===========================================================================
 * FIVE KINDS OF TEST
 * ===========================================================================
 *  1. PURE. Handles, money legs, validation, the payment copy, and the
 *     unrepresentability of an unpriceable order.
 *  2. THE DATA LAYER, against the real schema: resolution, the single batch,
 *     the snapshot, idempotency, the oversell CHECK, the torn-write detector.
 *  3. THE ENDPOINT, through the built Worker with the same SQLite database
 *     injected as `env.DB`.
 *  4. THE RENDERED PAGE.
 *  5. THE CLAIMS THE REST OF THE SITE MAKES ABOUT ORDERING.
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
import { fetchWorker } from "./helpers.mjs";

const { CART_COOKIE, addToCart, d1CartDb, newCartToken } = await import(
  "../app/_data/cart.ts"
);
const { mostRecentPublicationAtOrBefore } = await import("../app/_pricing/rates.ts");
const {
  BOOKING_ADVANCE_BPS,
  CHECKOUT_NOTICES,
  PAN_REQUIRED_AT_PAISE,
  PAYMENT_CAPTURE_ENABLED,
  PriceableOrderCheckout,
  assertOrderIntact,
  checkoutHref,
  formatWeightMg,
  isOrderNumber,
  newOrderNumber,
  paymentLegs,
  paymentStanding,
  placeOrder,
  readOrderForCart,
  resolveCheckout,
  ticketNumberFor,
  toCheckoutFields,
  toCheckoutNotice,
  validateCheckoutDetails,
} = await import("../app/_data/orders.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* =========================================================================
 * A D1-shaped client over node:sqlite — test infrastructure only
 *
 * Identical in construction to tests/cart.test.mjs: `meta.changes` is SQLite's
 * own change count and is never synthesised, and `batch()` is BEGIN/COMMIT with
 * a ROLLBACK on throw, which is D1's "one batch is one transaction". Every
 * statement in a batch runs synchronously, so nothing can interleave inside a
 * transaction, exactly as D1 does not interleave.
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

/* =========================================================================
 * The database, built from the project's own migration and seed
 * ====================================================================== */

const SEED_SQL = buildSeedSql({ now: "2026-08-09T00:00:00.000Z" });

/** Re-apply the seed. Every statement is an upsert on a deterministic id, so
 *  this puts the catalogue back to placeholder inventory — `on_request`,
 *  `enquire_only`, nothing weighed — however a previous test mutated it. */
function reseed(sqlite) {
  sqlite.exec("BEGIN");
  for (const statement of SEED_SQL) sqlite.exec(statement);
  sqlite.exec("COMMIT");
}

function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const dir = path.join(ROOT, "drizzle");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no migration to test orders against");

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }

  reseed(sqlite);
  return sqlite;
}

/**
 * A fresh database, the production adapter over it, and `env.DB` pointed at it.
 *
 * The binding matters: the price engine takes its rate as an argument, but
 * `readCurrentRate()` reads `gold_rates` through `db/index.ts`, which reads
 * `env.DB`. Pointing it at the same database means the gold rate under test is
 * the one this database holds — the real fail-closed lookup, not an injected
 * stand-in for it. `beforeEach` puts the binding back for the Worker tests.
 */
function freshOrders() {
  const sqlite = migratedDatabase();
  const binding = d1Over(sqlite);
  env.DB = binding;
  return { sqlite, db: d1CartDb(binding) };
}

const HAAR = "jadau-haar";
const HAAR_VARIANT = "var_jadau-haar";
const CHOKER = "polki-choker";
const SHOP_STATE = "08"; // Rajasthan, for the intra-state case.
const AWAY_STATE = "27"; // Maharashtra, for the inter-state case.

/**
 * Turn a placeholder piece into a real, priceable, buyable one.
 *
 * The seed is deliberately unpriceable — every variant is `on_request`, nothing
 * is weighed, nothing is assayed, and every product is `enquire_only`. That is
 * the shop's true state and section 2's first test asserts it. To exercise the
 * order machinery at all, this writes the inventory a real piece would have:
 * a weight, a fineness, a making-charge rate card, `buy_online`, and a live
 * IBJA-shaped gold rate.
 *
 * `effective_from` is the most recent real publication slot, so the rate is
 * fresh against the actual clock however this suite is run — including at a
 * weekend, when the Friday evening rate is still the current one.
 */
function makePriceable(sqlite, options = {}) {
  const {
    slug = HAAR,
    variantId = HAAR_VARIANT,
    netMetalWeightMg = 12_345,
    fineness = 916,
    stockQuantity = 1,
    withRate = true,
  } = options;

  sqlite.prepare("UPDATE products SET sale_mode = 'buy_online' WHERE slug = ?").run(slug);
  sqlite
    .prepare(
      `UPDATE variants
       SET pricing_mode = 'dynamic_metal',
           fineness = ?,
           net_metal_weight_mg = ?,
           gross_weight_mg = ?,
           making_charge_type = 'percent',
           making_charge_value = 1200,
           stock_quantity = ?,
           is_unique_piece = ?
       WHERE id = ?`
    )
    .run(
      fineness,
      netMetalWeightMg,
      netMetalWeightMg + 2000,
      stockQuantity,
      stockQuantity > 1 ? 0 : 1,
      variantId
    );

  if (withRate) {
    const slotMs = mostRecentPublicationAtOrBefore(Date.now());
    const effectiveFrom = new Date(slotMs).toISOString();
    const existing = sqlite
      .prepare(
        "SELECT count(*) AS c FROM gold_rates WHERE metal = 'gold' AND fineness = ? AND effective_to IS NULL"
      )
      .get(fineness).c;
    if (existing === 0) {
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
          13_705_300, // ₹1,37,053 per 10 g — a real IBJA 916 figure, in paise.
          `ibja:${effectiveFrom}`,
          "137053",
          effectiveFrom,
          effectiveFrom
        );
    }
  }
}

function count(sqlite, sql, ...params) {
  return sqlite.prepare(sql).get(...params).c;
}

/** A cart holding one priceable piece, resolved and ready to place. */
async function readyCheckout(sqlite, db, options = {}) {
  makePriceable(sqlite, options);
  const added = await addToCart(db, { token: null, slug: options.slug ?? HAAR });
  assert.equal(added.ok, true);

  const resolution = await resolveCheckout(db, {
    token: added.cartId,
    shopStateCode: SHOP_STATE,
  });
  assert.equal(resolution.ok, true, `resolution blocked: ${JSON.stringify(resolution)}`);
  return { cartId: added.cartId, resolution };
}

const PICKUP_DETAILS = {
  name: "Meera Sharma",
  phone: "+919812345678",
  email: "meera@example.com",
  fulfilmentMode: "store_pickup",
  paymentPlan: "full_prepaid",
  ship: null,
  pan: null,
  gstin: null,
  notes: null,
  marketingOptIn: false,
};

/* =========================================================================
 * 1. Pure — the guarantees that need no database
 * ====================================================================== */

test("an order number is dated, unguessable and not a sequence", () => {
  const number = newOrderNumber(Date.parse("2026-08-09T20:15:00.000Z"));

  // The YYMM half is IST: 20:15 UTC on 9 August is already 01:45 on the 10th in
  // India, and the month is the one the shop is living in.
  assert.match(number, /^AJ-2608-[0-9A-HJKMNP-TV-Z]{6}$/);
  assert.ok(isOrderNumber(number));

  // A sequence would leak order volume to anyone who buys twice, which is the
  // reason db/schema.ts gives for never exposing the primary key.
  const numbers = new Set();
  for (let index = 0; index < 2000; index += 1) numbers.add(newOrderNumber());
  assert.equal(numbers.size, 2000, "two order numbers collided in 2000 draws");

  // Crockford base32: no I, L, O or U, so nothing is misread off an invoice.
  for (const number_ of numbers) {
    assert.doesNotMatch(number_.slice(8), /[ILOU]/);
  }

  for (const forged of ["", "AJ-2608-4KX9P", "aj-2608-4kx9p2", "AJ-26-4KX9P2", null, 42, {}]) {
    assert.equal(isOrderNumber(forged), false, `accepted ${String(forged)}`);
  }
});

test("the complaint ticket number is the order's own number, marked", () => {
  const order = newOrderNumber();
  const ticket = ticketNumberFor(order);
  assert.equal(ticket, order.replace("AJ-", "AJ-C-"));
  assert.match(ticket, /^AJ-C-\d{4}-[0-9A-HJKMNP-TV-Z]{6}$/);
});

test("the two money legs always account for the whole order", () => {
  for (const total of [1, 2, 3, 99, 100, 12_345_678, 41_265_999]) {
    const full = paymentLegs(total, "full_prepaid");
    assert.equal(full.advanceDuePaise + full.balanceDuePaise, total);
    // `orders_no_cod_ck`: a full-prepaid order may owe nothing at the door.
    assert.equal(full.balanceDuePaise, 0);

    if (total < 2) continue;

    const advance = paymentLegs(total, "booking_advance");
    assert.equal(advance.advanceDuePaise + advance.balanceDuePaise, total);
    // `price_quotes_amount_due_ck` and the no-COD CHECK between them require
    // both legs to be strictly positive on a booking-advance order.
    assert.ok(advance.advanceDuePaise > 0);
    assert.ok(advance.balanceDuePaise > 0);
    assert.ok(advance.advanceDuePaise <= total);
  }

  // 25%, half up, in integers.
  assert.equal(paymentLegs(41_266_000, "booking_advance").advanceDuePaise, 10_316_500);
  assert.equal(BOOKING_ADVANCE_BPS, 2500);
});

test("A ZERO-VALUE ORDER CANNOT BE CONSTRUCTED, LET ALONE PLACED", () => {
  const line = { row: {}, input: {}, rate: null, purityLabel: null };
  const footing = (total) => ({
    lines: [{ lineTotalPaise: total }],
    metalValuePaise: total,
    makingChargesPaise: 0,
    stoneValuePaise: 0,
    hallmarkingPaise: 0,
    otherChargesPaise: 0,
    discountPaise: 0,
    shippingPaise: 0,
    taxablePaise: total,
    gstRateBps: 300,
    gstPaise: 0,
    totalPaise: total,
    components: [],
  });

  // The footing CHECK constraints would happily store 0 = 0 + 0 + 0. The
  // constructor will not produce the value that would reach them.
  assert.throws(
    () =>
      new PriceableOrderCheckout({
        cartId: "cart",
        lines: [line],
        quote: footing(0),
        nowMs: Date.now(),
      }),
    /total is 0 paise/
  );

  // Nor a cart with nothing in it.
  assert.throws(
    () =>
      new PriceableOrderCheckout({
        cartId: "cart",
        lines: [],
        quote: footing(100),
        nowMs: Date.now(),
      }),
    /at least one line/
  );

  // Nor a quote that priced a different number of lines than the cart holds.
  assert.throws(
    () =>
      new PriceableOrderCheckout({
        cartId: "cart",
        lines: [line, line],
        quote: footing(100),
        nowMs: Date.now(),
      }),
    /priced 1/
  );

  // Nor a breakup that does not sum to its own total.
  const broken = footing(100);
  assert.throws(
    () =>
      new PriceableOrderCheckout({
        cartId: "cart",
        lines: [line],
        quote: { ...broken, metalValuePaise: 90 },
        nowMs: Date.now(),
      }),
    /does not foot/
  );

  // And one that does add up is accepted, so the guard is a guard and not a
  // blanket refusal.
  const good = new PriceableOrderCheckout({
    cartId: "cart",
    lines: [line],
    quote: footing(100),
    nowMs: 0,
  });
  assert.equal(good.lineItemCount, 1);
  assert.equal(good.isPriceable, true);
});

test("placeOrder refuses anything that is not a PriceableOrderCheckout", async () => {
  // TypeScript refuses an object literal here because the class is nominal.
  // This is the same door closed for a caller that is not type-checked at all.
  await assert.rejects(
    () =>
      placeOrder(
        { all: async () => [], batch: async () => [] },
        { cartId: "cart", lines: [], quote: {}, nowMs: 0 },
        PICKUP_DETAILS,
        { shopStateCode: SHOP_STATE }
      ),
    /not a PriceableOrderCheckout/
  );
});

test("what the customer must tell us, and what the law makes us ask", () => {
  const base = {
    name: "Meera Sharma",
    phone: "98123 45678",
    fulfilment: "store_pickup",
    plan: "full_prepaid",
    consent: "yes",
  };
  const small = { totalPaise: 5_000_000 };

  const ok = validateCheckoutDetails(base, small);
  assert.equal(ok.ok, true);
  assert.equal(ok.details.phone, "+919812345678");
  // Rule 4(9): consent is an explicit affirmative action, never a default. An
  // absent marketing box is a "no", and there is no box that arrives ticked.
  assert.equal(ok.details.marketingOptIn, false);
  assert.equal(validateCheckoutDetails({ ...base, marketing: "yes" }, small).details.marketingOptIn, true);

  // Consent itself is required, and its absence is not a default.
  assert.deepEqual(validateCheckoutDetails({ ...base, consent: "" }, small).fields, ["consent"]);

  // Income-tax Act 2025 s.262(9): at or above ₹2,00,000 the SELLER must ensure
  // PAN is quoted, whatever the payment method. "Or more" — the threshold
  // itself is caught.
  const big = { totalPaise: PAN_REQUIRED_AT_PAISE };
  assert.deepEqual(validateCheckoutDetails(base, big).fields, ["pan"]);
  assert.equal(validateCheckoutDetails({ ...base, pan: "abcde1234f" }, big).ok, true);
  assert.equal(validateCheckoutDetails({ ...base, pan: "abcde1234f" }, big).details.pan, "ABCDE1234F");
  assert.deepEqual(validateCheckoutDetails({ ...base, pan: "NOTAPAN" }, big).fields, ["pan"]);

  // A shipped order needs an address, and the state is not optional because it
  // decides the GST split.
  const shipped = validateCheckoutDetails({ ...base, fulfilment: "ship" }, small);
  assert.equal(shipped.ok, false);
  assert.deepEqual([...shipped.fields].sort(), ["city", "line1", "pincode", "state"]);

  const address = {
    ...base,
    fulfilment: "ship",
    line1: "12 Johari Bazaar",
    city: "Jaipur",
    state: AWAY_STATE,
    pincode: "302003",
  };
  assert.equal(validateCheckoutDetails(address, small).ok, true);
  assert.deepEqual(validateCheckoutDetails({ ...address, pincode: "002003" }, small).fields, [
    "pincode",
  ]);
  assert.deepEqual(validateCheckoutDetails({ ...address, state: "99" }, small).fields, ["state"]);
});

test("THERE IS NO CASH ON DELIVERY, AND NO WAY TO ASK FOR ONE", () => {
  const base = {
    name: "Meera Sharma",
    phone: "9812345678",
    fulfilment: "store_pickup",
    consent: "yes",
    line1: "12 Johari Bazaar",
    city: "Jaipur",
    state: AWAY_STATE,
    pincode: "302003",
  };
  const small = { totalPaise: 5_000_000 };

  // The enum has two members. Anything else is not a plan.
  for (const plan of ["cod", "cash", "cash_on_delivery", "", "COD"]) {
    assert.deepEqual(validateCheckoutDetails({ ...base, plan }, small).fields, ["plan"]);
  }

  // And the one combination that would mean money owed to a courier at the
  // door — a shipped order with a balance — is refused before the CHECK sees
  // it, and would be refused by `orders_no_cod_ck` if it were not.
  assert.deepEqual(
    validateCheckoutDetails({ ...base, fulfilment: "ship", plan: "booking_advance" }, small).fields,
    ["plan"]
  );
  assert.equal(
    validateCheckoutDetails({ ...base, fulfilment: "store_pickup", plan: "booking_advance" }, small).ok,
    true
  );
});

test("WITH CAPTURE OFF, NOTHING CLAIMS A PAYMENT SUCCEEDED", () => {
  assert.equal(PAYMENT_CAPTURE_ENABLED, false, "the flag is on; this build takes money");

  for (const fulfilment of ["ship", "store_pickup"]) {
    for (const plan of ["full_prepaid", "booking_advance"]) {
      const off = paymentStanding(false, { plan, fulfilment });
      const sentence = `${off.heading} ${off.body} ${off.badge}`;

      assert.match(off.heading, /No payment has been taken/);
      assert.match(off.body, /Nothing has been charged and nothing has been paid/);
      assert.match(off.body, /we will call you/i);
      assert.equal(off.badge, "Awaiting payment");
      assertNoSettledPaymentLanguage(sentence, "paymentStanding(false)");

      // The other side of the flag is different copy, so the two states cannot
      // silently be the same string.
      const on = paymentStanding(true, { plan, fulfilment });
      assert.notEqual(on.heading, off.heading);
      assert.doesNotMatch(on.body, /Nothing has been charged/);
    }
  }
});

/**
 * The forbidden vocabulary, in one place.
 *
 * Deliberately NOT a ban on the word "paid": the honest copy says "nothing has
 * been paid" and "it has not been paid for", and a test that forced those out
 * would be pushing the page towards vaguer language rather than truer language.
 * What is banned is any construction that asserts money ARRIVED, plus the tick
 * glyphs, which read as settled from across a room whatever the words say.
 */
function assertNoSettledPaymentLanguage(text, where) {
  const forbidden = [
    /payment\s+(has\s+been\s+|was\s+|is\s+)?(received|captured|confirmed|successful|complete)/i,
    /(we\s+have\s+)?received\s+your\s+payment/i,
    /successfully\s+paid/i,
    /paid\s+in\s+full/i,
    /order\s+paid/i,
    /thank\s+you\s+for\s+your\s+payment/i,
    /payment\s+successful/i,
    /your\s+receipt/i,
    /✓|✔|✅/,
  ];
  for (const pattern of forbidden) {
    assert.doesNotMatch(text, pattern, `${where} claims a payment succeeded: ${pattern}`);
  }
}

test("only notice codes the shop publishes survive the round trip", () => {
  assert.equal(toCheckoutNotice("placed"), "placed");
  assert.equal(toCheckoutNotice("unpriceable"), "unpriceable");
  assert.equal(toCheckoutNotice("<script>alert(1)</script>"), null);
  assert.equal(toCheckoutNotice("toString"), null);
  assert.equal(toCheckoutNotice("constructor"), null);
  assert.equal(toCheckoutNotice(undefined), null);

  assert.deepEqual(toCheckoutFields("name,phone,constructor,name"), ["name", "phone"]);
  assert.deepEqual(toCheckoutFields("<script>"), []);
  assert.deepEqual(toCheckoutFields(undefined), []);

  // Nothing from a request reaches a Location header: the ref is matched
  // against the order-number pattern and dropped when it does not match.
  assert.equal(checkoutHref(), "/checkout");
  assert.equal(checkoutHref({ notice: "placed" }), "/checkout?notice=placed");
  assert.equal(
    checkoutHref({ notice: "placed", ref: "https://evil.example" }),
    "/checkout?notice=placed"
  );
  assert.equal(
    checkoutHref({ notice: "placed", ref: "AJ-2608-4KX9P2" }),
    "/checkout?notice=placed&ref=AJ-2608-4KX9P2"
  );

  // Every published code has copy, and none of it announces a payment.
  for (const [code, copy] of Object.entries(CHECKOUT_NOTICES)) {
    assert.ok(copy.length > 0, `${code} has no copy`);
    assertNoSettledPaymentLanguage(copy, `CHECKOUT_NOTICES.${code}`);
  }
});

test("weight is printed in grams to three places, without a float", () => {
  assert.equal(formatWeightMg(12_345), "12.345 g");
  assert.equal(formatWeightMg(1_000), "1.000 g");
  assert.equal(formatWeightMg(7), "0.007 g");
});

/* =========================================================================
 * 2. The data layer, against the real schema
 * ====================================================================== */

test("AN UNPRICEABLE CART CANNOT PRODUCE AN ORDER — the shop as it stands today", async () => {
  const { sqlite, db } = freshOrders();

  const added = await addToCart(db, { token: null, slug: HAAR });
  await addToCart(db, { token: added.cartId, slug: CHOKER });

  const resolution = await resolveCheckout(db, {
    token: added.cartId,
    shopStateCode: SHOP_STATE,
  });

  assert.equal(resolution.ok, false);
  assert.equal(resolution.reason, "unpriceable");
  assert.equal(resolution.lineCount, 2);
  // Every seeded product is `enquire_only`, which is refused before pricing is
  // even attempted — the owner decides per piece whether it is buyable.
  assert.deepEqual(
    resolution.blocked.map((line) => line.reason),
    ["not_for_sale_online", "not_for_sale_online"]
  );

  // Opened for online sale, the pieces are still `on_request`: nothing has been
  // weighed and nothing has been assayed, so there is no figure to charge.
  sqlite.prepare("UPDATE products SET sale_mode = 'buy_online'").run();
  const second = await resolveCheckout(db, {
    token: added.cartId,
    shopStateCode: SHOP_STATE,
  });
  assert.equal(second.ok, false);
  assert.deepEqual(
    second.blocked.map((line) => line.reason),
    ["on_request", "on_request"]
  );

  // And nothing at all was written. Not a draft, not a zero-value order.
  for (const table of ["orders", "order_items", "price_quotes", "payments", "webhook_events"]) {
    assert.equal(count(sqlite, `SELECT count(*) AS c FROM ${table}`), 0, table);
  }
  sqlite.close();
});

test("a piece with no readable gold rate is refused, and says which", async () => {
  const { sqlite, db } = freshOrders();

  makePriceable(sqlite, { withRate: false });
  const added = await addToCart(db, { token: null, slug: HAAR });

  const resolution = await resolveCheckout(db, {
    token: added.cartId,
    shopStateCode: SHOP_STATE,
  });
  assert.equal(resolution.ok, false);
  assert.deepEqual(
    resolution.blocked.map((line) => line.reason),
    ["rate_missing"]
  );
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM orders"), 0);
  sqlite.close();
});

test("an order cannot be created while the shop's own state is unrecorded", async () => {
  const { sqlite, db } = freshOrders();

  makePriceable(sqlite);
  const added = await addToCart(db, { token: null, slug: HAAR });

  const resolution = await resolveCheckout(db, {
    token: added.cartId,
    shopStateCode: null,
  });
  // An invoice must say whether GST is CGST+SGST or IGST, and that is decided
  // by the state the supply is made FROM. Guessing it is guessing a tax
  // treatment, so the order is refused instead.
  assert.equal(resolution.ok, false);
  assert.equal(resolution.reason, "shop_state_unknown");
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM orders"), 0);
  sqlite.close();
});

test("A PRICED CART PRODUCES EXACTLY ONE ORDER, WITH A SNAPSHOT THAT FOOTS", async () => {
  const { sqlite, db } = freshOrders();
  const { cartId, resolution } = await readyCheckout(sqlite, db);

  const placed = await placeOrder(db, resolution.checkout, PICKUP_DETAILS, {
    shopStateCode: SHOP_STATE,
  });

  assert.equal(placed.ok, true, JSON.stringify(placed));
  assert.ok(isOrderNumber(placed.orderNumber));
  assert.equal(placed.ticketNumber, ticketNumberFor(placed.orderNumber));

  assert.equal(count(sqlite, "SELECT count(*) AS c FROM orders"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM order_items"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM price_quotes"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM payments"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM support_tickets"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM webhook_events"), 1);

  const order = sqlite.prepare("SELECT * FROM orders").get();
  const item = sqlite.prepare("SELECT * FROM order_items").get();

  // The invoice foots. These are the database's own CHECK constraints,
  // re-asserted here so a regression is reported as arithmetic rather than as
  // an opaque constraint error.
  assert.equal(
    order.taxable_paise,
    order.metal_value_paise +
      order.making_charges_paise +
      order.stone_value_paise +
      order.hallmarking_paise +
      order.other_charges_paise -
      order.discount_paise +
      order.shipping_paise
  );
  assert.equal(order.total_paise, order.taxable_paise + order.gst_paise);
  assert.equal(order.gst_paise, order.cgst_paise + order.sgst_paise + order.igst_paise);
  assert.equal(order.advance_due_paise + order.balance_due_paise, order.total_paise);
  assert.equal(
    item.unit_price_paise,
    item.metal_value_paise +
      item.making_charge_paise +
      item.stone_value_paise +
      item.hallmarking_paise +
      item.other_charges_paise
  );
  assert.equal(item.line_total_paise, item.line_subtotal_paise + item.line_gst_paise);
  assert.ok(order.total_paise > 0, "a zero-value order reached the database");

  // A store pickup is supplied from the shop's own state, so CGST+SGST and
  // never IGST — and the two halves reconcile exactly on an odd paise.
  assert.equal(order.place_of_supply_state_code, SHOP_STATE);
  assert.equal(order.igst_paise, 0);
  assert.equal(order.cgst_paise + order.sgst_paise, order.gst_paise);

  // THE FULL COMPOSITION IS SNAPSHOTTED — BIS Reg. 5(11) requires description,
  // net weight of precious metal, purity in carat AND fineness, and hallmarking
  // charges to appear separately, reproducibly, years later.
  assert.equal(item.sku, "AJ-JADAU-HAAR-01");
  assert.equal(item.title_snapshot, "Jadau haar");
  assert.equal(item.net_metal_weight_mg, 12_345);
  assert.equal(item.fineness_snapshot, 916);
  assert.equal(item.purity_carat_label_snapshot, "22K (916)");
  assert.equal(item.hsn_code, "7113");
  assert.equal(item.country_of_origin_snapshot, "India");
  // Both the rate row AND its value: the key proves provenance, the copy
  // survives independently.
  assert.equal(item.gold_rate_id, "rate_916");
  assert.equal(item.gold_rate_per_ten_grams_paise, 13_705_300);
  assert.ok(item.gold_rate_effective_from);
  assert.ok(item.gold_rate_captured_at);
  // The metal value is the schema's rounding rule, computed independently here:
  // round_half_up(rate * mg / 10000).
  assert.equal(item.metal_value_paise, Math.round((13_705_300 * 12_345) / 10_000));
  assert.equal(item.making_charge_paise, Math.round((item.metal_value_paise * 1200) / 10_000));
  // QCO cl. 2(3) exempts Jadau, so a 0 here is the truth and not a gap.
  assert.equal(item.hallmarking_paise, 0);
  assert.equal(item.huid_snapshot, null);

  // Nothing was captured. The payment row is an intent, not a receipt.
  assert.equal(order.status, "pending_payment");
  assert.equal(order.payment_status, "unpaid");
  assert.equal(order.advance_paid_paise, 0);
  const payment = sqlite.prepare("SELECT * FROM payments").get();
  assert.equal(payment.provider, "manual");
  assert.equal(payment.status, "created");
  assert.equal(payment.provider_payment_id, null);

  // The cart is spent, the hold is consumed and the piece is off the wall.
  assert.equal(
    sqlite.prepare("SELECT status AS s FROM carts WHERE id = ?").get(cartId).s,
    "converted"
  );
  assert.equal(
    count(sqlite, "SELECT count(*) AS c FROM stock_reservations WHERE status = 'consumed'"),
    1
  );
  assert.equal(
    sqlite.prepare("SELECT stock_quantity AS q FROM variants WHERE id = ?").get(HAAR_VARIANT).q,
    0
  );

  // The quote is the price of record and it was consumed by this order.
  const quote = sqlite.prepare("SELECT * FROM price_quotes").get();
  assert.equal(quote.status, "consumed");
  assert.equal(quote.total_paise, order.total_paise);
  assert.equal(quote.amount_due_now_paise, order.advance_due_paise);
  assert.ok(quote.amount_due_now_paise > 0);

  sqlite.close();
});

test("a shipped order out of state is charged IGST, from the DELIVERY state", async () => {
  const { sqlite, db } = freshOrders();
  const { resolution } = await readyCheckout(sqlite, db);

  const placed = await placeOrder(
    db,
    resolution.checkout,
    {
      ...PICKUP_DETAILS,
      fulfilmentMode: "ship",
      ship: {
        name: "Meera Sharma",
        line1: "12 Marine Drive",
        line2: null,
        city: "Mumbai",
        stateCode: AWAY_STATE,
        pincode: "400020",
      },
    },
    { shopStateCode: SHOP_STATE }
  );
  assert.equal(placed.ok, true);

  const order = sqlite.prepare("SELECT * FROM orders").get();
  // IGST Act s.10(1)(a): the place of supply is where the movement terminates
  // for delivery — the delivery state, never the billing address.
  assert.equal(order.place_of_supply_state_code, AWAY_STATE);
  assert.equal(order.cgst_paise, 0);
  assert.equal(order.sgst_paise, 0);
  assert.equal(order.igst_paise, order.gst_paise);
  // A shipped order owes nothing at the door.
  assert.equal(order.balance_due_paise, 0);
  assert.equal(order.payment_plan, "full_prepaid");
  sqlite.close();
});

test("THE PLACEMENT IS ONE BATCH, IN THE ORDER THE SCHEMA ASKS FOR", async () => {
  const { sqlite, db: inner } = freshOrders();

  const batches = [];
  const db = {
    all: (sql, params) => inner.all(sql, params),
    batch: (statements) => {
      batches.push(statements);
      return inner.batch(statements);
    },
  };

  const { resolution } = await readyCheckout(sqlite, db);

  // Resolution reads the cart, which sweeps and re-claims; those are its own
  // transactions and are not what is under test here.
  batches.length = 0;

  const placed = await placeOrder(db, resolution.checkout, PICKUP_DETAILS, {
    shopStateCode: SHOP_STATE,
  });
  assert.equal(placed.ok, true);

  // ONE batch is ONE transaction. Two batches are two transactions, and if the
  // second failed the first would already be committed.
  assert.equal(batches.length, 1, "the placement was split across transactions");

  const statements = batches[0].map((statement) => statement.sql);
  const first = (needle) => statements.findIndex((sql) => sql.includes(needle));

  // The order db/schema.ts specifies, asserted as an ordering rather than as a
  // list — the idempotency key must be written before anything it protects.
  assert.ok(first("INSERT INTO webhook_events") === 0);
  assert.ok(first("INSERT INTO price_quotes") > first("INSERT INTO webhook_events"));
  assert.ok(first("INSERT INTO orders") > first("INSERT INTO price_quotes"));
  assert.ok(first("INSERT INTO order_items") > first("INSERT INTO orders"));
  assert.ok(first("INSERT INTO payments") > first("INSERT INTO order_items"));
  assert.ok(first("UPDATE variants") > first("INSERT INTO payments"));
  assert.ok(first("UPDATE stock_reservations") > first("UPDATE variants"));
  assert.ok(first("INSERT INTO support_tickets") > first("UPDATE stock_reservations"));
  assert.ok(first("UPDATE carts") > first("INSERT INTO support_tickets"));

  // ONE INSERT PER LINE ITEM, never a multi-row VALUES: six items at ~37
  // columns would be 222 bound parameters and would fail where two passed.
  assert.equal(
    statements.filter((sql) => sql.includes("INSERT INTO order_items")).length,
    resolution.checkout.lineItemCount
  );

  // And the D1 cap is respected by every statement in the transaction.
  for (const statement of batches[0]) {
    assert.ok(
      statement.params.length <= 100,
      `a statement bound ${statement.params.length} parameters: ${statement.sql.slice(0, 60)}`
    );
  }

  // The decrement carries no `WHERE stock_quantity >= ?`: a WHERE clause would
  // turn an oversell into a silent no-op instead of letting the CHECK abort.
  const decrement = statements.find((sql) => sql.includes("UPDATE variants"));
  assert.doesNotMatch(decrement, /stock_quantity\s*>=/);

  sqlite.close();
});

test("A DUPLICATE PLACEMENT COLLIDES ON THE PRIMARY KEY AND IS DISCARDED WHOLE", async () => {
  const { sqlite, db } = freshOrders();
  // Stock of five, so a second decrement would NOT trip the stock CHECK — this
  // test has to prove the webhook_events primary key did the work, not some
  // other constraint that happens to fire at the same time.
  const { resolution } = await readyCheckout(sqlite, db, { stockQuantity: 5 });

  const first = await placeOrder(db, resolution.checkout, PICKUP_DETAILS, {
    shopStateCode: SHOP_STATE,
  });
  assert.equal(first.ok, true);
  assert.equal(
    sqlite.prepare("SELECT stock_quantity AS q FROM variants WHERE id = ?").get(HAAR_VARIANT).q,
    4
  );

  // The gateway retries; the customer double-clicks; the browser re-posts.
  const again = await placeOrder(db, resolution.checkout, PICKUP_DETAILS, {
    shopStateCode: SHOP_STATE,
  });

  assert.equal(again.ok, false);
  assert.equal(again.reason, "already_placed");
  // Truthful, and it carries the order that stands rather than inventing one.
  assert.equal(again.orderNumber, first.orderNumber);

  // THE WHOLE duplicate placement went with it: order, line items, payment,
  // quote, ticket AND the second stock decrement.
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM orders"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM order_items"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM payments"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM price_quotes"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM support_tickets"), 1);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM webhook_events"), 1);
  assert.equal(
    sqlite.prepare("SELECT stock_quantity AS q FROM variants WHERE id = ?").get(HAAR_VARIANT).q,
    4,
    "the duplicate decremented stock a second time"
  );

  sqlite.close();
});

test("THE ARBITER IS THE DATABASE: a raw duplicate event id is refused outright", () => {
  const sqlite = migratedDatabase();
  const insert = () =>
    sqlite
      .prepare(
        "INSERT INTO webhook_events (id, provider, event_type, payload_json) VALUES (?, 'manual', 'checkout.placed', '{}')"
      )
      .run("manual:cart:one");

  insert();
  // No ON CONFLICT clause anywhere near this: the primary key refuses it, which
  // is the guarantee the placement batch relies on, asserted directly rather
  // than inferred from the placement's own return value.
  assert.throws(insert, /UNIQUE constraint failed|PRIMARY KEY/i);
  sqlite.close();
});

test("OVERSELLING IS REFUSED BY THE CHECK, NOT BY APPLICATION CODE", async () => {
  const { sqlite, db } = freshOrders();
  const { resolution } = await readyCheckout(sqlite, db);

  // The piece is taken between the quote and the commit. This is the race the
  // reservation is a courtesy against and the constraint is a guarantee
  // against; the application has already decided the stock was there.
  sqlite.prepare("UPDATE variants SET stock_quantity = 0 WHERE id = ?").run(HAAR_VARIANT);

  const placed = await placeOrder(db, resolution.checkout, PICKUP_DETAILS, {
    shopStateCode: SHOP_STATE,
  });

  assert.equal(placed.ok, false);
  assert.equal(placed.reason, "sold_out");

  // The order is NEVER CREATED, rather than created against stock that does not
  // exist. That is the whole point of letting the CHECK abort the batch.
  for (const table of ["orders", "order_items", "price_quotes", "payments", "webhook_events", "support_tickets"]) {
    assert.equal(count(sqlite, `SELECT count(*) AS c FROM ${table}`), 0, table);
  }
  assert.equal(
    sqlite.prepare("SELECT stock_quantity AS q FROM variants WHERE id = ?").get(HAAR_VARIANT).q,
    0,
    "the aborted batch left stock negative"
  );

  // And the constraint itself is real, asserted without going through any of
  // our code at all.
  assert.throws(
    () => sqlite.prepare("UPDATE variants SET stock_quantity = -1 WHERE id = ?").run(HAAR_VARIANT),
    /CHECK constraint failed/i
  );
  sqlite.close();
});

test("lineItemCount matches the rows written, and a torn order is detected", async () => {
  const { sqlite, db } = freshOrders();

  makePriceable(sqlite, { slug: HAAR, variantId: HAAR_VARIANT });
  makePriceable(sqlite, { slug: CHOKER, variantId: "var_polki-choker" });

  const added = await addToCart(db, { token: null, slug: HAAR });
  await addToCart(db, { token: added.cartId, slug: CHOKER });

  const resolution = await resolveCheckout(db, {
    token: added.cartId,
    shopStateCode: SHOP_STATE,
  });
  assert.equal(resolution.ok, true);

  const placed = await placeOrder(db, resolution.checkout, PICKUP_DETAILS, {
    shopStateCode: SHOP_STATE,
  });
  assert.equal(placed.ok, true);
  assert.equal(placed.lineItemCount, 2);

  const order = sqlite.prepare("SELECT * FROM orders").get();
  assert.equal(order.line_item_count, 2);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM order_items"), 2);
  assert.deepEqual(await assertOrderIntact(db, order.id, 2), { ok: true, found: 2 });

  // The order total is the sum of its own lines, which is what makes the
  // printed lines add up to the printed total exactly.
  const lineTotal = sqlite
    .prepare("SELECT sum(line_total_paise) AS s FROM order_items WHERE order_id = ?")
    .get(order.id).s;
  assert.equal(lineTotal, order.total_paise);

  // Tear it, the way a half-committed batch would have. D1 cannot roll a
  // partial write back for us, so this is how one is found on read.
  sqlite.prepare("DELETE FROM order_items WHERE order_id = ? AND sku LIKE 'AJ-POLKI%'").run(order.id);
  assert.deepEqual(await assertOrderIntact(db, order.id, 2), { ok: false, found: 1 });

  const receipt = await readOrderForCart(db, {
    orderNumber: placed.orderNumber,
    cartToken: added.cartId,
  });
  // A reader that finds a mismatch REFUSES TO ACT rather than invoicing a
  // subset, which would be a smaller figure than the customer actually owes.
  assert.equal(receipt.found, true);
  assert.equal(receipt.intact, false);
  sqlite.close();
});

test("a complaint ticket number is issued with the order, and it is trackable", async () => {
  const { sqlite, db } = freshOrders();
  const { resolution } = await readyCheckout(sqlite, db);

  const placed = await placeOrder(db, resolution.checkout, PICKUP_DETAILS, {
    shopStateCode: SHOP_STATE,
  });
  assert.equal(placed.ok, true);

  // E-Commerce Rule 7(1)(f): a ticket number for each complaint, through which
  // the consumer can track its status. `support_tickets` is authoritative;
  // `orders.complaintTicketNumber` is the denormalised copy for the invoice,
  // and the two are written in the SAME transaction so one cannot name the
  // other into thin air.
  const ticket = sqlite.prepare("SELECT * FROM support_tickets").get();
  const order = sqlite.prepare("SELECT * FROM orders").get();
  assert.equal(ticket.ticket_number, placed.ticketNumber);
  assert.equal(order.complaint_ticket_number, ticket.ticket_number);
  assert.equal(ticket.order_id, order.id);
  assert.equal(ticket.status, "open");
  assert.equal(ticket.contact_phone, PICKUP_DETAILS.phone);

  // Rule 4(5): acknowledge within forty-eight hours, redress within one month.
  // The deadlines are stored rather than recomputed, so an overdue queue is one
  // indexed query.
  const placedMs = Date.parse(order.placed_at);
  assert.equal(Date.parse(ticket.acknowledge_due_at) - placedMs, 48 * 3600_000);
  assert.equal(Date.parse(ticket.redress_due_at) - placedMs, 30 * 86_400_000);
  sqlite.close();
});

test("the buyer is recorded without a foreign key, and consent is provable", async () => {
  const { sqlite, db } = freshOrders();
  const { resolution } = await readyCheckout(sqlite, db);

  await placeOrder(db, resolution.checkout, PICKUP_DETAILS, { shopStateCode: SHOP_STATE });

  const customer = sqlite.prepare("SELECT * FROM customers").get();
  const order = sqlite.prepare("SELECT * FROM orders").get();
  assert.equal(customer.phone, PICKUP_DETAILS.phone);
  assert.equal(order.customer_id, customer.id);
  // DPDP s.6(10) puts the burden of proving consent on us, so which notice and
  // when — not a boolean.
  assert.ok(customer.consent_version);
  assert.ok(customer.consent_at);
  assert.equal(customer.marketing_opt_in, 0);

  // The order snapshots contact and address inline, so erasure can null every
  // PII column on `customers` without the order losing anything. Proved by
  // doing it: a redacted tombstone leaves the order intact.
  assert.equal(order.contact_name, PICKUP_DETAILS.name);
  assert.equal(order.contact_phone, PICKUP_DETAILS.phone);
  const year = new Date(Date.now() + 365 * 86_400_000).toISOString();
  sqlite
    .prepare(
      `UPDATE customers SET deletion_requested_at = ?, purge_not_before_at = ? WHERE id = ?`
    )
    .run(new Date().toISOString(), year, customer.id);
  sqlite
    .prepare(`UPDATE customers SET phone = NULL, email = NULL, name = NULL, redacted_at = ? WHERE id = ?`)
    .run(year, customer.id);

  const after = sqlite.prepare("SELECT * FROM orders").get();
  assert.equal(after.contact_name, PICKUP_DETAILS.name);
  assert.equal(after.contact_phone, PICKUP_DETAILS.phone);
  assert.equal(count(sqlite, "SELECT count(*) AS c FROM orders"), 1);
  sqlite.close();
});

test("an order is readable only by the cart that produced it", async () => {
  const { sqlite, db } = freshOrders();
  const { cartId, resolution } = await readyCheckout(sqlite, db);

  const placed = await placeOrder(db, resolution.checkout, PICKUP_DETAILS, {
    shopStateCode: SHOP_STATE,
  });

  const mine = await readOrderForCart(db, {
    orderNumber: placed.orderNumber,
    cartToken: cartId,
  });
  assert.equal(mine.found, true);
  assert.equal(mine.intact, true);
  assert.equal(mine.receipt.totalPaise, placed.totalPaise);
  assert.equal(mine.receipt.advancePaidPaise, 0);
  assert.equal(mine.receipt.paymentStatus, "unpaid");

  // An order number is short, printable and read out over a phone. It is NOT a
  // credential, so guessing one must not disclose a stranger's name, phone and
  // address.
  const stranger = await readOrderForCart(db, {
    orderNumber: placed.orderNumber,
    cartToken: newCartToken(),
  });
  assert.deepEqual(stranger, { found: false });
  assert.deepEqual(
    await readOrderForCart(db, { orderNumber: placed.orderNumber, cartToken: null }),
    { found: false }
  );
  assert.deepEqual(
    await readOrderForCart(db, { orderNumber: "' OR 1=1 --", cartToken: cartId }),
    { found: false }
  );
  sqlite.close();
});

/* =========================================================================
 * 3. The endpoint, through the built Worker
 * ====================================================================== */

let worker;
let workerBinding;

before(() => {
  worker = migratedDatabase();
  workerBinding = d1Over(worker);
  env.DB = workerBinding;
  // The shop's registered state, supplied the way an operator would supply it
  // while the rest of the address facts are still pending. Without it the
  // GST split cannot be decided and checkout refuses, which is its own test.
  env.SHOP_GST_STATE_CODE = SHOP_STATE;
});

/**
 * Every test starts from an empty order book and a placeholder catalogue.
 *
 * Three things are reset, and each has bitten:
 *
 *   THE BINDING. A data-layer test above points `env.DB` at its own in-memory
 *   database so the real rate lookup reads the rate it wrote. Left in place,
 *   the next Worker test would price against a database that has been closed.
 *
 *   THE ORDER BOOK, deleted in foreign-key order. `price_quotes` refuses to let
 *   a cart it references be deleted — NO ACTION, on purpose, because a quote is
 *   evidence of what was offered and must outlive the cart's lifecycle — so
 *   orders go before quotes and quotes go before carts.
 *
 *   THE CATALOGUE. `makePriceable()` gives a placeholder piece a weight, a
 *   fineness and `buy_online`. Left in place it would silently make the next
 *   test's "this cart cannot be priced" assertion test the opposite thing.
 */
beforeEach(() => {
  if (!worker) return;
  env.DB = workerBinding;
  for (const table of [
    "payments",
    "order_items",
    "orders",
    "support_tickets",
    "webhook_events",
    "price_quotes",
    "carts",
    "customers",
  ]) {
    worker.exec(`DELETE FROM ${table}`);
  }
  reseed(worker);
});

after(() => {
  delete env.DB;
  delete env.SHOP_GST_STATE_CODE;
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

async function addPiece(slug, cookie) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.cookie = `${CART_COOKIE}=${cookie}`;
  const response = await fetchWorker("/api/cart", {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "add", slug }),
  });
  return tokenOf(response) ?? cookie;
}

async function order(body, { cookie, form = false } = {}) {
  const headers = form
    ? { "Content-Type": "application/x-www-form-urlencoded" }
    : { "Content-Type": "application/json" };
  if (cookie) headers.cookie = `${CART_COOKIE}=${cookie}`;

  const response = await fetchWorker("/api/orders", {
    method: "POST",
    headers,
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
    redirect: "manual",
  });

  let parsed = null;
  if ((response.headers.get("content-type") ?? "").includes("json")) {
    parsed = await response.json();
  }
  return { response, body: parsed };
}

const SUBMISSION = {
  name: "Meera Sharma",
  phone: "98123 45678",
  email: "meera@example.com",
  fulfilment: "store_pickup",
  plan: "full_prepaid",
  consent: "yes",
};

test("POST refuses to create an order for a cart it cannot price", async () => {
  const cookie = await addPiece(HAAR);
  const { response, body } = await order(SUBMISSION, { cookie });

  assert.equal(response.status, 409);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "unpriceable");
  assert.equal(count(worker, "SELECT count(*) AS c FROM orders"), 0);
  // The refusal names the piece and the reason rather than going silent.
  assert.deepEqual(body.blocked, [{ slug: HAAR, reason: "not_for_sale_online" }]);
});

test("POST places one real order and claims no payment whatsoever", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);
  const { response, body } = await order(SUBMISSION, { cookie });

  assert.equal(response.status, 201);
  assert.equal(body.ok, true);
  assert.equal(body.placed, true);
  assert.ok(isOrderNumber(body.orderNumber));
  assert.equal(body.complaintTicketNumber, ticketNumberFor(body.orderNumber));
  assert.equal(body.lineItemCount, 1);
  assert.ok(body.totalPaise > 0);

  // Every field that could be read as money having moved says it has not.
  assert.equal(body.paid, false);
  assert.equal(body.amountPaidPaise, 0);
  assert.equal(body.paymentStatus, "unpaid");
  assert.equal(body.orderStatus, "pending_payment");
  assert.equal(body.paymentCaptureEnabled, false);
  assert.match(body.message, /Nothing has been charged and nothing has been paid/);
  assertNoSettledPaymentLanguage(JSON.stringify(body), "POST /api/orders");

  // The order is REAL: it is in the database, not merely announced.
  assert.equal(count(worker, "SELECT count(*) AS c FROM orders"), 1);
  assert.equal(count(worker, "SELECT count(*) AS c FROM order_items"), 1);
  assert.equal(
    worker.prepare("SELECT order_number AS n FROM orders").get().n,
    body.orderNumber
  );
});

test("a second, legitimate order is placed and never throttled away", async () => {
  makePriceable(worker);
  makePriceable(worker, { slug: CHOKER, variantId: "var_polki-choker" });

  const firstCookie = await addPiece(HAAR);
  const first = await order(SUBMISSION, { cookie: firstCookie });
  assert.equal(first.response.status, 201);

  // The cart is spent, so the next piece starts a fresh one — which is exactly
  // why the idempotency key can be the cart without suppressing real repeat
  // business. The appointments route's throttle would have answered this with
  // a fabricated success and written nothing.
  const secondCookie = await addPiece(CHOKER, firstCookie);
  const second = await order(SUBMISSION, { cookie: secondCookie });

  assert.equal(second.response.status, 201);
  assert.equal(second.body.placed, true);
  assert.notEqual(second.body.orderNumber, first.body.orderNumber);
  assert.equal(count(worker, "SELECT count(*) AS c FROM orders"), 2);
});

test("a browser form is answered with a redirect, and the outcome survives it", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);

  const placed = await order(SUBMISSION, { cookie, form: true });
  assert.equal(placed.response.status, 303);
  const location = placed.response.headers.get("location");
  assert.match(location, /^\/checkout\?notice=placed&ref=AJ-\d{4}-[0-9A-HJKMNP-TV-Z]{6}$/);

  // A failure is not dressed up as a success by the redirect either.
  const missing = await order({ ...SUBMISSION, name: "" }, { cookie, form: true });
  assert.equal(missing.response.status, 303);
  assert.match(missing.response.headers.get("location"), /notice=/);
});

test("incomplete details are refused, specifically, and nothing is ordered", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);

  const { response, body } = await order(
    { ...SUBMISSION, phone: "12", consent: "" },
    { cookie }
  );
  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.deepEqual([...body.fields].sort(), ["consent", "phone"]);
  assert.equal(count(worker, "SELECT count(*) AS c FROM orders"), 0);
  // And the piece is still held rather than quietly released.
  assert.equal(
    count(worker, "SELECT count(*) AS c FROM stock_reservations WHERE status = 'held'"),
    1
  );
});

test("a cross-site POST cannot place an order in someone else's name", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);

  const foreign = await fetchWorker("/api/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      cookie: `${CART_COOKIE}=${cookie}`,
      origin: "https://not-alankar.example",
      host: "localhost",
    },
    body: JSON.stringify(SUBMISSION),
  });

  assert.equal(foreign.status, 403);
  assert.equal(count(worker, "SELECT count(*) AS c FROM orders"), 0);
});

test("GET /api/orders is not a way to read a stranger's order", async () => {
  const response = await fetchWorker("/api/orders");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
});

test("NO FAKE SUCCESS: an unreachable order book is reported, never answered 201", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);

  const saved = env.DB;
  delete env.DB;
  try {
    const { response, body } = await order(SUBMISSION, { cookie });
    assert.equal(response.status, 503);
    assert.equal(body.ok, false);
    assert.equal(body.placed, false);
    assert.match(body.error, /nothing was ordered/i);
  } finally {
    env.DB = saved;
  }

  // The appointments route would have counted a webhook as success here. There
  // is no second sink on this path, and nothing was written.
  assert.equal(count(worker, "SELECT count(*) AS c FROM orders"), 0);
});

/* =========================================================================
 * 4. The rendered page
 * ====================================================================== */

async function checkoutHtml(cookie, query = "") {
  const response = await fetchWorker(`/checkout${query}`, {
    headers: { accept: "text/html", ...(cookie ? { cookie: `${CART_COOKIE}=${cookie}` } : {}) },
  });
  return response.text();
}

test("an unpriceable cart is shown the refusal and NO ORDER FORM AT ALL", async () => {
  const cookie = await addPiece(HAAR);
  const html = await checkoutHtml(cookie);

  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.ok(html.includes("Not something we can price."));
  assert.ok(html.includes("Jadau haar"));
  // The refusal is not a disabled button. The control is simply not there.
  assert.doesNotMatch(html, /<form[^>]*action="\/api\/orders"/);
  assert.doesNotMatch(html, /Place this order/);
  // And the path that does work is offered instead.
  assert.ok(html.includes("Ask us to price these"));
  assert.ok(html.includes("/#visit"));
  // Never a zero, anywhere.
  assert.doesNotMatch(html, /₹\s*0\b/);
  assert.doesNotMatch(html, /₹0/);
});

test("a priceable cart is shown an itemised quote and a form that takes no money", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);
  const html = await checkoutHtml(cookie);

  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.ok(html.includes("Tell us where it goes."));
  assert.match(html, /<form[^>]*action="\/api\/orders"[^>]*>/);
  assert.match(html, /method="post"/i);

  // The standing of the money is the FIRST thing, before a field is asked for.
  assert.ok(html.includes("No payment has been taken"));
  assert.ok(html.includes("Awaiting payment"));
  assertNoSettledPaymentLanguage(html, "/checkout (ready)");

  // Rule 7(1)(e): the total in a single figure TOGETHER WITH the breakup.
  assert.ok(html.includes("Making charges"));
  assert.ok(html.includes("GST"));
  assert.match(html, /₹[\d,]+/);

  // BIS Reg. 5(11) fields are on the page before the order is placed, not only
  // after it.
  assert.ok(html.includes("12.345 g"));
  assert.ok(html.includes("22K (916)"));

  // NO COD, and no control that could ask for one.
  assert.doesNotMatch(html, /value="cod"/i);
  assert.doesNotMatch(html, /name="plan"[^>]*value="cash/i);
  assert.ok(html.includes("There is no cash on delivery at this shop"));

  // Rule 4(9): no pre-ticked consent box, anywhere on the page.
  assert.doesNotMatch(html, /<input[^>]*type="checkbox"[^>]*checked/i);
});

test("the confirmation states what happened and does not dress it up", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);
  const placed = await order(SUBMISSION, { cookie });
  assert.equal(placed.response.status, 201);

  const html = await checkoutHtml(cookie, `?notice=placed&ref=${placed.body.orderNumber}`);

  assert.equal((html.match(/<h1[\s>]/g) ?? []).length, 1);
  assert.ok(html.includes("Your order is recorded."));
  assert.ok(html.includes(placed.body.orderNumber));
  assert.ok(html.includes(placed.body.complaintTicketNumber));

  // THE SENTENCE THE WHOLE FLAG EXISTS FOR.
  assert.ok(html.includes("No payment has been taken"));
  assert.ok(html.includes("Nothing has been charged and nothing has been paid"));
  assert.ok(html.includes("It has not been paid for"));
  assert.ok(html.includes("Awaiting payment"));
  assertNoSettledPaymentLanguage(html, "/checkout (confirmed)");

  // The statutory snapshot is printed from the order row, with no join back to
  // the catalogue: description, net weight, purity in carat and fineness, and
  // hallmarking as its own line.
  assert.ok(html.includes("Net metal weight"));
  assert.ok(html.includes("12.345 g"));
  assert.ok(html.includes("22K (916)"));
  assert.ok(html.includes("Hallmarking"));
  assert.ok(html.includes("7113"));
  assert.ok(html.includes("CGST"));
  assert.ok(html.includes("SGST"));
});

test("a stranger holding the order number sees nothing of the order", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);
  const placed = await order(SUBMISSION, { cookie });

  const html = await checkoutHtml(newCartToken(), `?ref=${placed.body.orderNumber}`);
  assert.ok(!html.includes("Meera Sharma"), "a stranger was shown the buyer's name");
  assert.ok(!html.includes(placed.body.complaintTicketNumber));
  assert.ok(!html.includes("Your order is recorded."));
});

test("checkout is not indexable and never renders the cart token", async () => {
  makePriceable(worker);
  const cookie = await addPiece(HAAR);
  const html = await checkoutHtml(cookie);

  assert.match(html, /name="robots"[^>]*content="[^"]*noindex/i);
  assert.ok(!html.includes(cookie), "the cart token was rendered into the page");
  assert.ok(!html.includes("aj_cart"));
});

test("only a published notice code is rendered, and a failure is not dressed up", async () => {
  const failure = await checkoutHtml(null, "?notice=unavailable");
  assert.match(failure, /We could not reach our order book just now/);

  const injected = await checkoutHtml(null, "?notice=%3Cscript%3Ealert(1)%3C%2Fscript%3E");
  assert.ok(!injected.includes("checkout-notice"), "an unknown notice code rendered a banner");
  assert.ok(!injected.includes("<script>alert(1)"), "the query string was reflected as markup");
});

/* =========================================================================
 * 5. What the rest of the site says about ordering
 * ====================================================================== */

test("the cart carries a proceed-to-checkout control", async () => {
  const cookie = await addPiece(HAAR);
  const cart = await fetchWorker("/cart", {
    headers: { accept: "text/html", cookie: `${CART_COOKIE}=${cookie}` },
  });
  const html = await cart.text();

  assert.match(html, /href="\/checkout"/);
  // Nothing here is priced, so the control is not a button that would fail: it
  // is the page that explains, piece by piece, why it cannot.
  assert.ok(html.includes("Why these cannot be ordered yet"));
});

test("the homepage says what a visitor can actually do today", async () => {
  const home = await fetchWorker("/", { headers: { accept: "text/html" } });
  const html = await home.text();

  // The row sits in the one table whose whole argument is that every line in it
  // can be verified from this site as it stands.
  assert.ok(html.includes("How to buy"));
  assert.ok(
    html.includes(
      "In the shop by appointment, or by enquiry here. Checkout takes no payment, and no piece is priced yet, so nothing can be ordered today."
    )
  );
  // The old wording claimed there was no online ordering at all, which stopped
  // being true the moment /checkout existed.
  assert.ok(!html.includes("Online ordering is not open yet.</td>"));
});
