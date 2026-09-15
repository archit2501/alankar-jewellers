/**
 * THE POLICY PAGES: WHAT THEY MAY SAY, AND WHAT THE SHOP HAS STILL TO SUPPLY.
 *
 * Checkout collects a name, an address and a PAN, and until now the site had no
 * privacy notice, no terms, no returns or delivery policy and no named
 * grievance officer. The pages that fix that sit on top of this file.
 *
 * TWO KINDS OF STATEMENT, KEPT APART ON PURPOSE.
 *
 *  1. WHAT THE WEBSITE DEMONSTRABLY DOES. Which fields checkout submits, which
 *     cookies exist and for how long, that no payment is taken, that no
 *     analytics script runs. These are read off the code, and
 *     tests/policies.test.mjs parses that code so the notice cannot drift from
 *     it: a new checkout field the privacy notice does not mention fails CI.
 *
 *  2. WHAT ONLY THE SHOP CAN DECIDE. Returns, exchange, cancellation, delivery
 *     terms, how long records are kept, who the grievance officer is. None of
 *     that is written here, because a plausible invented returns policy is a
 *     promise the shop never made. Each has its own flag, gated exactly like
 *     `known` in site-config.ts, and a page is PUBLISHED only once every fact
 *     it depends on has arrived. Until then it is noindex, stays out of the
 *     sitemap, and says plainly what is still missing.
 */
import { known } from "../site-config";

/** Which shop-supplied facts have arrived. Widened to boolean so both branches type-check. */
export const policyKnown: Record<
  | "registeredAddress"
  | "gstin"
  | "grievanceOfficer"
  | "dataContact"
  | "retention"
  | "returns"
  | "exchange"
  | "cancellation"
  | "deliveryTerms"
  | "paymentMethods",
  boolean
> = {
  // Not a second copy of the address: the address has its own gate in
  // site-config.ts, and this flag simply follows it.
  registeredAddress: known.address,
  gstin: false,
  grievanceOfficer: false,
  dataContact: false,
  retention: false,
  returns: false,
  exchange: false,
  cancellation: false,
  deliveryTerms: false,
  paymentMethods: false,
};

export type PolicyFact = keyof typeof policyKnown;

/** The values, exactly as the shop supplies them. Empty until it does. */
export const policyFacts = {
  gstin: null as string | null,
  grievanceOfficer: {
    name: null as string | null,
    designation: null as string | null,
    phone: null as string | null,
    email: null as string | null,
  },
  dataContactEmail: null as string | null,
  retention: [] as string[],
  returns: [] as string[],
  exchange: [] as string[],
  cancellation: [] as string[],
  deliveryTerms: [] as string[],
  paymentMethods: [] as string[],
};

/** A flag set to true must carry the value it promises, or nothing prints. */
export function hasValue(fact: PolicyFact): boolean {
  switch (fact) {
    case "registeredAddress":
      return known.address;
    case "gstin":
      return Boolean(policyFacts.gstin);
    case "grievanceOfficer": {
      const officer = policyFacts.grievanceOfficer;
      return Boolean(officer.name && officer.designation && (officer.phone || officer.email));
    }
    case "dataContact":
      return Boolean(policyFacts.dataContactEmail);
    default:
      return policyFacts[fact].length > 0;
  }
}

/** How each missing fact is named to a visitor. */
export const PENDING: Record<PolicyFact, string> = {
  registeredAddress: "its registered address",
  gstin: "its GSTIN",
  grievanceOfficer: "the name and contact details of its grievance officer",
  dataContact: "an address for privacy requests",
  retention: "how long records are kept",
  returns: "its returns policy",
  exchange: "its exchange and buyback terms",
  cancellation: "its cancellation terms",
  deliveryTerms: "where pieces are sent, how long delivery takes and what carriage costs",
  paymentMethods: "how payment is taken",
};

export type PolicyPageMeta = {
  readonly href: string;
  readonly title: string;
  readonly description: string;
  readonly requires: readonly PolicyFact[];
};

export const POLICY_PAGES: readonly PolicyPageMeta[] = [
  {
    href: "/privacy",
    title: "Privacy",
    description: "What Alankar Jewellers collects through this website, why, where it is kept and what you can ask for.",
    requires: ["registeredAddress", "dataContact", "retention"],
  },
  {
    href: "/terms",
    title: "Terms of sale",
    description: "How pieces are priced and how an order placed on this website works.",
    requires: ["registeredAddress", "gstin", "cancellation", "paymentMethods"],
  },
  {
    href: "/returns",
    title: "Returns and refunds",
    description: "Returns, exchanges and refunds at Alankar Jewellers.",
    requires: ["returns", "exchange", "cancellation"],
  },
  {
    href: "/shipping",
    title: "Delivery",
    description: "Collecting a piece from the shop, or having it sent.",
    requires: ["deliveryTerms"],
  },
  {
    href: "/grievance",
    title: "Complaints",
    description: "How to raise a complaint with Alankar Jewellers, and how quickly it is answered.",
    requires: ["grievanceOfficer"],
  },
];

export function policyPage(href: string): PolicyPageMeta {
  const page = POLICY_PAGES.find((candidate) => candidate.href === href);
  if (!page) throw new Error(`No policy page registered at ${href}`);
  return page;
}

export function outstanding(page: PolicyPageMeta): PolicyFact[] {
  return page.requires.filter((fact) => !(policyKnown[fact] && hasValue(fact)));
}

export function isPublished(page: PolicyPageMeta): boolean {
  return outstanding(page).length === 0;
}

type DataItem = { readonly fields: readonly string[]; readonly item: string; readonly why: string };

/**
 * Every field the checkout form submits, grouped as a visitor would recognise
 * it. `fields` are the form's own `name` attributes: the test reads
 * app/checkout/page.tsx and fails if a submitted field is not listed here.
 */
export const CHECKOUT_DATA: readonly DataItem[] = [
  { fields: ["name", "phone", "email"], item: "Your name, phone number and email", why: "to confirm the order and reach you about it" },
  { fields: ["fulfilment"], item: "Whether you collect the piece or have it sent", why: "to hand it over the way you chose" },
  { fields: ["shipname", "line1", "line2", "city", "state", "pincode"], item: "A delivery name and address, if the piece is sent", why: "to send it" },
  { fields: ["pan"], item: "Your PAN", why: "required by law on a purchase of ₹2,00,000 or more, and not needed below that" },
  { fields: ["gstin"], item: "A GSTIN, only if you give one", why: "for a GST invoice when you buy for a business" },
  { fields: ["plan"], item: "How you want to settle", why: "the whole amount, or a booking advance with the rest paid at the counter" },
  { fields: ["notes"], item: "Anything you write in the notes", why: "so the shop can act on it" },
  { fields: ["consent"], item: "That you agreed to place the order, with the date and the version of the wording you agreed to", why: "as a record of that agreement" },
  { fields: ["marketing"], item: "Whether you asked to hear about new pieces", why: "it is off unless you tick it, and nothing about the order depends on it" },
];

/**
 * Every column an appointment request stores. `fields` are the keys written in
 * app/api/appointments/route.ts, and the test holds them to it.
 */
export const ENQUIRY_DATA: readonly DataItem[] = [
  { fields: ["name", "phone"], item: "Your name and phone number", why: "so the shop can call you back" },
  { fields: ["interest", "preferredTime"], item: "What you are interested in and when you would like to come", why: "to prepare the right pieces for your visit" },
  { fields: ["note"], item: "Anything you add in the note", why: "so the shop can act on it" },
  { fields: ["userAgent"], item: "The browser you used, which your browser sends with every request", why: "to recognise automated spam" },
  { fields: ["country"], item: "The country your connection came from, as reported by the hosting provider", why: "to recognise automated spam" },
];

/** Read off app/_data/cart.ts and app/_admin/session.ts; the test holds these to the code. */
export const COOKIE_FACTS = {
  cart: { name: "aj_cart", days: 30 },
  admin: { name: "__Host-aj_admin", idleHours: 8, absoluteDays: 7 },
} as const;
