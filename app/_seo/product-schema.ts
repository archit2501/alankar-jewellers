/**
 * ONE PIECE, AS A `Product` — and the gate that decides what may be said about
 * it at all.
 *
 * ---------------------------------------------------------------------------
 * WHY THE VISIBLE PAGE AND THE MARKUP ARE BUILT FROM THE SAME FUNCTION
 * ---------------------------------------------------------------------------
 *
 * `./structured-data.ts` carries this site's honesty rule: a field that cannot
 * be verified is OMITTED rather than filled with a placeholder, because
 * fabricated structured data poisons search matching and can get the entity
 * flagged. That rule is only worth anything if the page and the crawler are
 * told the same story, and the way two stories drift apart is by being written
 * twice.
 *
 * So `disclosures()` below is the single gate. The specification block on the
 * product page renders exactly these rows; `productJsonLd()` emits exactly the
 * rows that came back with a value and silently drops the rest. A piece whose
 * HUID is unknown therefore reads "Not yet hallmarked" on the page and carries
 * no HUID property in the markup, and neither can change without the other.
 *
 * ---------------------------------------------------------------------------
 * THE PRICE IS GATED THE WAY THE CONTACT FACTS ALREADY ARE
 * ---------------------------------------------------------------------------
 *
 * `PricedPiece.price` is null whenever the piece is quoted by hand or the gold
 * rate is stale — the rate layer fails closed by design (see
 * `app/_data/types.ts` and `app/_pricing/rates.ts`). When it is null the Offer
 * below carries NO `price` and NO `priceCurrency`. It is not set to 0, and it
 * is not carried over from an earlier rate.
 *
 * The Offer node itself survives, because everything left in it is still true:
 * who sells the piece, where it can be seen, and whether it is still available.
 * Google will not award a price rich result to an offer with no price, and that
 * is the intended outcome — no figure in the search result is exactly right
 * when there is no figure we can stand behind.
 *
 * ---------------------------------------------------------------------------
 * NO FLOATS IN THE MONEY PATH, HERE EITHER
 * ---------------------------------------------------------------------------
 *
 * `app/_pricing/price.ts` computes every figure in bigint so an invoice foots.
 * Formatting is where that discipline is usually thrown away — `paise / 100`
 * is a floating-point division, and `(1234567 / 100).toFixed(2)` is a rounding
 * decision made by IEEE-754 rather than by us. Every conversion below is
 * integer division in bigint and string assembly, so the rupee figure printed
 * on the page is the paise figure the engine produced, exactly.
 *
 * `formatRupees` here is NOT a duplicate of `formatPaiseAsRupees` in
 * `app/_pricing/rates.ts`, which the catalogue listing renders price tags with.
 * Two differences, both deliberate. It always prints the paise, because the
 * total on a product page sits directly under the lines it is the sum of and
 * has to be seen to foot — a price TAG may drop them, an itemised document may
 * not. And it groups the digits itself instead of via
 * `toLocaleString("en-IN")`, because this renders inside a Cloudflare Worker
 * whose available ICU locale data is not something this repo pins: a silent
 * fallback to western grouping would put the wrong number of digits in front of
 * a customer without failing anything.
 */

import { images } from "../_media/images";
import { isDemonstrationPiece, type CataloguePiece, type PricedPiece } from "../_data/types";
import { isPriceableMetal, purityLabel } from "../_pricing/price";
import { site } from "../site-config";

/**
 * The business node published on every page by `app/layout.tsx`.
 *
 * This string MUST match `businessId` in `./structured-data.ts`. It is repeated
 * rather than imported because that module does not export it and is not ours
 * to edit; `tests/product-page.test.mjs` asserts the two agree, so a rename
 * there fails the build here rather than silently orphaning every product from
 * its seller.
 */
const BUSINESS_ID = `${site.url}/#jewellery-store`;

const HUNDRED = BigInt(100);
const THOUSAND = BigInt(1000);

/* -------------------------------------------------------------------------
 * Money and weight, formatted without ever leaving integer arithmetic
 * ---------------------------------------------------------------------- */

function requireSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be a safe integer, received ${String(value)}`);
  }
  return value;
}

/**
 * Indian digit grouping: the last three digits, then twos. 1234567 rupees is
 * "12,34,567" and not "1,234,567".
 *
 * Written out rather than delegated to `Intl.NumberFormat("en-IN")` because
 * this renders inside a Cloudflare Worker, where the ICU locale data available
 * to the runtime is not something this repo controls — a silent fallback to
 * western grouping would put the wrong number of digits in front of a customer
 * without failing anything.
 */
function groupIndian(digits: string): string {
  if (digits.length <= 3) {
    return digits;
  }
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  const groups: string[] = [];
  let index = rest.length;
  while (index > 2) {
    groups.unshift(rest.slice(index - 2, index));
    index -= 2;
  }
  if (index > 0) {
    groups.unshift(rest.slice(0, index));
  }
  return `${groups.join(",")},${last3}`;
}

/** `12345678` -> `"₹1,23,456.78"`. A negative amount (a discount) keeps its sign. */
export function formatRupees(paise: number): string {
  requireSafeInteger(paise, "paise");
  const negative = paise < 0;
  const absolute = BigInt(negative ? -paise : paise);
  const rupees = groupIndian((absolute / HUNDRED).toString());
  const remainder = (absolute % HUNDRED).toString().padStart(2, "0");
  return `${negative ? "−" : ""}₹${rupees}.${remainder}`;
}

/**
 * `12345678` -> `"123456.78"`. The form schema.org wants: a bare decimal, no
 * separators, no currency symbol, always two places.
 */
export function rupeesDecimal(paise: number): string {
  requireSafeInteger(paise, "paise");
  const negative = paise < 0;
  const absolute = BigInt(negative ? -paise : paise);
  const remainder = (absolute % HUNDRED).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${(absolute / HUNDRED).toString()}.${remainder}`;
}

/** `18500` -> `"18.500"`. Milligrams are the stored unit; grams are the spoken one. */
export function gramsDecimal(milligrams: number): string {
  requireSafeInteger(milligrams, "milligrams");
  if (milligrams < 0) {
    throw new Error(`milligrams must not be negative, received ${String(milligrams)}`);
  }
  const absolute = BigInt(milligrams);
  const remainder = (absolute % THOUSAND).toString().padStart(3, "0");
  return `${(absolute / THOUSAND).toString()}.${remainder}`;
}

/** `18500` -> `"18.500 g"`. Three places always, because that is the stored precision. */
export function formatGrams(milligrams: number): string {
  return `${gramsDecimal(milligrams)} g`;
}

/* -------------------------------------------------------------------------
 * The gate
 * ---------------------------------------------------------------------- */

export type DisclosureKey =
  | "metal"
  | "purity"
  | "grossWeight"
  | "netWeight"
  | "huid"
  | "hallmarkMark"
  | "certificate"
  | "certificateLab";

/**
 * One row of the specification block.
 *
 * `value` is what the shop has actually supplied. When it is null the page
 * prints `pending` instead — a sentence that names what is missing — and the
 * structured data omits the corresponding property entirely. There is no third
 * state: a row is never blank, and it never carries a plausible-looking
 * stand-in.
 */
export type Disclosure = {
  readonly key: DisclosureKey;
  readonly label: string;
  readonly value: string | null;
  /** Printed in place of a missing value. Never empty. */
  readonly pending: string;
  /** True for the rows a buyer is legally entitled to check. */
  readonly compliance: boolean;
};

/** "gold" -> "Gold". Metals are stored lower case; nothing else is touched. */
function metalNoun(metal: string): string | null {
  const trimmed = metal.trim();
  if (trimmed === "" || trimmed === "none") {
    return null;
  }
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Purity as BIS (Hallmarking) Regulations 2018 Reg. 5(11) wants it stated — "in
 * carat and fineness" — via the price engine's own lookup, so 995 is never
 * rounded up into "24K" here after being kept honest there.
 */
function purityDisplay(piece: CataloguePiece): string | null {
  if (piece.fineness === null) {
    return null;
  }
  return isPriceableMetal(piece.metal)
    ? purityLabel(piece.fineness, piece.metal).display
    : `${String(piece.fineness)} fineness`;
}

/**
 * Every fact a buyer of Indian gold jewellery is entitled to ask for, in one
 * list, with the honest answer where there is no answer yet.
 *
 * This is placeholder inventory: most of these are null today. That is the
 * case this function exists for.
 */
export function disclosures(piece: CataloguePiece): readonly Disclosure[] {
  return [
    {
      key: "metal",
      label: "Metal",
      value: metalNoun(piece.metal),
      pending: "Not stated for this piece.",
      compliance: false,
    },
    {
      key: "purity",
      label: "Purity",
      value: purityDisplay(piece),
      pending: "Not assayed yet. No fineness has been recorded.",
      compliance: true,
    },
    {
      key: "grossWeight",
      label: "Gross weight",
      value: piece.grossWeightMg === null ? null : formatGrams(piece.grossWeightMg),
      pending: "Not yet weighed. It will be weighed in front of you.",
      compliance: true,
    },
    {
      key: "netWeight",
      label: "Net metal weight",
      value: piece.netMetalWeightMg === null ? null : formatGrams(piece.netMetalWeightMg),
      pending: "Not yet weighed. Stones and cord are excluded from this figure.",
      compliance: true,
    },
    {
      key: "huid",
      label: "HUID",
      value: piece.huid,
      // The wording a buyer needs: the absence of a HUID is a fact about the
      // piece, not a gap in the page. Never blank, never invented.
      pending: "Not yet hallmarked. No HUID has been issued for this piece.",
      compliance: true,
    },
    {
      key: "hallmarkMark",
      label: "Hallmark purity mark",
      value: piece.hallmarkPurityMark,
      pending: "No BIS purity mark has been struck on this piece.",
      compliance: true,
    },
    {
      key: "certificate",
      label: "Certificate",
      value: piece.certificateNumber,
      pending: "Not yet certified. No certificate number exists for this piece.",
      compliance: true,
    },
    {
      key: "certificateLab",
      label: "Certifying laboratory",
      value: piece.certificateLab,
      pending: "No laboratory has assessed this piece.",
      compliance: true,
    },
  ];
}

/** Look one row up by key. */
function disclosed(rows: readonly Disclosure[], key: DisclosureKey): string | null {
  return rows.find((row) => row.key === key)?.value ?? null;
}

/* -------------------------------------------------------------------------
 * URLs
 * ---------------------------------------------------------------------- */

/** The canonical path for a piece. One definition, used by page and markup. */
export function productPath(slug: string): string {
  return `/shop/${slug}`;
}

/** Absolute, because a relative URL in JSON-LD resolves against nothing. */
export function productUrl(slug: string): string {
  return `${site.url}${productPath(slug)}`;
}

function absoluteImage(key: keyof typeof images): string {
  return `${site.url}${images[key].src}`;
}

/* -------------------------------------------------------------------------
 * The node
 * ---------------------------------------------------------------------- */

/**
 * `Product` + `Offer` for one piece, referencing — never duplicating — the
 * `JewelryStore` node that `app/layout.tsx` already publishes on every page.
 *
 * Both `brand` and `seller` are bare `@id` references, so a crawler resolves
 * one business entity with products attached to it rather than a second,
 * competing copy of the shop per product page.
 *
 * Everything emitted here is read from the database or derived from it. Nothing
 * is defaulted: no `itemCondition` (nobody has stated it), no `priceValidUntil`
 * (a gold-rate-derived price has no stated validity window), no `gtin` and no
 * `mpn` (this house does not issue them), no `aggregateRating` and no `review`
 * — the two fields most often fabricated on jewellery product pages, and the
 * two that carry the heaviest penalty for it.
 */
export function productJsonLd(piece: PricedPiece): Record<string, unknown> {
  const rows = disclosures(piece);
  const url = productUrl(piece.slug);

  const image = [
    absoluteImage(piece.mediaKey.front),
    ...(piece.mediaKey.back === null ? [] : [absoluteImage(piece.mediaKey.back)]),
  ];

  // Verified physical facts only, and the array is dropped entirely rather than
  // published empty — an empty additionalProperty is a broken signal, exactly
  // as an empty sameAs is in structured-data.ts.
  //
  // "Verified" is doing the work in that sentence. A demonstration piece has a
  // fineness and a net weight in the database, and both are invented, so both
  // are withheld here for the reason set out at THE SECOND GATE below. HUID,
  // hallmark mark and certificate need no gate: they are null for every piece
  // in the catalogue and always have been, because a fabricated credential was
  // never on the table.
  const invented = isDemonstrationPiece(piece.slug);
  const additionalProperty: Record<string, unknown>[] = [];

  if (piece.fineness !== null && !invented) {
    additionalProperty.push({
      "@type": "PropertyValue",
      propertyID: "fineness",
      name: "Millesimal fineness",
      value: String(piece.fineness),
    });
  }
  if (piece.netMetalWeightMg !== null && !invented) {
    additionalProperty.push({
      "@type": "PropertyValue",
      propertyID: "netMetalWeight",
      name: "Net metal weight",
      value: gramsDecimal(piece.netMetalWeightMg),
      unitCode: "GRM",
    });
  }
  const huid = disclosed(rows, "huid");
  if (huid !== null) {
    additionalProperty.push({
      "@type": "PropertyValue",
      propertyID: "HUID",
      name: "Hallmark Unique Identification",
      value: huid,
    });
  }
  const hallmarkMark = disclosed(rows, "hallmarkMark");
  if (hallmarkMark !== null) {
    additionalProperty.push({
      "@type": "PropertyValue",
      propertyID: "BISHallmark",
      name: "Hallmark purity mark",
      value: hallmarkMark,
    });
  }
  const certificate = disclosed(rows, "certificate");
  if (certificate !== null) {
    additionalProperty.push({
      "@type": "PropertyValue",
      propertyID: "certificateNumber",
      name: "Certificate number",
      value: certificate,
    });
  }
  const certificateLab = disclosed(rows, "certificateLab");
  if (certificateLab !== null) {
    additionalProperty.push({
      "@type": "PropertyValue",
      propertyID: "certifyingLaboratory",
      name: "Certifying laboratory",
      value: certificateLab,
    });
  }

  /**
   * THE SECOND GATE: A DEMONSTRATION PIECE MAKES NO COMMERCIAL CLAIM.
   *
   * The gate below this one asks "is there a fresh rate", which is a question
   * about the PRICE. This one asks whether the OBJECT exists, and it did not
   * exist as a question until demonstration stock was added to the catalogue.
   *
   * Everything these pieces published was true of the arithmetic and false of
   * the world: an `Offer` at ₹5,19,876, `InStock`, and a gross weight of 33.100
   * grams for a kangan nobody has ever made, machine-readable and indexed. A
   * human reading the page sees the disclosure printed above the diptych; a
   * crawler reads this object and sees a shop asserting it has the thing and
   * will sell it at that figure.
   *
   * So for these pieces the entire `offers` node and `weight` are withheld —
   * not zeroed, not marked OutOfStock, which would be a different false claim
   * about a real object. What remains is true: it has that name, that
   * description, those photographs, and it belongs to this shop.
   *
   * This is the same rule `site-config.ts` applies to the shop's address and
   * `disclosures()` applies to a HUID, arriving late at the one surface where
   * nobody was reading.
   */
  const offer: Record<string, unknown> = {
    "@type": "Offer",
    "@id": `${url}#offer`,
    url,
    availability:
      piece.stockQuantity > 0
        ? "https://schema.org/InStock"
        : "https://schema.org/OutOfStock",
    seller: { "@id": BUSINESS_ID },
  };

  // THE GATE. A price appears here only when a real one was computed against a
  // fresh rate. Otherwise the keys are absent — not zero, not stale, not "0.00".
  if (piece.price !== null) {
    offer.price = rupeesDecimal(piece.price.totalPaise);
    offer.priceCurrency = "INR";
    // True by construction: `priceLine()` adds GST to every line total.
    offer.valueAddedTaxIncluded = true;
  }

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Product",
    "@id": `${url}#product`,
    name: piece.title,
    description: piece.description ?? piece.spec,
    url,
    image,
    productID: piece.id,
    brand: { "@id": BUSINESS_ID },
  };

  if (!invented) {
    data.offers = offer;
  }

  const metal = disclosed(rows, "metal");
  if (metal !== null) {
    data.material = metal;
  }
  if (piece.grossWeightMg !== null && !invented) {
    data.weight = {
      "@type": "QuantitativeValue",
      value: gramsDecimal(piece.grossWeightMg),
      unitCode: "GRM",
    };
  }
  if (additionalProperty.length > 0) {
    data.additionalProperty = additionalProperty;
  }
  if (piece.collections.length > 0) {
    data.category = [...piece.collections];
  }

  return data;
}
