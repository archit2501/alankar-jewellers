/**
 * WHAT THE TWO ORDER SCREENS KNOW THAT THE DATA LAYER DOES NOT.
 *
 * The orders themselves are read by `app/_admin/data.ts` — `listAdminOrders()`
 * and `readAdminOrderDetail()`, which return the shared `AdminOrderRow` /
 * `AdminOrderDetail` shapes and write the DPDP Rule 6(1)(c) read log
 * themselves. There is no second query for an order in this file and there
 * must not be one: `readOrderForCart()` is authorised by the cart cookie and
 * cannot be reused by an admin, and a THIRD reader would be a third place for
 * `assertOrderIntact()` to be forgotten.
 *
 * What lives here is what belongs to these two screens alone:
 *
 *   - the status VOCABULARY, in the shop's words rather than the schema's;
 *   - the filter buckets the list groups by;
 *   - `STATUS_ACTIONS`, the transition table the action endpoint validates
 *     against, and the payment-state guard that sits beside it;
 *   - small readers of the breakup, which the view type deliberately models as
 *     an opaque list of labelled amounts;
 *   - the rate provenance, which the view type does not carry at all.
 */

import type { CartDb } from "../../_data/cart";
import { formatPaiseAsRupees } from "../../_pricing/rates";
import type { AdminOrderLine } from "../../_admin/view-types";
import { formatWhen } from "../../_admin/data";

/* =========================================================================
 * The vocabulary
 * ====================================================================== */

/**
 * THE STATUS VOCABULARY. research/05 §7, and it is not decoration.
 *
 * "Not settled", never "Unpaid" — which implies they owe and did not pay.
 * "Making", because that is a real jeweller's state and no generic e-commerce
 * vocabulary has it. "Did not go through", never "Failed", which reads as the
 * shop's fault. Naming the states in the shop's words is most of what makes
 * this feel built for the business rather than adapted to it.
 */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  pending_payment: "Not settled",
  advance_paid: "Advance taken",
  paid: "Paid",
  confirmed: "Confirmed",
  in_production: "Making",
  ready_for_pickup: "Ready to collect",
  shipped: "Sent",
  delivered: "Delivered",
  cancelled: "Cancelled",
  refunded: "Refunded",
  failed: "Did not go through",
};

export function statusWord(status: string): string {
  return STATUS_WORDS[status] ?? status.replace(/_/g, " ");
}

/**
 * The state every order in the system is in today, because
 * `PAYMENT_CAPTURE_ENABLED` is false. It prints on no row in the list:
 * printing the same word on every row teaches nothing.
 */
export const DEFAULT_STATUS = "pending_payment";

/* =========================================================================
 * The filter buckets
 * ====================================================================== */

/**
 * A closed set. The value from the query string is matched against it by exact
 * equality — it never reaches a query and there is nothing to inject.
 *
 * These group the page of rows the data layer returned; they are NOT a
 * database filter. The sentence above the list says so, because "3 making" is
 * a lie if it means "3 of the 50 I happened to fetch" and the screen does not
 * say which it is.
 */
export const ORDER_FILTERS = {
  all: { label: "All", statuses: null },
  "to-settle": { label: "Not settled", statuses: ["pending_payment"] },
  making: { label: "Making", statuses: ["confirmed", "in_production"] },
  ready: { label: "Ready to collect", statuses: ["ready_for_pickup"] },
  gone: { label: "Collected or sent", statuses: ["shipped", "delivered"] },
  cancelled: { label: "Cancelled", statuses: ["cancelled", "refunded", "failed"] },
} as const satisfies Record<
  string,
  { readonly label: string; readonly statuses: readonly string[] | null }
>;

export type OrderFilter = keyof typeof ORDER_FILTERS;

export function toOrderFilter(value: unknown): OrderFilter {
  return typeof value === "string" && Object.hasOwn(ORDER_FILTERS, value)
    ? (value as OrderFilter)
    : "all";
}

export function matchesFilter(status: string, filter: OrderFilter): boolean {
  const bucket: readonly string[] | null = ORDER_FILTERS[filter].statuses;
  return bucket === null || bucket.includes(status);
}

/* =========================================================================
 * The transition table — the whole of what this panel may write
 * ====================================================================== */

export type StatusIntent = "mark_ready" | "mark_collected";

/**
 * THE ONLY TWO STATUS WRITES THIS PANEL CAN MAKE, and the states each may be
 * made from.
 *
 * Both are physical facts about a piece — it is on the shelf with the
 * customer's name on it; the customer has taken it — and NEITHER touches
 * `payment_status` or moves `status` into a member that asserts money arrived.
 *
 * `orders.status` has eleven members and three of them (`advance_paid`,
 * `paid`, `refunded`) are payment claims. No CHECK constraint stops a write of
 * any of them and `PAYMENT_CAPTURE_ENABLED` is false, so a plain dropdown over
 * the enum is the most natural way to make this site tell a customer they paid
 * when nothing was ever taken — the top-rated risk in research/04. The remedy
 * is structural: the endpoint accepts an INTENT and looks the target up here,
 * so a hand-rolled POST carrying `status=paid` has nothing to bind to.
 */
export const STATUS_ACTIONS = {
  mark_ready: {
    label: "Ready to collect",
    from: ["pending_payment", "advance_paid", "paid", "confirmed", "in_production"],
    toStatus: "ready_for_pickup",
    toFulfilment: "unfulfilled",
    notice: "ready",
  },
  mark_collected: {
    label: "Collected",
    from: ["ready_for_pickup"],
    toStatus: "delivered",
    toFulfilment: "fulfilled",
    notice: "collected",
  },
} as const satisfies Record<
  StatusIntent,
  {
    readonly label: string;
    readonly from: readonly string[];
    readonly toStatus: string;
    readonly toFulfilment: string;
    readonly notice: string;
  }
>;

/** The three members of `orders.status` that assert money was received. */
export const PAYMENT_BEARING_STATUSES = ["advance_paid", "paid", "refunded"] as const;

export function isPaymentBearingStatus(status: string): boolean {
  return (PAYMENT_BEARING_STATUSES as readonly string[]).includes(status);
}

/* =========================================================================
 * Reading the breakup
 * ====================================================================== */

/**
 * `AdminOrderLine.breakup` is a list of labelled amounts and nothing more, so
 * the two facts the bill needs about it are recovered by naming convention.
 * That convention is: A ROW WHOSE LABEL NAMES A TAX IS A TAX ROW. It holds for
 * `app/_admin/data.ts`, which emits `GST`, and it would hold for a reader that
 * split the row into `CGST` and `SGST`.
 */
const TAX_LABEL_PREFIXES = ["CGST", "SGST", "IGST", "GST"] as const;

export function isTaxLabel(label: string): boolean {
  return TAX_LABEL_PREFIXES.some((prefix) => label.startsWith(prefix));
}

/** The tax charged on one line, summed from the rows the bill will print. */
export function taxOfLine(line: AdminOrderLine): number {
  let total = 0;
  for (const entry of line.breakup) {
    if (isTaxLabel(entry.label)) total += entry.amountPaise;
  }
  return total;
}

/**
 * What the bill raised in hallmarking on this line.
 *
 * It decides WHICH sentence a missing hallmark number prints. A hallmarking
 * charge of zero is how an exempt article is recorded — `priceLine()` emits no
 * hallmarking component for Kundan, Polki and Jadau, which QCO cl. 2(3)
 * exempts, and those are this shop's flagship categories.
 */
export function hallmarkingPaiseOf(line: AdminOrderLine): number {
  for (const entry of line.breakup) {
    if (entry.label.startsWith("Hallmarking")) return entry.amountPaise;
  }
  return 0;
}

/* =========================================================================
 * Rate provenance — the line that makes the price defensible
 * ====================================================================== */

/**
 * WHY THIS IS READ SEPARATELY.
 *
 * research/05 §8 moved the rate line INSIDE the statutory panel deliberately:
 * "Gold 916, ₹73,240 per 10 g, in force from 8 Aug 11:25 am, read at 4:11 pm"
 * is what makes the price defensible when the customer argues on the phone,
 * and it is what a Reg. 5(11) reconstruction depends on. A number that
 * justifies the invoice must print with the invoice.
 *
 * `AdminOrderLine` carries no field for it and `app/_admin/data.ts` does not
 * select the columns, so the bill reads the three snapshot columns itself.
 * This is a narrow read of provenance, NOT a second source of money: every
 * figure on the bill still comes from the shared reader. The right home for it
 * is the shared reader's breakup label, and moving it there is the one change
 * that would let this function be deleted.
 *
 * Nothing is recomputed from today's rate. The denormalised value that was
 * frozen onto the order is what prints — `goldRateId` proves provenance, the
 * value survives independently, and the rate moves twice a business day.
 */
const SELECT_RATE_PROVENANCE = `
  SELECT i.sku                           AS "sku",
         i.metal_snapshot                AS "metal",
         i.fineness_snapshot             AS "fineness",
         i.gold_rate_per_ten_grams_paise AS "ratePerTenGramsPaise",
         i.gold_rate_effective_from      AS "effectiveFrom",
         i.gold_rate_captured_at         AS "capturedAt"
    FROM order_items i
    JOIN orders o ON o.id = i.order_id
   WHERE o.order_number = ?
   ORDER BY i.rowid ASC`;

export type RateProvenance = {
  readonly sku: string;
  /** One printable sentence, or null when the line carried no metal rate. */
  readonly line: string | null;
};

export async function readRateProvenance(
  db: CartDb,
  orderNumber: string,
  nowMs: number
): Promise<readonly RateProvenance[]> {
  const rows = await db.all(SELECT_RATE_PROVENANCE, [orderNumber]);

  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    const sku = typeof record.sku === "string" ? record.sku : "";
    const rate = typeof record.ratePerTenGramsPaise === "number" ? record.ratePerTenGramsPaise : null;

    if (rate === null) {
      // A fixed-price piece carries no rate, and saying "no rate" is the
      // truthful line rather than an empty one.
      return { sku, line: null };
    }

    const metal = typeof record.metal === "string" ? record.metal : "metal";
    const fineness = typeof record.fineness === "number" ? record.fineness : null;
    const effectiveFrom = typeof record.effectiveFrom === "string" ? record.effectiveFrom : null;
    const capturedAt = typeof record.capturedAt === "string" ? record.capturedAt : null;

    const noun = metal.charAt(0).toUpperCase() + metal.slice(1);
    let line = `Rate used: ${noun}${fineness === null ? "" : ` ${fineness}`}, ₹${formatPaiseAsRupees(rate)} per 10 grams`;
    if (effectiveFrom !== null) line += `, in force from ${formatWhen(effectiveFrom, nowMs)}`;
    if (capturedAt !== null) line += `, read ${formatWhen(capturedAt, nowMs)}`;

    return { sku, line: `${line}.` };
  });
}

/* =========================================================================
 * Small presentation helpers
 * ====================================================================== */

/** Digits only, for a `wa.me` deep link. */
export function waNumber(phone: string): string {
  return phone.replace(/\D/g, "");
}

export function pieces(count: number): string {
  return count === 1 ? "1 piece" : `${count} pieces`;
}
