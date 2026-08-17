/**
 * THE RATE SCREEN AND THE NUMBERS SCREEN — every read and every rule they own.
 *
 * ===========================================================================
 * WHY THIS IS ITS OWN MODULE
 * ===========================================================================
 * `app/_admin/data.ts` is the shared admin reader and it is deliberately not
 * touched here. What lives in this file is what belongs to these two screens
 * alone: the rate board, the append-only supersession rule, the ten-times
 * guard, the orders billed from one rate row, and the two aggregations the
 * charts are drawn from. Everything shared — `resolveAdmin()`, `actorFrom()`,
 * `readClock()`, `formatWhen()`, `readRateStanding()` — is imported from there.
 *
 * It is a `.ts` file and not a `.tsx` one on purpose: every rule below is a
 * pure function over integers, and a pure function in a component file cannot
 * be tested without rendering something.
 *
 * ===========================================================================
 * THE UNIT, AND THE ONE BUG THIS FILE EXISTS TO PREVENT
 * ===========================================================================
 * `db/schema.ts` on `goldRates`: `rate_per_ten_grams_paise` is paise PER TEN
 * GRAMS because that is the unit IBJA publishes gold in, and "a silent 10x at
 * this step is the worst bug this system can have: it does not throw, it does
 * not look wrong in a table, and it multiplies every order by ten."
 *
 * A screen that lets a human type the figure reopens that hole by hand. So
 * `checkRateFigure()` below REFUSES — never warns, never accepts with a
 * shrug — a figure that sits where a per-gram or a ten-times figure would sit
 * against the rate already in force. There is no confirmation that gets past
 * it, because there is no legitimate overnight ten-fold move in the price of
 * gold; a figure that looks like one is a typo or a unit mistake in every real
 * case. A merely LARGE move is a different thing and is confirmable, because
 * that one does happen.
 *
 * ===========================================================================
 * APPEND-ONLY, AND WHAT A "CORRECTION" IS
 * ===========================================================================
 * `gold_rates` is never UPDATEd except to write `effective_to` on the outgoing
 * row — the interval terminator, not a mutation of the observation. So this
 * module offers no edit of any kind. A correction is an APPEND: the wrong row
 * is closed at this moment and the right figure is inserted after it, both in
 * one `db.batch()`, which is the only atomicity primitive D1 offers.
 *
 * The correction is recorded in columns that already exist rather than in a
 * migration nobody has run:
 *
 *   source            'manual'
 *   source_ref        `correction:<id of the row it replaces>:<reason code>`
 *   source_quote_raw  the figure the owner typed, VERBATIM, before conversion
 *   created_by        the signed-in admin's address
 *
 * `sourceRef` is therefore both the link back to the superseded row and the
 * idempotency key, and `sourceQuoteRaw` is what makes a bad entry provable
 * later instead of arguable — the same anchor the IBJA ingest keeps.
 *
 * ===========================================================================
 * READS OF CUSTOMER DATA ARE LOGGED HERE, NOT BY THE SCREEN
 * ===========================================================================
 * `readOrdersBilledFromRate()` returns customers' names and phone numbers, so
 * it takes a REQUIRED actor and writes the DPDP Rule 6(1)(c) row itself — the
 * same placement, and the same reason, as `app/_admin/data.ts`. What is
 * written is the actor, the action, a count and which field was matched on.
 * Never a name, never a number, never the rate id's customers.
 *
 * Nothing else in this file touches a person, so nothing else logs.
 */

import type { CartDb, CartStatement, SqlRow, SqlValue } from "../_data/cart";
import { PAYMENT_CAPTURE_ENABLED } from "../_data/orders";
import {
  IBJA_GOLD_FINENESS,
  IBJA_SILVER_FINENESS,
  formatPaiseAsRupees,
  goldQuoteToPaisePerTenGrams,
  nextPublicationAfter,
  silverQuoteToPaisePerTenGrams,
  type RateLookup,
} from "../_pricing/rates";
import { ADMIN_ACTIONS, searchDiff, writeAudit } from "./audit";
import { toIso, type AdminActor } from "./data";

/* =========================================================================
 * What the shop quotes in
 * ====================================================================== */

/** The purity the whole shop hangs off, and the one the board leads with. */
export const HEADLINE_FINENESS = 916;

/**
 * Every metal and purity a rate may be entered for, in the order the pills are
 * drawn. A closed set: the value from a form is matched against it by exact
 * equality, so nothing typed into a request reaches a query.
 */
export const RATE_SLOTS: readonly {
  readonly metal: "gold" | "silver";
  readonly fineness: number;
  readonly label: string;
  /** The unit the SOURCE publishes in. Gold per 10 g; silver per kilogram. */
  readonly unit: "per_ten_grams" | "per_kilogram";
}[] = [
  ...IBJA_GOLD_FINENESS.map((fineness) => ({
    metal: "gold" as const,
    fineness,
    label: String(fineness),
    unit: "per_ten_grams" as const,
  })),
  {
    metal: "silver",
    fineness: IBJA_SILVER_FINENESS,
    label: "Silver 999",
    unit: "per_kilogram" as const,
  },
];

export function findRateSlot(
  metal: string,
  fineness: number
): (typeof RATE_SLOTS)[number] | null {
  return (
    RATE_SLOTS.find((slot) => slot.metal === metal && slot.fineness === fineness) ?? null
  );
}

/** The words on the form and on the confirmation, per unit. */
export const UNIT_WORDS = {
  per_ten_grams: "₹ per 10 grams",
  per_kilogram: "₹ per kilogram",
} as const;

/* =========================================================================
 * Row helpers — the same two this project reads every row through
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
 * The SQL expression that compares either timestamp form, and the bound value
 * in the same shape. Copied in behaviour from `app/_admin/data.ts` because
 * `SQL_TS()` is private there and a second reader of the same two formats is
 * better than an export that invites a third caller to get it wrong.
 */
function SQL_TS(column: string): string {
  return `replace(substr(${column}, 1, 19), ' ', 'T')`;
}

function sqlTimestamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19);
}

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
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

/** Midnight IST at the start of the day `ms` falls in, as a UTC epoch. */
export function istDayStart(ms: number): number {
  return Math.floor((ms + IST_OFFSET_MS) / MS_PER_DAY) * MS_PER_DAY - IST_OFFSET_MS;
}

/** `2026-08-10`, in IST. The key both charts group by. */
export function istDayKey(ms: number): string {
  const shifted = new Date(ms + IST_OFFSET_MS);
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${month}-${day}`;
}

/** `8 Aug`. Never ISO on a screen — research/05 §12. */
export function shortDate(dayKey: string): string {
  const [, month, day] = dayKey.split("-");
  const index = Number(month) - 1;
  const name = MONTHS[index] ?? month;
  return `${Number(day)} ${name}`;
}

/* =========================================================================
 * Weight, in the unit a jeweller weighs in
 * ====================================================================== */

/**
 * Milligrams to grams as a STRING, to three places, without a float.
 * `18400` -> `18.400`. Integer arithmetic only, for the same reason money is:
 * a weight is a statutory figure on a BIS Reg. 5(11) document and a rounding
 * artefact in one is a discrepancy somebody has to explain.
 */
export function formatMilligrams(mg: number): string {
  const safe = Math.max(0, Math.trunc(mg));
  const grams = Math.floor(safe / 1000);
  return `${grams.toLocaleString("en-IN")}.${String(safe % 1000).padStart(3, "0")}`;
}

/* =========================================================================
 * THE TEN-TIMES GUARD
 * ====================================================================== */

export type FigureVerdict =
  | { readonly ok: true; readonly paise: number; readonly needsConfirmation: false }
  | {
      readonly ok: true;
      readonly paise: number;
      readonly needsConfirmation: true;
      readonly code: "big_move";
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly code: "not_a_figure" | "looks_per_gram" | "looks_ten_times" | "out_of_band";
      readonly message: string;
    };

/**
 * The widest band a gold rate per ten grams has any business being in, used
 * ONLY when there is no previous rate to measure against — ₹500 to ₹50,00,000
 * per ten grams. It is deliberately far too wide to catch a plausible typo;
 * its whole job is to catch the first-ever entry that is out by a factor of a
 * thousand, which the ratio test cannot see because there is nothing to
 * compare with.
 */
const FIRST_ENTRY_MIN_PAISE = 500 * 100;
const FIRST_ENTRY_MAX_PAISE = 50_00_000 * 100;

/** A move this large is a typo often enough to be worth one extra tap. */
const BIG_MOVE_NUMERATOR = 1;
const BIG_MOVE_DENOMINATOR = 4; // a quarter.

/**
 * Read a typed rupee figure, in the unit the source publishes, and decide
 * whether it may be written.
 *
 * `raw` is the string exactly as the owner typed it, and it is what travels
 * into `source_quote_raw`. The paise value is DERIVED from it here rather than
 * sent alongside it, so the stored number and the recorded quote can never
 * disagree — the same rule `app/api/gold-rate/route.ts` follows for a manual
 * ingest.
 *
 * The two refusals are absolute. A figure a tenth of the rate in force is a
 * per-gram figure typed into a per-ten-grams box; a figure ten times it is the
 * same mistake mirrored. Neither is a real overnight move in the price of
 * gold, and neither may be confirmed away — the whole reason
 * `ratePerTenGramsPaise` is named the way it is, is that this mistake does not
 * announce itself afterwards.
 */
export function checkRateFigure(input: {
  readonly raw: string;
  readonly unit: "per_ten_grams" | "per_kilogram";
  /** The rate currently in force for this metal and purity, if there is one. */
  readonly previousPaise: number | null;
  readonly confirmed?: boolean;
}): FigureVerdict {
  const raw = input.raw.trim();

  if (raw.length === 0 || raw.length > 32) {
    return {
      ok: false,
      code: "not_a_figure",
      message: "Type the rate as a plain rupee figure, the way it is printed.",
    };
  }

  const paise =
    input.unit === "per_kilogram"
      ? silverQuoteToPaisePerTenGrams(raw)
      : goldQuoteToPaisePerTenGrams(raw);

  if (paise === null || paise <= 0) {
    return {
      ok: false,
      code: "not_a_figure",
      message: `“${raw}” is not a rupee figure. Type the digits as they are printed — ${
        input.unit === "per_kilogram" ? "₹ per kilogram" : "₹ per 10 grams"
      }, with or without commas.`,
    };
  }

  const previous = input.previousPaise;

  if (previous === null || previous <= 0) {
    if (paise < FIRST_ENTRY_MIN_PAISE || paise > FIRST_ENTRY_MAX_PAISE) {
      return {
        ok: false,
        code: "out_of_band",
        message: `₹${formatPaiseAsRupees(
          paise
        )} per 10 grams is not a figure a metal rate has ever been. Check the unit — gold is published per 10 grams and silver per kilogram — and type it again.`,
      };
    }
    return { ok: true, paise, needsConfirmation: false };
  }

  const perGramNow = Math.round(previous / 10);
  const perGramTyped = Math.round(paise / 10);

  // A tenth, give or take: between a fifth and a twentieth of the rate in
  // force. Nothing else lives in that band.
  if (paise * 5 <= previous && paise * 20 >= previous) {
    return {
      ok: false,
      code: "looks_per_gram",
      message: `₹${formatPaiseAsRupees(paise)} per 10 grams is ₹${formatPaiseAsRupees(
        perGramTyped
      )} a gram. The rate in force is ₹${formatPaiseAsRupees(
        perGramNow
      )} a gram, so this one looks ten times too small — it looks like a per-gram figure. The box takes the figure per 10 grams, exactly as it is printed. Nothing has been changed.`,
    };
  }

  if (paise >= previous * 5 && paise <= previous * 20) {
    return {
      ok: false,
      code: "looks_ten_times",
      message: `₹${formatPaiseAsRupees(
        paise
      )} per 10 grams is ten times the rate in force, which is ₹${formatPaiseAsRupees(
        previous
      )}. That is not a move gold makes. Check the digits and type it again. Nothing has been changed.`,
    };
  }

  const movement = Math.abs(paise - previous);
  if (movement * BIG_MOVE_DENOMINATOR > previous * BIG_MOVE_NUMERATOR) {
    if (input.confirmed !== true) {
      return {
        ok: true,
        paise,
        needsConfirmation: true,
        code: "big_move",
        message: `The rate in force is ₹${formatPaiseAsRupees(
          previous
        )} and this one is ₹${formatPaiseAsRupees(
          paise
        )} — a change of more than a quarter in one step. That does happen, but it is also what a mistyped digit looks like. Read the figure once more before it goes in.`,
      };
    }
  }

  return { ok: true, paise, needsConfirmation: false };
}

/* =========================================================================
 * Why a rate was wrong — a closed set
 * ====================================================================== */

export const CORRECTION_REASONS = {
  typo: "A typing mistake",
  source_wrong: "The figure from IBJA was wrong",
  other: "Something else",
} as const;

export type CorrectionReason = keyof typeof CORRECTION_REASONS;

export function isCorrectionReason(value: string): value is CorrectionReason {
  return Object.hasOwn(CORRECTION_REASONS, value);
}

/** `correction:<superseded row id>:<reason>`. Both a link and a key. */
export function correctionRef(supersededId: string, reason: CorrectionReason): string {
  return `correction:${supersededId}:${reason}`;
}

export type CorrectionMark = {
  readonly supersededId: string;
  readonly reason: CorrectionReason;
};

/** The inverse. Returns null for every `sourceRef` that is not a correction. */
export function readCorrectionRef(sourceRef: string | null): CorrectionMark | null {
  if (!sourceRef || !sourceRef.startsWith("correction:")) return null;
  const rest = sourceRef.slice("correction:".length);
  const cut = rest.lastIndexOf(":");
  if (cut <= 0) return null;
  const supersededId = rest.slice(0, cut);
  const reason = rest.slice(cut + 1);
  return isCorrectionReason(reason) ? { supersededId, reason } : null;
}

/* =========================================================================
 * The board — what is in force, for every purity
 * ====================================================================== */

export type RateBoardRow = {
  readonly id: string;
  readonly metal: string;
  readonly fineness: number;
  readonly label: string;
  readonly unit: "per_ten_grams" | "per_kilogram";
  readonly ratePerTenGramsPaise: number;
  readonly source: string;
  readonly sourceQuoteRaw: string | null;
  readonly effectiveFrom: string;
  readonly createdBy: string | null;
};

const SELECT_OPEN_RATES = `
  SELECT id                       AS "id",
         metal                    AS "metal",
         fineness                 AS "fineness",
         rate_per_ten_grams_paise AS "ratePerTenGramsPaise",
         source                   AS "source",
         source_ref               AS "sourceRef",
         source_quote_raw         AS "sourceQuoteRaw",
         effective_from           AS "effectiveFrom",
         created_by               AS "createdBy"
    FROM gold_rates
   WHERE effective_to IS NULL`;

function toBoardRow(row: SqlRow): RateBoardRow | null {
  const metal = text(row, "metal");
  const fineness = int(row, "fineness");
  if (metal === null || fineness === null) return null;
  const slot = findRateSlot(metal, fineness);

  return {
    id: text(row, "id") ?? "",
    metal,
    fineness,
    label: slot?.label ?? `${metal} ${fineness}`,
    unit: slot?.unit ?? "per_ten_grams",
    ratePerTenGramsPaise: int(row, "ratePerTenGramsPaise") ?? 0,
    source: text(row, "source") ?? "",
    sourceQuoteRaw: text(row, "sourceQuoteRaw"),
    effectiveFrom: toIso(text(row, "effectiveFrom")) ?? "",
    createdBy: text(row, "createdBy"),
  };
}

/**
 * Every rate in force, in the order the pills are drawn — so the headline
 * purity and "the other purities" come from ONE read of the table rather than
 * from six.
 */
export async function readRateBoard(db: CartDb): Promise<RateBoardRow[]> {
  const rows = await db.all(SELECT_OPEN_RATES);
  const found = new Map<string, RateBoardRow>();

  for (const row of rows) {
    const board = toBoardRow(row);
    if (board) found.set(`${board.metal}:${board.fineness}`, board);
  }

  const ordered: RateBoardRow[] = [];
  for (const slot of RATE_SLOTS) {
    const row = found.get(`${slot.metal}:${slot.fineness}`);
    if (row) ordered.push(row);
  }
  // A purity nobody publishes any more, still in force. It is in the table, so
  // it is on the screen: this board is what the database holds, not what the
  // code expected it to hold.
  for (const [key, row] of found) {
    if (!RATE_SLOTS.some((slot) => `${slot.metal}:${slot.fineness}` === key)) {
      ordered.push(row);
    }
  }

  return ordered;
}

/** The rate one entry supersedes, read back by its own id. Null if closed. */
export async function readOpenRateById(
  db: CartDb,
  id: string
): Promise<RateBoardRow | null> {
  const rows = await db.all(`${SELECT_OPEN_RATES} AND id = ? LIMIT 1`, [id]);
  return rows[0] ? toBoardRow(rows[0]) : null;
}

/**
 * THE RATE THE WRONG ONE REPLACED — and why a correction is measured against
 * it rather than against the rate in force.
 *
 * The rate in force IS the wrong one. Measuring a correction against it would
 * make the ten-times guard fire on exactly the correction it exists to invite:
 * putting right a per-gram typo means entering a figure ten times what the
 * table currently says, which is indistinguishable from the mistake unless the
 * comparison moves one row back.
 *
 * So a correction is checked against the last figure that was believed to be
 * right, which is also the figure the screen quotes back at the owner: "the
 * rate before it was ₹7,294 a gram". If the wrong row was the first ever
 * recorded there is nothing to compare with, and the absolute band is all
 * that is left.
 *
 * A ROW THAT WAS ITSELF CORRECTED IS SKIPPED. Somebody has already said that
 * figure was wrong, in writing, in this table — benchmarking against it would
 * make the second correction on a purity harder than the first, which is
 * exactly backwards. That is what the `NOT EXISTS` clause is for: a row is a
 * benchmark only if no correction row names it.
 */
export async function readRateBefore(
  db: CartDb,
  { metal, fineness, before }: { metal: string; fineness: number; before: string }
): Promise<RateBoardRow | null> {
  const rows = await db.all(
    `SELECT r.id                       AS "id",
            r.metal                    AS "metal",
            r.fineness                 AS "fineness",
            r.rate_per_ten_grams_paise AS "ratePerTenGramsPaise",
            r.source                   AS "source",
            r.source_ref               AS "sourceRef",
            r.source_quote_raw         AS "sourceQuoteRaw",
            r.effective_from           AS "effectiveFrom",
            r.created_by               AS "createdBy"
       FROM gold_rates r
      WHERE r.metal = ? AND r.fineness = ?
        AND ${SQL_TS("r.effective_from")} < ?
        AND NOT EXISTS (
              SELECT 1 FROM gold_rates c
               WHERE c.source_ref LIKE 'correction:' || r.id || ':%'
            )
      ORDER BY ${SQL_TS("r.effective_from")} DESC, r.rowid DESC
      LIMIT 1`,
    [metal, fineness, before.slice(0, 19)] satisfies SqlValue[]
  );
  return rows[0] ? toBoardRow(rows[0]) : null;
}

/** Any rate row by id, open or closed — what the "which orders" view needs. */
export async function readRateById(db: CartDb, id: string): Promise<RateBoardRow | null> {
  const rows = await db.all(
    `SELECT id                       AS "id",
            metal                    AS "metal",
            fineness                 AS "fineness",
            rate_per_ten_grams_paise AS "ratePerTenGramsPaise",
            source                   AS "source",
            source_ref               AS "sourceRef",
            source_quote_raw         AS "sourceQuoteRaw",
            effective_from           AS "effectiveFrom",
            created_by               AS "createdBy"
       FROM gold_rates
      WHERE id = ?
      LIMIT 1`,
    [id]
  );
  return rows[0] ? toBoardRow(rows[0]) : null;
}

/* =========================================================================
 * The history, and the corrections written against it
 * ====================================================================== */

export type RateHistoryRow = {
  readonly id: string;
  readonly ratePerTenGramsPaise: number;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly sourceQuoteRaw: string | null;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly createdBy: string | null;
  /** True for the row a price is quoted from right now. */
  readonly inForce: boolean;
  /** Set when this row was closed by a correction, and by which one. */
  readonly correctedBy: {
    readonly id: string;
    readonly reason: CorrectionReason;
    readonly ratePerTenGramsPaise: number;
    readonly at: string;
  } | null;
  /** Set when this row IS a correction, naming the row it replaced. */
  readonly corrects: CorrectionMark | null;
  /** How many order lines were priced from this row. Never a name. */
  readonly billedLines: number;
};

const SELECT_HISTORY = `
  SELECT r.id                       AS "id",
         r.rate_per_ten_grams_paise AS "ratePerTenGramsPaise",
         r.source                   AS "source",
         r.source_ref               AS "sourceRef",
         r.source_quote_raw         AS "sourceQuoteRaw",
         r.effective_from           AS "effectiveFrom",
         r.effective_to             AS "effectiveTo",
         r.created_by               AS "createdBy",
         (SELECT COUNT(*) FROM order_items i WHERE i.gold_rate_id = r.id) AS "billedLines"
    FROM gold_rates r
   WHERE r.metal = ? AND r.fineness = ?
   ORDER BY ${SQL_TS("r.effective_from")} DESC, r.rowid DESC
   LIMIT ?`;

export const HISTORY_LIMIT = 25;

/**
 * The trail for one metal and purity, newest first, with each correction
 * folded into the row it corrects.
 *
 * The fold is what makes the append-only rule readable rather than merely
 * true: a bad figure and the figure that replaced it sit together, and the
 * bad one is never removed — the orders priced from it still have to add up.
 */
export async function readRateHistory(
  db: CartDb,
  {
    metal = "gold",
    fineness = HEADLINE_FINENESS,
    limit = HISTORY_LIMIT,
  }: { metal?: string; fineness?: number; limit?: number } = {}
): Promise<RateHistoryRow[]> {
  const rows = await db.all(SELECT_HISTORY, [
    metal,
    fineness,
    Math.max(1, Math.trunc(limit)),
  ] satisfies SqlValue[]);

  const base = rows.map((row) => {
    const sourceRef = text(row, "sourceRef");
    return {
      id: text(row, "id") ?? "",
      ratePerTenGramsPaise: int(row, "ratePerTenGramsPaise") ?? 0,
      source: text(row, "source") ?? "",
      sourceRef,
      sourceQuoteRaw: text(row, "sourceQuoteRaw"),
      effectiveFrom: toIso(text(row, "effectiveFrom")) ?? "",
      effectiveTo: toIso(text(row, "effectiveTo")),
      createdBy: text(row, "createdBy"),
      inForce: text(row, "effectiveTo") === null,
      corrects: readCorrectionRef(sourceRef),
      billedLines: int(row, "billedLines") ?? 0,
    };
  });

  const byId = new Map(base.map((row) => [row.id, row]));

  return base.map((row) => {
    const correction = base.find((other) => other.corrects?.supersededId === row.id);
    const target = correction ? byId.get(correction.id) : undefined;

    return {
      ...row,
      correctedBy:
        correction && target
          ? {
              id: correction.id,
              reason: correction.corrects!.reason,
              ratePerTenGramsPaise: correction.ratePerTenGramsPaise,
              at: correction.effectiveFrom,
            }
          : null,
    };
  });
}

/* =========================================================================
 * Is the automatic check still running?
 * ====================================================================== */

export type IngestHealth = {
  /** The last row the IBJA scraper wrote, for any metal. */
  readonly lastRunAt: string | null;
  readonly lastRunFineness: number | null;
  /** IBJA's next publication instant after that one. */
  readonly nextDueAt: string | null;
  /** Publications that came and went without a row. Never negative. */
  readonly missedPublications: number;
};

const SELECT_LAST_INGEST = `
  SELECT effective_from AS "effectiveFrom",
         fineness       AS "fineness"
    FROM gold_rates
   WHERE source = 'ibja'
   ORDER BY ${SQL_TS("effective_from")} DESC
   LIMIT 1`;

/**
 * WHEN THE AUTOMATIC CHECK LAST RAN, AND WHEN IT IS NEXT DUE.
 *
 * Phrased as an event rather than as a status, because "last ran at 11:25 and
 * is next due at 2:25" is something a shopkeeper can act on and "ingest:
 * healthy" is not. Staleness has to be visible BEFORE it is a problem, and
 * this is the line that makes it so — a missed publication shows here a full
 * grace period before the rate itself expires and the storefront stops
 * quoting.
 */
export async function readIngestHealth(
  db: CartDb,
  { nowMs = Date.now() }: { nowMs?: number } = {}
): Promise<IngestHealth> {
  const [row] = await db.all(SELECT_LAST_INGEST);

  if (!row) {
    return { lastRunAt: null, lastRunFineness: null, nextDueAt: null, missedPublications: 0 };
  }

  const lastRunAt = toIso(text(row, "effectiveFrom"));
  const lastMs = lastRunAt === null ? Number.NaN : Date.parse(lastRunAt);

  if (!Number.isFinite(lastMs)) {
    return { lastRunAt, lastRunFineness: int(row, "fineness"), nextDueAt: null, missedPublications: 0 };
  }

  const nextDue = nextPublicationAfter(lastMs);

  // Count the publications between that row and now. Bounded, so a database
  // holding a rate from 2019 cannot spin here.
  let missed = 0;
  let cursor = lastMs;
  for (let step = 0; step < 40; step += 1) {
    const next = nextPublicationAfter(cursor);
    if (next === null || next > nowMs) break;
    missed += 1;
    cursor = next;
  }

  return {
    lastRunAt,
    lastRunFineness: int(row, "fineness"),
    nextDueAt: nextDue === null ? null : new Date(nextDue).toISOString(),
    missedPublications: missed,
  };
}

/* =========================================================================
 * THE CONSEQUENCE — which orders were billed from a rate row
 * ====================================================================== */

export type BilledOrder = {
  readonly orderNumber: string;
  readonly customerName: string | null;
  readonly customerPhone: string | null;
  readonly placedAt: string;
  /** Null when the order is torn. A partial sum is never shown as a total. */
  readonly totalPaise: number | null;
  readonly intact: boolean;
  readonly status: string;
};

const SELECT_BILLED_FROM_RATE = `
  SELECT o.order_number    AS "orderNumber",
         o.contact_name    AS "contactName",
         o.contact_phone   AS "contactPhone",
         o.placed_at       AS "placedAt",
         o.total_paise     AS "totalPaise",
         o.status          AS "status",
         o.line_item_count AS "lineItemCount",
         (SELECT COUNT(*) FROM order_items x WHERE x.order_id = o.id) AS "foundLines"
    FROM orders o
   WHERE EXISTS (
           SELECT 1 FROM order_items i
            WHERE i.order_id = o.id AND i.gold_rate_id = ?
         )
   ORDER BY ${SQL_TS("o.placed_at")} DESC
   LIMIT ?`;

export const BILLED_LIMIT = 50;

/**
 * THE PART MOST TOOLS SKIP.
 *
 * Correcting a rate does not fix the bills already made from it, and a screen
 * that lets the owner correct one without naming them is a screen that quietly
 * creates a discrepancy between what the shop believes and what a customer was
 * told. `order_items.gold_rate_id` points at the exact row, which is why it
 * exists — `db/schema.ts`: "the foreign key proves provenance; the value
 * survives independently."
 *
 * This returns names and phone numbers, so it takes an actor and writes the
 * Rule 6(1)(c) row itself. What goes into the log is the field matched on and
 * the count. The rate id is an internal identifier and travels as the entity
 * id; no customer of that rate is named anywhere in the trail.
 */
export async function readOrdersBilledFromRate(
  db: CartDb,
  rateId: string,
  options: { readonly actor: AdminActor; readonly nowMs?: number; readonly limit?: number }
): Promise<BilledOrder[]> {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.trunc(options.limit ?? BILLED_LIMIT));

  const rows = await db.all(SELECT_BILLED_FROM_RATE, [rateId, limit] satisfies SqlValue[]);

  const orders: BilledOrder[] = rows.map((row) => {
    const declared = int(row, "lineItemCount") ?? 0;
    const found = int(row, "foundLines") ?? 0;
    const intact = declared === found;

    return {
      orderNumber: text(row, "orderNumber") ?? "",
      customerName: text(row, "contactName"),
      customerPhone: text(row, "contactPhone"),
      placedAt: toIso(text(row, "placedAt")) ?? "",
      totalPaise: intact ? int(row, "totalPaise") : null,
      intact,
      status: text(row, "status") ?? "",
    };
  });

  try {
    await writeAudit(db, {
      actorEmail: options.actor.email,
      actorAdminUserId: options.actor.adminUserId,
      action: ADMIN_ACTIONS.searchRun,
      entityType: "order",
      entityId: rateId,
      diff: searchDiff(["gold_rate_id"], orders.length),
      result: "ok",
      ip: options.actor.ip ?? null,
      userAgent: options.actor.userAgent ?? null,
      nowMs,
    });
  } catch (error) {
    console.error("[admin-rate] could not record a read of the orders billed from a rate:", error);
  }

  return orders;
}

/* =========================================================================
 * WRITING — one batch, close then insert, audit inside
 * ====================================================================== */

/**
 * Closes the open row for one metal and purity. Two shapes, and the difference
 * is the whole concurrency story:
 *
 *   a CORRECTION names the row it is replacing, so if somebody else has
 *   already closed that row the UPDATE changes nothing, the INSERT then
 *   collides with THEIR still-open row on `gold_rates_current_idx`, and the
 *   batch aborts. The owner is told what the rate says now instead of silently
 *   overwriting a colleague.
 *
 *   an ENTRY closes whatever is open, because it is not claiming anything
 *   about what that was.
 */
const CLOSE_BY_ID = `
  UPDATE gold_rates
     SET effective_to = ?
   WHERE id = ? AND effective_to IS NULL`;

const CLOSE_OPEN_FOR_SLOT = `
  UPDATE gold_rates
     SET effective_to = ?
   WHERE metal = ? AND fineness = ? AND effective_to IS NULL`;

const INSERT_RATE = `
  INSERT INTO gold_rates (
    id, metal, fineness, rate_per_ten_grams_paise, source, source_ref,
    source_quote_raw, effective_from, effective_to, created_by, created_at
  ) VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, NULL, ?, ?)`;

export type RateAppendInput = {
  readonly metal: "gold" | "silver";
  readonly fineness: number;
  readonly ratePerTenGramsPaise: number;
  /** The figure exactly as it was typed. The audit anchor. Never derived back. */
  readonly sourceQuoteRaw: string;
  readonly sourceRef: string;
  readonly createdBy: string;
  /** Set for a correction: the row this one replaces, which must still be open. */
  readonly supersedes?: string | null;
  readonly nowMs: number;
};

export type RateAppendPlan = {
  readonly id: string;
  readonly effectiveFrom: string;
  readonly statements: readonly CartStatement[];
};

/**
 * The statements a rate write is made of, so the caller can put its audit row
 * in the SAME batch. `app/_admin/audit.ts`: an audit row written in a second
 * batch either records a change that did not commit or misses one that did.
 *
 * `effective_from` is the moment of entry rather than an IBJA slot, so a
 * correction made four minutes after a bad entry is strictly newer than the
 * row it replaces and the trail reads in the order things happened.
 */
export function planRateAppend(input: RateAppendInput): RateAppendPlan {
  const at = new Date(input.nowMs).toISOString();
  const id = crypto.randomUUID();

  const close: CartStatement = input.supersedes
    ? { sql: CLOSE_BY_ID, params: [at, input.supersedes] }
    : { sql: CLOSE_OPEN_FOR_SLOT, params: [at, input.metal, input.fineness] };

  const insert: CartStatement = {
    sql: INSERT_RATE,
    params: [
      id,
      input.metal,
      input.fineness,
      input.ratePerTenGramsPaise,
      input.sourceRef,
      input.sourceQuoteRaw,
      at,
      input.createdBy,
      at,
    ],
  };

  return { id, effectiveFrom: at, statements: [close, insert] };
}

/* =========================================================================
 * THE NUMBERS — two aggregations, and nothing else
 * ====================================================================== */

/**
 * The windows the screen offers. A closed set, matched by exact equality.
 * There is no "all time": a chart whose x-axis grows forever stops being
 * readable the month after it is built.
 */
export const NUMBER_WINDOWS = {
  30: { days: 30, label: "Last 30 days" },
  90: { days: 90, label: "Last 90 days" },
  365: { days: 365, label: "Last year" },
} as const;

export type NumberWindow = keyof typeof NUMBER_WINDOWS;

export function toNumberWindow(value: unknown): NumberWindow {
  const key = typeof value === "string" ? Number(value) : Number.NaN;
  return key === 90 ? 90 : key === 365 ? 365 : 30;
}

export type DayCount = {
  readonly dayKey: string;
  readonly orders: number;
};

export type OrdersOverTime = {
  readonly days: readonly DayCount[];
  readonly totalOrders: number;
  /**
   * Intact orders only. It is what was RECORDED, and it must never be printed
   * without the sentence that says so — see `PAYMENT_CAPTURE_ENABLED`.
   */
  readonly recordedTotalPaise: number;
  /** Orders that did not save fully. Reported, never summed. */
  readonly tornOrders: number;
  readonly daysWithAnOrder: number;
};

const SELECT_ORDERS_IN_WINDOW = `
  SELECT o.placed_at       AS "placedAt",
         o.total_paise     AS "totalPaise",
         o.line_item_count AS "lineItemCount",
         (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS "foundLines"
    FROM orders o
   WHERE ${SQL_TS("o.placed_at")} >= ?
     AND o.status <> 'cancelled'`;

/**
 * ORDERS A DAY — counts on discrete days, which is why the chart is bars.
 *
 * Every day in the window is present, including the ones with nothing. A line
 * would draw straight through those and hide the single thing a shop owner
 * actually reads off this chart: how many days had no orders at all.
 */
export async function readOrdersOverTime(
  db: CartDb,
  { days, nowMs = Date.now() }: { days: number; nowMs?: number }
): Promise<OrdersOverTime> {
  const span = Math.max(1, Math.trunc(days));
  const firstDayStart = istDayStart(nowMs) - (span - 1) * MS_PER_DAY;
  const rows = await db.all(SELECT_ORDERS_IN_WINDOW, [sqlTimestamp(firstDayStart)]);

  const counts = new Map<string, number>();
  for (let i = 0; i < span; i += 1) {
    counts.set(istDayKey(firstDayStart + i * MS_PER_DAY), 0);
  }

  let recordedTotalPaise = 0;
  let tornOrders = 0;
  let totalOrders = 0;

  for (const row of rows) {
    const placedAt = toIso(text(row, "placedAt"));
    const ms = placedAt === null ? Number.NaN : Date.parse(placedAt);
    if (!Number.isFinite(ms)) continue;

    const key = istDayKey(ms);
    if (!counts.has(key)) continue;

    counts.set(key, (counts.get(key) ?? 0) + 1);
    totalOrders += 1;

    if ((int(row, "lineItemCount") ?? 0) === (int(row, "foundLines") ?? 0)) {
      recordedTotalPaise += int(row, "totalPaise") ?? 0;
    } else {
      tornOrders += 1;
    }
  }

  const series = [...counts.entries()].map(([dayKey, orders]) => ({ dayKey, orders }));
  series.sort((a, b) => (a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0));

  return {
    days: series,
    totalOrders,
    recordedTotalPaise,
    tornOrders,
    daysWithAnOrder: series.filter((day) => day.orders > 0).length,
  };
}

export type MetalCommitted = {
  readonly metal: string;
  readonly fineness: number | null;
  readonly label: string;
  readonly milligrams: number;
};

const SELECT_METAL_COMMITTED = `
  SELECT i.metal_snapshot      AS "metal",
         i.fineness_snapshot   AS "fineness",
         SUM(i.net_metal_weight_mg * i.quantity) AS "milligrams"
    FROM order_items i
    JOIN orders o ON o.id = i.order_id
   WHERE ${SQL_TS("o.placed_at")} >= ?
     AND o.status <> 'cancelled'
     AND i.net_metal_weight_mg IS NOT NULL
     AND o.line_item_count = (
           SELECT COUNT(*) FROM order_items x WHERE x.order_id = o.id
         )
   GROUP BY i.metal_snapshot, i.fineness_snapshot
   ORDER BY SUM(i.net_metal_weight_mg * i.quantity) DESC`;

/** Six rows, then Other. Past that the labels stop being readable at 390px. */
export const COMMITTED_ROW_LIMIT = 6;

export type CommittedResult = {
  readonly rows: readonly MetalCommitted[];
  readonly totalMilligrams: number;
  readonly goldOnly: boolean;
};

/**
 * GOLD COMMITTED, IN GRAMS — the one genuinely shop-specific view here.
 *
 * A jeweller's stock is metal. Rupees move with the rate twice a business day;
 * grams do not, so "38.400 g of 916 went out this month" tells the owner what
 * to buy and the same figure in rupees does not. It comes straight from
 * `order_items.net_metal_weight_mg` grouped by `fineness_snapshot`, which is
 * exact because the snapshot is statutory — it is already there and it is
 * already right.
 *
 * TORN ORDERS ARE EXCLUDED, in the query, by the same declared-vs-found test
 * every other reader in this panel uses. An order missing a line understates
 * its own metal, and a figure the owner buys stock against may not be
 * understated by a write that half committed.
 */
export async function readMetalCommitted(
  db: CartDb,
  { days, nowMs = Date.now() }: { days: number; nowMs?: number }
): Promise<CommittedResult> {
  const span = Math.max(1, Math.trunc(days));
  const firstDayStart = istDayStart(nowMs) - (span - 1) * MS_PER_DAY;
  const rows = await db.all(SELECT_METAL_COMMITTED, [sqlTimestamp(firstDayStart)]);

  const all: MetalCommitted[] = [];
  for (const row of rows) {
    const milligrams = int(row, "milligrams") ?? 0;
    if (milligrams <= 0) continue;
    const metal = text(row, "metal") ?? "metal";
    const fineness = int(row, "fineness");
    all.push({
      metal,
      fineness,
      label:
        metal === "gold"
          ? (fineness === null ? "Gold, purity not recorded" : String(fineness))
          : `${metal.charAt(0).toUpperCase()}${metal.slice(1)}${fineness === null ? "" : ` ${fineness}`}`,
      milligrams,
    });
  }

  const totalMilligrams = all.reduce((sum, row) => sum + row.milligrams, 0);

  let shown: MetalCommitted[] = all;
  if (all.length > COMMITTED_ROW_LIMIT) {
    const head = all.slice(0, COMMITTED_ROW_LIMIT - 1);
    const rest = all.slice(COMMITTED_ROW_LIMIT - 1);
    shown = [
      ...head,
      {
        metal: "other",
        fineness: null,
        label: "Other",
        milligrams: rest.reduce((sum, row) => sum + row.milligrams, 0),
      },
    ];
  }

  return {
    rows: shown,
    totalMilligrams,
    goldOnly: all.every((row) => row.metal === "gold"),
  };
}

/* =========================================================================
 * CHART GEOMETRY — pure, so the shapes are assertions rather than screenshots
 * ====================================================================== */

/**
 * Every chart on these screens is an inline SVG rendered on the server. There
 * is no charting library and there is no script: the panel is designed to work
 * with JavaScript switched off, and a chart that needs a runtime to appear is
 * a chart that is not there on a shop's wifi.
 *
 * These two functions are the whole of the drawing logic. They take numbers
 * and return rectangles; the components below turn rectangles into `<path>`
 * elements. Nothing about a colour, a font or a label lives in here.
 */

/** The column chart's canvas, in user units. Scaled to fit by `viewBox`. */
export const COLUMN_CHART = {
  width: 358,
  /** Plot only. The axis band and the top label band are added on top. */
  plotHeight: 96,
  topBand: 16,
  axisBand: 18,
  gap: 2,
  radius: 4,
} as const;

export type ColumnBar = {
  readonly dayKey: string;
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly isMax: boolean;
};

export type ColumnChart = {
  readonly bars: readonly ColumnBar[];
  readonly max: number;
  readonly baselineY: number;
  readonly gridY: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Columns, anchored to one baseline, with a 2px surface gap between adjacent
 * bars and a 4px rounded top that squares off at the baseline. A day with no
 * orders draws NO bar — the gap is the encoding, and it is the reason this is
 * not a line.
 */
export function layOutColumns(days: readonly DayCount[]): ColumnChart {
  const { width, plotHeight, topBand, axisBand, gap, radius } = COLUMN_CHART;
  const baselineY = topBand + plotHeight;
  const height = topBand + plotHeight + axisBand;
  const count = Math.max(1, days.length);
  const slot = width / count;
  const barWidth = Math.max(1, slot - gap);
  const max = days.reduce((best, day) => Math.max(best, day.orders), 0);

  // One gridline, at the maximum. A full grid behind thirty 9px bars is more
  // ink than data.
  const gridY = topBand;

  const bars: ColumnBar[] = [];
  let maxSeen = false;

  for (let index = 0; index < days.length; index += 1) {
    const day = days[index];
    if (day.orders <= 0 || max <= 0) continue;

    const barHeight = (day.orders / max) * plotHeight;
    const isMax = day.orders === max && !maxSeen;
    if (isMax) maxSeen = true;

    bars.push({
      dayKey: day.dayKey,
      value: day.orders,
      x: index * slot + gap / 2,
      y: baselineY - barHeight,
      width: barWidth,
      height: barHeight,
      radius: Math.min(radius, barHeight / 2, barWidth / 2),
      isMax,
    });
  }

  return { bars, max, baselineY, gridY, width, height };
}

/** The horizontal chart's canvas. One row per purity. */
export const ROW_CHART = {
  width: 358,
  rowHeight: 30,
  barHeight: 14,
  /** Room for the purity label on the left and the figure on the right. */
  labelWidth: 46,
  valueWidth: 92,
  radius: 4,
} as const;

export type RowBar = {
  readonly label: string;
  readonly milligrams: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
  readonly labelY: number;
};

export type RowChart = {
  readonly bars: readonly RowBar[];
  readonly width: number;
  readonly height: number;
  readonly plotStart: number;
  readonly plotWidth: number;
};

/**
 * Horizontal bars, one hue, value direct-labelled at the end of each bar in a
 * text colour rather than the bar's own. The right gutter is reserved BEFORE
 * the bars are scaled, so the longest bar cannot push its own figure off the
 * canvas — a clipped label is worse than no label.
 */
export function layOutRows(rows: readonly MetalCommitted[]): RowChart {
  const { width, rowHeight, barHeight, labelWidth, valueWidth, radius } = ROW_CHART;
  const plotStart = labelWidth;
  const plotWidth = Math.max(10, width - labelWidth - valueWidth);
  const max = rows.reduce((best, row) => Math.max(best, row.milligrams), 0);

  const bars: RowBar[] = rows.map((row, index) => {
    const top = index * rowHeight;
    const barWidth = max <= 0 ? 0 : Math.max(2, (row.milligrams / max) * plotWidth);

    return {
      label: row.label,
      milligrams: row.milligrams,
      x: plotStart,
      y: top + (rowHeight - barHeight) / 2,
      width: barWidth,
      height: barHeight,
      radius: Math.min(radius, barWidth / 2, barHeight / 2),
      labelY: top + rowHeight / 2,
    };
  });

  return {
    bars,
    width,
    height: Math.max(rowHeight, rows.length * rowHeight),
    plotStart,
    plotWidth,
  };
}

/**
 * A rounded-at-one-end rectangle as an SVG path.
 *
 * `<rect rx>` rounds all four corners, which would lift a column off its own
 * baseline and make a short bar look like a pill. The data end is rounded; the
 * baseline end is square, so every bar starts from the same line.
 */
export function columnPath(bar: {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}): string {
  const { x, y, width, height, radius } = bar;
  const r = Math.max(0, Math.min(radius, width / 2, height));
  const bottom = y + height;
  const round = (value: number) => Math.round(value * 100) / 100;

  return [
    `M${round(x)},${round(bottom)}`,
    `V${round(y + r)}`,
    `Q${round(x)},${round(y)} ${round(x + r)},${round(y)}`,
    `H${round(x + width - r)}`,
    `Q${round(x + width)},${round(y)} ${round(x + width)},${round(y + r)}`,
    `V${round(bottom)}`,
    "Z",
  ].join(" ");
}

export function rowPath(bar: {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}): string {
  const { x, y, width, height, radius } = bar;
  const r = Math.max(0, Math.min(radius, height / 2, width));
  const right = x + width;
  const bottom = y + height;
  const round = (value: number) => Math.round(value * 100) / 100;

  return [
    `M${round(x)},${round(y)}`,
    `H${round(right - r)}`,
    `Q${round(right)},${round(y)} ${round(right)},${round(y + r)}`,
    `V${round(bottom - r)}`,
    `Q${round(right)},${round(bottom)} ${round(right - r)},${round(bottom)}`,
    `H${round(x)}`,
    "Z",
  ].join(" ");
}

/* =========================================================================
 * The sentence that must travel with every rupee figure on these screens
 * ====================================================================== */

/**
 * WHY THIS IS A CONSTANT AND NOT A PARAGRAPH IN A COMPONENT.
 *
 * `PAYMENT_CAPTURE_ENABLED` is false: the `payments` row is written
 * `status = 'created'`, `advance_paid_paise` is 0, and nothing in this
 * application can record money as received. So every rupee figure on these two
 * screens is what was ORDERED, and a screen that prints one without saying so
 * prints a figure no bank account contains.
 *
 * Exporting it as a constant is what makes that testable: the screens render
 * this exact string beside a total, and a test can assert that a total never
 * appears without it.
 */
export const RECORDED_NOT_RECEIVED =
  PAYMENT_CAPTURE_ENABLED
    ? "Every figure here is what has been ordered through the website."
    : "No money has come through the website. Card and UPI are not switched on. Every figure here is what was ordered, not what was taken.";

/** Whether a rate lookup is usable, in the one word the screens branch on. */
export function rateStandingWord(lookup: RateLookup | null): "none" | "good" | "stale" | "broken" {
  if (lookup === null) return "none";
  if (lookup.ok) return "good";
  if (lookup.reason === "rate_stale") return "stale";
  if (lookup.reason === "no_rate_recorded") return "none";
  return "broken";
}
