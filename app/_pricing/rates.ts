/**
 * IBJA metal-rate ingestion, and the audit trail behind it.
 *
 * ===========================================================================
 * WHY IBJA, AND ONLY IBJA
 * ===========================================================================
 * IBJA (ibjarates.com) publishes India-local, duty-inclusive, pre-GST,
 * pre-making rates twice every business day — polled from 29 physical market
 * participants between 11:30–12:00 and 16:30–17:00 IST and displayed at around
 * 12:05 and 17:05. Its 916 figure IS 22K. It is the number an Indian jeweller
 * actually quotes from, it is free to read, and it is what `gold_rates` was
 * shaped around. See research/02-market-tech.md §2.5.
 *
 * The two alternatives are both wrong here and neither may be reintroduced:
 *
 *   MCX is out on licence AND on cost. Its data-feed policy says, verbatim,
 *   "only delayed data is allowed for public display on the websites" and
 *   "Resale of data, in any form, whatsoever, is not permitted" — i.e. the
 *   licence forbids the exact thing a storefront does. The cheapest
 *   legally-clean tier is ~₹2.6 lakh/yr plus a signed undertaking, with no
 *   HTTP API at all. See §2.5.
 *
 *   DERIVING FROM XAU SPOT IS A TRAP. The naive chain
 *   (XAU/USD ÷ 31.1035 × USDINR × 0.916) reconstructs — badly — a number that
 *   is published free twice a day, and the landed-cost stack it has to guess
 *   is neither small nor stable: import duty moved 6% → 15% in May 2026, the
 *   steepest increase on record, and the domestic-vs-international spread
 *   moved from ~$14/oz to ~$150/oz inside one week around that change. A
 *   fixed premium cannot model that. See §2.6.
 *
 * ===========================================================================
 * THE UNIT. Read `db/schema.ts`'s comment on `goldRates` before touching this.
 * ===========================================================================
 * IBJA quotes gold in whole rupees PER TEN GRAMS and silver in whole rupees
 * PER KILOGRAM (its own footer: "Gold rates per 10gm & Silver rate per 1kg").
 * `gold_rates.ratePerTenGramsPaise` is paise per ten grams, so:
 *
 *   gold   ₹R per 10 g  ->  R × 100 paise per 10 g.        Exact, no rounding.
 *   silver ₹R per 1 kg  ->  R × 100 paise per kg
 *                           ÷ 100 (1 kg = 100 × 10 g)
 *                       ->  R paise per 10 g.              Exact for whole ₹.
 *
 * A silent 10× at this step is the worst bug this system can have: it does not
 * throw, it does not look wrong in a table, and it multiplies every order by
 * ten. Every conversion below is integer-only, string-parsed, and the figure
 * as published is carried verbatim into `sourceQuoteRaw` so a bad ingest is
 * provable after the fact rather than arguable.
 *
 * NO FLOATS. Money is integer paise throughout. The decimal parser works on
 * the digit string, never on `parseFloat`.
 *
 * ===========================================================================
 * MODULE BOUNDARIES — the fetch/parse split exists so tests need no network
 * ===========================================================================
 *   1. PURE            unit conversion, HTML parsing, publication-slot
 *                      arithmetic, staleness classification. No I/O at all.
 *                      `parseIbjaRatesHtml()` takes a string and returns a
 *                      typed result; every branch is testable offline.
 *   2. NETWORK (thin)  `fetchIbjaRatesHtml()` is one `fetch()` and nothing
 *                      else. It is the only function in this file that can
 *                      touch the internet, and it takes an injectable
 *                      `fetchImpl` so it can be driven from a fixture.
 *   3. DATABASE        `readCurrentRate()` / `ingestRateQuotes()`. D1 has no
 *                      interactive transactions, so ingestion is exactly one
 *                      `db.batch()` per `db/schema.ts`'s contract.
 */

import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../../db";
import { goldRates } from "../../db/schema";

/* ==========================================================================
 * 1. PURE — constants
 * ======================================================================= */

/** The free IBJA rate page. See the header comment for why not MCX/XAU. */
export const IBJA_RATES_URL = "https://ibjarates.com/";

/** Millesimal fineness codes IBJA publishes for gold. Never karat. */
export const IBJA_GOLD_FINENESS = [999, 995, 916, 750, 585] as const;

/** IBJA publishes one silver line, at 999. Quoted per KILOGRAM, not per 10 g. */
export const IBJA_SILVER_FINENESS = 999;

export type IngestibleMetal = "gold" | "silver";

/**
 * PLATINUM IS DELIBERATELY NOT INGESTED. IBJA renders a "Platinum 999" row,
 * but its footer states the unit only for gold (per 10 g) and silver (per kg)
 * — the platinum unit is stated nowhere on the page. Ingesting a number whose
 * unit is a guess is precisely the 10× failure this module exists to prevent.
 * The figure is still surfaced by the parser as an unconvertible observation
 * so an operator can see it; it is never converted and never written.
 */
export const IBJA_UNCONVERTIBLE_ROWS = ["Platinum999"] as const;

const IST_OFFSET_MINUTES = 330; // UTC+05:30, fixed — India has never used DST.
const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * Minute-of-day (IST) at which IBJA displays each polling round. From its own
 * published spot-polling mechanism: prices are polled 11:30–12:00 and
 * 16:30–17:00 and "displayed at around 12:05 PM and 5:05 PM on all business
 * days". 12:05 = 725, 17:05 = 1025.
 */
export const IBJA_SLOT_MINUTES_IST = [725, 1025] as const;

/**
 * ---------------------------------------------------------------------------
 * THE STALENESS RULE, and the numbers behind it.
 * ---------------------------------------------------------------------------
 * A rate does not expire on a wall-clock timer. It expires when the NEXT IBJA
 * publication was due and did not arrive, plus this grace period. That is the
 * honest form of "roughly one business day", because the real gaps between
 * consecutive publications are not uniform:
 *
 *     12:05 -> 17:05 same day .................  5 h
 *     17:05 -> next business day 12:05 ........ 19 h
 *     Fri 17:05 -> Mon 12:05 .................. 67 h
 *
 * A single 24-hour threshold would therefore be simultaneously too loose on a
 * weekday (a rate that failed to refresh at 17:05 stays "fresh" until the
 * following noon) and far too tight at a weekend (it would kill the Friday
 * evening rate on Saturday afternoon, when the shop is at its busiest). The
 * slot-relative rule is tight when a refresh was expected and tolerant when
 * none was.
 *
 * GRACE = 90 minutes. IBJA's own wording is "around 12:05 PM and 5:05 PM", the
 * ingest cron will not fire on the same second, and a first failure deserves
 * one retry. 90 minutes covers all three, and is short enough that a genuinely
 * broken ingest surfaces inside the same trading session rather than the next
 * day.
 *
 * PUBLIC HOLIDAYS ARE A KNOWN, ACCEPTED GAP. The bullion market shuts on
 * holidays this code has no calendar for, so a Monday holiday expires the
 * Friday rate at 13:35 IST on Monday and the storefront FAILS CLOSED until
 * either IBJA publishes or the owner enters a rate manually. Refusing to quote
 * is the correct behaviour: on the 5 trading days sampled during this build,
 * 916 moved 130,863 -> 137,053 (+4.7%), so pricing a bridal set against a rate
 * of unknown vintage is a real, four-figure loss, not a theoretical one.
 */
export const RATE_STALE_GRACE_MINUTES = 90;

/**
 * A backstop that binds only if the slot arithmetic above is ever wrong. No
 * legitimate rate is ever this old: the longest real gap (Fri 17:05 -> Mon
 * 12:05) is 67 hours, so 96 hours cannot be reached by a healthy feed.
 */
export const RATE_ABSOLUTE_MAX_AGE_MINUTES = 96 * 60;

/* ==========================================================================
 * 1. PURE — money, without floats
 * ======================================================================= */

/**
 * Parse a published rupee figure into integer paise, from the digit string.
 *
 * Deliberately NOT `Math.round(parseFloat(x) * 100)`: IEEE-754 makes that
 * wrong for figures it has no business being wrong for. Accepts thousands
 * separators, a rupee sign and surrounding whitespace, because those are all
 * things a source or an admin will eventually type. Fractional input is
 * rounded HALF-UP to whole paise, per `db/schema.ts`'s ingest rule.
 *
 * Returns null — never 0, never NaN — when the input is not a rupee figure.
 */
export function rupeesToPaise(raw: string): number | null {
  if (typeof raw !== "string") return null;

  const cleaned = raw
    .replace(/[\s, ]/g, "")
    .replace(/^(?:₹|Rs\.?|INR)/i, "");

  const match = /^(\d+)(?:\.(\d+))?$/.exec(cleaned);
  if (!match) return null;

  const rupees = Number(match[1]);
  if (!Number.isSafeInteger(rupees)) return null;

  const fraction = match[2] ?? "";
  const wholePaise = Number(`${fraction}00`.slice(0, 2));
  const roundUp = Number(fraction[2] ?? "0") >= 5 ? 1 : 0;

  const paise = rupees * 100 + wholePaise + roundUp;
  return Number.isSafeInteger(paise) && paise > 0 ? paise : null;
}

/**
 * Gold, as IBJA publishes it: rupees per TEN GRAMS -> paise per ten grams.
 * A straight ×100. There is no division here and there must never be one.
 */
export function goldQuoteToPaisePerTenGrams(raw: string): number | null {
  return rupeesToPaise(raw);
}

/**
 * Silver, as IBJA publishes it: rupees per KILOGRAM -> paise per ten grams.
 * 1 kg = 100 × 10 g, so paise-per-kg ÷ 100. Exact for any whole-rupee kilo
 * quote (₹229,950/kg -> 22,995,000 paise/kg -> 229,950 paise per 10 g);
 * rounded half-up only if a fractional kilo quote ever appears.
 */
export function silverQuoteToPaisePerTenGrams(raw: string): number | null {
  const paisePerKg = rupeesToPaise(raw);
  if (paisePerKg === null) return null;
  const paisePerTenGrams = Math.floor((paisePerKg + 50) / 100);
  return paisePerTenGrams > 0 ? paisePerTenGrams : null;
}

/**
 * Render integer paise as a rupee string without ever creating a float.
 * Used for display only; nothing downstream may read money back out of it.
 */
export function formatPaiseAsRupees(paise: number): string {
  const sign = paise < 0 ? "-" : "";
  const absolute = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}${rupees.toLocaleString("en-IN")}.${String(remainder).padStart(2, "0")}`;
}

/* ==========================================================================
 * 1. PURE — publication slots and staleness
 * ======================================================================= */

function istDayIndexAndMinute(ms: number) {
  const shifted = ms + IST_OFFSET_MINUTES * MS_PER_MINUTE;
  const dayIndex = Math.floor(shifted / MS_PER_DAY);
  const minuteOfDay = Math.floor((shifted - dayIndex * MS_PER_DAY) / MS_PER_MINUTE);
  return { dayIndex, minuteOfDay };
}

/** 1970-01-01 was a Thursday, so `(dayIndex + 4) % 7` is 0=Sunday..6=Saturday. */
function isBusinessDay(dayIndex: number) {
  const weekday = (((dayIndex + 4) % 7) + 7) % 7;
  return weekday >= 1 && weekday <= 5;
}

function slotInstantMs(dayIndex: number, minuteOfDayIst: number) {
  return (
    dayIndex * MS_PER_DAY +
    (minuteOfDayIst - IST_OFFSET_MINUTES) * MS_PER_MINUTE
  );
}

/**
 * The most recent IBJA publication instant at or before `ms`.
 *
 * This is how the ingest decides WHICH publication it is looking at, because
 * ibjarates.com does not date its headline table (see the UNVERIFIED notes on
 * `parseIbjaRatesHtml`). Derived from our own clock, which we trust, rather
 * than from the page, which does not say.
 */
export function mostRecentPublicationAtOrBefore(ms: number): number | null {
  const { dayIndex, minuteOfDay } = istDayIndexAndMinute(ms);

  for (let back = 0; back <= 10; back += 1) {
    const day = dayIndex - back;
    if (!isBusinessDay(day)) continue;
    const cutoff = back === 0 ? minuteOfDay : 1440;
    for (let i = IBJA_SLOT_MINUTES_IST.length - 1; i >= 0; i -= 1) {
      const slot = IBJA_SLOT_MINUTES_IST[i];
      if (slot <= cutoff) return slotInstantMs(day, slot);
    }
  }

  return null;
}

/** Which of IBJA's two daily columns a publication instant belongs to. */
export function slotColumn(slotMs: number): "AM" | "PM" {
  const { minuteOfDay } = istDayIndexAndMinute(slotMs);
  return minuteOfDay < IBJA_SLOT_MINUTES_IST[1] ? "AM" : "PM";
}

/** The next publication instant strictly after `ms`, skipping weekends. */
export function nextPublicationAfter(ms: number): number | null {
  const { dayIndex, minuteOfDay } = istDayIndexAndMinute(ms);

  for (let forward = 0; forward <= 10; forward += 1) {
    const day = dayIndex + forward;
    if (!isBusinessDay(day)) continue;
    for (const slot of IBJA_SLOT_MINUTES_IST) {
      if (forward > 0 || slot > minuteOfDay) return slotInstantMs(day, slot);
    }
  }

  return null;
}

/** The instant a rate effective from `effectiveFromMs` stops being usable. */
export function rateExpiryMs(effectiveFromMs: number): number {
  const absoluteCeiling =
    effectiveFromMs + RATE_ABSOLUTE_MAX_AGE_MINUTES * MS_PER_MINUTE;
  const next = nextPublicationAfter(effectiveFromMs);
  if (next === null) return absoluteCeiling;
  return Math.min(next + RATE_STALE_GRACE_MINUTES * MS_PER_MINUTE, absoluteCeiling);
}

/**
 * Parse a timestamp the way this database actually writes them.
 *
 * `effective_from` is written by this module as a full ISO-8601 `...Z`, but
 * `created_at` defaults to SQLite's `CURRENT_TIMESTAMP`, which is
 * `YYYY-MM-DD HH:MM:SS` in UTC with no zone marker. Passing that straight to
 * `Date.parse` makes V8 read it as LOCAL time, which silently shifts a rate by
 * the server's offset and would quietly change what counts as stale.
 *
 * Returns null rather than NaN so the caller has to handle it.
 */
export function parseTimestampMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let normalised = trimmed.replace(" ", "T");
  if (!/([Zz]|[+-]\d{2}:?\d{2})$/.test(normalised)) normalised += "Z";

  const ms = Date.parse(normalised);
  return Number.isFinite(ms) ? ms : null;
}

/* ==========================================================================
 * 1. PURE — the typed lookup outcome
 * ======================================================================= */

/** One `gold_rates` row, as read back. Money is paise per TEN grams. */
export type RateRow = {
  readonly id: string;
  readonly metal: string;
  readonly fineness: number;
  readonly ratePerTenGramsPaise: number;
  readonly source: string;
  readonly sourceRef: string | null;
  readonly sourceQuoteRaw: string | null;
  readonly effectiveFrom: string;
};

/** A rate that MAY be priced against. Only ever produced by the `ok: true` arm. */
export type UsableRate = RateRow & {
  readonly expiresAt: string;
  readonly ageMinutes: number;
};

export type RateUnavailableReason =
  /** No rate has ever been recorded for this metal/fineness. */
  | "no_rate_recorded"
  /** A rate exists but the next IBJA publication came and went without one. */
  | "rate_stale"
  /** D1 is unreachable, or the table is missing. */
  | "rate_store_unavailable"
  /** A row exists but its own fields are not usable (bad timestamp, etc). */
  | "rate_unreadable";

/**
 * THE FAIL-CLOSED CONTRACT.
 *
 * A stale or missing rate is NOT a `null` and NOT a `0`. It is the `ok: false`
 * arm of a discriminated union, and that arm has no `rate` property at all —
 * so under `strict` TypeScript a caller that writes `lookup.rate` without
 * narrowing on `lookup.ok` does not compile. There is no shape here that reads
 * as "zero rupees" if it is ignored, because there is nothing to ignore.
 *
 * The unusable row is still returned for the admin screen, but under
 * `unusableRate` — deliberately not `rate` — so no pricing code path can pick
 * it up by autocomplete or by a careless rename.
 */
export type RateLookup =
  | { readonly ok: true; readonly rate: UsableRate }
  | {
      readonly ok: false;
      readonly reason: RateUnavailableReason;
      readonly message: string;
      readonly unusableRate?: RateRow & { readonly expiresAt: string | null };
    };

/** Thrown by `unwrapRate`. Carries the machine reason for the caller's logs. */
export class RateUnavailableError extends Error {
  readonly reason: RateUnavailableReason;

  constructor(reason: RateUnavailableReason, message: string) {
    super(message);
    this.name = "RateUnavailableError";
    this.reason = reason;
  }
}

/**
 * For call sites that genuinely cannot proceed without a rate (the price
 * engine, the quote writer). Throws rather than returning a falsy number, so
 * the worst case is a 5xx and a log line — never an order priced at zero.
 */
export function unwrapRate(lookup: RateLookup): UsableRate {
  if (lookup.ok) return lookup.rate;
  throw new RateUnavailableError(lookup.reason, lookup.message);
}

const STALE_MESSAGE =
  "The gold rate we hold is older than IBJA's latest publication, so we cannot quote a price right now. Please call or WhatsApp the shop and we will confirm today's rate.";

/** Classify a row against the clock. Pure: no I/O, no ambient `Date.now()`. */
export function classifyRate(row: RateRow, nowMs: number): RateLookup {
  const effectiveFromMs = parseTimestampMs(row.effectiveFrom);

  if (effectiveFromMs === null) {
    return {
      ok: false,
      reason: "rate_unreadable",
      message: `Rate ${row.id} has an unparseable effective_from (${row.effectiveFrom}).`,
      unusableRate: { ...row, expiresAt: null },
    };
  }

  if (!Number.isSafeInteger(row.ratePerTenGramsPaise) || row.ratePerTenGramsPaise <= 0) {
    return {
      ok: false,
      reason: "rate_unreadable",
      message: `Rate ${row.id} does not hold a positive integer paise figure.`,
      unusableRate: { ...row, expiresAt: null },
    };
  }

  const expiresAtMs = rateExpiryMs(effectiveFromMs);
  const expiresAt = new Date(expiresAtMs).toISOString();
  const ageMinutes = Math.floor((nowMs - effectiveFromMs) / MS_PER_MINUTE);

  if (nowMs >= expiresAtMs) {
    return {
      ok: false,
      reason: "rate_stale",
      message: STALE_MESSAGE,
      unusableRate: { ...row, expiresAt },
    };
  }

  return { ok: true, rate: { ...row, expiresAt, ageMinutes } };
}

/* ==========================================================================
 * 1. PURE — the IBJA HTML parser
 * ======================================================================= */

/** One converted, ingestible observation. */
export type RateQuote = {
  readonly metal: IngestibleMetal;
  readonly fineness: number;
  readonly ratePerTenGramsPaise: number;
  /** The figure exactly as published. The audit anchor. Never derived back. */
  readonly sourceQuoteRaw: string;
};

/** A row we read but refuse to convert. See `IBJA_UNCONVERTIBLE_ROWS`. */
export type UnconvertedObservation = {
  readonly label: string;
  readonly sourceQuoteRaw: string;
  readonly reason: string;
};

export type IbjaParseResult =
  | {
      readonly ok: true;
      readonly column: "AM" | "PM";
      readonly quotes: readonly RateQuote[];
      readonly unconverted: readonly UnconvertedObservation[];
      /**
       * Newest date in IBJA's "Previous Dates Rate" archive, `DD/MM/YYYY` as
       * printed. The ONLY date the page publishes. Operator signal only — see
       * UNVERIFIED (2).
       */
      readonly archiveLatestDate: string | null;
    }
  | {
      readonly ok: false;
      readonly reason: "markup_changed" | "unparseable_figure";
      readonly message: string;
      readonly missing: readonly string[];
    };

/**
 * Read one publication column out of ibjarates.com's headline table.
 *
 * VERIFIED against the live page on 2026-08-08 (fetched 03:17 IST). The table
 * is server-rendered ASP.NET WebForms, id `TodayRatesTableDataYes`, and each
 * cell is a span with a stable id:
 *
 *   <span id="lblGold999_AM">149020</span>   <span id="lblGold999_PM">149621</span>
 *   <span id="lblGold916_AM">136502</span>   <span id="lblGold916_PM">137053</span>
 *   <span id="lblSilver999_AM">229950</span> <span id="lblPlatinum999_PM">62707</span>
 *
 * The unit is confirmed on the page itself, in the footer: "*Gold rates per
 * 10gm & Silver rate per 1kg" and "*The above rates are without 3% GST and
 * Making Charges". The per-gram carousel above the table (`GoldRatesCompare999`
 * = 14962 against `lblGold999_PM` = 149621) reconciles to the same number and
 * is what proves the per-10-g reading rather than assuming it.
 *
 * ---------------------------------------------------------------------------
 * UNVERIFIED — exactly what still needs checking against the real feed
 * ---------------------------------------------------------------------------
 * Only ONE snapshot of the live page was observed (2026-08-08 03:17 IST, a
 * Saturday, showing Friday 2026-08-07's AM and PM figures). Everything below
 * is inference from that single sample and must be confirmed by watching the
 * page across a publication boundary before this parser is trusted unattended:
 *
 *  1. UNVERIFIED: that the headline AM/PM columns always correspond to the
 *     most recent publication slot derived from the clock. It held for the one
 *     sample. Check specifically at ~12:10 and ~17:10 IST on a business day.
 *  2. UNVERIFIED: THE HEADLINE TABLE CARRIES NO DATE. Nothing in the markup
 *     says which day those figures are for — the only visible date is the
 *     client-side `#clockbox`, which is the *viewer's* clock, not the rate's.
 *     `effective_from` is therefore derived from our own clock via
 *     `mostRecentPublicationAtOrBefore()`, never from the page.
 *     `archiveLatestDate` is returned so an operator can sanity-check that the
 *     derived day is one step ahead of the newest archived day; it is NOT
 *     gated on, because the relationship was only observed once.
 *  3. UNVERIFIED: how an unpublished slot renders. In the sample both columns
 *     were populated (with the previous business day's figures). Whether a
 *     not-yet-published slot renders empty, as 0, or as the previous value is
 *     unknown. The parser refuses an empty or non-numeric cell outright rather
 *     than guessing.
 *  4. UNVERIFIED: the table id is `TodayRatesTableDataYes`, which strongly
 *     implies a `...No` sibling with different markup on a day with no data.
 *     That variant was never seen. If it appears, every `lbl*` id will be
 *     missing and this returns `markup_changed` — which is the safe outcome,
 *     but the message will be less specific than it could be.
 *  5. UNVERIFIED: whether IBJA ever publishes a fractional figure. Every value
 *     observed (headline table and 30-day archive) is a whole-rupee integer.
 *     The half-up rounding path in `rupeesToPaise` is therefore exercised only
 *     by tests, never yet by the real feed.
 *  6. UNVERIFIED: the platinum unit, which the page never states. Not
 *     ingested. See `IBJA_UNCONVERTIBLE_ROWS`.
 *
 * PARTIAL PARSES ARE REFUSED. If any one of the five gold finenesses is
 * missing or non-numeric the whole result fails; a four-of-five ingest would
 * leave one fineness silently pinned to yesterday's rate.
 */
export function parseIbjaRatesHtml(html: string, column: "AM" | "PM"): IbjaParseResult {
  if (typeof html !== "string" || html.length === 0) {
    return {
      ok: false,
      reason: "markup_changed",
      message: "IBJA returned an empty document.",
      missing: [],
    };
  }

  const readCell = (label: string): string | null => {
    const pattern = new RegExp(
      `id=["']lbl${label}_${column}["'][^>]*>([^<]*)<`,
      "i"
    );
    const match = pattern.exec(html);
    if (!match) return null;
    const text = match[1].trim();
    return text.length > 0 ? text : null;
  };

  const missing: string[] = [];
  const unparseable: string[] = [];
  const quotes: RateQuote[] = [];

  for (const fineness of IBJA_GOLD_FINENESS) {
    const label = `Gold${fineness}`;
    const raw = readCell(label);
    if (raw === null) {
      missing.push(`${label}_${column}`);
      continue;
    }
    const paise = goldQuoteToPaisePerTenGrams(raw);
    if (paise === null) {
      unparseable.push(`${label}_${column}=${raw}`);
      continue;
    }
    quotes.push({
      metal: "gold",
      fineness,
      ratePerTenGramsPaise: paise,
      sourceQuoteRaw: raw,
    });
  }

  if (missing.length > 0) {
    return {
      ok: false,
      reason: "markup_changed",
      message:
        "IBJA's rate table no longer matches the markup this parser was written against. Refusing to ingest a partial set of gold rates.",
      missing,
    };
  }

  if (unparseable.length > 0) {
    return {
      ok: false,
      reason: "unparseable_figure",
      message:
        "IBJA published a gold figure that is not a rupee amount. Refusing to guess.",
      missing: unparseable,
    };
  }

  // Silver is optional: gold is what this storefront prices against, and a
  // missing silver row must not block a gold ingest.
  const silverRaw = readCell(`Silver${IBJA_SILVER_FINENESS}`);
  const unconverted: UnconvertedObservation[] = [];

  if (silverRaw !== null) {
    const silverPaise = silverQuoteToPaisePerTenGrams(silverRaw);
    if (silverPaise === null) {
      unconverted.push({
        label: `Silver${IBJA_SILVER_FINENESS}`,
        sourceQuoteRaw: silverRaw,
        reason: "Not a rupee figure.",
      });
    } else {
      quotes.push({
        metal: "silver",
        fineness: IBJA_SILVER_FINENESS,
        ratePerTenGramsPaise: silverPaise,
        sourceQuoteRaw: silverRaw,
      });
    }
  }

  for (const label of IBJA_UNCONVERTIBLE_ROWS) {
    const raw = readCell(label);
    if (raw === null) continue;
    unconverted.push({
      label,
      sourceQuoteRaw: raw,
      reason:
        "IBJA does not publish the unit for this metal, so converting it would be a guess. Not ingested.",
    });
  }

  const archiveMatch = /data-label=["'](?:AM|PM)["'][^>]*>\s*<strong>\s*(\d{2}\/\d{2}\/\d{4})\s*<\/strong>/i.exec(
    html
  );

  return {
    ok: true,
    column,
    quotes,
    unconverted,
    archiveLatestDate: archiveMatch ? archiveMatch[1] : null,
  };
}

/* ==========================================================================
 * 2. NETWORK — kept to one function, and injectable
 * ======================================================================= */

export type IbjaFetchResult =
  | { readonly ok: true; readonly html: string; readonly fetchedAt: string }
  | { readonly ok: false; readonly message: string };

/**
 * The only function here that talks to the internet. Deliberately does nothing
 * else: no parsing, no writing, no clock decisions. `fetchImpl` is injectable
 * so every test in this repo runs offline.
 */
export async function fetchIbjaRatesHtml(
  fetchImpl: typeof fetch = fetch
): Promise<IbjaFetchResult> {
  try {
    const response = await fetchImpl(IBJA_RATES_URL, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        // ibjarates.com serves a plain HTML page; a UA is sent only so the
        // request is attributable rather than anonymous.
        "user-agent": "alankar-jewellers-rate-ingest/1.0 (+https://ibjarates.com)",
      },
    });

    if (!response.ok) {
      return {
        ok: false,
        message: `IBJA responded ${response.status} ${response.statusText}.`,
      };
    }

    return {
      ok: true,
      html: await response.text(),
      fetchedAt: new Date().toISOString(),
    };
  } catch (error) {
    return {
      ok: false,
      message: `Could not reach IBJA: ${
        error instanceof Error ? error.message : "unknown network error"
      }`,
    };
  }
}

/** `sourceRef` for one publication slot. The idempotency key for ingestion. */
export function publicationSlotRef(slotMs: number): string {
  return `ibja:${new Date(slotMs).toISOString()}`;
}

export type IbjaReading = {
  readonly slotMs: number;
  readonly slotRef: string;
  readonly effectiveFrom: string;
  readonly column: "AM" | "PM";
  readonly quotes: readonly RateQuote[];
  readonly unconverted: readonly UnconvertedObservation[];
  readonly archiveLatestDate: string | null;
};

export type IbjaReadResult =
  | { readonly ok: true; readonly reading: IbjaReading }
  | { readonly ok: false; readonly message: string; readonly detail?: readonly string[] };

/**
 * Fetch + parse, with the publication slot derived from `nowMs` rather than
 * from the page (which does not date its headline table — UNVERIFIED (2)).
 */
export async function readIbjaRates(
  nowMs: number = Date.now(),
  fetchImpl: typeof fetch = fetch
): Promise<IbjaReadResult> {
  const slotMs = mostRecentPublicationAtOrBefore(nowMs);
  if (slotMs === null) {
    return { ok: false, message: "Could not derive an IBJA publication slot." };
  }

  const fetched = await fetchIbjaRatesHtml(fetchImpl);
  if (!fetched.ok) return { ok: false, message: fetched.message };

  const column = slotColumn(slotMs);
  const parsed = parseIbjaRatesHtml(fetched.html, column);
  if (!parsed.ok) {
    return { ok: false, message: parsed.message, detail: parsed.missing };
  }

  return {
    ok: true,
    reading: {
      slotMs,
      slotRef: publicationSlotRef(slotMs),
      effectiveFrom: new Date(slotMs).toISOString(),
      column,
      quotes: parsed.quotes,
      unconverted: parsed.unconverted,
      archiveLatestDate: parsed.archiveLatestDate,
    },
  };
}

/* ==========================================================================
 * 3. DATABASE — insert-only, one batch
 * ======================================================================= */

const MISSING_TABLE_HINT =
  "The gold_rates table is unavailable. Generate the migration locally with `npm run db:generate`, then deploy so the platform can apply the generated SQL to the real D1 database.";

function describeDbError(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
  const combined = `${message}\n${cause}`;
  if (combined.includes("no such table") || combined.includes("gold_rates")) {
    return MISSING_TABLE_HINT;
  }
  return message;
}

const RATE_COLUMNS = {
  id: goldRates.id,
  metal: goldRates.metal,
  fineness: goldRates.fineness,
  ratePerTenGramsPaise: goldRates.ratePerTenGramsPaise,
  source: goldRates.source,
  sourceRef: goldRates.sourceRef,
  sourceQuoteRaw: goldRates.sourceQuoteRaw,
  effectiveFrom: goldRates.effectiveFrom,
};

/**
 * The current rate for one metal/fineness, classified.
 *
 * Returns `RateLookup`, never a bare row and never null. Every failure mode —
 * no row, stale row, D1 down, corrupt row — lands on the `ok: false` arm, so
 * the storefront cannot accidentally price against an unknown rate.
 */
export async function readCurrentRate(
  metal: string,
  fineness: number,
  nowMs: number = Date.now()
): Promise<RateLookup> {
  let rows: RateRow[];

  try {
    const db = getDb();
    rows = (await db
      .select(RATE_COLUMNS)
      .from(goldRates)
      .where(
        and(
          eq(goldRates.metal, metal as "gold" | "silver" | "platinum"),
          eq(goldRates.fineness, fineness),
          isNull(goldRates.effectiveTo)
        )
      )
      .limit(1)) as RateRow[];
  } catch (error) {
    console.error("[gold-rate] rate store unavailable:", error);
    return {
      ok: false,
      reason: "rate_store_unavailable",
      message: describeDbError(error),
    };
  }

  const row = rows[0];
  if (!row) {
    return {
      ok: false,
      reason: "no_rate_recorded",
      message: `No ${metal} rate has been recorded for fineness ${fineness}. Ingest one from IBJA before quoting a price.`,
    };
  }

  return classifyRate(row, nowMs);
}

export type IngestMeta = {
  /** `ibja` for the scraper, `manual` for owner entry from ibjarates.com. */
  readonly source: "ibja" | "manual";
  /** Idempotency key. One publication slot -> one ref -> at most one row. */
  readonly sourceRef: string;
  /** ISO-8601 UTC. The publication instant, not the ingest instant. */
  readonly effectiveFrom: string;
  readonly createdBy?: string | null;
};

export type IngestOutcome = {
  readonly metal: string;
  readonly fineness: number;
  readonly action: "inserted" | "skipped_duplicate_slot" | "skipped_not_newer";
  readonly ratePerTenGramsPaise: number;
  readonly sourceQuoteRaw: string;
};

export type IngestResult =
  | { readonly ok: true; readonly inserted: number; readonly outcomes: readonly IngestOutcome[] }
  | { readonly ok: false; readonly message: string };

/**
 * Write a publication into the audit trail.
 *
 * ---------------------------------------------------------------------------
 * INSERT-ONLY, AND WHAT THE ONE UPDATE ACTUALLY IS
 * ---------------------------------------------------------------------------
 * No rate value is ever overwritten and no row is ever deleted. Every figure
 * this shop has ever quoted from stays readable forever, which is what lets an
 * invoice reprinted in 2031 reconstruct to the paise (BIS Reg. 5(13) keeps
 * those records five years or until sold, whichever is longer).
 *
 * The single UPDATE below writes `effective_to` on the outgoing row and
 * NOTHING else — not the rate, not the source, not the raw quote. It is the
 * interval terminator, not a mutation of the observation: it is what turns
 * "this is the current rate" into "this was the rate from X to Y". It is also
 * not optional. `gold_rates_current_idx` is a partial unique index on
 * `(metal, fineness) WHERE effective_to IS NULL`, so SQLite itself refuses a
 * second open row — an insert without the close would be rejected, which is
 * exactly the "two rates active, which one did we charge?" bug being designed
 * out.
 *
 * ---------------------------------------------------------------------------
 * ONE BATCH, BECAUSE D1 HAS NO INTERACTIVE TRANSACTIONS
 * ---------------------------------------------------------------------------
 * Per `db/schema.ts`'s header: `drizzle.transaction()` throws on D1, and
 * `db.batch([...])` is the only atomicity primitive — one batch is one
 * transaction. Every close and every insert for this publication goes in ONE
 * batch, so the trail can never end up with a closed row and no replacement
 * (which would leave that fineness unpriceable) or an open row that was never
 * closed (which the unique index would reject halfway through).
 *
 * The 100-bound-parameter cap is respected by construction: one statement per
 * quote pair, never a multi-row VALUES. Six gold+silver quotes is 12
 * statements of ~10 parameters each.
 *
 * IDEMPOTENCY: `sourceRef` identifies the publication slot. Re-running the
 * cron for a slot already ingested is a no-op, so a retry cannot inflate the
 * trail or artificially refresh `effective_from` (which would make a stale
 * rate look fresh — the exact failure this task exists to prevent).
 *
 * OUT-OF-ORDER: a quote whose `effectiveFrom` is not strictly newer than the
 * open row's is skipped, so replaying an old slot cannot close a newer row
 * with an older timestamp.
 */
export async function ingestRateQuotes(
  quotes: readonly RateQuote[],
  meta: IngestMeta
): Promise<IngestResult> {
  if (quotes.length === 0) {
    return { ok: false, message: "No rate quotes to ingest." };
  }

  const effectiveFromMs = parseTimestampMs(meta.effectiveFrom);
  if (effectiveFromMs === null) {
    return { ok: false, message: `\`effectiveFrom\` is not a timestamp: ${meta.effectiveFrom}` };
  }

  try {
    const db = getDb();

    const openRows = (await db
      .select(RATE_COLUMNS)
      .from(goldRates)
      .where(isNull(goldRates.effectiveTo))) as RateRow[];

    const openByKey = new Map(
      openRows.map((row) => [`${row.metal}:${row.fineness}`, row])
    );

    const outcomes: IngestOutcome[] = [];
    const statements = [];

    for (const quote of quotes) {
      const key = `${quote.metal}:${quote.fineness}`;
      const open = openByKey.get(key);

      if (open && open.sourceRef === meta.sourceRef) {
        outcomes.push({
          metal: quote.metal,
          fineness: quote.fineness,
          action: "skipped_duplicate_slot",
          ratePerTenGramsPaise: quote.ratePerTenGramsPaise,
          sourceQuoteRaw: quote.sourceQuoteRaw,
        });
        continue;
      }

      if (open) {
        const openFromMs = parseTimestampMs(open.effectiveFrom);
        if (openFromMs !== null && openFromMs >= effectiveFromMs) {
          outcomes.push({
            metal: quote.metal,
            fineness: quote.fineness,
            action: "skipped_not_newer",
            ratePerTenGramsPaise: quote.ratePerTenGramsPaise,
            sourceQuoteRaw: quote.sourceQuoteRaw,
          });
          continue;
        }

        // Terminates the interval. Touches `effective_to` and nothing else.
        statements.push(
          db
            .update(goldRates)
            .set({ effectiveTo: meta.effectiveFrom })
            .where(
              and(
                eq(goldRates.metal, quote.metal),
                eq(goldRates.fineness, quote.fineness),
                isNull(goldRates.effectiveTo)
              )
            )
        );
      }

      statements.push(
        db.insert(goldRates).values({
          id: crypto.randomUUID(),
          metal: quote.metal,
          fineness: quote.fineness,
          ratePerTenGramsPaise: quote.ratePerTenGramsPaise,
          source: meta.source,
          sourceRef: meta.sourceRef,
          sourceQuoteRaw: quote.sourceQuoteRaw,
          effectiveFrom: meta.effectiveFrom,
          effectiveTo: null,
          createdBy: meta.createdBy ?? null,
        })
      );

      outcomes.push({
        metal: quote.metal,
        fineness: quote.fineness,
        action: "inserted",
        ratePerTenGramsPaise: quote.ratePerTenGramsPaise,
        sourceQuoteRaw: quote.sourceQuoteRaw,
      });
    }

    if (statements.length > 0) {
      type Statement = (typeof statements)[number];
      await db.batch(statements as [Statement, ...Statement[]]);
    }

    return {
      ok: true,
      inserted: outcomes.filter((outcome) => outcome.action === "inserted").length,
      outcomes,
    };
  } catch (error) {
    console.error("[gold-rate] ingest failed:", error);
    return { ok: false, message: describeDbError(error) };
  }
}
