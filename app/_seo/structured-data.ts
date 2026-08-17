/**
 * schema.org structured data for the site.
 *
 * ⚠️  Honesty rule, now applied PER FACT.
 *
 * Publishing a placeholder telephone/address/openingHours inside LocalBusiness
 * markup is worse than publishing none — it poisons Google Business Profile
 * matching and can get the entity flagged. That is why every contact field is
 * gated. What changed is the granularity: the gate used to be the single
 * `SITE_DETAILS_PENDING` flag, so one unknown fact suppressed all of them, and
 * a real telephone sat unpublished because the address had not arrived.
 *
 * Each field below is now gated on its own `known.*` flag. A real telephone is
 * a genuine ranking and call-through signal, so it goes out the moment it is
 * verified; the address stays out until it is. `site.address`, `site.email`,
 * `site.hours` and `site.mapsUrl` still hold placeholders/assumptions, and this
 * file must never emit any of them while their flag is false.
 *
 * To publish a further fact: fill in its TODO in `site-config.ts` and flip its
 * entry in `known`. Nothing here needs to change.
 */

import { known, site } from "../site-config";

/** Stable node identity so other schema nodes can reference the business. */
const businessId = `${site.url}/#jewellery-store`;

const description =
  "Alankar Jewellers has crafted antique Jadau, diamond and Polki jewellery since 1980. Designer pieces made with trust and artistry across generations.";

/**
 * The business as a `JewelryStore` (a subtype of `LocalBusiness`).
 * Returns a plain object so it can be serialised into a JSON-LD script tag.
 */
export function jewelryStoreJsonLd(): Record<string, unknown> {
  // Widened so each conditional below is not a compile-time constant, which
  // keeps both branches of every gate type-checked while the flags are literals.
  const has: Record<keyof typeof known, boolean> = { ...known };

  const sameAs = has.social
    ? Object.values(site.social).filter((url) => url.length > 0)
    : [];

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

  // Verified real-world contact facts only, one gate each. See the rule above.

  if (has.phone) {
    data.telephone = site.phone;
  }

  if (has.email) {
    data.email = site.email;
  }

  if (has.address) {
    data.address = {
      "@type": "PostalAddress",
      streetAddress: site.address.street,
      addressLocality: site.address.locality,
      addressRegion: site.address.region,
      postalCode: site.address.postalCode,
      addressCountry: site.address.country,
    };
    // Narrowing areaServed to a city is only meaningful once the city is real.
    data.areaServed = [
      { "@type": "Country", name: "India" },
      { "@type": "City", name: site.address.city },
    ];
  }

  // `site.hours` is the shop's assumed schedule, not a statement it has made.
  // An assumed openingHours is the field most likely to send someone to a
  // closed shutter, so it waits for confirmation like everything else.
  if (has.hours) {
    data.openingHoursSpecification = site.openingHoursSpec.map((spec) => ({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: [...spec.days],
      opens: spec.opens,
      closes: spec.closes,
    }));
  }

  if (has.maps && site.mapsUrl) {
    data.hasMap = site.mapsUrl;
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
