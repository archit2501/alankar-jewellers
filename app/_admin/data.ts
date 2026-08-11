/**
 * THE ADMIN-SHAPED DATA LAYER — every read the panel makes, in one module.
 *
 * ===========================================================================
 * WHY THE STOREFRONT'S QUERIES ARE NOT REUSED
 * ===========================================================================
 * `app/_admin/view-types.ts` states the contract and the reason. In short:
 * `readOrderForCart()` is authorised by the CART COOKIE and an admin has no
 * cart, and `readCatalogue()` falls back to a compiled seed when D1 is empty —
 * which is right for a shop window and wrong for a management screen. The owner
 * must see what is in the database, not a plausible substitute. Every function
 * below therefore reads D1 directly and returns nothing when D1 has nothing.
 *
 * ===========================================================================
 * READS OF CUSTOMER DATA ARE LOGGED HERE, NOT BY THE SCREENS
 * ===========================================================================
 * DPDP Rule 6(1)(c) obliges "visibility on the accessing of such personal
 * data". `app/_admin/audit.ts` explains what that buys: a read log is the
 * difference between notifying "every customer in the database" and notifying
 * "the eleven whose records were opened between 02:14 and 02:41".
 *
 * The logging lives in THIS module and not in the pages, and that placement is
 * the whole control. A screen cannot forget to log, because it cannot obtain a
 * name or a phone number without calling a function that logs — which is why
 * every reader below takes a REQUIRED `actor`. A page with no signed-in admin
 * has nothing to pass, so it cannot read personal data at all.
 *
 * What is written is the actor, the action, the entity id and a count. Never a
 * search term, never a name, never a number: a phone number typed into a search
 * box is the same personal datum whether it is stored in a customer row or in a
 * log line about one.
 *
 * `readSetupGaps()` and `readRateStanding()` take no actor and write no audit
 * row, because neither touches a person.
 *
 * ===========================================================================
 * EVERY ORDER READ CARRIES `intact`
 * ===========================================================================
 * D1 has no interactive transactions, so `orders.line_item_count` is a
 * torn-write detector and `assertOrderIntact()` is exported for exactly this.
 * A torn order is REPORTED and never rendered as a figure: `totalPaise` is
 * null, `lines` is empty, and the caller is told `intact: false`. An invoice
 * missing a line is worse than an error message.
 *
 * ===========================================================================
 * TIMESTAMPS
 * ===========================================================================
 * Two formats exist in this database and mixing them silently is a real bug.
 * The application writes ISO-8601 with a `Z`; the `CURRENT_TIMESTAMP` default —
 * which `appointments` relies on — writes `YYYY-MM-DD HH:MM:SS` in UTC with no
 * zone marker, which `Date.parse` reads as LOCAL time. Every timestamp read
 * below goes through `toIso()` before it is compared, sorted or printed, and
 * the SQL that compares one uses `SQL_TS()` so both forms sort alike.
 */

import type { CartDb, SqlRow, SqlValue } from "../_data/cart";
import { formatPricePaise } from "../_data/catalogue";
import {
  CANCELLABLE_ORDER_STATUSES,
  PAYMENT_CAPTURE_ENABLED,
  assertOrderIntact,
  normalisePhone,
  paymentStanding,
} from "../_data/orders";
import { classifyRate, type RateLookup, type RateRow } from "../_pricing/rates";
import { known } from "../site-config";
import { ADMIN_ACTIONS, searchDiff, writeAudit } from "./audit";
import { getAdminDb, requireAdmin, type AdminIdentity } from "./session";
import type {
  AdminOrderDetail,
  AdminOrderLine,
  AdminOrderRow,
  QueueItem,
  SetupGap,
} from "./view-types";

/* =========================================================================
 * The actor
 * ====================================================================== */

/**
 * Who is reading. Assembled from `AdminIdentity` by `actorFrom()` so a page
 * cannot invent one, and REQUIRED by every function that returns a name or a
 * phone number.
 */
export type AdminActor = {
  readonly email: string;
  readonly adminUserId: string | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
};

/**
 * WHO IS ASKING — the one call every admin screen makes before it reads
 * anything.
 *
 * It takes the three header values rather than reaching for `next/headers`
 * itself, which keeps this module free of the framework: a Server Component, a
 * route handler and a test can all supply them, and none of them has to fake a
 * request context. `requireAdmin()` does the real work — the D1 row, both
 * clocks, revocation and `is_active` — and a failure of ANY kind returns null.
 * A database that cannot be read is not an authenticated admin, never a
 * fabricated one.
 */
export type CurrentAdmin = {
  readonly identity: AdminIdentity;
  readonly actor: AdminActor;
};

export async function resolveAdmin(
  input: {
    readonly cookie: string | null;
    readonly ip?: string | null;
    readonly userAgent?: string | null;
  },
  { nowMs = Date.now(), db }: { nowMs?: number; db?: CartDb } = {}
): Promise<CurrentAdmin | null> {
  if (!input.cookie) return null;

  try {
    const outcome = await requireAdmin(
      // `requireAdmin()` reads only the cookie header. The URL is never used
      // for anything but constructing a valid object.
      new Request("https://admin.invalid/", { headers: { cookie: input.cookie } }),
      { nowMs, db: db ?? getAdminDb() }
    );
    if (!outcome.ok) return null;

    return {
      identity: outcome.identity,
      actor: actorFrom(outcome.identity, { ip: input.ip, userAgent: input.userAgent }),
    };
  } catch (error) {
    console.error("[admin-data] could not read the session:", error);
    return null;
  }
}

/** Narrow an `AdminIdentity` to what the log needs. Nothing else travels. */
export function actorFrom(
  identity: { readonly email: string; readonly adminUserId: string },
  request?: { readonly ip?: string | null; readonly userAgent?: string | null }
): AdminActor {
  return {
    email: identity.email,
    adminUserId: identity.adminUserId,
    ip: request?.ip ?? null,
    userAgent: request?.userAgent ?? null,
  };
}

/* =========================================================================
 * Row helpers
 * ====================================================================== */

function text(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return String(value);
  return null;
}

function int(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

/**
 * Normalise either timestamp form to ISO-8601 UTC.
 *
 * `2026-08-09 09:00:00` (the SQLite default) is UTC without saying so, and
 * `Date.parse` would read it as local time — an offset that is silently wrong
 * by hours and would misfile a deadline. Anything already carrying a `T` and a
 * zone is left alone.
 */
export function toIso(value: string | null): string | null {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(value)) {
    if (value.includes("T") && /(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) return value;
    return `${value.slice(0, 10)}T${value.slice(11, 19)}.000Z`;
  }
  return value;
}

function msOf(value: string | null): number {
  const iso = toIso(value);
  if (!iso) return Number.NaN;
  return Date.parse(iso);
}

/**
 * The SQL expression that compares either timestamp form. `substr` to seconds,
 * then the space becomes a `T`, so `2026-08-09 09:00:00` and
 * `2026-08-09T09:00:00.000Z` sort against each other correctly. Bound values
 * are produced by `sqlTimestamp()` in the same shape.
 */
function SQL_TS(column: string): string {
  return `replace(substr(${column}, 1, 19), ' ', 'T')`;
}

function sqlTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

/* =========================================================================
 * Time, in the shop's words and the shop's zone
 * ====================================================================== */

/**
 * India Standard Time, as a fixed offset. India has never observed daylight
 * saving, so this is exact — and it is arithmetic rather than
 * `Intl.DateTimeFormat`, for the reason `app/_seo/product-schema.ts` gives
 * about Indian digit grouping: the ICU data available to a Cloudflare Worker is
 * not something this repo pins, and a silent fallback would put the wrong time
 * in front of the owner without failing anything.
 */
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function istParts(ms: number) {
  const shifted = new Date(ms + IST_OFFSET_MS);
  return {
    dayIndex: Math.floor((ms + IST_OFFSET_MS) / MS_PER_DAY),
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/**
 * THE ONE PLACE A SCREEN READS THE WALL CLOCK.
 *
 * Every function in this project takes `nowMs` injected rather than reading the
 * clock, so its tests are assertions rather than sleeps. A page is the
 * composition root and has to read it once, so that every figure and every
 * deadline on a single render is measured from the SAME moment — a page that
 * called `Date.now()` in three places could print a queue and a tally that
 * disagree by a millisecond either side of midnight.
 *
 * It is a function here rather than a `Date.now()` in the component body
 * because `react-hooks/purity` refuses an impure call during render, and it is
 * right to: what it is guarding against is exactly the three-readings bug.
 */
export function readClock(): number {
  return Date.now();
}

/** Midnight IST at the start of the day `ms` falls in, as a UTC epoch. */
export function istDayStartMs(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY - IST_OFFSET_MS;
}

/** `4:12 pm`. Lower-case meridiem, because that is how a shop writes it. */
export function formatIstClock(ms: number): string {
  const { hours, minutes } = istParts(ms);
  const meridiem = hours < 12 ? "am" : "pm";
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(minutes).padStart(2, "0")} ${meridiem}`;
}

/**
 * A moment in words: `today, 4:12 pm`, `tomorrow, 9:40 am`, `Sunday, 4:12 pm`,
 * `14 Aug, 4:12 pm`. Never ISO and never a bare "2 hours ago" — the first is
 * unreadable at a counter and the second is useless for a deadline.
 */
export function formatWhen(iso: string | null, nowMs: number): string {
  const ms = msOf(iso);
  if (!Number.isFinite(ms)) return "at an unknown time";

  const then = istParts(ms);
  const now = istParts(nowMs);
  const dayDelta = then.dayIndex - now.dayIndex;
  const clock = formatIstClock(ms);

  if (dayDelta === 0) return `today, ${clock}`;
  if (dayDelta === 1) return `tomorrow, ${clock}`;
  if (dayDelta === -1) return `yesterday, ${clock}`;
  if (dayDelta > -7 && dayDelta < 7) return `${WEEKDAYS[then.weekday]}, ${clock}`;

  const date = `${then.day} ${MONTHS[then.month]}`;
  return then.year === now.year ? `${date}, ${clock}` : `${date} ${then.year}, ${clock}`;
}

/* =========================================================================
 * THE QUEUE
 * ====================================================================== */

/**
 * How long a queue may get before it stops being a queue. The owner works a
 * list; a list of two hundred is a database view.
 */
export const QUEUE_LIMIT = 40;

/**
 * ORDERS THAT ARE STILL WORK.
 *
 * Not "recent orders" — an order leaves the queue when the piece has left the
 * shop or the order has ended, which is what `fulfilment_status` and the
 * terminal statuses say. With `PAYMENT_CAPTURE_ENABLED` false every order sits
 * in `pending_payment` forever, so a status-only predicate would never empty.
 */
const SELECT_QUEUE_ORDERS = `
  SELECT o.id                AS "id",
         o.order_number      AS "orderNumber",
         o.contact_name      AS "contactName",
         o.contact_phone     AS "contactPhone",
         o.placed_at         AS "placedAt",
         o.status            AS "status",
         o.total_paise       AS "totalPaise",
         o.line_item_count   AS "lineItemCount",
         (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS "foundLines"
    FROM orders o
   WHERE o.status NOT IN ('cancelled', 'delivered', 'refunded', 'failed')
     AND o.fulfilment_status IN ('unfulfilled', 'partially_fulfilled')
   ORDER BY o.placed_at ASC
   LIMIT ?`;

/** Enquiries nobody has finished with. `booked` and `closed` are done. */
const SELECT_QUEUE_APPOINTMENTS = `
  SELECT a.id             AS "id",
         a.name           AS "name",
         a.phone          AS "phone",
         a.interest       AS "interest",
         a.preferred_time AS "preferredTime",
         a.created_at     AS "createdAt"
    FROM appointments a
   WHERE a.status NOT IN ('booked', 'closed')
   ORDER BY a.created_at ASC
   LIMIT ?`;

/**
 * Tickets with a live Rule 4(5) clock. `resolved` and `closed` have none.
 *
 * This is the ONLY source of a deadline in the queue. Phase 0 removed the
 * ticket that every order used to open; reintroducing a deadline on an order
 * here would undo that fix in the interface instead of in the database, which
 * is worse because it would look correct.
 */
const SELECT_QUEUE_TICKETS = `
  SELECT t.id                  AS "id",
         t.ticket_number       AS "ticketNumber",
         t.contact_name        AS "contactName",
         t.contact_phone       AS "contactPhone",
         t.kind                AS "kind",
         t.subject             AS "subject",
         t.acknowledge_due_at  AS "acknowledgeDueAt",
         t.acknowledged_at     AS "acknowledgedAt",
         t.redress_due_at      AS "redressDueAt",
         t.created_at          AS "createdAt"
    FROM support_tickets t
   WHERE t.status IN ('open', 'acknowledged', 'in_progress')
   ORDER BY t.acknowledge_due_at ASC
   LIMIT ?`;

/**
 * What a torn order says, verbatim, so the view can recognise one without
 * inspecting a string it did not write. `QueueItem` carries no `intact` field —
 * the contract is fixed — and inventing an `overdue: true` for this would be a
 * lie about a deadline that does not exist.
 */
export const TORN_ORDER_SUMMARY =
  "This order did not save fully, so a bill made from it would be wrong. Do not invoice it and do not take money for it. Ring the customer and take the order again.";

function orderSummary(input: {
  intact: boolean;
  lineCount: number;
  totalPaise: number | null;
}): string {
  if (!input.intact) return TORN_ORDER_SUMMARY;

  const pieces = input.lineCount === 1 ? "1 piece" : `${input.lineCount} pieces`;
  const money =
    input.totalPaise === null ? "" : `, ${formatPricePaise(input.totalPaise)}`;
  const settled = PAYMENT_CAPTURE_ENABLED ? "" : " Nothing has been charged.";
  return `Order recorded — ${pieces}${money}.${settled}`;
}

/**
 * WHAT A TICKET IS CALLED.
 *
 * The word "complaint" is used only where a human classified the row as one,
 * and even then it is "Problem raised", because that is what it is. An owner
 * who opens the panel and reads "14 complaints" against 14 orders closes it and
 * does not come back.
 */
function ticketSummary(kind: string | null, subject: string | null): string {
  const said = subject ?? "No subject was recorded.";
  return kind === "complaint" ? `Problem raised — ${said}` : said;
}

/** A queue entry with the one fact the contract has no room for. */
type Ranked = { readonly item: QueueItem; readonly torn: boolean };

/**
 * THE ORDER OF THE QUEUE, and the argument for it.
 *
 *   1. Anything carrying a statutory deadline outranks anything that does not.
 *      A complaint starts a Rule 4(5) clock; a purchase does not. This is the
 *      whole reason the queue is not sorted by recency, and it is why an
 *      ordinary order can never be lifted by anything other than its age.
 *   2. Among deadlines, the earliest first — so a breached one is at the top by
 *      construction rather than by a special case.
 *   3. Then a torn order. It carries no clock, but it is the one other state in
 *      here that is WRONG rather than merely waiting: the customer's order is
 *      broken, no bill can be made from it, and they have to be rung and the
 *      order taken again. "Nothing has fixed prominence — a thing grows only
 *      when it is wrong" applies to position as much as to size.
 *   4. Among the rest, the longest wait first. A person who has been waiting
 *      three days is more owed than one who arrived ten minutes ago, whatever
 *      the money says.
 *   5. Kind then id, so two identical timestamps do not shuffle between renders.
 */
function byObligation(a: Ranked, b: Ranked): number {
  const aDue = a.item.dueAt === null ? null : msOf(a.item.dueAt);
  const bDue = b.item.dueAt === null ? null : msOf(b.item.dueAt);

  if (aDue !== null && bDue === null) return -1;
  if (aDue === null && bDue !== null) return 1;
  if (aDue !== null && bDue !== null && aDue !== bDue) return aDue - bDue;

  if (aDue === null && a.torn !== b.torn) return a.torn ? -1 : 1;

  const aAt = msOf(a.item.receivedAt);
  const bAt = msOf(b.item.receivedAt);
  if (aAt !== bAt) return aAt - bAt;

  if (a.item.kind !== b.item.kind) return a.item.kind < b.item.kind ? -1 : 1;
  return a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0;
}

export type QueueOptions = {
  readonly actor: AdminActor;
  readonly nowMs?: number;
  readonly limit?: number;
};

/**
 * ONE LIST, THREE TABLES.
 *
 * The owner's unit of work is a person, not a record, and the person they need
 * to ring may exist in `orders`, in `appointments` or in `support_tickets`. A
 * screen that shows one of those tables answers none of the questions the owner
 * opens the panel with, so the merge happens here rather than in the view.
 */
export async function readTodayQueue(
  db: CartDb,
  options: QueueOptions
): Promise<QueueItem[]> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.trunc(options.limit ?? QUEUE_LIMIT));
  const ranked: Ranked[] = [];

  const [orderRows, appointmentRows, ticketRows] = await Promise.all([
    db.all(SELECT_QUEUE_ORDERS, [limit]),
    db.all(SELECT_QUEUE_APPOINTMENTS, [limit]),
    db.all(SELECT_QUEUE_TICKETS, [limit]),
  ]);

  for (const row of orderRows) {
    const declared = int(row, "lineItemCount") ?? 0;
    const found = int(row, "foundLines") ?? 0;
    const intact = declared === found;
    const totalPaise = int(row, "totalPaise");

    ranked.push({
      torn: !intact,
      item: {
        kind: "order",
        id: text(row, "id") ?? "",
        reference: text(row, "orderNumber") ?? "",
        name: text(row, "contactName"),
        phone: text(row, "contactPhone"),
        receivedAt: toIso(text(row, "placedAt")) ?? "",
        // NEVER a deadline. See SELECT_QUEUE_TICKETS.
        dueAt: null,
        overdue: false,
        summary: orderSummary({
          intact,
          lineCount: declared,
          totalPaise: intact ? totalPaise : null,
        }),
      },
    });
  }

  for (const row of appointmentRows) {
    const id = text(row, "id") ?? "";
    const interest = text(row, "interest");
    const preferred = text(row, "preferredTime");

    ranked.push({
      torn: false,
      item: {
        kind: "appointment",
        id,
        reference: `#${id}`,
        name: text(row, "name"),
        phone: text(row, "phone"),
        receivedAt: toIso(text(row, "createdAt")) ?? "",
        dueAt: null,
        overdue: false,
        summary: [
          interest ? `Asked about ${interest}.` : "Asked about a piece.",
          preferred ? `Wants ${preferred}.` : null,
        ]
          .filter(Boolean)
          .join(" "),
      },
    });
  }

  for (const row of ticketRows) {
    // Rule 4(5) runs two clocks: forty-eight hours to acknowledge, one month to
    // redress. Once the first is answered the second is the live one.
    const acknowledgedAt = toIso(text(row, "acknowledgedAt"));
    const dueAt =
      toIso(text(row, acknowledgedAt ? "redressDueAt" : "acknowledgeDueAt")) ?? null;

    ranked.push({
      torn: false,
      item: {
        kind: "complaint",
        id: text(row, "id") ?? "",
        reference: text(row, "ticketNumber") ?? "",
        name: text(row, "contactName"),
        phone: text(row, "contactPhone"),
        receivedAt: toIso(text(row, "createdAt")) ?? "",
        dueAt,
        overdue: dueAt !== null && msOf(dueAt) <= nowMs,
        summary: ticketSummary(text(row, "kind"), text(row, "subject")),
      },
    });
  }

  ranked.sort(byObligation);
  const queue = ranked.slice(0, limit).map((entry) => entry.item);

  await logCustomerRead(db, options.actor, {
    action: ADMIN_ACTIONS.searchRun,
    entityType: "customer_data",
    diff: searchDiff(["today_queue"], queue.length),
    nowMs,
  });

  return queue;
}

/* =========================================================================
 * WHAT TODAY LOOKED LIKE
 * ====================================================================== */

export type TodayTally = {
  /** Orders recorded since midnight IST. */
  readonly orders: number;
  /** Their total — INTACT ORDERS ONLY. A torn order is never in a sum. */
  readonly ordersTotalPaise: number;
  /** How many of today's orders did not save fully. Reported, never summed. */
  readonly tornOrders: number;
  readonly enquiries: number;
};

const SELECT_TODAY_ORDERS = `
  SELECT o.total_paise     AS "totalPaise",
         o.line_item_count AS "lineItemCount",
         (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS "foundLines"
    FROM orders o
   WHERE ${SQL_TS("o.placed_at")} >= ?
     AND o.status <> 'cancelled'`;

const COUNT_TODAY_APPOINTMENTS = `
  SELECT COUNT(*) AS "n"
    FROM appointments a
   WHERE ${SQL_TS("a.created_at")} >= ?`;

/**
 * The one sentence the Today screen says about today. Money and the truth about
 * money travel together — see the copy in `app/admin/page.tsx` — so this
 * returns figures and never a formatted claim.
 */
export async function readTodayTally(
  db: CartDb,
  { nowMs = Date.now() }: { nowMs?: number } = {}
): Promise<TodayTally> {
  const since = sqlTimestamp(istDayStartMs(nowMs));

  const [orderRows, appointmentRows] = await Promise.all([
    db.all(SELECT_TODAY_ORDERS, [since]),
    db.all(COUNT_TODAY_APPOINTMENTS, [since]),
  ]);

  let ordersTotalPaise = 0;
  let tornOrders = 0;

  for (const row of orderRows) {
    if ((int(row, "lineItemCount") ?? 0) === (int(row, "foundLines") ?? 0)) {
      ordersTotalPaise += int(row, "totalPaise") ?? 0;
    } else {
      tornOrders += 1;
    }
  }

  return {
    orders: orderRows.length,
    ordersTotalPaise,
    tornOrders,
    enquiries: appointmentRows[0] ? (int(appointmentRows[0], "n") ?? 0) : 0,
  };
}

/* =========================================================================
 * THE FOUR REASONS THE SHOP IS NOT OPEN
 * ====================================================================== */

const COUNT_PIECES = `
  SELECT
    (SELECT COUNT(*) FROM products WHERE status = 'active') AS "activeProducts",
    (SELECT COUNT(*)
       FROM variants v
       JOIN products p ON p.id = v.product_id
      WHERE p.status = 'active'
        AND v.pricing_mode <> 'on_request') AS "priceablePieces"`;

const COUNT_RATES = `SELECT COUNT(*) AS "n" FROM gold_rates`;

/**
 * WHY THIS IS THE MOST IMPORTANT THING IN THE PANEL.
 *
 * `research/05-admin-ux.md` §13 names an empty landing screen as the single
 * likeliest cause of abandonment. The shop has no contact details, nothing
 * weighed or assayed, no rate and no payment capture — none of which resolves
 * on its own. So an owner signs in, sees nothing, signs in again the next
 * evening, sees nothing, and stops. By the time a real order arrives nobody is
 * watching, and its clock starts anyway.
 *
 * Every gap below is therefore CHECKED IN CODE against the real state, not
 * written down. Each resolves itself out of the list the moment the thing it
 * describes is done, and when all four are resolved the block never renders
 * again. This is the same placeholder-honesty rule the storefront already
 * follows: nothing is invented, and the reason the screen is quiet is named.
 *
 * `href` is null for a gap whose screen does not exist yet, and the action is
 * stated in words instead. A link to a page that 404s is a worse answer than a
 * sentence — the screens land in M3 tasks 3.1 and 4.1, and this is where they
 * get wired in.
 */
export async function readSetupGaps(db: CartDb): Promise<SetupGap[]> {
  let activeProducts = 0;
  let priceablePieces = 0;
  let rateRows = 0;

  const [pieceRows, rateCountRows] = await Promise.all([
    db.all(COUNT_PIECES),
    db.all(COUNT_RATES),
  ]);

  if (pieceRows[0]) {
    activeProducts = int(pieceRows[0], "activeProducts") ?? 0;
    priceablePieces = int(pieceRows[0], "priceablePieces") ?? 0;
  }
  if (rateCountRows[0]) rateRows = int(rateCountRows[0], "n") ?? 0;

  const catalogue: SetupGap =
    activeProducts === 0
      ? {
          id: "catalogue",
          title: "There are no pieces on the website",
          detail:
            "Nothing is listed to buy or to enquire about. A piece needs a name and a craft to start; everything else can be filled in afterwards.",
          href: "/admin/pieces?add=1",
          resolved: false,
        }
      : {
          id: "catalogue",
          title:
            priceablePieces > 0
              ? `${activeProducts} ${activeProducts === 1 ? "piece is" : "pieces are"} on the website`
              : `${activeProducts} ${activeProducts === 1 ? "piece is" : "pieces are"} listed, but none has been weighed or assayed`,
          detail:
            priceablePieces > 0
              ? "They carry a weight and a purity, so the website can price them."
              : "Every one of them shows “price on request”, which is the truth rather than a placeholder. A piece needs its net metal weight and its purity before the website can put a figure on it.",
          href: "/admin/pieces",
          resolved: priceablePieces > 0,
        };

  return [
    {
      id: "contact_details",
      // Each fact is now known or not on its own, so this reports the state it
      // is actually in rather than collapsing "phone but no address" into the
      // same sentence as "nothing at all".
      title: known.phone
        ? "The website has a phone number, but no address or opening hours"
        : "The website has no phone number or address yet",
      detail: known.phone
        ? "The number is live and people can ring it. The address and the opening hours are still missing, and the page says so rather than inventing them — someone will otherwise arrive at a closed shutter."
        : "It says so on the page rather than inventing them. They are filled in once, in the site’s own settings, by whoever looks after the website.",
      href: null,
      resolved: known.phone && known.address && known.hours,
    },
    catalogue,
    {
      id: "gold_rate",
      title: "No gold rate has been recorded",
      detail:
        "Nothing on the website can show a price until one is. Every piece shows “price on request”, and nobody can check out. That is deliberate — a wrong price is worse than no price.",
      href: "/admin/rate",
      resolved: rateRows > 0,
    },
    {
      id: "payment_capture",
      title: "Card and UPI are switched off",
      detail:
        "They stay off until the shop holds a BIS certificate. Orders can still be recorded here and settled at the counter, and every screen says so rather than implying money has moved.",
      href: null,
      resolved: PAYMENT_CAPTURE_ENABLED,
    },
  ];
}

/* =========================================================================
 * THE RATE, AND WHETHER IT IS WRONG
 * ====================================================================== */

export type RateStanding = {
  /** False when the table has never held a row. That is a setup gap, not an alarm. */
  readonly everRecorded: boolean;
  /** Null only when nothing has ever been recorded for this metal and fineness. */
  readonly lookup: RateLookup | null;
};

const SELECT_CURRENT_RATE = `
  SELECT id                         AS "id",
         metal                      AS "metal",
         fineness                   AS "fineness",
         rate_per_ten_grams_paise   AS "ratePerTenGramsPaise",
         source                     AS "source",
         source_ref                 AS "sourceRef",
         source_quote_raw           AS "sourceQuoteRaw",
         effective_from             AS "effectiveFrom"
    FROM gold_rates
   WHERE metal = ? AND fineness = ? AND effective_to IS NULL
   LIMIT 1`;

/**
 * The rate in force, classified — read through the ADMIN's database handle and
 * `classifyRate()`, which is pure. `readCurrentRate()` is not reused because it
 * opens its own Drizzle connection, and the panel reads everything on one
 * handle so a screen cannot show two different moments of the same database.
 *
 * NOTHING HAS FIXED PROMINENCE. This is one quiet line while the rate is good,
 * and the top of the screen the moment it is not.
 */
export async function readRateStanding(
  db: CartDb,
  {
    metal = "gold",
    fineness = 916,
    nowMs = Date.now(),
  }: { metal?: string; fineness?: number; nowMs?: number } = {}
): Promise<RateStanding> {
  const [current] = await db.all(SELECT_CURRENT_RATE, [metal, fineness]);
  if (!current) {
    const [count] = await db.all(COUNT_RATES);
    return { everRecorded: count ? (int(count, "n") ?? 0) > 0 : false, lookup: null };
  }

  const row: RateRow = {
    id: text(current, "id") ?? "",
    metal: text(current, "metal") ?? metal,
    fineness: int(current, "fineness") ?? fineness,
    ratePerTenGramsPaise: int(current, "ratePerTenGramsPaise") ?? 0,
    source: text(current, "source") ?? "",
    sourceRef: text(current, "sourceRef"),
    sourceQuoteRaw: text(current, "sourceQuoteRaw"),
    effectiveFrom: toIso(text(current, "effectiveFrom")) ?? "",
  };

  return { everRecorded: true, lookup: classifyRate(row, nowMs) };
}

/* =========================================================================
 * ORDERS — the list and the record
 * ====================================================================== */

const ORDER_ROW_COLUMNS = `
         o.id                AS "id",
         o.order_number      AS "orderNumber",
         o.placed_at         AS "placedAt",
         o.contact_name      AS "contactName",
         o.contact_phone     AS "contactPhone",
         o.contact_email     AS "contactEmail",
         o.status            AS "status",
         o.fulfilment_status AS "fulfilmentStatus",
         o.fulfilment_mode   AS "fulfilmentMode",
         o.payment_plan      AS "paymentPlan",
         o.total_paise       AS "totalPaise",
         o.line_item_count   AS "lineItemCount",
         o.cancelled_at      AS "cancelledAt",
         (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS "foundLines"`;

const SELECT_ORDERS = `
  SELECT ${ORDER_ROW_COLUMNS}
    FROM orders o
   ORDER BY o.placed_at DESC
   LIMIT ?`;

const SEARCH_ORDERS = `
  SELECT ${ORDER_ROW_COLUMNS}
    FROM orders o
   WHERE o.contact_phone = ?
      OR o.order_number = ?
      OR lower(o.contact_name) LIKE ?
   ORDER BY o.placed_at DESC
   LIMIT ?`;

const SELECT_ORDER_BY_NUMBER = `
  SELECT ${ORDER_ROW_COLUMNS}
    FROM orders o
   WHERE o.order_number = ?
   LIMIT 1`;

const SELECT_ORDER_LINES = `
  SELECT i.title_snapshot               AS "title",
         i.sku                          AS "sku",
         i.quantity                     AS "quantity",
         i.metal_value_paise            AS "metalValuePaise",
         i.making_charge_paise          AS "makingChargePaise",
         i.stone_value_paise            AS "stoneValuePaise",
         i.hallmarking_paise            AS "hallmarkingPaise",
         i.other_charges_paise          AS "otherChargesPaise",
         i.line_discount_paise          AS "lineDiscountPaise",
         i.line_gst_paise               AS "lineGstPaise",
         i.line_total_paise             AS "lineTotalPaise",
         i.huid_snapshot                AS "huid",
         i.purity_carat_label_snapshot  AS "purityLabel",
         i.fineness_snapshot            AS "fineness",
         i.net_metal_weight_mg          AS "netMetalWeightMg"
    FROM order_items i
   WHERE i.order_id = ?
   ORDER BY i.rowid ASC`;

function toOrderRow(row: SqlRow): AdminOrderRow {
  const declared = int(row, "lineItemCount") ?? 0;
  const found = int(row, "foundLines") ?? 0;
  const intact = declared === found;

  return {
    id: text(row, "id") ?? "",
    orderNumber: text(row, "orderNumber") ?? "",
    placedAt: toIso(text(row, "placedAt")) ?? "",
    customerName: text(row, "contactName"),
    customerPhone: text(row, "contactPhone"),
    status: text(row, "status") ?? "",
    fulfilmentStatus: text(row, "fulfilmentStatus") ?? "",
    lineCount: declared,
    // A partial sum is never presented as a total.
    totalPaise: intact ? int(row, "totalPaise") : null,
    intact,
    cancelledAt: toIso(text(row, "cancelledAt")),
  };
}

export type OrderListOptions = {
  readonly actor: AdminActor;
  /** Phone number, order number or name. Empty means "the latest orders". */
  readonly search?: string | null;
  readonly limit?: number;
  readonly nowMs?: number;
};

/**
 * The orders list, admin-shaped.
 *
 * Search matches the PHONE NUMBER first, because that is what the owner has in
 * front of them when a customer rings — normalised through the storefront's own
 * `normalisePhone()` so the two agree about what a number is. The term itself
 * is never logged; only which fields were searched and how many rows came back.
 */
export async function listAdminOrders(
  db: CartDb,
  options: OrderListOptions
): Promise<AdminOrderRow[]> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.trunc(options.limit ?? 50));
  const term = (options.search ?? "").trim();

  let rows: SqlRow[];
  let fields: string[];

  if (term) {
    const digits = term.replace(/\D+/g, "");
    const phone = digits.length >= 4 ? normalisePhone(term) : "";
    rows = await db.all(SEARCH_ORDERS, [
      phone,
      term.toUpperCase(),
      `%${term.toLowerCase()}%`,
      limit,
    ] satisfies SqlValue[]);
    fields = ["contact_phone", "order_number", "contact_name"];
  } else {
    rows = await db.all(SELECT_ORDERS, [limit]);
    fields = ["placed_at"];
  }

  const orders = rows.map(toOrderRow);

  await logCustomerRead(db, options.actor, {
    action: ADMIN_ACTIONS.searchRun,
    entityType: "order",
    diff: searchDiff(fields, orders.length),
    nowMs,
  });

  return orders;
}

function breakupFor(row: SqlRow): AdminOrderLine["breakup"] {
  const parts: { label: string; amountPaise: number }[] = [];
  const push = (label: string, key: string, always = false) => {
    const amount = int(row, key) ?? 0;
    if (always || amount !== 0) parts.push({ label, amountPaise: amount });
  };

  // Metal, making, stones and hallmarking print even at zero: BIS Reg. 5(11)
  // itemisation is a fixed shape, and a missing line reads as an omission.
  push("Gold", "metalValuePaise", true);
  push("Making", "makingChargePaise", true);
  push("Stones", "stoneValuePaise", true);
  push("Hallmarking", "hallmarkingPaise", true);
  push("Other charges", "otherChargesPaise");
  const discount = int(row, "lineDiscountPaise") ?? 0;
  if (discount !== 0) parts.push({ label: "Discount", amountPaise: -discount });
  push("GST", "lineGstPaise", true);

  return parts;
}

export type OrderDetailOptions = {
  readonly actor: AdminActor;
  readonly nowMs?: number;
};

/**
 * One order, in full — and the record-opened audit row that DPDP Rule 6(1)(c)
 * obliges, written here rather than left to the screen.
 *
 * `assertOrderIntact()` is called even though the list query answers the same
 * question, because `db/schema.ts` compensation (5) names it as the check every
 * invoice reader owes, and a second reader that reimplemented it would be a
 * second thing to keep true.
 */
export async function readAdminOrderDetail(
  db: CartDb,
  orderNumber: string,
  options: OrderDetailOptions
): Promise<AdminOrderDetail | null> {
  const nowMs = options.nowMs ?? Date.now();
  const [row] = await db.all(SELECT_ORDER_BY_NUMBER, [orderNumber]);
  if (!row) return null;

  const base = toOrderRow(row);
  const check = await assertOrderIntact(db, base.id, base.lineCount);
  const intact = base.intact && check.ok;

  // The read is logged whether or not the order is intact: what matters to the
  // log is that this admin opened this customer's record.
  await logCustomerRead(db, options.actor, {
    action: ADMIN_ACTIONS.recordOpened,
    entityType: "order",
    entityId: base.id,
    nowMs,
  });

  const lineRows = intact ? await db.all(SELECT_ORDER_LINES, [base.id]) : [];
  const lines: AdminOrderLine[] = lineRows.map((line) => ({
    title: text(line, "title") ?? "",
    sku: text(line, "sku") ?? "",
    quantity: int(line, "quantity") ?? 1,
    breakup: breakupFor(line),
    lineTotalPaise: int(line, "lineTotalPaise") ?? 0,
    huid: text(line, "huid"),
    purityLabel:
      text(line, "purityLabel") ??
      (int(line, "fineness") === null ? null : `${int(line, "fineness")} fineness`),
    netMetalWeightMg: int(line, "netMetalWeightMg"),
  }));

  const status = base.status;
  const cancellable = (CANCELLABLE_ORDER_STATUSES as readonly string[]).includes(status);
  const unfulfilled = base.fulfilmentStatus === "unfulfilled";
  const mode = text(row, "fulfilmentMode") ?? "ship";

  const allowedActions: ("cancel" | "mark_ready" | "mark_collected")[] = [];
  if (intact && cancellable && unfulfilled && base.cancelledAt === null) {
    allowedActions.push("cancel");
  }
  if (
    intact &&
    unfulfilled &&
    base.cancelledAt === null &&
    ["pending_payment", "advance_paid", "paid", "confirmed", "in_production"].includes(status)
  ) {
    allowedActions.push("mark_ready");
  }
  if (intact && base.cancelledAt === null && status === "ready_for_pickup" && mode === "store_pickup") {
    allowedActions.push("mark_collected");
  }

  /**
   * THE TOP-RATED RISK IN research/04, closed in the type and again here: the
   * three actions above cannot express a payment state, and while capture is
   * off the screen says so in the shop's own words rather than offering a
   * control that would make the site claim money it never received.
   */
  const standing = paymentStanding(PAYMENT_CAPTURE_ENABLED, {
    plan: text(row, "paymentPlan") === "booking_advance" ? "booking_advance" : "full_prepaid",
    fulfilment: mode === "store_pickup" ? "store_pickup" : "ship",
  });

  return {
    ...base,
    intact,
    totalPaise: intact ? base.totalPaise : null,
    lines,
    contact: {
      name: base.customerName,
      phone: base.customerPhone,
      email: text(row, "contactEmail"),
    },
    allowedActions,
    paymentActionsBlockedReason: PAYMENT_CAPTURE_ENABLED
      ? null
      : `${standing.heading}. Card and UPI are switched off, so nothing here can record money as received. Settle it at the counter and note it there.`,
  };
}

/* =========================================================================
 * The audit call every read above owes
 * ====================================================================== */

/**
 * One writer, so there is one place to check that no personal datum reaches the
 * log. What goes in: the admin's own address, the action, the entity type, an
 * internal id, and a count. What never goes in: a customer's name, phone,
 * email, address, or anything they typed.
 *
 * Never throws. An audit write that fails must be loud in `wrangler tail`, but
 * it must not be the reason the owner cannot see who to ring — the caller has
 * already decided the read is authorised.
 */
async function logCustomerRead(
  db: CartDb,
  actor: AdminActor,
  entry: {
    action: string;
    entityType: string;
    entityId?: string | null;
    diff?: ReturnType<typeof searchDiff> | null;
    nowMs: number;
  }
): Promise<void> {
  try {
    await writeAudit(db, {
      actorEmail: actor.email,
      actorAdminUserId: actor.adminUserId,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      diff: entry.diff ?? null,
      result: "ok",
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      nowMs: entry.nowMs,
    });
  } catch (error) {
    console.error("[admin-data] could not record a read of customer data:", error);
  }
}
