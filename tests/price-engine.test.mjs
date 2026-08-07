/**
 * Price-engine tests.
 *
 * Worked examples with real-looking Indian jewellery numbers, asserted to the
 * paise. Every expected figure below was derived by hand from the rules in
 * `app/_pricing/price.ts` and `db/schema.ts`; none of it was read back out of
 * the implementation.
 *
 * The engine is pure, so these tests import the module directly rather than
 * driving the built Worker the way the route tests do. Node strips the types
 * (>= 22.18 unflagged); no build step or bundler is involved.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  BIS_HALLMARKING_GOLD_PAISE,
  GST_RATE_BPS,
  isPriceableMetal,
  PriceEngineError,
  priceLine,
  priceQuote,
  purityLabel,
  splitGst,
} from "../app/_pricing/price.ts";

/* -------------------------------------------------------------------------
 * The invariants. These are the CHECK constraints from db/schema.ts, written
 * out as executable assertions, so a breakup this engine produces is provably
 * storable rather than hopefully storable.
 * ---------------------------------------------------------------------- */

/** `order_items_unit_price_foots_ck`, `..._subtotal_foots_ck`, `..._total_foots_ck`. */
function assertLineFoots(line) {
  const { unit } = line;
  assert.equal(
    unit.unitPricePaise,
    unit.metalValuePaise +
      unit.makingChargePaise +
      unit.stoneValuePaise +
      unit.hallmarkingPaise +
      unit.otherChargesPaise,
    "unit_price_paise = metal + making + stone + hallmarking + other"
  );
  assert.equal(
    line.lineSubtotalPaise,
    unit.unitPricePaise * line.quantity - line.lineDiscountPaise,
    "line_subtotal_paise = unit_price_paise * quantity - line_discount_paise"
  );
  assert.equal(
    line.lineTotalPaise,
    line.lineSubtotalPaise + line.lineGstPaise,
    "line_total_paise = line_subtotal_paise + line_gst_paise"
  );

  // The rendered breakup must reconcile against those same totals, because it
  // is the breakup the customer and the invoice see.
  const sum = (predicate) =>
    line.components.filter(predicate).reduce((acc, component) => acc + component.amountPaise, 0);
  assert.equal(sum((c) => c.key !== "gst"), line.lineSubtotalPaise, "components ex-GST sum to subtotal");
  assert.equal(sum(() => true), line.lineTotalPaise, "all components sum to the line total");

  for (const value of [
    unit.metalValuePaise,
    unit.makingChargePaise,
    unit.stoneValuePaise,
    unit.hallmarkingPaise,
    unit.otherChargesPaise,
    unit.unitPricePaise,
    line.lineSubtotalPaise,
    line.lineGstPaise,
    line.lineTotalPaise,
  ]) {
    assert.ok(Number.isSafeInteger(value), `${value} must be an exact integer number of paise`);
  }
}

/** `price_quotes_taxable_foots_ck` / `price_quotes_total_foots_ck`. */
function assertQuoteFoots(quote) {
  assert.equal(
    quote.taxablePaise,
    quote.metalValuePaise +
      quote.makingChargesPaise +
      quote.stoneValuePaise +
      quote.hallmarkingPaise +
      quote.otherChargesPaise -
      quote.discountPaise +
      quote.shippingPaise,
    "taxable_paise = metal + making + stone + hallmarking + other - discount + shipping"
  );
  assert.equal(quote.totalPaise, quote.taxablePaise + quote.gstPaise, "total_paise = taxable + gst");

  const sum = (predicate) =>
    quote.components.filter(predicate).reduce((acc, component) => acc + component.amountPaise, 0);
  assert.equal(sum((c) => c.key !== "gst"), quote.taxablePaise, "components ex-GST sum to taxable");
  assert.equal(sum(() => true), quote.totalPaise, "all components sum to the total");

  for (const line of quote.lines) {
    assertLineFoots(line);
  }
}

function component(priced, key) {
  return priced.components.find((entry) => entry.key === key);
}

/* -------------------------------------------------------------------------
 * Worked example A — 22K bangle, percentage making charge
 *
 * IBJA 916 at Rs 92,450 per 10 g, net metal 12.345 g, 12% making, BIS Rs 45.
 *
 *   metal   = round_half_up(9,245,000 x 12,345 / 10,000)
 *           = round_half_up(11,412,952.5) = 11,412,953   (Rs 1,14,129.53)
 *   making  = round_half_up(11,412,953 x 1,200 / 10,000)
 *           = round_half_up(1,369,554.36) = 1,369,554    (Rs 13,695.54)
 *   hallmk  =                                    4,500   (Rs 45.00)
 *   unit    =                               12,787,007   (Rs 1,27,870.07)
 *   GST 3%  = round_half_up(383,610.21)   =    383,610   (Rs 3,836.10)
 *   total   =                               13,170,617   (Rs 1,31,706.17)
 * ---------------------------------------------------------------------- */

const BANGLE_22K = {
  pricingMode: "dynamic_metal",
  rate: { metal: "gold", fineness: 916, ratePerTenGramsPaise: 9_245_000 },
  metal: "gold",
  fineness: 916,
  netMetalWeightMg: 12_345,
  makingCharge: { type: "percent", value: 1_200 },
  hallmarkingPaise: BIS_HALLMARKING_GOLD_PAISE,
};

test("A: 22K bangle with a percentage making charge prices to the paise", () => {
  const line = priceLine(BANGLE_22K);

  assert.equal(line.unit.metalValuePaise, 11_412_953);
  assert.equal(line.unit.makingChargePaise, 1_369_554);
  assert.equal(line.unit.stoneValuePaise, 0);
  assert.equal(line.unit.hallmarkingPaise, 4_500);
  assert.equal(line.unit.otherChargesPaise, 0);
  assert.equal(line.unit.unitPricePaise, 12_787_007);
  assert.equal(line.lineSubtotalPaise, 12_787_007);
  assert.equal(line.lineGstRateBps, 300);
  assert.equal(line.lineGstPaise, 383_610);
  assert.equal(line.lineTotalPaise, 13_170_617);
  assertLineFoots(line);
});

test("A: the making charge is a percentage of the ROUNDED metal value", () => {
  // 12% of the unrounded 11,412,952.5 would be 1,369,554.30 -> 1,369,554 too,
  // so assert the documented base directly rather than relying on a collision.
  const line = priceLine(BANGLE_22K);
  const making = component(line, "making");
  assert.equal(making.basis.kind, "percent");
  assert.equal(making.basis.rateBps, 1_200);
  assert.equal(
    making.basis.ofPaise,
    line.unit.metalValuePaise,
    "the printed metal line must be the base of the printed making line"
  );
});

/* -------------------------------------------------------------------------
 * Worked example B — 18K Polki set, FLAT making charge, stones, NO hallmarking
 *
 * QCO cl. 2(3) exempts Polki from mandatory hallmarking, so the charge is 0 and
 * no hallmarking line may appear.
 *
 *   metal   = 7,560,000 x 8,200 / 10,000 =  6,199,200   (Rs 61,992.00, exact)
 *   making  = flat                       =  1,500,000   (Rs 15,000.00)
 *   stone   =                              24,500,000   (Rs 2,45,000.00)
 *   unit    =                              32,199,200
 *   GST 3%  =                                 965,976   (exact, Rs 9,659.76)
 *   total   =                              33,165,176   (Rs 3,31,651.76)
 * ---------------------------------------------------------------------- */

const POLKI_18K = {
  pricingMode: "dynamic_metal",
  rate: { metal: "gold", fineness: 750, ratePerTenGramsPaise: 7_560_000 },
  metal: "gold",
  fineness: 750,
  netMetalWeightMg: 8_200,
  makingCharge: { type: "flat", value: 1_500_000 },
  stoneValuePaise: 24_500_000,
  hallmarkingPaise: 0,
};

test("B: 18K Polki set with a flat making charge and stone value", () => {
  const line = priceLine(POLKI_18K);

  assert.equal(line.unit.metalValuePaise, 6_199_200);
  assert.equal(line.unit.makingChargePaise, 1_500_000);
  assert.equal(line.unit.stoneValuePaise, 24_500_000);
  assert.equal(line.unit.hallmarkingPaise, 0);
  assert.equal(line.unit.unitPricePaise, 32_199_200);
  assert.equal(line.lineGstPaise, 965_976);
  assert.equal(line.lineTotalPaise, 33_165_176);
  assertLineFoots(line);
});

test("B: a hallmarking-exempt piece renders NO hallmarking line", () => {
  const line = priceLine(POLKI_18K);
  assert.equal(
    component(line, "hallmarking"),
    undefined,
    "a zero line would imply the piece was hallmarked and the charge waived"
  );
  assert.ok(component(line, "stone"), "the stone value is its own renderable line");
});

test("a flat making charge is not divided, so it is never rounded", () => {
  const line = priceLine({ ...POLKI_18K, makingCharge: { type: "flat", value: 1_500_001 } });
  assert.equal(line.unit.makingChargePaise, 1_500_001);
  assert.equal(component(line, "making").basis.kind, "flat");
});

/* -------------------------------------------------------------------------
 * Worked example C — 995 fineness, per-gram making charge
 *
 * 995 has no karat equivalent. This is the exact case the old
 * `"24K" | "22K" | "18K" | "14K"` enum collapsed onto 24K, mis-pricing every
 * 995 article by roughly 0.4% forever, invisibly.
 *
 *   metal   = 9,912,000 x 10,000 / 10,000 =  9,912,000  (Rs 99,120.00)
 *   making  = 55,000 x 10,000 / 1,000     =    550,000  (Rs 5,500.00)
 *   hallmk  =                                   4,500
 *   unit    =                               10,466,500
 *   GST 3%  =                                  313,995  (exact)
 *   total   =                               10,780,495  (Rs 1,07,804.95)
 * ---------------------------------------------------------------------- */

const COIN_995 = {
  pricingMode: "dynamic_metal",
  rate: { metal: "gold", fineness: 995, ratePerTenGramsPaise: 9_912_000 },
  metal: "gold",
  fineness: 995,
  netMetalWeightMg: 10_000,
  makingCharge: { type: "per_gram", value: 55_000 },
  hallmarkingPaise: BIS_HALLMARKING_GOLD_PAISE,
};

test("C: a 995-fineness piece prices from the 995 rate, per gram making", () => {
  const line = priceLine(COIN_995);

  assert.equal(line.unit.metalValuePaise, 9_912_000);
  assert.equal(line.unit.makingChargePaise, 550_000);
  assert.equal(line.unit.unitPricePaise, 10_466_500);
  assert.equal(line.lineGstPaise, 313_995);
  assert.equal(line.lineTotalPaise, 10_780_495);
  assertLineFoots(line);
});

test("C: 995 is never presented, or priced, as 24K", () => {
  const label = purityLabel(995, "gold");
  assert.equal(label.caratLabel, null, "995 has no karat equivalent");
  assert.equal(label.finenessLabel, "995");
  assert.equal(label.display, "995 fineness");

  const line = priceLine(COIN_995);
  assert.equal(line.purity.caratLabel, null);
  assert.equal(component(line, "metal").label, "995 Gold");
  assert.equal(component(line, "metal").basis.fineness, 995);
});

test("C: pricing a 995 article against the 999 rate is refused, not silently absorbed", () => {
  assert.throws(
    () =>
      priceLine({
        ...COIN_995,
        rate: { metal: "gold", fineness: 999, ratePerTenGramsPaise: 9_952_000 },
      }),
    (error) => error instanceof PriceEngineError && error.code === "rate_mismatch"
  );
});

test("the rate's metal must match the article's metal", () => {
  assert.throws(
    () =>
      priceLine({
        ...COIN_995,
        rate: { metal: "silver", fineness: 995, ratePerTenGramsPaise: 12_000 },
      }),
    (error) => error instanceof PriceEngineError && error.code === "rate_mismatch"
  );
});

test("a metal name that survived a `string`-typed database column is checked, not trusted", () => {
  // `gold_rates.metal` reaches this module as `string`, so the compile-time
  // union is not a guarantee at the persistence boundary. Both sides are
  // re-checked at runtime; a matched pair of nonsense is still refused.
  assert.ok(isPriceableMetal("gold"));
  assert.ok(!isPriceableMetal("Gold"));
  assert.ok(!isPriceableMetal("palladium"));

  assert.throws(
    () =>
      priceLine({
        ...COIN_995,
        metal: "palladium",
        rate: { ...COIN_995.rate, metal: "palladium" },
      }),
    (error) => error instanceof PriceEngineError && error.code === "invalid_input"
  );
});

test("karat labels come from a table, not from rounding fineness x 24 / 1000", () => {
  assert.equal(purityLabel(999, "gold").display, "24K (999)");
  assert.equal(purityLabel(916, "gold").display, "22K (916)");
  assert.equal(purityLabel(750, "gold").display, "18K (750)");
  assert.equal(purityLabel(585, "gold").display, "14K (585)");
  assert.equal(purityLabel(995, "gold").display, "995 fineness");
  // Karat is a gold convention; silver 999 and platinum 950 have none.
  assert.equal(purityLabel(999, "silver").caratLabel, null);
  assert.equal(purityLabel(950, "platinum").display, "950 fineness");
});

/* -------------------------------------------------------------------------
 * Worked example D — quantity 2 with a line discount
 *
 *   metal   = 9,245,000 x 5,500 / 10,000 = 5,084,750 (exact)
 *   making  = 45,000 x 5,500 / 1,000     =   247,500 (exact)
 *   hallmk  =                                  4,500  (per ARTICLE)
 *   unit    =                              5,336,750
 *   x 2                                   10,673,500
 *   less discount Rs 5,000                  -500,000
 *   subtotal                              10,173,500
 *   GST 3%  =                                305,205 (exact)
 *   total                                 10,478,705
 * ---------------------------------------------------------------------- */

test("D: quantity multiplies AFTER per-article rounding, and the discount is a line", () => {
  const line = priceLine({
    pricingMode: "dynamic_metal",
    rate: { metal: "gold", fineness: 916, ratePerTenGramsPaise: 9_245_000 },
    metal: "gold",
    fineness: 916,
    netMetalWeightMg: 5_500,
    makingCharge: { type: "per_gram", value: 45_000 },
    hallmarkingPaise: BIS_HALLMARKING_GOLD_PAISE,
    quantity: 2,
    lineDiscountPaise: 500_000,
  });

  assert.equal(line.unit.metalValuePaise, 5_084_750);
  assert.equal(line.unit.makingChargePaise, 247_500);
  assert.equal(line.unit.hallmarkingPaise, 4_500, "hallmarking is per article, not per line");
  assert.equal(line.unit.unitPricePaise, 5_336_750);
  assert.equal(line.quantity, 2);
  assert.equal(line.lineSubtotalPaise, 10_173_500);
  assert.equal(line.lineGstPaise, 305_205);
  assert.equal(line.lineTotalPaise, 10_478_705);

  // Components are line-level; the per-article figures live in `unit`/`basis`.
  assert.equal(component(line, "metal").amountPaise, 10_169_500);
  assert.equal(component(line, "metal").basis.netMetalWeightMg, 5_500);
  assert.equal(component(line, "hallmarking").amountPaise, 9_000);
  assert.equal(component(line, "discount").amountPaise, -500_000, "a discount renders negative");
  assertLineFoots(line);
});

/* -------------------------------------------------------------------------
 * Rounding at half-way boundaries. Half UP, every time, at the documented step.
 * ---------------------------------------------------------------------- */

test("metal value at an exact half paise rounds UP", () => {
  // 9,245,000 x 12,345 / 10,000 = 11,412,952.5 exactly.
  const line = priceLine(BANGLE_22K);
  assert.equal(line.unit.metalValuePaise, 11_412_953);
  assert.notEqual(line.unit.metalValuePaise, 11_412_952);
});

test("a percentage making charge at an exact half paise rounds UP", () => {
  // 14K at Rs 61,992.04 per 10 g, 10.000 g -> metal 6,199,204 exactly.
  // 12.5% of that is 774,900.5 exactly.
  const line = priceLine({
    pricingMode: "dynamic_metal",
    rate: { metal: "gold", fineness: 585, ratePerTenGramsPaise: 6_199_204 },
    metal: "gold",
    fineness: 585,
    netMetalWeightMg: 10_000,
    makingCharge: { type: "percent", value: 1_250 },
    hallmarkingPaise: BIS_HALLMARKING_GOLD_PAISE,
  });

  assert.equal(line.unit.metalValuePaise, 6_199_204);
  assert.equal(line.unit.makingChargePaise, 774_901, "774,900.5 rounds up");
  assert.equal(line.unit.unitPricePaise, 6_978_605);
  assert.equal(line.lineGstPaise, 209_358, "209,358.15 rounds down");
  assert.equal(line.lineTotalPaise, 7_187_963);
  assertLineFoots(line);
});

test("GST at an exact half paise rounds UP", () => {
  // Subtotal 12,345,650 -> 3% is 370,369.5 exactly.
  const line = priceLine({ pricingMode: "fixed", fixedPricePaise: 12_345_650 });
  assert.equal(line.lineSubtotalPaise, 12_345_650);
  assert.equal(line.lineGstPaise, 370_370, "370,369.5 rounds up");
  assert.equal(line.lineTotalPaise, 12_716_020);
  assertLineFoots(line);
});

test("a per-gram making charge at an exact half paise rounds UP", () => {
  // 1 paise/g x 500 mg = 0.5 paise.
  const line = priceLine({
    pricingMode: "dynamic_metal",
    rate: { metal: "gold", fineness: 916, ratePerTenGramsPaise: 9_245_000 },
    metal: "gold",
    fineness: 916,
    netMetalWeightMg: 500,
    makingCharge: { type: "per_gram", value: 1 },
    hallmarkingPaise: 0,
  });
  assert.equal(line.unit.makingChargePaise, 1);
});

/* -------------------------------------------------------------------------
 * GST. One rate, on the total transaction value. CBIC FAQ Q7.
 * ---------------------------------------------------------------------- */

test("GST is 3% of the whole taxable value, NOT 3% metal + 5% making", () => {
  const line = priceLine(BANGLE_22K);

  // The correct figure.
  assert.equal(GST_RATE_BPS, 300);
  assert.equal(line.lineGstRateBps, 300);
  assert.equal(line.lineGstPaise, 383_610);

  // The figure a 3%/5% split would produce. If this test ever fails because
  // the engine now returns 411,002, someone has "fixed" a rule that was never
  // broken: CBIC DGTS Sectoral FAQ (Gems & Jewellery) Q7 says 3% of the total
  // transaction value "whether the making charge is shown separately or not".
  const wrongSplitGst =
    Math.round((11_412_953 * 300) / 10_000) + // 3% on metal
    Math.round((1_369_554 * 500) / 10_000) + //  5% on making  <- the mistake
    Math.round((4_500 * 300) / 10_000); //       3% on hallmarking
  assert.equal(wrongSplitGst, 411_002);
  assert.notEqual(line.lineGstPaise, wrongSplitGst);
});

test("GST is charged on making charges and hallmarking, not only on metal", () => {
  const line = priceLine(BANGLE_22K);
  const gst = component(line, "gst");
  assert.equal(gst.basis.ofPaise, line.lineSubtotalPaise);
  assert.equal(gst.basis.rateBps, 300);
  assert.notEqual(gst.basis.ofPaise, line.unit.metalValuePaise);
});

test("a quote refuses a line that asks for a different GST rate", () => {
  assert.throws(
    () => priceQuote({ lines: [{ ...BANGLE_22K, gstRateBps: 500 }] }),
    (error) => error instanceof PriceEngineError && error.code === "invalid_input"
  );
});

test("splitGst reconciles exactly on an odd number of paise", () => {
  const intra = splitGst(305_205, { interState: false });
  assert.deepEqual(intra, { cgstPaise: 152_602, sgstPaise: 152_603, igstPaise: 0 });
  assert.equal(intra.cgstPaise + intra.sgstPaise + intra.igstPaise, 305_205);

  const inter = splitGst(305_205, { interState: true });
  assert.deepEqual(inter, { cgstPaise: 0, sgstPaise: 0, igstPaise: 305_205 });
  assert.equal(inter.cgstPaise + inter.sgstPaise + inter.igstPaise, 305_205);
});

/* -------------------------------------------------------------------------
 * The breakup is a product feature, not a debug view.
 * ---------------------------------------------------------------------- */

test("the breakup is itemised, ordered and renderable", () => {
  const line = priceLine({ ...BANGLE_22K, stoneValuePaise: 250_000, otherChargesPaise: 14_950 });

  assert.deepEqual(
    line.components.map((entry) => entry.key),
    ["metal", "making", "stone", "hallmarking", "other", "gst"]
  );
  for (const entry of line.components) {
    assert.equal(typeof entry.label, "string");
    assert.ok(entry.label.length > 0, "every component carries a printable label");
    assert.ok(Number.isSafeInteger(entry.amountPaise));
  }

  const metal = component(line, "metal");
  assert.equal(metal.label, "22K Gold");
  assert.deepEqual(metal.basis, {
    kind: "metal_rate",
    ratePerTenGramsPaise: 9_245_000,
    netMetalWeightMg: 12_345,
    fineness: 916,
  });
});

test("a total is never produced without its breakup", () => {
  for (const priced of [priceLine(BANGLE_22K), priceQuote({ lines: [BANGLE_22K] })]) {
    assert.ok(Array.isArray(priced.components));
    assert.ok(priced.components.length > 0, "the breakup is a non-empty tuple by construction");
    assert.ok(
      priced.components.some((entry) => entry.key === "gst"),
      "the applicable tax always appears in the breakup (E-Commerce Rule 7(1)(e))"
    );
  }
});

test("purity is carried for the invoice in carat AND fineness (BIS Reg. 5(11))", () => {
  const line = priceLine(BANGLE_22K);
  assert.deepEqual(line.purity, {
    fineness: 916,
    caratLabel: "22K",
    finenessLabel: "916",
    display: "22K (916)",
  });
});

/* -------------------------------------------------------------------------
 * Flat-quoted (antique / Jadau) pieces
 * ---------------------------------------------------------------------- */

test("a flat-quoted Jadau set prices without a metal rate at all", () => {
  const line = priceLine({ pricingMode: "fixed", fixedPricePaise: 42_000_000, hallmarkingPaise: 0 });

  assert.equal(line.unit.metalValuePaise, 0);
  assert.equal(line.unit.makingChargePaise, 0);
  assert.equal(line.unit.otherChargesPaise, 42_000_000);
  assert.equal(line.unit.unitPricePaise, 42_000_000);
  assert.equal(line.lineGstPaise, 1_260_000);
  assert.equal(line.lineTotalPaise, 43_260_000);
  assert.equal(component(line, "other").label, "Piece price");
  assert.equal(line.purity, undefined);
  assertLineFoots(line);
});

test("a flat-quoted piece still keeps hallmarking on its own line", () => {
  const line = priceLine({
    pricingMode: "fixed",
    fixedPricePaise: 42_000_000,
    hallmarkingPaise: BIS_HALLMARKING_GOLD_PAISE,
    metal: "gold",
    fineness: 916,
  });
  assert.equal(line.unit.hallmarkingPaise, 4_500);
  assert.equal(line.unit.otherChargesPaise, 42_000_000, "hallmarking is never folded into the price");
  assert.equal(line.unit.unitPricePaise, 42_004_500);
  assert.equal(component(line, "hallmarking").amountPaise, 4_500);
  assert.equal(line.purity.display, "22K (916)");
  assertLineFoots(line);
});

test("an on-request piece is not priceable and says so", () => {
  assert.throws(
    () => priceLine({ pricingMode: "on_request" }),
    (error) => error instanceof PriceEngineError && error.code === "not_priceable"
  );
});

/* -------------------------------------------------------------------------
 * Quote level
 *
 *   A  metal 11,412,953  making 1,369,554  stone          0  hallmk 4,500
 *   B  metal  6,199,200  making 1,500,000  stone 24,500,000  hallmk     0
 *   -------------------------------------------------------------------
 *      metal 17,612,153  making 2,869,554  stone 24,500,000  hallmk 4,500
 *      shipping Rs 1,500                                          150,000
 *      taxable                                               45,136,207
 *      GST = 383,610 + 965,976 (per line) + 4,500 (shipping) = 1,354,086
 *      total                                                 46,490,293
 * ---------------------------------------------------------------------- */

test("a two-line quote foots, and its GST is the sum of the per-line figures", () => {
  const quote = priceQuote({ lines: [BANGLE_22K, POLKI_18K], shippingPaise: 150_000 });

  assert.equal(quote.metalValuePaise, 17_612_153);
  assert.equal(quote.makingChargesPaise, 2_869_554);
  assert.equal(quote.stoneValuePaise, 24_500_000);
  assert.equal(quote.hallmarkingPaise, 4_500);
  assert.equal(quote.otherChargesPaise, 0);
  assert.equal(quote.discountPaise, 0);
  assert.equal(quote.shippingPaise, 150_000);
  assert.equal(quote.taxablePaise, 45_136_207);
  assert.equal(quote.gstRateBps, 300);
  assert.equal(quote.gstPaise, 1_354_086);
  assert.equal(quote.totalPaise, 46_490_293);

  const lineGst = quote.lines.reduce((acc, line) => acc + line.lineGstPaise, 0);
  assert.equal(lineGst, 1_349_586);
  assert.equal(quote.gstPaise - lineGst, 4_500, "shipping is its own rounding group");
  assertQuoteFoots(quote);
});

test("quote-level components roll the lines up and still sum to the total", () => {
  const quote = priceQuote({ lines: [BANGLE_22K, POLKI_18K], shippingPaise: 150_000 });
  assert.deepEqual(
    quote.components.map((entry) => entry.key),
    ["metal", "making", "stone", "hallmarking", "shipping", "gst"]
  );
  assertQuoteFoots(quote);
});

test("quantity and line discounts roll up into the quote correctly", () => {
  const quote = priceQuote({
    lines: [
      { ...BANGLE_22K, quantity: 3, lineDiscountPaise: 1_000_000 },
      { ...POLKI_18K, lineDiscountPaise: 250_000 },
    ],
  });

  assert.equal(quote.metalValuePaise, 11_412_953 * 3 + 6_199_200);
  assert.equal(quote.hallmarkingPaise, 4_500 * 3);
  assert.equal(quote.discountPaise, 1_250_000);
  assertQuoteFoots(quote);
});

test("a single-line quote agrees with the line it contains", () => {
  const line = priceLine(BANGLE_22K);
  const quote = priceQuote({ lines: [BANGLE_22K] });
  assert.equal(quote.taxablePaise, line.lineSubtotalPaise);
  assert.equal(quote.gstPaise, line.lineGstPaise);
  assert.equal(quote.totalPaise, line.lineTotalPaise);
  assertQuoteFoots(quote);
});

test("an empty quote is refused rather than priced at zero", () => {
  assert.throws(
    () => priceQuote({ lines: [] }),
    (error) => error instanceof PriceEngineError && error.code === "invalid_input"
  );
});

/* -------------------------------------------------------------------------
 * Fail closed. Bad inputs throw; nothing here quietly returns NaN.
 * ---------------------------------------------------------------------- */

const REJECTED = [
  ["a fractional weight", { ...BANGLE_22K, netMetalWeightMg: 12_345.5 }],
  ["a fractional rate", { ...BANGLE_22K, rate: { ...BANGLE_22K.rate, ratePerTenGramsPaise: 9_245_000.5 } }],
  ["a zero rate", { ...BANGLE_22K, rate: { ...BANGLE_22K.rate, ratePerTenGramsPaise: 0 } }],
  ["a negative stone value", { ...BANGLE_22K, stoneValuePaise: -1 }],
  ["a fractional making charge", { ...BANGLE_22K, makingCharge: { type: "flat", value: 100.5 } }],
  ["a zero weight", { ...BANGLE_22K, netMetalWeightMg: 0 }],
  ["a zero quantity", { ...BANGLE_22K, quantity: 0 }],
  ["a fractional quantity", { ...BANGLE_22K, quantity: 1.5 }],
  ["a fineness above 1000", { ...BANGLE_22K, fineness: 1_001, rate: { ...BANGLE_22K.rate, fineness: 1_001 } }],
  ["NaN anywhere", { ...BANGLE_22K, stoneValuePaise: Number.NaN }],
];

for (const [what, input] of REJECTED) {
  test(`${what} is refused`, () => {
    assert.throws(
      () => priceLine(input),
      (error) => error instanceof PriceEngineError && error.code === "invalid_input"
    );
  });
}

test("a discount larger than the line is refused, not turned into a negative price", () => {
  assert.throws(
    () => priceLine({ ...BANGLE_22K, lineDiscountPaise: 99_999_999 }),
    (error) => error instanceof PriceEngineError && error.code === "invalid_input"
  );
});

test("a discount equal to the whole line is allowed and still foots", () => {
  const line = priceLine({ ...BANGLE_22K, lineDiscountPaise: 12_787_007 });
  assert.equal(line.lineSubtotalPaise, 0);
  assert.equal(line.lineGstPaise, 0);
  assert.equal(line.lineTotalPaise, 0);
  assertLineFoots(line);
});

/* -------------------------------------------------------------------------
 * No floats in the money path.
 * ---------------------------------------------------------------------- */

test("a Rs 1 crore order is still exact to the paise", () => {
  // 1 kg of 22K at Rs 92,450 per 10 g, 15% making.
  const line = priceLine({
    pricingMode: "dynamic_metal",
    rate: { metal: "gold", fineness: 916, ratePerTenGramsPaise: 9_245_000 },
    metal: "gold",
    fineness: 916,
    netMetalWeightMg: 1_000_000,
    makingCharge: { type: "percent", value: 1_500 },
    hallmarkingPaise: BIS_HALLMARKING_GOLD_PAISE,
  });

  assert.equal(line.unit.metalValuePaise, 924_500_000);
  assert.equal(line.unit.makingChargePaise, 138_675_000);
  assert.equal(line.unit.unitPricePaise, 1_063_179_500);
  assert.equal(line.lineGstPaise, 31_895_385);
  assert.equal(line.lineTotalPaise, 1_095_074_885);
  assertLineFoots(line);
});

test("a figure that would leave the exact-integer range throws instead of drifting", () => {
  assert.throws(
    () =>
      priceLine({
        pricingMode: "dynamic_metal",
        rate: { metal: "gold", fineness: 916, ratePerTenGramsPaise: 90_000_000 },
        metal: "gold",
        fineness: 916,
        netMetalWeightMg: 2_000_000_000_000,
        hallmarkingPaise: 0,
      }),
    (error) => error instanceof PriceEngineError && error.code === "overflow"
  );
});

test("every money figure a quote returns is an exact integer", () => {
  const quote = priceQuote({
    lines: [{ ...BANGLE_22K, quantity: 7 }, POLKI_18K, COIN_995],
    shippingPaise: 99_999,
  });

  for (const [key, value] of Object.entries(quote)) {
    if (typeof value === "number") {
      assert.ok(Number.isSafeInteger(value), `${key} = ${value} must be an exact integer`);
    }
  }
  assertQuoteFoots(quote);
});
