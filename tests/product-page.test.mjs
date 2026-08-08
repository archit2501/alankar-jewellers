/**
 * Product-page tests — task 2.1.2.
 *
 * TWO LAYERS, ON PURPOSE
 *
 * 1. THE GATE, unit tested. `app/_seo/product-schema.ts` decides what may be
 *    said about a piece — to a reader and to a crawler alike — and the page has
 *    no second opinion. Every criterion that is about honesty (the null
 *    compliance fields, the price that must never appear as a zero, the Offer
 *    that must hang off the existing business node) is asserted there against
 *    both a placeholder piece and a fully documented one, because the documented
 *    case cannot be reached through the route yet.
 *
 * 2. THE ROUTE, rendered. `tests/helpers.mjs` drives the built Worker
 *    in-process with no D1 binding; `readCatalogue()` treats a thrown binding
 *    as "D1 cannot answer" and falls back to the compiled seed, so /shop/<slug>
 *    really does render here — against the five placeholder pieces the site
 *    ships with, every one of them unweighed, unhallmarked and priced on
 *    request. That is precisely the state these rules exist for.
 *
 * The one case neither layer reaches is a rendered breakup: no seed piece has a
 * computable price, and a rate cannot be injected through the Worker boundary.
 * The breakup's arithmetic is `tests/price-engine.test.mjs`; its formatting is
 * unit tested below.
 *
 * The gate module imports its siblings without file extensions, which is
 * correct for the bundler and unresolvable under plain Node ESM, so this file
 * registers a resolve hook of its own rather than editing the shared
 * `tests/setup.mjs`. `node --test` runs each test file in its own process, so
 * the hook is local to this one.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";

import { fetchWorker, renderPage } from "./helpers.mjs";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.(m?[jt]sx?|json|css)$/.test(specifier)) {
      const candidate = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(candidate)) {
        return { url: candidate.href, shortCircuit: true };
      }
    }
    return nextResolve(specifier, context);
  },
});

const {
  disclosures,
  formatGrams,
  formatRupees,
  gramsDecimal,
  productJsonLd,
  productPath,
  productUrl,
  rupeesDecimal,
} = await import("../app/_seo/product-schema.ts");

const { jewelryStoreJsonLd, serializeJsonLd } = await import(
  "../app/_seo/structured-data.ts"
);

/* -------------------------------------------------------------------------
 * Fixtures. `placeholderPiece` is deliberately what the catalogue actually
 * holds today: real photographs, real copy, and every single compliance field
 * null because nothing has been weighed, hallmarked or certified yet.
 * ---------------------------------------------------------------------- */

function placeholderPiece(overrides = {}) {
  return {
    id: "piece_01HZ",
    slug: "jadau-haar",
    title: "Jadau haar",
    subtitle: null,
    description: null,
    spec: "Uncut polki · carved ruby and emerald drops · silk cord",
    pricingMode: "on_request",
    fineness: null,
    metal: "gold",
    netMetalWeightMg: null,
    grossWeightMg: null,
    makingChargeType: null,
    makingChargeValue: null,
    stoneValuePaise: 0,
    hallmarkingPaise: 0,
    otherChargesPaise: 0,
    fixedPricePaise: null,
    huid: null,
    hallmarkPurityMark: null,
    certificateNumber: null,
    certificateLab: null,
    stockQuantity: 1,
    isUniquePiece: true,
    mediaKey: { front: "jadau-haar-front", back: "jadau-haar-reverse" },
    alt: "Jadau haar of uncut polki closed-set in gold",
    altBack: "The same haar turned over, enamelled on a red ground",
    collections: [],
    price: null,
    priceUnavailableReason: "on_request",
    ...overrides,
  };
}

/** The same piece once the shop has actually done the paperwork. */
function documentedPiece(overrides = {}) {
  return placeholderPiece({
    pricingMode: "dynamic_metal",
    fineness: 916,
    netMetalWeightMg: 18500,
    grossWeightMg: 21250,
    huid: "AZ4567",
    hallmarkPurityMark: "22K916",
    certificateNumber: "IGI-2026-114233",
    certificateLab: "IGI",
    collections: ["Bridal"],
    price: {
      totalPaise: 123456789,
      breakup: [
        { label: "22K Gold", amountPaise: 100000000 },
        { label: "Making charges", amountPaise: 20000000 },
        { label: "GST", amountPaise: 3456789 },
      ],
      rateAsOf: "2026-08-09",
    },
    priceUnavailableReason: null,
    ...overrides,
  });
}

/** Every leaf of an object graph, with the path that reached it. */
function leaves(value, path = "$", out = []) {
  if (Array.isArray(value)) {
    assert.ok(value.length > 0, `${path} is an empty array`);
    value.forEach((entry, index) => leaves(entry, `${path}[${index}]`, out));
  } else if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    assert.ok(entries.length > 0, `${path} is an empty object`);
    for (const [key, entry] of entries) {
      leaves(entry, `${path}.${key}`, out);
    }
  } else {
    out.push([path, value]);
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Money. The price engine computes in bigint so an invoice foots; formatting
 * is where that is usually thrown away by a float division.
 * ---------------------------------------------------------------------- */

test("rupees are formatted with Indian digit grouping, to the paise", () => {
  assert.equal(formatRupees(0), "₹0.00");
  assert.equal(formatRupees(1), "₹0.01");
  assert.equal(formatRupees(99), "₹0.99");
  assert.equal(formatRupees(100), "₹1.00");
  assert.equal(formatRupees(100000), "₹1,000.00");

  // The boundary western grouping gets wrong: a lakh is 1,00,000, not 100,000.
  assert.equal(formatRupees(10000000), "₹1,00,000.00");
  assert.equal(formatRupees(123456789), "₹12,34,567.89");
  assert.equal(formatRupees(1234567890123), "₹12,34,56,78,901.23");
});

test("a negative component keeps its sign rather than becoming a smaller number", () => {
  // A discount arrives from the engine as a negative component.
  assert.equal(formatRupees(-50000), "−₹500.00");
});

test("a fractional or unsafe paise figure is refused, not rounded", () => {
  assert.throws(() => formatRupees(1.5), /safe integer/);
  assert.throws(() => formatRupees(Number.NaN), /safe integer/);
  assert.throws(() => rupeesDecimal(2 ** 53), /safe integer/);
});

test("schema.org prices are bare two-place decimals", () => {
  assert.equal(rupeesDecimal(0), "0.00");
  assert.equal(rupeesDecimal(5), "0.05");
  assert.equal(rupeesDecimal(123456789), "1234567.89");
  // No separators: "12,34,567.89" is not a number to a crawler.
  assert.doesNotMatch(rupeesDecimal(123456789), /,/);
});

test("milligrams become grams exactly, at the stored precision", () => {
  assert.equal(formatGrams(18500), "18.500 g");
  assert.equal(formatGrams(5), "0.005 g");
  assert.equal(formatGrams(0), "0.000 g");
  assert.equal(gramsDecimal(1000000), "1000.000");
  assert.throws(() => formatGrams(-1), /negative/);
});

/* -------------------------------------------------------------------------
 * The disclosure gate
 * ---------------------------------------------------------------------- */

test("every disclosure row is either a value or a sentence — never blank", () => {
  for (const piece of [placeholderPiece(), documentedPiece()]) {
    const rows = disclosures(piece);
    assert.ok(rows.length >= 8, `expected the full record, got ${rows.length} rows`);
    for (const row of rows) {
      assert.ok(row.label.trim().length > 0, `row ${row.key} has no label`);
      assert.ok(
        row.pending.trim().length > 0,
        `row ${row.key} has no wording for a missing value`
      );
      assert.ok(
        row.value === null || row.value.trim().length > 0,
        `row ${row.key} renders as an empty string`
      );
      // A dash, an "N/A" or a "—" is the failure this rule exists to prevent.
      assert.doesNotMatch(row.pending, /^[-–—\s]*$/);
    }
  }
});

test("weight, purity, HUID and certification are all present as rows", () => {
  const keys = disclosures(placeholderPiece()).map((row) => row.key);
  for (const key of [
    "purity",
    "grossWeight",
    "netWeight",
    "huid",
    "hallmarkMark",
    "certificate",
    "certificateLab",
  ]) {
    assert.ok(keys.includes(key), `the record must disclose ${key}`);
  }
});

test("a missing HUID reads as not yet hallmarked, never as a blank or a number", () => {
  const huid = disclosures(placeholderPiece()).find((row) => row.key === "huid");
  assert.equal(huid.value, null);
  assert.match(huid.pending, /not yet hallmarked/i);
  assert.match(huid.pending, /HUID/);
  // Nothing that could be mistaken for an actual six-character HUID.
  assert.doesNotMatch(huid.pending, /\b[A-Z0-9]{6}\b/);
});

test("an unweighed, uncertified piece says so on every one of those rows", () => {
  const rows = disclosures(placeholderPiece());
  const pending = Object.fromEntries(rows.map((row) => [row.key, row]));

  assert.equal(pending.grossWeight.value, null);
  assert.match(pending.grossWeight.pending, /not yet weighed/i);
  assert.equal(pending.netWeight.value, null);
  assert.match(pending.netWeight.pending, /not yet weighed/i);
  assert.equal(pending.certificate.value, null);
  assert.match(pending.certificate.pending, /not yet certified/i);
  assert.equal(pending.certificateLab.value, null);
  assert.equal(pending.purity.value, null);
  assert.match(pending.purity.pending, /not assayed/i);
});

test("a documented piece prints its real figures", () => {
  const rows = disclosures(documentedPiece());
  const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));

  assert.equal(values.metal, "Gold");
  assert.equal(values.purity, "22K (916)");
  assert.equal(values.grossWeight, "21.250 g");
  assert.equal(values.netWeight, "18.500 g");
  assert.equal(values.huid, "AZ4567");
  assert.equal(values.certificate, "IGI-2026-114233");
  assert.equal(values.certificateLab, "IGI");
});

test("995 fineness is never rounded up into 24K on the page", () => {
  // The exact mis-statement the price engine's karat lookup table exists to
  // prevent: 995 x 24 / 1000 = 23.88, which rounds to a lie.
  const rows = disclosures(documentedPiece({ fineness: 995 }));
  const purity = rows.find((row) => row.key === "purity");
  assert.equal(purity.value, "995 fineness");
  assert.doesNotMatch(purity.value, /24K/);
});

test("a piece with no priceable metal states that rather than inventing one", () => {
  const rows = disclosures(documentedPiece({ metal: "none", fineness: null }));
  const metal = rows.find((row) => row.key === "metal");
  assert.equal(metal.value, null);
  assert.ok(metal.pending.length > 0);
});

/* -------------------------------------------------------------------------
 * Product / Offer JSON-LD
 * ---------------------------------------------------------------------- */

test("the product is a Product hung on the existing JewelryStore node", () => {
  const data = productJsonLd(documentedPiece());
  const business = jewelryStoreJsonLd();

  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "Product");
  assert.equal(data["@id"], `${productUrl("jadau-haar")}#product`);
  assert.equal(data.url, productUrl("jadau-haar"));
  assert.equal(productPath("jadau-haar"), "/shop/jadau-haar");
  assert.match(data["@id"], /^https:\/\//);

  // Referenced, never duplicated: one business entity with products attached,
  // not one copy of the shop per product page.
  assert.deepEqual(data.brand, { "@id": business["@id"] });
  assert.deepEqual(data.offers.seller, { "@id": business["@id"] });
  assert.equal(data.brand["@id"], `${business.url}/#jewellery-store`);
  assert.equal(Object.keys(data.brand).length, 1, "brand must be a bare reference");
});

test("images are absolute, and only the piece's own reverse is published", () => {
  const both = productJsonLd(documentedPiece());
  assert.equal(both.image.length, 2);
  for (const url of both.image) {
    assert.match(url, /^https:\/\/[^/]+\/images\/catalogue\//);
  }

  const frontOnly = productJsonLd(
    documentedPiece({ mediaKey: { front: "jadau-haar-front", back: null } })
  );
  assert.equal(frontOnly.image.length, 1);
});

test("a real price is published in full, GST included", () => {
  const { offers } = productJsonLd(documentedPiece());

  assert.equal(offers["@type"], "Offer");
  assert.equal(offers.price, "1234567.89");
  assert.equal(offers.priceCurrency, "INR");
  assert.equal(offers.valueAddedTaxIncluded, true);
  assert.equal(offers.availability, "https://schema.org/InStock");
  assert.equal(offers["@id"], `${productUrl("jadau-haar")}#offer`);
});

test("an unavailable price is OMITTED from the offer, never published as zero", () => {
  for (const reason of ["on_request", "rate_stale", "rate_missing"]) {
    const data = productJsonLd(
      documentedPiece({ price: null, priceUnavailableReason: reason })
    );
    const { offers } = data;

    // The gate. Same discipline as the contact facts in structured-data.ts:
    // absent beats fabricated.
    assert.ok(!("price" in offers), `price must be omitted for ${reason}`);
    assert.ok(!("priceCurrency" in offers), `currency must be omitted for ${reason}`);
    assert.ok(
      !("valueAddedTaxIncluded" in offers),
      `a tax claim without a price is meaningless (${reason})`
    );

    // The Offer itself survives: the seller and the availability are still true.
    assert.equal(offers["@type"], "Offer");
    assert.ok(offers.seller["@id"]);

    // And nothing anywhere in the document is a zero or a stale figure.
    const serialised = JSON.stringify(data);
    assert.doesNotMatch(serialised, /"price"/);
    assert.doesNotMatch(serialised, /"0\.00"/);
    assert.doesNotMatch(serialised, /1234567\.89/);
  }
});

test("out of stock is stated rather than implied by a missing field", () => {
  const { offers } = productJsonLd(documentedPiece({ stockQuantity: 0 }));
  assert.equal(offers.availability, "https://schema.org/OutOfStock");
});

test("unverified physical facts are omitted, not defaulted", () => {
  const data = productJsonLd(placeholderPiece());

  for (const field of [
    "weight",
    "additionalProperty",
    "aggregateRating",
    "review",
    "gtin",
    "gtin13",
    "mpn",
    "itemCondition",
    "priceValidUntil",
  ]) {
    assert.ok(!(field in data), `${field} must be absent for an undocumented piece`);
  }
  assert.ok(!("itemCondition" in data.offers), "condition has not been stated by anyone");
  assert.ok(!("priceValidUntil" in data.offers), "a rate-derived price has no stated window");
  assert.ok(!("category" in data), "an empty collection list is a broken signal");

  // The description falls back to the shop's own spec line, not to prose we
  // wrote on their behalf.
  assert.equal(data.description, placeholderPiece().spec);
});

test("documented facts arrive as properties, keyed the way a buyer would ask", () => {
  const data = productJsonLd(documentedPiece());

  assert.deepEqual(data.weight, {
    "@type": "QuantitativeValue",
    value: "21.250",
    unitCode: "GRM",
  });
  assert.equal(data.material, "Gold");
  assert.deepEqual(data.category, ["Bridal"]);

  const byId = Object.fromEntries(
    data.additionalProperty.map((property) => [property.propertyID, property.value])
  );
  assert.equal(byId.HUID, "AZ4567");
  assert.equal(byId.fineness, "916");
  assert.equal(byId.netMetalWeight, "18.500");
  assert.equal(byId.certificateNumber, "IGI-2026-114233");
  assert.equal(byId.certifyingLaboratory, "IGI");
});

test("the emitted graph carries no nulls, no empties and no placeholders", () => {
  for (const piece of [placeholderPiece(), documentedPiece()]) {
    for (const [path, value] of leaves(productJsonLd(piece))) {
      assert.notEqual(value, null, `${path} is null — omit the key instead`);
      assert.notEqual(value, undefined, `${path} is undefined`);
      if (typeof value === "string") {
        assert.ok(value.trim().length > 0, `${path} is an empty string`);
      }
    }
  }
});

test("the JSON-LD survives being embedded in a script tag", () => {
  const serialised = serializeJsonLd(
    productJsonLd(documentedPiece({ title: "Haar <script> & co" }))
  );

  assert.doesNotMatch(serialised, /</);
  assert.doesNotMatch(serialised, />/);
  assert.equal(JSON.parse(serialised).name, "Haar <script> & co");
});

/* -------------------------------------------------------------------------
 * The route
 * ---------------------------------------------------------------------- */

/**
 * There is no D1 binding in-process, and `readCatalogue()` falls back to the
 * compiled seed when the binding throws — so the route genuinely renders here,
 * against the same five placeholder pieces the site ships with. Every one of
 * them is `on_request` with no weights and no HUID, which is exactly the state
 * the honesty rules below exist for.
 */
let cached;
async function productHtml() {
  cached ??= await renderPage("/shop/jadau-haar");
  return cached;
}

/** The JSON-LD blocks in document order. The page's own comes before the layout's. */
function structuredData(body) {
  return [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(
    (match) =>
      JSON.parse(
        match[1].replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&")
      )
  );
}

test("serves a piece as HTML, with exactly one h1", async () => {
  const response = await renderPage("/shop/jadau-haar", { raw: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const body = await productHtml();
  assert.equal((body.match(/<h1/g) ?? []).length, 1, "expected exactly one h1");
  assert.match(body, /<h1[^>]*>Jadau haar<\/h1>/);
  assert.match(body, /<link rel="canonical" href="https:\/\/[^"]*\/shop\/jadau-haar"/);
});

test("an unknown slug is a 404, not an empty product page", async () => {
  const response = await fetchWorker("/shop/no-such-piece-exists", {
    headers: { accept: "text/html" },
  });
  assert.equal(response.status, 404);
  const body = await response.text();
  assert.doesNotMatch(body, /application\/ld\+json[\s\S]*"Product"/);
});

test("the reverse is hung at the same size as the face, not as a thumbnail", async () => {
  const body = await productHtml();
  const imgs = body.match(/<img\b[^>]*>/g) ?? [];
  assert.equal(imgs.length, 2, `the diptych is two plates, found ${imgs.length} images`);

  for (const img of imgs) {
    assert.match(img, /\bwidth="\d+"/, `image without width (causes CLS): ${img}`);
    assert.match(img, /\bheight="\d+"/, `image without height (causes CLS): ${img}`);
    assert.match(img, /\bsrcSet="/i, `image without a srcset: ${img}`);
    assert.match(img, /\balt="[^"]+"/, `image without alt text: ${img}`);
  }

  // Parity is the acceptance criterion: same intrinsic box, same declared
  // layout width. A smaller reverse is the afterthought thumbnail this page
  // exists to avoid.
  const widths = imgs.map((img) => img.match(/\bwidth="(\d+)"/)[1]);
  const sizes = imgs.map((img) => img.match(/\bsizes="([^"]+)"/)[1]);
  assert.equal(widths[0], widths[1], "face and reverse must share an intrinsic width");
  assert.equal(sizes[0], sizes[1], "face and reverse must be laid out at the same size");

  assert.match(body, /The face/);
  assert.match(body, /The reverse/);
  assert.match(body, /meenakari/i);

  // The reverse carries its own alt text, not the face's.
  const alts = imgs.map((img) => img.match(/\balt="([^"]+)"/)[1]);
  assert.notEqual(alts[0], alts[1]);
});

test("every compliance field is disclosed, and a missing one says so", async () => {
  const body = await productHtml();

  for (const label of [
    "Purity",
    "Gross weight",
    "Net metal weight",
    "HUID",
    "Hallmark purity mark",
    "Certificate",
    "Certifying laboratory",
  ]) {
    assert.ok(body.includes(label), `the record must disclose ${label}`);
  }

  assert.match(body, /Not yet hallmarked/);
  assert.match(body, /Not yet weighed/);
  assert.match(body, /Not yet certified/);
  assert.match(body, /Not assayed yet/);

  // An empty definition cell is the failure mode: a blank reads as "nothing to
  // declare" rather than "not established yet".
  assert.doesNotMatch(body, /<dd[^>]*><\/dd>/);
  // And no HUID-shaped string has been conjured to fill the row.
  assert.doesNotMatch(body, /HUID<\/dt><dd[^>]*>[A-Z0-9]{6}</);
});

test("a piece with no price shows no figure at all", async () => {
  const body = await productHtml();

  // The five seed pieces are all `on_request`, so there must be no money on
  // this page — and above all no zero standing in for a price.
  assert.doesNotMatch(body, /₹/, "no rupee figure may appear when there is no price");
  assert.doesNotMatch(body, /\b0\.00\b/);
  assert.match(body, /priced by hand/i, "the page must say WHY there is no price");
});

test("the page publishes Product/Offer hung on the layout's JewelryStore node", async () => {
  const body = await productHtml();
  const blocks = structuredData(body);
  assert.equal(blocks.length, 2, "expected the product node and the business node");

  const product = blocks.find((block) => block["@type"] === "Product");
  const business = blocks.find((block) => block["@type"] === "JewelryStore");
  assert.ok(product, "no Product node on the product page");
  assert.ok(business, "the business node must still be published");

  // One business entity with products attached, not a second copy per page.
  assert.equal(product.brand["@id"], business["@id"]);
  assert.equal(product.offers.seller["@id"], business["@id"]);
  assert.match(product.url, /^https:\/\/[^/]+\/shop\/jadau-haar$/);
  assert.equal(product.image.length, 2);

  // The gate, end to end: a piece with no price publishes no price.
  assert.ok(!("price" in product.offers));
  assert.ok(!("priceCurrency" in product.offers));
  assert.ok(!("aggregateRating" in product));
  assert.ok(!("weight" in product), "nothing has been weighed yet");
});
