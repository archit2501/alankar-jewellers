/**
 * THE ORDER DATA LAYER. One module, read by `/checkout` and by `/api/orders`.
 *
 * An order is the highest-stakes row this system writes. It is a GST invoice, a
 * BIS Reg. 5(11) record and a Consumer Protection (E-Commerce) Rule 7 document
 * at the same time, it is append-only, and it must reconstruct to the paise in
 * 2031. Everything below is shaped by that.
 *
 * ===========================================================================
 * 1. ORDER CREATION IS REAL. ONLY PAYMENT CAPTURE IS FLAGGED.
 * ===========================================================================
 * `PAYMENT_CAPTURE_ENABLED` is false and will stay false until the shop holds a
 * BIS certificate, because gateway KYC for a jeweller is underwritten on it
 * (research/02-market-tech.md §3.4). What the flag gates is EXACTLY what §3.9
 * says it gates: creating a gateway order, mounting a gateway widget, the
 * webhook capture branch, and refunds. None of those exist in this file.
 *
 * What is NOT gated, and is genuinely written on every placement: the
 * `price_quotes` row, the `orders` row, one `order_items` row per line, the
 * `payments` row, the stock decrement, the reservation consumption and the
 * cart conversion. The order is a real commercial record from day one; the
 * money step is the only inert part, and it is inert in a way the customer is
 * told about in plain words rather than dressed up. See `paymentStanding()`.
 *
 * NOTHING HERE MAY SAY OR IMPLY THAT MONEY WAS RECEIVED. `orders.status` is
 * `pending_payment`, `orders.paymentStatus` is `unpaid`, `advancePaidPaise` is
 * 0 and the `payments` row is `status = 'created'` — an intent recorded, not a
 * capture. There is no code path below that writes `captured`, `paid` or
 * `advance_paid`, and there must not be one until the flag flips.
 *
 * ===========================================================================
 * 2. AN UNPRICEABLE ORDER IS UNREPRESENTABLE, NOT MERELY DISCOURAGED
 * ===========================================================================
 * Every seeded piece is `pricing_mode = 'on_request'` and the rate layer fails
 * closed, so TODAY no cart in this shop has a resolvable price. The footing
 * CHECK constraints on `orders` would cheerfully accept `0 = 0 + 0 + 0`, and
 * that row would be a statutory document asserting that a piece sold for
 * nothing. So there are four independent layers, and the first two are the
 * ones that matter:
 *
 *   (a) TYPE LEVEL. `placeOrder()` takes a `PriceableCheckout`, which is a
 *       class with a `private` member. TypeScript types classes with private
 *       members NOMINALLY, so no object literal — however carefully shaped —
 *       is assignable to it. The only way to obtain one is to construct one.
 *   (b) RUNTIME, IN THE CONSTRUCTOR. `new PriceableCheckout(...)` throws unless
 *       every line carries a resolved price, the quote foots, and the total is
 *       strictly positive. Because the check lives in the constructor rather
 *       than in a factory, EVERY instance that exists anywhere is valid — there
 *       is no unchecked path to a value of this type.
 *   (c) THE PRICE ENGINE. `priceLine()` throws `not_priceable` for
 *       `on_request`, and `assertFoots()` runs on every call.
 *   (d) THE DATABASE. `price_quotes_amount_due_ck` is
 *       `amount_due_now_paise > 0`, so a zero-value placement aborts the batch
 *       even if (a)–(c) were all removed.
 *
 * `resolveCheckout()` is the only producer, and it refuses the WHOLE cart when
 * ANY line is unpriceable — never a partial order — for the same reason
 * `/cart` refuses to show a partial total: a subset is a smaller number than
 * the truth. The customer is routed to the enquiry path that already works.
 *
 * ===========================================================================
 * 3. THE DATABASE IS THE ONLY SINK, AND IT IS NOT OPTIONAL
 * ===========================================================================
 * `/api/appointments` treats "D1 **or** the webhook accepted it" as success,
 * because a lead that reached a human is a captured lead. FOR AN ORDER THAT IS
 * BACKWARDS: a notification with no database row is a lost order — no invoice,
 * no stock decrement, no record that the customer's money is owed against
 * anything. So the D1 write is authoritative and non-optional here, a
 * notification failure is a logged warning and never a successful order, and
 * there is no throttle: a customer's legitimate second order is a second order.
 * Recorded as a hazard in `.claude-protocol/state.json`; inverted deliberately.
 *
 * ===========================================================================
 * 4. ONE BATCH, AND WHY EACH STATEMENT IS IN IT
 * ===========================================================================
 * D1 has no interactive transactions: `drizzle.transaction()` throws, and
 * `db.batch()` is one transaction. `db/schema.ts` therefore specifies a single
 * batch for the whole placement. `placeOrder()` emits exactly one, in the order
 * the schema asks for:
 *
 *   1  INSERT webhook_events      the idempotency key. See (5).
 *   2  INSERT price_quotes        the frozen composition, written `consumed`.
 *   3  INSERT orders              the statutory snapshot.
 *   4  INSERT order_items × N     one statement per line. See (6).
 *   5  INSERT payments            provider `manual`, status `created`.
 *   6  UPDATE variants            the decrement. See (7).
 *   7  UPDATE stock_reservations  this cart's hold, `held` -> `consumed`.
 *   8  UPDATE carts               `open` -> `converted`.
 *
 * ONE DEVIATION FROM THE SCHEMA'S LIST, DELIBERATE: `price_quotes` is INSERTED
 * here rather than being inserted earlier and marked `consumed` here. With no
 * gateway in the loop there is no interval between quoting and ordering to
 * protect, and writing it in the same transaction means a quote can never
 * outlive a placement that failed. It is written with `status = 'consumed'` for
 * the same reason. When the gateway goes live the row moves back to "proceed to
 * pay" and statement 2 becomes the UPDATE the schema describes; nothing else in
 * this list changes.
 *
 * AND ONE STATEMENT THAT USED TO BE HERE AND IS NOT: a `support_tickets` row.
 * See (10) — a purchase is not a grievance, and every row in that table
 * asserts two statutory deadlines against the shop.
 *
 * ===========================================================================
 * 5. IDEMPOTENCY IS THE ROLLBACK
 * ===========================================================================
 * `webhook_events.id` is a primary key and the insert sits INSIDE the order
 * batch, so a replay collides on the key and the entire duplicate placement —
 * order, line items, payment row and stock decrement together — is discarded.
 * That is the closest thing to a rollback D1 offers.
 *
 * With capture off there is no gateway event id, so the key is the placement's
 * own natural identity: `manual:cart:<cartId>`. One cart converts to at most
 * one order, ever, enforced by SQLite rather than by a guard. Two simultaneous
 * "Place order" submissions therefore produce exactly one order and the loser
 * is told — truthfully — that the order is already placed, WITH its number,
 * rather than being answered with a fabricated success. A customer's next
 * order uses a new cart (this one is `converted`), so nothing legitimate is
 * suppressed. When the gateway goes live the provider's event id takes this
 * slot unchanged.
 *
 * ===========================================================================
 * 6. THE 100-BOUND-PARAMETER CAP
 * ===========================================================================
 * One INSERT per line item, never a multi-row VALUES. The widest statement here
 * binds 46 parameters (`orders`); a line item binds 37. Two line items in one
 * statement would be 74 and would pass; six would be 222 and would fail where a
 * two-item cart passed. `MAX_CHECKOUT_LINES` additionally bounds the batch at
 * 5 + 3N statements.
 *
 * ===========================================================================
 * 7. THE DECREMENT CARRIES NO `WHERE stock_quantity >= ?` GUARD, ON PURPOSE
 * ===========================================================================
 * `db/schema.ts` asks for the guard and for the CHECK. Written literally as a
 * WHERE clause the guard DEFEATS the CHECK: a decrement that would oversell
 * matches no row, updates nothing, commits quietly, and the order is created
 * against stock that does not exist — precisely the outcome rule (2) exists to
 * prevent. So the guard is not omitted, it is RELOCATED into the constraint:
 * `CHECK (stock_quantity >= 0)` applied to `stock_quantity - quantity` is
 * exactly `stock_quantity >= quantity`, and expressed there it aborts the batch
 * instead of skipping a row. `changes === 1` is asserted afterwards, which
 * catches a variant that has vanished — a case that cannot oversell.
 *
 * This is also why a lapsed reservation is not a money-critical failure: if
 * another cart took the piece and ordered first, our decrement goes negative
 * and the CHECK destroys our whole placement. The reservation is the courtesy;
 * the constraint is the guarantee.
 *
 * ===========================================================================
 * 8. NO COD, EXPRESSED STRUCTURALLY
 * ===========================================================================
 * ₹2,00,000 arrives from three independent directions: NPCI caps UPI P2M for
 * the jewellery category at ₹2 lakh; Income-tax Act 2025 s.186 bars RECEIVING
 * ₹2,00,000 or more in cash, aggregating per person per day AND per event, with
 * a s.451 penalty equal to 100% of the sum received; and couriers ban jewellery
 * outright (Blue Dart bans "Precious & Semi-Precious Items" across all
 * services). `orders_no_cod_ck` makes a cash-owing shipped order unrepresentable
 * and this module never offers one: a shipped order is `full_prepaid`, and a
 * balance may exist only on a `booking_advance` order collected in store.
 *
 * ===========================================================================
 * 9. CANCELLATION — THE ONLY WAY A PIECE GOES BACK ON THE WALL
 * ===========================================================================
 * `DECREMENT_STOCK` above was for a long time the ONLY statement in this
 * application that touched `variants.stockQuantity`, and it only ever
 * subtracted. With capture off, every order is unpaid by construction, so an
 * abandoned order retired a one-of-a-kind piece permanently and the shop had no
 * way to put it back. `cancelOrder()` is that way, and it is ONE `db.batch()`:
 *
 *   1  INSERT webhook_events   `manual:order:<id>:cancelled`. See below.
 *   2  UPDATE orders           the transition, gated by the DATABASE.
 *   3  UPDATE variants × N     the restore, one statement per variant.
 *   4  INSERT admin_audit_log  who, what, and why, as a machine record.
 *
 * IDEMPOTENCY IS STRUCTURAL, NOT CHECKED. Statement 1 is the same device
 * placement uses: a primary key that a second attempt collides on, inserted
 * INSIDE the batch it protects, so a second "Cancel" click discards the whole
 * duplicate cancellation — including the second restore — rather than adding a
 * second copy of a piece there is only one of. Nothing here reads the status
 * first and trusts what it read, because between that read and the write
 * anything may happen.
 *
 * WHICH STATES MAY BE CANCELLED IS ALSO DECIDED BY THE DATABASE. Statement 2 is
 *
 *     SET status = CASE WHEN <cancellable> THEN 'cancelled' ELSE NULL END
 *
 * and `orders.status` is NOT NULL. An order that has shipped therefore does not
 * fail a WHERE clause and quietly change nothing — it violates a constraint and
 * ABORTS THE WHOLE BATCH, so the restore in statement 3 can never run against
 * a piece that has already left the shop. This is (7) again, one table over:
 * the guard is not written as a WHERE clause, it is relocated into a constraint
 * where a violation destroys the transaction instead of skipping a row.
 *
 * `stock_reservations` IS LEFT `consumed`. It is a checkout lock with a TTL,
 * not an inventory record: its partial unique index permits one *live* hold per
 * variant, so moving a spent hold back to `held` would take the freshly
 * restored piece off sale again and block the next buyer until it expired. The
 * inventory fact is `variants.stockQuantity`, and that is what is restored.
 *
 * NOTHING IS DELETED. See `db/schema.ts` compensation (7): the order stays, its
 * statutory snapshot stays untouched to the paise, and `cancelled_at`,
 * `cancelled_by` and `cancellation_reason_code` say who ended it and why —
 * which is what Rule 4(8) and any subsequent dispute turn on.
 *
 * ===========================================================================
 * 10. A PURCHASE IS NOT A COMPLAINT
 * ===========================================================================
 * `placeOrder()` used to write a `support_tickets` row for every order, with
 * `acknowledgeDueAt = placedAt + 48h`. Consumer Protection (E-Commerce)
 * Rule 4(5)'s clocks run from the receipt of a CONSUMER COMPLAINT, and
 * Rule 7(1)(f)'s ticket number is issued per COMPLAINT LODGED. A purchase is
 * neither. Three things followed and all three were real:
 *
 *   Within two days of launch the database asserted a breached acknowledgement
 *   deadline on every order the shop had ever taken. A record of a breach that
 *   did not happen is worse than no record, because it is what gets produced in
 *   a consumer-commission proceeding.
 *
 *   `support_tickets_status_due_idx` exists so an overdue queue is one indexed
 *   query. With every order in it, the one genuinely angry customer is
 *   invisible.
 *
 *   `orders.complaintTicketNumber` is a single column under a UNIQUE index and
 *   was consumed at placement by a `kind='query'` row. When a real complaint
 *   arrived there was nowhere to record its Rule 7(1)(f) number.
 *
 * So placement opens no ticket and leaves `complaintTicketNumber` NULL, and
 * `lodgeComplaint()` is the one and only producer of a `support_tickets` row.
 * The customer already has a reference to quote — the order number — and the
 * confirmation page prints that when there is no ticket.
 */

import { env } from "cloudflare:workers";
import {
  GST_RATE_BPS,
  isPriceableMetal,
  priceQuote,
  purityLabel,
  splitGst,
  type MakingCharge,
  type MetalRate,
  type PriceLineInput,
  type PricedQuote,
} from "../_pricing/price";
import { readCurrentRate, type RateLookup } from "../_pricing/rates";
import { SITE_DETAILS_PENDING, site } from "../site-config";
import { d1CartDb, readCart, type CartDb, type CartStatement } from "./cart";

/* =========================================================================
 * The flag
 * ====================================================================== */

/**
 * THE ONE TOGGLE. False until the shop's Razorpay/Cashfree KYC clears, which is
 * itself gated on a BIS certificate — weeks to months.
 *
 * A compile-time constant rather than an environment binding, deliberately:
 * every sentence this site says about payment is derived from it (see
 * `paymentStanding()`), so it must not be possible for the deployed copy to
 * disagree with the deployed behaviour because someone set a variable in a
 * dashboard. Flipping it is a reviewed change to source, which is what a change
 * of this consequence deserves.
 */
export const PAYMENT_CAPTURE_ENABLED = false;

/* =========================================================================
 * Constants — every one of them a cited figure, not a preference
 * ====================================================================== */

/**
 * Income-tax Act 2025 s.262(9) puts an affirmative duty on the SELLER to ensure
 * PAN has been quoted for notified transactions; the ₹2,00,000 goods-and-
 * services threshold survives into Rule 159 (the renumbering of Rule 114B), and
 * under 114B it applied irrespective of the mode of payment — card, UPI and
 * bank transfer included. Penalty s.467: ₹10,000 per default. The comparator is
 * "or more", so ₹2,00,000 exactly is caught.
 */
export const PAN_REQUIRED_AT_PAISE = 20_000_000;

/**
 * The booking advance, in basis points of the order total. 25% is what the
 * trade actually uses for a reserve-and-settle-in-store purchase (Candere
 * publishes "you can pay 25% of the total product value in advance online").
 *
 * It is a figure the shop may want to change; it is here rather than inline so
 * changing it is one edit, and it is BPS so no float ever touches money.
 */
export const BOOKING_ADVANCE_BPS = 2500;

/** How long a quote stands. Gold moves twice every business day. */
export const QUOTE_TTL_MINUTES = 30;

/**
 * The batch is 9 + 3N statements and the widest binds 47 parameters, so this
 * bound is about keeping one transaction comprehensible rather than about the
 * parameter cap. A cart this large in a one-of-a-kind shop is a data problem.
 */
export const MAX_CHECKOUT_LINES = 20;

/**
 * Consumer Protection (E-Commerce) Rule 4(5): acknowledge within 48 hours OF
 * THE RECEIPT OF A CONSUMER COMPLAINT. Not of a purchase — see (10).
 */
export const TICKET_ACKNOWLEDGE_HOURS = 48;

/**
 * DPDP s.6(10) puts the burden of proving consent on us, so the version of the
 * notice shown is recorded rather than a boolean. Bump this whenever the words
 * beside the consent control change.
 */
export const CONSENT_VERSION = "checkout-2026-08";

/** HSN 7113 is finished jewellery. Only loose stones or coins diverge. */
const DEFAULT_HSN = "7113";

/* =========================================================================
 * Place of supply
 * ====================================================================== */

/**
 * GST state codes. The CGST+SGST vs IGST split is decided by PLACE OF SUPPLY —
 * IGST Act s.10(1)(a): where the supply involves movement of goods, the place
 * of supply is where the movement terminates for delivery. So it is the
 * DELIVERY state, never the billing address; for a store pickup it is the
 * shop's own state.
 *
 * This list is also the address form's state control, which is why it carries
 * names rather than only codes. 25 (Daman & Diu) and 28 (the old Andhra
 * Pradesh) are retired and deliberately absent: offering them would let a
 * customer put a dead state code on an invoice.
 */
export const GST_STATES: readonly { readonly code: string; readonly name: string }[] = [
  { code: "01", name: "Jammu and Kashmir" },
  { code: "02", name: "Himachal Pradesh" },
  { code: "03", name: "Punjab" },
  { code: "04", name: "Chandigarh" },
  { code: "05", name: "Uttarakhand" },
  { code: "06", name: "Haryana" },
  { code: "07", name: "Delhi" },
  { code: "08", name: "Rajasthan" },
  { code: "09", name: "Uttar Pradesh" },
  { code: "10", name: "Bihar" },
  { code: "11", name: "Sikkim" },
  { code: "12", name: "Arunachal Pradesh" },
  { code: "13", name: "Nagaland" },
  { code: "14", name: "Manipur" },
  { code: "15", name: "Mizoram" },
  { code: "16", name: "Tripura" },
  { code: "17", name: "Meghalaya" },
  { code: "18", name: "Assam" },
  { code: "19", name: "West Bengal" },
  { code: "20", name: "Jharkhand" },
  { code: "21", name: "Odisha" },
  { code: "22", name: "Chhattisgarh" },
  { code: "23", name: "Madhya Pradesh" },
  { code: "24", name: "Gujarat" },
  { code: "26", name: "Dadra and Nagar Haveli and Daman and Diu" },
  { code: "27", name: "Maharashtra" },
  { code: "29", name: "Karnataka" },
  { code: "30", name: "Goa" },
  { code: "31", name: "Lakshadweep" },
  { code: "32", name: "Kerala" },
  { code: "33", name: "Tamil Nadu" },
  { code: "34", name: "Puducherry" },
  { code: "35", name: "Andaman and Nicobar Islands" },
  { code: "36", name: "Telangana" },
  { code: "37", name: "Andhra Pradesh" },
  { code: "38", name: "Ladakh" },
  { code: "97", name: "Other Territory" },
];

const STATE_BY_CODE = new Map(GST_STATES.map((state) => [state.code, state]));

const STATE_CODE_BY_NAME = new Map(
  GST_STATES.map((state) => [state.name.toLowerCase(), state.code])
);

export function isGstStateCode(value: unknown): value is string {
  return typeof value === "string" && STATE_BY_CODE.has(value);
}

/** The printable state name for a code, or the code itself. */
export function gstStateName(code: string): string {
  return STATE_BY_CODE.get(code)?.name ?? code;
}

/**
 * THE SHOP'S OWN STATE, which the split cannot be computed without.
 *
 * `site.address.region` is still the placeholder string "State" and
 * `SITE_DETAILS_PENDING` is true, so there is no honest answer from the site
 * config today and this returns null — which blocks order creation with a
 * stated reason, exactly as an unpriceable line does. Guessing here would mean
 * guessing whether a sale is intra-state or inter-state, which is a tax
 * treatment and not a default.
 *
 * `SHOP_GST_STATE_CODE` is read as a binding so an operator can supply the real
 * code before the rest of the address facts are settled (the `LEAD_WEBHOOK_URL`
 * pattern). It is an operator SETTING a fact, never this code inventing one.
 */
export function shopStateCode(): string | null {
  if (!SITE_DETAILS_PENDING) {
    const fromConfig = STATE_CODE_BY_NAME.get(site.address.region.trim().toLowerCase());
    if (fromConfig !== undefined) return fromConfig;
  }

  const binding = (env as unknown as Record<string, unknown>).SHOP_GST_STATE_CODE;
  return isGstStateCode(binding) ? binding : null;
}

/* =========================================================================
 * Handles — the human-facing order and ticket numbers
 * ====================================================================== */

/**
 * Crockford's base32 alphabet: no I, L, O or U, so nothing is misread off a
 * printed invoice and no accidental word is ever produced. 256 is an exact
 * multiple of 32, so the byte-to-symbol map below is unbiased.
 */
const HANDLE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const HANDLE_LENGTH = 6;

const IST_OFFSET_MS = 330 * 60_000;

/** `AJ-2608-4KX9P2`. */
export const ORDER_NUMBER_PATTERN = /^AJ-\d{4}-[0-9A-HJKMNP-TV-Z]{6}$/;
/** `AJ-C-2608-4KX9P2`. */
export const TICKET_NUMBER_PATTERN = /^AJ-C-\d{4}-[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * A new order number.
 *
 * NOT A SEQUENCE, and this is a departure from the illustrative "AJ-2607-0042"
 * in `db/schema.ts`. A counter would need a read-modify-write that D1 cannot
 * make safe without an interactive transaction, and — more to the point — a
 * sequential handle leaks order volume to anyone who buys twice, which is the
 * exact reason that file gives for not exposing the primary key. The suffix is
 * six CSPRNG symbols from a 32-symbol alphabet: about 1.07e9 values, and
 * `orders_order_number_unique` aborts the batch on the collision that will not
 * happen, so a collision costs a retry and never a wrong document.
 *
 * The YYMM half is IST, because that is the clock the shop and the customer
 * both read; an order placed at 00:30 IST on the 1st belongs to that month.
 */
export function newOrderNumber(nowMs: number = Date.now()): string {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const yy = String(ist.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");

  const bytes = crypto.getRandomValues(new Uint8Array(HANDLE_LENGTH));
  let suffix = "";
  for (const byte of bytes) suffix += HANDLE_ALPHABET[byte % HANDLE_ALPHABET.length];

  return `AJ-${yy}${mm}-${suffix}`;
}

/**
 * A complaint ticket number, E-Commerce Rule 7(1)(f).
 *
 * DRAWN, NOT DERIVED FROM THE ORDER. An earlier version of this function
 * returned `orderNumber.replace("AJ-", "AJ-C-")`, which is a bijection with the
 * order and therefore permits exactly one ticket per order — while Rule 7(1)(f)
 * is a number per COMPLAINT LODGED, and one order can legitimately generate a
 * second complaint. `support_tickets_ticket_number_unique` would have refused
 * that second one. Same alphabet, same shape and the same collision story as
 * `newOrderNumber()`: the unique index aborts the batch on the collision that
 * will not happen.
 */
export function newTicketNumber(nowMs: number = Date.now()): string {
  return newOrderNumber(nowMs).replace(/^AJ-/, "AJ-C-");
}

export function isTicketNumber(value: unknown): value is string {
  return typeof value === "string" && TICKET_NUMBER_PATTERN.test(value);
}

export function isOrderNumber(value: unknown): value is string {
  return typeof value === "string" && ORDER_NUMBER_PATTERN.test(value);
}

/* =========================================================================
 * Field normalisation
 * ====================================================================== */

/**
 * Indian mobile normalisation, character-for-character the rule
 * `/api/appointments` applies, so one person is one `customers.phone` however
 * they arrived. It is reimplemented rather than imported because that module is
 * a route handler that pulls in `env` and the ORM; this file must stay
 * importable by the page, the endpoint and the tests alike.
 */
export function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return "";

  let local = digits;
  if (local.length > 10 && local.startsWith("91")) local = local.slice(2);
  if (local.length > 10 && local.startsWith("0")) local = local.replace(/^0+/, "");

  if (local.length === 10) return `+91${local}`;
  return `+${digits}`;
}

/** 5 letters, 4 digits, 1 letter. Sensitive PII: never logged, never notified. */
const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;

/** 2-digit state code, 10-character PAN, entity digit, "Z", one checksum. */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

/** Indian PIN codes never begin with 0. */
const PINCODE_PATTERN = /^[1-9][0-9]{5}$/;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isoAt(nowMs: number, plusMinutes = 0): string {
  return new Date(nowMs + plusMinutes * 60_000).toISOString();
}

function asText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function asInt(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "bigint") return Number(value);
  return null;
}

/* =========================================================================
 * Reading the cart as a set of priceable inputs
 * ====================================================================== */

/**
 * Everything an order line needs, read STRAIGHT FROM D1 rather than through
 * `app/_data/catalogue.ts`.
 *
 * That layer falls back to a compiled seed when D1 is unreachable, which is
 * right for browsing and catastrophic for commerce: an order built from a
 * fallback would decrement stock that the database never confirmed exists. A
 * cart that cannot be read from the database is not a cart that can be ordered.
 */
const SELECT_CHECKOUT_LINES = `
  SELECT ci.variant_id            AS "variantId",
         ci.quantity              AS "quantity",
         p.id                     AS "productId",
         p.slug                   AS "slug",
         p.title                  AS "title",
         p.subtitle               AS "subtitle",
         p.sale_mode              AS "saleMode",
         v.sku                    AS "sku",
         v.metal                  AS "metal",
         v.fineness               AS "fineness",
         v.size                   AS "size",
         v.colour                 AS "colour",
         v.pricing_mode           AS "pricingMode",
         v.net_metal_weight_mg    AS "netMetalWeightMg",
         v.gross_weight_mg        AS "grossWeightMg",
         v.making_charge_type     AS "makingChargeType",
         v.making_charge_value    AS "makingChargeValue",
         v.stone_value_paise      AS "stoneValuePaise",
         v.hallmarking_paise      AS "hallmarkingPaise",
         v.other_charges_paise    AS "otherChargesPaise",
         v.fixed_price_paise      AS "fixedPricePaise",
         v.huid                   AS "huid",
         v.certificate_number     AS "certificateNumber",
         v.certificate_lab        AS "certificateLab",
         v.diamond_origin         AS "diamondOrigin",
         v.country_of_origin      AS "countryOfOrigin",
         v.hsn_code               AS "hsnCode",
         v.stock_quantity         AS "stockQuantity",
         r.cart_id                AS "holderCartId"
  FROM cart_items ci
  JOIN variants v ON v.id = ci.variant_id
  JOIN products p ON p.id = v.product_id
  LEFT JOIN stock_reservations r
    ON r.variant_id = ci.variant_id AND r.status = 'held'
  WHERE ci.cart_id = ? AND p.status = 'active'
  ORDER BY ci.added_at ASC, p.slug ASC`;

type CheckoutRow = {
  readonly variantId: string;
  readonly quantity: number;
  readonly productId: string;
  readonly slug: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly saleMode: string;
  readonly sku: string;
  readonly metal: string;
  readonly fineness: number | null;
  readonly size: string | null;
  readonly colour: string | null;
  readonly pricingMode: string;
  readonly netMetalWeightMg: number | null;
  readonly grossWeightMg: number | null;
  readonly makingChargeType: string | null;
  readonly makingChargeValue: number | null;
  readonly stoneValuePaise: number;
  readonly hallmarkingPaise: number;
  readonly otherChargesPaise: number;
  readonly fixedPricePaise: number | null;
  readonly huid: string | null;
  readonly certificateNumber: string | null;
  readonly certificateLab: string | null;
  readonly diamondOrigin: string | null;
  readonly countryOfOrigin: string | null;
  readonly hsnCode: string | null;
  readonly stockQuantity: number;
  readonly holderCartId: string | null;
};

/** Why one line cannot become an order line. Rendered, never swallowed. */
export type LineBlockReason =
  /** `pricing_mode = 'on_request'` — priceable by a human, not by this system. */
  | "on_request"
  /** Dynamic pricing with nothing weighed or assayed. */
  | "not_measured"
  /** A rate exists but IBJA's next publication came and went without one. */
  | "rate_stale"
  /** No rate has ever been recorded, or the rate store is unreadable. */
  | "rate_missing"
  /** The owner has not opened this piece for online sale. */
  | "not_for_sale_online"
  /** Another cart holds the reservation right now. */
  | "held_by_another"
  /** The piece has left the shop since it was added. */
  | "sold_out"
  /** The engine refused the inputs. Logged in full; never guessed around. */
  | "not_priceable";

export type BlockedLine = {
  readonly slug: string;
  readonly title: string;
  readonly reason: LineBlockReason;
};

/** One line that CAN be ordered, with its full statutory composition. */
export type PricedCheckoutLine = {
  readonly row: CheckoutRow;
  readonly input: PriceLineInput;
  /** The exact `gold_rates` row this line was priced from. Null when flat-quoted. */
  readonly rate: {
    readonly id: string;
    readonly ratePerTenGramsPaise: number;
    readonly effectiveFrom: string;
    readonly capturedAt: string;
  } | null;
  /** "22K (916)", or null for a piece with no metal purity to print. */
  readonly purityLabel: string | null;
};

/* =========================================================================
 * The priceable checkout — the type an order cannot be created without
 * ====================================================================== */

export class PriceableOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PriceableOrderError";
  }
}

/**
 * A CART THAT CAN LAWFULLY BECOME AN ORDER.
 *
 * The `private` member below is not decoration. TypeScript types a class with a
 * private member NOMINALLY: no object literal, and no other class with the same
 * shape, is assignable to `PriceableOrderCheckout`. Combined with the fact that
 * every check lives in the CONSTRUCTOR rather than in a factory function, the
 * invariant is total — there is no value of this type anywhere, however it was
 * obtained, that does not carry a positive, footing, fully composed price.
 *
 * `placeOrder()` takes one of these and nothing else, so "create an order for a
 * cart with no resolvable price" is not a thing a caller can express.
 */
export class PriceableOrderCheckout {
  /** The nominal brand. See the class comment; this is why it exists. */
  private readonly priceable = true;

  readonly cartId: string;
  readonly lines: readonly PricedCheckoutLine[];
  readonly quote: PricedQuote;
  readonly nowMs: number;

  constructor(input: {
    cartId: string;
    lines: readonly PricedCheckoutLine[];
    quote: PricedQuote;
    nowMs: number;
  }) {
    if (input.lines.length === 0) {
      throw new PriceableOrderError("a checkout must contain at least one line");
    }
    if (input.lines.length !== input.quote.lines.length) {
      throw new PriceableOrderError(
        `checkout has ${input.lines.length} lines but the quote priced ${input.quote.lines.length}`
      );
    }

    // A zero-value order is the failure this whole class exists to prevent: the
    // footing CHECKs accept 0 = 0 + 0 + 0 and the result is a statutory
    // document asserting a piece sold for nothing.
    if (input.quote.totalPaise <= 0) {
      throw new PriceableOrderError(
        `refusing a checkout whose total is ${input.quote.totalPaise} paise`
      );
    }
    for (const [index, line] of input.quote.lines.entries()) {
      if (line.lineTotalPaise <= 0) {
        throw new PriceableOrderError(
          `refusing a checkout: line ${index + 1} totals ${line.lineTotalPaise} paise`
        );
      }
    }

    // `priceQuote()` already asserts this; re-asserting costs nothing and means
    // a hand-built quote object cannot reach the database either.
    const taxable =
      input.quote.metalValuePaise +
      input.quote.makingChargesPaise +
      input.quote.stoneValuePaise +
      input.quote.hallmarkingPaise +
      input.quote.otherChargesPaise -
      input.quote.discountPaise +
      input.quote.shippingPaise;
    if (taxable !== input.quote.taxablePaise) {
      throw new PriceableOrderError(
        `quote does not foot: components sum to ${taxable}, taxable is ${input.quote.taxablePaise}`
      );
    }
    if (input.quote.taxablePaise + input.quote.gstPaise !== input.quote.totalPaise) {
      throw new PriceableOrderError(
        `quote does not foot: taxable + GST is not ${input.quote.totalPaise}`
      );
    }

    this.cartId = input.cartId;
    this.lines = input.lines;
    this.quote = input.quote;
    this.nowMs = input.nowMs;
  }

  /** Present so the brand is read somewhere rather than being dead weight. */
  get isPriceable(): boolean {
    return this.priceable;
  }

  get lineItemCount(): number {
    return this.lines.length;
  }
}

/* =========================================================================
 * Resolution — the only producer of a PriceableOrderCheckout
 * ====================================================================== */

export type CheckoutBlockReason =
  | "no_cart"
  | "empty_cart"
  | "too_many_lines"
  | "shop_state_unknown"
  | "unpriceable";

export type CheckoutResolution =
  | {
      readonly ok: true;
      readonly checkout: PriceableOrderCheckout;
      readonly shopStateCode: string;
    }
  | {
      readonly ok: false;
      readonly reason: CheckoutBlockReason;
      /** Populated for `unpriceable`; one entry per line that cannot be ordered. */
      readonly blocked: readonly BlockedLine[];
      /** How many lines the cart holds, whatever their state. */
      readonly lineCount: number;
    };

/** Injectable so every arm of the rate union can be driven without a network. */
export type OrderRateReader = (
  metal: string,
  fineness: number,
  nowMs: number
) => Promise<RateLookup>;

export type ResolveOptions = {
  readonly nowMs?: number;
  readonly readRate?: OrderRateReader;
  /** Defaults to `shopStateCode()`. Explicit so a caller cannot forget it. */
  readonly shopStateCode?: string | null;
};

function makingChargeOf(row: CheckoutRow): MakingCharge | undefined {
  const value = row.makingChargeValue ?? 0;
  switch (row.makingChargeType) {
    case "percent":
      return { type: "percent", value };
    case "per_gram":
      return { type: "per_gram", value };
    case "flat":
      return { type: "flat", value };
    default:
      return undefined;
  }
}

/**
 * Turn a cart into either a priceable checkout or a list of stated reasons.
 *
 * ALL OR NOTHING. One unpriceable line refuses the whole cart, for the reason
 * `/cart` refuses to show a partial total: a subset of a basket is a smaller
 * figure than the truth, and here it would additionally be a commercial record
 * of a purchase the customer did not make.
 */
export async function resolveCheckout(
  db: CartDb,
  options: { token: string | null } & ResolveOptions
): Promise<CheckoutResolution> {
  const nowMs = options.nowMs ?? Date.now();
  const readRate = options.readRate ?? readCurrentRate;
  const stateCode =
    options.shopStateCode === undefined ? shopStateCode() : options.shopStateCode;

  // Reading the cart first is not incidental: it runs the lazy expiry sweep and
  // re-claims anything now free, so the hold state the checks below read is the
  // state as of this request rather than as of the page render.
  const snapshot = await readCart(db, { token: options.token, nowMs });
  if (snapshot.cartId === null) {
    return { ok: false, reason: "no_cart", blocked: [], lineCount: 0 };
  }

  const rows = (await db.all(SELECT_CHECKOUT_LINES, [snapshot.cartId])) as unknown as CheckoutRow[];
  if (rows.length === 0) {
    return { ok: false, reason: "empty_cart", blocked: [], lineCount: 0 };
  }
  if (rows.length > MAX_CHECKOUT_LINES) {
    return { ok: false, reason: "too_many_lines", blocked: [], lineCount: rows.length };
  }
  if (stateCode === null) {
    return { ok: false, reason: "shop_state_unknown", blocked: [], lineCount: rows.length };
  }

  const blocked: BlockedLine[] = [];
  const lines: PricedCheckoutLine[] = [];

  for (const row of rows) {
    const block = (reason: LineBlockReason) => {
      blocked.push({ slug: row.slug, title: row.title, reason });
    };

    // CLAIM BEFORE YOU QUOTE. We do not price a piece we are not holding.
    if (row.holderCartId !== snapshot.cartId) {
      block("held_by_another");
      continue;
    }
    if (row.stockQuantity < row.quantity) {
      block("sold_out");
      continue;
    }
    if (row.saleMode !== "buy_online") {
      // `sale_mode` exists so the owner decides per piece whether it is buyable
      // at all. Every seeded piece is `enquire_only`, which is what the shop
      // actually converts a ₹4 lakh bridal set on.
      block("not_for_sale_online");
      continue;
    }

    if (row.pricingMode === "on_request") {
      block("on_request");
      continue;
    }

    if (row.pricingMode === "fixed") {
      if (row.fixedPricePaise === null) {
        block("not_priceable");
        continue;
      }
      lines.push({
        row,
        input: {
          pricingMode: "fixed",
          fixedPricePaise: row.fixedPricePaise,
          hallmarkingPaise: row.hallmarkingPaise,
          otherChargesPaise: row.otherChargesPaise,
          quantity: row.quantity,
          ...(row.fineness !== null && isPriceableMetal(row.metal)
            ? { metal: row.metal, fineness: row.fineness }
            : {}),
        },
        rate: null,
        purityLabel:
          row.fineness !== null && isPriceableMetal(row.metal)
            ? purityLabel(row.fineness, row.metal).display
            : null,
      });
      continue;
    }

    if (row.pricingMode !== "dynamic_metal") {
      block("not_priceable");
      continue;
    }

    if (row.fineness === null || row.netMetalWeightMg === null) {
      // Nothing weighed and nothing assayed. `variants_pricing_inputs_ck`
      // forbids this combination, so it can only mean the row was written
      // before the constraint, and there is no figure to compute either way.
      block("not_measured");
      continue;
    }
    if (!isPriceableMetal(row.metal)) {
      block("not_priceable");
      continue;
    }

    const lookup = await readRate(row.metal, row.fineness, nowMs);
    if (!lookup.ok) {
      // The failure arm has no `rate` property at all, so there is nothing here
      // that could be read as zero. See app/_pricing/rates.ts.
      block(lookup.reason === "rate_stale" ? "rate_stale" : "rate_missing");
      continue;
    }
    if (!isPriceableMetal(lookup.rate.metal)) {
      block("rate_missing");
      continue;
    }

    const rate: MetalRate = {
      metal: lookup.rate.metal,
      fineness: lookup.rate.fineness,
      ratePerTenGramsPaise: lookup.rate.ratePerTenGramsPaise,
    };

    lines.push({
      row,
      input: {
        pricingMode: "dynamic_metal",
        rate,
        metal: row.metal,
        fineness: row.fineness,
        netMetalWeightMg: row.netMetalWeightMg,
        ...(makingChargeOf(row) === undefined
          ? {}
          : { makingCharge: makingChargeOf(row) as MakingCharge }),
        stoneValuePaise: row.stoneValuePaise,
        hallmarkingPaise: row.hallmarkingPaise,
        otherChargesPaise: row.otherChargesPaise,
        quantity: row.quantity,
      },
      rate: {
        id: lookup.rate.id,
        ratePerTenGramsPaise: lookup.rate.ratePerTenGramsPaise,
        effectiveFrom: lookup.rate.effectiveFrom,
        capturedAt: isoAt(nowMs),
      },
      purityLabel: purityLabel(row.fineness, row.metal).display,
    });
  }

  if (blocked.length > 0 || lines.length === 0) {
    return { ok: false, reason: "unpriceable", blocked, lineCount: rows.length };
  }

  let quote: PricedQuote;
  try {
    quote = priceQuote({
      lines: lines.map((line) => line.input),
      // Carriage is arranged by hand — ordinary couriers ban jewellery outright
      // — so no delivery charge is quoted here and the breakup carries no
      // delivery line rather than a misleading zero-value one.
      shippingPaise: 0,
      gstRateBps: GST_RATE_BPS,
    });
  } catch (error) {
    console.error("[orders] the price engine refused a cart it had inputs for:", error);
    return {
      ok: false,
      reason: "unpriceable",
      blocked: lines.map((line) => ({
        slug: line.row.slug,
        title: line.row.title,
        reason: "not_priceable" as const,
      })),
      lineCount: rows.length,
    };
  }

  let checkout: PriceableOrderCheckout;
  try {
    checkout = new PriceableOrderCheckout({
      cartId: snapshot.cartId,
      lines,
      quote,
      nowMs,
    });
  } catch (error) {
    console.error("[orders] a priced cart failed the priceable invariant:", error);
    return {
      ok: false,
      reason: "unpriceable",
      blocked: lines.map((line) => ({
        slug: line.row.slug,
        title: line.row.title,
        reason: "not_priceable" as const,
      })),
      lineCount: rows.length,
    };
  }

  return { ok: true, checkout, shopStateCode: stateCode };
}

/* =========================================================================
 * What the customer tells us
 * ====================================================================== */

export type FulfilmentMode = "ship" | "store_pickup";
export type PaymentPlan = "full_prepaid" | "booking_advance";

export type ShippingAddress = {
  readonly name: string;
  readonly line1: string;
  readonly line2: string | null;
  readonly city: string;
  readonly stateCode: string;
  readonly pincode: string;
};

export type CheckoutDetails = {
  readonly name: string;
  /** E.164, normalised. */
  readonly phone: string;
  readonly email: string | null;
  readonly fulfilmentMode: FulfilmentMode;
  readonly paymentPlan: PaymentPlan;
  readonly ship: ShippingAddress | null;
  readonly pan: string | null;
  readonly gstin: string | null;
  readonly notes: string | null;
  /** Rule 4(9): an explicit affirmative action, never a pre-ticked box. */
  readonly marketingOptIn: boolean;
};

/**
 * The fields a form may get wrong. A CLOSED SET: it travels back to `/checkout`
 * in the query string, and the page renders copy keyed by exact match, so
 * nothing from the request is ever reflected into the document.
 */
export const CHECKOUT_FIELDS = [
  "name",
  "phone",
  "email",
  "fulfilment",
  "plan",
  "shipname",
  "line1",
  "city",
  "state",
  "pincode",
  "pan",
  "gstin",
  "notes",
  "consent",
] as const;

export type CheckoutField = (typeof CHECKOUT_FIELDS)[number];

const FIELD_SET = new Set<string>(CHECKOUT_FIELDS);

export function toCheckoutFields(value: unknown): readonly CheckoutField[] {
  if (typeof value !== "string") return [];
  const seen = new Set<CheckoutField>();
  for (const part of value.split(",")) {
    const key = part.trim();
    if (FIELD_SET.has(key)) seen.add(key as CheckoutField);
  }
  return [...seen];
}

/** What the page says about each field it was told to ask again for. */
export const CHECKOUT_FIELD_PROBLEMS: Readonly<Record<CheckoutField, string>> = {
  name: "We need the name this order is for.",
  phone: "We need a mobile number with at least ten digits — it is how we will reach you about this order.",
  email: "That email address does not look like one. Leave it empty if you would rather we only called.",
  fulfilment: "Please choose whether the piece is collected from the shop or sent to you.",
  plan: "Please choose how you would like to settle this order.",
  shipname: "We need the name the piece should be addressed to.",
  line1: "We need a street address to send the piece to.",
  city: "We need the town or city.",
  state: "We need the state, because it decides how GST is charged on this invoice.",
  pincode: "We need a six-digit PIN code that does not start with a zero.",
  pan: "Orders of ₹2,00,000 or more need the buyer's PAN by law (Income-tax Act 2025 s.262(9)). Ten characters: five letters, four digits, one letter.",
  gstin: "That GSTIN is not fifteen characters in the standard form. Leave it empty unless you are buying for a registered business.",
  notes: "Your note must be 2000 characters or fewer.",
  consent: "Please tick the box to confirm you are placing this order.",
};

export type DetailsValidation =
  | { readonly ok: true; readonly details: CheckoutDetails }
  | { readonly ok: false; readonly fields: readonly CheckoutField[] };

/**
 * Validate what the customer typed, against the order they are actually placing.
 *
 * `totalPaise` is a parameter because two of the rules below are thresholds on
 * the order value, not on the field: PAN above ₹2,00,000, and a booking advance
 * that has to leave a positive balance behind.
 */
export function validateCheckoutDetails(
  raw: Record<string, unknown>,
  context: { readonly totalPaise: number }
): DetailsValidation {
  const fields: CheckoutField[] = [];
  const fail = (field: CheckoutField) => {
    if (!fields.includes(field)) fields.push(field);
  };

  const name = trimmed(raw.name);
  if (!name || name.length > 120) fail("name");

  const phone = normalisePhone(trimmed(raw.phone));
  if (!phone) fail("phone");

  const emailRaw = trimmed(raw.email);
  if (emailRaw && (emailRaw.length > 190 || !EMAIL_PATTERN.test(emailRaw))) fail("email");

  const fulfilmentRaw = trimmed(raw.fulfilment);
  const fulfilmentMode: FulfilmentMode | null =
    fulfilmentRaw === "ship" || fulfilmentRaw === "store_pickup" ? fulfilmentRaw : null;
  if (fulfilmentMode === null) fail("fulfilment");

  const planRaw = trimmed(raw.plan);
  const paymentPlan: PaymentPlan | null =
    planRaw === "full_prepaid" || planRaw === "booking_advance" ? planRaw : null;
  if (paymentPlan === null) fail("plan");

  // `orders_no_cod_ck`, in code: a balance may exist only on a booking-advance
  // order collected in store, so a shipped order is full prepaid and there is
  // no representable state in which money is owed to a courier at the door.
  if (fulfilmentMode === "ship" && paymentPlan === "booking_advance") fail("plan");
  // A booking advance has to leave something behind to settle. Unreachable for
  // any real piece; the CHECK would refuse it anyway.
  if (paymentPlan === "booking_advance" && context.totalPaise < 2) fail("plan");

  let ship: ShippingAddress | null = null;
  if (fulfilmentMode === "ship") {
    const shipName = trimmed(raw.shipname) || name;
    const line1 = trimmed(raw.line1);
    const line2 = trimmed(raw.line2);
    const city = trimmed(raw.city);
    const stateCode = trimmed(raw.state);
    const pincode = trimmed(raw.pincode);

    if (!shipName || shipName.length > 120) fail("shipname");
    if (!line1 || line1.length > 190) fail("line1");
    if (!city || city.length > 90) fail("city");
    if (!isGstStateCode(stateCode)) fail("state");
    if (!PINCODE_PATTERN.test(pincode)) fail("pincode");

    if (fields.length === 0) {
      ship = {
        name: shipName,
        line1,
        line2: line2 || null,
        city,
        stateCode,
        pincode,
      };
    }
  }

  const panRaw = trimmed(raw.pan).toUpperCase();
  if (panRaw && !PAN_PATTERN.test(panRaw)) fail("pan");
  if (context.totalPaise >= PAN_REQUIRED_AT_PAISE && !PAN_PATTERN.test(panRaw)) fail("pan");

  const gstinRaw = trimmed(raw.gstin).toUpperCase();
  if (gstinRaw && !GSTIN_PATTERN.test(gstinRaw)) fail("gstin");

  const notes = trimmed(raw.notes);
  if (notes.length > 2000) fail("notes");

  // Rule 4(9): consent must be an explicit affirmative action. An absent
  // checkbox is an absent consent, not a default.
  const consent = trimmed(raw.consent);
  if (consent !== "yes" && consent !== "on" && consent !== "true") fail("consent");

  if (fields.length > 0 || fulfilmentMode === null || paymentPlan === null) {
    return { ok: false, fields };
  }

  // Nothing here is pre-ticked, so an absent value is a "no".
  const marketing = trimmed(raw.marketing);
  const marketingOptIn = marketing === "yes" || marketing === "on" || marketing === "true";

  return {
    ok: true,
    details: {
      name,
      phone,
      email: emailRaw || null,
      fulfilmentMode,
      paymentPlan,
      ship,
      pan: panRaw || null,
      gstin: gstinRaw || null,
      notes: notes || null,
      marketingOptIn,
    },
  };
}

/* =========================================================================
 * The money legs
 * ====================================================================== */

export type PaymentLegs = {
  readonly advanceDuePaise: number;
  readonly balanceDuePaise: number;
};

/**
 * Split the total into what is due now and what is settled at the counter.
 *
 * `orders_payment_legs_foot_ck` requires the two to account for the whole
 * order, and `orders_no_cod_ck` requires a balance to exist only on a
 * booking-advance order collected in store. Both hold by construction here.
 */
export function paymentLegs(totalPaise: number, plan: PaymentPlan): PaymentLegs {
  if (plan === "full_prepaid") {
    return { advanceDuePaise: totalPaise, balanceDuePaise: 0 };
  }

  // Integer arithmetic, half up, and clamped so the advance is always at least
  // one paise and always leaves at least one paise to settle in store.
  const scaled = totalPaise * BOOKING_ADVANCE_BPS;
  const advance = Math.floor(scaled / 10000) + (scaled % 10000 >= 5000 ? 1 : 0);
  const advanceDuePaise = Math.min(Math.max(advance, 1), totalPaise - 1);

  return { advanceDuePaise, balanceDuePaise: totalPaise - advanceDuePaise };
}

/* =========================================================================
 * Placement — one batch
 * ====================================================================== */

const INSERT_WEBHOOK_EVENT = `
  INSERT INTO webhook_events (id, provider, event_type, payload_json, processed_at, received_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

const INSERT_PRICE_QUOTE = `
  INSERT INTO price_quotes
    (id, cart_id, metal_value_paise, making_charges_paise, stone_value_paise,
     hallmarking_paise, other_charges_paise, discount_paise, shipping_paise,
     taxable_paise, gst_rate_bps, gst_paise, total_paise, amount_due_now_paise,
     payment_plan, lines_json, created_at, expires_at, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'consumed')`;

const INSERT_ORDER = `
  INSERT INTO orders
    (id, order_number, customer_id, quote_id,
     contact_name, contact_phone, contact_email,
     ship_name, ship_line1, ship_line2, ship_city, ship_state, ship_pincode, ship_country,
     billing_same_as_shipping, billing_json, customer_gstin, customer_pan,
     metal_value_paise, making_charges_paise, stone_value_paise, hallmarking_paise,
     other_charges_paise, discount_paise, shipping_paise, taxable_paise,
     gst_rate_bps, gst_paise, cgst_paise, sgst_paise, igst_paise, total_paise,
     currency, place_of_supply_state_code, payment_plan, fulfilment_mode,
     advance_due_paise, advance_paid_paise, balance_due_paise,
     status, payment_status, fulfilment_status,
     line_item_count, notes, placed_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'IN', 1, NULL, ?, ?,
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'INR', ?, ?, ?,
          ?, 0, ?, 'pending_payment', 'unpaid', 'unfulfilled', ?, ?, ?, ?)`;

const INSERT_ORDER_ITEM = `
  INSERT INTO order_items
    (id, order_id, product_id, variant_id, sku, title_snapshot,
     variant_description_snapshot, image_r2_key_snapshot, metal_snapshot,
     fineness_snapshot, purity_carat_label_snapshot, net_metal_weight_mg,
     gross_weight_mg, gold_rate_id, gold_rate_per_ten_grams_paise,
     gold_rate_effective_from, gold_rate_captured_at, metal_value_paise,
     making_charge_type, making_charge_value, making_charge_paise,
     stone_value_paise, hallmarking_paise, other_charges_paise, huid_snapshot,
     certificate_number_snapshot, certificate_lab_snapshot,
     diamond_origin_snapshot, country_of_origin_snapshot, hsn_code, quantity,
     unit_price_paise, line_discount_paise, line_subtotal_paise,
     line_gst_rate_bps, line_gst_paise, line_total_paise)
  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const INSERT_PAYMENT = `
  INSERT INTO payments
    (id, order_id, quote_id, provider, provider_order_id, provider_payment_id,
     method, kind, amount_paise, status, raw_payload_json, created_at, updated_at)
  VALUES (?, ?, ?, 'manual', NULL, NULL, NULL, ?, ?, 'created', NULL, ?, ?)`;

/**
 * THE DECREMENT. No `WHERE stock_quantity >= ?`: see (7) in the header. The
 * `variants_stock_non_negative_ck` CHECK is what refuses an oversell, and it
 * refuses it by aborting the whole batch rather than by skipping a row.
 */
const DECREMENT_STOCK = `
  UPDATE variants
  SET stock_quantity = stock_quantity - ?, updated_at = ?
  WHERE id = ?`;

const CONSUME_RESERVATION = `
  UPDATE stock_reservations
  SET status = 'consumed'
  WHERE cart_id = ? AND variant_id = ? AND status = 'held'`;

const CONVERT_CART = `
  UPDATE carts SET status = 'converted', updated_at = ? WHERE id = ? AND status = 'open'`;

const UPSERT_CUSTOMER = `
  INSERT INTO customers
    (id, phone, email, name, consent_version, consent_at, marketing_opt_in, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (phone) DO UPDATE SET
    email = excluded.email,
    name = excluded.name,
    consent_version = excluded.consent_version,
    consent_at = excluded.consent_at,
    marketing_opt_in = excluded.marketing_opt_in,
    updated_at = excluded.updated_at
  RETURNING id AS "id"`;

const COUNT_ORDER_ITEMS = `
  SELECT count(*) AS "lineItems" FROM order_items WHERE order_id = ?`;

const SELECT_ORDER_FOR_CART = `
  SELECT o.order_number AS "orderNumber"
  FROM orders o
  JOIN price_quotes q ON q.id = o.quote_id
  WHERE q.cart_id = ?
  ORDER BY o.placed_at ASC
  LIMIT 1`;

export type PlacementFailure =
  /** An order for this cart already exists; the duplicate was discarded. */
  | { readonly reason: "already_placed"; readonly orderNumber: string }
  /** A piece was taken between quoting and committing. Nothing was written. */
  | { readonly reason: "sold_out" }
  /** The batch did not commit. Nothing was written. */
  | { readonly reason: "write_failed"; readonly message: string }
  /**
   * The batch committed but the order does not reconcile against its own
   * `line_item_count`. The order EXISTS; it must not be invoiced or fulfilled.
   */
  | {
      readonly reason: "torn";
      readonly orderNumber: string;
      readonly expected: number;
      readonly found: number;
    };

export type PlacementResult =
  | {
      readonly ok: true;
      readonly orderId: string;
      readonly orderNumber: string;
      readonly totalPaise: number;
      readonly advanceDuePaise: number;
      readonly balanceDuePaise: number;
      readonly paymentPlan: PaymentPlan;
      readonly fulfilmentMode: FulfilmentMode;
      readonly lineItemCount: number;
    }
  | { readonly ok: false } & PlacementFailure;

/** `variant_description_snapshot` — what the invoice prints under the title. */
function describeVariant(row: CheckoutRow, purity: string | null): string | null {
  const parts = [row.subtitle, purity, row.size, row.colour].filter(
    (part): part is string => typeof part === "string" && part.trim().length > 0
  );
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Record the buyer, OUTSIDE the placement batch and best-effort.
 *
 * `orders.customerId` is a weak reference with no foreign key — that is the
 * structural half of the soft-delete design in `db/schema.ts` — and the order
 * snapshots name, phone, email and the whole address inline, so it loses
 * nothing at all when this fails. A customer row is a convenience for a
 * returning buyer and a record of consent; it is not part of the statutory
 * document, it is not in the schema's batch list, and an order must never be
 * lost because it could not be written.
 *
 * It is a separate statement rather than a batch member for a second reason:
 * the id has to be READ BACK (the conflicting row keeps its own), and a batch
 * cannot feed one statement's result into the next.
 */
async function recordCustomer(
  db: CartDb,
  details: CheckoutDetails,
  nowMs: number
): Promise<string | null> {
  const now = isoAt(nowMs);
  try {
    const rows = await db.all(UPSERT_CUSTOMER, [
      crypto.randomUUID(),
      details.phone,
      details.email,
      details.name,
      CONSENT_VERSION,
      now,
      details.marketingOptIn ? 1 : 0,
      now,
      now,
    ]);
    return rows[0] === undefined ? null : asText(rows[0], "id");
  } catch (error) {
    console.warn("[orders] could not record the customer; the order is unaffected:", error);
    return null;
  }
}

/**
 * PLACE THE ORDER. One `db.batch()`, which is one transaction.
 *
 * The only argument that can carry a price is a `PriceableOrderCheckout`, whose
 * constructor has already refused anything unpriced, unfooting or non-positive.
 * There is no parameter here through which a zero-value order can arrive.
 */
export async function placeOrder(
  db: CartDb,
  checkout: PriceableOrderCheckout,
  details: CheckoutDetails,
  options: { readonly shopStateCode: string; readonly nowMs?: number }
): Promise<PlacementResult> {
  // The type system already refuses an object literal here, because the class
  // has a private member and is therefore nominal. This closes the same door
  // for a caller that is not type-checked at all — a `.mjs` test, a future
  // JavaScript admin script — so the invariant holds in both worlds rather than
  // only in the one the compiler can see.
  if (!(checkout instanceof PriceableOrderCheckout)) {
    throw new PriceableOrderError(
      "placeOrder was handed something that is not a PriceableOrderCheckout; " +
        "the only way to obtain one is to construct one, and the constructor refuses an unpriced cart"
    );
  }

  const nowMs = options.nowMs ?? checkout.nowMs;
  const now = isoAt(nowMs);
  const quote = checkout.quote;

  const orderId = crypto.randomUUID();
  const quoteId = crypto.randomUUID();
  const paymentId = crypto.randomUUID();
  const orderNumber = newOrderNumber(nowMs);

  // IGST Act s.10(1)(a): the place of supply is where the movement terminates
  // for delivery. For a store pickup there is no movement, so it is the shop's
  // own state and the supply is always intra-state.
  const placeOfSupply =
    details.fulfilmentMode === "ship" && details.ship !== null
      ? details.ship.stateCode
      : options.shopStateCode;
  const interState = placeOfSupply !== options.shopStateCode;
  const gst = splitGst(quote.gstPaise, { interState });

  const legs = paymentLegs(quote.totalPaise, details.paymentPlan);

  const customerId = await recordCustomer(db, details, nowMs);

  const statements: CartStatement[] = [];

  // 1. IDEMPOTENCY FIRST, so a replay collides before anything else is written.
  //    One cart converts to at most one order, decided by the primary key.
  statements.push({
    sql: INSERT_WEBHOOK_EVENT,
    params: [
      `manual:cart:${checkout.cartId}`,
      "manual",
      "checkout.placed",
      // No PII: this row exists to be collided with, not to be read back.
      JSON.stringify({
        kind: "checkout.placed",
        orderNumber,
        lineItemCount: checkout.lineItemCount,
        totalPaise: quote.totalPaise,
        paymentCaptureEnabled: PAYMENT_CAPTURE_ENABLED,
      }),
      now,
      now,
    ],
  });

  // 2. The frozen composition. Written `consumed`: see (4) in the header.
  statements.push({
    sql: INSERT_PRICE_QUOTE,
    params: [
      quoteId,
      checkout.cartId,
      quote.metalValuePaise,
      quote.makingChargesPaise,
      quote.stoneValuePaise,
      quote.hallmarkingPaise,
      quote.otherChargesPaise,
      quote.discountPaise,
      quote.shippingPaise,
      quote.taxablePaise,
      quote.gstRateBps,
      quote.gstPaise,
      quote.totalPaise,
      legs.advanceDuePaise,
      details.paymentPlan,
      JSON.stringify(
        checkout.lines.map((line, index) => ({
          sku: line.row.sku,
          variantId: line.row.variantId,
          quantity: line.row.quantity,
          purity: line.purityLabel,
          goldRateId: line.rate?.id ?? null,
          goldRatePerTenGramsPaise: line.rate?.ratePerTenGramsPaise ?? null,
          unitPricePaise: quote.lines[index]?.unit.unitPricePaise ?? null,
          lineTotalPaise: quote.lines[index]?.lineTotalPaise ?? null,
        }))
      ),
      now,
      isoAt(nowMs, QUOTE_TTL_MINUTES),
    ],
  });

  // 3. The statutory snapshot.
  statements.push({
    sql: INSERT_ORDER,
    params: [
      orderId,
      orderNumber,
      customerId,
      quoteId,
      details.name,
      details.phone,
      details.email,
      details.ship?.name ?? null,
      details.ship?.line1 ?? null,
      details.ship?.line2 ?? null,
      details.ship?.city ?? null,
      details.ship?.stateCode ?? null,
      details.ship?.pincode ?? null,
      details.gstin,
      details.pan,
      quote.metalValuePaise,
      quote.makingChargesPaise,
      quote.stoneValuePaise,
      quote.hallmarkingPaise,
      quote.otherChargesPaise,
      quote.discountPaise,
      quote.shippingPaise,
      quote.taxablePaise,
      quote.gstRateBps,
      quote.gstPaise,
      gst.cgstPaise,
      gst.sgstPaise,
      gst.igstPaise,
      quote.totalPaise,
      placeOfSupply,
      details.paymentPlan,
      details.fulfilmentMode,
      legs.advanceDuePaise,
      legs.balanceDuePaise,
      checkout.lineItemCount,
      details.notes,
      now,
      now,
    ],
  });

  // 4. ONE INSERT PER LINE ITEM. Never a multi-row VALUES: see (6).
  for (const [index, line] of checkout.lines.entries()) {
    const priced = quote.lines[index];
    if (priced === undefined) {
      // Unreachable: the constructor refuses a checkout whose line count and
      // quote line count disagree. Refusing here too costs one branch and means
      // no partially-composed line can reach the database.
      return {
        ok: false,
        reason: "write_failed",
        message: `line ${index + 1} was not priced`,
      };
    }

    statements.push({
      sql: INSERT_ORDER_ITEM,
      params: [
        crypto.randomUUID(),
        orderId,
        line.row.productId,
        line.row.variantId,
        line.row.sku,
        line.row.title,
        describeVariant(line.row, line.purityLabel),
        line.row.metal,
        line.row.fineness,
        line.purityLabel,
        line.row.netMetalWeightMg,
        line.row.grossWeightMg,
        line.rate?.id ?? null,
        line.rate?.ratePerTenGramsPaise ?? null,
        line.rate?.effectiveFrom ?? null,
        line.rate?.capturedAt ?? null,
        priced.unit.metalValuePaise,
        line.row.makingChargeType,
        line.row.makingChargeValue,
        priced.unit.makingChargePaise,
        priced.unit.stoneValuePaise,
        priced.unit.hallmarkingPaise,
        priced.unit.otherChargesPaise,
        line.row.huid,
        line.row.certificateNumber,
        line.row.certificateLab,
        line.row.diamondOrigin,
        line.row.countryOfOrigin,
        line.row.hsnCode ?? DEFAULT_HSN,
        priced.quantity,
        priced.unit.unitPricePaise,
        priced.lineDiscountPaise,
        priced.lineSubtotalPaise,
        priced.lineGstRateBps,
        priced.lineGstPaise,
        priced.lineTotalPaise,
      ],
    });
  }

  // 5. The payment row. `manual` / `created` — an intent recorded. NOT a
  //    capture, and nothing below ever writes one while the flag is off.
  statements.push({
    sql: INSERT_PAYMENT,
    params: [
      paymentId,
      orderId,
      quoteId,
      details.paymentPlan === "booking_advance" ? "booking_advance" : "full_payment",
      legs.advanceDuePaise,
      now,
      now,
    ],
  });

  // 6 & 7. The decrement, then this cart's hold.
  for (const line of checkout.lines) {
    statements.push({
      sql: DECREMENT_STOCK,
      params: [line.row.quantity, now, line.row.variantId],
    });
  }
  for (const line of checkout.lines) {
    statements.push({
      sql: CONSUME_RESERVATION,
      params: [checkout.cartId, line.row.variantId],
    });
  }

  // 8. The cart is spent.
  //
  //    NO `support_tickets` ROW. A purchase is not a consumer complaint and
  //    must not start Rule 4(5)'s clocks; see (10) and `lodgeComplaint()`.
  statements.push({ sql: CONVERT_CART, params: [now, checkout.cartId] });

  let results: readonly { changes: number }[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    return await classifyPlacementFailure(db, checkout.cartId, error);
  }

  // The decrement must have moved exactly one row per line. A zero here means
  // the variant vanished between the read and the commit — which cannot
  // oversell (the CHECK owns that) but does mean the snapshot is wrong.
  const decrementBase = 3 + checkout.lineItemCount + 1;
  for (let index = 0; index < checkout.lineItemCount; index += 1) {
    if ((results[decrementBase + index]?.changes ?? 0) !== 1) {
      console.error(
        `[orders] ${orderNumber}: stock decrement for ${checkout.lines[index]?.row.sku} changed no row.`
      );
    }
  }

  // THE TORN-WRITE DETECTOR. `db/schema.ts` compensation (5): assert the line
  // items actually written match `orders.lineItemCount` before anything
  // invoices, refunds or fulfils this order.
  const intact = await assertOrderIntact(db, orderId, checkout.lineItemCount);
  if (!intact.ok) {
    console.error(
      `[orders] ${orderNumber} is TORN: line_item_count says ${checkout.lineItemCount}, ${intact.found} rows exist.`
    );
    return {
      ok: false,
      reason: "torn",
      orderNumber,
      expected: checkout.lineItemCount,
      found: intact.found,
    };
  }

  return {
    ok: true,
    orderId,
    orderNumber,
    totalPaise: quote.totalPaise,
    advanceDuePaise: legs.advanceDuePaise,
    balanceDuePaise: legs.balanceDuePaise,
    paymentPlan: details.paymentPlan,
    fulfilmentMode: details.fulfilmentMode,
    lineItemCount: checkout.lineItemCount,
  };
}

/**
 * Work out what a failed batch actually was, by looking rather than by parsing.
 *
 * The authoritative question is "does an order for this cart already exist?",
 * and it is answered with a query instead of a regular expression over an error
 * string — because the wording of a constraint error is the database's
 * business, and a customer being told "already placed" or "nothing was written"
 * must not hinge on it. The message is used only to tell an oversell apart from
 * a generic failure, and only after the authoritative question has said no.
 */
async function classifyPlacementFailure(
  db: CartDb,
  cartId: string,
  error: unknown
): Promise<PlacementResult> {
  const message = error instanceof Error ? error.message : String(error);

  try {
    const rows = await db.all(SELECT_ORDER_FOR_CART, [cartId]);
    const existing = rows[0] === undefined ? null : asText(rows[0], "orderNumber");
    if (existing !== null) {
      // The duplicate collided on `webhook_events.id` and the WHOLE placement —
      // order, line items, payment, decrement — was discarded with it.
      console.warn(`[orders] duplicate placement for cart ${cartId}; kept ${existing}.`);
      return { ok: false, reason: "already_placed", orderNumber: existing };
    }
  } catch (lookupError) {
    console.error("[orders] could not check for an existing order:", lookupError);
  }

  if (/stock_quantity|variants_stock_non_negative_ck/i.test(message)) {
    console.warn(`[orders] the stock CHECK refused a placement for cart ${cartId}.`);
    return { ok: false, reason: "sold_out" };
  }

  console.error("[orders] the placement batch did not commit:", error);
  return { ok: false, reason: "write_failed", message };
}

/**
 * THE TORN-ORDER TEST, exported because every reader owes it.
 *
 * `db/schema.ts` compensation (5): any code that renders an invoice, an admin
 * order page or a refund must assert that the line items on disk match
 * `orders.lineItemCount` and refuse to act on a mismatch, rather than silently
 * invoicing a subset. D1 cannot roll a partial write back for us, so this is
 * how one is found.
 */
export async function assertOrderIntact(
  db: CartDb,
  orderId: string,
  lineItemCount: number
): Promise<{ readonly ok: boolean; readonly found: number }> {
  const rows = await db.all(COUNT_ORDER_ITEMS, [orderId]);
  const found = rows[0] === undefined ? 0 : (asInt(rows[0], "lineItems") ?? 0);
  return { ok: found === lineItemCount, found };
}

/* =========================================================================
 * Cancellation — one batch, and the only path that puts a piece back
 * ====================================================================== */

/**
 * THE STATES AN ORDER MAY BE CANCELLED FROM.
 *
 * The question this list answers is physical, not financial: IS THE PIECE
 * STILL IN THE SHOP? If it is, cancelling puts it back on the wall and that is
 * simply true. `shipped` and `delivered` are therefore absent — the piece has
 * gone, and restoring stock would advertise something the shop does not have,
 * which for a one-of-a-kind item is the unrecoverable error. Those orders need
 * a return, and a return is a different act with a different record.
 *
 * `cancelled` is absent because a second cancellation must change nothing, and
 * `refunded` is absent because it is a terminal money state whose stock
 * restoration belongs to the refund path that will exist when capture does.
 *
 * `advance_paid` and `paid` ARE here, though neither is reachable while
 * `PAYMENT_CAPTURE_ENABLED` is false. Withholding cancellation from a paid but
 * unshipped order would strand the piece off sale for as long as the money
 * question took to settle, which is the very failure this function exists to
 * end. The money is not forgotten: `CancellationResult` carries
 * `refundDuePaise`, and a non-zero value is an obligation on the caller.
 *
 * `fulfilment_status` is checked separately and must be `unfulfilled`: a
 * partially fulfilled multi-line order would otherwise restore stock for a
 * piece already handed over.
 */
export const CANCELLABLE_ORDER_STATUSES = [
  "pending_payment",
  "advance_paid",
  "paid",
  "confirmed",
  "in_production",
  "ready_for_pickup",
  "failed",
] as const;

export type CancellableOrderStatus = (typeof CANCELLABLE_ORDER_STATUSES)[number];

/**
 * WHY an order was cancelled. A closed set, because Rule 4(8) and any
 * subsequent dispute turn on who ended the order and on what footing — "the
 * customer asked" and "the shop declined" are not the same fact, and a free
 * text box is not a queryable answer to which of them happened.
 *
 * The human sentence goes in `cancellationNote` alongside it. Both are
 * required at the call site.
 */
export const CANCELLATION_REASON_CODES = [
  /** The customer asked. Rule 4(8): with nothing captured, nothing is charged. */
  "customer_request",
  /** The shop called to settle payment and could not reach the customer. */
  "not_reachable",
  /** The shop declines the order. The customer is told, and pays nothing. */
  "shop_declined",
  /** The piece cannot be supplied — promised elsewhere, damaged, mis-listed. */
  "piece_unavailable",
  /** Placed in error and re-placed correctly. See research/06 §3.4. */
  "placed_in_error",
  /** Recorded rather than guessed at. The note carries the truth. */
  "other",
] as const;

export type CancellationReasonCode = (typeof CANCELLATION_REASON_CODES)[number];

/** A SQL literal list built from our own compile-time constants. */
const CANCELLABLE_SQL_LIST = CANCELLABLE_ORDER_STATUSES.map(
  (status) => `'${status}'`
).join(", ");

/**
 * THE TRANSITION, GATED BY A CONSTRAINT RATHER THAN BY A WHERE CLAUSE.
 *
 * `orders.status` is NOT NULL. An order that is not in a cancellable state
 * therefore does not fail a `WHERE` and quietly change nothing — it writes NULL
 * into a NOT NULL column, which raises a constraint error and ABORTS THE WHOLE
 * BATCH, taking the stock restore with it. This is exactly the argument in (7)
 * for the decrement: a guard expressed as a WHERE clause turns a violation into
 * a silent no-op, and a silent no-op here would put a shipped piece back on
 * sale. SQLite evaluates every SET expression against the pre-UPDATE row, so
 * the CASE reads the state as it was when the batch began.
 */
const CANCEL_ORDER = `
  UPDATE orders
  SET status = CASE
        WHEN status IN (${CANCELLABLE_SQL_LIST}) AND fulfilment_status = 'unfulfilled'
        THEN 'cancelled'
        ELSE NULL
      END,
      cancelled_at = ?,
      cancelled_by = ?,
      cancellation_reason_code = ?,
      cancellation_note = ?,
      updated_at = ?
  WHERE id = ?`;

/**
 * THE RESTORE. The mirror of `DECREMENT_STOCK`, and it carries no guard of its
 * own for the same reason that one does not: `variants_unique_piece_stock_ck`
 * (`is_unique_piece = 0 OR stock_quantity <= 1`) means a restore that would put
 * two of a one-of-a-kind piece on the wall aborts the batch instead of
 * corrupting the shop's inventory quietly.
 */
const RESTORE_STOCK = `
  UPDATE variants
  SET stock_quantity = stock_quantity + ?, updated_at = ?
  WHERE id = ?`;

/**
 * The machine record of the act. `diff_json` is ALLOWLISTED: the status
 * transition, the reason CODE, and what was given back. Never the note, never
 * a name, a phone number or an address — research/06 §4.3 — because the audit
 * table is outside the reach of the erasure job.
 */
const INSERT_CANCELLATION_AUDIT = `
  INSERT INTO admin_audit_log (id, actor_email, action, entity_type, entity_id, diff_json, created_at)
  VALUES (?, ?, 'order.cancelled', 'order', ?, ?, ?)`;

const SELECT_ORDER_TO_CANCEL = `
  SELECT id                  AS "orderId",
         order_number        AS "orderNumber",
         status              AS "status",
         fulfilment_status   AS "fulfilmentStatus",
         payment_status      AS "paymentStatus",
         advance_paid_paise  AS "advancePaidPaise",
         line_item_count     AS "lineItemCount",
         cancelled_at        AS "cancelledAt"
  FROM orders
  WHERE order_number = ?
  LIMIT 1`;

/** What has to go back on the wall, one row per variant however many lines. */
const SELECT_ORDER_STOCK_LINES = `
  SELECT variant_id     AS "variantId",
         sum(quantity)  AS "quantity"
  FROM order_items
  WHERE order_id = ? AND variant_id IS NOT NULL
  GROUP BY variant_id
  ORDER BY variant_id ASC`;

export class OrderCancellationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderCancellationError";
  }
}

export type RestoredStockLine = {
  readonly variantId: string;
  readonly quantity: number;
};

export type CancellationFailure =
  | { readonly reason: "not_found" }
  /** Already cancelled. Nothing was restored a second time. */
  | { readonly reason: "already_cancelled"; readonly cancelledAt: string | null }
  /** The piece has gone, or part of the order has. A return, not a cancel. */
  | {
      readonly reason: "not_cancellable";
      readonly status: string;
      readonly fulfilmentStatus: string;
    }
  /** The order does not reconcile against its own count. A human must look. */
  | { readonly reason: "torn"; readonly expected: number; readonly found: number }
  | { readonly reason: "write_failed"; readonly message: string };

export type CancellationResult =
  | {
      readonly ok: true;
      readonly orderId: string;
      readonly orderNumber: string;
      readonly cancelledAt: string;
      /** One entry per variant put back. Empty only for a line-less order. */
      readonly restored: readonly RestoredStockLine[];
      /**
       * Money already captured against this order, which cancelling does NOT
       * return. Zero for every order this shop can currently take; a non-zero
       * value is a refund the caller now owes and must not swallow.
       */
      readonly refundDuePaise: number;
    }
  | ({ readonly ok: false } & CancellationFailure);

export type CancelOrderInput = {
  readonly orderNumber: string;
  /** Who is cancelling. An admin email, or `system:<job>` for a sweep. */
  readonly actor: string;
  readonly reasonCode: CancellationReasonCode;
  /** The human sentence. Rule 4(8) turns on it; it is not optional. */
  readonly note: string;
  readonly nowMs?: number;
};

/**
 * CANCEL AN ORDER AND PUT ITS PIECES BACK. One `db.batch()`, which is one
 * transaction, and the only increment of `variants.stockQuantity` there is.
 *
 * ORDER OF THE BATCH, and why each statement is where it is:
 *
 *   1  INSERT webhook_events   `manual:order:<id>:cancelled`. THE IDEMPOTENCY.
 *      A primary key, inserted inside the batch it protects, exactly as
 *      placement does it: a second cancellation collides here and the whole
 *      duplicate — including a second restore of a one-of-a-kind piece — is
 *      discarded by SQLite rather than by a status check that might have read
 *      a stale row. The `already_cancelled` branch below is a courtesy that
 *      produces a better message; it is NOT what makes this safe.
 *
 *   2  UPDATE orders           the transition. See `CANCEL_ORDER`: an
 *      ineligible state aborts the batch on a NOT NULL violation, so the
 *      restore below cannot run against a piece that has left the shop.
 *
 *   3  UPDATE variants × N     the restore, one statement per variant.
 *
 *   4  INSERT admin_audit_log  actor, action, allowlisted diff.
 *
 * The order row is not deleted, its statutory snapshot is not touched, and no
 * `order_items` row is altered — `db/schema.ts` compensation (7).
 */
export async function cancelOrder(
  db: CartDb,
  input: CancelOrderInput
): Promise<CancellationResult> {
  const actor = trimmed(input.actor);
  const note = trimmed(input.note);

  // A cancellation nobody is named for is a false audit trail, and a false
  // audit trail is worse than none because it gets produced in evidence. This
  // is a caller error, not a customer outcome, so it throws rather than
  // returning a failure the UI would render.
  if (actor === "" || actor.length > 190) {
    throw new OrderCancellationError(
      "cancelOrder needs an actor: who cancelled this order must be recorded, not inferred"
    );
  }
  if (note === "" || note.length > 2000) {
    throw new OrderCancellationError(
      "cancelOrder needs a reason in words as well as a code; Rule 4(8) turns on why the order ended"
    );
  }
  if (!CANCELLATION_REASON_CODES.includes(input.reasonCode)) {
    throw new OrderCancellationError(
      `cancelOrder was given the reason code "${String(input.reasonCode)}", which is not one this shop publishes`
    );
  }
  if (!isOrderNumber(input.orderNumber)) {
    return { ok: false, reason: "not_found" };
  }

  const nowMs = input.nowMs ?? Date.now();
  const now = isoAt(nowMs);

  const [row] = await db.all(SELECT_ORDER_TO_CANCEL, [input.orderNumber]);
  if (row === undefined) return { ok: false, reason: "not_found" };

  const orderId = asText(row, "orderId");
  const orderNumber = asText(row, "orderNumber");
  const status = asText(row, "status") ?? "";
  const fulfilmentStatus = asText(row, "fulfilmentStatus") ?? "";
  const lineItemCount = asInt(row, "lineItemCount") ?? 0;
  if (orderId === null || orderNumber === null) return { ok: false, reason: "not_found" };

  // Both of these are REPORTS, not gates. The gates are statements 1 and 2 of
  // the batch, and they are enforced by the database. Reading first only buys
  // a truthful message and avoids burning the idempotency key on an order that
  // was never going to be cancellable.
  if (status === "cancelled") {
    return { ok: false, reason: "already_cancelled", cancelledAt: asText(row, "cancelledAt") };
  }
  if (
    !(CANCELLABLE_ORDER_STATUSES as readonly string[]).includes(status) ||
    fulfilmentStatus !== "unfulfilled"
  ) {
    return { ok: false, reason: "not_cancellable", status, fulfilmentStatus };
  }

  // `db/schema.ts` compensation (5). A torn order does not reconcile against
  // its own line count, so what it took off the wall is not knowable from it;
  // restoring the rows that happen to exist would be a guess at inventory. A
  // person has to look at it first.
  const intact = await assertOrderIntact(db, orderId, lineItemCount);
  if (!intact.ok) {
    console.error(
      `[orders] refusing to cancel ${orderNumber}: it is TORN — line_item_count says ${lineItemCount}, ${intact.found} rows exist.`
    );
    return { ok: false, reason: "torn", expected: lineItemCount, found: intact.found };
  }

  const lineRows = await db.all(SELECT_ORDER_STOCK_LINES, [orderId]);
  const restored: RestoredStockLine[] = [];
  for (const line of lineRows) {
    const variantId = asText(line, "variantId");
    const quantity = asInt(line, "quantity") ?? 0;
    if (variantId === null || quantity <= 0) continue;
    restored.push({ variantId, quantity });
  }

  const statements: CartStatement[] = [];

  // 1. IDEMPOTENCY FIRST. See the function comment.
  statements.push({
    sql: INSERT_WEBHOOK_EVENT,
    params: [
      `manual:order:${orderId}:cancelled`,
      "manual",
      "order.cancelled",
      // No PII and no note: this row exists to be collided with.
      JSON.stringify({
        kind: "order.cancelled",
        orderNumber,
        reasonCode: input.reasonCode,
        restoredVariants: restored.length,
      }),
      now,
      now,
    ],
  });

  // 2. The transition, which the database refuses if the state forbids it.
  statements.push({
    sql: CANCEL_ORDER,
    params: [now, actor, input.reasonCode, note, now, orderId],
  });

  // 3. The pieces go back on the wall.
  for (const line of restored) {
    statements.push({ sql: RESTORE_STOCK, params: [line.quantity, now, line.variantId] });
  }

  // 4. The machine record. No note, no name, no number: research/06 §4.3.
  statements.push({
    sql: INSERT_CANCELLATION_AUDIT,
    params: [
      crypto.randomUUID(),
      actor,
      orderId,
      JSON.stringify({
        orderNumber,
        status: { from: status, to: "cancelled" },
        reasonCode: input.reasonCode,
        restored,
      }),
      now,
    ],
  });

  let results: readonly { changes: number }[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    return await classifyCancellationFailure(db, input.orderNumber, error);
  }

  // The transition must have moved exactly one row. Zero means the order was
  // deleted between the read and the commit — which cannot happen through this
  // application, and is worth saying loudly if it ever does.
  if ((results[1]?.changes ?? 0) !== 1) {
    console.error(
      `[orders] ${orderNumber}: the cancellation transition changed no row, yet the batch committed.`
    );
    return {
      ok: false,
      reason: "write_failed",
      message: "the order vanished between the read and the write",
    };
  }

  // Every restore should have found its variant. A missing one cannot oversell
  // — the piece is not in the catalogue to be bought — but it does mean the
  // shop is one piece short of what it thinks it has, so it is not swallowed.
  for (const [index, line] of restored.entries()) {
    if ((results[2 + index]?.changes ?? 0) !== 1) {
      console.error(
        `[orders] ${orderNumber}: stock restore for variant ${line.variantId} changed no row.`
      );
    }
  }

  return {
    ok: true,
    orderId,
    orderNumber,
    cancelledAt: now,
    restored,
    refundDuePaise: asInt(row, "advancePaidPaise") ?? 0,
  };
}

/**
 * Work out what a failed cancellation batch was, by looking rather than by
 * parsing — the same discipline `classifyPlacementFailure()` applies. The
 * authoritative question is "is this order cancelled now?", and the error text
 * is consulted only after the database has answered it.
 */
async function classifyCancellationFailure(
  db: CartDb,
  orderNumber: string,
  error: unknown
): Promise<CancellationResult> {
  const message = error instanceof Error ? error.message : String(error);

  try {
    const [row] = await db.all(SELECT_ORDER_TO_CANCEL, [orderNumber]);
    if (row !== undefined) {
      const status = asText(row, "status") ?? "";
      if (status === "cancelled") {
        // The idempotency key collided. The duplicate cancellation — including
        // its second stock restore — went with it.
        console.warn(`[orders] duplicate cancellation for ${orderNumber}; it stands as it was.`);
        return {
          ok: false,
          reason: "already_cancelled",
          cancelledAt: asText(row, "cancelledAt"),
        };
      }
      if (/NOT NULL constraint failed: orders\.status/i.test(message)) {
        // The state gate refused it: the order moved on between the read above
        // and the batch. Nothing was written, and nothing was restored.
        return {
          ok: false,
          reason: "not_cancellable",
          status,
          fulfilmentStatus: asText(row, "fulfilmentStatus") ?? "",
        };
      }
    }
  } catch (lookupError) {
    console.error("[orders] could not re-read the order after a failed cancellation:", lookupError);
  }

  console.error("[orders] the cancellation batch did not commit:", error);
  return { ok: false, reason: "write_failed", message };
}

/* =========================================================================
 * Complaints — the ONLY producer of a support_tickets row
 * ====================================================================== */

/**
 * ONE CALENDAR MONTH LATER, reckoned by the British calendar.
 *
 * Rule 4(5) says "within one month from the date of receipt". General Clauses
 * Act 1897 s.3(35) defines a month by the British calendar, so one month from
 * 31 January expires on 28 February — twenty-eight days, not thirty. The
 * previous fixed `+30 days` was therefore LATER than the statutory deadline in
 * every short month, which is the direction that loses a case.
 *
 * The arithmetic is done on the IST calendar, because that is the calendar the
 * shop and the consumer both read, and a day-of-month that does not exist in
 * the target month clamps to its last day (31 March -> 30 April).
 */
export function oneCalendarMonthAfter(ms: number): number {
  const ist = new Date(ms + IST_OFFSET_MS);
  const year = ist.getUTCFullYear();
  const month = ist.getUTCMonth();
  // Day 0 of month+2 is the last day of month+1, and Date.UTC rolls the year.
  const lastDayOfNextMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();

  return (
    Date.UTC(
      year,
      month + 1,
      Math.min(ist.getUTCDate(), lastDayOfNextMonth),
      ist.getUTCHours(),
      ist.getUTCMinutes(),
      ist.getUTCSeconds(),
      ist.getUTCMilliseconds()
    ) - IST_OFFSET_MS
  );
}

/**
 * What a ticket is about. `support_tickets.kind` has NO database default any
 * more, precisely so this is stated rather than assumed — it used to default
 * to `complaint`, and an insert that forgot the column filed a grievance
 * against the shop with two statutory clocks attached.
 */
export const SUPPORT_TICKET_KINDS = [
  "complaint",
  "return",
  "exchange",
  "query",
  "other",
] as const;

export type SupportTicketKind = (typeof SUPPORT_TICKET_KINDS)[number];

export class ComplaintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComplaintError";
  }
}

const INSERT_SUPPORT_TICKET = `
  INSERT INTO support_tickets
    (id, ticket_number, order_id, customer_id, contact_name, contact_phone,
     contact_email, kind, subject, body, status, assigned_to,
     acknowledge_due_at, redress_due_at, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, ?, ?)`;

/**
 * The Rule 7(1)(f) number on the order, for the order page and the invoice.
 *
 * `WHERE complaint_ticket_number IS NULL` and the column's UNIQUE index
 * together mean the FIRST complaint takes the slot and a later one cannot
 * dislodge it or collide with it. A no-op here is the correct outcome for a
 * second complaint, not a failure: `support_tickets` is authoritative and its
 * `order_id` has always supported many complaints against one order.
 */
const ATTACH_TICKET_TO_ORDER = `
  UPDATE orders
  SET complaint_ticket_number = ?, updated_at = ?
  WHERE id = ? AND complaint_ticket_number IS NULL`;

const SELECT_ORDER_FOR_TICKET = `
  SELECT id            AS "orderId",
         order_number  AS "orderNumber",
         customer_id   AS "customerId",
         contact_name  AS "contactName",
         contact_phone AS "contactPhone",
         contact_email AS "contactEmail"
  FROM orders
  WHERE order_number = ?
  LIMIT 1`;

export type LodgeComplaintInput = {
  /** The order complained about, or null: a complaint may stand alone. */
  readonly orderNumber: string | null;
  readonly kind: SupportTicketKind;
  readonly subject: string;
  readonly body?: string | null;
  /**
   * WHEN THE COMPLAINT WAS RECEIVED, which is what Rule 4(5)'s two clocks run
   * from — not when it was typed in. A complaint that arrives by telephone on
   * Monday and is entered on Wednesday is acknowledged from Monday.
   */
  readonly receivedAtMs: number;
  /** Taken from the order when it is not given and an order is named. */
  readonly contactName?: string | null;
  readonly contactPhone?: string | null;
  readonly contactEmail?: string | null;
  readonly nowMs?: number;
};

export type ComplaintResult =
  | {
      readonly ok: true;
      readonly ticketId: string;
      readonly ticketNumber: string;
      readonly orderId: string | null;
      readonly acknowledgeDueAt: string;
      readonly redressDueAt: string;
      /** True when this ticket took `orders.complaintTicketNumber`. */
      readonly isFirstOnOrder: boolean;
    }
  | { readonly ok: false; readonly reason: "order_not_found" }
  | { readonly ok: false; readonly reason: "write_failed"; readonly message: string };

/**
 * LODGE A COMPLAINT, and issue the number Rule 7(1)(f) requires.
 *
 * This is the only function in the codebase that writes a `support_tickets`
 * row, and it is one `db.batch()` so that `orders.complaintTicketNumber` can
 * never name a ticket that does not exist — which is the sound half of the
 * reasoning that used to put a ticket in the placement batch.
 *
 * Not idempotent, and deliberately so: a second complaint about the same order
 * is a real thing that gets its own number and its own clocks. Double-submit
 * protection belongs to the form that calls this, not here.
 */
export async function lodgeComplaint(
  db: CartDb,
  input: LodgeComplaintInput
): Promise<ComplaintResult> {
  // `support_tickets.kind` carries no CHECK — nothing the database guarantees
  // depends on the value — and it no longer carries a default either, so the
  // only thing standing between a mis-typed kind and the table is this. The
  // door is closed for a caller TypeScript never saw, exactly as `placeOrder()`
  // closes it for a `.mjs` script.
  if (!SUPPORT_TICKET_KINDS.includes(input.kind)) {
    throw new ComplaintError(
      `a ticket must say what it is; "${String(input.kind)}" is not one of ${SUPPORT_TICKET_KINDS.join(", ")}`
    );
  }
  if (!Number.isFinite(input.receivedAtMs)) {
    // Rule 4(5)'s two clocks both run from this instant. Guessing it is
    // guessing a statutory deadline.
    throw new ComplaintError("a complaint needs the time it was RECEIVED, not merely typed in");
  }

  const nowMs = input.nowMs ?? Date.now();
  const now = isoAt(nowMs);

  let orderId: string | null = null;
  let customerId: string | null = null;
  let contactName = trimmed(input.contactName);
  let contactPhone = trimmed(input.contactPhone);
  let contactEmail = trimmed(input.contactEmail);

  if (input.orderNumber !== null) {
    if (!isOrderNumber(input.orderNumber)) return { ok: false, reason: "order_not_found" };

    const [row] = await db.all(SELECT_ORDER_FOR_TICKET, [input.orderNumber]);
    if (row === undefined) return { ok: false, reason: "order_not_found" };

    orderId = asText(row, "orderId");
    customerId = asText(row, "customerId");
    // Snapshotted from the order, so the thread stays answerable after any
    // redaction of the customer row — `db/schema.ts` on `supportTickets`.
    contactName = contactName || (asText(row, "contactName") ?? "");
    contactPhone = contactPhone || (asText(row, "contactPhone") ?? "");
    contactEmail = contactEmail || (asText(row, "contactEmail") ?? "");
  }

  const subject = trimmed(input.subject);
  if (subject === "" || subject.length > 190) {
    throw new ComplaintError("a complaint needs a subject line to be findable by");
  }
  if (contactName === "") {
    // `contact_name` is NOT NULL, and a complaint nobody can be called back on
    // is not one that can be redressed within a month.
    throw new ComplaintError(
      "a complaint needs someone to answer to: give a contact name, or an order to take one from"
    );
  }

  const ticketId = crypto.randomUUID();
  const ticketNumber = newTicketNumber(nowMs);
  const acknowledgeDueAt = isoAt(input.receivedAtMs, TICKET_ACKNOWLEDGE_HOURS * 60);
  const redressDueAt = isoAt(oneCalendarMonthAfter(input.receivedAtMs));

  const statements: CartStatement[] = [
    {
      sql: INSERT_SUPPORT_TICKET,
      params: [
        ticketId,
        ticketNumber,
        orderId,
        customerId,
        contactName,
        contactPhone || null,
        contactEmail || null,
        input.kind,
        subject,
        trimmed(input.body) || null,
        acknowledgeDueAt,
        redressDueAt,
        now,
        now,
      ],
    },
  ];

  if (orderId !== null) {
    statements.push({ sql: ATTACH_TICKET_TO_ORDER, params: [ticketNumber, now, orderId] });
  }

  let results: readonly { changes: number }[];
  try {
    results = await db.batch(statements);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[orders] a complaint could not be recorded:", error);
    return { ok: false, reason: "write_failed", message };
  }

  return {
    ok: true,
    ticketId,
    ticketNumber,
    orderId,
    acknowledgeDueAt,
    redressDueAt,
    isFirstOnOrder: orderId !== null && (results[1]?.changes ?? 0) === 1,
  };
}

/* =========================================================================
 * Reading an order back — scoped by the cart credential, never by number alone
 * ====================================================================== */

/**
 * The confirmation query.
 *
 * An order number is short, printable and shared out loud, so it is NOT a
 * credential: looking an order up by number alone would let anyone who guesses
 * one read a stranger's name, phone and address. So the lookup is scoped by the
 * bearer credential the customer already holds — the cart cookie — through the
 * quote that produced the order. Nobody without that cookie can read the row,
 * and the customer who just placed it has it in their browser.
 */
const SELECT_ORDER_RECEIPT = `
  SELECT o.id                        AS "orderId",
         o.order_number              AS "orderNumber",
         o.complaint_ticket_number   AS "ticketNumber",
         o.contact_name              AS "contactName",
         o.contact_phone             AS "contactPhone",
         o.contact_email             AS "contactEmail",
         o.ship_name                 AS "shipName",
         o.ship_line1                AS "shipLine1",
         o.ship_line2                AS "shipLine2",
         o.ship_city                 AS "shipCity",
         o.ship_state                AS "shipState",
         o.ship_pincode              AS "shipPincode",
         o.taxable_paise             AS "taxablePaise",
         o.gst_paise                 AS "gstPaise",
         o.cgst_paise                AS "cgstPaise",
         o.sgst_paise                AS "sgstPaise",
         o.igst_paise                AS "igstPaise",
         o.total_paise               AS "totalPaise",
         o.advance_due_paise         AS "advanceDuePaise",
         o.advance_paid_paise        AS "advancePaidPaise",
         o.balance_due_paise         AS "balanceDuePaise",
         o.payment_plan              AS "paymentPlan",
         o.fulfilment_mode           AS "fulfilmentMode",
         o.place_of_supply_state_code AS "placeOfSupplyStateCode",
         o.status                    AS "status",
         o.payment_status            AS "paymentStatus",
         o.line_item_count           AS "lineItemCount",
         o.placed_at                 AS "placedAt"
  FROM orders o
  JOIN price_quotes q ON q.id = o.quote_id
  WHERE o.order_number = ? AND q.cart_id = ?
  LIMIT 1`;

const SELECT_ORDER_ITEMS = `
  SELECT sku                          AS "sku",
         title_snapshot               AS "title",
         variant_description_snapshot AS "description",
         quantity                     AS "quantity",
         net_metal_weight_mg          AS "netMetalWeightMg",
         purity_carat_label_snapshot  AS "purity",
         huid_snapshot                AS "huid",
         hallmarking_paise            AS "hallmarkingPaise",
         unit_price_paise             AS "unitPricePaise",
         line_subtotal_paise          AS "lineSubtotalPaise",
         line_gst_paise               AS "lineGstPaise",
         line_total_paise             AS "lineTotalPaise",
         hsn_code                     AS "hsnCode"
  FROM order_items
  WHERE order_id = ?
  ORDER BY rowid ASC`;

export type OrderReceiptItem = {
  readonly sku: string;
  readonly title: string;
  readonly description: string | null;
  readonly quantity: number;
  readonly netMetalWeightMg: number | null;
  readonly purity: string | null;
  readonly huid: string | null;
  readonly hallmarkingPaise: number;
  readonly unitPricePaise: number;
  readonly lineSubtotalPaise: number;
  readonly lineGstPaise: number;
  readonly lineTotalPaise: number;
  readonly hsnCode: string;
};

export type OrderReceipt = {
  readonly orderNumber: string;
  readonly ticketNumber: string | null;
  readonly contactName: string;
  readonly contactPhone: string;
  readonly contactEmail: string | null;
  readonly ship: ShippingAddress | null;
  readonly taxablePaise: number;
  readonly gstPaise: number;
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
  readonly totalPaise: number;
  readonly advanceDuePaise: number;
  readonly advancePaidPaise: number;
  readonly balanceDuePaise: number;
  readonly paymentPlan: PaymentPlan;
  readonly fulfilmentMode: FulfilmentMode;
  readonly placeOfSupplyStateCode: string | null;
  readonly status: string;
  readonly paymentStatus: string;
  readonly lineItemCount: number;
  readonly placedAt: string;
  readonly items: readonly OrderReceiptItem[];
};

export type OrderReceiptResult =
  | { readonly found: false }
  /** The order exists and does not reconcile. It must not be invoiced. */
  | { readonly found: true; readonly intact: false; readonly orderNumber: string }
  | { readonly found: true; readonly intact: true; readonly receipt: OrderReceipt };

/** One order, readable only by the cart that produced it. */
export async function readOrderForCart(
  db: CartDb,
  options: { readonly orderNumber: string; readonly cartToken: string | null }
): Promise<OrderReceiptResult> {
  if (!isOrderNumber(options.orderNumber) || options.cartToken === null) {
    return { found: false };
  }

  const rows = await db.all(SELECT_ORDER_RECEIPT, [
    options.orderNumber,
    options.cartToken,
  ]);
  const row = rows[0];
  if (row === undefined) return { found: false };

  const orderId = asText(row, "orderId");
  const orderNumber = asText(row, "orderNumber");
  const lineItemCount = asInt(row, "lineItemCount") ?? 0;
  if (orderId === null || orderNumber === null) return { found: false };

  const itemRows = await db.all(SELECT_ORDER_ITEMS, [orderId]);

  // The torn-write detector again, at the one place a customer would otherwise
  // be shown a subset of what they bought.
  if (itemRows.length !== lineItemCount) {
    console.error(
      `[orders] ${orderNumber} is TORN on read: ${itemRows.length} items against a count of ${lineItemCount}.`
    );
    return { found: true, intact: false, orderNumber };
  }

  const shipLine1 = asText(row, "shipLine1");
  const shipState = asText(row, "shipState");
  const shipCity = asText(row, "shipCity");
  const shipPincode = asText(row, "shipPincode");

  return {
    found: true,
    intact: true,
    receipt: {
      orderNumber,
      ticketNumber: asText(row, "ticketNumber"),
      contactName: asText(row, "contactName") ?? "",
      contactPhone: asText(row, "contactPhone") ?? "",
      contactEmail: asText(row, "contactEmail"),
      ship:
        shipLine1 !== null && shipCity !== null && shipState !== null && shipPincode !== null
          ? {
              name: asText(row, "shipName") ?? "",
              line1: shipLine1,
              line2: asText(row, "shipLine2"),
              city: shipCity,
              stateCode: shipState,
              pincode: shipPincode,
            }
          : null,
      taxablePaise: asInt(row, "taxablePaise") ?? 0,
      gstPaise: asInt(row, "gstPaise") ?? 0,
      cgstPaise: asInt(row, "cgstPaise") ?? 0,
      sgstPaise: asInt(row, "sgstPaise") ?? 0,
      igstPaise: asInt(row, "igstPaise") ?? 0,
      totalPaise: asInt(row, "totalPaise") ?? 0,
      advanceDuePaise: asInt(row, "advanceDuePaise") ?? 0,
      advancePaidPaise: asInt(row, "advancePaidPaise") ?? 0,
      balanceDuePaise: asInt(row, "balanceDuePaise") ?? 0,
      paymentPlan: asText(row, "paymentPlan") === "booking_advance" ? "booking_advance" : "full_prepaid",
      fulfilmentMode: asText(row, "fulfilmentMode") === "store_pickup" ? "store_pickup" : "ship",
      placeOfSupplyStateCode: asText(row, "placeOfSupplyStateCode"),
      status: asText(row, "status") ?? "",
      paymentStatus: asText(row, "paymentStatus") ?? "",
      lineItemCount,
      placedAt: asText(row, "placedAt") ?? "",
      items: itemRows.map((item) => ({
        sku: asText(item, "sku") ?? "",
        title: asText(item, "title") ?? "",
        description: asText(item, "description"),
        quantity: asInt(item, "quantity") ?? 1,
        netMetalWeightMg: asInt(item, "netMetalWeightMg"),
        purity: asText(item, "purity"),
        huid: asText(item, "huid"),
        hallmarkingPaise: asInt(item, "hallmarkingPaise") ?? 0,
        unitPricePaise: asInt(item, "unitPricePaise") ?? 0,
        lineSubtotalPaise: asInt(item, "lineSubtotalPaise") ?? 0,
        lineGstPaise: asInt(item, "lineGstPaise") ?? 0,
        lineTotalPaise: asInt(item, "lineTotalPaise") ?? 0,
        hsnCode: asText(item, "hsnCode") ?? DEFAULT_HSN,
      })),
    },
  };
}

/* =========================================================================
 * What the shop says about money — the ONLY place payment copy is written
 * ====================================================================== */

export type PaymentStanding = {
  /** Never "Paid". With the flag off there is nothing that could be. */
  readonly heading: string;
  readonly body: string;
  /** The one-line status beside the total. */
  readonly badge: string;
};

/**
 * EVERY SENTENCE THIS SITE SAYS ABOUT PAYMENT, derived from the flag.
 *
 * A pure function of the flag, so the two states cannot drift apart and both
 * are testable. While `captureEnabled` is false, nothing here contains the word
 * "paid" on its own, "received", "successful", "confirmed", a receipt, or a
 * tick — because none of those would be true. What it says instead is exactly
 * what happened: the order is recorded, the piece is off the wall, no money has
 * moved, and a person from the shop will call.
 */
export function paymentStanding(
  captureEnabled: boolean,
  context: { readonly plan: PaymentPlan; readonly fulfilment: FulfilmentMode }
): PaymentStanding {
  if (!captureEnabled) {
    return {
      heading: "No payment has been taken",
      body:
        context.fulfilment === "store_pickup"
          ? "Nothing has been charged and nothing has been paid. Card and UPI are not switched on here yet, so we will call you to confirm the piece, and you settle it at the counter when you collect it."
          : "Nothing has been charged and nothing has been paid. Card and UPI are not switched on here yet, so we will call you to confirm the piece, agree how you would like to pay, and arrange insured carriage before anything leaves the shop.",
      badge: "Awaiting payment",
    };
  }

  return {
    heading: context.plan === "booking_advance" ? "Booking advance due" : "Payment due",
    body:
      context.plan === "booking_advance"
        ? "The booking advance is taken online and the balance is settled at the counter when you collect the piece."
        : "The order is settled online in full before the piece leaves the shop.",
    badge: "Awaiting payment",
  };
}

/* =========================================================================
 * Notices — the one channel a no-JavaScript flow has
 * ====================================================================== */

/**
 * `/api/orders` answers a browser form with a 303 to `/checkout`, which throws
 * the response body away, so the outcome has to survive the redirect. It
 * travels as one of these fixed codes in `?notice=`.
 *
 * A CLOSED SET, validated on the way back in, exactly as `CART_NOTICES` is. The
 * page renders the copy below keyed by exact match and never the query string,
 * so there is nothing to inject into.
 *
 * WHAT DOES NOT TRAVEL BACK: anything the customer typed. A redirect puts its
 * query string in browser history, in the referrer and in every access log on
 * the way, and a name, a phone number, an address and a PAN have no business in
 * any of those. So a rejected form loses its values, which is a real cost paid
 * deliberately — and it is why every control on the page carries `required` and
 * `pattern`, so the browser catches almost all of this before a request is made.
 */
export const CHECKOUT_NOTICES = {
  placed: "Your order is recorded. Nothing has been charged.",
  "already-placed":
    "This cart had already become an order, so nothing was placed twice. Your original order stands.",
  "no-cart": "There is nothing in your cart to order.",
  "empty-cart": "There is nothing in your cart to order.",
  unpriceable:
    "We cannot put a price on everything in your cart, so we have not created an order. Ask us and we will quote it by hand.",
  "shop-state-unknown":
    "We cannot issue an invoice until the shop's own registered state is recorded, so no order was created.",
  "too-many": "That is more pieces than one order here can carry. Please call the shop.",
  "needs-detail": "Some of what we need is missing or does not look right. Nothing was ordered.",
  "sold-out":
    "One of these pieces was taken while you were checking out, so no order was created and nothing was charged.",
  torn: "We recorded your order but our own check on it did not pass. Please call the shop before doing anything else, and quote the number below.",
  unavailable:
    "We could not reach our order book just now, so nothing was ordered and nothing was changed. Please try again, or call the shop.",
  "bad-request": "That request did not make sense to us, so nothing was ordered.",
} as const;

export type CheckoutNotice = keyof typeof CHECKOUT_NOTICES;

/** Notices that report a failure, so the page can mark them as one. */
const PROBLEM_NOTICES = new Set<CheckoutNotice>([
  "no-cart",
  "empty-cart",
  "unpriceable",
  "shop-state-unknown",
  "too-many",
  "needs-detail",
  "sold-out",
  "torn",
  "unavailable",
  "bad-request",
]);

export function isProblemNotice(notice: CheckoutNotice): boolean {
  return PROBLEM_NOTICES.has(notice);
}

/** Narrow a `?notice=` value to a code we actually publish, or `null`. */
export function toCheckoutNotice(value: unknown): CheckoutNotice | null {
  if (typeof value !== "string") return null;
  return Object.hasOwn(CHECKOUT_NOTICES, value) ? (value as CheckoutNotice) : null;
}

/** The block reason a resolution failed with, as a notice code. */
export function noticeForBlock(reason: CheckoutBlockReason): CheckoutNotice {
  switch (reason) {
    case "no_cart":
      return "no-cart";
    case "empty_cart":
      return "empty-cart";
    case "too_many_lines":
      return "too-many";
    case "shop_state_unknown":
      return "shop-state-unknown";
    default:
      return "unpriceable";
  }
}

/** `/checkout`, or `/checkout?…`. The only redirect target this feature has. */
export function checkoutHref(options: {
  readonly notice?: CheckoutNotice;
  readonly ref?: string;
  readonly fields?: readonly CheckoutField[];
} = {}): string {
  const search = new URLSearchParams();
  if (options.notice) search.set("notice", options.notice);
  if (options.ref && isOrderNumber(options.ref)) search.set("ref", options.ref);
  if (options.fields && options.fields.length > 0) {
    search.set("fields", options.fields.join(","));
  }
  const rendered = search.toString();
  return rendered ? `/checkout?${rendered}` : "/checkout";
}

/** What the page says, per blocked line. Never a number and never a zero. */
export function lineBlockCopy(reason: LineBlockReason): string {
  switch (reason) {
    case "on_request":
      return "quoted by hand, so there is no figure to charge";
    case "not_measured":
      return "not weighed or assayed yet, so it cannot be priced";
    case "rate_stale":
      return "waiting on today's gold rate, which has not been confirmed";
    case "rate_missing":
      return "waiting on a gold rate we can read";
    case "not_for_sale_online":
      return "sold in the shop rather than through this page";
    case "held_by_another":
      return "reserved by someone else at this moment";
    case "sold_out":
      return "no longer on the wall";
    default:
      return "not something we can price automatically";
  }
}

/** Grams from milligrams, without a float. "12.345 g". */
export function formatWeightMg(mg: number): string {
  const grams = Math.floor(mg / 1000);
  const remainder = String(mg % 1000).padStart(3, "0");
  return `${grams}.${remainder} g`;
}

/**
 * The order database, or a throw.
 *
 * ONE PORT: `d1CartDb()` from `app/_data/cart.ts`, unchanged, because the two
 * modules speak the same four-method SQL surface and a second adapter would be
 * a second place for `meta.changes` — the signal both the cart's claim and this
 * module's decrement read — to be got subtly wrong.
 *
 * Deliberately NOT a fallback. The catalogue may serve a compiled seed when D1
 * is unreachable, because browsing is read-only. An order that is not in the
 * database is not an order, so this throws and the caller reports it; it never
 * pretends the order was taken. See (3) in the header.
 */
export function getOrderDb(): CartDb {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable, so no order can be recorded. An order that is not in the database is not an order."
    );
  }
  return d1CartDb(env.DB);
}
