/**
 * Single source of truth for every real-world fact about the business.
 *
 * ⚠️  The values marked TODO are placeholders. Nothing on the site invents a
 * phone number, address or credential: while `SITE_DETAILS_PENDING` is true the
 * UI renders these as visibly unfinished and the structured data omits them
 * entirely, because publishing fabricated LocalBusiness data is worse for
 * search ranking than publishing none.
 *
 * To launch: fill in the TODOs below and set SITE_DETAILS_PENDING to false.
 */

export const SITE_DETAILS_PENDING = true;

export const site = {
  name: "Alankar Jewellers",
  legalName: "Alankar Jewellers",
  tagline: "Jewels that become heirlooms.",
  foundedYear: 1980,

  /** TODO: the production origin, no trailing slash. Used for metadataBase,
   *  canonical URLs and absolute Open Graph image URLs. */
  url: "https://www.alankarjewellers.com",

  /** TODO: E.164, digits only after the +. Used for tel: links and JSON-LD. */
  phone: "+910000000000",
  /** TODO: how the number should read on screen. */
  phoneDisplay: "+91 00000 00000",

  /** TODO: wa.me target — country code + number, no + or spaces. */
  whatsapp: "910000000000",

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
