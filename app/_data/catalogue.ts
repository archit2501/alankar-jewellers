/**
 * THE CATALOGUE DATA LAYER. One module, read by the listing (`/shop`) and by the
 * product page (`/shop/[slug]`), returning exactly the shapes in `./types.ts`.
 *
 * ===========================================================================
 * 1. WHERE EACH FIELD COMES FROM, AND WHY THE SEAM IS WHERE IT IS
 * ===========================================================================
 * `./types.ts` already explains why imagery does NOT come out of the database:
 * `product_media.r2Key` is `notNull`, R2 is not enabled on the account yet, and
 * writing static asset paths into a column called `r2Key` would be a lie the
 * next developer has to unpick. The same argument applies to the alt text that
 * belongs to those photographs, and to `spec` — the caption line that describes
 * what is visible IN the photograph — because neither has a column that is not
 * a misuse of something else.
 *
 * So the seam is:
 *
 *   DATABASE (authoritative)   title, subtitle, description, every pricing
 *                              input, every compliance field, stock, and the
 *                              collections a piece belongs to.
 *   MANIFEST (this file)       mediaKey, alt, altBack, spec — keyed by slug.
 *
 * A product row whose slug has no manifest entry CANNOT be rendered: it would
 * have no photograph and no alt text. Such a row is skipped and logged rather
 * than shown with an empty `alt`. When R2 comes online, `PRESENTATION` below and
 * `mediaKey` in `./types.ts` are the single seam to change.
 *
 * ===========================================================================
 * 2. THE DATABASE IS NOT REQUIRED FOR THE STOREFRONT TO RENDER
 * ===========================================================================
 * `getDb()` throws when the D1 binding is absent, and the `products` table does
 * not exist until the migration has been applied. Neither is a reason to serve a
 * 500 on a catalogue of five placeholder pieces, so every read below falls back
 * to `CATALOGUE_SEED` — which is the same content the seed script writes, so the
 * fallback and the seeded database agree by construction rather than by luck.
 *
 * The fallback is NOT a silent invention: it is the identical row set, and it is
 * logged once per failure so an operator can see that D1 was unreachable.
 *
 * ===========================================================================
 * 3. THIS IS PLACEHOLDER INVENTORY, AND IT SAYS SO IN THE DATA
 * ===========================================================================
 * The real catalogue does not exist yet. Every piece here is therefore
 * `pricingMode: "on_request"`, and every field that would be a checkable claim
 * about a physical object is NULL rather than plausible:
 *
 *   netMetalWeightMg / grossWeightMg   NULL — nothing has been weighed.
 *   fineness / hallmarkPurityMark      NULL — nothing has been assayed.
 *   makingChargeType / Value           NULL — no rate card has been given to us.
 *   huid                               NULL — a HUID is a government-issued
 *                                      identifier. Inventing one is not a
 *                                      placeholder, it is a fake credential.
 *   certificateNumber / certificateLab NULL — same argument.
 *
 * `hallmarkingPaise: 0` is NOT a placeholder and must not be "filled in later"
 * by default: QCO cl. 2(3) exempts Kundan, Polki and Jadau — every piece below —
 * from mandatory hallmarking, and `app/_pricing/price.ts` deliberately emits no
 * component at all for a zero, so no invoice implies a hallmark that does not
 * exist.
 *
 * ===========================================================================
 * 4. PRICING GOES THROUGH THE TYPED RATE RESULT. NEVER THROUGH A CAST.
 * ===========================================================================
 * `readCurrentRate()` returns a discriminated union whose failure arm has NO
 * `rate` property, so a stale rate cannot be read as zero. This module narrows
 * on `lookup.ok` and nowhere assumes a number. A piece whose rate is stale,
 * missing or unreadable comes back with `price: null` and a
 * `priceUnavailableReason`, and the UI is required to print "price on request"
 * rather than a figure.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import { getDb } from "../../db";
import {
  collections as collectionsTable,
  productCollections,
  products,
  variants,
} from "../../db/schema";
import type { ImageKey } from "../_media/images";
import { isPriceableMetal, priceLine, type MetalRate } from "../_pricing/price";
import { formatPaiseAsRupees, readCurrentRate, type RateLookup } from "../_pricing/rates";
import type { CatalogueFilter, CataloguePiece, Fineness, PricedPiece } from "./types";

/* =========================================================================
 * Presentation manifest — the half that is not in the database. See (1).
 * ====================================================================== */

type Presentation = {
  readonly mediaKey: { readonly front: ImageKey; readonly back: ImageKey | null };
  readonly alt: string;
  readonly altBack: string | null;
  /** The line the shop would say out loud. Describes the photograph. */
  readonly spec: string;
};

/**
 * Copy, alt text and imagery are VERBATIM from `app/page.tsx`, so the homepage
 * and the catalogue cannot drift into describing the same photograph two
 * different ways.
 */
const PRESENTATION: Readonly<Record<string, Presentation>> = {
  "jadau-haar": {
    mediaKey: { front: "jadau-haar-front", back: "jadau-haar-reverse" },
    alt: "Jadau haar of uncut polki closed-set in gold, hung with carved ruby and emerald drops on a red silk cord",
    altBack:
      "The same haar turned over: every plate enamelled on a red ground with a white and green lotus",
    spec: "Uncut polki · carved ruby and emerald drops · silk cord",
  },
  "polki-choker": {
    mediaKey: { front: "polki-choker-front", back: "polki-choker-reverse" },
    alt: "Polki choker of kundan-set uncut diamonds with a pearl fringe, strung on a red silk cord and tassel",
    altBack:
      "The same choker turned over: a green enamel ground carrying one white and red flower per cell",
    spec: "Kundan-set polki · pearl fringe · silk cord and tassel",
  },
  "chandbali-earrings": {
    mediaKey: { front: "chandbali-earrings-front", back: "chandbali-earrings-reverse" },
    alt: "Pair of crescent chandbali earrings in granulated gold with rose-cut polki and pearl and emerald bead drops",
    altBack:
      "The same pair turned over: a green, red and white lotus spread across the whole of each crescent",
    spec: "Crescent chandbali · rose-cut polki · pearl and emerald drops",
  },
  "kundan-kada": {
    mediaKey: { front: "kundan-kada-front", back: "kundan-kada-reverse" },
    alt: "Hinged gold kada set with kundan flowerheads, rimmed in seed pearls, with carved emerald terminals",
    altBack:
      "The same kada turned over: a red and green flowering vine enamelled around the inner face",
    spec: "Closed-set kundan · seed-pearl rim · carved emerald terminals",
  },
  "maang-tikka": {
    mediaKey: { front: "maang-tikka-front", back: "maang-tikka-reverse" },
    alt: "Round gold maang tikka set with kundan around a ruby centre, a polki drop below and a woven chain above",
    altBack: "Turn over to see the concentric floral meenakari rosette on the back of the disc",
    spec: "Kundan-set polki · ruby centre · woven chain",
  },
};

/* =========================================================================
 * Collections
 * ====================================================================== */

export type CatalogueCollection = {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string | null;
  readonly kind: "category" | "collection" | "occasion";
  readonly position: number;
};

/**
 * Editorial classification only. A collection says what KIND of object this is
 * and roughly when it is worn — both readable from the photograph — so none of
 * it is a claim about weight, purity or provenance that a buyer could catch us
 * inventing.
 */
export const CATALOGUE_COLLECTIONS: readonly CatalogueCollection[] = [
  { id: "col_necklaces", slug: "necklaces", title: "Necklaces", description: null, kind: "category", position: 10 },
  { id: "col_earrings", slug: "earrings", title: "Earrings", description: null, kind: "category", position: 20 },
  { id: "col_bangles", slug: "bangles", title: "Bangles", description: null, kind: "category", position: 30 },
  { id: "col_headpieces", slug: "headpieces", title: "Headpieces", description: null, kind: "category", position: 40 },
  {
    id: "col_jadau-polki",
    slug: "jadau-polki",
    title: "Jadau & Polki",
    description: "Uncut stones held by pressed gold rather than by claws.",
    kind: "collection",
    position: 50,
  },
  {
    id: "col_kundan",
    slug: "kundan",
    title: "Kundan",
    description: "Closed-set flowerheads, bedded in shellac and closed by hand.",
    kind: "collection",
    position: 60,
  },
  {
    id: "col_meenakari",
    slug: "meenakari",
    title: "Enamelled reverse",
    description: "Photographed from behind, because the back is where the enamel is.",
    kind: "collection",
    position: 70,
  },
  {
    id: "col_bridal",
    slug: "bridal",
    title: "Bridal",
    description: null,
    kind: "occasion",
    position: 80,
  },
];

const COLLECTION_BY_SLUG = new Map(CATALOGUE_COLLECTIONS.map((c) => [c.slug, c]));

/** Title for a collection slug, falling back to the slug itself. */
export function collectionTitle(slug: string): string {
  return COLLECTION_BY_SLUG.get(slug)?.title ?? slug;
}

/* =========================================================================
 * The seed — one definition, used by the seed script AND as the fallback
 * ====================================================================== */

/** The database-shaped extras a `CataloguePiece` has no field for. */
export type CatalogueSeedRow = {
  readonly piece: CataloguePiece;
  readonly variantId: string;
  readonly sku: string;
  readonly craft: "jadau" | "polki" | "diamond" | "gold" | "kundan" | "other";
  readonly status: "draft" | "active" | "archived";
  readonly saleMode: "buy_online" | "enquire_only" | "appointment_only";
  readonly position: number;
};

function seedPiece(input: {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  collections: readonly string[];
}): CataloguePiece {
  const presentation = PRESENTATION[input.slug];
  if (presentation === undefined) {
    // Unreachable for the five below; a compile-time table would need a literal
    // union that the seed script cannot extend, so this is checked instead.
    throw new Error(`No presentation manifest entry for "${input.slug}".`);
  }

  return {
    id: `prd_${input.slug}`,
    slug: input.slug,
    title: input.title,
    subtitle: input.subtitle,
    description: input.description,
    spec: presentation.spec,

    // See (3): placeholder inventory, so nothing measurable is asserted.
    pricingMode: "on_request",
    fineness: null,
    metal: "gold",
    netMetalWeightMg: null,
    grossWeightMg: null,
    makingChargeType: null,
    makingChargeValue: null,
    stoneValuePaise: 0,
    // Not a placeholder: QCO cl. 2(3) exempts Kundan, Polki and Jadau.
    hallmarkingPaise: 0,
    otherChargesPaise: 0,
    fixedPricePaise: null,

    huid: null,
    hallmarkPurityMark: null,
    certificateNumber: null,
    certificateLab: null,

    stockQuantity: 1,
    isUniquePiece: true,

    mediaKey: presentation.mediaKey,
    alt: presentation.alt,
    altBack: presentation.altBack,

    collections: input.collections,
  };
}

/**
 * The five pieces, in the order the wall hangs them. Titles, specs, copy and alt
 * text are verbatim from `app/page.tsx`.
 */
export const CATALOGUE_SEED_ROWS: readonly CatalogueSeedRow[] = [
  {
    piece: seedPiece({
      slug: "jadau-haar",
      title: "Jadau haar",
      subtitle: "Necklace",
      description:
        "Gold and stone on the face. On the back, a lotus fired into every single plate.",
      collections: ["necklaces", "jadau-polki", "meenakari", "bridal"],
    }),
    variantId: "var_jadau-haar",
    sku: "AJ-JADAU-HAAR-01",
    craft: "jadau",
    status: "active",
    saleMode: "enquire_only",
    position: 10,
  },
  {
    piece: seedPiece({
      slug: "polki-choker",
      title: "Polki choker",
      subtitle: "Choker",
      description:
        "Close-set stones sit shoulder to shoulder in front. Behind them, green enamel and thirty small flowers.",
      collections: ["necklaces", "jadau-polki", "meenakari", "bridal"],
    }),
    variantId: "var_polki-choker",
    sku: "AJ-POLKI-CHOKER-01",
    craft: "polki",
    status: "active",
    saleMode: "enquire_only",
    position: 20,
  },
  {
    piece: seedPiece({
      slug: "chandbali-earrings",
      title: "Chandbali earrings",
      subtitle: "Earrings",
      description:
        "Worn, the reverse faces the wearer's neck. It is still the more decorated of the two sides.",
      collections: ["earrings", "jadau-polki", "meenakari", "bridal"],
    }),
    variantId: "var_chandbali-earrings",
    sku: "AJ-CHANDBALI-01",
    craft: "polki",
    status: "active",
    saleMode: "enquire_only",
    position: 30,
  },
  {
    piece: seedPiece({
      slug: "kundan-kada",
      title: "Kundan kada",
      subtitle: "Bangle",
      description:
        "The inside of a bangle touches only the wrist, which is exactly why this one is enamelled.",
      collections: ["bangles", "kundan", "meenakari", "bridal"],
    }),
    variantId: "var_kundan-kada",
    sku: "AJ-KUNDAN-KADA-01",
    craft: "kundan",
    status: "active",
    saleMode: "enquire_only",
    position: 40,
  },
  {
    piece: seedPiece({
      slug: "maang-tikka",
      title: "Maang tikka",
      subtitle: "Headpiece",
      description:
        "The smallest piece here, and the back of it is worked as carefully as the front nobody questions.",
      collections: ["headpieces", "kundan", "meenakari", "bridal"],
    }),
    variantId: "var_maang-tikka",
    sku: "AJ-MAANG-TIKKA-01",
    craft: "kundan",
    status: "active",
    saleMode: "enquire_only",
    position: 50,
  },
];

/** The five pieces as the storefront sees them. */
export const CATALOGUE_SEED: readonly CataloguePiece[] = CATALOGUE_SEED_ROWS.map(
  (row) => row.piece
);

/**
 * TRUE while the catalogue is placeholder inventory rather than the shop's real
 * stock. The listing reads this to say so on the page; it is the catalogue's
 * equivalent of `SITE_DETAILS_PENDING` in `app/site-config.ts`.
 *
 * Flip it to `false` only when the pieces below are actual pieces with actual
 * weights, and the "placeholder" notice disappears from the storefront.
 */
export const CATALOGUE_IS_PLACEHOLDER = true;

/* =========================================================================
 * Reading the database
 * ====================================================================== */

const FINENESS_VALUES = [999, 995, 916, 750, 585] as const;

/** Narrow a database integer to the millesimal fineness union. Never a cast. */
export function toFineness(value: number | null | undefined): Fineness | null {
  if (typeof value !== "number") return null;
  return FINENESS_VALUES.find((candidate) => candidate === value) ?? null;
}

function isPricingMode(value: string): value is CataloguePiece["pricingMode"] {
  return value === "dynamic_metal" || value === "fixed" || value === "on_request";
}

/** One row of the products x variants join, before presentation is attached. */
type CommerceRow = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  pricingMode: string;
  fineness: number | null;
  metal: string;
  netMetalWeightMg: number | null;
  grossWeightMg: number | null;
  makingChargeType: string | null;
  makingChargeValue: number | null;
  stoneValuePaise: number;
  hallmarkingPaise: number;
  otherChargesPaise: number;
  fixedPricePaise: number | null;
  huid: string | null;
  hallmarkPurityMark: string | null;
  certificateNumber: string | null;
  certificateLab: string | null;
  stockQuantity: number;
  isUniquePiece: boolean;
  position: number;
};

/**
 * Read the live catalogue, or `null` when D1 cannot answer.
 *
 * `null` is deliberately distinct from `[]`: an empty table is a real answer
 * ("nothing is published"), a thrown binding is not, and only the latter should
 * fall back to the compiled seed.
 */
async function readCommerceRows(): Promise<CataloguePiece[] | null> {
  let rows: CommerceRow[];

  try {
    const db = getDb();
    rows = (await db
      .select({
        id: products.id,
        slug: products.slug,
        title: products.title,
        subtitle: products.subtitle,
        description: products.description,
        pricingMode: variants.pricingMode,
        fineness: variants.fineness,
        metal: variants.metal,
        netMetalWeightMg: variants.netMetalWeightMg,
        grossWeightMg: variants.grossWeightMg,
        makingChargeType: variants.makingChargeType,
        makingChargeValue: variants.makingChargeValue,
        stoneValuePaise: variants.stoneValuePaise,
        hallmarkingPaise: variants.hallmarkingPaise,
        otherChargesPaise: variants.otherChargesPaise,
        fixedPricePaise: variants.fixedPricePaise,
        huid: variants.huid,
        hallmarkPurityMark: variants.hallmarkPurityMark,
        certificateNumber: variants.certificateNumber,
        certificateLab: variants.certificateLab,
        stockQuantity: variants.stockQuantity,
        isUniquePiece: variants.isUniquePiece,
        position: variants.position,
      })
      .from(products)
      .innerJoin(variants, eq(variants.productId, products.id))
      .where(eq(products.status, "active"))
      .orderBy(asc(variants.position), asc(products.title))) as CommerceRow[];
  } catch (error) {
    console.error("[catalogue] catalogue store unavailable:", error);
    return null;
  }

  if (rows.length === 0) return [];

  let membership: Map<string, string[]>;
  try {
    membership = await readCollectionMembership(rows.map((row) => row.id));
  } catch (error) {
    console.error("[catalogue] collection membership unavailable:", error);
    membership = new Map();
  }

  const pieces: CataloguePiece[] = [];

  for (const row of rows) {
    const presentation = PRESENTATION[row.slug];
    if (presentation === undefined) {
      // No photograph and no alt text — see (1). Showing it would mean shipping
      // an <img> with an empty alt, which is worse than not showing it at all.
      console.warn(
        `[catalogue] product "${row.slug}" has no imagery in app/_data/catalogue.ts; not listed.`
      );
      continue;
    }
    if (!isPricingMode(row.pricingMode)) {
      console.warn(`[catalogue] product "${row.slug}" has an unknown pricing mode; not listed.`);
      continue;
    }

    pieces.push({
      id: row.id,
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      description: row.description,
      spec: presentation.spec,
      pricingMode: row.pricingMode,
      fineness: toFineness(row.fineness),
      metal: row.metal,
      netMetalWeightMg: row.netMetalWeightMg,
      grossWeightMg: row.grossWeightMg,
      makingChargeType: row.makingChargeType,
      makingChargeValue: row.makingChargeValue,
      stoneValuePaise: row.stoneValuePaise,
      hallmarkingPaise: row.hallmarkingPaise,
      otherChargesPaise: row.otherChargesPaise,
      fixedPricePaise: row.fixedPricePaise,
      huid: row.huid,
      hallmarkPurityMark: row.hallmarkPurityMark,
      certificateNumber: row.certificateNumber,
      certificateLab: row.certificateLab,
      stockQuantity: row.stockQuantity,
      isUniquePiece: row.isUniquePiece,
      mediaKey: presentation.mediaKey,
      alt: presentation.alt,
      altBack: presentation.altBack,
      collections: membership.get(row.id) ?? [],
    });
  }

  return pieces;
}

/** D1 caps a statement at 100 bound parameters, so ids go in in chunks. */
const ID_CHUNK = 50;

async function readCollectionMembership(productIds: readonly string[]) {
  const db = getDb();
  const membership = new Map<string, string[]>();

  for (let index = 0; index < productIds.length; index += ID_CHUNK) {
    const chunk = productIds.slice(index, index + ID_CHUNK);
    const rows = await db
      .select({
        productId: productCollections.productId,
        slug: collectionsTable.slug,
      })
      .from(productCollections)
      .innerJoin(collectionsTable, eq(collectionsTable.id, productCollections.collectionId))
      .where(
        and(
          inArray(productCollections.productId, chunk),
          eq(collectionsTable.isVisible, true)
        )
      )
      .orderBy(asc(collectionsTable.position));

    for (const row of rows) {
      const existing = membership.get(row.productId);
      if (existing) existing.push(row.slug);
      else membership.set(row.productId, [row.slug]);
    }
  }

  return membership;
}

/** Every published piece, from D1 when it answers and from the seed when not. */
export async function readCatalogue(): Promise<CataloguePiece[]> {
  const rows = await readCommerceRows();
  if (rows === null) return [...CATALOGUE_SEED];
  if (rows.length === 0) {
    console.warn(
      "[catalogue] no active products in D1; serving the compiled seed. Run `node scripts/seed-catalogue.mjs`."
    );
    return [...CATALOGUE_SEED];
  }
  return rows;
}

/* =========================================================================
 * Filtering
 * ====================================================================== */

/**
 * The metal / fineness / collection half of a `CatalogueFilter` — everything
 * that can be decided without knowing a price.
 */
export function matchesStructuralFilter(
  piece: CataloguePiece,
  filter: CatalogueFilter
): boolean {
  if (filter.metal !== undefined && piece.metal.toLowerCase() !== filter.metal.toLowerCase()) {
    return false;
  }
  if (filter.fineness !== undefined && piece.fineness !== filter.fineness) {
    return false;
  }
  if (filter.collection !== undefined && !piece.collections.includes(filter.collection)) {
    return false;
  }
  return true;
}

/**
 * The price half. A piece with no resolvable price is EXCLUDED by a price bound
 * rather than treated as zero — "price on request" is not "free", and letting a
 * ₹0 through a "under ₹1 lakh" filter is exactly the failure the whole rate
 * layer fails closed to prevent.
 */
export function matchesPriceFilter(piece: PricedPiece, filter: CatalogueFilter): boolean {
  if (filter.minPaise === undefined && filter.maxPaise === undefined) return true;
  if (piece.price === null) return false;
  if (filter.minPaise !== undefined && piece.price.totalPaise < filter.minPaise) return false;
  if (filter.maxPaise !== undefined && piece.price.totalPaise > filter.maxPaise) return false;
  return true;
}

/* =========================================================================
 * Pricing
 * ====================================================================== */

/** Injectable so tests can drive every arm of the rate union without a database. */
export type RateReader = (
  metal: string,
  fineness: number,
  nowMs: number
) => Promise<RateLookup>;

export type PricingOptions = {
  readonly nowMs?: number;
  readonly readRate?: RateReader;
};

function rateKey(metal: string, fineness: number): string {
  return `${metal}:${fineness}`;
}

/**
 * `RateUnavailableReason` has four members; `PricedPiece.priceUnavailableReason`
 * has two that can apply. `rate_stale` is kept distinct because the UI says
 * something different about it ("today's rate has not been confirmed") from what
 * it says when no rate was ever recorded.
 */
function unavailableReason(lookup: Extract<RateLookup, { ok: false }>) {
  return lookup.reason === "rate_stale" ? ("rate_stale" as const) : ("rate_missing" as const);
}

function unpriced(
  piece: CataloguePiece,
  reason: PricedPiece["priceUnavailableReason"]
): PricedPiece {
  return { ...piece, price: null, priceUnavailableReason: reason };
}

/**
 * Attach a price to each piece.
 *
 * Rates are read ONCE per (metal, fineness) for the whole list rather than once
 * per piece: five pieces of 916 gold is one query, not five, and D1 is
 * single-threaded.
 */
export async function priceCataloguePieces(
  pieces: readonly CataloguePiece[],
  options: PricingOptions = {}
): Promise<PricedPiece[]> {
  const nowMs = options.nowMs ?? Date.now();
  const readRate = options.readRate ?? readCurrentRate;

  const needed = new Map<string, { metal: string; fineness: number }>();
  for (const piece of pieces) {
    if (piece.pricingMode !== "dynamic_metal") continue;
    if (piece.fineness === null) continue;
    needed.set(rateKey(piece.metal, piece.fineness), {
      metal: piece.metal,
      fineness: piece.fineness,
    });
  }

  const lookups = new Map<string, RateLookup>();
  await Promise.all(
    [...needed].map(async ([key, { metal, fineness }]) => {
      lookups.set(key, await readRate(metal, fineness, nowMs));
    })
  );

  return pieces.map((piece) => pricePiece(piece, lookups, nowMs));
}

function pricePiece(
  piece: CataloguePiece,
  lookups: ReadonlyMap<string, RateLookup>,
  nowMs: number
): PricedPiece {
  if (piece.pricingMode === "on_request") {
    return unpriced(piece, "on_request");
  }

  try {
    if (piece.pricingMode === "fixed") {
      if (piece.fixedPricePaise === null) {
        console.error(`[catalogue] "${piece.slug}" is priced fixed but carries no fixed price.`);
        return unpriced(piece, "rate_missing");
      }
      const line = priceLine({
        pricingMode: "fixed",
        fixedPricePaise: piece.fixedPricePaise,
        hallmarkingPaise: piece.hallmarkingPaise,
        otherChargesPaise: piece.otherChargesPaise,
      });
      return {
        ...piece,
        price: {
          totalPaise: line.lineTotalPaise,
          breakup: line.components.map((component) => ({
            label: component.label,
            amountPaise: component.amountPaise,
          })),
          // A flat-quoted piece is not priced from a metal rate at all, so the
          // only honest "as of" is the instant the quote was resolved.
          rateAsOf: new Date(nowMs).toISOString(),
        },
        priceUnavailableReason: null,
      };
    }

    // dynamic_metal.
    if (piece.fineness === null || piece.netMetalWeightMg === null) {
      // Nothing has been weighed or assayed yet — the placeholder state. The
      // database CHECK forbids this combination, so it can only arrive from the
      // compiled seed, and "on request" is exactly what it means.
      return unpriced(piece, "on_request");
    }
    if (!isPriceableMetal(piece.metal)) {
      console.error(`[catalogue] "${piece.slug}" has no priceable metal (${piece.metal}).`);
      return unpriced(piece, "rate_missing");
    }

    const lookup = lookups.get(rateKey(piece.metal, piece.fineness));
    if (lookup === undefined || !lookup.ok) {
      // NOTE: the failure arm has no `rate` property at all, so there is nothing
      // here that could be read as a number. See app/_pricing/rates.ts.
      return unpriced(piece, lookup === undefined ? "rate_missing" : unavailableReason(lookup));
    }
    if (!isPriceableMetal(lookup.rate.metal)) {
      console.error(`[catalogue] the stored rate for "${piece.slug}" names an unpriceable metal.`);
      return unpriced(piece, "rate_missing");
    }

    const rate: MetalRate = {
      metal: lookup.rate.metal,
      fineness: lookup.rate.fineness,
      ratePerTenGramsPaise: lookup.rate.ratePerTenGramsPaise,
    };

    const line = priceLine({
      pricingMode: "dynamic_metal",
      rate,
      metal: piece.metal,
      fineness: piece.fineness,
      netMetalWeightMg: piece.netMetalWeightMg,
      ...(piece.makingChargeType === "percent" ||
      piece.makingChargeType === "per_gram" ||
      piece.makingChargeType === "flat"
        ? {
            makingCharge: {
              type: piece.makingChargeType,
              value: piece.makingChargeValue ?? 0,
            },
          }
        : {}),
      stoneValuePaise: piece.stoneValuePaise,
      hallmarkingPaise: piece.hallmarkingPaise,
      otherChargesPaise: piece.otherChargesPaise,
    });

    return {
      ...piece,
      price: {
        totalPaise: line.lineTotalPaise,
        breakup: line.components.map((component) => ({
          label: component.label,
          amountPaise: component.amountPaise,
        })),
        rateAsOf: lookup.rate.effectiveFrom,
      },
      priceUnavailableReason: null,
    };
  } catch (error) {
    // The engine throws rather than returning NaN. Fail closed: a piece whose
    // inputs the engine refuses is shown as "price on request", never as a
    // number we could not compute.
    console.error(`[catalogue] could not price "${piece.slug}":`, error);
    return unpriced(piece, "rate_missing");
  }
}

/* =========================================================================
 * The public read API — what /shop and /shop/[slug] call
 * ====================================================================== */

/**
 * Every piece matching `filter`, without prices.
 *
 * `minPaise` / `maxPaise` are IGNORED here, because applying them needs a rate
 * and this function promises not to read one. Use `listPricedCatalogue` when a
 * price band is part of the query — it is the function the listing page calls.
 */
export async function listCatalogue(filter: CatalogueFilter = {}): Promise<CataloguePiece[]> {
  const pieces = await readCatalogue();
  return pieces.filter((piece) => matchesStructuralFilter(piece, filter));
}

/** Every piece matching `filter`, priced against the prevailing rate. */
export async function listPricedCatalogue(
  filter: CatalogueFilter = {},
  options: PricingOptions = {}
): Promise<PricedPiece[]> {
  const pieces = await listCatalogue(filter);
  const priced = await priceCataloguePieces(pieces, options);
  return priced.filter((piece) => matchesPriceFilter(piece, filter));
}

/** One piece by slug, or `null`. */
export async function getCataloguePiece(slug: string): Promise<CataloguePiece | null> {
  const pieces = await readCatalogue();
  return pieces.find((piece) => piece.slug === slug) ?? null;
}

/** One piece by slug, priced. `null` when there is no such piece. */
export async function getPricedCataloguePiece(
  slug: string,
  options: PricingOptions = {}
): Promise<PricedPiece | null> {
  const piece = await getCataloguePiece(slug);
  if (piece === null) return null;
  const [priced] = await priceCataloguePieces([piece], options);
  return priced ?? null;
}

/* =========================================================================
 * Query-string plumbing — the listing filters, without JavaScript
 * ====================================================================== */

/**
 * The price bands the listing offers, as inclusive paise bounds.
 * ₹1 lakh = 100,000 rupees = 10,000,000 paise.
 */
export const PRICE_BANDS = [
  { key: "under-1l", label: "Under ₹1 lakh", maxPaise: 9_999_999 },
  { key: "1l-3l", label: "₹1 – 3 lakh", minPaise: 10_000_000, maxPaise: 29_999_999 },
  { key: "3l-6l", label: "₹3 – 6 lakh", minPaise: 30_000_000, maxPaise: 59_999_999 },
  { key: "6l-plus", label: "₹6 lakh and above", minPaise: 60_000_000 },
] as const satisfies readonly {
  key: string;
  label: string;
  minPaise?: number;
  maxPaise?: number;
}[];

export type PriceBandKey = (typeof PRICE_BANDS)[number]["key"];

/** The query keys the listing reads. One per filter, all optional. */
export const FILTER_PARAMS = ["metal", "purity", "collection", "price"] as const;
export type FilterParam = (typeof FILTER_PARAMS)[number];

/** What was asked for, as strings, so the form can re-select what was chosen. */
export type CatalogueQuery = Readonly<Record<FilterParam, string>>;

export const EMPTY_QUERY: CatalogueQuery = {
  metal: "",
  purity: "",
  collection: "",
  price: "",
};

type RawSearchParams = Readonly<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return (value[0] ?? "").trim();
  return (value ?? "").trim();
}

/**
 * Turn `?metal=gold&purity=916&collection=bridal&price=1l-3l` into a
 * `CatalogueFilter`, discarding anything that is not a value this catalogue
 * actually offers. An unknown value is dropped rather than 404ing: a stale
 * bookmark should show the catalogue, not an error.
 */
export function parseCatalogueFilter(params: RawSearchParams): {
  filter: CatalogueFilter;
  query: CatalogueQuery;
} {
  const metal = firstValue(params.metal).toLowerCase();
  const purity = firstValue(params.purity);
  const collection = firstValue(params.collection);
  const price = firstValue(params.price);

  const fineness = toFineness(Number.parseInt(purity, 10));
  const band = PRICE_BANDS.find((candidate) => candidate.key === price);

  const filter: CatalogueFilter = {
    ...(metal ? { metal } : {}),
    ...(fineness !== null ? { fineness } : {}),
    ...(collection && COLLECTION_BY_SLUG.has(collection) ? { collection } : {}),
    ...(band && "minPaise" in band ? { minPaise: band.minPaise } : {}),
    ...(band && "maxPaise" in band ? { maxPaise: band.maxPaise } : {}),
  };

  return {
    filter,
    query: {
      metal: filter.metal ?? "",
      purity: filter.fineness === undefined ? "" : String(filter.fineness),
      collection: filter.collection ?? "",
      price: band ? band.key : "",
    },
  };
}

/** `/shop`, or `/shop?…` — the canonical URL for a query. */
export function catalogueHref(query: CatalogueQuery): string {
  const search = new URLSearchParams();
  for (const key of FILTER_PARAMS) {
    if (query[key]) search.set(key, query[key]);
  }
  const rendered = search.toString();
  return rendered ? `/shop?${rendered}` : "/shop";
}

/** The same query with one filter cleared — the "remove this chip" link. */
export function withoutFilter(query: CatalogueQuery, key: FilterParam): CatalogueQuery {
  return { ...query, [key]: "" };
}

export function isFiltered(query: CatalogueQuery): boolean {
  return FILTER_PARAMS.some((key) => query[key] !== "");
}

/* =========================================================================
 * Facets — the options a filter control may offer
 * ====================================================================== */

export type Facets = {
  /** Distinct metals present, lower-cased, sorted. */
  readonly metals: readonly string[];
  /** Distinct finenesses present. EMPTY while nothing has been assayed. */
  readonly finenesses: readonly Fineness[];
  /** Collections that actually contain something, in catalogue order. */
  readonly collections: readonly CatalogueCollection[];
};

/**
 * Facets are derived from the data rather than hard-coded, so a control never
 * offers a value that returns nothing — and, just as important, the purity
 * control is visibly EMPTY while no piece has a recorded fineness, instead of
 * offering five karat options against inventory that has never been assayed.
 */
export function catalogueFacets(pieces: readonly CataloguePiece[]): Facets {
  const metals = new Set<string>();
  const finenesses = new Set<Fineness>();
  const collectionSlugs = new Set<string>();

  for (const piece of pieces) {
    metals.add(piece.metal.toLowerCase());
    if (piece.fineness !== null) finenesses.add(piece.fineness);
    for (const slug of piece.collections) collectionSlugs.add(slug);
  }

  return {
    metals: [...metals].sort(),
    finenesses: [...finenesses].sort((a, b) => b - a),
    collections: CATALOGUE_COLLECTIONS.filter((collection) =>
      collectionSlugs.has(collection.slug)
    ),
  };
}

/* =========================================================================
 * Display
 * ====================================================================== */

/**
 * Integer paise as a rupee string, without ever creating a float — the
 * formatting lives in `app/_pricing/rates.ts` and is reused rather than
 * reimplemented. Whole rupees drop the ".00", because a jeweller's price tag
 * does not carry paise.
 */
export function formatPricePaise(paise: number): string {
  const rendered = formatPaiseAsRupees(paise);
  return `₹${rendered.endsWith(".00") ? rendered.slice(0, -3) : rendered}`;
}

/** What the storefront says instead of a number, and why. Never a zero. */
export function priceUnavailableCopy(
  reason: PricedPiece["priceUnavailableReason"]
): { headline: string; note: string | null } {
  switch (reason) {
    case "rate_stale":
      return {
        headline: "Price on request",
        note: "Today's gold rate has not been confirmed yet, so we are not quoting a figure.",
      };
    case "rate_missing":
      return {
        headline: "Price on request",
        note: "We cannot read a gold rate right now, so we are not quoting a figure.",
      };
    case "on_request":
      return {
        headline: "Price on request",
        note: null,
      };
    default:
      return { headline: "Price on request", note: null };
  }
}
