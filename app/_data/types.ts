/**
 * The shape the storefront reads. Shared contract between the catalogue
 * listing, the product page, and the data layer that serves both.
 *
 * WHY IMAGERY IS NOT IN THE DATABASE YET
 * `product_media.r2Key` is `notNull`, because the schema was designed for the
 * real thing: an admin uploads a photograph, R2 holds it, the row points at the
 * object key. R2 is not enabled on the account yet (a one-time dashboard
 * opt-in), and every photograph currently on this site is a generated
 * placeholder living in `public/images/catalogue/` as a static asset.
 *
 * So imagery resolves through `app/_media/images.ts` by key, and
 * `product_media` stays EMPTY rather than being filled with static paths
 * stuffed into a column named `r2Key`. That would be a lie the next developer
 * has to unpick, and it would silently survive the switch to real uploads.
 * When R2 comes online, `mediaKey` below is the single seam to change.
 */

import type { ImageKey } from "../_media/images";

/**
 * The demonstration pieces, named rather than detected.
 *
 * DECLARED HERE, in the leaf module, rather than in `catalogue.ts` where it
 * began. `app/_seo/product-schema.ts` has to know which pieces are invented in
 * order to keep their figures out of the structured data, and importing the
 * catalogue would drag the D1 layer into a module that only formats markup.
 * `catalogue.ts` re-exports both so every existing import still resolves.
 */
export const DEMONSTRATION_SLUGS: readonly string[] = [
  "gold-jhumka",
  "polki-ring",
  "lotus-pendant",
  "slim-kada",
  "rani-haar",
  "bridal-tikka",
  "jadau-kangan",
];

/** True for a piece whose figures are invented for demonstration. */
export function isDemonstrationPiece(slug: string): boolean {
  return DEMONSTRATION_SLUGS.includes(slug);
}

/** Millesimal fineness, never karat. 995 has no karat equivalent. */
export type Fineness = 999 | 995 | 916 | 750 | 585;

export type Craft = "jadau" | "polki" | "diamond" | "gold" | "kundan" | "other";

/** The crafts BIS QCO cl. 2(3) exempts from mandatory hallmarking. */
export const HALLMARK_EXEMPT_CRAFTS: readonly Craft[] = ["jadau", "polki", "kundan"];

export function isHallmarkExempt(craft: string): boolean {
  return (HALLMARK_EXEMPT_CRAFTS as readonly string[]).includes(craft);
}

export type SaleMode = "buy_online" | "enquire_only" | "appointment_only";

/** True only for a piece the shop has decided may be bought online. */
export function isBuyable(piece: { saleMode: SaleMode; stockQuantity: number }): boolean {
  return piece.saleMode === "buy_online" && piece.stockQuantity > 0;
}

export type PricingMode = "dynamic_metal" | "fixed" | "on_request";

/**
 * One physical piece. Jewellery here is one-of-a-kind, so a product almost
 * always has exactly one variant and `stockQuantity` is 1.
 */
export type CataloguePiece = {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  description: string | null;

  /** The line the shop would say out loud. Metal, stones, cord. */
  spec: string;

  /**
   * What the piece IS, which decides whether BIS QCO cl. 2(3) exempts it from
   * mandatory hallmarking. The product page needs this to avoid claiming an
   * exemption a plain gold article does not have — a claim that used to be safe
   * only because every piece in the catalogue happened to be stone-set.
   */
  craft: Craft;

  /**
   * Whether this piece may be bought on the website at all.
   *
   * This lived only on the seed row and in the database for weeks, which meant
   * the admin wrote it, the audit log tracked it, and the storefront never read
   * it -- so every piece rendered an Add to cart button and the API accepted
   * every one of them. A four lakh bridal set was one click from a cart.
   */
  saleMode: SaleMode;

  pricingMode: PricingMode;
  fineness: Fineness | null;
  metal: string;
  netMetalWeightMg: number | null;
  grossWeightMg: number | null;
  makingChargeType: string | null;
  makingChargeValue: number | null;
  stoneValuePaise: number;
  hallmarkingPaise: number;
  otherChargesPaise: number;
  fixedPricePaise: number | null;

  /** Compliance fields. Null until a real piece is hallmarked and certified. */
  huid: string | null;
  hallmarkPurityMark: string | null;
  certificateNumber: string | null;
  certificateLab: string | null;

  stockQuantity: number;
  isUniquePiece: boolean;

  /**
   * Imagery, resolved from the generated manifest rather than the database.
   * `back` is the enamelled meenakari reverse — the site's whole idea — and is
   * absent when a piece has not been photographed from behind.
   */
  mediaKey: { front: ImageKey; back: ImageKey | null; worn: ImageKey | null };
  alt: string;
  altBack: string | null;
  /**
   * The piece on a body. Null where none exists — the five heirloom pieces have
   * never been worn for a camera, and a missing worn shot is a fact about the
   * photography rather than a hole to fill with something approximate.
   */
  altWorn: string | null;

  collections: readonly string[];
};

/** Filters the listing supports. Every one maps to a column or a join. */
export type CatalogueFilter = {
  metal?: string;
  fineness?: Fineness;
  collection?: string;
  /** Inclusive bounds in paise, applied to the resolved price. */
  minPaise?: number;
  maxPaise?: number;
};

/**
 * A piece with its price resolved against a live rate.
 *
 * `price` is null when the piece is `on_request`, or when the gold rate is
 * stale — the rate layer fails closed by design, and the storefront must show
 * "price on request" rather than a wrong number or a zero. The listing and the
 * product page must both handle null without falling back to 0.
 */
export type PricedPiece = CataloguePiece & {
  price: {
    totalPaise: number;
    breakup: readonly { label: string; amountPaise: number }[];
    rateAsOf: string;
  } | null;
  /** Set when price is null, so the UI can say WHY rather than going silent. */
  priceUnavailableReason: "on_request" | "rate_stale" | "rate_missing" | null;
};
