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

/** Millesimal fineness, never karat. 995 has no karat equivalent. */
export type Fineness = 999 | 995 | 916 | 750 | 585;

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
  mediaKey: { front: ImageKey; back: ImageKey | null };
  alt: string;
  altBack: string | null;

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
