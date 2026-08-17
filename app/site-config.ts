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

/**
 * THE ONE PERSON AT ALANKAR JEWELLERS.
 *
 * Gated the same way as `known` above, but deliberately kept OUT of it:
 * `known` is enumerated wholesale by `_seo/structured-data.ts` and
 * `_components/appointment.tsx` (`Record<keyof typeof known, boolean>`), and
 * those are about the shop's contactability, not about a person.
 *
 * Supplied by the shop on 2026-08-12, and recorded here at exactly the width it
 * was given. Three facts arrived, and this is all three of them:
 *
 *   1. he is the third generation OF THE FAMILY BUSINESS
 *   2. he oversees everything — all of the operations
 *   3. there is no second person
 *
 * ⚠️  WHAT IS DELIBERATELY ABSENT, AND MUST STAY ABSENT.
 *
 * The house dates to 1980 and he is the third generation. Those are two facts,
 * not one: "third generation of the family business" is an ordinal within a
 * family, and a family can trade before it opens a shop. Multiplying the two
 * together to get a grandfather who founded Alankar in 1980 is arithmetic, not
 * evidence, and it is the single most tempting sentence on this page. So there
 * is no grandfather here, no father, no year he took over, and no stated
 * relationship between him and the 1980 opening. Nobody supplied any of it.
 *
 * Still pending below, and rendered as visibly unanswered rather than guessed:
 * his own words, where in the shop to find him, and his email.
 */
export const founder = {
  /** Which facts about him the shop has actually supplied. */
  known: {
    name: true, // supplied 2026-08-11
    generation: true, // supplied 2026-08-12
    oversees: true, // supplied 2026-08-12
    soleOperator: true, // supplied 2026-08-12
    whereabouts: false,
    words: false,
    quote: false,
    email: false,
    joined: false, // no date of joining, and none may be inferred from 1980
  },

  /** As he wants it written. */
  name: "Saksham Goel" as string | null,

  /**
   * The ordinal on its own, because it is only ever printed beside the scope it
   * belongs to — the record card's own label, "In the family business". Kept
   * apart so that the ordinal can never be set loose next to the shop's 1980
   * opening and quietly become "the third generation since 1980", which is a
   * different and unevidenced claim. See the warning above.
   */
  generation: "The third generation." as string | null,

  /**
   * The role as a verb rather than a job title, which is Part E's grammar and
   * also, here, the client's own phrasing: he oversees everything.
   */
  oversees: "Oversees everything, all of the operations." as string | null,

  /**
   * The same fact cut to caption length, for Part E's "Name, verb." grammar
   * under a portrait. Kept here rather than sliced out of the sentence above,
   * so that both phrasings are things the shop said rather than things a
   * component derived.
   */
  overseesShort: "oversees everything" as string | null,

  /** "there is no second person." The reason this page carries one portrait. */
  soleOperator: true,

  /** TODO: where in the shop a customer actually finds him. */
  whereabouts: null as string | null,
  /** TODO: two or three short paragraphs, recorded in the first person. */
  words: [] as string[],
  /** TODO: one line, in his own words. Set without quotation marks. */
  quote: null as string | null,
  /** TODO: his own address, if he wants one published. */
  email: null as string | null,
};

/** Formatted one-line address for display. */
export function formattedAddress() {
  const { street, locality, city, region, postalCode } = site.address;
  return [street, locality, `${city}, ${region} ${postalCode}`].filter(Boolean).join(", ");
}

/** wa.me deep link with a prefilled opening message. */
export function whatsappUrl(message = "Hello Alankar Jewellers, I'd like to book an appointment.") {
  return `https://wa.me/${site.whatsapp}?text=${encodeURIComponent(message)}`;
}
