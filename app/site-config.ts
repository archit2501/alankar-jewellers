/**
 * Single source of truth for every real-world fact about the business.
 *
 * ⚠️  GATING IS PER FACT, NOT GLOBAL.
 *
 * This started as one boolean, and one boolean could not survive contact with
 * reality: the shop supplied a real phone number long before it supplied an
 * address. An all-or-nothing flag forces a choice between hiding a fact that IS
 * known and publishing placeholders that are NOT — and publishing fabricated
 * LocalBusiness data is worse for search than publishing none.
 *
 * So each fact declares whether it is known. `SITE_DETAILS_PENDING` survives as
 * a DERIVED value — true while anything is still outstanding — because callers
 * that only want "is the shop fully set up?" should not have to enumerate.
 *
 * The rule that has not changed: a fact that is not known is never invented,
 * never rendered as a live link, and never enters structured data.
 */

/** Which real-world facts the shop has actually supplied. */
export const known = {
  phone: true, // supplied 2026-08-11
  whatsapp: true, // same number
  email: false,
  address: false,
  hours: false, // the defaults below are an assumption, not a statement
  maps: false,
  social: false,
} as const;

/**
 * True while ANY fact is still outstanding. Derived, so it cannot drift out of
 * step with the individual flags above.
 */
export const SITE_DETAILS_PENDING = Object.values(known).some((v) => !v);

export const site = {
  name: "Alankar Jewellers",
  legalName: "Alankar Jewellers",
  tagline: "Jewels that become heirlooms.",
  foundedYear: 1980,

  /** TODO: the production origin, no trailing slash. Used for metadataBase,
   *  canonical URLs and absolute Open Graph image URLs. */
  url: "https://www.alankarjewellers.com",

  /** E.164, digits only after the +. Used for tel: links and JSON-LD. */
  phone: "+918130386551",
  /** How the number reads on screen. */
  phoneDisplay: "+91 81303 86551",

  /** wa.me target — country code + number, no + or spaces. */
  whatsapp: "918130386551",

  /** TODO */
  email: "contact@alankarjewellers.com",

  address: {
    /** TODO */
    street: "Shop address line 1",
    /** TODO */
    locality: "Locality",
    /** TODO */
    city: "City",
    /** TODO */
    region: "State",
    /** TODO */
    postalCode: "000000",
    country: "IN",
  },

  /** TODO: Google Maps share link for the storefront. */
  mapsUrl: "",

  hours: [
    { days: "Monday – Saturday", time: "11:00 AM – 8:00 PM" },
    { days: "Sunday", time: "By appointment only" },
  ],

  /** Machine-readable opening hours for JSON-LD. Keep in sync with `hours`. */
  openingHoursSpec: [
    { days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"], opens: "11:00", closes: "20:00" },
  ],

  social: {
    /** TODO: full profile URLs, or leave empty to omit. */
    instagram: "",
    facebook: "",
  },
} as const;

/** Formatted one-line address for display. */
export function formattedAddress() {
  const { street, locality, city, region, postalCode } = site.address;
  return [street, locality, `${city}, ${region} ${postalCode}`].filter(Boolean).join(", ");
}

/** wa.me deep link with a prefilled opening message. */
export function whatsappUrl(message = "Hello Alankar Jewellers, I'd like to book an appointment.") {
  return `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(message)}`;
}
