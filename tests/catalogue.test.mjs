/**
 * The catalogue: the data layer, the seed, and the listing at /shop.
 *
 * THREE KINDS OF TEST, ON PURPOSE
 *
 *  1. DATA LAYER, imported directly. `app/_data/catalogue.ts` takes an
 *     injectable rate reader, so every arm of the fail-closed rate union — live,
 *     stale, never recorded, store down — is exercised without a database and
 *     without a clock. This is where "a stale rate must never render as a
 *     number" is actually proved.
 *
 *  2. THE SEED, applied to a REAL SQLite database built from the project's own
 *     migration, twice. That proves idempotency against the actual CHECK
 *     constraints in db/schema.ts rather than against a mock of them. Nothing
 *     here touches `.wrangler` or D1: the database is `:memory:`.
 *
 *  3. THE RENDERED PAGE, driven through the built Worker like the other route
 *     tests. There is no D1 binding in-process, so this also proves the listing
 *     serves the catalogue when the database is unreachable instead of 500ing.
 *
 * `scripts/seed-catalogue.mjs` is imported before the data layer because it
 * registers the module hooks that let plain Node resolve the TypeScript module
 * graph (`../../db` -> `db/index.ts`, `cloudflare:workers` -> the test stub).
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildSeedSql, sqlLiteral } from "../scripts/seed-catalogue.mjs";
import { renderPage } from "./helpers.mjs";

const {
  CATALOGUE_COLLECTIONS,
  CATALOGUE_SEED,
  CATALOGUE_SEED_ROWS,
  PRICE_BANDS,
  catalogueFacets,
  catalogueHref,
  formatPricePaise,
  isFiltered,
  listCatalogue,
  listPricedCatalogue,
  matchesPriceFilter,
  parseCatalogueFilter,
  priceCataloguePieces,
  toFineness,
  withoutFilter,
} = await import("../app/_data/catalogue.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* =========================================================================
 * 1. The data layer
 * ====================================================================== */

/** A `gold_rates` row as `readCurrentRate` hands it back on the `ok: true` arm. */
function usableRate(overrides = {}) {
  return {
    ok: true,
    rate: {
      id: "rate_test",
      metal: "gold",
      fineness: 916,
      ratePerTenGramsPaise: 13_705_300, // ₹1,37,053 per 10 g — IBJA, 2026-08-07.
      source: "ibja",
      sourceRef: "ibja:2026-08-07T11:35:00.000Z",
      sourceQuoteRaw: "137053",
      effectiveFrom: "2026-08-07T11:35:00.000Z",
      expiresAt: "2026-08-08T08:05:00.000Z",
      ageMinutes: 30,
      ...overrides,
    },
  };
}

/** A piece with real pricing inputs, for the arms the placeholder seed cannot reach. */
function pricedInputPiece(overrides = {}) {
  return {
    ...CATALOGUE_SEED[0],
    slug: "test-dynamic",
    pricingMode: "dynamic_metal",
    metal: "gold",
    fineness: 916,
    netMetalWeightMg: 12_345,
    makingChargeType: "percent",
    makingChargeValue: 1200,
    ...overrides,
  };
}

test("serves the compiled seed when D1 is unreachable", async () => {
  // There is no DB binding in-process, so `getDb()` throws. Five placeholder
  // pieces is not a reason to serve a 500.
  const pieces = await listCatalogue();
  assert.equal(pieces.length, 5);
  assert.deepEqual(
    pieces.map((piece) => piece.slug),
    [
      "jadau-haar",
      "polki-choker",
      "chandbali-earrings",
      "kundan-kada",
      "maang-tikka",
    ]
  );
});

test("invents no weight, purity, hallmark or certificate", () => {
  for (const piece of CATALOGUE_SEED) {
    assert.equal(piece.pricingMode, "on_request", `${piece.slug} must be priced on request`);
    assert.equal(piece.netMetalWeightMg, null, `${piece.slug} asserts a net weight`);
    assert.equal(piece.grossWeightMg, null, `${piece.slug} asserts a gross weight`);
    assert.equal(piece.fineness, null, `${piece.slug} asserts a fineness`);
    assert.equal(piece.makingChargeType, null, `${piece.slug} asserts a making charge`);
    assert.equal(piece.makingChargeValue, null, `${piece.slug} asserts a making charge`);
    assert.equal(piece.fixedPricePaise, null, `${piece.slug} asserts a price`);

    // A HUID is a government-issued identifier and a certificate number is a
    // lab's. Inventing either is a fake credential, not a placeholder.
    assert.equal(piece.huid, null, `${piece.slug} carries a fabricated HUID`);
    assert.equal(piece.hallmarkPurityMark, null, `${piece.slug} carries a fabricated hallmark`);
    assert.equal(piece.certificateNumber, null, `${piece.slug} carries a fabricated certificate`);
    assert.equal(piece.certificateLab, null, `${piece.slug} names a lab that never saw it`);

    // QCO cl. 2(3) exempts Kundan, Polki and Jadau, so a hallmarking charge of
    // zero is the correct figure and not an unfilled blank.
    assert.equal(piece.hallmarkingPaise, 0);

    assert.equal(piece.isUniquePiece, true);
    assert.equal(piece.stockQuantity, 1);
  }
});

test("every piece has a photographed face and reverse with its own alt text", () => {
  for (const piece of CATALOGUE_SEED) {
    assert.ok(piece.mediaKey.front, `${piece.slug} has no front image`);
    assert.ok(piece.mediaKey.back, `${piece.slug} has no reverse image`);
    assert.ok(piece.alt.length > 20, `${piece.slug} has thin alt text`);
    assert.ok(piece.altBack && piece.altBack.length > 20, `${piece.slug} has thin reverse alt`);
    assert.notEqual(piece.alt, piece.altBack, `${piece.slug} reuses one alt for both sides`);
  }
});

test("an on-request piece resolves to no price, and says so", async () => {
  const [priced] = await priceCataloguePieces([CATALOGUE_SEED[0]], {
    readRate: async () => {
      throw new Error("the rate must not be read for an on-request piece");
    },
  });

  assert.equal(priced.price, null);
  assert.equal(priced.priceUnavailableReason, "on_request");
});

test("a live rate prices a dynamic piece, and the breakup foots", async () => {
  const [priced] = await priceCataloguePieces([pricedInputPiece()], {
    readRate: async () => usableRate(),
  });

  assert.notEqual(priced.price, null);
  assert.equal(priced.priceUnavailableReason, null);

  // Derived by hand from the rules in app/_pricing/price.ts:
  //   metal  = roundHalfUp(13,705,300 x 12,345 / 10,000) = 16,919,193
  //   making = roundHalfUp(16,919,193 x 1200 / 10,000)   =  2,030,303
  //   GST    = roundHalfUp(18,949,496 x  300 / 10,000)   =    568,485
  assert.equal(priced.price.totalPaise, 19_517_981);
  assert.equal(formatPricePaise(priced.price.totalPaise), "₹1,95,179.81");

  const summed = priced.price.breakup.reduce((total, row) => total + row.amountPaise, 0);
  assert.equal(summed, priced.price.totalPaise, "the breakup must sum to the total");

  // The "as of" is the rate's own effective instant, not the time of render.
  assert.equal(priced.price.rateAsOf, "2026-08-07T11:35:00.000Z");
});

test("a STALE rate renders as no price — never a stale number, never a zero", async () => {
  const [priced] = await priceCataloguePieces([pricedInputPiece()], {
    // This is the shape rates.ts returns when the next IBJA publication came and
    // went without one. It has NO `rate` property at all, so there is nothing
    // here that could be read as a figure.
    readRate: async () => ({
      ok: false,
      reason: "rate_stale",
      message: "stale",
      unusableRate: {
        id: "rate_old",
        metal: "gold",
        fineness: 916,
        ratePerTenGramsPaise: 13_086_300,
        source: "ibja",
        sourceRef: null,
        sourceQuoteRaw: null,
        effectiveFrom: "2026-07-30T11:35:00.000Z",
        expiresAt: "2026-07-31T08:05:00.000Z",
      },
    }),
  });

  assert.equal(priced.price, null);
  assert.equal(priced.priceUnavailableReason, "rate_stale");
});

test("a missing or unreadable rate also fails closed", async () => {
  for (const reason of ["no_rate_recorded", "rate_store_unavailable", "rate_unreadable"]) {
    const [priced] = await priceCataloguePieces([pricedInputPiece()], {
      readRate: async () => ({ ok: false, reason, message: reason }),
    });
    assert.equal(priced.price, null, `${reason} produced a price`);
    assert.equal(priced.priceUnavailableReason, "rate_missing");
  }
});

test("a price band never treats an unpriced piece as zero", () => {
  const unpriced = { ...CATALOGUE_SEED[0], price: null, priceUnavailableReason: "on_request" };

  // "Under ₹1 lakh" must NOT sweep up every piece whose price we could not
  // resolve. Price on request is not free.
  assert.equal(matchesPriceFilter(unpriced, { maxPaise: 9_999_999 }), false);
  assert.equal(matchesPriceFilter(unpriced, { minPaise: 0 }), false);
  // With no band asked for, it is shown.
  assert.equal(matchesPriceFilter(unpriced, {}), true);
});

test("the rate is read once per metal and fineness, not once per piece", async () => {
  const calls = [];
  await priceCataloguePieces(
    [
      pricedInputPiece({ slug: "a" }),
      pricedInputPiece({ slug: "b" }),
      pricedInputPiece({ slug: "c", fineness: 750 }),
    ],
    {
      readRate: async (metal, fineness) => {
        calls.push(`${metal}:${fineness}`);
        return usableRate({ fineness });
      },
    }
  );

  assert.deepEqual(calls.sort(), ["gold:750", "gold:916"]);
});

/* --- Filters ------------------------------------------------------------ */

test("parses a query string into a filter, dropping anything unknown", () => {
  const { filter, query } = parseCatalogueFilter({
    metal: "GOLD",
    purity: "916",
    collection: "bridal",
    price: "1l-3l",
  });

  assert.deepEqual(filter, {
    metal: "gold",
    fineness: 916,
    collection: "bridal",
    minPaise: 10_000_000,
    maxPaise: 29_999_999,
  });
  assert.equal(query.purity, "916");
  assert.equal(isFiltered(query), true);

  // A stale bookmark shows the catalogue rather than an error.
  const junk = parseCatalogueFilter({
    purity: "24K",
    collection: "does-not-exist",
    price: "free",
  });
  assert.deepEqual(junk.filter, {});
  assert.equal(isFiltered(junk.query), false);
});

test("a filter is a real URL, and removing one is a link", () => {
  const { query } = parseCatalogueFilter({ metal: "gold", collection: "earrings" });
  assert.equal(catalogueHref(query), "/shop?metal=gold&collection=earrings");
  assert.equal(catalogueHref(withoutFilter(query, "metal")), "/shop?collection=earrings");
  assert.equal(
    catalogueHref(withoutFilter(withoutFilter(query, "metal"), "collection")),
    "/shop"
  );
});

test("filters the catalogue by collection and by metal", async () => {
  const earrings = await listPricedCatalogue({ collection: "earrings" });
  assert.deepEqual(
    earrings.map((piece) => piece.slug),
    ["chandbali-earrings"]
  );

  const bridal = await listPricedCatalogue({ collection: "bridal" });
  assert.equal(bridal.length, 5);

  assert.equal((await listPricedCatalogue({ metal: "gold" })).length, 5);
  assert.equal((await listPricedCatalogue({ metal: "silver" })).length, 0);
});

test("facets are derived from the data, never hard-coded", async () => {
  const facets = catalogueFacets(await listCatalogue());

  assert.deepEqual(facets.metals, ["gold"]);
  // Nothing has been assayed, so the purity control has nothing honest to offer.
  assert.deepEqual(facets.finenesses, []);
  assert.deepEqual(
    facets.collections.map((collection) => collection.slug),
    ["necklaces", "earrings", "bangles", "headpieces", "jadau-polki", "kundan", "meenakari", "bridal"]
  );
});

test("fineness is narrowed, not cast", () => {
  assert.equal(toFineness(916), 916);
  assert.equal(toFineness(995), 995);
  assert.equal(toFineness(917), null);
  assert.equal(toFineness(null), null);
  assert.equal(toFineness(Number.NaN), null);
});

/* =========================================================================
 * 2. The seed, against the project's own migration
 * ====================================================================== */

function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");

  const dir = path.join(ROOT, "drizzle");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no migration to test the seed against");

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) db.exec(statement);
    }
  }

  return db;
}

function applySeed(db) {
  db.exec("BEGIN");
  for (const statement of buildSeedSql({ now: "2026-08-09T00:00:00.000Z" })) {
    db.exec(statement);
  }
  db.exec("COMMIT");
}

test("the seed applies to the real schema, and is idempotent", () => {
  const db = migratedDatabase();
  try {
    applySeed(db);
    const first = {
      products: db.prepare("SELECT count(*) AS c FROM products").get().c,
      variants: db.prepare("SELECT count(*) AS c FROM variants").get().c,
      collections: db.prepare("SELECT count(*) AS c FROM collections").get().c,
      memberships: db.prepare("SELECT count(*) AS c FROM product_collections").get().c,
    };
    assert.deepEqual(first, { products: 5, variants: 5, collections: 8, memberships: 20 });

    // Twice, and then a third time, must leave exactly the same rows. Every
    // statement is an upsert keyed on a deterministic id.
    applySeed(db);
    applySeed(db);

    assert.deepEqual(
      {
        products: db.prepare("SELECT count(*) AS c FROM products").get().c,
        variants: db.prepare("SELECT count(*) AS c FROM variants").get().c,
        collections: db.prepare("SELECT count(*) AS c FROM collections").get().c,
        memberships: db.prepare("SELECT count(*) AS c FROM product_collections").get().c,
      },
      first
    );

    // created_at is written once and never rewritten.
    const created = db.prepare("SELECT created_at FROM products WHERE id = 'prd_jadau-haar'").get();
    assert.equal(created.created_at, "2026-08-09T00:00:00.000Z");
  } finally {
    db.close();
  }
});

test("the seeded rows leave every compliance column NULL", () => {
  const db = migratedDatabase();
  try {
    applySeed(db);
    const rows = db
      .prepare(
        `SELECT sku, pricing_mode, fineness, net_metal_weight_mg, gross_weight_mg,
                making_charge_type, making_charge_value, fixed_price_paise,
                huid, hallmark_purity_mark, certificate_number, certificate_lab,
                hallmarking_paise, is_unique_piece, stock_quantity
         FROM variants`
      )
      .all();

    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.pricing_mode, "on_request", `${row.sku} is not on request`);
      for (const column of [
        "fineness",
        "net_metal_weight_mg",
        "gross_weight_mg",
        "making_charge_type",
        "making_charge_value",
        "fixed_price_paise",
        "huid",
        "hallmark_purity_mark",
        "certificate_number",
        "certificate_lab",
      ]) {
        assert.equal(row[column], null, `${row.sku} asserts ${column}`);
      }
      assert.equal(row.hallmarking_paise, 0, `${row.sku} charges for a hallmark it does not have`);
      assert.equal(row.is_unique_piece, 1);
      assert.equal(row.stock_quantity, 1);
    }
  } finally {
    db.close();
  }
});

test("a membership dropped from the seed is dropped from the database", () => {
  const db = migratedDatabase();
  try {
    applySeed(db);
    // Something the seed does not declare, added by hand, is cleaned up on the
    // next run — which is what makes re-running after an edit truly idempotent.
    db.exec(
      "INSERT INTO product_collections (product_id, collection_id, position) VALUES ('prd_maang-tikka', 'col_necklaces', 99);"
    );
    assert.equal(db.prepare("SELECT count(*) AS c FROM product_collections").get().c, 21);
    applySeed(db);
    assert.equal(db.prepare("SELECT count(*) AS c FROM product_collections").get().c, 20);
  } finally {
    db.close();
  }
});

test("every seeded collection is one the catalogue declares", () => {
  const known = new Set(CATALOGUE_COLLECTIONS.map((collection) => collection.slug));
  for (const row of CATALOGUE_SEED_ROWS) {
    for (const slug of row.piece.collections) {
      assert.ok(known.has(slug), `"${row.piece.slug}" is in an undeclared collection "${slug}"`);
    }
  }
});

test("SQL literals are escaped rather than concatenated", () => {
  assert.equal(sqlLiteral("Jadau haar"), "'Jadau haar'");
  assert.equal(sqlLiteral("l'or"), "'l''or'");
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral(true), "1");
  assert.equal(sqlLiteral(0), "0");
  assert.throws(() => sqlLiteral(1.5), /non-integer/);
});

/* =========================================================================
 * 3. The rendered listing
 * ====================================================================== */

const rendered = new Map();
async function shop(query = "") {
  if (!rendered.has(query)) rendered.set(query, await renderPage(`/shop${query}`));
  return rendered.get(query);
}

/**
 * React emits a `<!-- -->` separator between literal text and an interpolated
 * value, so "Showing 1 of 5" is not one string in the markup.
 */
function showing(shown, total) {
  const gap = "(?:<!-- -->)?";
  return new RegExp(`Showing ${gap}${shown}${gap} of ${gap}${total}${gap}`);
}

test("serves /shop as HTML with one h1 and its own metadata", async () => {
  const response = await renderPage("/shop", { raw: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const body = await shop();
  assert.equal((body.match(/<h1/g) ?? []).length, 1, "expected exactly one h1");
  assert.match(body, /<title>The catalogue \| Alankar Jewellers<\/title>/);
  assert.match(body, /<link rel="canonical" href="https:\/\/[^"]*\/shop"/);
});

test("server-renders every piece, both sides, with intrinsic dimensions", async () => {
  const body = await shop();

  for (const piece of CATALOGUE_SEED) {
    assert.ok(body.includes(piece.title), `missing ${piece.title}`);
    assert.ok(body.includes(piece.spec), `missing the spec line for ${piece.slug}`);
    assert.match(body, new RegExp(`href="/shop/${piece.slug}"`), `no link to ${piece.slug}`);
    assert.ok(body.includes(`${piece.mediaKey.front}-1400.webp`), `no face image for ${piece.slug}`);
    assert.ok(body.includes(`${piece.mediaKey.back}-1400.webp`), `no reverse image for ${piece.slug}`);
  }

  const imgs = body.match(/<img\b[^>]*>/g) ?? [];
  assert.equal(imgs.length, 10, `expected 5 faces and 5 reverses, found ${imgs.length}`);
  for (const img of imgs) {
    assert.match(img, /\bwidth="\d+"/, `image without width (causes CLS): ${img}`);
    assert.match(img, /\bheight="\d+"/, `image without height (causes CLS): ${img}`);
    assert.match(img, /\bsrcSet="|\bsrcset="/, `image without a srcset: ${img}`);
    assert.match(img, /\balt="/, `image without an alt attribute: ${img}`);
  }

  // Nothing on a catalogue page is the LCP hero, so nothing is eager.
  assert.equal(
    imgs.filter((tag) => !/loading="lazy"/.test(tag)).length,
    0,
    "every catalogue image below the fold must be lazy"
  );
});

test("prints price on request, and never a figure it does not have", async () => {
  const body = await shop();

  // The RSC payload is inlined alongside the HTML, so every string appears
  // twice. Five cards is therefore a floor, not an exact count.
  assert.ok(
    (body.match(/Price on request/g) ?? []).length >= 5,
    "every placeholder piece must say price on request"
  );
  // The priced variant of the figure must not appear at all: nothing here has
  // a price, so nothing may render one.
  assert.doesNotMatch(body, /class="shop-card__figure"/, "a figure was rendered for an unpriced piece");
  assert.doesNotMatch(body, /₹\s*0\b/, "a zero price must never be rendered");
  assert.doesNotMatch(body, /\bHUID\b/i, "no HUID may appear while none is recorded");
  assert.doesNotMatch(body, /\b\d+(\.\d+)?\s?(g|gm|grams)\b/, "no weight may be asserted");
  assert.doesNotMatch(body, /\b\d{2}K\b/, "no karat may be asserted");

  // The page says out loud that this is placeholder inventory.
  assert.match(body, /Placeholder catalogue/);
  assert.match(body, /none of those has been recorded/);
});

test("filters work with a plain GET form — no JavaScript involved", async () => {
  const body = await shop();

  assert.match(body, /<form[^>]*action="\/shop"[^>]*method="get"/);
  for (const name of ["metal", "purity", "collection", "price"]) {
    assert.match(body, new RegExp(`<select[^>]*name="${name}"`), `no ${name} control`);
  }
  assert.match(body, /<button[^>]*type="submit"/, "the form needs a real submit button");

  // The purity control is disabled and says why, rather than offering karat
  // options against inventory nobody has assayed.
  assert.match(body, /<select[^>]*name="purity"[^>]*disabled/);
  assert.match(body, /No piece has a recorded fineness yet/);
});

test("a collection filter narrows the wall and offers a way back", async () => {
  const body = await shop("?collection=earrings");

  assert.ok(body.includes("Chandbali earrings"));
  assert.ok(!body.includes("Kundan kada"), "the filter did not narrow anything");
  assert.match(body, showing(1, 5));
  // The chip is a link that removes the filter, so it works without script,
  // and it names the collection rather than echoing its slug back.
  assert.match(body, /href="\/shop"/);
  assert.match(body, /Earrings<span class="shop-chip__x"/);
  assert.match(body, /Clear all filters/);
});

test("an unknown filter value shows the catalogue rather than an error", async () => {
  const response = await renderPage("/shop?collection=not-a-collection&purity=24K", {
    raw: true,
  });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, showing(5, 5));
});

test("a price band excludes on-request pieces and explains itself", async () => {
  const body = await shop("?price=1l-3l");

  assert.match(body, showing(0, 5));
  assert.match(body, /Nothing on the wall matches that/);
  assert.match(body, /priced on request/);
  assert.doesNotMatch(body, /₹\s*0\b/);

  // Every band the form offers is a key the parser accepts.
  for (const band of PRICE_BANDS) {
    const parsed = parseCatalogueFilter({ price: band.key });
    assert.equal(parsed.query.price, band.key, `band ${band.key} is not parseable`);
  }
});

test("a filtered view is not offered to crawlers", async () => {
  const body = await shop("?collection=bridal");
  assert.match(body, /<meta name="robots" content="[^"]*noindex/);

  const unfiltered = await shop();
  assert.doesNotMatch(unfiltered, /<meta name="robots" content="[^"]*noindex/);
});
