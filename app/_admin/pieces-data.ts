/**
 * THE CATALOGUE, ADMIN-SHAPED — every read and every write the Pieces screens
 * make, in one module.
 *
 * ===========================================================================
 * THERE IS NO LONG FORM, AND THAT IS THE WHOLE DESIGN
 * ===========================================================================
 * `research/05-admin-ux.md` §9 settles this: a piece is CREATED IN ONE STEP and
 * COMPLETED IN MANY. Two fields start it — a name and a craft — and everything
 * else arrives afterwards in small sections that each save on their own.
 *
 * Three reasons, and each is sufficient on its own:
 *
 *  1. WITHOUT JAVASCRIPT A REJECTED LONG FORM LOSES EVERYTHING. Checkout pays
 *     that cost deliberately for a handful of PII fields; for a twenty-field
 *     jewellery form it is abandonment on the first mistake.
 *
 *  2. `variants_pricing_inputs_ck` REFUSES A `dynamic_metal` ROW WITHOUT BOTH A
 *     WEIGHT AND A FINENESS. One form that asks for the pricing mode and the
 *     weight at the same time can be filled in an order the database will not
 *     accept, and the owner is handed a constraint name against eight columns.
 *     Split into sections, the constraint becomes a SEQUENCE: `on_request` is
 *     always writable, so the piece is always in a legal state and the owner
 *     walks towards a priced one instead of hitting a wall.
 *
 *  3. A HALF-FINISHED PIECE IS THE NORMAL CASE. The owner starts one at the
 *     counter, a customer walks in, and they come back at eleven at night.
 *     `status = 'draft'` is already the schema default; this module makes it the
 *     expected path rather than the failure path.
 *
 * ===========================================================================
 * WHAT MAKES A HALF-FINISHED PIECE SAFE
 * ===========================================================================
 * Three independent things, not one:
 *
 *   VALID IN THE DATABASE  `createPiece()` writes `pricing_mode = 'on_request'`
 *                          EXPLICITLY. The column's default is `dynamic_metal`,
 *                          and a row inserted at that default with no weight
 *                          violates `variants_pricing_inputs_ck` — so the very
 *                          first insert would fail. The explicit value is not
 *                          belt and braces, it is the only thing that works.
 *
 *   INVISIBLE TO THE SHOP  `products.status` stays `draft`, and
 *                          `readCommerceRows()` in `app/_data/catalogue.ts`
 *                          filters on `status = 'active'`. A draft cannot reach
 *                          the storefront by any path.
 *
 *   NEVER A BROKEN LISTING Even once published, the storefront SKIPS any product
 *                          whose slug has no entry in that file's `PRESENTATION`
 *                          map, because it would have no photograph and no alt
 *                          text. Image upload is blocked (R2 is not enabled), so
 *                          nothing created here can be listed yet — and the
 *                          screens say exactly that rather than letting the
 *                          owner believe otherwise.
 *
 * ===========================================================================
 * THE HONESTY RULE
 * ===========================================================================
 * `huid`, `hallmarkPurityMark`, `certificateNumber` and `certificateLab` are
 * OPTIONAL AND ARE NEVER INVENTED. A HUID is a government-issued hallmark
 * identifier; this module has no expression that produces one, no default for
 * one, and no derivation of one from anything else. It records what the owner
 * typed and nothing else, and an empty field becomes NULL rather than "".
 *
 * The absence is EXPLAINED rather than blank, and which explanation applies is
 * decided the same way `app/admin/orders/[id]/page.tsx` already decides it —
 * from whether a hallmarking charge was raised:
 *
 *   `hallmarking_paise = 0`                exempt. Kundan, Polki and Jadau are
 *                                          outside mandatory hallmarking
 *                                          (QCO cl. 2(3)), which is this shop's
 *                                          flagship stock. Publishable.
 *   `hallmarking_paise > 0`, huid present  hallmarked, and the number is on
 *                                          record. Publishable.
 *   `hallmarking_paise > 0`, huid NULL     a charge with no number against it.
 *                                          NOT PUBLISHABLE — research/05 §7
 *                                          says so plainly, and `PUBLISH_PIECE`
 *                                          below makes the DATABASE refuse it
 *                                          rather than a WHERE clause quietly
 *                                          doing nothing.
 *
 * That third state is the schema's own default (`hallmarking_paise` defaults to
 * 4500), so a brand-new piece starts out unpublishable and the owner has to say
 * which of the two true things is true. Failing towards "we owe a number" is the
 * safe direction; failing towards "exempt" would be a claim about a physical
 * object that nobody made.
 *
 * ===========================================================================
 * UNITS — the three that get transposed
 * ===========================================================================
 *   MONEY   integer paise.        ₹22,400 is 2_240_000.
 *   WEIGHT  integer milligrams.   18.400 g is 18_400.
 *   PURITY  millesimal fineness.  22K is 916. NEVER a karat string: 995 has no
 *           karat at all, and rounding it to 24K mis-prices it by ~0.4% forever.
 *
 * Nothing here accepts a float. `parseGrams()` and `parseRupees()` are the only
 * doors between what an owner types and what is stored, and both return integers
 * or a notice code naming what is wrong.
 *
 * ===========================================================================
 * EVERY SENTENCE THE SCREENS SAY LIVES IN `PIECE_NOTICES`
 * ===========================================================================
 * A refusal has to survive a 303 back to a form. `app/api/admin/orders/route.ts`
 * sets the rule this follows: NOTHING FROM A REQUEST IS EVER REFLECTED INTO A
 * `Location`. So a failure travels as a code from a closed set and the copy is
 * looked up here — by the route for its JSON answer, and by the page for what it
 * prints. One table, so the two cannot drift into telling the owner two
 * different things about one refusal.
 *
 * ===========================================================================
 * NO CUSTOMER DATA PASSES THROUGH THIS MODULE
 * ===========================================================================
 * A piece is a thing, not a person. Nothing here reads a name, a phone number or
 * an address, so nothing here writes a `customer_data.*` audit row —
 * `app/_admin/data.ts` owns that obligation and reproducing it would report
 * reads that never happened. What IS written is a `piece.*` row per change, with
 * the allowlist-driven diff from `app/_admin/audit.ts`, inside the same
 * `db.batch()` as the change itself.
 */

import type { CartDb, CartStatement, SqlRow, SqlValue } from "../_data/cart";
import { isHallmarkExempt, type Craft as SharedCraft } from "../_data/types";
import {
  PriceEngineError,
  priceLine,
  purityLabel,
  type MakingCharge,
  type PricedLine,
  type PurityLabel,
} from "../_pricing/price";
import { auditStatement, buildDiff, toAuditRow, type AuditDiff } from "./audit";
import { readRateStanding, type AdminActor } from "./data";

/* =========================================================================
 * The handle
 * ====================================================================== */

const HANDLE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const HANDLE_LENGTH = 6;
const IST_OFFSET_MS = 330 * 60_000;

/**
 * `AJ-P-2608-4KX9P2`. The same shape as an order number and a ticket number,
 * with its own letter, so nobody reading a slip can confuse the three.
 *
 * DRAWN, NOT COUNTED, for the reason `newOrderNumber()` gives: D1 cannot make a
 * read-modify-write counter safe without an interactive transaction, and a
 * sequential handle leaks how much stock the shop has taken in.
 *
 * A SKU IS THE SHOP'S OWN HANDLE, AND GENERATING ONE IS HONEST. It is not a
 * HUID, not a certificate number and not an assay: it names a row, it makes no
 * claim about a physical object, and no authority issues it. That distinction is
 * the whole of why this function exists and why there is no `newHuid()` beside
 * it — and there must never be one.
 */
export const PIECE_SKU_PATTERN = /^AJ-P-\d{4}-[0-9A-HJKMNP-TV-Z]{6}$/;

export function newPieceSku(nowMs: number = Date.now()): string {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const yy = String(ist.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");

  const bytes = crypto.getRandomValues(new Uint8Array(HANDLE_LENGTH));
  let suffix = "";
  for (const byte of bytes) suffix += HANDLE_ALPHABET[byte % HANDLE_ALPHABET.length];

  return `AJ-P-${yy}${mm}-${suffix}`;
}

export function isPieceSku(value: unknown): value is string {
  return typeof value === "string" && PIECE_SKU_PATTERN.test(value);
}

/**
 * A handle that is safe to put in a URL and to query on.
 *
 * The seed writes its own SKUs (`var_jadau-haar` and friends), so the pattern
 * above cannot be the only key this panel accepts without orphaning the stock
 * that is already in the database. What every handle must be is short and made
 * of characters that cannot escape a query string.
 */
const SAFE_SKU = /^[A-Za-z0-9_-]{1,64}$/;

export function isUsableSku(value: unknown): value is string {
  return typeof value === "string" && SAFE_SKU.test(value);
}

/* =========================================================================
 * The vocabulary the screens speak
 * ====================================================================== */

/**
 * The six `products.craft` values, in the shop's words, with the one legal fact
 * that changes what the hallmark section may say about each.
 *
 * `hallmarkExempt` is a statement about a CATEGORY under QCO cl. 2(3), not about
 * a piece. It is used to print a sentence beside a choice; it never selects the
 * choice, because whether a particular article carries a hallmark is a fact
 * about that article and only the owner knows it.
 */
export const CRAFTS = [
  { value: "jadau", label: "Jadau", hallmarkExempt: true },
  { value: "polki", label: "Polki", hallmarkExempt: true },
  { value: "kundan", label: "Kundan", hallmarkExempt: true },
  { value: "gold", label: "Gold", hallmarkExempt: false },
  { value: "diamond", label: "Diamond", hallmarkExempt: false },
  { value: "other", label: "Something else", hallmarkExempt: false },
] as const;

/**
 * Re-exported from the shared vocabulary rather than re-derived here. The
 * storefront's product page needs the same union and the same exemption rule,
 * and cannot import this module — it pulls in the admin audit and data layers.
 * Two copies of a legal rule is one copy too many.
 */
export type Craft = SharedCraft;

export function isCraft(value: string): value is Craft {
  return CRAFTS.some((craft) => craft.value === value);
}

export function craftLabel(value: string): string {
  return CRAFTS.find((craft) => craft.value === value)?.label ?? "Something else";
}

export function craftIsHallmarkExempt(value: string): boolean {
  return isHallmarkExempt(value);
}

/**
 * The five gold finenesses IBJA publishes, each carrying BOTH labels — because
 * Reg. 5(11) requires purity "in carat and fineness", and because 995 has no
 * carat equivalent at all. A control offering only carats silently collapses 995
 * onto 24K and mis-prices every 995 piece by roughly 0.4%, forever, invisibly.
 */
export const FINENESS_CHOICES = [999, 995, 916, 750, 585] as const;

export type Fineness = (typeof FINENESS_CHOICES)[number];

export function isFineness(value: number): value is Fineness {
  return (FINENESS_CHOICES as readonly number[]).includes(value);
}

/** "22K (916)", or "995 fineness". Straight from the pricing engine's own rule. */
export function finenessDisplay(fineness: number): string {
  return finenessPurity(fineness)?.display ?? `${fineness} fineness`;
}

export function finenessPurity(fineness: number): PurityLabel | null {
  try {
    return purityLabel(fineness, "gold");
  } catch {
    return null;
  }
}

/**
 * Every piece created here is GOLD. `variants.metal` has four members and the
 * fineness control above is a gold control; a silver or platinum piece needs a
 * different purity list and a different rate row, and offering a metal picker
 * the rest of this screen could not honour would be worse than not offering one.
 * The screens say so in words rather than leaving it to be discovered.
 */
export const PIECE_METAL = "gold";

export const MAX_TITLE_LENGTH = 120;

/* =========================================================================
 * NOTICES — the closed set, and the only copy these screens carry
 * ====================================================================== */

export type PieceNotice =
  // Things that worked.
  | "created"
  | "weight-saved"
  | "price-saved"
  | "hallmark-saved"
  | "published"
  | "taken-off"
  | "put-away"
  | "brought-back"
  | "no-change"
  | "stock-moved"
  | "confirm-weight"
  // Things the owner can fix.
  | "needs-title"
  | "needs-craft"
  | "bad-weight"
  | "weight-too-big"
  | "bad-purity"
  | "needs-weight"
  | "needs-price"
  | "bad-money"
  | "bad-percent"
  | "bad-count"
  | "unique-stock"
  | "online-on-request"
  | "needs-huid"
  | "not-publishable"
  | "name-taken"
  | "negative-money"
  // Things that are the website's problem.
  | "bad-pricing"
  | "sku-taken"
  | "not-found"
  | "refused"
  | "unavailable";

export type NoticeCopy = { readonly copy: string; readonly problem: boolean };

/**
 * ONE TABLE, READ BY BOTH SIDES. The route answers a JSON caller with `copy` and
 * redirects a browser with the CODE; the page looks the code up here and prints
 * the same sentence. Nothing typed by anyone travels in a `Location`.
 *
 * Every sentence names the thing that is wrong AND the way out. research/05 §9:
 * the commonest reason a non-technical user gives up is an error message naming
 * a field they cannot see.
 */
export const PIECE_NOTICES: Readonly<Record<PieceNotice, NoticeCopy>> = {
  created: {
    copy: "Started. It is saved as a draft and is not on the website. Fill in the rest whenever you like, a bit at a time.",
    problem: false,
  },
  "weight-saved": { copy: "Weight and purity saved.", problem: false },
  "price-saved": { copy: "Saved.", problem: false },
  "hallmark-saved": { copy: "Saved.", problem: false },
  published: {
    copy: "Marked as on the website. It will not actually appear there until it has a photograph, and photographs cannot be added yet.",
    problem: false,
  },
  "taken-off": {
    copy: "Taken off the website. It is a draft again and nothing about it was lost.",
    problem: false,
  },
  "put-away": {
    copy: "Put away. It is off the website and out of the working list, and it can be brought back at any time.",
    problem: false,
  },
  "brought-back": { copy: "Brought back as a draft.", problem: false },
  "stock-moved": {
    copy:
      "This piece was ordered or put back while you had it open, so the stock was left as it stands rather than overwritten. Open it again to see where it is now.",
    problem: true,
  },
  "no-change": { copy: "Nothing changed. The piece was already like that.", problem: false },
  "confirm-weight": {
    copy: "Nothing has been saved yet. Read the weight back, in words and in rupees, and confirm it.",
    problem: false,
  },

  "needs-title": {
    copy: "Give the piece a name first. It is the name the customer will see, and everything else can wait.",
    problem: true,
  },
  "needs-craft": { copy: "Say what kind of piece it is.", problem: true },
  "bad-weight": {
    copy: "That is not a weight this can read. Write it in grams the way it reads on the scale: 18.4 and 18.400 both work. Digits and at most one dot, no commas, and no more than three figures after the dot.",
    problem: true,
  },
  "weight-too-big": {
    copy: "That weight is over five kilograms, which is almost always a misplaced decimal point rather than a real piece. Nothing was saved. Check it and try again.",
    problem: true,
  },
  "bad-purity": {
    copy: "Purity has to be one of 999, 995, 916, 750 or 585. 22K is 916, and 995 has no carat name at all: which is why both are printed on every button.",
    problem: true,
  },
  "needs-weight": {
    copy: "A piece priced by weight needs both a net metal weight and a purity, and this one is missing at least one of them. Add them under “Weight and purity” first, or leave it at price on request, which is a real answer and the website says so plainly.",
    problem: true,
  },
  "needs-price": {
    copy: "A fixed price needs a figure. Type the price the customer would pay, or leave it at price on request for now.",
    problem: true,
  },
  "bad-money": {
    copy: "That is not an amount this can read. Write it in rupees, like 22400 or 22,400.",
    problem: true,
  },
  "bad-percent": {
    copy: "Write the making charge as a percentage, like 12 or 12.5. Anything over 100% of the gold value is almost certainly a typo.",
    problem: true,
  },
  "bad-count": {
    copy: "Write how many there are as a whole number, like 1 or 6.",
    problem: true,
  },
  "unique-stock": {
    copy: "A one-of-a-kind piece can only have one in stock. Either say there is more than one of these, or set the number to 1.",
    problem: true,
  },
  "online-on-request": {
    copy: "A piece shown at “price on request” cannot be bought on the website. There is no figure to charge. Give it a price, or leave it as one people ask about.",
    problem: true,
  },
  "needs-huid": {
    copy: "Type the hallmark number as it reads on the piece. If it is not to hand, choose “it is hallmarked but the number is not here” instead and come back to it. Nothing will be made up in the meantime.",
    problem: true,
  },
  "not-publishable": {
    copy: "Answer the hallmark question first: either this piece's hallmark number, or that it is exempt because it is Kundan, Polki or Jadau. Until then it stays off the website.",
    problem: true,
  },
  "name-taken": {
    copy: "There is already a piece with a name very like that one. Give this one a name that tells them apart. The customer sees it too.",
    problem: true,
  },
  "negative-money": {
    copy: "None of these amounts can be less than nothing.",
    problem: true,
  },

  "bad-pricing": {
    copy: "This piece cannot be priced the way it is set up: priced by weight it needs a weight and a purity, and priced at a fixed price it needs that price. Nothing was changed. Set it to price on request, then add the missing part.",
    problem: true,
  },
  "sku-taken": {
    copy: "That piece number is already in use. Try again. A new one is drawn each time.",
    problem: true,
  },
  "not-found": {
    copy: "There is no piece with that number.",
    problem: true,
  },
  refused: {
    copy: "That request could not be verified, so nothing was changed. Try it again from this page.",
    problem: true,
  },
  unavailable: {
    copy: "Nothing was changed. Try again, and if it happens twice tell whoever runs the site.",
    problem: true,
  },
};

export function isPieceNotice(value: string): value is PieceNotice {
  return Object.prototype.hasOwnProperty.call(PIECE_NOTICES, value);
}

export function noticeCopy(notice: PieceNotice): string {
  return PIECE_NOTICES[notice].copy;
}

/* =========================================================================
 * PARSING — the only door between what is typed and what is stored
 * ====================================================================== */

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly notice: PieceNotice };

/** Five kilograms. Above this it is not a piece of jewellery, it is a typo. */
export const MAX_WEIGHT_MG = 5_000_000;

/**
 * Grams as an owner types them, to integer milligrams. Empty means "not weighed
 * yet", which is a legitimate answer and returns NULL rather than a refusal.
 *
 * A COMMA IS REFUSED OUTRIGHT rather than guessed at. In Indian digit grouping
 * `18,400` reads as eighteen thousand four hundred; in half the world it reads
 * as 18.4. A separator whose meaning is ambiguous must never be silently
 * resolved on the field that multiplies the price of the piece.
 */
export function parseGrams(raw: string): Parsed<number | null> {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };

  const match = /^(\d{1,5})(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return { ok: false, notice: "bad-weight" };

  const grams = Number(match[1]);
  const milli = Number((match[2] ?? "").padEnd(3, "0"));
  const mg = grams * 1000 + milli;

  if (mg === 0) return { ok: false, notice: "bad-weight" };
  if (mg > MAX_WEIGHT_MG) return { ok: false, notice: "weight-too-big" };
  return { ok: true, value: mg };
}

/** `18.400 g`. Three decimals always, because that is how the trade quotes. */
export function formatGrams(mg: number): string {
  const grams = Math.floor(mg / 1000);
  const remainder = String(mg % 1000).padStart(3, "0");
  return `${grams}.${remainder} g`;
}

/** One crore rupees. A piece above this needs a conversation, not a text box. */
export const MAX_MONEY_PAISE = 1_000_000_000;

/**
 * Rupees as an owner types them, to integer paise.
 *
 * Commas ARE accepted here and are not on the weight, and the asymmetry is
 * deliberate: `22,400` in a money box has exactly one reading in this shop,
 * while the same string in a weight box has two and one of them is a
 * thousand-fold error.
 */
export function parseRupees(raw: string): Parsed<number | null> {
  const text = raw.trim().replace(/[,\s₹]/g, "");
  if (text === "") return { ok: true, value: null };

  const match = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return { ok: false, notice: "bad-money" };

  const paise = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (paise > MAX_MONEY_PAISE) return { ok: false, notice: "bad-money" };
  return { ok: true, value: paise };
}

/** A percentage to basis points. 12 and 12.5 both work; 1200 and 1250 come out. */
export function parsePercent(raw: string): Parsed<number | null> {
  const text = raw.trim().replace(/[%\s]/g, "");
  if (text === "") return { ok: true, value: null };

  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return { ok: false, notice: "bad-percent" };

  const bps = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (bps > 10_000) return { ok: false, notice: "bad-percent" };
  return { ok: true, value: bps };
}

/** A whole number of articles. */
export function parseCount(raw: string): Parsed<number | null> {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (!/^\d{1,4}$/.test(text)) return { ok: false, notice: "bad-count" };
  return { ok: true, value: Number(text) };
}

/**
 * A recorded identifier, trimmed and capped, or NULL.
 *
 * NULL AND NOT "" — the difference IS the honesty rule. An empty string in
 * `huid` would read downstream as "there is a hallmark number and it is blank",
 * which is a claim. NULL reads as "no number is on record", which is the truth
 * and is what every renderer in this project already explains rather than
 * printing blank.
 */
export function recordedText(raw: string, max = 80): string | null {
  const text = raw.trim().slice(0, max);
  return text === "" ? null : text;
}

/* =========================================================================
 * NUMBERS IN WORDS — the ten-times guard
 * ====================================================================== */

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
] as const;

const TENS = [
  "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety",
] as const;

function underHundred(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = n % 10;
  return ones === 0 ? tens : `${tens}-${ONES[ones]}`;
}

function underThousand(n: number): string {
  if (n < 100) return underHundred(n);
  const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest === 0 ? hundreds : `${hundreds} and ${underHundred(rest)}`;
}

/** Whole numbers to five figures, which is all these screens ever need. */
export function numberInWords(n: number): string {
  const whole = Math.max(0, Math.trunc(n));
  if (whole < 1000) return underThousand(whole);
  const thousands = `${underThousand(Math.floor(whole / 1000))} thousand`;
  const rest = whole % 1000;
  return rest === 0 ? thousands : `${thousands} ${underThousand(rest)}`;
}

/**
 * "eighteen grams and four hundred milligrams".
 *
 * THIS IS THE TEN-TIMES GUARD. A factor-of-ten weight error is invisible in a
 * number field — 18.400 and 184.00 are one keystroke apart and look alike at a
 * glance — and it is the most expensive mistake this whole panel can make,
 * because it multiplies the gold in the piece by ten and nothing downstream
 * throws. Spelled out, 184.00 becomes "one hundred and eighty-four grams", which
 * shares not one word with the right answer.
 */
export function weightInWords(mg: number): string {
  const grams = Math.floor(mg / 1000);
  const milli = mg % 1000;

  const gramWords = `${numberInWords(grams)} ${grams === 1 ? "gram" : "grams"}`;
  const milliWords = `${numberInWords(milli)} ${milli === 1 ? "milligram" : "milligrams"}`;

  if (grams === 0) return milliWords;
  if (milli === 0) return gramWords;
  return `${gramWords} and ${milliWords}`;
}

/* =========================================================================
 * The slug
 * ====================================================================== */

/**
 * A URL handle from a title. `products.slug` is UNIQUE, so a collision is a real
 * outcome rather than a theoretical one — two "Polki necklace" pieces is what a
 * jeweller's stock actually looks like.
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

const SELECT_SLUGS_LIKE = `SELECT slug AS "slug" FROM products WHERE slug = ? OR slug LIKE ?`;

/**
 * The suffix is chosen from a READ, and the read races: two admins creating the
 * same title in the same second both see the same free slug. That race ends at
 * the UNIQUE index, the batch aborts, and `constraintNotice()` turns it into the
 * `name-taken` sentence. Losing the race costs a retyped name, never a bad row.
 */
async function freeSlug(db: CartDb, title: string, sku: string): Promise<string> {
  const base = slugify(title);
  // A title with no Latin letters at all — Devanagari, or only punctuation —
  // still needs a handle, and the piece's own SKU is one nobody else holds.
  if (base === "") return `piece-${sku.slice(-6).toLowerCase()}`;

  const rows = await db.all(SELECT_SLUGS_LIKE, [base, `${base}-%`]);
  const taken = new Set(rows.map((row) => String(row.slug ?? "")));
  if (!taken.has(base)) return base;

  for (let n = 2; n <= 50; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${sku.slice(-6).toLowerCase()}`;
}

/* =========================================================================
 * The row
 * ====================================================================== */

export type PieceStatus = "draft" | "active" | "archived";
export type PricingMode = "dynamic_metal" | "fixed" | "on_request";
export type SaleMode = "buy_online" | "enquire_only" | "appointment_only";
export type MakingChargeType = "per_gram" | "percent" | "flat";

export type AdminPiece = {
  readonly productId: string;
  readonly variantId: string;
  readonly sku: string;
  readonly slug: string;
  readonly title: string;
  readonly craft: string;
  readonly status: PieceStatus;
  readonly saleMode: SaleMode;
  readonly pricingMode: PricingMode;
  readonly metal: string;
  readonly fineness: number | null;
  readonly netMetalWeightMg: number | null;
  readonly grossWeightMg: number | null;
  readonly makingChargeType: MakingChargeType | null;
  readonly makingChargeValue: number | null;
  readonly stoneValuePaise: number;
  readonly hallmarkingPaise: number;
  readonly otherChargesPaise: number;
  readonly fixedPricePaise: number | null;
  /** NULL means no number is on record. It is never "" and never invented. */
  readonly huid: string | null;
  readonly hallmarkPurityMark: string | null;
  readonly certificateNumber: string | null;
  readonly certificateLab: string | null;
  readonly isUniquePiece: boolean;
  readonly stockQuantity: number;
  readonly photographs: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

function text(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number") return String(value);
  return null;
}

function int(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
  }
  return null;
}

function asStatus(value: string | null): PieceStatus {
  return value === "active" || value === "archived" ? value : "draft";
}

function asPricingMode(value: string | null): PricingMode {
  return value === "dynamic_metal" || value === "fixed" ? value : "on_request";
}

function asSaleMode(value: string | null): SaleMode {
  return value === "buy_online" || value === "appointment_only" ? value : "enquire_only";
}

export function isSaleMode(value: string): value is SaleMode {
  return value === "buy_online" || value === "enquire_only" || value === "appointment_only";
}

export function isPricingMode(value: string): value is PricingMode {
  return value === "dynamic_metal" || value === "fixed" || value === "on_request";
}

export function isMakingChargeType(value: string): value is MakingChargeType {
  return value === "per_gram" || value === "percent" || value === "flat";
}

function asMakingType(value: string | null): MakingChargeType | null {
  return value !== null && isMakingChargeType(value) ? value : null;
}

const PIECE_COLUMNS = `
         p.id                     AS "productId",
         v.id                     AS "variantId",
         v.sku                    AS "sku",
         p.slug                   AS "slug",
         p.title                  AS "title",
         p.craft                  AS "craft",
         p.status                 AS "status",
         p.sale_mode              AS "saleMode",
         v.pricing_mode           AS "pricingMode",
         v.metal                  AS "metal",
         v.fineness               AS "fineness",
         v.net_metal_weight_mg    AS "netMetalWeightMg",
         v.gross_weight_mg        AS "grossWeightMg",
         v.making_charge_type     AS "makingChargeType",
         v.making_charge_value    AS "makingChargeValue",
         v.stone_value_paise      AS "stoneValuePaise",
         v.hallmarking_paise      AS "hallmarkingPaise",
         v.other_charges_paise    AS "otherChargesPaise",
         v.fixed_price_paise      AS "fixedPricePaise",
         v.huid                   AS "huid",
         v.hallmark_purity_mark   AS "hallmarkPurityMark",
         v.certificate_number     AS "certificateNumber",
         v.certificate_lab        AS "certificateLab",
         v.is_unique_piece        AS "isUniquePiece",
         v.stock_quantity         AS "stockQuantity",
         p.created_at             AS "createdAt",
         p.updated_at             AS "updatedAt",
         (SELECT COUNT(*) FROM product_media m WHERE m.product_id = p.id) AS "photographs"`;

/**
 * Newest first. The unfinished piece the owner walked away from is the one they
 * came back for, and it is at the top without them looking for it.
 */
const SELECT_PIECES = `
  SELECT ${PIECE_COLUMNS}
    FROM products p
    JOIN variants v ON v.product_id = p.id
   ORDER BY p.created_at DESC, p.rowid DESC
   LIMIT ?`;

const SELECT_PIECE_BY_SKU = `
  SELECT ${PIECE_COLUMNS}
    FROM products p
    JOIN variants v ON v.product_id = p.id
   WHERE v.sku = ?
   LIMIT 1`;

function toPiece(row: SqlRow): AdminPiece {
  return {
    productId: text(row, "productId") ?? "",
    variantId: text(row, "variantId") ?? "",
    sku: text(row, "sku") ?? "",
    slug: text(row, "slug") ?? "",
    title: text(row, "title") ?? "",
    craft: text(row, "craft") ?? "other",
    status: asStatus(text(row, "status")),
    saleMode: asSaleMode(text(row, "saleMode")),
    pricingMode: asPricingMode(text(row, "pricingMode")),
    metal: text(row, "metal") ?? PIECE_METAL,
    fineness: int(row, "fineness"),
    netMetalWeightMg: int(row, "netMetalWeightMg"),
    grossWeightMg: int(row, "grossWeightMg"),
    makingChargeType: asMakingType(text(row, "makingChargeType")),
    makingChargeValue: int(row, "makingChargeValue"),
    stoneValuePaise: int(row, "stoneValuePaise") ?? 0,
    hallmarkingPaise: int(row, "hallmarkingPaise") ?? 0,
    otherChargesPaise: int(row, "otherChargesPaise") ?? 0,
    fixedPricePaise: int(row, "fixedPricePaise"),
    huid: text(row, "huid"),
    hallmarkPurityMark: text(row, "hallmarkPurityMark"),
    certificateNumber: text(row, "certificateNumber"),
    certificateLab: text(row, "certificateLab"),
    isUniquePiece: (int(row, "isUniquePiece") ?? 1) === 1,
    stockQuantity: int(row, "stockQuantity") ?? 0,
    photographs: int(row, "photographs") ?? 0,
    createdAt: text(row, "createdAt") ?? "",
    updatedAt: text(row, "updatedAt") ?? "",
  };
}

/** How many pieces a list may show before it stops being a list. */
export const PIECE_LIMIT = 200;

/**
 * Every piece in the database, in every state.
 *
 * NO SEED FALLBACK, unlike `readCatalogue()`. `app/_admin/view-types.ts` states
 * the reason: a compiled substitute is right for a shop window and wrong for a
 * management screen. If D1 holds nothing this returns nothing, and the screen
 * says the catalogue is empty — which is a fact the owner needs rather than one
 * to paper over.
 */
export async function listPieces(
  db: CartDb,
  { limit = PIECE_LIMIT }: { limit?: number } = {}
): Promise<AdminPiece[]> {
  const rows = await db.all(SELECT_PIECES, [Math.max(1, Math.trunc(limit))]);
  return rows.map(toPiece);
}

export async function readPiece(db: CartDb, sku: string): Promise<AdminPiece | null> {
  if (!isUsableSku(sku)) return null;
  const [row] = await db.all(SELECT_PIECE_BY_SKU, [sku]);
  return row ? toPiece(row) : null;
}

/* =========================================================================
 * THE CHECKLIST — what is missing, said before it is asked for
 * ====================================================================== */

export type PieceGapId = "photograph" | "weight" | "price" | "hallmark";

export type PieceGap = {
  readonly id: PieceGapId;
  /** The heading the section carries. */
  readonly label: string;
  /** A few words for the "Still needs:" line on the list. */
  readonly short: string;
  readonly done: boolean;
  /** True only for a gap that actually stops the piece going on the website. */
  readonly blocksPublishing: boolean;
  /** Null when nothing in this panel can resolve it — see `photograph`. */
  readonly section: "weight" | "price" | "hallmark" | null;
};

/**
 * Whether the hallmark question has been ANSWERED — which is not the same as
 * whether there is a number, and that difference is the honesty rule made
 * mechanical. "It is exempt" and "here is the number" are both answers. "I have
 * not said" is not, and it is the state a new piece starts in.
 */
export function hallmarkAnswered(piece: AdminPiece): boolean {
  return piece.hallmarkingPaise === 0 || piece.huid !== null;
}

/**
 * THE ONE BLOCKER IS THE HALLMARK ANSWER, and everything else is a note.
 *
 * Note what is deliberately NOT a blocker. A piece with no weight is
 * `on_request`, and research/05 is explicit that this must be "the natural, easy
 * state — not a validation failure the owner has to fight". A shop that sells a
 * ₹4 lakh antique through a private viewing has pieces that will never carry a
 * rate card, and refusing to publish those would make the panel wrong about the
 * business rather than careful about the data.
 */
export function gapsFor(piece: AdminPiece): readonly PieceGap[] {
  const weighed = piece.netMetalWeightMg !== null && piece.fineness !== null;

  return [
    {
      id: "photograph",
      label: "A photograph",
      short: "a photograph",
      done: piece.photographs > 0,
      // Not the owner's to fix, so it must not stop them. See PHOTOGRAPHS_BLOCKED.
      blocksPublishing: false,
      section: null,
    },
    {
      id: "weight",
      label: "Weight and purity",
      short: "weight and purity",
      done: weighed,
      blocksPublishing: false,
      section: "weight",
    },
    {
      id: "price",
      label: "How it is priced",
      // A price is only a GAP once the piece could carry one. Before it has been
      // weighed there is nothing to price it from, and "price on request" is the
      // honest answer rather than an unfinished one.
      short: "a price",
      done: !weighed || piece.pricingMode !== "on_request",
      blocksPublishing: false,
      section: "price",
    },
    {
      id: "hallmark",
      label: "Hallmark number, or the reason there is not one",
      short: "the hallmark answer",
      done: hallmarkAnswered(piece),
      blocksPublishing: true,
      section: "hallmark",
    },
  ];
}

/** The words that go after "Still needs:" on a list row. */
export function stillNeeds(piece: AdminPiece): readonly string[] {
  return gapsFor(piece)
    .filter((gap) => !gap.done)
    .map((gap) => gap.short);
}

export function canPublish(piece: AdminPiece): boolean {
  return gapsFor(piece).every((gap) => gap.done || !gap.blocksPublishing);
}

/**
 * IMAGE UPLOAD IS BLOCKED, AND THE PANEL SAYS SO WHERE A PHOTOGRAPH WOULD GO.
 *
 * R2 is not enabled on this account (dashboard opt-in; wrangler error 10042),
 * `env.MEDIA` is undefined at runtime, and the deploy-time IMAGES/ASSETS
 * bindings do not help — `worker/index.ts` resolves sources only through
 * `env.ASSETS`. Serving an upload needs a route handler over `env.MEDIA`, so
 * there is nothing to build against yet; M3 task 3.2 is marked `blocked` for
 * exactly this.
 *
 * The consequence is not cosmetic and the screens must not soften it:
 * `readCommerceRows()` SKIPS any product whose slug has no imagery manifest
 * entry, so a piece with no photograph does not appear on the website even after
 * it has been published. A broken control here would be a lie; a sentence is the
 * truth.
 */
export const PHOTOGRAPHS_BLOCKED =
  "Photographs cannot be added yet. The storage they need is not switched on for this account, so there is nothing here to upload to, and until a piece has one the website leaves it out, even when it is marked as being on the website. That is the website being careful rather than something you have done wrong.";

/* =========================================================================
 * DIAGNOSING THE CONSTRAINTS, BEFORE AND AFTER
 * ====================================================================== */

/**
 * The pricing contract, checked in the owner's words BEFORE the write.
 *
 * `variants_pricing_inputs_ck` is the constraint most likely to be met by
 * someone who cannot read it. The database's own message is
 * "CHECK constraint failed: variants_pricing_inputs_ck" against a row with eight
 * columns, and there is no way to work out from that which one is wrong.
 *
 * So the mode is checked here first, and each refusal names the missing thing
 * AND the way out — and the way out is always available, because `on_request`
 * carries no precondition at all. That is what turns the constraint from a wall
 * into a sequence.
 */
export function pricingNotice(input: {
  readonly pricingMode: PricingMode;
  readonly netMetalWeightMg: number | null;
  readonly fineness: number | null;
  readonly fixedPricePaise: number | null;
}): PieceNotice | null {
  if (input.pricingMode === "on_request") return null;
  if (input.pricingMode === "dynamic_metal") {
    return input.netMetalWeightMg === null || input.fineness === null ? "needs-weight" : null;
  }
  return input.fixedPricePaise === null ? "needs-price" : null;
}

/** The one-of-a-kind rule, in shop English. `variants_unique_piece_stock_ck`. */
export function stockNotice(input: {
  readonly isUniquePiece: boolean;
  readonly stockQuantity: number;
}): PieceNotice | null {
  if (input.stockQuantity < 0) return "bad-count";
  if (input.isUniquePiece && input.stockQuantity > 1) return "unique-stock";
  return null;
}

/**
 * THE BACKSTOP. Every constraint that can still abort a batch, mapped to a
 * sentence.
 *
 * The pre-checks above cover the paths these screens can reach, but they are
 * code and the constraints are the database — and the database is the one that
 * is actually true. A race, a seeded row with an unexpected shape, or a future
 * edit to a form can each put a write in front of a CHECK the pre-check did not
 * anticipate. When that happens the owner must still be told what is wrong in
 * words, and never handed a constraint name.
 */
export function constraintNotice(error: unknown): PieceNotice | null {
  const message = error instanceof Error ? error.message : String(error ?? "");

  if (message.includes("variants_pricing_inputs_ck")) return "bad-pricing";
  if (message.includes("variants_unique_piece_stock_ck")) return "unique-stock";
  if (message.includes("variants_stock_non_negative_ck")) return "bad-count";
  if (message.includes("variants_fineness_range_ck")) return "bad-purity";
  if (message.includes("variants_money_non_negative_ck")) return "negative-money";
  if (message.includes("products.slug") || message.includes("products_slug_unique")) {
    return "name-taken";
  }
  if (message.includes("variants.sku") || message.includes("variants_sku_unique")) {
    return "sku-taken";
  }
  // PUBLISH_PIECE writes NULL into a NOT NULL column when the hallmark question
  // has not been answered. The abort IS the refusal.
  if (/NOT NULL constraint failed: products\.status/i.test(message)) return "not-publishable";
  return null;
}

/* =========================================================================
 * THE PRICE PREVIEW — where a wrong weight becomes obvious
 * ====================================================================== */

export type PreviewRow = { readonly label: string; readonly amountPaise: number };

/**
 * `rows` IS THE ENGINE'S OWN BREAKUP AND ALREADY CARRIES THE GST LINE.
 * `priceLine()` always appends one — E-Commerce Rule 7(1)(e) requires the
 * applicable tax to appear in the breakup — so a renderer that adds a GST row
 * of its own prints the tax twice and shows a total that does not foot. The
 * rows are passed through untouched for exactly that reason.
 */
export type PricePreview =
  | {
      readonly ok: true;
      readonly rows: readonly PreviewRow[];
      readonly totalPaise: number;
      readonly purity: PurityLabel | null;
      readonly ratePerTenGramsPaise: number | null;
    }
  | { readonly ok: false; readonly reason: "on_request" | "no_rate" | "not_priceable" };

function makingChargeOf(piece: AdminPiece): MakingCharge | undefined {
  if (piece.makingChargeType === null || piece.makingChargeValue === null) return undefined;
  return { type: piece.makingChargeType, value: piece.makingChargeValue };
}

/**
 * What the website would show for this piece today, itemised.
 *
 * research/05 calls this the most valuable element on the screen, and it is: a
 * wrong weight, a wrong making mode and a wrong purity each become obvious in
 * the breakup and in nothing else. Without JavaScript it cannot follow a
 * keystroke, so it appears on the confirmation and on the piece page after a
 * save — which is the moment it is actually needed.
 *
 * It goes through `priceLine()` — the same engine the storefront and the invoice
 * use — and NOT through arithmetic written here. A preview computed a second way
 * is a preview that can disagree with what a customer is charged.
 */
export function previewPrice(
  piece: AdminPiece,
  ratePerTenGramsPaise: number | null
): PricePreview {
  if (piece.pricingMode === "on_request") return { ok: false, reason: "on_request" };

  let line: PricedLine;
  try {
    if (piece.pricingMode === "fixed") {
      if (piece.fixedPricePaise === null) return { ok: false, reason: "not_priceable" };
      line = priceLine({
        pricingMode: "fixed",
        fixedPricePaise: piece.fixedPricePaise,
        hallmarkingPaise: piece.hallmarkingPaise,
        otherChargesPaise: piece.otherChargesPaise,
        metal: "gold",
        fineness: piece.fineness ?? undefined,
      });
    } else {
      if (piece.netMetalWeightMg === null || piece.fineness === null) {
        return { ok: false, reason: "not_priceable" };
      }
      if (ratePerTenGramsPaise === null) return { ok: false, reason: "no_rate" };
      line = priceLine({
        pricingMode: "dynamic_metal",
        metal: "gold",
        fineness: piece.fineness,
        netMetalWeightMg: piece.netMetalWeightMg,
        rate: { metal: "gold", fineness: piece.fineness, ratePerTenGramsPaise },
        makingCharge: makingChargeOf(piece),
        stoneValuePaise: piece.stoneValuePaise,
        hallmarkingPaise: piece.hallmarkingPaise,
        otherChargesPaise: piece.otherChargesPaise,
      });
    }
  } catch (error) {
    // A `PriceEngineError` here means the row cannot be priced at all. The
    // screen says so; it never falls back to a figure it made up.
    if (!(error instanceof PriceEngineError)) throw error;
    console.error("[admin-pieces] this piece cannot be priced:", error.message);
    return { ok: false, reason: "not_priceable" };
  }

  return {
    ok: true,
    rows: line.components.map((component) => ({
      label: component.label,
      amountPaise: component.amountPaise,
    })),
    totalPaise: line.lineTotalPaise,
    purity: line.purity ?? null,
    ratePerTenGramsPaise,
  };
}

/**
 * The gold rate in force for a fineness, or null.
 *
 * NULL COVERS BOTH "none was ever recorded" AND "the one on record is stale",
 * and both produce the same sentence on screen: this cannot be shown in rupees.
 * Never a zero and never yesterday's figure presented as today's — a number the
 * owner would act on has to be one the pricing layer would actually charge from.
 */
export async function readUsableRatePaise(
  db: CartDb,
  fineness: number | null,
  nowMs: number
): Promise<number | null> {
  if (fineness === null) return null;
  try {
    const standing = await readRateStanding(db, { metal: PIECE_METAL, fineness, nowMs });
    return standing.lookup !== null && standing.lookup.ok
      ? standing.lookup.rate.ratePerTenGramsPaise
      : null;
  } catch (error) {
    console.error("[admin-pieces] the gold rate could not be read:", error);
    return null;
  }
}

/**
 * The gold in a piece, in paise, at a given rate — the money half of the echo.
 *
 * It reuses `priceLine()` with every other charge stripped out, so the figure in
 * the confirmation is arithmetically the same one the invoice will carry. A
 * second implementation of `rate x weight / 10000` would be a second place for
 * the rounding rule to drift, and `db/schema.ts` writes that rule down precisely
 * because it must exist once.
 */
export function goldValuePaise(
  netMetalWeightMg: number,
  fineness: number,
  ratePerTenGramsPaise: number
): number | null {
  try {
    return priceLine({
      pricingMode: "dynamic_metal",
      metal: "gold",
      fineness,
      netMetalWeightMg,
      rate: { metal: "gold", fineness, ratePerTenGramsPaise },
      hallmarkingPaise: 0,
    }).unit.metalValuePaise;
  } catch (error) {
    if (!(error instanceof PriceEngineError)) throw error;
    return null;
  }
}

/* =========================================================================
 * WRITES
 * ====================================================================== */

/**
 * Why every write reports a NOTICE rather than throwing.
 *
 * Each of these is something an owner can be told and can act on, so each is a
 * value the screen renders as a sentence. A throw would become a 503 and "try
 * again", which is the wrong answer to "you have not said whether this piece
 * carries a hallmark".
 */
export type WriteOutcome<T = undefined> =
  | { readonly ok: true; readonly notice: PieceNotice; readonly value: T }
  | { readonly ok: false; readonly notice: PieceNotice };

function refuse(notice: PieceNotice): { readonly ok: false; readonly notice: PieceNotice } {
  return { ok: false, notice };
}

const AUDIT_ACTIONS = {
  created: "piece.created",
  weight: "piece.weight_changed",
  pricing: "piece.pricing_changed",
  hallmark: "piece.hallmark_changed",
  status: "piece.status_changed",
} as const;

/**
 * One audit statement, allowlist-driven, for the caller's own batch.
 *
 * `AUDIT_VALUE_ALLOWLIST` lets `sku`, `stock_quantity`, `is_unique_piece` and
 * `fineness` carry their values for a variant, and `slug`, `status`, `sale_mode`
 * and `position` for a product. EVERYTHING ELSE — the weight, the making charge,
 * the stone value, the fixed price, the HUID, the certificate number — comes
 * back as the indicator `"changed"`, which proves something moved and carries
 * nothing. That is not this module's discipline to keep; `buildDiff()` enforces
 * it, and nothing here can widen it.
 */
function auditFor(input: {
  readonly actor: AdminActor;
  readonly action: string;
  readonly entityType: "product" | "variant";
  readonly entityId: string;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  readonly nowMs: number;
}): { readonly statement: CartStatement; readonly diff: AuditDiff } {
  const diff = buildDiff(input.entityType, input.before, input.after);
  const row = toAuditRow({
    actorEmail: input.actor.email,
    actorAdminUserId: input.actor.adminUserId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    diff,
    result: "ok",
    ip: input.actor.ip,
    userAgent: input.actor.userAgent,
    nowMs: input.nowMs,
  });
  return { statement: auditStatement(row), diff };
}

const INSERT_PRODUCT = `
  INSERT INTO products (id, slug, title, craft, status, sale_mode, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'draft', 'enquire_only', ?, ?)`;

/**
 * `pricing_mode` IS WRITTEN EXPLICITLY, AND THIS IS NOT DECORATION.
 *
 * The column defaults to `dynamic_metal`, and `variants_pricing_inputs_ck`
 * refuses a `dynamic_metal` row with no weight and no fineness. A piece created
 * from two fields has neither, so an insert at the default is a row the database
 * will not take. `on_request` is the only mode with no precondition, which is
 * exactly why it is the state a piece starts in and the state it can always be
 * returned to.
 *
 * `hallmarking_paise` is likewise written at its own default value rather than
 * inherited, so the unanswered hallmark state is a decision this code made and
 * can be read back as one.
 */
const INSERT_VARIANT = `
  INSERT INTO variants (
    id, product_id, sku, metal, pricing_mode,
    stone_value_paise, hallmarking_paise, other_charges_paise,
    is_unique_piece, stock_quantity, position, created_at, updated_at
  ) VALUES (?, ?, ?, 'gold', 'on_request', 0, 4500, 0, 1, 1, 0, ?, ?)`;

export type CreatePieceInput = {
  readonly title: string;
  readonly craft: string;
  readonly actor: AdminActor;
  readonly nowMs?: number;
};

/**
 * TWO FIELDS, AND THE PIECE EXISTS.
 *
 * That is the whole barrier to starting one. Everything else is added later, on
 * the piece's own page, in sections that each save on their own — so an
 * interruption costs nothing and a rejected section loses only itself.
 */
export async function createPiece(
  db: CartDb,
  input: CreatePieceInput
): Promise<WriteOutcome<AdminPiece>> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();

  const title = input.title.trim().slice(0, MAX_TITLE_LENGTH);
  if (title === "") return refuse("needs-title");
  if (!isCraft(input.craft)) return refuse("needs-craft");

  const sku = newPieceSku(nowMs);
  const productId = crypto.randomUUID();
  const variantId = crypto.randomUUID();

  let slug: string;
  try {
    slug = await freeSlug(db, title, sku);
  } catch (error) {
    console.error("[admin-pieces] could not work out a web address for the piece:", error);
    return refuse("unavailable");
  }

  const audit = auditFor({
    actor: input.actor,
    action: AUDIT_ACTIONS.created,
    entityType: "product",
    entityId: productId,
    before: {},
    // `slug`, `status` and `sale_mode` are on the product allowlist and carry
    // their values. The title and the craft are not, and come back as
    // "changed" — the allowlist is a closed list, and widening it here would be
    // widening it for every entity that shares the type.
    after: { slug, status: "draft", sale_mode: "enquire_only", title, craft: input.craft },
    nowMs,
  });

  try {
    await db.batch([
      { sql: INSERT_PRODUCT, params: [productId, slug, title, input.craft, now, now] },
      { sql: INSERT_VARIANT, params: [variantId, productId, sku, now, now] },
      audit.statement,
    ]);
  } catch (error) {
    const notice = constraintNotice(error);
    if (notice) return refuse(notice);
    console.error("[admin-pieces] the piece could not be started:", error);
    return refuse("unavailable");
  }

  const piece = await readPiece(db, sku);
  if (piece === null) return refuse("unavailable");
  return { ok: true, notice: "created", value: piece };
}

/* -------------------------------------------------------------------------
 * Weight and purity
 * ---------------------------------------------------------------------- */

const UPDATE_WEIGHT = `
  UPDATE variants
     SET net_metal_weight_mg = ?, gross_weight_mg = ?, fineness = ?, updated_at = ?
   WHERE id = ?`;

const TOUCH_PRODUCT = `UPDATE products SET updated_at = ? WHERE id = ?`;

export type SaveWeightInput = {
  readonly piece: AdminPiece;
  readonly netMetalWeightMg: number | null;
  readonly grossWeightMg: number | null;
  readonly fineness: number | null;
  readonly actor: AdminActor;
  readonly nowMs?: number;
};

export async function saveWeight(
  db: CartDb,
  input: SaveWeightInput
): Promise<WriteOutcome<AdminPiece>> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const { piece } = input;

  if (input.fineness !== null && !isFineness(input.fineness)) return refuse("bad-purity");

  // Clearing a weight out from under a piece that is PRICED by weight would put
  // the row on the wrong side of `variants_pricing_inputs_ck`. The database
  // would refuse it; this refuses it first, and names the way out.
  const notice = pricingNotice({
    pricingMode: piece.pricingMode,
    netMetalWeightMg: input.netMetalWeightMg,
    fineness: input.fineness,
    fixedPricePaise: piece.fixedPricePaise,
  });
  if (notice) return refuse(notice);

  const audit = auditFor({
    actor: input.actor,
    action: AUDIT_ACTIONS.weight,
    entityType: "variant",
    entityId: piece.variantId,
    before: {
      fineness: piece.fineness,
      net_metal_weight_mg: piece.netMetalWeightMg,
      gross_weight_mg: piece.grossWeightMg,
    },
    // `fineness` is allowlisted and carries its value. Neither weight is, so
    // both record as "changed" — enough to prove a weight moved, carrying no
    // figure that could be read back out of the log.
    after: {
      fineness: input.fineness,
      net_metal_weight_mg: input.netMetalWeightMg,
      gross_weight_mg: input.grossWeightMg,
    },
    nowMs,
  });

  try {
    await db.batch([
      {
        sql: UPDATE_WEIGHT,
        params: [
          input.netMetalWeightMg,
          input.grossWeightMg,
          input.fineness,
          now,
          piece.variantId,
        ] satisfies SqlValue[],
      },
      { sql: TOUCH_PRODUCT, params: [now, piece.productId] },
      audit.statement,
    ]);
  } catch (error) {
    const constraint = constraintNotice(error);
    if (constraint) return refuse(constraint);
    console.error("[admin-pieces] the weight could not be saved:", error);
    return refuse("unavailable");
  }

  const saved = await readPiece(db, piece.sku);
  return saved === null
    ? refuse("unavailable")
    : { ok: true, notice: "weight-saved", value: saved };
}

/* -------------------------------------------------------------------------
 * Price
 * ---------------------------------------------------------------------- */

/**
 * TWO PRICING WRITES, BECAUSE STOCK IS NOT A PRICING FIELD.
 *
 * `stock_quantity` is mutated by exactly three things: an order decrements it,
 * a cancellation increments it, and this form sets it absolutely from a value
 * the browser has been holding since the page loaded. The third is the odd one
 * out, and it is how a sold piece came back:
 *
 *   14:00  the owner opens a piece. The form renders stock = 1.
 *   14:02  a customer orders it. The order decrements stock to 0.
 *   14:05  the owner fixes a typo in the stone value and saves.
 *          stock_quantity is written back to 1.
 *
 * The piece is on sale again with a live order against it, and the next buyer's
 * decrement passes `variants_stock_non_negative_ck` cleanly, so the oversell
 * backstop never fires and one physical piece sells twice.
 *
 * The fix is not to guard the write. It is to NOT MAKE IT. Fixing a typo is not
 * a statement about stock, so when the owner has not touched the field the
 * column is left out of the UPDATE entirely and the race cannot exist.
 *
 * When the owner HAS changed it, `..._SET_STOCK` applies the change only if the
 * row still reads what the form displayed. D1 has no interactive transactions,
 * so this compare-and-swap is the available primitive: it matches nothing when
 * the row moved, and the caller detects that by re-reading rather than by
 * trusting a rowcount.
 *
 * NOTE the earlier attempt at this, which was wrong in an instructive way: it
 * compared against a FRESH read of the row taken at save time. That is the same
 * value on both sides of the comparison, so it agreed every time and guarded
 * nothing. The token has to be what the FORM SAW.
 */
const UPDATE_PRICING = `
  UPDATE variants
     SET pricing_mode = ?, making_charge_type = ?, making_charge_value = ?,
         stone_value_paise = ?, other_charges_paise = ?, fixed_price_paise = ?,
         is_unique_piece = ?, updated_at = ?
   WHERE id = ?`;

const UPDATE_PRICING_SET_STOCK = `
  UPDATE variants
     SET pricing_mode = ?, making_charge_type = ?, making_charge_value = ?,
         stone_value_paise = ?, other_charges_paise = ?, fixed_price_paise = ?,
         is_unique_piece = ?, stock_quantity = ?, updated_at = ?
   WHERE id = ? AND stock_quantity = ?`;

const UPDATE_SALE_MODE = `UPDATE products SET sale_mode = ?, updated_at = ? WHERE id = ?`;

export type SavePricingInput = {
  /**
   * The stock the FORM WAS RENDERED WITH, or null when the caller did not send
   * it. This is the optimistic-concurrency token, and it is the whole mechanism:
   * `stockQuantity` is what the owner wants, this is what they were looking at
   * when they decided. Null falls back to the old unguarded behaviour, which is
   * why `tests/admin-pieces.test.mjs` asserts the real form ships it.
   */
  renderedStockQuantity?: number | null;
  readonly piece: AdminPiece;
  readonly pricingMode: PricingMode;
  readonly makingChargeType: MakingChargeType | null;
  readonly makingChargeValue: number | null;
  readonly stoneValuePaise: number;
  readonly otherChargesPaise: number;
  readonly fixedPricePaise: number | null;
  readonly isUniquePiece: boolean;
  readonly stockQuantity: number;
  readonly saleMode: SaleMode;
  readonly actor: AdminActor;
  readonly nowMs?: number;
};

export async function savePricing(
  db: CartDb,
  input: SavePricingInput
): Promise<WriteOutcome<AdminPiece>> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const { piece } = input;

  // The pricing contract, in the owner's words, before the database sees it.
  const notice = pricingNotice({
    pricingMode: input.pricingMode,
    netMetalWeightMg: piece.netMetalWeightMg,
    fineness: piece.fineness,
    fixedPricePaise: input.fixedPricePaise,
  });
  if (notice) return refuse(notice);

  const stock = stockNotice({
    isUniquePiece: input.isUniquePiece,
    stockQuantity: input.stockQuantity,
  });
  if (stock) return refuse(stock);

  if (input.stoneValuePaise < 0 || input.otherChargesPaise < 0) return refuse("negative-money");

  // A piece nobody can put a figure on cannot be bought online, whatever the
  // control says — refused here rather than sending a customer to a checkout
  // that would throw.
  if (input.saleMode === "buy_online" && input.pricingMode === "on_request") {
    return refuse("online-on-request");
  }

  // Making-charge inputs travel only with the mode they belong to. THIS IS THE
  // NO-JAVASCRIPT GUARANTEE: a browser with no script cannot hide the two
  // unselected inputs, so the SERVER reads only the fields the chosen mode uses
  // and drops the rest. A `disabled` attribute would be a client-side promise;
  // this is a server-side one, and it cannot be edited out of the markup.
  const dynamic = input.pricingMode === "dynamic_metal";
  const makingType = dynamic ? input.makingChargeType : null;
  const makingValue = dynamic && makingType !== null ? input.makingChargeValue : null;
  const fixedPrice = input.pricingMode === "fixed" ? input.fixedPricePaise : null;

  const audit = auditFor({
    actor: input.actor,
    action: AUDIT_ACTIONS.pricing,
    entityType: "variant",
    entityId: piece.variantId,
    before: {
      pricing_mode: piece.pricingMode,
      making_charge_type: piece.makingChargeType,
      making_charge_value: piece.makingChargeValue,
      stone_value_paise: piece.stoneValuePaise,
      other_charges_paise: piece.otherChargesPaise,
      fixed_price_paise: piece.fixedPricePaise,
      is_unique_piece: piece.isUniquePiece,
      stock_quantity: piece.stockQuantity,
    },
    after: {
      pricing_mode: input.pricingMode,
      making_charge_type: makingType,
      // Every money figure below is off the allowlist and records as "changed".
      making_charge_value: makingValue,
      stone_value_paise: input.stoneValuePaise,
      other_charges_paise: input.otherChargesPaise,
      fixed_price_paise: fixedPrice,
      is_unique_piece: input.isUniquePiece,
      stock_quantity: input.stockQuantity,
    },
    nowMs,
  });

  /**
   * DID THE OWNER ACTUALLY CHANGE THE STOCK?
   *
   * `rendered` is what the form displayed. If the submitted figure matches it,
   * the owner did not touch the field, this save is about price, and the column
   * is left out of the UPDATE entirely -- so a typo fix cannot resurrect a
   * piece that sold while the page was open.
   *
   * If it differs, the change is deliberate and is applied as a compare-and-swap
   * against what the form saw. Without a token (a caller that does not send one)
   * the behaviour is exactly as it was before, which is why the rendered form is
   * asserted to ship it.
   */
  const rendered = input.renderedStockQuantity ?? null;
  const stockChanged = rendered !== null && input.stockQuantity !== rendered;
  const guarded = rendered !== null;

  const pricingStatement: CartStatement = guarded
    ? stockChanged
      ? {
          sql: UPDATE_PRICING_SET_STOCK,
          params: [
            input.pricingMode,
            makingType,
            makingValue,
            input.stoneValuePaise,
            input.otherChargesPaise,
            fixedPrice,
            input.isUniquePiece ? 1 : 0,
            input.stockQuantity,
            now,
            piece.variantId,
            rendered,
          ] satisfies SqlValue[],
        }
      : {
          sql: UPDATE_PRICING,
          params: [
            input.pricingMode,
            makingType,
            makingValue,
            input.stoneValuePaise,
            input.otherChargesPaise,
            fixedPrice,
            input.isUniquePiece ? 1 : 0,
            now,
            piece.variantId,
          ] satisfies SqlValue[],
        }
    : {
        // No token: the pre-existing unguarded write, unchanged.
        sql: UPDATE_PRICING_SET_STOCK.replace(" AND stock_quantity = ?", ""),
        params: [
          input.pricingMode,
          makingType,
          makingValue,
          input.stoneValuePaise,
          input.otherChargesPaise,
          fixedPrice,
          input.isUniquePiece ? 1 : 0,
          input.stockQuantity,
          now,
          piece.variantId,
        ] satisfies SqlValue[],
      };

  try {
    await db.batch([
      pricingStatement,
      { sql: UPDATE_SALE_MODE, params: [input.saleMode, now, piece.productId] },
      audit.statement,
    ]);
  } catch (error) {
    const constraint = constraintNotice(error);
    if (constraint) return refuse(constraint);
    console.error("[admin-pieces] the price could not be saved:", error);
    return refuse("unavailable");
  }

  const saved = await readPiece(db, piece.sku);
  if (saved === null) return refuse("unavailable");

  // A compare-and-swap that matched nothing changes zero rows and throws
  // nothing, so the batch above reports success either way. The only honest
  // check is to read the row back: if a deliberate stock change did not land,
  // the piece moved while the form was open and saying "saved" would be the
  // worse of the two failures.
  if (guarded && stockChanged && saved.stockQuantity !== input.stockQuantity) {
    console.warn(
      `[admin-pieces] ${piece.sku}: stock was ${rendered} when the form was drawn ` +
        `and is ${saved.stockQuantity} now, so the change was not applied.`
    );
    return refuse("stock-moved");
  }

  return { ok: true, notice: "price-saved", value: saved };
}

/* -------------------------------------------------------------------------
 * Hallmark and certificate — the honesty rule, enforced
 * ---------------------------------------------------------------------- */

const UPDATE_HALLMARK = `
  UPDATE variants
     SET huid = ?, hallmark_purity_mark = ?, certificate_number = ?, certificate_lab = ?,
         hallmarking_paise = ?, updated_at = ?
   WHERE id = ?`;

/**
 * The three true things an owner can say about a hallmark. There is no fourth,
 * and none of them produces a number.
 *
 *   exempt        Kundan / Polki / Jadau, QCO cl. 2(3). No charge, no number,
 *                 and the absence is not a gap. Publishable.
 *   recorded      It carries a hallmark and here is the number, as read off the
 *                 piece. Publishable.
 *   not_to_hand   It carries a hallmark and the number is not here. Honest,
 *                 common, and it keeps the piece off the website until the
 *                 number turns up. This is the state research/05 §7 says must
 *                 exist, and it is what stops the other two being answered
 *                 falsely just to get past a form.
 */
export type HallmarkAnswer = "exempt" | "recorded" | "not_to_hand";

export function isHallmarkAnswer(value: string): value is HallmarkAnswer {
  return value === "exempt" || value === "recorded" || value === "not_to_hand";
}

/** BIS's published per-article charge for gold, Jan 2024 guidelines cl. 3.3.5. */
export const BIS_GOLD_HALLMARKING_PAISE = 4500;

export type SaveHallmarkInput = {
  readonly piece: AdminPiece;
  readonly answer: HallmarkAnswer;
  /** Exactly what the owner typed, or null. NEVER derived from anything. */
  readonly huid: string | null;
  readonly hallmarkPurityMark: string | null;
  readonly certificateNumber: string | null;
  readonly certificateLab: string | null;
  readonly hallmarkingPaise: number | null;
  readonly actor: AdminActor;
  readonly nowMs?: number;
};

export async function saveHallmark(
  db: CartDb,
  input: SaveHallmarkInput
): Promise<WriteOutcome<AdminPiece>> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const { piece } = input;

  // The one place a refusal is right: the owner said there is a number and did
  // not give one. Inventing, defaulting or deriving one is not an option that
  // exists anywhere in this module — there is no expression here that produces
  // a HUID, and there must never be.
  if (input.answer === "recorded" && input.huid === null) return refuse("needs-huid");

  const exempt = input.answer === "exempt";
  const charge = exempt
    ? 0
    : (input.hallmarkingPaise ??
      (piece.hallmarkingPaise > 0 ? piece.hallmarkingPaise : BIS_GOLD_HALLMARKING_PAISE));

  if (charge < 0) return refuse("negative-money");

  // An exempt piece carries no number, and saying so must actually clear one
  // recorded earlier — otherwise the two facts on the row disagree and the bill
  // prints a number beside "exempt from hallmarking".
  const huid = exempt ? null : input.answer === "recorded" ? input.huid : null;

  const audit = auditFor({
    actor: input.actor,
    action: AUDIT_ACTIONS.hallmark,
    entityType: "variant",
    entityId: piece.variantId,
    before: {
      huid: piece.huid,
      hallmark_purity_mark: piece.hallmarkPurityMark,
      certificate_number: piece.certificateNumber,
      certificate_lab: piece.certificateLab,
      hallmarking_paise: piece.hallmarkingPaise,
    },
    // NONE of these is on the variant allowlist, so every one records as
    // "changed". A HUID is a government-issued identifier for a physical object,
    // the audit table is outside the erasure job's reach, and it holds no copy.
    after: {
      huid,
      hallmark_purity_mark: input.hallmarkPurityMark,
      certificate_number: input.certificateNumber,
      certificate_lab: input.certificateLab,
      hallmarking_paise: charge,
    },
    nowMs,
  });

  try {
    await db.batch([
      {
        sql: UPDATE_HALLMARK,
        params: [
          huid,
          input.hallmarkPurityMark,
          input.certificateNumber,
          input.certificateLab,
          charge,
          now,
          piece.variantId,
        ] satisfies SqlValue[],
      },
      { sql: TOUCH_PRODUCT, params: [now, piece.productId] },
      audit.statement,
    ]);
  } catch (error) {
    const constraint = constraintNotice(error);
    if (constraint) return refuse(constraint);
    console.error("[admin-pieces] the hallmark answer could not be saved:", error);
    return refuse("unavailable");
  }

  const saved = await readPiece(db, piece.sku);
  return saved === null
    ? refuse("unavailable")
    : { ok: true, notice: "hallmark-saved", value: saved };
}

/* -------------------------------------------------------------------------
 * Status — on the website, off it, put away
 * ---------------------------------------------------------------------- */

/**
 * THE DATABASE REFUSES AN UNANSWERED HALLMARK, NOT A WHERE CLAUSE.
 *
 * The CASE is evaluated against the row as it stands. A product whose variant
 * raised a hallmarking charge and carries no number writes NULL into
 * `products.status`, which is NOT NULL, so the statement raises and ABORTS THE
 * WHOLE BATCH — taking the audit row with it, and leaving nothing on the record
 * that says the piece was published.
 *
 * Written as `WHERE ... AND hallmarking...` instead, an ineligible piece would
 * be a silent no-op: nothing changed, no error, and a redirect saying it worked.
 * This is the shape `cancelOrder()` and the order-status endpoint both use, for
 * exactly the same reason.
 */
const PUBLISH_PIECE = `
  UPDATE products
     SET status = CASE
           WHEN EXISTS (
             SELECT 1 FROM variants v
              WHERE v.product_id = products.id
                AND (v.hallmarking_paise = 0 OR v.huid IS NOT NULL)
           ) THEN 'active' ELSE NULL
         END,
         updated_at = ?
   WHERE id = ?`;

const SET_STATUS = `UPDATE products SET status = ?, updated_at = ? WHERE id = ?`;

export type StatusIntent = "publish" | "unpublish" | "put_away" | "bring_back";

export const STATUS_INTENTS: Readonly<
  Record<
    StatusIntent,
    { readonly to: PieceStatus; readonly label: string; readonly notice: PieceNotice }
  >
> = {
  publish: { to: "active", label: "Put this piece on the website", notice: "published" },
  unpublish: { to: "draft", label: "Take it off the website", notice: "taken-off" },
  put_away: { to: "archived", label: "Put this piece away", notice: "put-away" },
  bring_back: { to: "draft", label: "Bring it back", notice: "brought-back" },
};

export function isStatusIntent(value: string): value is StatusIntent {
  return Object.prototype.hasOwnProperty.call(STATUS_INTENTS, value);
}

export async function setPieceStatus(
  db: CartDb,
  input: {
    readonly piece: AdminPiece;
    readonly intent: StatusIntent;
    readonly actor: AdminActor;
    readonly nowMs?: number;
  }
): Promise<WriteOutcome<AdminPiece>> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const { piece } = input;
  const action = STATUS_INTENTS[input.intent];

  if (piece.status === action.to) return refuse("no-change");
  if (input.intent === "publish" && !canPublish(piece)) return refuse("not-publishable");

  const audit = auditFor({
    actor: input.actor,
    action: AUDIT_ACTIONS.status,
    entityType: "product",
    entityId: piece.productId,
    before: { status: piece.status },
    after: { status: action.to },
    nowMs,
  });

  let results;
  try {
    results = await db.batch([
      input.intent === "publish"
        ? { sql: PUBLISH_PIECE, params: [now, piece.productId] }
        : { sql: SET_STATUS, params: [action.to, now, piece.productId] },
      audit.statement,
    ]);
  } catch (error) {
    const constraint = constraintNotice(error);
    if (constraint) return refuse(constraint);
    console.error("[admin-pieces] the piece's status could not be changed:", error);
    return refuse("unavailable");
  }

  if ((results[0]?.changes ?? 0) !== 1) {
    console.error(`[admin-pieces] ${piece.sku}: the status change moved no row, yet it committed.`);
    return refuse("unavailable");
  }

  const saved = await readPiece(db, piece.sku);
  return saved === null ? refuse("unavailable") : { ok: true, notice: action.notice, value: saved };
}
