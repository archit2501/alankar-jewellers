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
 * by default: QCO cl. 2(3) exempts Kundan, Polki and Jadau from mandatory
 * hallmarking, and `app/_pricing/price.ts` deliberately emits no component at
 * all for a zero, so no invoice implies a hallmark that does not exist. Note the
 * word "exempts" is doing real work — it is NOT true of the two plain gold
 * demonstration pieces described next, which do carry the fee.
 *
 * ===========================================================================
 * 3a. FOUR PIECES BELOW ARE DEMONSTRATION STOCK, AND ARE PRICED
 * ===========================================================================
 * The five heirloom pieces above remain exactly as (3) describes. Beneath them
 * sit four small everyday pieces built by `demoPiece()` which DO carry a weight,
 * a fineness and a making charge, and which are `saleMode: "buy_online"`.
 *
 * They exist because a shop cannot be handed a storefront whose buy, cart and
 * checkout path has never been walked end to end. Nothing about the price
 * engine, stock reservation or the statutory price breakup can be demonstrated
 * — or reviewed by the owner — against a catalogue that is priced on request.
 *
 * WHAT THEIR NUMBERS ARE: plausible, internally consistent, and INVENTED. No
 * scale has touched any of these pieces because none of them physically exists.
 * They are here to exercise the arithmetic, not to describe stock.
 *
 * WHAT IS STILL REFUSED: `huid`, `certificateNumber` and `hallmarkPurityMark`
 * stay NULL. Those are credentials rather than measurements, and a plausible
 * invented HUID is a forged government identifier no matter how clearly the
 * surrounding page is labelled a demonstration.
 *
 * `CATALOGUE_IS_PLACEHOLDER` therefore stays TRUE, and the notice it renders on
 * the shop page must keep saying — accurately — which of these pieces carry
 * figures and which do not. Deleting these four is a data change and nothing
 * more: no code depends on their existence.
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
import type {
  CatalogueFilter,
  CataloguePiece,
  Craft,
  Fineness,
  PricedPiece,
  SaleMode,
} from "./types";

/* =========================================================================
 * Presentation manifest — the half that is not in the database. See (1).
 * ====================================================================== */

type Presentation = {
  readonly mediaKey: {
    readonly front: ImageKey;
    readonly back: ImageKey | null;
    /** The piece worn. See (1a). */
    readonly worn: ImageKey | null;
  };
  readonly alt: string;
  readonly altBack: string | null;
  readonly altWorn: string | null;
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
    mediaKey: { front: "jadau-haar-front", back: "jadau-haar-reverse", worn: null },
    alt: "Jadau haar of uncut polki closed-set in gold, hung with carved ruby and emerald drops on a red silk cord",
    altBack:
      "The same haar turned over: every plate enamelled on a red ground with a white and green lotus",
    altWorn: null,
    spec: "Uncut polki · carved ruby and emerald drops · silk cord",
  },
  "polki-choker": {
    mediaKey: { front: "polki-choker-front", back: "polki-choker-reverse", worn: null },
    alt: "Polki choker of kundan-set uncut diamonds with a pearl fringe, strung on a red silk cord and tassel",
    altBack:
      "The same choker turned over: a green enamel ground carrying one white and red flower per cell",
    altWorn: null,
    spec: "Kundan-set polki · pearl fringe · silk cord and tassel",
  },
  "chandbali-earrings": {
    mediaKey: { front: "chandbali-earrings-front", back: "chandbali-earrings-reverse", worn: null },
    alt: "Pair of crescent chandbali earrings in granulated gold with rose-cut polki and pearl and emerald bead drops",
    altBack:
      "The same pair turned over: a green, red and white lotus spread across the whole of each crescent",
    altWorn: null,
    spec: "Crescent chandbali · rose-cut polki · pearl and emerald drops",
  },
  "kundan-kada": {
    mediaKey: { front: "kundan-kada-front", back: "kundan-kada-reverse", worn: null },
    alt: "Hinged gold kada set with kundan flowerheads, rimmed in seed pearls, with carved emerald terminals",
    altBack:
      "The same kada turned over: a red and green flowering vine enamelled around the inner face",
    altWorn: null,
    spec: "Closed-set kundan · seed-pearl rim · carved emerald terminals",
  },
  "maang-tikka": {
    mediaKey: { front: "maang-tikka-front", back: "maang-tikka-reverse", worn: null },
    alt: "Round gold maang tikka set with kundan around a ruby centre, a polki drop below and a woven chain above",
    altBack: "Turn over to see the concentric floral meenakari rosette on the back of the disc",
    altWorn: null,
    spec: "Kundan-set polki · ruby centre · woven chain",
  },

  /* --- The four demonstration pieces. See (3a). ------------------------- */

  "gold-jhumka": {
    mediaKey: { front: "gold-jhumka-front", back: "gold-jhumka-reverse", worn: "gold-jhumka-worn" },
    alt: "Pair of small gold jhumka earrings, each a granulated dome hung with a fringe of seed pearls",
    altBack:
      "The same pair turned over: the inside of each dome enamelled in red and green around a gold lotus",
    altWorn:
      "The jhumka worn: the granulated dome and its pearl fringe hanging at the ear",
    spec: "Granulated gold · seed-pearl fringe · enamelled inside",
  },
  "polki-ring": {
    mediaKey: { front: "polki-ring-front", back: null, worn: "polki-ring-worn" },
    alt: "Slim gold ring with one uncut polki diamond closed in a kundan bezel, ringed with granulation",
    altBack: null,
    altWorn:
      "The ring worn on a hand, showing how small the band and its single stone are",
    spec: "One uncut polki · kundan bezel · granulated shoulders",
  },
  "lotus-pendant": {
    mediaKey: { front: "lotus-pendant-front", back: "lotus-pendant-reverse", worn: "lotus-pendant-worn" },
    alt: "Eight-petalled gold lotus pendant, granulated throughout, ringed with polki around a cabochon emerald",
    altBack:
      "The same pendant turned over: one red and green lotus enamelled across the whole of the back",
    altWorn:
      "The pendant worn at the throat on a fine chain, showing its everyday scale",
    spec: "Granulated lotus · polki ring · cabochon emerald",
  },
  "slim-kada": {
    mediaKey: { front: "slim-kada-front", back: null, worn: "slim-kada-worn" },
    alt: "Slim round gold kada chased all the way round with a fine vine pattern, closed by a plain hinged clasp",
    altBack: null,
    altWorn:
      "The kada worn on a wrist, showing how slim the chased band sits",
    spec: "Chased vine · hinged clasp · no stones",
  },

  /* --- Bridal demonstration pieces. See (3a). --------------------------- */

  "rani-haar": {
    mediaKey: { front: "rani-haar-front", back: "rani-haar-reverse", worn: "rani-haar-worn" },
    alt: "Three-strand rani haar of carved ruby and emerald beads and pearls, hung with seven kundan-set polki medallions and a drop",
    altBack:
      "The same haar turned over: a pink and green lotus enamelled on the back of every medallion and on the drop",
    altWorn:
      "The haar worn: three strands falling below the collarbone with the drop at the centre",
    spec: "Three strands · carved ruby and emerald · kundan medallions",
  },
  "bridal-tikka": {
    mediaKey: { front: "bridal-tikka-front", back: "bridal-tikka-reverse", worn: "bridal-tikka-worn" },
    alt: "Bridal maang tikka: a kundan-set polki medallion hung with carved emerald and ruby drops, on a pearl and gold chain",
    altBack:
      "The same tikka turned over: a red and green lotus enamelled across the back of the medallion",
    altWorn:
      "The tikka worn at the hairline, its chain running back over the parting",
    spec: "Kundan-set polki · carved bead drops · pearl chain",
  },
  "jadau-kangan": {
    mediaKey: { front: "jadau-kangan-front", back: "jadau-kangan-reverse", worn: "jadau-kangan-worn" },
    alt: "Wide bridal jadau kangan of polki flowerheads bedded in gold, rimmed in seed pearls with carved emerald beads",
    altBack:
      "The same kangan turned over: a red and green flowering vine enamelled right round the inner face",
    altWorn:
      "The kangan worn on a wrist, showing the full width of the stone-set band",
    spec: "Jadau flowerheads · seed-pearl rim · carved emerald",
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
  readonly status: "draft" | "active" | "archived";
  readonly position: number;
};

function seedPiece(input: {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  craft: Craft;
  saleMode: SaleMode;
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
    craft: input.craft,
    saleMode: input.saleMode,

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
    altWorn: presentation.altWorn,

    collections: input.collections,
  };
}

/**
 * A DEMONSTRATION piece — see (3a). Deliberately a separate function from
 * `seedPiece` rather than an options bag on it, because the two say opposite
 * things and the name is the warning: `seedPiece` asserts nothing measurable,
 * and this one asserts a weight the shop has never put on a scale.
 *
 * What it still refuses to invent, exactly as `seedPiece` does:
 *
 *   huid                  A HUID is a government-issued identifier. A made-up
 *                         one is a fake credential whether or not the piece
 *                         behind it is real, so it stays NULL and the storefront
 *                         explains the absence.
 *   certificateNumber     Same argument.
 *   hallmarkPurityMark    Asserts an assay that has not happened.
 *
 * `hallmarkingPaise` is NOT uniform here, and that is the point. QCO cl. 2(3)
 * exempts Kundan, Polki and Jadau, so the two stone-set pieces carry 0 — but a
 * plain gold jhumka and a plain gold kada are NOT exempt, and a shop selling
 * them charges the BIS fee per article. Passing 0 for those would have quietly
 * made the demonstration teach the wrong invoice.
 */
function demoPiece(input: {
  slug: string;
  title: string;
  subtitle: string;
  description: string;
  craft: Craft;
  saleMode: SaleMode;
  collections: readonly string[];
  /** Millesimal fineness. 916 is the 22-carat this shop works in. */
  fineness: Fineness;
  netMetalWeightMg: number;
  grossWeightMg: number;
  makingChargeType: "percent" | "per_gram" | "flat";
  /** Basis points of METAL VALUE for `percent`, paise for the other two. */
  makingChargeValue: number;
  stoneValuePaise: number;
  /** 0 where QCO cl. 2(3) exempts the piece; the BIS per-article fee otherwise. */
  hallmarkingPaise: number;
}): CataloguePiece {
  const presentation = PRESENTATION[input.slug];
  if (presentation === undefined) {
    throw new Error(`No presentation manifest entry for "${input.slug}".`);
  }

  return {
    id: `prd_${input.slug}`,
    slug: input.slug,
    title: input.title,
    subtitle: input.subtitle,
    description: input.description,
    spec: presentation.spec,
    craft: input.craft,
    saleMode: input.saleMode,

    pricingMode: "dynamic_metal",
    fineness: input.fineness,
    metal: "gold",
    netMetalWeightMg: input.netMetalWeightMg,
    grossWeightMg: input.grossWeightMg,
    makingChargeType: input.makingChargeType,
    makingChargeValue: input.makingChargeValue,
    stoneValuePaise: input.stoneValuePaise,
    hallmarkingPaise: input.hallmarkingPaise,
    otherChargesPaise: 0,
    fixedPricePaise: null,

    // Never invented, in demonstration data or anywhere else.
    huid: null,
    hallmarkPurityMark: null,
    certificateNumber: null,
    certificateLab: null,

    stockQuantity: 1,
    isUniquePiece: true,

    mediaKey: presentation.mediaKey,
    alt: presentation.alt,
    altBack: presentation.altBack,
    altWorn: presentation.altWorn,

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
      saleMode: "enquire_only",
      title: "Jadau haar",
      subtitle: "Necklace",
      description:
        "Gold and stone on the face. On the back, a lotus fired into every single plate.",
      craft: "jadau",
      collections: ["necklaces", "jadau-polki", "meenakari", "bridal"],
    }),
    variantId: "var_jadau-haar",
    sku: "AJ-JADAU-HAAR-01",
    status: "active",
    position: 10,
  },
  {
    piece: seedPiece({
      slug: "polki-choker",
      saleMode: "enquire_only",
      title: "Polki choker",
      subtitle: "Choker",
      description:
        "Close-set stones sit shoulder to shoulder in front. Behind them, green enamel and thirty small flowers.",
      craft: "polki",
      collections: ["necklaces", "jadau-polki", "meenakari", "bridal"],
    }),
    variantId: "var_polki-choker",
    sku: "AJ-POLKI-CHOKER-01",
    status: "active",
    position: 20,
  },
  {
    piece: seedPiece({
      slug: "chandbali-earrings",
      saleMode: "enquire_only",
      title: "Chandbali earrings",
      subtitle: "Earrings",
      description:
        "Worn, the reverse faces the wearer's neck. It is still the more decorated of the two sides.",
      craft: "polki",
      collections: ["earrings", "jadau-polki", "meenakari", "bridal"],
    }),
    variantId: "var_chandbali-earrings",
    sku: "AJ-CHANDBALI-01",
    status: "active",
    position: 30,
  },
  {
    piece: seedPiece({
      slug: "kundan-kada",
      saleMode: "enquire_only",
      title: "Kundan kada",
      subtitle: "Bangle",
      description:
        "The inside of a bangle touches only the wrist, which is exactly why this one is enamelled.",
      craft: "kundan",
      collections: ["bangles", "kundan", "meenakari", "bridal"],
    }),
    variantId: "var_kundan-kada",
    sku: "AJ-KUNDAN-KADA-01",
    status: "active",
    position: 40,
  },
  {
    piece: seedPiece({
      slug: "maang-tikka",
      saleMode: "enquire_only",
      title: "Maang tikka",
      subtitle: "Headpiece",
      description:
        "The smallest piece here, and the back of it is worked as carefully as the front nobody questions.",
      craft: "kundan",
      collections: ["headpieces", "kundan", "meenakari", "bridal"],
    }),
    variantId: "var_maang-tikka",
    sku: "AJ-MAANG-TIKKA-01",
    status: "active",
    position: 50,
  },

  /* =======================================================================
   * DEMONSTRATION STOCK — see (3a). Everything below is buyable and priced.
   *
   * Small everyday pieces, which is deliberate on two counts. It is what
   * actually sells online, and it keeps the split the schema was built around
   * intact: `saleMode` exists so a bridal set worth several lakhs converts
   * through a private viewing rather than a Buy button. The five pieces above
   * stay `enquire_only` for exactly that reason.
   * ==================================================================== */

  {
    piece: demoPiece({
      slug: "gold-jhumka",
      saleMode: "buy_online",
      title: "Gold jhumka",
      subtitle: "Earrings",
      description:
        "Small enough for a working day. The enamel is inside the bell, where only the wearer's neck ever sees it.",
      craft: "gold",
      collections: ["earrings", "meenakari"],
      fineness: 916,
      netMetalWeightMg: 8_200,
      grossWeightMg: 8_900,
      makingChargeType: "percent",
      makingChargeValue: 1400, // 14% of metal value
      stoneValuePaise: 0, // seed pearls, carried in the making charge
      hallmarkingPaise: 4500, // plain gold: NOT exempt, BIS fee per article
    }),
    variantId: "var_gold-jhumka",
    sku: "AJ-JHUMKA-01",
    status: "active",
    position: 60,
  },
  {
    piece: demoPiece({
      slug: "polki-ring",
      saleMode: "buy_online",
      title: "Polki ring",
      subtitle: "Ring",
      description:
        "One uncut stone, closed in by hand with pure gold. The oldest setting there is, on the smallest thing we make.",
      craft: "polki",
      collections: ["jadau-polki", "kundan"],
      fineness: 916,
      netMetalWeightMg: 3_600,
      grossWeightMg: 3_900,
      makingChargeType: "percent",
      makingChargeValue: 1800, // 18% — small pieces carry proportionally more work
      stoneValuePaise: 1_850_000, // the polki, ₹18,500
      hallmarkingPaise: 0, // QCO cl. 2(3): polki, exempt
    }),
    variantId: "var_polki-ring",
    sku: "AJ-RING-01",
    status: "active",
    position: 70,
  },
  {
    piece: demoPiece({
      slug: "lotus-pendant",
      saleMode: "buy_online",
      title: "Lotus pendant",
      subtitle: "Pendant",
      description:
        "Eight petals of granulation on the face. One whole lotus, in enamel, on the side that faces in.",
      craft: "kundan",
      collections: ["necklaces", "kundan", "meenakari"],
      fineness: 916,
      netMetalWeightMg: 6_400,
      grossWeightMg: 7_100,
      makingChargeType: "percent",
      makingChargeValue: 1600,
      stoneValuePaise: 1_240_000, // emerald cabochon and the polki ring, ₹12,400
      hallmarkingPaise: 0, // QCO cl. 2(3): kundan-set, exempt
    }),
    variantId: "var_lotus-pendant",
    sku: "AJ-PENDANT-01",
    status: "active",
    position: 80,
  },
  {
    piece: demoPiece({
      slug: "slim-kada",
      saleMode: "buy_online",
      title: "Slim kada",
      subtitle: "Bangle",
      description:
        "No stones and nothing to catch. A vine chased right round it, and a clasp you can work one-handed.",
      craft: "gold",
      collections: ["bangles"],
      fineness: 916,
      netMetalWeightMg: 14_800,
      grossWeightMg: 14_800, // no stones, so gross and net are the same
      makingChargeType: "per_gram",
      makingChargeValue: 65_000, // ₹650 per gram
      stoneValuePaise: 0,
      hallmarkingPaise: 4500, // plain gold: NOT exempt
    }),
    variantId: "var_slim-kada",
    sku: "AJ-KADA-01",
    status: "active",
    position: 90,
  },

  /* =======================================================================
   * BRIDAL DEMONSTRATION STOCK.
   *
   * The four pieces above are everyday work and belong to no occasion, which
   * left two entries in the collection control -- Headpieces and Bridal --
   * with nothing behind them once a shopper also chose a purity. Since only
   * priced pieces carry a fineness, and every priced piece was everyday, those
   * two filters returned "0 of 9" against a wall that visibly had pieces on it.
   *
   * These three are bridal by construction rather than by filing: a tikka IS a
   * headpiece and a rani haar IS bridal, so the collections below describe them
   * instead of being assigned to fill a gap. All three are stone-set, so QCO
   * cl. 2(3) exempts them and `hallmarkingPaise` is 0 -- unlike the plain gold
   * pieces above, which pay the fee.
   * ==================================================================== */

  {
    piece: demoPiece({
      slug: "rani-haar",
      saleMode: "buy_online",
      title: "Rani haar",
      subtitle: "Necklace",
      craft: "polki",
      description:
        "Three strands, seven medallions, and a lotus fired onto the back of every one of them. Long enough to sit below a choker.",
      collections: ["necklaces", "jadau-polki", "meenakari", "bridal"],
      fineness: 916,
      netMetalWeightMg: 42_000,
      grossWeightMg: 58_400, // carved beads and pearls carry the difference
      makingChargeType: "percent",
      makingChargeValue: 1500,
      stoneValuePaise: 8_500_000, // carved ruby and emerald, polki, pearls
      hallmarkingPaise: 0, // QCO cl. 2(3): polki, exempt
    }),
    variantId: "var_rani-haar",
    sku: "AJ-RANI-HAAR-01",
    status: "active",
    position: 100,
  },
  {
    piece: demoPiece({
      slug: "bridal-tikka",
      saleMode: "buy_online",
      title: "Bridal tikka",
      subtitle: "Headpiece",
      craft: "kundan",
      description:
        "It sits where the parting starts. The side nobody sees faces the hair, and it is enamelled anyway.",
      collections: ["headpieces", "kundan", "meenakari", "bridal"],
      fineness: 916,
      netMetalWeightMg: 9_600,
      grossWeightMg: 11_200,
      makingChargeType: "percent",
      makingChargeValue: 1700,
      stoneValuePaise: 1_450_000,
      hallmarkingPaise: 0, // QCO cl. 2(3): kundan-set, exempt
    }),
    variantId: "var_bridal-tikka",
    sku: "AJ-TIKKA-01",
    status: "active",
    position: 110,
  },
  {
    piece: demoPiece({
      slug: "jadau-kangan",
      saleMode: "buy_online",
      title: "Jadau kangan",
      subtitle: "Bangle",
      craft: "jadau",
      description:
        "Stones pressed into gold rather than gripped by it. Wide enough that the vine on the inside takes a week.",
      collections: ["bangles", "jadau-polki", "meenakari", "bridal"],
      fineness: 916,
      netMetalWeightMg: 28_500,
      grossWeightMg: 33_100,
      makingChargeType: "percent",
      makingChargeValue: 1600,
      stoneValuePaise: 4_200_000,
      hallmarkingPaise: 0, // QCO cl. 2(3): jadau, exempt
    }),
    variantId: "var_jadau-kangan",
    sku: "AJ-KANGAN-01",
    status: "active",
    position: 120,
  },
];

/** The five pieces as the storefront sees them. */
export const CATALOGUE_SEED: readonly CataloguePiece[] = CATALOGUE_SEED_ROWS.map(
  (row) => row.piece
);

/**
 * Re-exported from `./types` so this module stays the one place the storefront
 * imports catalogue facts from. The declaration moved to the leaf module so the
 * SEO layer can read it without importing the database. See ./types.
 */
export { DEMONSTRATION_SLUGS, isDemonstrationPiece } from "./types";

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

/**
 * `products.craft` is constrained by the schema, but this module treats the
 * database as untrusted input everywhere else and there is no reason to make an
 * exception for the one field that decides whether the page claims a legal
 * exemption. An unrecognised craft is not silently coerced to something
 * convenient — the piece is skipped, exactly as an unknown pricing mode is.
 */
function isSaleMode(value: string): value is SaleMode {
  return value === "buy_online" || value === "enquire_only" || value === "appointment_only";
}

function isCraft(value: string): value is Craft {
  return (
    value === "jadau" ||
    value === "polki" ||
    value === "diamond" ||
    value === "gold" ||
    value === "kundan" ||
    value === "other"
  );
}

/** One row of the products x variants join, before presentation is attached. */
type CommerceRow = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;
  /** Widened to `string` on purpose — validated by `isCraft` before use. */
  craft: string;
  /** Same treatment: validated by `isSaleMode` before it reaches a piece. */
  saleMode: string;
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
        craft: products.craft,
        saleMode: products.saleMode,
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
    if (!isCraft(row.craft)) {
      console.warn(`[catalogue] product "${row.slug}" has an unknown craft; not listed.`);
      continue;
    }
    if (!isSaleMode(row.saleMode)) {
      // Fail closed. An unreadable sale mode must not default to buyable.
      console.warn(`[catalogue] product "${row.slug}" has an unknown sale mode; not listed.`);
      continue;
    }

    pieces.push({
      id: row.id,
      slug: row.slug,
      title: row.title,
      subtitle: row.subtitle,
      description: row.description,
      spec: presentation.spec,
      craft: row.craft,
      saleMode: row.saleMode,
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
      altWorn: presentation.altWorn,
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
