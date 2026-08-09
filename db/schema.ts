import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Appointment requests captured by the private-viewing form on the homepage.
 * Every column mirrors a field the visitor actually fills in, plus the
 * lightweight request metadata Cloudflare hands us for free.
 */
export const appointments = sqliteTable(
  "appointments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    interest: text("interest").notNull(),
    preferredTime: text("preferred_time").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    /** Workflow state for the shop team: new -> contacted -> booked/closed. */
    status: text("status").notNull().default("new"),
    /** Where the lead came from, so future channels stay distinguishable. */
    source: text("source").notNull().default("website"),
    userAgent: text("user_agent"),
    /** Two-letter country from the Cloudflare `CF-IPCountry` request header. */
    country: text("country"),
  },
  (table) => [
    index("appointments_created_at_idx").on(table.createdAt),
    /**
     * Supports the duplicate/flood guard in the appointments route, which asks
     * "has this number submitted in the last few minutes?" on every POST.
     */
    index("appointments_phone_created_at_idx").on(table.phone, table.createdAt),
  ]
);

/* ==========================================================================
 * COMMERCE
 * ==========================================================================
 *
 * Everything below this line is the storefront data layer. It is additive:
 * `appointments` above is unchanged and the appointment flow remains the
 * primary conversion path for high-value Jadau and Polki pieces. The catalogue
 * sits alongside it, it does not replace it.
 *
 * ---------------------------------------------------------------------------
 * REPRESENTATION RULES — these apply to every table below, without exception
 * ---------------------------------------------------------------------------
 *
 * MONEY      integer **paise**, never REAL. SQLite REAL is IEEE-754 and
 *            `0.1 + 0.2 !== 0.3`; a GST figure computed in floats produces an
 *            invoice that does not foot, and a GST invoice is a statutory
 *            document. ₹7,250.50 is stored as `725050`. Every money column in
 *            this file is named `...Paise` so the unit can never be guessed
 *            wrong at a call site.
 *
 * WEIGHT     integer **milligrams**, named `...Mg`. The trade quotes to three
 *            decimals (12.345 g); that is `12345`. Same float argument.
 *
 * RATES/%    integer **basis points**, named `...Bps`. GST 3% is `300`.
 *            A 12% making charge is `1200`.
 *
 * METAL RATE integer paise **per ten grams**, named `ratePerTenGramsPaise`.
 *            See the long comment on `goldRates` — the unit is the single most
 *            dangerous thing in this schema and it is spelled out in the name.
 *
 * PURITY     integer **millesimal fineness** (999, 995, 916, 750, 585), never
 *            a karat string. See the comment on `goldRates.fineness`.
 *
 * IDS        `text` primary keys, application-generated (nanoid/crypto.randomUUID).
 *            Auto-increment integers leak order volume to anyone who can read
 *            a URL. `orders.orderNumber` is the separate human-facing handle.
 *
 * TIMES      `text` ISO-8601 UTC, `default sql`CURRENT_TIMESTAMP``, matching
 *            the `appointments` convention above. Do not introduce a second
 *            timestamp style.
 *
 * ENUMS      `text` + `{ enum: [...] }` for the TypeScript side. SQLite has no
 *            native enum and Drizzle's `enum` is type-level only, so a CHECK
 *            constraint is added wherever the *database's own* guarantees
 *            depend on the value (partial indexes, money invariants,
 *            inventory locks). Enums that are purely presentational are left
 *            to the type system; adding a CHECK to every one of them would be
 *            noise that has to be migrated later, and migrations here are
 *            forward-only.
 *
 * ---------------------------------------------------------------------------
 * D1 HAS NO INTERACTIVE TRANSACTIONS — what the code layer must do
 * ---------------------------------------------------------------------------
 *
 * `drizzle.transaction()` throws on D1: Drizzle emits `BEGIN TRANSACTION` and
 * the Workers D1 binding rejects it. `db.batch([...])` is the *only* atomicity
 * primitive — one batch is one transaction; two batches are two transactions,
 * and if the second fails the first is already committed.
 *
 * This schema is shaped so that a partial write cannot leave an order
 * half-created. The compensations the code layer owes it:
 *
 *  1. ONE BATCH FOR ORDER PLACEMENT. The verified-webhook handler must emit a
 *     single `db.batch([...])` containing, in this order: insert
 *     `webhook_events` (PK = provider event id), insert `orders`, one insert
 *     per `order_items` row, update `payments`, guarded decrement of
 *     `variants.stockQuantity`, mark the `stock_reservations` row `consumed`,
 *     mark the `price_quotes` row `consumed`, mark the `carts` row
 *     `converted`. Never split this across two batches.
 *
 *  2. LET THE DATABASE ABORT THE BATCH. `variants.stockQuantity` carries a
 *     `CHECK (stock_quantity >= 0)`. A decrement that would oversell raises a
 *     constraint error, which aborts the whole batch — so the order is never
 *     created rather than being created against stock that does not exist.
 *     The app must still write the `WHERE stock_quantity >= quantity` guard,
 *     but correctness does not depend on it being remembered.
 *
 *  3. CLAIM BEFORE YOU QUOTE. Stock is claimed with
 *     `INSERT INTO stock_reservations ... ON CONFLICT DO NOTHING` and a check
 *     of `meta.changes === 1`. The partial unique index on that table means
 *     SQLite, not application code, decides who wins the race for a
 *     one-of-a-kind piece. Read-then-write is unsafe here and always will be.
 *
 *  4. IDEMPOTENCY IS THE ROLLBACK. Gateways retry. `webhook_events.id` is the
 *     provider's own event id and is inserted *inside* the order batch, so a
 *     retry of an already-processed event fails on the primary key and the
 *     entire batch — including the duplicate order and the duplicate stock
 *     decrement — is discarded. Any work that genuinely cannot fit in one
 *     batch (outbound email, R2 writes) must be separately idempotent and
 *     safe to re-run.
 *
 *  5. DETECT A TORN ORDER ON READ. `orders.lineItemCount` is written in the
 *     same batch as the line items. Any reader that renders an invoice, an
 *     admin order page or a refund must assert
 *     `count(order_items where order_id = ?) === orders.lineItemCount` and
 *     refuse to act on a mismatch, rather than silently invoicing a subset.
 *
 *  6. RESPECT THE 100-BOUND-PARAMETER CAP. One `INSERT` statement per line
 *     item inside the batch — never a single multi-row `VALUES (...), (...)`.
 *     A six-item cart at ~25 snapshot columns is 150 parameters and fails
 *     where a two-item cart passed.
 *
 *  7. ORDERS ARE APPEND-ONLY. No code path may `DELETE FROM orders` or
 *     `DELETE FROM order_items`. SQLite cannot be made to refuse this without
 *     triggers, which the migration pipeline does not emit, so it is a review
 *     rule — but every *structural* path into an order delete (a cascading
 *     foreign key from `customers`) has been removed. See `customers`.
 *
 *     CANCELLATION IS THEREFORE A TRANSITION, NOT A REMOVAL: `status` moves to
 *     `cancelled`, `cancelled_at`/`cancelled_by`/`cancellation_reason_code` are
 *     written, and `variants.stockQuantity` is given back — all in ONE batch,
 *     because a cancelled order whose stock was not restored is a one-of-a-kind
 *     piece permanently off sale, and a restored piece on a live order is an
 *     oversell of something there is no second of. That batch is idempotent by
 *     the same device as placement: it opens with an insert into
 *     `webhook_events` keyed `manual:order:<id>:cancelled`, so a second
 *     cancellation collides on the primary key and the restore dies with it.
 *     Which states may be cancelled is decided by the DATABASE and not by a
 *     prior read — see `cancelOrder()` in `app/_data/orders.ts`.
 */

/* -------------------------------------------------------------------------
 * Catalogue
 * ---------------------------------------------------------------------- */

/**
 * Categories, collections and occasions. Many-to-many with products, because a
 * single piece is legitimately both "Bridal" and "Polki" at the same time.
 * `parentId` is a self-reference kept deliberately one level deep — a deep
 * tree needs recursive CTEs on every listing page and D1 is single-threaded.
 */
export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  kind: text("kind", { enum: ["category", "collection", "occasion"] })
    .notNull()
    .default("category"),
  parentId: text("parent_id").references((): AnySQLiteColumn => collections.id, {
    onDelete: "set null",
  }),
  position: integer("position").notNull().default(0),
  isVisible: integer("is_visible", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/**
 * A product is the *design* / listing. The purchasable *physical piece* is a
 * variant. An antique Jadau set is one product with exactly one variant; a
 * repeatable chain is one product with several. This costs one join and buys
 * correctness for both cases — and for this shop the one-of-a-kind case is the
 * norm, not the exception.
 *
 * `saleMode` exists so the owner can decide per piece whether it is buyable at
 * all. Putting the entire catalogue online as buyable is not the goal; a
 * ₹4 lakh bridal set converting through a private viewing is.
 */
export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    subtitle: text("subtitle"),
    description: text("description"),
    craft: text("craft", {
      enum: ["jadau", "polki", "diamond", "gold", "kundan", "other"],
    }).notNull(),
    status: text("status", { enum: ["draft", "active", "archived"] })
      .notNull()
      .default("draft"),
    /** Sold online vs. enquiry-only vs. viewing-only. Default is the safe one. */
    saleMode: text("sale_mode", {
      enum: ["buy_online", "enquire_only", "appointment_only"],
    })
      .notNull()
      .default("enquire_only"),
    seoTitle: text("seo_title"),
    seoDescription: text("seo_description"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("products_status_sale_mode_idx").on(t.status, t.saleMode),
    index("products_craft_idx").on(t.craft),
  ]
);

export const productCollections = sqliteTable(
  "product_collections",
  {
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    collectionId: text("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.collectionId] }),
    index("product_collections_collection_idx").on(t.collectionId),
  ]
);

/**
 * A variant is one physical piece (or one repeatable configuration of a design).
 * It holds *pricing inputs*, never a price: the price is computed from the
 * prevailing metal rate at quote time. A single `price` column would make it
 * impossible to render the weight/making/stone breakup Indian buyers expect,
 * impossible to reprice on a rate change, and impossible to produce an invoice
 * that satisfies BIS (Hallmarking) Regulations 2018 Reg. 5(11).
 *
 * ONE-OF-A-KIND IS THE DEFAULT. `isUniquePiece` defaults to true and
 * `stockQuantity` defaults to 1. Three database-level guards, not three
 * conventions, stop the same antique set being sold twice:
 *
 *   (a) `CHECK (stock_quantity >= 0)` — the guarded decrement inside the order
 *       batch cannot go negative; it raises and aborts the batch instead.
 *   (b) `CHECK (is_unique_piece = 0 OR stock_quantity <= 1)` — a piece marked
 *       one-of-a-kind can never be given a stock of 2 by an admin typo.
 *   (c) the partial unique index on `stock_reservations`, which lets SQLite
 *       arbitrate the checkout race. See that table.
 */
export const variants = sqliteTable(
  "variants",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sku: text("sku").notNull().unique(),

    // --- Variant axes ---
    metal: text("metal", { enum: ["gold", "silver", "platinum", "none"] })
      .notNull()
      .default("gold"),
    /**
     * Millesimal fineness — 999, 995, 916, 750, 585 for gold; 999 for silver;
     * 950 for platinum. NOT a karat string.
     *
     * IBJA, which is the number an Indian jeweller actually quotes from,
     * publishes fineness. 995 has no karat equivalent at all: a
     * `"24K" | "22K" | "18K" | "14K"` enum silently collapses 995 onto 24K and
     * then mis-prices every 995 item by roughly 0.4%, forever, invisibly.
     *
     * The display karat is DERIVED, never stored as the source of truth:
     * `carat = fineness * 24 / 1000` (916 -> 21.98 -> "22K", 750 -> 18.0 ->
     * "18K", 585 -> 14.04 -> "14K"). 995 derives to 23.88 and must be
     * presented as "995 fineness", not rounded up to 24K. BIS Reg. 5(11)
     * requires purity "in carat and fineness" on the invoice, so the renderer
     * prints both — from this one column.
     */
    fineness: integer("fineness"),
    size: text("size"), // ring size / bangle 2.4 / chain 18in
    colour: text("colour", { enum: ["yellow", "white", "rose", "mixed"] }),

    // --- Pricing inputs (integers only) ---
    pricingMode: text("pricing_mode", {
      enum: ["dynamic_metal", "fixed", "on_request"],
    })
      .notNull()
      .default("dynamic_metal"),
    /** Metal only, stones excluded. This is what the rate multiplies. */
    netMetalWeightMg: integer("net_metal_weight_mg"),
    /** As weighed, stones included. Shown alongside net weight; never priced. */
    grossWeightMg: integer("gross_weight_mg"),
    makingChargeType: text("making_charge_type", {
      enum: ["per_gram", "percent", "flat"],
    }),
    /** paise-per-gram when `per_gram`; bps when `percent`; paise when `flat`. */
    makingChargeValue: integer("making_charge_value"),
    stoneValuePaise: integer("stone_value_paise").notNull().default(0),
    /**
     * BIS hallmarking charge for this article, as a separate figure.
     *
     * Defaults to ₹45 (4500 paise), the BIS published per-article charge for
     * gold (Revised Guidelines for Jewellers, Jan 2024, cl. 3.3.5); silver is
     * ₹35 (3500). It defaults to the real charge and NOT to 0, because
     * Reg. 5(11) requires hallmarking charges to appear *separately* on the
     * invoice — a 0 default means the line silently disappears and the invoice
     * is non-compliant.
     *
     * It is deliberately NOT folded into making charges. It travels as its own
     * column through quotes, orders and order lines for exactly that reason.
     *
     * Set it to 0 explicitly for Kundan, Polki and Jadau pieces: QCO cl. 2(3)
     * exempts those categories from mandatory hallmarking, so an unhallmarked
     * Jadau set incurs no hallmarking charge and must not be shown as if it
     * had one.
     */
    hallmarkingPaise: integer("hallmarking_paise").notNull().default(4500),
    otherChargesPaise: integer("other_charges_paise").notNull().default(0),
    /** Used only when `pricingMode = 'fixed'` — antique/Polki quoted flat. */
    fixedPricePaise: integer("fixed_price_paise"),

    // --- Compliance ---
    /**
     * Six-character BIS HUID. NULLABLE ON PURPOSE and its absence is not a
     * data gap: Kundan, Polki and Jadau are exempt from mandatory hallmarking,
     * and those are this shop's flagship categories. The UI must not render a
     * missing HUID as an omission or imply a blanket "every piece is
     * hallmarked" claim, which would be false.
     */
    huid: text("huid"),
    hallmarkPurityMark: text("hallmark_purity_mark"), // e.g. "22K916"
    certificateNumber: text("certificate_number"),
    certificateLab: text("certificate_lab"), // IGI / GIA / SGL
    diamondOrigin: text("diamond_origin", {
      enum: ["natural", "lab_grown", "none"],
    })
      .notNull()
      .default("none"),
    countryOfOrigin: text("country_of_origin").notNull().default("India"),
    /** 7113 for finished jewellery. Only loose stones or coins diverge. */
    hsnCode: text("hsn_code").notNull().default("7113"),

    // --- Inventory ---
    isUniquePiece: integer("is_unique_piece", { mode: "boolean" })
      .notNull()
      .default(true),
    stockQuantity: integer("stock_quantity").notNull().default(1),
    isMadeToOrder: integer("is_made_to_order", { mode: "boolean" })
      .notNull()
      .default(false),
    leadTimeDays: integer("lead_time_days"),

    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("variants_product_idx").on(t.productId),
    index("variants_stock_idx").on(t.stockQuantity),
    /**
     * The pricing-mode contract. A dynamically-priced piece without a weight
     * or a fineness cannot be priced at all, and a "fixed" piece without a
     * price is a listing that will throw at checkout. Refuse both at write
     * time rather than discovering them at quote time.
     */
    check(
      "variants_pricing_inputs_ck",
      sql`(pricing_mode = 'dynamic_metal' AND net_metal_weight_mg IS NOT NULL AND fineness IS NOT NULL)
        OR (pricing_mode = 'fixed' AND fixed_price_paise IS NOT NULL)
        OR (pricing_mode = 'on_request')`
    ),
    /** The oversell backstop. See the header comment, compensation (2). */
    check("variants_stock_non_negative_ck", sql`stock_quantity >= 0`),
    /** A one-of-a-kind piece cannot be given a stock of two. */
    check(
      "variants_unique_piece_stock_ck",
      sql`is_unique_piece = 0 OR stock_quantity <= 1`
    ),
    /** Fineness is parts per thousand; anything outside this is a typo. */
    check(
      "variants_fineness_range_ck",
      sql`fineness IS NULL OR (fineness > 0 AND fineness <= 1000)`
    ),
    check("variants_money_non_negative_ck", sql`stone_value_paise >= 0
      AND hallmarking_paise >= 0
      AND other_charges_paise >= 0
      AND (fixed_price_paise IS NULL OR fixed_price_paise >= 0)`),
  ]
);

/**
 * Product imagery. Stores R2 object keys, never URLs — the public URL shape is
 * a rendering concern and changes when the delivery path changes.
 * `contentType` is not optional: an R2 object uploaded without it makes the
 * image-optimization endpoint reject the image, and the failure is quiet.
 */
export const productMedia = sqliteTable(
  "product_media",
  {
    id: text("id").primaryKey(),
    productId: text("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    variantId: text("variant_id").references(() => variants.id, {
      onDelete: "set null",
    }),
    r2Key: text("r2_key").notNull(),
    kind: text("kind", { enum: ["image", "video"] })
      .notNull()
      .default("image"),
    /** Accessibility and SEO. Make it required in the admin form. */
    alt: text("alt"),
    width: integer("width"),
    height: integer("height"),
    contentType: text("content_type").notNull(),
    byteSize: integer("byte_size"),
    position: integer("position").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("product_media_product_position_idx").on(t.productId, t.position)]
);

/* -------------------------------------------------------------------------
 * Metal rates
 * ---------------------------------------------------------------------- */

/**
 * The metal rate audit trail. Append-only: never UPDATE a rate row. Close the
 * old row (`effectiveTo = now`) and insert a new one, both inside one
 * `db.batch()`. Historic orders reference the exact row they were priced from,
 * so an invoice reprinted in 2031 still reconstructs to the paise.
 *
 * ---------------------------------------------------------------------------
 * THE UNIT. Read this before writing any pricing code.
 * ---------------------------------------------------------------------------
 * `ratePerTenGramsPaise` is paise **per ten grams**, because that is the unit
 * IBJA publishes gold in ("Gold rates per 10gm & Silver rate per 1kg"). A
 * `ratePerGram...` column would invite a silent 10x error at ingest, which is
 * the single worst bug this system can have: it does not throw, it does not
 * look wrong in a table, and it multiplies every order by ten.
 *
 * INGEST, and why it is lossless:
 *   - Gold, IBJA ₹R per 10 g (whole rupees)  ->  ratePerTenGramsPaise = R * 100.
 *     No division, no rounding.
 *   - Silver, IBJA ₹R per 1 kg (whole rupees) ->  R * 100 paise per kg,
 *     ÷ 100 (1 kg = 100 × 10 g) -> R paise per 10 g. Exact integer, no
 *     rounding, for any whole-rupee kilo quote.
 *   - If a source ever publishes paise or a fractional figure, the ingest
 *     layer MUST round half-up to the nearest whole paise per ten grams and
 *     record the untouched published figure in `sourceQuoteRaw`. Never let
 *     integer division truncate silently.
 *
 * ROUNDING RULE for using the rate — defined here so it is defined once:
 *   metalValuePaise = round_half_up(ratePerTenGramsPaise * netMetalWeightMg / 10000)
 * because 10 g = 10,000 mg. Round exactly once, per order line, at that step.
 * Do NOT pre-divide the rate into a per-gram figure: that throws away up to
 * 0.9 paise per gram and the error grows with weight.
 */
export const goldRates = sqliteTable(
  "gold_rates",
  {
    id: text("id").primaryKey(),
    metal: text("metal", { enum: ["gold", "silver", "platinum"] }).notNull(),
    /**
     * Millesimal fineness as published: 999 / 995 / 916 / 750 / 585 for gold,
     * 999 for silver, 950 for platinum. See `variants.fineness` for why this
     * is not a karat enum — 995 is the case that breaks karat outright.
     */
    fineness: integer("fineness").notNull(),
    ratePerTenGramsPaise: integer("rate_per_ten_grams_paise").notNull(),
    source: text("source", { enum: ["manual", "ibja", "api", "derived"] }).notNull(),
    /** API response id / provider name / the admin's note. */
    sourceRef: text("source_ref"),
    /**
     * The figure exactly as published, verbatim, before any unit conversion
     * ("98500 per 10g", "119500 per kg"). This is the audit anchor that makes
     * a 10x ingest bug provable after the fact instead of arguable.
     */
    sourceQuoteRaw: text("source_quote_raw"),
    effectiveFrom: text("effective_from").notNull(),
    /** NULL means "this is the current rate". */
    effectiveTo: text("effective_to"),
    createdBy: text("created_by"), // admin email when source = 'manual'
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("gold_rates_lookup_idx").on(t.metal, t.fineness, t.effectiveFrom),
    /**
     * Exactly one *current* rate per (metal, fineness), enforced by SQLite.
     * Prevents the "two rates active, which one did we actually charge?" bug,
     * which is unanswerable after the fact.
     */
    uniqueIndex("gold_rates_current_idx")
      .on(t.metal, t.fineness)
      .where(sql`effective_to IS NULL`),
    check("gold_rates_rate_positive_ck", sql`rate_per_ten_grams_paise > 0`),
    check(
      "gold_rates_fineness_range_ck",
      sql`fineness > 0 AND fineness <= 1000`
    ),
  ]
);

/* -------------------------------------------------------------------------
 * Customers — soft delete only
 * ---------------------------------------------------------------------- */

/**
 * A customer record. Guest checkout is the expected path; this row exists so a
 * returning buyer is recognisable and so consent is provable.
 *
 * ---------------------------------------------------------------------------
 * DELETION IS SOFT, AND THE SCHEMA MAKES A HARD DELETE STRUCTURALLY IMPOSSIBLE
 * TO GET WRONG. Three mechanisms, not one comment:
 * ---------------------------------------------------------------------------
 *
 * 1. NO FOREIGN KEY POINTS FROM `orders` TO THIS TABLE. `orders.customerId` is
 *    a plain indexed text column, deliberately not `.references()`. There is
 *    therefore no `ON DELETE` clause anywhere on the order path that a future
 *    edit could turn into `cascade`. A cascade from customer to order cannot
 *    be written by accident, because there is no edge to annotate. Order rows
 *    already snapshot contact name, phone, email and the full address inline
 *    (see `orders`), so they lose nothing by not joining.
 *
 * 2. REDACTION IS AN UPDATE, NEVER A DELETE. Every PII column here is
 *    nullable — including `phone`, which would otherwise be `notNull` — so the
 *    erasure job nulls the columns in place and the row survives as a
 *    tombstone. A tombstone keeps the id valid, which is what stops anything
 *    downstream from dangling. The invariant that a *live* customer must still
 *    have a phone is preserved by `customers_live_row_has_phone_ck`.
 *
 * 3. THE ONE-YEAR RETENTION FLOOR IS A CHECK CONSTRAINT, NOT A CODE COMMENT.
 *    DPDP Rule 8(3) requires personal data, traffic data and logs to be kept
 *    for a minimum of one year even after the account is deleted — its own
 *    illustration is an e-commerce order retained after the user deletes her
 *    account. So `purgeNotBeforeAt` must be written at the same moment as
 *    `deletionRequestedAt` (enforced), and `redactedAt` may not precede it
 *    (enforced). A purge job that runs early is rejected by the database.
 *
 * The purge job MUST NOT touch `orders` or `order_items`. Those are GST
 * documents and BIS Reg. 5(13) records (five years, or until sold, whichever
 * is longer) with their own retention need entirely independent of DPDP.
 * Redact the customer row; keep the order.
 */
export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    /**
     * E.164, normalised with the same `normalisePhone()` the appointments
     * route uses. Nullable ONLY so that redaction can null it — see (2) above.
     * SQLite treats NULLs as distinct in a unique index, so any number of
     * redacted tombstones coexist.
     */
    phone: text("phone"),
    email: text("email"),
    name: text("name"),
    /**
     * DPDP s.6(10) puts the burden of proving consent on us, so record which
     * version of the notice was shown and when — not a boolean.
     */
    consentVersion: text("consent_version"),
    consentAt: text("consent_at"),
    /**
     * Consent must be an explicit affirmative action; E-Commerce Rule 4(9)
     * forbids pre-ticked boxes, so this must never default to true.
     */
    marketingOptIn: integer("marketing_opt_in", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),

    // --- Erasure lifecycle ---
    /** When the data principal asked for erasure. Never deletes anything. */
    deletionRequestedAt: text("deletion_requested_at"),
    /**
     * The earliest instant at which PII on THIS ROW may be nulled:
     * `deletionRequestedAt + 365 days`, computed at request time and stored,
     * so the floor cannot drift if the rule is ever re-implemented elsewhere.
     */
    purgeNotBeforeAt: text("purge_not_before_at"),
    /** Set by the erasure job once PII has actually been nulled. */
    redactedAt: text("redacted_at"),
  },
  (t) => [
    uniqueIndex("customers_phone_idx").on(t.phone),
    index("customers_email_idx").on(t.email),
    index("customers_deletion_requested_idx").on(t.deletionRequestedAt),
    /**
     * You cannot record a deletion request without simultaneously recording
     * the date before which nothing may be purged. The two fields are written
     * together or not at all.
     */
    check(
      "customers_deletion_request_pairs_ck",
      sql`(deletion_requested_at IS NULL AND purge_not_before_at IS NULL)
        OR (deletion_requested_at IS NOT NULL AND purge_not_before_at IS NOT NULL)`
    ),
    /**
     * The retention floor itself. ISO-8601 UTC strings compare correctly
     * lexicographically, so SQLite can enforce "not before" directly: an
     * erasure job that fires inside the one-year window is rejected.
     */
    check(
      "customers_retention_floor_ck",
      sql`redacted_at IS NULL
        OR (purge_not_before_at IS NOT NULL AND redacted_at >= purge_not_before_at)`
    ),
    /**
     * A live customer must have a phone number; only a redacted tombstone is
     * allowed to have none. This is what lets `phone` be nullable for
     * redaction without losing the invariant everywhere else.
     */
    check(
      "customers_live_row_has_phone_ck",
      sql`redacted_at IS NOT NULL OR phone IS NOT NULL`
    ),
  ]
);

/* -------------------------------------------------------------------------
 * Cart — intent only, never price of record
 * ---------------------------------------------------------------------- */

export const carts = sqliteTable(
  "carts",
  {
    /** Opaque; the signed cookie carries this and nothing else. */
    id: text("id").primaryKey(),
    customerId: text("customer_id").references(() => customers.id, {
      onDelete: "set null",
    }),
    status: text("status", { enum: ["open", "converted", "abandoned"] })
      .notNull()
      .default("open"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("carts_status_updated_idx").on(t.status, t.updatedAt)]
);

/**
 * THE CART DOES NOT SNAPSHOT PRICE, DELIBERATELY.
 *
 * Freezing a price at add-to-cart means a cart abandoned for three weeks
 * resurrects at a stale metal rate; you then either absorb the loss or ambush
 * the customer at checkout. The cart stores *intent*. Price resolves once, at
 * order time, through `price_quotes`.
 *
 * `quotedUnitPricePaise` is NOT the price of record. It exists so the cart view
 * can say "the gold rate has changed since you added this" — disclosure, not
 * pricing. Nothing downstream may read it to compute money.
 */
export const cartItems = sqliteTable(
  "cart_items",
  {
    id: text("id").primaryKey(),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    /** Display-only; see the table comment. */
    quotedUnitPricePaise: integer("quoted_unit_price_paise"),
    quotedAt: text("quoted_at"),
    addedAt: text("added_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("cart_items_cart_variant_idx").on(t.cartId, t.variantId),
    check("cart_items_quantity_positive_ck", sql`quantity > 0`),
  ]
);

/* -------------------------------------------------------------------------
 * Price quotes — the rate lock
 * ---------------------------------------------------------------------- */

/**
 * A quote is the price the customer was shown, frozen, with an expiry that
 * lives in the database rather than in a comment.
 *
 * Flow: "Proceed to pay" -> server recomputes from the CURRENT rate -> writes
 * this row with `expiresAt = now + N minutes` -> the gateway order is created
 * for exactly `amountDueNowPaise` -> on verified webhook the server checks
 * `status = 'active' AND expiresAt > now` before converting to an order. An
 * expired quote is REFUNDED, never force-fitted and never silently re-priced
 * upward — that is both a consumer-law problem and a trust catastrophe.
 *
 * The client never sends a price. It sends this row's id.
 *
 * The three CHECK constraints below make a quote that does not add up
 * literally unstorable. That matters more than it sounds: E-Commerce
 * Rule 7(1)(e) requires a total in a single figure *together with* the
 * breakup, so a breakup that does not sum to the total is a compliance defect,
 * not a cosmetic one.
 */
export const priceQuotes = sqliteTable(
  "price_quotes",
  {
    id: text("id").primaryKey(),
    /**
     * No `onDelete` clause: SQLite's default NO ACTION means an attempt to
     * delete a cart that still has a quote fails. Quotes are evidence of what
     * was offered and must outlive the cart's lifecycle.
     */
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id),

    // --- Frozen composition, all paise ---
    metalValuePaise: integer("metal_value_paise").notNull(),
    makingChargesPaise: integer("making_charges_paise").notNull(),
    stoneValuePaise: integer("stone_value_paise").notNull(),
    /** Its own line. Never folded into making charges. See `variants`. */
    hallmarkingPaise: integer("hallmarking_paise").notNull().default(0),
    otherChargesPaise: integer("other_charges_paise").notNull().default(0),
    discountPaise: integer("discount_paise").notNull().default(0),
    shippingPaise: integer("shipping_paise").notNull().default(0),
    taxablePaise: integer("taxable_paise").notNull(),
    /**
     * ONE rate, 300 bps, applied to the whole taxable value. This is correct
     * and must not be "fixed" later into a 3%/5% split.
     *
     * CBIC's DGTS Sectoral FAQ (Gems & Jewellery) Q7, verbatim: "GST is
     * payable at the rate of 3% of the total transaction value of jewellery,
     * whether the making charge is shown separately or not." Jewellery is a
     * composite supply with gold as the principal supply. Showing the breakup
     * — which BIS Reg. 5(11) largely requires — does not split the rate.
     *
     * The 5% figure someone will eventually cite is job work (Heading 9988):
     * a customer bringing their own gold, or a karigar invoicing the shop.
     * Different transaction, not this one.
     */
    gstRateBps: integer("gst_rate_bps").notNull().default(300),
    gstPaise: integer("gst_paise").notNull(),
    totalPaise: integer("total_paise").notNull(),
    /**
     * The exact figure the gateway order is created for. Equals `totalPaise`
     * for a full prepaid order and the booking advance for a reserve-and-pay-
     * in-store order. Keeping it explicit means the amount charged is read
     * from one column rather than reconstructed at the call site.
     */
    amountDueNowPaise: integer("amount_due_now_paise").notNull(),
    paymentPlan: text("payment_plan", {
      enum: ["full_prepaid", "booking_advance"],
    })
      .notNull()
      .default("full_prepaid"),

    /** Line-level frozen inputs as JSON so the quote is self-contained. */
    linesJson: text("lines_json").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    expiresAt: text("expires_at").notNull(),
    status: text("status", { enum: ["active", "consumed", "expired"] })
      .notNull()
      .default("active"),
  },
  (t) => [
    index("price_quotes_cart_status_idx").on(t.cartId, t.status),
    index("price_quotes_expires_idx").on(t.expiresAt),
    check(
      "price_quotes_taxable_foots_ck",
      sql`taxable_paise = metal_value_paise + making_charges_paise + stone_value_paise
        + hallmarking_paise + other_charges_paise - discount_paise + shipping_paise`
    ),
    check("price_quotes_total_foots_ck", sql`total_paise = taxable_paise + gst_paise`),
    check(
      "price_quotes_amount_due_ck",
      sql`amount_due_now_paise > 0 AND amount_due_now_paise <= total_paise`
    ),
    check(
      "price_quotes_status_ck",
      sql`status IN ('active', 'consumed', 'expired')`
    ),
  ]
);

/* -------------------------------------------------------------------------
 * Orders — where the statutory snapshot lives
 * ---------------------------------------------------------------------- */

/**
 * An order is an immutable commercial record. Nothing here is read through a
 * join at render time: contact details and the address are snapshotted inline
 * rather than referenced, because a customer moving house must not change
 * where a past order was shipped, and place of supply cannot be re-derived
 * later.
 *
 * `customerId` is a WEAK reference — plain text, indexed, no foreign key. That
 * is the structural half of the soft-delete design; see `customers`.
 *
 * PAYMENT PLANS, AND WHY THERE IS NO COD.
 * Two plans only: `full_prepaid` (paid online in full) and `booking_advance`
 * (advance online, balance settled at the counter on pickup). Cash on delivery
 * is not modelled and must not be added:
 *   - couriers ban jewellery outright — Blue Dart bans "Precious &
 *     Semi-Precious Items" across all services, Shiprocket lists jewellery as
 *     restricted with no liability and excludes it from its own insurance;
 *   - Income-tax Act 2025 s.186 bars *receiving* ₹2,00,000 or more in cash,
 *     aggregating per person per day and across a single event, with a
 *     s.451 penalty equal to 100% of the sum received — a bridal purchase is
 *     unusually exposed to that aggregation;
 *   - NPCI caps UPI P2M for the jewellery category at ₹2,00,000, so UPI cannot
 *     be the sole rail either.
 * The advance-plus-in-store-balance pattern sidesteps all three at once, and
 * matches how this shop already sells.
 */
export const orders = sqliteTable(
  "orders",
  {
    id: text("id").primaryKey(),
    /** Human-facing handle: "AJ-2607-0042". Never expose `id` in the UI. */
    orderNumber: text("order_number").notNull().unique(),
    /** Weak reference. No FK, deliberately — see the table comment. */
    customerId: text("customer_id"),
    quoteId: text("quote_id").references(() => priceQuotes.id),

    // --- Snapshotted contact + address (NOT foreign keys) ---
    contactName: text("contact_name").notNull(),
    contactPhone: text("contact_phone").notNull(),
    contactEmail: text("contact_email"),
    /**
     * `ship*` columns are nullable because a `store_pickup` order has no
     * shipping address; `orders_shipping_address_ck` requires them whenever
     * the order actually ships. CGST Rule 46(e)/(f) additionally requires the
     * recipient's name, delivery address and State code on any invoice of
     * ₹50,000 or more to an unregistered buyer — which most jewellery orders
     * are. Guest checkout may stay guest; it cannot stay anonymous.
     */
    shipName: text("ship_name"),
    shipLine1: text("ship_line1"),
    shipLine2: text("ship_line2"),
    shipCity: text("ship_city"),
    shipState: text("ship_state"),
    shipPincode: text("ship_pincode"),
    shipCountry: text("ship_country").notNull().default("IN"),
    billingSameAsShipping: integer("billing_same_as_shipping", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    billingJson: text("billing_json"),
    customerGstin: text("customer_gstin"),
    /**
     * PAN of the buyer, captured at checkout above the statutory threshold.
     *
     * Income-tax Act 2025 s.262(9) puts an affirmative duty on the *seller* to
     * ensure PAN (or Aadhaar) has been quoted and authenticated for notified
     * transactions; the ₹2,00,000 goods-and-services threshold survives into
     * Rule 159 (the renumbering of the old Rule 114B), and under 114B the
     * requirement applied irrespective of the mode of payment — card, UPI and
     * bank transfer included, not only cash. Penalty s.467: ₹10,000 per
     * default. Nullable because most orders fall below the threshold; absent
     * from the schema is not an option, because a ₹2.5 lakh UPI order has
     * nowhere to put it.
     *
     * This is sensitive PII. It is redacted by the same erasure job that
     * handles `customers`, subject to the same one-year floor, and it must
     * never be logged or sent to a webhook.
     */
    customerPan: text("customer_pan"),

    // --- Snapshotted money (paise) ---
    metalValuePaise: integer("metal_value_paise").notNull(),
    makingChargesPaise: integer("making_charges_paise").notNull(),
    stoneValuePaise: integer("stone_value_paise").notNull(),
    hallmarkingPaise: integer("hallmarking_paise").notNull().default(0),
    otherChargesPaise: integer("other_charges_paise").notNull().default(0),
    discountPaise: integer("discount_paise").notNull().default(0),
    shippingPaise: integer("shipping_paise").notNull().default(0),
    taxablePaise: integer("taxable_paise").notNull(),
    /** One rate for the whole order. See the long note on `priceQuotes`. */
    gstRateBps: integer("gst_rate_bps").notNull().default(300),
    gstPaise: integer("gst_paise").notNull(),
    /**
     * The CGST+SGST vs IGST split is decided by PLACE OF SUPPLY, not by
     * component. IGST Act s.10(1)(a): where the supply involves movement of
     * goods, place of supply is where the movement terminates for delivery —
     * so it is derived from the DELIVERY pincode's state, never the billing
     * address. For a store pickup, the shop's own state.
     */
    cgstPaise: integer("cgst_paise").notNull().default(0),
    sgstPaise: integer("sgst_paise").notNull().default(0),
    igstPaise: integer("igst_paise").notNull().default(0),
    totalPaise: integer("total_paise").notNull(),
    currency: text("currency").notNull().default("INR"),
    placeOfSupplyStateCode: text("place_of_supply_state_code"),

    // --- Payment plan (see the table comment: no COD) ---
    paymentPlan: text("payment_plan", {
      enum: ["full_prepaid", "booking_advance"],
    })
      .notNull()
      .default("full_prepaid"),
    fulfilmentMode: text("fulfilment_mode", { enum: ["ship", "store_pickup"] })
      .notNull()
      .default("ship"),
    /** Charged online now. Equals `totalPaise` when `full_prepaid`. */
    advanceDuePaise: integer("advance_due_paise").notNull(),
    advancePaidPaise: integer("advance_paid_paise").notNull().default(0),
    /** Settled at the counter. Always 0 when `full_prepaid`. */
    balanceDuePaise: integer("balance_due_paise").notNull().default(0),

    // --- State ---
    status: text("status", {
      enum: [
        "pending_payment",
        "advance_paid",
        "paid",
        "confirmed",
        "in_production",
        "ready_for_pickup",
        "shipped",
        "delivered",
        "cancelled",
        "refunded",
        "failed",
      ],
    })
      .notNull()
      .default("pending_payment"),
    paymentStatus: text("payment_status", {
      enum: [
        "unpaid",
        "authorized",
        "advance_captured",
        "captured",
        "partially_refunded",
        "refunded",
        "failed",
      ],
    })
      .notNull()
      .default("unpaid"),
    fulfilmentStatus: text("fulfilment_status", {
      enum: ["unfulfilled", "partially_fulfilled", "fulfilled", "returned"],
    })
      .notNull()
      .default("unfulfilled"),

    /**
     * Ticket number for a complaint lodged against this order, so the consumer
     * can track its status — E-Commerce Rule 7(1)(f) requires one to be issued
     * per complaint. Denormalised copy of the FIRST
     * `support_tickets.ticketNumber` raised on this order so the order page
     * and the invoice can print it without a join; `support_tickets` remains
     * authoritative and holds the full thread and the Rule 4(5) timers.
     *
     * NULL UNTIL A COMPLAINT IS ACTUALLY LODGED, and that is the point of the
     * column. Rule 4(5)'s clocks run from the receipt of a CONSUMER COMPLAINT,
     * not from a purchase, so placement writes nothing here: it is a single
     * column under a UNIQUE index, and filling it at placement leaves a real
     * complaint with nowhere to record its statutory number. A second complaint
     * on the same order lives in `support_tickets` alone — `orderId` there is a
     * weak reference and already supports many-to-one.
     */
    complaintTicketNumber: text("complaint_ticket_number"),

    /* --- Cancellation. A status transition, never a delete: see (7). ------ */

    /**
     * When this order was cancelled, and by whom, and why.
     *
     * All four are NULL on a live order and are written together, in the one
     * batch that also restores `variants.stockQuantity`. They exist as columns
     * rather than as an `admin_audit_log` row alone because the order's own
     * state has to be readable without a join: "is this piece back on the
     * wall, and on whose word?" is answered from the order, and the audit row
     * is the separate machine record of the same act.
     *
     * `cancelledBy` is an ACTOR, not a customer: an admin's email, or a
     * reserved word for an automated sweep. It is deliberately not a customer
     * identifier, so the DPDP erasure job has nothing to redact here.
     *
     * `cancellationReasonCode` is a closed set on the TypeScript side and
     * carries NO CHECK constraint: nothing the database itself guarantees
     * depends on the value, and adding one later would need a rebuild of a
     * table that holds statutory records. `cancellationNote` is the human
     * sentence — Rule 4(8) turns on why a cancellation happened and who
     * initiated it, so the reason is not optional at the call site even though
     * the column is nullable for every order that was never cancelled.
     *
     * There is no CHECK tying `status = 'cancelled'` to a non-null
     * `cancelledAt` for the same reason. It is a review rule, and the one code
     * path that writes either writes both.
     */
    cancelledAt: text("cancelled_at"),
    cancelledBy: text("cancelled_by"),
    cancellationReasonCode: text("cancellation_reason_code"),
    cancellationNote: text("cancellation_note"),

    /**
     * Written in the SAME batch as the line items. Any reader must assert it
     * matches the actual `order_items` count before invoicing, refunding or
     * fulfilling — this is how a torn write is detected when the database
     * cannot roll one back for us. See the header comment, compensation (5).
     */
    lineItemCount: integer("line_item_count").notNull(),

    notes: text("notes"),
    placedAt: text("placed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("orders_status_placed_idx").on(t.status, t.placedAt),
    index("orders_customer_idx").on(t.customerId),
    index("orders_phone_idx").on(t.contactPhone),
    uniqueIndex("orders_complaint_ticket_idx").on(t.complaintTicketNumber),
    /** The invoice must foot. A breakup that does not sum is unstorable. */
    check(
      "orders_taxable_foots_ck",
      sql`taxable_paise = metal_value_paise + making_charges_paise + stone_value_paise
        + hallmarking_paise + other_charges_paise - discount_paise + shipping_paise`
    ),
    check("orders_total_foots_ck", sql`total_paise = taxable_paise + gst_paise`),
    /**
     * CGST+SGST or IGST, never both, and always summing to the GST charged.
     * Compute `cgst = gst / 2` rounded down and `sgst = gst - cgst` so the
     * halves reconcile exactly on an odd number of paise.
     */
    check(
      "orders_gst_split_foots_ck",
      sql`gst_paise = cgst_paise + sgst_paise + igst_paise`
    ),
    /** The two money legs must account for the whole order, always. */
    check(
      "orders_payment_legs_foot_ck",
      sql`advance_due_paise + balance_due_paise = total_paise`
    ),
    /**
     * This is the "no COD" rule expressed structurally: a balance may exist
     * only on a booking-advance order, and a booking-advance order may only be
     * collected in store. There is therefore no representable state in which
     * money is owed to a courier at the door.
     */
    check(
      "orders_no_cod_ck",
      sql`(payment_plan = 'full_prepaid' AND balance_due_paise = 0)
        OR (payment_plan = 'booking_advance' AND fulfilment_mode = 'store_pickup' AND balance_due_paise > 0)`
    ),
    /** A shipped order needs a deliverable address; a pickup does not. */
    check(
      "orders_shipping_address_ck",
      sql`fulfilment_mode <> 'ship'
        OR (ship_name IS NOT NULL AND ship_line1 IS NOT NULL AND ship_city IS NOT NULL
            AND ship_state IS NOT NULL AND ship_pincode IS NOT NULL)`
    ),
    check("orders_line_item_count_ck", sql`line_item_count > 0`),
  ]
);

/**
 * THE STATUTORY SNAPSHOT. Every column below is frozen at order time and no
 * renderer may join back to `variants` or `products` to fill a gap.
 *
 * This is not defensive coding, it is a legal requirement. BIS (Hallmarking)
 * Regulations 2018 Reg. 5(11): "The bill or invoice of sale of hallmarked
 * precious metal articles shall indicate separately description of each
 * article, net weight of precious metal, purity in carat and fineness, and
 * hallmarking charges." Reg. 5(13) requires those records to be kept five
 * years or until sold, whichever is longer. A GST invoice must likewise be
 * reproducible years later.
 *
 * Four independent reasons the join would be wrong anyway: the metal rate
 * moves daily, so a join reprices the past; the admin will edit titles,
 * weights and photographs and must not retroactively rewrite what a customer
 * bought; archiving a product must not corrupt an order; and the rate row
 * itself is a historical fact.
 *
 * Both `goldRateId` AND the denormalised rate value are stored. The foreign
 * key proves provenance; the value survives independently. Belt and braces on
 * the one number the entire invoice hangs off.
 *
 * All per-unit money columns are PER UNIT. `quantity` is 1 for every
 * one-of-a-kind piece, which is the normal case here.
 */
export const orderItems = sqliteTable(
  "order_items",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),

    // --- Weak references, for reporting only. Nothing below is read from them. ---
    productId: text("product_id"),
    variantId: text("variant_id"),

    // ===================== FULL SNAPSHOT =====================
    sku: text("sku").notNull(),
    titleSnapshot: text("title_snapshot").notNull(),
    variantDescriptionSnapshot: text("variant_description_snapshot"),
    imageR2KeySnapshot: text("image_r2_key_snapshot"),

    metalSnapshot: text("metal_snapshot"),
    /** Millesimal fineness, the source of truth. */
    finenessSnapshot: integer("fineness_snapshot"),
    /**
     * The carat label as it was PRINTED on the invoice, derived from
     * `finenessSnapshot` at order time. Frozen only so a reprint is
     * byte-identical to the original document that Reg. 5(11) requires to
     * carry "purity in carat and fineness". It is never an input to anything:
     * fineness remains the source of truth and all pricing reads that.
     */
    purityCaratLabelSnapshot: text("purity_carat_label_snapshot"),
    netMetalWeightMg: integer("net_metal_weight_mg"),
    grossWeightMg: integer("gross_weight_mg"),

    /** The exact rate row used. Reconstructs the invoice forever. */
    goldRateId: text("gold_rate_id").references(() => goldRates.id),
    /** Denormalised copy, same unit as `gold_rates`. Paise per TEN grams. */
    goldRatePerTenGramsPaise: integer("gold_rate_per_ten_grams_paise"),
    /** When that rate became effective — the "as of" on the invoice line. */
    goldRateEffectiveFrom: text("gold_rate_effective_from"),
    /** When we read it, which is what the quote was actually built from. */
    goldRateCapturedAt: text("gold_rate_captured_at"),

    metalValuePaise: integer("metal_value_paise").notNull().default(0),
    makingChargeType: text("making_charge_type"),
    makingChargeValue: integer("making_charge_value"),
    makingChargePaise: integer("making_charge_paise").notNull().default(0),
    stoneValuePaise: integer("stone_value_paise").notNull().default(0),
    /** Separate invoice line, per Reg. 5(11). Never merged into making. */
    hallmarkingPaise: integer("hallmarking_paise").notNull().default(0),
    otherChargesPaise: integer("other_charges_paise").notNull().default(0),

    huidSnapshot: text("huid_snapshot"),
    certificateNumberSnapshot: text("certificate_number_snapshot"),
    certificateLabSnapshot: text("certificate_lab_snapshot"),
    diamondOriginSnapshot: text("diamond_origin_snapshot"),
    countryOfOriginSnapshot: text("country_of_origin_snapshot"),
    hsnCode: text("hsn_code").notNull().default("7113"),

    quantity: integer("quantity").notNull().default(1),
    /** Per unit, and equal to the sum of the per-unit components above. */
    unitPricePaise: integer("unit_price_paise").notNull(),
    lineDiscountPaise: integer("line_discount_paise").notNull().default(0),
    lineSubtotalPaise: integer("line_subtotal_paise").notNull(),
    lineGstRateBps: integer("line_gst_rate_bps").notNull().default(300),
    lineGstPaise: integer("line_gst_paise").notNull(),
    lineTotalPaise: integer("line_total_paise").notNull(),
    // =========================================================
  },
  (t) => [
    index("order_items_order_idx").on(t.orderId),
    index("order_items_variant_idx").on(t.variantId),
    check("order_items_quantity_positive_ck", sql`quantity > 0`),
    /**
     * The three line-level footing rules. GST is computed and rounded ONCE per
     * line (round half up), and the order-level `gstPaise` is the sum of these
     * — that ordering is what makes the lines add up to the total exactly,
     * instead of drifting by a paise or two against an order-level rounding.
     */
    check(
      "order_items_unit_price_foots_ck",
      sql`unit_price_paise = metal_value_paise + making_charge_paise + stone_value_paise
        + hallmarking_paise + other_charges_paise`
    ),
    check(
      "order_items_subtotal_foots_ck",
      sql`line_subtotal_paise = unit_price_paise * quantity - line_discount_paise`
    ),
    check(
      "order_items_total_foots_ck",
      sql`line_total_paise = line_subtotal_paise + line_gst_paise`
    ),
  ]
);

/* -------------------------------------------------------------------------
 * Payments, webhooks, stock reservations
 * ---------------------------------------------------------------------- */

/**
 * One row per payment attempt. The webhook is the source of truth; the
 * browser's "payment succeeded" redirect is a UX nicety and may be replayed,
 * spoofed or simply lost when the customer closes the tab.
 *
 * There is deliberately NO `cod` member in `method`. See the note on `orders`.
 * `in_store` covers the balance handed over at the counter, recorded by staff
 * with `provider = 'manual'` — which is also how an order is settled while the
 * gateway is still behind its KYC flag.
 *
 * Card data never reaches this application. With hosted/standard checkout the
 * Worker sees only the gateway's order id, payment id and signature, which is
 * what keeps RBI's card-on-file tokenisation regime entirely the gateway's
 * problem. `rawPayloadJson` must be scrubbed of anything resembling a PAN
 * before it is written, and watch the 2 MB D1 row cap.
 */
export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id").references(() => orders.id, {
      onDelete: "set null",
    }),
    quoteId: text("quote_id").references(() => priceQuotes.id),
    provider: text("provider", {
      enum: ["razorpay", "cashfree", "payu", "manual"],
    }).notNull(),
    providerOrderId: text("provider_order_id"),
    providerPaymentId: text("provider_payment_id"),
    method: text("method", {
      enum: [
        "upi",
        "card",
        "netbanking",
        "wallet",
        "emi",
        "bank_transfer",
        "in_store",
      ],
    }),
    /** Which leg of the order this settles. No cash-on-delivery leg exists. */
    kind: text("kind", {
      enum: ["booking_advance", "full_payment", "in_store_balance", "refund"],
    })
      .notNull()
      .default("full_payment"),
    amountPaise: integer("amount_paise").notNull(),
    status: text("status", {
      enum: ["created", "authorized", "captured", "failed", "refunded"],
    }).notNull(),
    /** Raw gateway payload for dispute forensics. See the table comment. */
    rawPayloadJson: text("raw_payload_json"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    uniqueIndex("payments_provider_payment_idx").on(
      t.provider,
      t.providerPaymentId
    ),
    index("payments_order_idx").on(t.orderId),
    check("payments_amount_positive_ck", sql`amount_paise > 0`),
  ]
);

/**
 * Webhook idempotency. The primary key is the PROVIDER's event id, so a retry
 * of an already-processed event collides on the primary key. Because this
 * insert sits inside the same `db.batch()` as the order insert, that collision
 * aborts the entire batch — the duplicate order, the duplicate line items and
 * the duplicate stock decrement all disappear together. This is the closest
 * thing to a rollback that D1 offers, and the schema depends on it.
 */
export const webhookEvents = sqliteTable(
  "webhook_events",
  {
    /** Provider event id — a natural primary key, not a generated one. */
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull(),
    processedAt: text("processed_at"),
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [index("webhook_events_received_idx").on(t.receivedAt)]
);

/**
 * A short-TTL hold on a piece during checkout, and THE concurrency primitive
 * for one-of-a-kind stock.
 *
 * D1 has no interactive transactions, so "read stock, decide, then write" is
 * unsafe: two buyers can both read `stock = 1`. Selling the same antique Jadau
 * set twice is unrecoverable, because there is no second one. Instead:
 *
 *   INSERT INTO stock_reservations (...) VALUES (...) ON CONFLICT DO NOTHING
 *
 * and check `meta.changes === 1`. The partial unique index below means SQLite
 * decides who wins the race, not application code. For a single piece, the
 * reservation *is* the lock.
 *
 * The index is deliberately conservative: it permits one live hold per variant
 * even where `stockQuantity > 1`, which serialises checkout on repeatable
 * designs. That is an acceptable trade at this shop's volume, and the real
 * oversell backstop for multi-stock variants is
 * `CHECK (stock_quantity >= 0)` on `variants`.
 *
 * `expiresAt` is not optional. A hold that never expires takes a unique piece
 * off sale permanently the first time someone abandons a checkout. Sweep stale
 * `held` rows to `released` on a schedule, or lazily on cart read if no cron
 * trigger is available on this platform.
 */
export const stockReservations = sqliteTable(
  "stock_reservations",
  {
    id: text("id").primaryKey(),
    variantId: text("variant_id")
      .notNull()
      .references(() => variants.id, { onDelete: "cascade" }),
    cartId: text("cart_id")
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    quantity: integer("quantity").notNull().default(1),
    status: text("status", { enum: ["held", "consumed", "released"] })
      .notNull()
      .default("held"),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    /** At most one live hold per variant, enforced by the database itself. */
    uniqueIndex("stock_reservations_active_idx")
      .on(t.variantId)
      .where(sql`status = 'held'`),
    index("stock_reservations_expiry_idx").on(t.status, t.expiresAt),
    /** The partial index above depends on this value, so pin it. */
    check(
      "stock_reservations_status_ck",
      sql`status IN ('held', 'consumed', 'released')`
    ),
    check("stock_reservations_quantity_positive_ck", sql`quantity > 0`),
  ]
);

/* -------------------------------------------------------------------------
 * Support tickets
 * ---------------------------------------------------------------------- */

/**
 * Consumer complaints, with the trackable ticket number that E-Commerce
 * Rule 7(1)(f) requires to be issued for each complaint lodged.
 *
 * `acknowledgeDueAt` and `redressDueAt` exist because Rule 4(5) gives the
 * grievance officer hard timelines — acknowledge within forty-eight hours,
 * redress within one month of receipt. Storing the deadlines rather than
 * recomputing them means an overdue queue is one indexed query.
 *
 * `orderId` and `customerId` are weak references, not foreign keys: a complaint
 * must survive independently of anything the erasure job does, and it must be
 * possible to lodge one without an order at all.
 *
 * ---------------------------------------------------------------------------
 * A ROW HERE IS A GRIEVANCE CLOCK. DO NOT OPEN ONE FOR A PURCHASE.
 * ---------------------------------------------------------------------------
 * Rule 4(5) triggers on the RECEIPT OF A CONSUMER COMPLAINT. Both deadline
 * columns are `notNull`, so every row that exists here asserts two statutory
 * deadlines against the shop. Writing one per order — which this code did
 * until the clocks were removed from `placeOrder()` — makes the database
 * assert a breached SLA on every purchase within two days, destroys the
 * overdue queue `support_tickets_status_due_idx` exists to serve, and consumes
 * the single `orders.complaintTicketNumber` slot that a real complaint needs.
 *
 * The deadlines are computed from the date the complaint was RECEIVED, which
 * may be earlier than the moment it is typed in: a complaint arrives by phone
 * on Monday and is entered on Wednesday with Monday's clocks.
 */
export const supportTickets = sqliteTable(
  "support_tickets",
  {
    id: text("id").primaryKey(),
    /** The number given to the consumer. Human-facing: "AJ-C-2607-0007". */
    ticketNumber: text("ticket_number").notNull().unique(),
    orderId: text("order_id"),
    customerId: text("customer_id"),
    /** Snapshotted so the thread stays answerable after any redaction. */
    contactName: text("contact_name").notNull(),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    /**
     * NO DEFAULT, DELIBERATELY. This column used to default to `'complaint'`,
     * which meant any insert that forgot it filed a consumer complaint against
     * the shop — silently, with the Rule 4(5) clocks the two `notNull` deadline
     * columns below make mandatory. Classifying the row is now something the
     * writer has to do on purpose, and an insert that omits it fails.
     */
    kind: text("kind", {
      enum: ["complaint", "return", "exchange", "query", "other"],
    }).notNull(),
    subject: text("subject").notNull(),
    body: text("body"),
    status: text("status", {
      enum: ["open", "acknowledged", "in_progress", "resolved", "closed"],
    })
      .notNull()
      .default("open"),
    assignedTo: text("assigned_to"),
    /** Rule 4(5): forty-eight hours from receipt. */
    acknowledgeDueAt: text("acknowledge_due_at").notNull(),
    acknowledgedAt: text("acknowledged_at"),
    /** Rule 4(5): one month from receipt. */
    redressDueAt: text("redress_due_at").notNull(),
    resolvedAt: text("resolved_at"),
    resolutionNote: text("resolution_note"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("support_tickets_status_due_idx").on(t.status, t.redressDueAt),
    index("support_tickets_order_idx").on(t.orderId),
  ]
);

/* -------------------------------------------------------------------------
 * Admin
 * ---------------------------------------------------------------------- */

/**
 * WHO MAY SIGN IN, AND WITH WHAT.
 *
 * This table was written as an authorisation ALLOWLIST for a world where
 * identity came from the platform's sign-in. That is no longer true: the
 * recorded decision (`.claude-protocol/decisions.json` -> `adminAuth`) is a
 * password the shop owns, so this table is now a CREDENTIAL STORE as well, and
 * the columns below are what a login actually needs.
 *
 * Store the email lowercased and compare lowercased — a case mismatch here is a
 * silent lockout. That used to be a comment and is now a CHECK.
 *
 * ---------------------------------------------------------------------------
 * ONE CREDENTIAL PER PERSON — `.claude-protocol/decisions.json` -> adminAttribution
 * ---------------------------------------------------------------------------
 * Shops share passwords with a son or a counter assistant. The moment that
 * happens `admin_audit_log.actor_email` asserts something UNTRUE about who read
 * a customer's PAN, and a false audit trail is worse than none because it gets
 * produced in evidence. So this table has seats, and adding a second person is
 * an INSERT rather than a redesign. Nothing in the auth code assumes one row.
 *
 * ---------------------------------------------------------------------------
 * WHY THE KDF PARAMETERS ARE COLUMNS AND NOT CONSTANTS
 * ---------------------------------------------------------------------------
 * Cloudflare Workers has no Argon2 and no bcrypt, caps PBKDF2 at 100,000
 * iterations, and on the Free plan gives a request 10 ms of CPU. So the work
 * factor cannot be raised to where OWASP would want it, and it will have to
 * move once the plan tier is known. `password_algo`, `password_iterations` and
 * `password_salt` are therefore stored PER ROW: the count can be raised, or the
 * algorithm replaced, by rehashing on the next successful sign-in — never by a
 * migration that would lock everyone out of a live shop.
 *
 * The security does not rest on the KDF and is not supposed to. It rests on a
 * passphrase that is GENERATED at ~100 bits and never chosen by a human, and on
 * an env-held pepper that never touches this database — so a D1-only leak
 * yields nothing crackable at any iteration count. See `app/_admin/auth.ts`.
 *
 * ---------------------------------------------------------------------------
 * THE CHECKS, AND WHY THEY ARE ADDED NOW
 * ---------------------------------------------------------------------------
 * Migrations here are forward-only, and SQLite cannot add a CHECK to a table
 * without RECREATING it (create -> copy -> drop -> rename). This table is empty
 * today and stops being empty at the first sign-in, so the window in which
 * these constraints are free closes permanently at that moment. All three are
 * therefore added in the same migration as the credential columns:
 *
 *   email is lower-cased    the doc comment always SAID this and nothing
 *                           enforced it.
 *   role is a closed set    authorisation is a database guarantee, not a
 *                           presentational enum (see ENUMS at the head of this
 *                           file for when a CHECK is warranted).
 *   the credential is whole a half-written credential — a hash with no salt, a
 *                           salt with no iteration count — must be impossible,
 *                           because verification would then either throw or,
 *                           worse, silently compare against a default.
 */
export const adminUsers = sqliteTable(
  "admin_users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    displayName: text("display_name"),
    role: text("role", { enum: ["owner", "manager", "staff"] })
      .notNull()
      .default("staff"),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    lastSeenAt: text("last_seen_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),

    /* --- the credential. All four are set together or none of them is. --- */

    /** base64url of the derived bits. NULL = this seat has no password yet. */
    passwordHash: text("password_hash"),
    /** base64url of 16 CSPRNG bytes, unique per row. */
    passwordSalt: text("password_salt"),
    /** e.g. `pbkdf2-sha256-pepper-v1`. Named so the KDF can be replaced. */
    passwordAlgo: text("password_algo"),
    /** Stored per row so the work factor can be raised without a migration. */
    passwordIterations: integer("password_iterations"),
    passwordUpdatedAt: text("password_updated_at"),

    /* --- throttling. There is no KV and no Durable Object on this plan, so
     * the counter lives here: one read and one UPDATE per attempt.
     * Deliberately NOT a permanent lockout — with few accounts a hard lockout
     * is an attacker-triggerable denial of the shop's own order book. The
     * backoff has a ceiling and clears itself. See `app/_admin/auth.ts`. --- */

    failedLoginCount: integer("failed_login_count").notNull().default(0),
    /** ISO-8601 UTC. NULL = not throttled. */
    lockedUntil: text("locked_until"),

    /** Distinct from `lastSeenAt`: when a session was last MINTED, not used. */
    lastLoginAt: text("last_login_at"),
  },
  (t) => [
    check("admin_users_email_lower_ck", sql`${t.email} = lower(${t.email})`),
    check("admin_users_role_ck", sql`${t.role} in ('owner', 'manager', 'staff')`),
    check(
      "admin_users_credential_complete_ck",
      sql`(${t.passwordHash} is null and ${t.passwordSalt} is null and ${t.passwordAlgo} is null and ${t.passwordIterations} is null)
       or (${t.passwordHash} is not null and ${t.passwordSalt} is not null and ${t.passwordAlgo} is not null and ${t.passwordIterations} is not null and ${t.passwordIterations} > 0)`
    ),
  ]
);

/**
 * SERVER-SIDE SESSIONS. The cookie carries an opaque bearer token; everything
 * that decides what its holder may do is read from here and from `admin_users`
 * on every single request.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE RATHER THAN A SELF-CONTAINED SIGNED COOKIE
 * ---------------------------------------------------------------------------
 * A stateless `{email, role, exp}` cookie cannot be revoked before it expires.
 * Sign-out becomes advisory, a stolen cookie stays valid, and setting
 * `admin_users.is_active = 0` on a departed employee does nothing until the
 * cookie ages out. Revocation on the next request is the whole point of an
 * allowlist, and a stateless cookie destroys exactly that property. One indexed
 * D1 read per admin request buys it back, which at this shop's volume is free.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS STORED IS A HASH, NOT THE TOKEN
 * ---------------------------------------------------------------------------
 * `token_hash` is SHA-256 of the bearer token, so a database dump does not hand
 * over live sessions. The cookie additionally carries an HMAC over the token,
 * so a forged or truncated cookie is refused BEFORE D1 is touched — the same
 * discipline `isWellFormedCartToken()` applies to the cart cookie.
 *
 * NO AUTHORISATION DATA IS CARRIED IN THE COOKIE AT ALL. There is nothing in it
 * to forge except an opaque id that must exist in this table, and role and
 * active-status are re-read from `admin_users` every time, so a downgrade takes
 * effect on the next request rather than at expiry.
 *
 * ---------------------------------------------------------------------------
 * TWO CLOCKS
 * ---------------------------------------------------------------------------
 * `expires_at` is the ABSOLUTE lifetime — a session dies at it however busy the
 * shop is. `idle_expires_at` slides forward on use and kills a terminal that
 * was left alone. A counter terminal in a jewellery shop is visible to the
 * public; the cart's thirty-day cookie is right for a cart and wrong here.
 *
 * `created_at` has NO `CURRENT_TIMESTAMP` default, which is a deliberate
 * departure from the TIMES convention at the head of this file.
 * `CURRENT_TIMESTAMP` renders `YYYY-MM-DD HH:MM:SS` — no `T`, no zone — and the
 * window CHECK below compares these columns LEXICOGRAPHICALLY. Mixing the two
 * formats would make `'2026-08-09T09:00:00.000Z' > '2026-08-09 23:00:00'` true,
 * which is nonsense. So the shape is constrained by the CHECK and written by
 * the application, in one format, always.
 */
export const adminSessions = sqliteTable(
  "admin_sessions",
  {
    id: text("id").primaryKey(),
    /**
     * The one place a cascade is right: a deleted admin's sessions must die
     * with them, in the same statement, rather than outliving the row that
     * authorises them.
     */
    adminUserId: text("admin_user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    /** SHA-256 of the bearer token, base64url. NEVER the token itself. */
    tokenHash: text("token_hash").notNull().unique(),
    /** ISO-8601 UTC, written by the application. See the note above. */
    createdAt: text("created_at").notNull(),
    /** Absolute lifetime. */
    expiresAt: text("expires_at").notNull(),
    /** Idle timeout; slides forward on use, clamped to `expires_at`. */
    idleExpiresAt: text("idle_expires_at").notNull(),
    lastSeenAt: text("last_seen_at"),
    /** Set on sign-out and on "sign out everywhere". Never a DELETE. */
    revokedAt: text("revoked_at"),
    /** Why: `signed_out`, `superseded`, `password_changed`, `deactivated`. */
    revokedReason: text("revoked_reason"),
    /**
     * Loosely useful for "these are your active sessions". Deliberately NOT a
     * binding condition — Indian mobile networks re-NAT constantly, and a
     * session bound to an IP is a support burden wearing a control.
     */
    userAgent: text("user_agent"),
    /**
     * The ADMIN's own address, which is the shop's operator rather than a
     * customer. `app/api/appointments/route.ts` declines to store VISITOR IPs
     * and that rule is untouched by this column.
     */
    ip: text("ip"),
  },
  (t) => [
    index("admin_sessions_user_idx").on(t.adminUserId, t.revokedAt),
    index("admin_sessions_expiry_idx").on(t.expiresAt),
    check(
      "admin_sessions_window_ck",
      sql`${t.createdAt} like '____-__-__T__:__:__%Z'
       and ${t.expiresAt} > ${t.createdAt}
       and ${t.idleExpiresAt} <= ${t.expiresAt}`
    ),
  ]
);

/**
 * Not optional polish, and not merely wise: REQUIRED.
 *
 * DPDP Rule 6(1)(c) obliges "visibility on the accessing of such personal data,
 * through appropriate logs, monitoring and review, for enabling detection of
 * unauthorised access", and CERT-In direction (iv) obliges logs of all ICT
 * systems for a rolling 180 days — the latter in force TODAY. It is also the
 * answer to "who changed the 916 rate at 4pm, and why did that order price
 * differ?", which will be asked.
 *
 * ---------------------------------------------------------------------------
 * READS ARE LOGGED, NOT ONLY WRITES
 * ---------------------------------------------------------------------------
 * Rule 6(1)(c) is about ACCESS. It is also the difference between a breach
 * notification that names eleven customers and one that must go to every
 * customer in the database, because a system that cannot say which records a
 * compromised session actually read has to assume all of them.
 *
 * ---------------------------------------------------------------------------
 * `diff_json` IS ALLOWLIST-DRIVEN AND HAS EXACTLY ONE WRITER
 * ---------------------------------------------------------------------------
 * A naive whole-row diff of an `orders` or `customers` update would write a
 * name, a phone, a full address and a PAN into this table — a second,
 * unmanaged copy of the exact data the log exists to protect, sitting outside
 * the erasure job's reach. So a value is recorded only when its column is on
 * the allowlist in `app/_admin/audit.ts`; everything else is recorded as the
 * indicator `"changed"`. Never a PAN, a password, a hash, a salt, the pepper, a
 * session id, a CSRF token, an ingest token or a raw gateway payload.
 *
 * ---------------------------------------------------------------------------
 * APPEND-ONLY, AND HONESTLY DESCRIBED
 * ---------------------------------------------------------------------------
 * No admin code path may UPDATE or DELETE a row here. That stops accidents and
 * stops a compromised session; it does NOT stop whoever holds the D1
 * credentials, who is realistically the same person the log describes. The only
 * real answer is the off-box mirror in `app/_admin/audit.ts` (also the CERT-In
 * Indian-jurisdiction answer), and until it is configured this log is evidence
 * the shop keeps for itself, not a control over the shop.
 */
export const adminAuditLog = sqliteTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    /**
     * A string rather than an FK, deliberately, so the record survives the
     * admin row being deleted. With one credential per person it is true; with
     * a shared credential it would be a lie, which is why the credential is
     * per person.
     */
    actorEmail: text("actor_email").notNull(),
    /**
     * The row this actor was, when there was one. NULL for events with no
     * authenticated actor — a refused sign-in naming an address that has no
     * seat, for instance.
     */
    actorAdminUserId: text("actor_admin_user_id"),
    /** Dotted action name: "order.status_changed", "rate.updated". */
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    diffJson: text("diff_json"),
    /**
     * REFUSED attempts are the half of the record that matters most: the
     * 6-hour CERT-In clock has nothing to start from unless a failed sign-in
     * leaves a trace. Defaulted so the ALTER needs no table rebuild.
     */
    result: text("result", { enum: ["ok", "refused"] })
      .notNull()
      .default("ok"),
    /** The ADMIN's own address. Visitor IPs are still not stored anywhere. */
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (t) => [
    index("admin_audit_created_idx").on(t.createdAt),
    index("admin_audit_entity_idx").on(t.entityType, t.entityId),
    /** "What did this person do, most recent first" — the forensic query. */
    index("admin_audit_actor_idx").on(t.actorEmail, t.createdAt),
  ]
);
