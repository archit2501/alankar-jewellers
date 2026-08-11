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
  DEMONSTRATION_SLUGS,
  isDemonstrationPiece,
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

/**
 * How many `product_collections` rows the seed should produce, computed from the
 * seed rather than written down. The membership counts in this file used to be
 * literals, which meant adding a piece failed tests about idempotency — tests
 * that had nothing to say about the change and reported it as a regression.
 */
const SEEDED_MEMBERSHIPS = CATALOGUE_SEED.reduce(
  (total, piece) => total + piece.collections.length,
  0
);

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
  // There is no DB binding in-process, so `getDb()` throws. A placeholder
  // catalogue is not a reason to serve a 500.
  const pieces = await listCatalogue();
  assert.equal(pieces.length, CATALOGUE_SEED.length);
  assert.deepEqual(
    pieces.map((piece) => piece.slug),
    [
      "jadau-haar",
      "polki-choker",
      "chandbali-earrings",
      "kundan-kada",
      "maang-tikka",
      "gold-jhumka",
      "polki-ring",
      "lotus-pendant",
      "slim-kada",
      "rani-haar",
      "bridal-tikka",
      "jadau-kangan",
    ],
    "the fallback must serve the seed in wall order, heirlooms before demonstration stock"
  );
});

/**
 * The catalogue holds two populations with opposite rules, and the split is
 * DECLARED in `DEMONSTRATION_SLUGS` rather than detected. This asserts the
 * declaration matches reality in both directions, so neither
 *
 *   - a heirloom piece quietly acquiring a weight, nor
 *   - a fifth priced piece appearing without anyone deciding it should
 *
 * can pass. Checking `pricingMode` alone would be circular: the thing under
 * test is exactly whether a piece is allowed to be priced.
 */
test("the demonstration set is declared, and matches what is actually priced", () => {
  const priced = CATALOGUE_SEED.filter((p) => p.pricingMode !== "on_request").map((p) => p.slug);
  assert.deepEqual(
    [...priced].sort(),
    [...DEMONSTRATION_SLUGS].sort(),
    "a piece carries a price without being declared a demonstration piece (or vice versa)"
  );

  for (const slug of DEMONSTRATION_SLUGS) {
    assert.ok(
      CATALOGUE_SEED.some((p) => p.slug === slug),
      `DEMONSTRATION_SLUGS names "${slug}", which is not in the catalogue`
    );
  }
});

test("the heirloom pieces invent no weight, purity, hallmark or certificate", () => {
  for (const piece of CATALOGUE_SEED) {
    if (isDemonstrationPiece(piece.slug)) continue;

    assert.equal(piece.pricingMode, "on_request", `${piece.slug} must be priced on request`);
    assert.equal(piece.netMetalWeightMg, null, `${piece.slug} asserts a net weight`);
    assert.equal(piece.grossWeightMg, null, `${piece.slug} asserts a gross weight`);
    assert.equal(piece.fineness, null, `${piece.slug} asserts a fineness`);
    assert.equal(piece.makingChargeType, null, `${piece.slug} asserts a making charge`);
    assert.equal(piece.makingChargeValue, null, `${piece.slug} asserts a making charge`);
    assert.equal(piece.fixedPricePaise, null, `${piece.slug} asserts a price`);

    // QCO cl. 2(3) exempts Kundan, Polki and Jadau, so a hallmarking charge of
    // zero is the correct figure and not an unfilled blank.
    assert.equal(piece.hallmarkingPaise, 0);
  }
});

/**
 * The rule that does NOT bend for demonstration data.
 *
 * A weight is a measurement: invented, clearly labelled, it misleads nobody
 * about anything a regulator issues. A HUID is a government identifier and a
 * certificate number belongs to a lab. A plausible invented one is a forged
 * credential no matter how loudly the surrounding page says "demonstration",
 * so this runs over EVERY piece with no exemption.
 */
test("no piece — demonstration or not — carries a fabricated credential", () => {
  for (const piece of CATALOGUE_SEED) {
    assert.equal(piece.huid, null, `${piece.slug} carries a fabricated HUID`);
    assert.equal(piece.hallmarkPurityMark, null, `${piece.slug} carries a fabricated hallmark`);
    assert.equal(piece.certificateNumber, null, `${piece.slug} carries a fabricated certificate`);
    assert.equal(piece.certificateLab, null, `${piece.slug} names a lab that never saw it`);

    assert.equal(piece.isUniquePiece, true);
    assert.equal(piece.stockQuantity, 1);
  }
});

/**
 * A demonstration piece must still be COHERENT — the pricing CHECK in the schema
 * refuses a dynamic piece without a weight and a fineness, and discovering that
 * at checkout rather than here is the failure this prevents.
 *
 * `hallmarkingPaise` is asserted per piece rather than as a constant, because
 * the QCO exemption is the whole point: plain gold is not exempt and must carry
 * the fee, stone-set Kundan and Polki are and must not.
 */
test("every demonstration piece can actually be priced", () => {
  for (const piece of CATALOGUE_SEED) {
    if (!isDemonstrationPiece(piece.slug)) continue;

    assert.equal(piece.pricingMode, "dynamic_metal", `${piece.slug} is declared demo but unpriced`);
    assert.ok(piece.netMetalWeightMg > 0, `${piece.slug} has no net weight to price`);
    assert.ok(piece.grossWeightMg >= piece.netMetalWeightMg, `${piece.slug}: gross below net`);
    assert.ok([999, 995, 916, 750, 585].includes(piece.fineness), `${piece.slug}: bad fineness`);
    assert.ok(
      ["percent", "per_gram", "flat"].includes(piece.makingChargeType),
      `${piece.slug} has a making-charge type the price engine cannot read`
    );
    assert.ok(piece.makingChargeValue > 0, `${piece.slug} has no making charge`);

    // Exempt iff stone-set. A plain gold article pays the BIS per-article fee,
    // and pretending otherwise would teach the wrong invoice.
    const exempt = ["polki", "kundan", "jadau"].includes(
      piece.craft
    );
    if (exempt) {
      assert.equal(piece.hallmarkingPaise, 0, `${piece.slug} is QCO-exempt but charges hallmarking`);
    } else {
      assert.ok(piece.hallmarkingPaise > 0, `${piece.slug} is plain gold and must pay the BIS fee`);
    }
  }
});

/**
 * A front is mandatory. A reverse is NOT — a plain gold kada has no enamelled
 * back, and inventing one would misdescribe the craft this shop is selling.
 * What is mandatory is CONSISTENCY: an image and its alt text arrive together
 * or not at all, so `Flip` never renders a control promising a side that does
 * not exist, and never hides one that does.
 */
test("every piece has a photographed face, and a reverse only where one exists", () => {
  for (const piece of CATALOGUE_SEED) {
    assert.ok(piece.mediaKey.front, `${piece.slug} has no front image`);
    assert.ok(piece.alt.length > 20, `${piece.slug} has thin alt text`);

    if (piece.mediaKey.back) {
      assert.ok(piece.altBack && piece.altBack.length > 20, `${piece.slug} has thin reverse alt`);
      assert.notEqual(piece.alt, piece.altBack, `${piece.slug} reuses one alt for both sides`);
    } else {
      assert.equal(
        piece.altBack,
        null,
        `${piece.slug} describes a reverse it has no photograph of`
      );
    }
  }
});

/**
 * A buy control appears for exactly the in-stock pieces, and no others.
 *
 * `/api/cart` already refuses a sold piece ("That piece has left the shop"), so
 * this was never an oversell — the storefront printed that the piece was gone
 * and rendered an enabled "Add to cart" immediately underneath, so the only way
 * to find out was to click and be rejected. Unreachable until the demonstration
 * stock arrived: before that no piece was ever `buy_online`, so nothing could
 * sell out with a buy control on screen.
 *
 * WHAT THIS COVERS AND WHAT IT DOES NOT: the page is rendered in-process from
 * the compiled seed, where every piece is in stock, so this proves the
 * IN-STOCK arm and the count invariant. The sold arm cannot be reached from
 * here without a database, and is asserted against real data in
 * `cart.test.mjs`, where stock is actually decremented.
 */
test("a buy control is rendered for exactly the in-stock pieces", async () => {
  const body = await renderPage("/shop");

  const forms = [...body.matchAll(/<form[^>]*class="cart-add"[^>]*>[\s\S]*?<\/form>/g)];
  const inStock = CATALOGUE_SEED.filter((piece) => piece.stockQuantity > 0);
  assert.equal(inStock.length, CATALOGUE_SEED.length, "the seed is expected to be fully in stock");
  assert.equal(forms.length, inStock.length, "one buy control per in-stock piece");

  // Each control names the piece it would add, so nine identical buttons cannot
  // silently all point at the same slug.
  const slugs = [...body.matchAll(/name="slug" value="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(slugs)].sort(), inStock.map((p) => p.slug).sort());
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
    ["chandbali-earrings", "gold-jhumka"]
  );

  // Bridal holds the five heirloom pieces plus the three demonstration pieces
  // that are bridal BY CONSTRUCTION — a tikka is a headpiece and a rani haar is
  // bridal, so the collection describes them rather than being a place they
  // were filed to fill a gap.
  //
  // The rule that still holds, and is what this asserts: the four EVERYDAY
  // demonstration pieces stay out. A jhumka small enough for a working day does
  // not become bridal because the filter looked empty.
  const bridal = await listPricedCatalogue({ collection: "bridal" });
  const everyday = ["gold-jhumka", "polki-ring", "lotus-pendant", "slim-kada"];
  for (const slug of everyday) {
    assert.ok(
      !bridal.some((piece) => piece.slug === slug),
      `${slug} is everyday work and must not be filed under an occasion`
    );
  }
  assert.ok(
    bridal.some((piece) => isDemonstrationPiece(piece.slug)),
    "Bridal has no priced piece, so choosing it with a purity returns nothing"
  );

  assert.equal((await listPricedCatalogue({ metal: "gold" })).length, CATALOGUE_SEED.length);
  assert.equal((await listPricedCatalogue({ metal: "silver" })).length, 0);
});

/**
 * EVERY COLLECTION THE CONTROL OFFERS MUST SURVIVE A PURITY FILTER.
 *
 * The bug this exists for, seen on the live site: choosing Gold + 916 fineness
 * + Headpieces returned "Showing 0 of 9 pieces" on a wall that plainly had nine
 * pieces on it. Nothing was broken — a fineness only exists on a priced piece,
 * every priced piece happened to be everyday, and so both Headpieces and Bridal
 * were empty the moment a shopper touched Purity.
 *
 * That is indistinguishable from a broken filter, and a shopper who gets an
 * empty wall twice stops using the control. So a collection is only allowed
 * into the dropdown if something behind it can actually be found.
 */
test("no collection in the control is empty once a purity is chosen", async () => {
  const finenesses = catalogueFacets(await listCatalogue()).finenesses;
  assert.ok(finenesses.length > 0, "no fineness is offered, so this proves nothing");

  const empty = [];
  for (const collection of CATALOGUE_COLLECTIONS) {
    for (const purity of finenesses) {
      const matches = await listPricedCatalogue({
        collection: collection.slug,
        fineness: purity,
      });
      if (matches.length === 0) empty.push(`${collection.slug} + ${purity}`);
    }
  }

  assert.deepEqual(
    empty,
    [],
    `these collection/purity combinations show an empty wall: ${empty.join(", ")}`
  );
});


test("facets are derived from the data, never hard-coded", async () => {
  const facets = catalogueFacets(await listCatalogue());

  assert.deepEqual(facets.metals, ["gold"]);
  // The purity control offers exactly what the data supports and nothing more.
  // It was empty while every piece was on request; the demonstration pieces are
  // all 916, so one option appears. If this ever lists a fineness no piece
  // carries, the facet has stopped being derived.
  assert.deepEqual(facets.finenesses, [916]);
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
    // Derived from the seed, not pinned to a number. What this test is actually
    // about is idempotency, and a hard-coded count made every catalogue edit
    // look like an idempotency failure.
    assert.deepEqual(first, {
      products: CATALOGUE_SEED.length,
      variants: CATALOGUE_SEED.length,
      collections: CATALOGUE_COLLECTIONS.length,
      memberships: SEEDED_MEMBERSHIPS,
    });

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

    assert.equal(rows.length, CATALOGUE_SEED.length);

    const demoSkus = new Set(
      CATALOGUE_SEED_ROWS.filter((r) => isDemonstrationPiece(r.piece.slug)).map((r) => r.sku)
    );
    assert.equal(demoSkus.size, DEMONSTRATION_SLUGS.length, "demo SKUs did not resolve");

    for (const row of rows) {
      // The credential columns. NULL for every row, with no exemption — this is
      // the assertion that must survive any future change to this file.
      for (const column of [
        "huid",
        "hallmark_purity_mark",
        "certificate_number",
        "certificate_lab",
      ]) {
        assert.equal(row[column], null, `${row.sku} asserts ${column}`);
      }
      assert.equal(row.is_unique_piece, 1);
      assert.equal(row.stock_quantity, 1);

      if (demoSkus.has(row.sku)) {
        // Priced, and therefore obliged to satisfy variants_pricing_inputs_ck —
        // which the INSERT above has already proved, since it did not throw.
        assert.equal(row.pricing_mode, "dynamic_metal", `${row.sku} is demo but unpriced`);
        assert.ok(row.fineness > 0, `${row.sku} has no fineness`);
        assert.ok(row.net_metal_weight_mg > 0, `${row.sku} has no weight`);
        assert.equal(row.fixed_price_paise, null, `${row.sku} mixes dynamic and fixed pricing`);
        continue;
      }

      assert.equal(row.pricing_mode, "on_request", `${row.sku} is not on request`);
      for (const column of [
        "fineness",
        "net_metal_weight_mg",
        "gross_weight_mg",
        "making_charge_type",
        "making_charge_value",
        "fixed_price_paise",
      ]) {
        assert.equal(row[column], null, `${row.sku} asserts ${column}`);
      }
      assert.equal(row.hallmarking_paise, 0, `${row.sku} charges for a hallmark it does not have`);
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
    assert.equal(
      db.prepare("SELECT count(*) AS c FROM product_collections").get().c,
      SEEDED_MEMBERSHIPS + 1
    );
    applySeed(db);
    assert.equal(
      db.prepare("SELECT count(*) AS c FROM product_collections").get().c,
      SEEDED_MEMBERSHIPS
    );
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
    if (piece.mediaKey.back) {
      assert.ok(
        body.includes(`${piece.mediaKey.back}-1400.webp`),
        `no reverse image for ${piece.slug}`
      );
    }
  }

  // One <img> per face, plus one per piece that HAS a reverse. A plain gold
  // kada has no enamelled back and must not render an empty second image.
  const expectedImages =
    CATALOGUE_SEED.length + CATALOGUE_SEED.filter((piece) => piece.mediaKey.back).length;
  const imgs = body.match(/<img\b[^>]*>/g) ?? [];
  assert.equal(imgs.length, expectedImages, `expected ${expectedImages} images, found ${imgs.length}`);
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

  // The purity control must never offer a fineness no piece carries — that
  // would be a filter implying a fact. It was disabled while nothing had been
  // assayed; the demonstration pieces are 916, so it is live and offers exactly
  // that one option. Both states are asserted from the data rather than pinned.
  const finenesses = catalogueFacets(await listCatalogue()).finenesses;
  if (finenesses.length === 0) {
    assert.match(body, /<select[^>]*name="purity"[^>]*disabled/);
    assert.match(body, /No piece has a recorded fineness yet/);
  } else {
    assert.doesNotMatch(
      body,
      /<select[^>]*name="purity"[^>]*disabled/,
      "the purity control is disabled while pieces do carry a fineness"
    );
    for (const fineness of finenesses) {
      assert.match(body, new RegExp(`<option value="${fineness}"`), `no option for ${fineness}`);
    }
    // Nothing beyond what the catalogue supports.
    const offered = [...body.matchAll(/<option value="(\d{3})"/g)].map((m) => Number(m[1]));
    assert.deepEqual(
      [...new Set(offered)].sort(),
      [...finenesses].sort(),
      "the purity control offers a fineness no piece carries"
    );
  }
});

test("a collection filter narrows the wall and offers a way back", async () => {
  const body = await shop("?collection=earrings");

  assert.ok(body.includes("Chandbali earrings"));
  assert.ok(!body.includes("Kundan kada"), "the filter did not narrow anything");
  assert.match(body, showing(2, CATALOGUE_SEED.length));
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
  assert.match(body, showing(CATALOGUE_SEED.length, CATALOGUE_SEED.length));
});

test("a price band excludes on-request pieces and explains itself", async () => {
  const body = await shop("?price=1l-3l");

  assert.match(body, showing(0, CATALOGUE_SEED.length));
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
