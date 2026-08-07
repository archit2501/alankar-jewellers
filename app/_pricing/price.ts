/**
 * THE PRICE ENGINE.
 *
 * Pure functions. No I/O, no clock, no database, no gold-rate lookup — the
 * prevailing rate is an argument, never an import, so the engine is
 * independently testable and a caller cannot accidentally price against a rate
 * it did not consciously read.
 *
 * ---------------------------------------------------------------------------
 * WHAT INDIAN JEWELLERY PRICING IS
 * ---------------------------------------------------------------------------
 *
 *   metal value   = gold rate x net metal weight
 *   making charge = % of metal value, or paise per gram, or a flat amount
 *   stone value   = per the piece
 *   hallmarking   = per article, its own line
 *   other charges = per the piece (certification, packaging)
 *   ------------------------------------------------------------------
 *   unit price      (per article)
 *   line subtotal = unit price x quantity - line discount
 *   GST           = 3% of the TOTAL TRANSACTION VALUE
 *   ------------------------------------------------------------------
 *   line total
 *
 * ---------------------------------------------------------------------------
 * GST IS A SINGLE 3% ON THE TOTAL TRANSACTION VALUE. IT IS NOT A 3%/5% SPLIT.
 * ---------------------------------------------------------------------------
 *
 * Someone will eventually read the itemised breakup below, notice that making
 * charges are shown separately, and try to "fix" this into 3% on metal and 5%
 * on making. That is wrong, and it is wrong on the authority of the tax
 * department's own FAQ.
 *
 * CBIC DGTS Sectoral FAQ (Gems & Jewellery), Q7, verbatim: "GST is payable at
 * the rate of 3% of the total transaction value of jewellery, whether the
 * making charge is shown separately or not." Finished jewellery is a composite
 * supply with gold as the principal supply (HSN 7113, 3%). Showing the
 * breakup — which BIS (Hallmarking) Regulations 2018 Reg. 5(11) and Consumer
 * Protection (E-Commerce) Rules 2020 Rule 7(1)(e) between them largely
 * REQUIRE — does not split the rate.
 *
 * The 5% figure someone will cite is job work (Heading 9988): a customer
 * bringing their own gold, or a karigar invoicing the shop. Different
 * transaction, not this one. The same reasoning is recorded on
 * `priceQuotes.gstRateBps` in `db/schema.ts`; it is repeated here because this
 * is the file where the mistake would actually be made.
 *
 * ---------------------------------------------------------------------------
 * HALLMARKING IS ITS OWN LINE, ALWAYS
 * ---------------------------------------------------------------------------
 *
 * BIS Reg. 5(11): the invoice "shall indicate separately description of each
 * article, net weight of precious metal, purity in carat and fineness, and
 * hallmarking charges". So `hallmarkingPaise` is never folded into the making
 * charge, and it travels as its own component through quote, order and invoice.
 *
 * The converse also holds and matters more here than at most shops: QCO
 * cl. 2(3) exempts Kundan, Polki and Jadau — this house's flagship categories —
 * from mandatory hallmarking. A hallmarking charge of 0 therefore emits NO
 * component at all, rather than a "Hallmarking  0.00" line that would imply the
 * piece was hallmarked and the charge waived.
 *
 * ---------------------------------------------------------------------------
 * UNITS (identical to `db/schema.ts`; the names carry the unit)
 * ---------------------------------------------------------------------------
 *
 *   money        integer paise          `...Paise`
 *   weight       integer milligrams     `...Mg`
 *   percentages  integer basis points   `...Bps`      (3% = 300)
 *   metal rate   paise per TEN grams    `ratePerTenGramsPaise`
 *   purity       millesimal fineness    999 / 995 / 916 / 750 / 585
 *
 * ---------------------------------------------------------------------------
 * NO FLOATS. ANYWHERE. NOT EVEN TRANSIENTLY.
 * ---------------------------------------------------------------------------
 *
 * A JavaScript `number` is an IEEE-754 double. Integer arithmetic in it is
 * exact only while every intermediate stays under 2^53, and `a / b` is a
 * floating-point operation whose result may not be the true quotient. A GST
 * figure computed that way produces an invoice that does not foot, and a GST
 * invoice is a statutory document.
 *
 * So every multiplication and every division in this file is done in `bigint`,
 * which is exact and unbounded. `number` is used only at the API boundary, to
 * carry values that have already been proved to be safe integers by
 * `toPaise()`. The sums are done in `bigint` too (`sumPaise`), so there is no
 * point in the money path at which a float exists.
 *
 * ---------------------------------------------------------------------------
 * WHERE ROUNDING HAPPENS. EVERY DECISION, STATED ONCE.
 * ---------------------------------------------------------------------------
 *
 * research/02-market-tech.md Sec. 9.1: "Compute in paise, round once, at a
 * defined level". The defined level here is THE ARTICLE (one unit of one
 * line) — because `order_items.unit_price_paise` is what the invoice prints,
 * and `CHECK (line_subtotal_paise = unit_price_paise * quantity - ...)` means
 * the article price must be a whole number of paise before quantity is applied.
 *
 *  1. METAL VALUE — rounded, half up, exactly once, per article:
 *
 *         metalValuePaise = roundHalfUp(ratePerTenGramsPaise * netMetalWeightMg / 10000)
 *
 *     (10 g = 10,000 mg.) The rate is NEVER pre-divided into a per-gram figure:
 *     that discards up to 0.9 paise per gram and the error grows with weight.
 *     This is the rule written on `goldRates` in `db/schema.ts`, implemented
 *     here and nowhere else.
 *
 *  2. MAKING CHARGE — rounded, half up, exactly once, per article:
 *       - `percent`  roundHalfUp(metalValuePaise * bps / 10000)
 *       - `per_gram` roundHalfUp(paisePerGram * netMetalWeightMg / 1000)
 *       - `flat`     already an integer; no rounding occurs
 *
 *     `percent` is deliberately taken on the ALREADY-ROUNDED metal value, not
 *     on the unrounded product. The printed metal line is then literally the
 *     base of the printed making line, so a customer or an auditor can
 *     reproduce the invoice's arithmetic from the invoice itself. The
 *     alternative (percent of the unrounded product) differs by at most one
 *     paise and cannot be reproduced from the document.
 *
 *     `percent` is a percentage of METAL VALUE ONLY — stones are not in the
 *     base. If the shop ever charges a percentage of metal-plus-stone that must
 *     arrive as a NEW making-charge type, never as a quiet change here.
 *
 *  3. STONE / HALLMARKING / OTHER — integer inputs. Never rounded, never
 *     divided, never scaled by weight.
 *
 *  4. UNIT PRICE — an exact integer sum of (1)(2)(3). No rounding.
 *
 *  5. QUANTITY — applied AFTER the per-article rounding:
 *     `lineSubtotalPaise = unitPricePaise * quantity - lineDiscountPaise`.
 *     Exact integer arithmetic; no rounding.
 *
 *  6. GST — rounded, half up, exactly once PER LINE, on that line's subtotal:
 *
 *         lineGstPaise = roundHalfUp(lineSubtotalPaise * gstRateBps / 10000)
 *
 *     and the order-level `gstPaise` is the SUM of the per-line figures (plus
 *     the shipping figure, see 7). Rounding per line and summing — rather than
 *     rounding once on the order total — is what makes the printed lines add up
 *     to the printed total exactly. It is also what `order_items` in
 *     `db/schema.ts` documents, and its CHECK constraints require.
 *
 *  7. SHIPPING — its own rounding group at the order level, because it belongs
 *     to no line: `roundHalfUp(shippingPaise * gstRateBps / 10000)`. Taxed at
 *     the same 3% as the principal supply, for the same composite-supply
 *     reason. Order GST = sum(line GST) + shipping GST, so the order total is
 *     still an exact sum of figures that were each rounded exactly once.
 *
 *  8. THE CGST/SGST SPLIT — `splitGst()`: `cgst = floor(gst / 2)` and
 *     `sgst = gst - cgst`, so an odd number of paise reconciles exactly and
 *     `CHECK (gst_paise = cgst_paise + sgst_paise + igst_paise)` holds.
 *
 * Half-up is unambiguous here because every value that is divided is
 * non-negative — validated on the way in. Discounts are subtracted as whole
 * integers and are never a divisor or a dividend, so no negative rounding case
 * exists.
 *
 * ---------------------------------------------------------------------------
 * THE COMPONENTS FOOT. THIS IS GUARANTEED, NOT INTENDED.
 * ---------------------------------------------------------------------------
 *
 * `db/schema.ts` carries footing CHECK constraints — `unit_price_paise =
 * metal + making + stone + hallmarking + other`, `line_total_paise =
 * line_subtotal_paise + line_gst_paise`, and the equivalents on `price_quotes`
 * and `orders`. A breakup that does not sum to its total is literally
 * unstorable, and under E-Commerce Rule 7(1)(e) it is a compliance defect
 * rather than a cosmetic one.
 *
 * Three mechanisms, in order of strength:
 *
 *   (a) The renderable `components[]` array is BUILT FROM the same integer
 *       fields that produce the totals. There is no second computation to
 *       drift from the first.
 *   (b) `assertFoots()` runs on every single call and re-checks the sums
 *       against the totals, in bigint. Any future edit that breaks footing
 *       throws here rather than at the D1 CHECK constraint, or worse, on a
 *       customer's invoice.
 *   (c) The return type makes a total unobtainable without its breakup. There
 *       is no exported function anywhere in this module that returns a bare
 *       total, and `components` is typed as a non-empty tuple, so the type
 *       system itself guarantees a breakup accompanies every figure.
 */

/* -------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------- */

/**
 * 3%, in basis points. One rate, on the whole taxable value. See the header.
 * Callers may pass a different value ONLY because a snapshot must record the
 * rate that actually applied and a statutory change must be expressible — not
 * because different components take different rates.
 */
export const GST_RATE_BPS = 300;

/** BIS published per-article hallmarking charge for gold (Jan 2024, cl. 3.3.5). */
export const BIS_HALLMARKING_GOLD_PAISE = 4500;

/** BIS published per-article hallmarking charge for silver. */
export const BIS_HALLMARKING_SILVER_PAISE = 3500;

/** Milligrams in ten grams — the divisor for `ratePerTenGramsPaise`. */
const MG_PER_TEN_GRAMS = 10000;

/** Milligrams in one gram — the divisor for a `per_gram` making charge. */
const MG_PER_GRAM = 1000;

/** Basis points in 100% — the divisor for every `...Bps` figure. */
const BPS_DIVISOR = 10000;

const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Gold fineness values that have an exact, conventional karat name.
 *
 * This is a LOOKUP TABLE and not a rounding rule, on purpose. `carat =
 * fineness * 24 / 1000` gives 995 -> 23.88, which rounds to 24K and is a lie:
 * 995 is 0.4% less gold than 999 and mis-prices every 995 article, invisibly,
 * forever. A fineness not in this table has no karat name and is presented as
 * fineness alone. That is exactly the case the old karat enum collapsed.
 */
const GOLD_KARAT_BY_FINENESS: Readonly<Record<number, string>> = {
  999: "24K",
  958: "23K",
  916: "22K",
  833: "20K",
  750: "18K",
  585: "14K",
  375: "9K",
};

const METAL_NOUN: Readonly<Record<PriceableMetal, string>> = {
  gold: "Gold",
  silver: "Silver",
  platinum: "Platinum",
};

/* -------------------------------------------------------------------------
 * Errors
 * ---------------------------------------------------------------------- */

export type PriceEngineErrorCode =
  /** An input was absent, negative, fractional, or otherwise unusable. */
  | "invalid_input"
  /** The rate supplied is not the rate for this article's metal or fineness. */
  | "rate_mismatch"
  /** `pricing_mode = 'on_request'`: there is no price to compute. */
  | "not_priceable"
  /** An internal invariant broke: the breakup does not sum to the total. */
  | "does_not_foot"
  /** A figure exceeded the exactly-representable integer range. */
  | "overflow";

/** Every failure in this module is one of these. Nothing here returns NaN. */
export class PriceEngineError extends Error {
  readonly code: PriceEngineErrorCode;

  constructor(code: PriceEngineErrorCode, message: string) {
    super(message);
    this.name = "PriceEngineError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------
 * Public types
 * ---------------------------------------------------------------------- */

/** Metals that can carry a published rate. `variants.metal` also allows "none". */
export type PriceableMetal = "gold" | "silver" | "platinum";

/**
 * The prevailing rate for one (metal, fineness), as published.
 *
 * Structurally compatible with a `gold_rates` row, so the rate module's row can
 * be handed straight in. Only these three fields are read; anything else on the
 * row (id, `effectiveFrom`, `sourceQuoteRaw`) is the caller's to snapshot.
 */
export interface MetalRate {
  readonly metal: PriceableMetal;
  /** Millesimal fineness as published: 999 / 995 / 916 / 750 / 585. */
  readonly fineness: number;
  /** Paise per TEN grams. Not per gram. See `goldRates` in `db/schema.ts`. */
  readonly ratePerTenGramsPaise: number;
}

/**
 * Making charge, in the three forms the market actually uses.
 * Mirrors `variants.makingChargeType` / `variants.makingChargeValue` exactly.
 */
export type MakingCharge =
  /** `value` is basis points of the metal value. 12% is 1200. */
  | { readonly type: "percent"; readonly value: number }
  /** `value` is paise per gram of net metal weight. */
  | { readonly type: "per_gram"; readonly value: number }
  /** `value` is a flat number of paise for the article. */
  | { readonly type: "flat"; readonly value: number };

/** Charges that apply identically however the piece is priced. */
interface CommonLineInput {
  /** Articles on this line. 1 for a one-of-a-kind piece, which is the norm. */
  readonly quantity?: number;
  /**
   * Its own line, per BIS Reg. 5(11). Per ARTICLE, not per line. Pass 0 — and
   * it is the default — for Kundan / Polki / Jadau, which QCO cl. 2(3) exempts:
   * a 0 emits no component rather than a zero-value one.
   */
  readonly hallmarkingPaise?: number;
  /** Certification, packaging, engraving. Per article. */
  readonly otherChargesPaise?: number;
  /**
   * Discount for the whole line, in paise, as a positive number. Modelled at
   * line level (and rendered as a negative component) rather than as an
   * order-level field, so the breakup always sums to the total.
   */
  readonly lineDiscountPaise?: number;
  /** Defaults to `GST_RATE_BPS`. See the header before changing it. */
  readonly gstRateBps?: number;
}

/** A piece priced from the prevailing metal rate. The normal case. */
export interface DynamicMetalLineInput extends CommonLineInput {
  readonly pricingMode: "dynamic_metal";
  /** The prevailing rate. Must match this article's metal AND fineness. */
  readonly rate: MetalRate;
  readonly metal: PriceableMetal;
  /** Millesimal fineness of the article itself. Checked against `rate`. */
  readonly fineness: number;
  /** Metal only, stones excluded. This is what the rate multiplies. */
  readonly netMetalWeightMg: number;
  readonly makingCharge?: MakingCharge;
  /** Value of the stones in the piece, per article. */
  readonly stoneValuePaise?: number;
}

/**
 * A piece quoted flat — antique, Polki, Jadau. `fixedPricePaise` is the whole
 * piece EXCLUDING hallmarking (which must stay a separate line) and EXCLUDING
 * GST. It is carried as `otherChargesPaise` in the snapshot, because that is
 * the only `order_items` column that can hold an undecomposed price and still
 * satisfy the unit-price footing CHECK.
 */
export interface FixedLineInput extends CommonLineInput {
  readonly pricingMode: "fixed";
  readonly fixedPricePaise: number;
  readonly metal?: PriceableMetal;
  readonly fineness?: number;
}

/** `pricing_mode = 'on_request'`. Priceable by a human, not by this module. */
export interface OnRequestLineInput {
  readonly pricingMode: "on_request";
}

export type PriceLineInput =
  | DynamicMetalLineInput
  | FixedLineInput
  | OnRequestLineInput;

/** The keys a renderer can switch on. Stable; the labels are not. */
export type PriceComponentKey =
  | "metal"
  | "making"
  | "stone"
  | "hallmarking"
  | "other"
  | "discount"
  | "shipping"
  | "gst";

/**
 * How a component was arrived at, so a renderer can print "Rate x Weight =
 * Value" the way every competitor's breakup does, without recomputing anything.
 * All figures are PER ARTICLE; multiply by `PricedLine.quantity` for the line.
 */
export type PriceComponentBasis =
  | {
      readonly kind: "metal_rate";
      readonly ratePerTenGramsPaise: number;
      readonly netMetalWeightMg: number;
      readonly fineness: number;
    }
  | {
      readonly kind: "per_gram";
      readonly ratePerGramPaise: number;
      readonly netMetalWeightMg: number;
    }
  | { readonly kind: "percent"; readonly rateBps: number; readonly ofPaise: number }
  | { readonly kind: "flat" }
  | { readonly kind: "per_article"; readonly perArticlePaise: number };

/** One renderable row of the breakup. Signed: a discount is negative. */
export interface PriceComponent {
  readonly key: PriceComponentKey;
  /** A plain English default. Renderers may substitute their own wording. */
  readonly label: string;
  /** The amount for the WHOLE line (per-article figures live in `basis`). */
  readonly amountPaise: number;
  readonly basis?: PriceComponentBasis;
}

/**
 * A non-empty breakup. The tuple shape is the point: TypeScript will not let a
 * caller be handed a total whose itemisation is an empty array.
 */
export type PriceComponents = readonly [PriceComponent, ...PriceComponent[]];

/** Per-article money. These are exactly the `order_items` snapshot columns. */
export interface PricedUnit {
  readonly metalValuePaise: number;
  readonly makingChargePaise: number;
  readonly stoneValuePaise: number;
  readonly hallmarkingPaise: number;
  readonly otherChargesPaise: number;
  /** The exact sum of the five above — `order_items_unit_price_foots_ck`. */
  readonly unitPricePaise: number;
}

/**
 * One priced line. Field names match `order_items` so the snapshot is a copy,
 * not a translation. `components` renders the breakup; there is no way to get
 * `lineTotalPaise` without it.
 */
export interface PricedLine {
  readonly quantity: number;
  readonly unit: PricedUnit;
  readonly lineDiscountPaise: number;
  readonly lineSubtotalPaise: number;
  readonly lineGstRateBps: number;
  readonly lineGstPaise: number;
  readonly lineTotalPaise: number;
  readonly components: PriceComponents;
  /** Purity as Reg. 5(11) wants it printed. Absent when the piece has no metal. */
  readonly purity?: PurityLabel;
}

export interface PriceQuoteInput {
  readonly lines: readonly PriceLineInput[];
  /** Order-level. Taxed at the same rate as the principal supply. */
  readonly shippingPaise?: number;
  /** Defaults to `GST_RATE_BPS`; every line must agree with it. */
  readonly gstRateBps?: number;
}

/**
 * A whole quote. Field names match `price_quotes` and the money half of
 * `orders`, and the values satisfy their footing CHECK constraints by
 * construction — see `assertFoots`.
 */
export interface PricedQuote {
  readonly lines: readonly PricedLine[];
  readonly metalValuePaise: number;
  readonly makingChargesPaise: number;
  readonly stoneValuePaise: number;
  readonly hallmarkingPaise: number;
  readonly otherChargesPaise: number;
  /** The sum of the line discounts. There is no separate order discount. */
  readonly discountPaise: number;
  readonly shippingPaise: number;
  readonly taxablePaise: number;
  readonly gstRateBps: number;
  readonly gstPaise: number;
  readonly totalPaise: number;
  readonly components: PriceComponents;
}

/** CGST+SGST or IGST, never both. Decided by place of supply, not by component. */
export interface GstSplit {
  readonly cgstPaise: number;
  readonly sgstPaise: number;
  readonly igstPaise: number;
}

/** Purity as BIS Reg. 5(11) requires it: "in carat and fineness". */
export interface PurityLabel {
  readonly fineness: number;
  /** "22K", or null when the fineness has no karat equivalent (e.g. 995). */
  readonly caratLabel: string | null;
  /** "916". Always present — fineness is the source of truth. */
  readonly finenessLabel: string;
  /** "22K (916)", or "995 fineness" when there is no karat name. */
  readonly display: string;
}

/* -------------------------------------------------------------------------
 * Integer arithmetic. Every operation below is exact.
 * ---------------------------------------------------------------------- */

/** Narrow a bigint back to a `number`, refusing anything not exactly held. */
function toPaise(value: bigint): number {
  if (value > MAX_SAFE || value < MIN_SAFE) {
    throw new PriceEngineError(
      "overflow",
      `money figure ${value.toString()} is outside the exactly-representable integer range`
    );
  }
  return Number(value);
}

/**
 * `roundHalfUp(a * b / divisor)`, computed entirely in bigint.
 *
 * `a`, `b` and `divisor` are all non-negative (validated by the callers), so
 * bigint truncation is floor and "half up" is unambiguous.
 */
function mulDivRoundHalfUp(a: number, b: number, divisor: number): number {
  const product = BigInt(a) * BigInt(b);
  const d = BigInt(divisor);
  const quotient = product / d;
  const remainder = product % d;
  return toPaise(remainder * TWO >= d ? quotient + ONE : quotient);
}

/** Exact integer sum. Values may be negative (a discount is). */
function sumPaise(values: readonly number[]): number {
  let total = ZERO;
  for (const value of values) {
    total += BigInt(value);
  }
  return toPaise(total);
}

/* -------------------------------------------------------------------------
 * Validation. Fail loudly at the boundary; the interior assumes integers.
 * ---------------------------------------------------------------------- */

function requireInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new PriceEngineError(
      "invalid_input",
      `${field} must be a safe integer, received ${String(value)}`
    );
  }
  return value;
}

function requireNonNegativeInteger(value: number, field: string): number {
  requireInteger(value, field);
  if (value < 0) {
    throw new PriceEngineError(
      "invalid_input",
      `${field} must not be negative, received ${String(value)}`
    );
  }
  return value;
}

function requirePositiveInteger(value: number, field: string): number {
  requireInteger(value, field);
  if (value <= 0) {
    throw new PriceEngineError(
      "invalid_input",
      `${field} must be greater than zero, received ${String(value)}`
    );
  }
  return value;
}

/** `variants_fineness_range_ck` and `gold_rates_fineness_range_ck`, in code. */
function requireFineness(value: number, field: string): number {
  requireInteger(value, field);
  if (value <= 0 || value > 1000) {
    throw new PriceEngineError(
      "invalid_input",
      `${field} must be a millesimal fineness in 1..1000, received ${String(value)}`
    );
  }
  return value;
}

function optionalPaise(value: number | undefined, field: string): number {
  return value === undefined ? 0 : requireNonNegativeInteger(value, field);
}

/**
 * Narrow a metal name read out of the database.
 *
 * A `gold_rates` row types `metal` as `string`, so the compile-time guarantee
 * that `MetalRate.metal` is one of three values evaporates at the persistence
 * boundary. Every entry point below re-checks it at runtime, and this guard is
 * exported so a caller can narrow explicitly rather than reach for a cast.
 */
export function isPriceableMetal(value: string): value is PriceableMetal {
  return value === "gold" || value === "silver" || value === "platinum";
}

function requirePriceableMetal(value: string, field: string): PriceableMetal {
  if (!isPriceableMetal(value)) {
    throw new PriceEngineError(
      "invalid_input",
      `${field} must be gold, silver or platinum, received ${JSON.stringify(value)}`
    );
  }
  return value;
}

/* -------------------------------------------------------------------------
 * Purity presentation
 * ---------------------------------------------------------------------- */

/**
 * Derive the printable purity from fineness. Fineness is, and stays, the source
 * of truth; this is presentation only.
 *
 * A fineness with no conventional karat name — 995 being the one that matters —
 * gets `caratLabel: null` and displays as "995 fineness". It is never rounded
 * up to 24K. Karat is a gold convention, so silver and platinum never carry one.
 */
export function purityLabel(fineness: number, metal: PriceableMetal): PurityLabel {
  requireFineness(fineness, "fineness");
  const finenessLabel = String(fineness);
  const caratLabel =
    requirePriceableMetal(metal, "metal") === "gold"
      ? (GOLD_KARAT_BY_FINENESS[fineness] ?? null)
      : null;
  return {
    fineness,
    caratLabel,
    finenessLabel,
    display: caratLabel === null ? `${finenessLabel} fineness` : `${caratLabel} (${finenessLabel})`,
  };
}

/* -------------------------------------------------------------------------
 * Footing — the invariant, checked on every call
 * ---------------------------------------------------------------------- */

/**
 * Re-derive the totals from the rendered breakup and refuse to return anything
 * that does not reconcile. This mirrors the CHECK constraints on `order_items`,
 * `price_quotes` and `orders`; failing here is enormously better than failing at
 * the database, and better again than a customer receiving an invoice that does
 * not add up.
 */
function assertFoots(
  components: PriceComponents,
  taxablePaise: number,
  gstPaise: number,
  totalPaise: number,
  where: string
): void {
  const taxableFromComponents = sumPaise(
    components.filter((component) => component.key !== "gst").map((component) => component.amountPaise)
  );
  const totalFromComponents = sumPaise(components.map((component) => component.amountPaise));

  if (taxableFromComponents !== taxablePaise) {
    throw new PriceEngineError(
      "does_not_foot",
      `${where}: components sum to ${taxableFromComponents} but taxable value is ${taxablePaise}`
    );
  }
  if (sumPaise([taxablePaise, gstPaise]) !== totalPaise) {
    throw new PriceEngineError(
      "does_not_foot",
      `${where}: taxable ${taxablePaise} + GST ${gstPaise} is not total ${totalPaise}`
    );
  }
  if (totalFromComponents !== totalPaise) {
    throw new PriceEngineError(
      "does_not_foot",
      `${where}: components sum to ${totalFromComponents} but total is ${totalPaise}`
    );
  }
}

/** Seal a built-up list into the non-empty tuple, without a type assertion. */
function sealComponents(list: readonly PriceComponent[], where: string): PriceComponents {
  const [first, ...rest] = list;
  if (first === undefined) {
    throw new PriceEngineError("does_not_foot", `${where}: a total was produced with no breakup`);
  }
  return [first, ...rest];
}

/* -------------------------------------------------------------------------
 * Line pricing
 * ---------------------------------------------------------------------- */

/** The per-article money for a dynamically-priced piece, plus its components. */
function priceDynamicUnit(input: DynamicMetalLineInput): {
  unit: PricedUnit;
  unitComponents: PriceComponent[];
  purity: PurityLabel;
} {
  const fineness = requireFineness(input.fineness, "fineness");
  const metal = requirePriceableMetal(input.metal, "metal");
  const rateMetal = requirePriceableMetal(input.rate.metal, "rate.metal");
  const rateFineness = requireFineness(input.rate.fineness, "rate.fineness");
  const ratePerTenGramsPaise = requirePositiveInteger(
    input.rate.ratePerTenGramsPaise,
    "rate.ratePerTenGramsPaise"
  );
  const netMetalWeightMg = requirePositiveInteger(input.netMetalWeightMg, "netMetalWeightMg");

  // The rate is per (metal, fineness) — IBJA publishes one per purity. Pricing
  // a 995 article against the 999 rate is a silent ~0.4% error on every order,
  // which is precisely what a karat enum used to cause. Refuse it.
  if (rateMetal !== metal) {
    throw new PriceEngineError(
      "rate_mismatch",
      `rate is for ${rateMetal} but the article is ${metal}`
    );
  }
  if (rateFineness !== fineness) {
    throw new PriceEngineError(
      "rate_mismatch",
      `rate is for fineness ${rateFineness} but the article is fineness ${fineness}`
    );
  }

  const purity = purityLabel(fineness, metal);

  // (1) Metal value. Rounded half up exactly once, per article.
  const metalValuePaise = mulDivRoundHalfUp(
    ratePerTenGramsPaise,
    netMetalWeightMg,
    MG_PER_TEN_GRAMS
  );

  // (2) Making charge. Rounded half up exactly once, per article.
  const makingChargePaise = computeMakingCharge(
    input.makingCharge,
    metalValuePaise,
    netMetalWeightMg
  );

  // (3) Pass-through integers.
  const stoneValuePaise = optionalPaise(input.stoneValuePaise, "stoneValuePaise");
  const hallmarkingPaise = optionalPaise(input.hallmarkingPaise, "hallmarkingPaise");
  const otherChargesPaise = optionalPaise(input.otherChargesPaise, "otherChargesPaise");

  // (4) Exact integer sum. `order_items_unit_price_foots_ck`.
  const unitPricePaise = sumPaise([
    metalValuePaise,
    makingChargePaise,
    stoneValuePaise,
    hallmarkingPaise,
    otherChargesPaise,
  ]);

  const unitComponents: PriceComponent[] = [
    {
      key: "metal",
      label: `${purity.caratLabel ?? purity.finenessLabel} ${METAL_NOUN[metal]}`,
      amountPaise: metalValuePaise,
      basis: {
        kind: "metal_rate",
        ratePerTenGramsPaise,
        netMetalWeightMg,
        fineness,
      },
    },
  ];
  if (makingChargePaise !== 0 && input.makingCharge !== undefined) {
    unitComponents.push({
      key: "making",
      label: "Making charges",
      amountPaise: makingChargePaise,
      basis: makingChargeBasis(input.makingCharge, metalValuePaise, netMetalWeightMg),
    });
  }
  if (stoneValuePaise !== 0) {
    unitComponents.push({ key: "stone", label: "Stone value", amountPaise: stoneValuePaise });
  }
  // A hallmarking charge of 0 emits NO line. See the header: Kundan, Polki and
  // Jadau are exempt, and a zero line would misrepresent them as hallmarked.
  if (hallmarkingPaise !== 0) {
    unitComponents.push({
      key: "hallmarking",
      label: "Hallmarking",
      amountPaise: hallmarkingPaise,
      basis: { kind: "per_article", perArticlePaise: hallmarkingPaise },
    });
  }
  if (otherChargesPaise !== 0) {
    unitComponents.push({ key: "other", label: "Other charges", amountPaise: otherChargesPaise });
  }

  return {
    unit: {
      metalValuePaise,
      makingChargePaise,
      stoneValuePaise,
      hallmarkingPaise,
      otherChargesPaise,
      unitPricePaise,
    },
    unitComponents,
    purity,
  };
}

function computeMakingCharge(
  makingCharge: MakingCharge | undefined,
  metalValuePaise: number,
  netMetalWeightMg: number
): number {
  if (makingCharge === undefined) {
    return 0;
  }
  switch (makingCharge.type) {
    case "percent":
      // Basis points of the ALREADY-ROUNDED metal value, so the invoice's own
      // arithmetic reproduces. Metal value only; stones are not in the base.
      return mulDivRoundHalfUp(
        metalValuePaise,
        requireNonNegativeInteger(makingCharge.value, "makingCharge.value"),
        BPS_DIVISOR
      );
    case "per_gram":
      return mulDivRoundHalfUp(
        requireNonNegativeInteger(makingCharge.value, "makingCharge.value"),
        netMetalWeightMg,
        MG_PER_GRAM
      );
    case "flat":
      // Already paise. No division, therefore no rounding.
      return requireNonNegativeInteger(makingCharge.value, "makingCharge.value");
    default:
      return assertNever(makingCharge, "making charge type");
  }
}

function makingChargeBasis(
  makingCharge: MakingCharge,
  metalValuePaise: number,
  netMetalWeightMg: number
): PriceComponentBasis {
  switch (makingCharge.type) {
    case "percent":
      return { kind: "percent", rateBps: makingCharge.value, ofPaise: metalValuePaise };
    case "per_gram":
      return { kind: "per_gram", ratePerGramPaise: makingCharge.value, netMetalWeightMg };
    case "flat":
      return { kind: "flat" };
    default:
      return assertNever(makingCharge, "making charge type");
  }
}

/** The per-article money for a flat-quoted piece. */
function priceFixedUnit(input: FixedLineInput): {
  unit: PricedUnit;
  unitComponents: PriceComponent[];
  purity?: PurityLabel;
} {
  const fixedPricePaise = requireNonNegativeInteger(input.fixedPricePaise, "fixedPricePaise");
  const hallmarkingPaise = optionalPaise(input.hallmarkingPaise, "hallmarkingPaise");
  const otherChargesPaise = sumPaise([
    fixedPricePaise,
    optionalPaise(input.otherChargesPaise, "otherChargesPaise"),
  ]);
  const unitPricePaise = sumPaise([hallmarkingPaise, otherChargesPaise]);

  const unitComponents: PriceComponent[] = [
    { key: "other", label: "Piece price", amountPaise: otherChargesPaise, basis: { kind: "flat" } },
  ];
  if (hallmarkingPaise !== 0) {
    unitComponents.push({
      key: "hallmarking",
      label: "Hallmarking",
      amountPaise: hallmarkingPaise,
      basis: { kind: "per_article", perArticlePaise: hallmarkingPaise },
    });
  }

  const purity =
    input.fineness === undefined || input.metal === undefined
      ? undefined
      : purityLabel(input.fineness, requirePriceableMetal(input.metal, "metal"));

  return {
    unit: {
      metalValuePaise: 0,
      makingChargePaise: 0,
      stoneValuePaise: 0,
      hallmarkingPaise,
      otherChargesPaise,
      unitPricePaise,
    },
    unitComponents,
    purity,
  };
}

/**
 * Price one line: one design, one configuration, `quantity` articles of it.
 *
 * The returned object is the breakup. There is no variant of this function that
 * returns only a total.
 */
export function priceLine(input: PriceLineInput): PricedLine {
  if (input.pricingMode === "on_request") {
    throw new PriceEngineError(
      "not_priceable",
      "this piece is priced on request; there is no computable price"
    );
  }

  const priced =
    input.pricingMode === "dynamic_metal" ? priceDynamicUnit(input) : priceFixedUnit(input);
  const { unit, unitComponents } = priced;

  const quantity = input.quantity === undefined ? 1 : requirePositiveInteger(input.quantity, "quantity");
  const lineDiscountPaise = optionalPaise(input.lineDiscountPaise, "lineDiscountPaise");
  const lineGstRateBps =
    input.gstRateBps === undefined ? GST_RATE_BPS : requireNonNegativeInteger(input.gstRateBps, "gstRateBps");

  // (5) Quantity applies AFTER per-article rounding.
  //     `order_items_subtotal_foots_ck`.
  const grossLinePaise = toPaise(BigInt(unit.unitPricePaise) * BigInt(quantity));
  const lineSubtotalPaise = sumPaise([grossLinePaise, -lineDiscountPaise]);
  if (lineSubtotalPaise < 0) {
    throw new PriceEngineError(
      "invalid_input",
      `lineDiscountPaise ${lineDiscountPaise} exceeds the line value ${grossLinePaise}`
    );
  }

  // (6) GST: rounded half up, exactly once, on this line's subtotal.
  const lineGstPaise = mulDivRoundHalfUp(lineSubtotalPaise, lineGstRateBps, BPS_DIVISOR);
  const lineTotalPaise = sumPaise([lineSubtotalPaise, lineGstPaise]);

  // Components are line-level; the per-article figures live in `unit` and in
  // each component's `basis`.
  const components: PriceComponent[] = unitComponents.map((component) => ({
    ...component,
    amountPaise: toPaise(BigInt(component.amountPaise) * BigInt(quantity)),
  }));
  if (lineDiscountPaise !== 0) {
    components.push({ key: "discount", label: "Discount", amountPaise: -lineDiscountPaise });
  }
  // GST is always rendered: E-Commerce Rule 7(1)(e) requires the applicable tax
  // to appear in the breakup, and its presence is what guarantees the breakup
  // is never empty.
  components.push({
    key: "gst",
    label: "GST",
    amountPaise: lineGstPaise,
    basis: { kind: "percent", rateBps: lineGstRateBps, ofPaise: lineSubtotalPaise },
  });

  const sealed = sealComponents(components, "priceLine");
  assertFoots(sealed, lineSubtotalPaise, lineGstPaise, lineTotalPaise, "priceLine");

  // The unit-price footing CHECK, re-asserted here so a per-article breakup is
  // storable without a further reconciliation step.
  const unitFromParts = sumPaise([
    unit.metalValuePaise,
    unit.makingChargePaise,
    unit.stoneValuePaise,
    unit.hallmarkingPaise,
    unit.otherChargesPaise,
  ]);
  if (unitFromParts !== unit.unitPricePaise) {
    throw new PriceEngineError(
      "does_not_foot",
      `priceLine: unit components sum to ${unitFromParts} but unit price is ${unit.unitPricePaise}`
    );
  }

  return {
    quantity,
    unit,
    lineDiscountPaise,
    lineSubtotalPaise,
    lineGstRateBps,
    lineGstPaise,
    lineTotalPaise,
    components: sealed,
    ...(priced.purity === undefined ? {} : { purity: priced.purity }),
  };
}

/* -------------------------------------------------------------------------
 * Quote pricing
 * ---------------------------------------------------------------------- */

/**
 * Price a whole basket. The result maps field-for-field onto `price_quotes`
 * (and onto the money columns of `orders`), and satisfies their footing CHECK
 * constraints by construction.
 */
export function priceQuote(input: PriceQuoteInput): PricedQuote {
  if (input.lines.length === 0) {
    throw new PriceEngineError("invalid_input", "a quote must contain at least one line");
  }

  const gstRateBps =
    input.gstRateBps === undefined ? GST_RATE_BPS : requireNonNegativeInteger(input.gstRateBps, "gstRateBps");
  const shippingPaise = optionalPaise(input.shippingPaise, "shippingPaise");

  const lines = input.lines.map((line) => {
    if (line.pricingMode === "on_request") {
      return priceLine(line);
    }
    // One rate for the whole order. A line asking for a different rate is
    // almost certainly the 3%/5% mistake the header warns about, so it is
    // refused loudly rather than silently overridden.
    if (line.gstRateBps !== undefined && line.gstRateBps !== gstRateBps) {
      throw new PriceEngineError(
        "invalid_input",
        `line gstRateBps ${line.gstRateBps} differs from the quote's ${gstRateBps}; ` +
          "GST is a single rate on the total transaction value"
      );
    }
    return priceLine({ ...line, gstRateBps });
  });

  const scaled = (pick: (line: PricedLine) => number): number =>
    sumPaise(lines.map((line) => toPaise(BigInt(pick(line)) * BigInt(line.quantity))));

  const metalValuePaise = scaled((line) => line.unit.metalValuePaise);
  const makingChargesPaise = scaled((line) => line.unit.makingChargePaise);
  const stoneValuePaise = scaled((line) => line.unit.stoneValuePaise);
  const hallmarkingPaise = scaled((line) => line.unit.hallmarkingPaise);
  const otherChargesPaise = scaled((line) => line.unit.otherChargesPaise);
  const discountPaise = sumPaise(lines.map((line) => line.lineDiscountPaise));

  // `price_quotes_taxable_foots_ck` / `orders_taxable_foots_ck`.
  const taxablePaise = sumPaise([
    metalValuePaise,
    makingChargesPaise,
    stoneValuePaise,
    hallmarkingPaise,
    otherChargesPaise,
    -discountPaise,
    shippingPaise,
  ]);

  // (7) Shipping is its own rounding group: it belongs to no line, and is taxed
  //     at the principal supply's rate. Order GST is therefore the sum of
  //     figures each of which was rounded exactly once.
  const shippingGstPaise = mulDivRoundHalfUp(shippingPaise, gstRateBps, BPS_DIVISOR);
  const gstPaise = sumPaise([...lines.map((line) => line.lineGstPaise), shippingGstPaise]);
  const totalPaise = sumPaise([taxablePaise, gstPaise]);

  const components: PriceComponent[] = [];
  if (metalValuePaise !== 0) {
    components.push({ key: "metal", label: "Metal value", amountPaise: metalValuePaise });
  }
  if (makingChargesPaise !== 0) {
    components.push({ key: "making", label: "Making charges", amountPaise: makingChargesPaise });
  }
  if (stoneValuePaise !== 0) {
    components.push({ key: "stone", label: "Stone value", amountPaise: stoneValuePaise });
  }
  if (hallmarkingPaise !== 0) {
    components.push({ key: "hallmarking", label: "Hallmarking", amountPaise: hallmarkingPaise });
  }
  if (otherChargesPaise !== 0) {
    components.push({ key: "other", label: "Other charges", amountPaise: otherChargesPaise });
  }
  if (discountPaise !== 0) {
    components.push({ key: "discount", label: "Discount", amountPaise: -discountPaise });
  }
  if (shippingPaise !== 0) {
    components.push({ key: "shipping", label: "Delivery", amountPaise: shippingPaise });
  }
  components.push({
    key: "gst",
    label: "GST",
    amountPaise: gstPaise,
    basis: { kind: "percent", rateBps: gstRateBps, ofPaise: taxablePaise },
  });

  const sealed = sealComponents(components, "priceQuote");
  assertFoots(sealed, taxablePaise, gstPaise, totalPaise, "priceQuote");

  return {
    lines,
    metalValuePaise,
    makingChargesPaise,
    stoneValuePaise,
    hallmarkingPaise,
    otherChargesPaise,
    discountPaise,
    shippingPaise,
    taxablePaise,
    gstRateBps,
    gstPaise,
    totalPaise,
    components: sealed,
  };
}

/* -------------------------------------------------------------------------
 * Tax split
 * ---------------------------------------------------------------------- */

/**
 * Split the GST into CGST+SGST or IGST. The choice is made by PLACE OF SUPPLY
 * — IGST Act s.10(1)(a): where the supply involves movement of goods, the place
 * of supply is where the movement terminates for delivery, i.e. the DELIVERY
 * state, never the billing address. For a store pickup it is the shop's state.
 * That determination is the caller's; this function only divides the money.
 *
 * `cgst = floor(gst / 2)` and `sgst = gst - cgst`, so an odd number of paise
 * reconciles exactly and `orders_gst_split_foots_ck` holds.
 */
export function splitGst(gstPaise: number, options: { readonly interState: boolean }): GstSplit {
  requireNonNegativeInteger(gstPaise, "gstPaise");
  if (options.interState) {
    return { cgstPaise: 0, sgstPaise: 0, igstPaise: gstPaise };
  }
  const cgstPaise = toPaise(BigInt(gstPaise) / TWO);
  return { cgstPaise, sgstPaise: sumPaise([gstPaise, -cgstPaise]), igstPaise: 0 };
}

/* -------------------------------------------------------------------------
 * Exhaustiveness
 * ---------------------------------------------------------------------- */

function assertNever(value: never, what: string): never {
  throw new PriceEngineError("invalid_input", `unhandled ${what}: ${JSON.stringify(value)}`);
}
