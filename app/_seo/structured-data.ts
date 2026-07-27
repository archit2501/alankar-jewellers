/**
 * schema.org structured data for the site.
 *
 * ⚠️  Honesty rule: while `SITE_DETAILS_PENDING` is true the contact block in
 * `site-config.ts` is a set of placeholders. Publishing a placeholder
 * telephone/address/openingHours inside LocalBusiness markup is worse than
 * publishing none — it poisons Google Business Profile matching and can get the
 * entity flagged — so those fields are omitted entirely until the flag flips.
 *
 * To publish the full entity: fill in the TODOs in `site-config.ts` and set
 * `SITE_DETAILS_PENDING = false`. Nothing else here needs to change.
 */

import { SITE_DETAILS_PENDING, site } from "../site-config";

/** Stable node identity so other schema nodes can reference the business. */
const businessId = `${site.url}/#jewellery-store`;

const description =
  "Alankar Jewellers has crafted antique Jadau, diamond and Polki jewellery since 1980 — designer pieces made with trust and artistry across generations.";

/**
 * The business as a `JewelryStore` (a subtype of `LocalBusiness`).
 * Returns a plain object so it can be serialised into a JSON-LD script tag.
 */
export function jewelryStoreJsonLd(): Record<string, unknown> {
  // Widened so the conditional below is not a compile-time constant.
  const detailsPending: boolean = SITE_DETAILS_PENDING;

  const sameAs = Object.values(site.social).filter((url) => url.length > 0);

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "JewelryStore",
    "@id": businessId,
    name: site.name,
    legalName: site.legalName,
    url: site.url,
    slogan: site.tagline,
    description,
    image: `${site.url}/og.png`,
    logo: `${site.url}/favicon.png`,
    foundingDate: String(site.foundedYear),
    priceRange: "$$$",
    currenciesAccepted: "INR",
    areaServed: { "@type": "Country", name: "India" },
    knowsAbout: [
      "Antique Jadau jewellery",
      "Polki jewellery",
      "Diamond jewellery",
      "Heirloom and bridal jewellery",
    ],
  };

  // Verified real-world contact facts only. See the honesty rule above.
  if (!detailsPending) {
    data.telephone = site.phone;
    data.email = site.email;
    data.address = {
      "@type": "PostalAddress",
      streetAddress: site.address.street,
      addressLocality: site.address.locality,
      addressRegion: site.address.region,
      postalCode: site.address.postalCode,
      addressCountry: site.address.country,
    };
    data.openingHoursSpecification = site.openingHoursSpec.map((spec) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: [...spec.days],
      opens: spec.opens,
      closes: spec.closes,
    }));
    if (site.mapsUrl) {
      data.hasMap = site.mapsUrl;
    }
    data.areaServed = [
      { "@type": "Country", name: "India" },
      { "@type": "City", name: site.address.city },
    ];
  }

  // Omitted rather than emitted empty: an empty sameAs is a broken signal.
  if (sameAs.length > 0) {
    data.sameAs = sameAs;
  }

  return data;
}

/**
 * JSON for embedding inside a `<script>` element. Escapes the characters that
 * could otherwise break out of the script context (`<`, `>`, `&`) plus the
 * line separators that are legal in JSON but not in JavaScript string literals.
 */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
