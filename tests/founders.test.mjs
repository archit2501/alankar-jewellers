import assert from "node:assert/strict";
import test from "node:test";

import { renderPage } from "./helpers.mjs";

let cached;
async function html() {
  cached ??= await renderPage("/founders");
  return cached;
}

test("serves the founders page", async () => {
  const response = await renderPage("/founders", { raw: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
});

test("is reachable from the homepage", async () => {
  const home = await renderPage("/");
  assert.match(home, /href="\/founders"/, "homepage must link to /founders");
});

test("appears in the sitemap", async () => {
  const sitemap = await renderPage("/sitemap.xml", { raw: true });
  assert.match(await sitemap.text(), /<loc>https:\/\/[^<]*\/founders<\/loc>/);
});

/** The one person on this page. */
const NAMED = "Saksham Goel";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE CLAIM GUARD, AND WHY IT IS SHAPED LIKE THIS
 *
 * Until 2026-08-12 nothing was known about him but his name, so the guard was
 * blunt: no sentence containing his name could contain any word out of a claim
 * vocabulary. Three facts then arrived, and two of the blocked words became
 * true — but ONLY in the exact width the shop gave them:
 *
 *   1. he is the third generation OF THE FAMILY BUSINESS
 *   2. he oversees everything — all of the operations
 *   3. there is no second person
 *
 * The word "generation" is now allowed. The claim "third generation" is what
 * was supplied; "second generation", "fourth generation", "the generation
 * that opened the shop" and a bare "generation" were not. Likewise "oversees
 * everything" is supplied and "oversees the bench" is invention with a true
 * word in it. So the guard does not un-block words — it whitelists PHRASES and
 * keeps blocking the words outside them:
 *
 *   Rule A  the word "generation" may appear only inside "third generation"
 *   Rule B  "oversee*" only inside "oversees everything" /
 *           "oversees all of the operations"
 *   Rule C  "family" only inside "family business"
 *   Rule D  a vocabulary that is never true on this page — founder, founded,
 *           proprietor, owner, and every word for a relative — may not appear
 *           anywhere in the rendered text at all
 *   Rule E  in any sentence ABOUT HIM (his name, or a pronoun, or one of the
 *           confirmed phrases), once the confirmed phrases are struck out,
 *           nothing may remain that dates him, ages him or hands him the shop
 *
 * Rule E is scoped rather than page-wide because the shop legitimately says
 * "since 1980" in its own wordmark and colophon. Rules A–D are page-wide
 * precisely because a pronoun is enough to make a claim about him — "his
 * grandfather opened the shop in 1980" never mentions his name and is exactly
 * the sentence this file exists to stop.
 *
 * The property mutation-tested on the previous version of this guard still
 * holds: "Saksham Goel — founder since 1980" is invisible to a plain year
 * check, because 1980 is the one year the business can evidence. It is the
 * vocabulary that catches it, which is why the vocabulary is here.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** The confirmed phrases — the only reason those words are on the page. */
const CONFIRMED = [
  /third generation/gi,
  /family business/gi,
  /oversees everything/gi,
  /oversees all of the operations/gi,
  /no second person/gi,
];

/** Rule A / B / C: word, and the phrases that are allowed to contain it. */
const WORD_STATUS = [
  { word: /\bgenerations?\b/gi, allowed: [/third generation/gi] },
  {
    word: /\boversee\w*\b/gi,
    allowed: [/oversees everything/gi, /oversees all of the operations/gi],
  },
  { word: /\bfamil(y|ies)\b/gi, allowed: [/family business/gi] },
];

/** Rule D: words that can never be true of this page, wherever they appear. */
const NEVER =
  /\b(co-?founders?|founders?|founded|founding|proprietors?|owners?|owns|runs|ran|directors?|partners?|heirs?|successors?|succeeded|inherit\w*|took over|taken over|sons?|grandsons?|daughters?|granddaughters?|fathers?|grandfathers?|mothers?|grandmothers?|uncles?|aunts?|nephews?|nieces?|brothers?|sisters?|widows?)\b/i;

/** Rule E: what may not survive in a sentence that is about him. */
const UNSUPPLIED_CLAIM =
  /\b(since|19\d{2}|20\d{2}|decades?|century|centuries|generations?|oversee\w*|famil(y|ies)|joined|start(ed)? (the|this)|open(ed)? (the|this))\b|\b\d{1,3}[- ]?(year|yr)s?\b/i;

/** Language that may only ever describe a placeholder — and now, nothing. */
const STAND_IN = /stand-?in|placeholder|not (yet )?been taken|not a photograph of a real person/i;

/** Rendered text only: markup, script and style stripped, whitespace collapsed. */
function visibleText(body) {
  return body
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&rsquo;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
}

/** Blank out every confirmed phrase, preserving offsets so context still lines up. */
function strikeConfirmed(text, phrases = CONFIRMED) {
  let masked = text;
  for (const phrase of phrases) {
    masked = masked.replace(new RegExp(phrase.source, "gi"), (match) => "·".repeat(match.length));
  }
  return masked;
}

/** A readable excerpt around a hit, for failure messages. */
function around(text, index) {
  return text.slice(Math.max(0, index - 70), index + 70);
}

/** Does this sentence make a claim about him? A pronoun is enough. */
function isAboutHim(sentence) {
  if (sentence.includes(NAMED)) return true;
  if (/\b(he|him|his)\b/i.test(sentence)) return true;
  return CONFIRMED.some((phrase) => new RegExp(phrase.source, "i").test(sentence));
}

/** The `<img>` whose source is the named asset — the face, not the reverse. */
function imgFor(body, assetKey) {
  const tag = (body.match(/<img\b[^>]*>/g) ?? []).find((t) => t.includes(`/${assetKey}-`));
  assert.ok(tag, `no <img> rendered for ${assetKey}`);
  return tag;
}

function altFor(body, assetKey) {
  const match = imgFor(body, assetKey).match(/\balt="([^"]*)"/);
  assert.ok(match, `no alt text on the ${assetKey} image`);
  return match[1];
}

/** The caption printed under a portrait. */
function captionFor(body, assetKey) {
  const from = body.indexOf(assetKey);
  assert.notEqual(from, -1, `${assetKey} does not appear in the page`);
  const match = body
    .slice(from)
    .match(/<figcaption class="flip__caption">([\s\S]*?)<\/figcaption>/);
  assert.ok(match, `no caption under ${assetKey}`);
  return visibleText(match[1]);
}

/**
 * A fact that is known and not published is its own kind of dishonesty — the
 * same failure as an unpublished verified phone number. All three confirmed
 * facts must actually be live, and at the width they were given: the ordinal
 * is printed against the scope it belongs to ("in the family business"), never
 * loose beside the shop's 1980 opening.
 */
test("publishes all three confirmed facts, at the width they were given", async () => {
  const body = await html();
  const text = visibleText(body);

  assert.ok(text.includes(NAMED), "the supplied name must appear in the rendered page");
  assert.ok(
    /In the family business\s*The third generation\./i.test(text),
    "the ordinal must be printed against the scope it was given: in the family business"
  );
  assert.ok(
    /Oversees everything\b/.test(text),
    "what he does must be published as the verb the shop gave"
  );
  assert.ok(
    /There is no second person/i.test(text),
    "the page must say there is no second person — it is why there is one portrait"
  );

  // Part E's caption grammar, finally available: the name, then the verb.
  assert.equal(
    captionFor(body, "founder-saksham-goel"),
    `${NAMED} — oversees everything.`,
    "his caption must be the name and the supplied verb — no title, relationship or date"
  );

  // What is genuinely still unknown stays visibly unanswered.
  assert.ok(text.includes("counter, bench or both"), "his whereabouts must still read as pending");
  assert.ok(
    /In his own words/i.test(text) && /We have not recorded it yet/i.test(text),
    "his own words must still read as unrecorded"
  );
});

test("claims nothing about him that the shop did not supply", async () => {
  const body = await html();
  const text = visibleText(body);

  // Rules A / B / C — a true word is not a licence to use it loosely.
  for (const { word, allowed } of WORD_STATUS) {
    const masked = strikeConfirmed(text, allowed);
    const stray = [...masked.matchAll(new RegExp(word.source, "gi"))];
    assert.deepEqual(
      stray.map((hit) => around(text, hit.index)),
      [],
      `"${stray[0]?.[0]}" is only confirmed inside ${allowed.map((a) => a.source).join(" / ")}`
    );
  }

  // Rule D — never true of this page, wherever it appears.
  assert.doesNotMatch(text, NEVER, "the page uses a word it was never given");

  // Rule E — every sentence about him, with the confirmed phrases struck out.
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    if (!isAboutHim(sentence)) continue;
    assert.doesNotMatch(
      strikeConfirmed(sentence),
      UNSUPPLIED_CLAIM,
      `an unsupplied claim is attached to him: ${sentence}`
    );
  }

  // The alt text describes the photograph and nothing about the sitter.
  const alt = altFor(body, "founder-saksham-goel");
  assert.doesNotMatch(alt, STAND_IN, `a real photograph described as a placeholder: ${alt}`);
  assert.doesNotMatch(strikeConfirmed(alt), UNSUPPLIED_CLAIM, `alt text asserts a claim: ${alt}`);
  assert.doesNotMatch(alt, NEVER, `alt text asserts a claim: ${alt}`);
});

/**
 * There is no second person, so there is no second mount and no stand-in for
 * one. This used to assert that the placeholder disclaimer appeared EXACTLY
 * ONCE — that it had not spread onto the real photograph. With the mount taken
 * off the wall the assertion gets to be stronger: the stand-in vocabulary
 * appears nowhere at all, in the copy or in any alt text, and no second
 * portrait is rendered to need it.
 */
test("has no second mount, and no stand-in language anywhere", async () => {
  const body = await html();
  const text = visibleText(body);

  assert.doesNotMatch(text, STAND_IN, "stand-in language survives on a page with no stand-in");

  for (const img of body.match(/<img\b[^>]*>/g) ?? []) {
    const alt = img.match(/\balt="([^"]*)"/)?.[1] ?? "";
    assert.doesNotMatch(alt, STAND_IN, `stand-in language in alt text: ${alt}`);
  }

  // The placeholder portraits are simply not referenced. app/_media/images.ts
  // is generated, so they stay in the manifest and go unused.
  for (const unused of ["founder-portrait-a", "founder-portrait-b"]) {
    assert.equal(body.includes(unused), false, `${unused} is still rendered on the page`);
  }

  // Exactly one face on the page.
  const faces = (body.match(/<img\b[^>]*founder-[^>]*>/g) ?? []).filter((tag) =>
    tag.includes("founder-saksham-goel")
  );
  assert.equal(faces.length, 1, "expected exactly one portrait of a person");
});

test("invents no dates", async () => {
  const body = await html();

  // 1980 is the one date this business can evidence. Nothing else numeric
  // should be asserted as history -- and knowing which generation he is does
  // NOT licence dating that generation, or him, or the succession between them.
  const years = [...body.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => m[0]);
  const invented = years.filter((y) => y !== "1980" && y !== String(new Date().getFullYear()));
  assert.deepEqual(invented, [], `page asserts unverified years: ${invented.join(", ")}`);
});

test("declares intrinsic dimensions on every image", async () => {
  const body = await html();
  const imgs = body.match(/<img\b[^>]*>/g) ?? [];
  assert.ok(imgs.length >= 2, `expected at least 2 images, found ${imgs.length}`);

  for (const img of imgs) {
    assert.match(img, /\bwidth="\d+"/, `image without width (causes CLS): ${img}`);
    assert.match(img, /\bheight="\d+"/, `image without height (causes CLS): ${img}`);
  }
});

test("has exactly one h1 and its own metadata", async () => {
  const body = await html();
  assert.equal((body.match(/<h1/g) ?? []).length, 1, "expected exactly one h1");

  const title = body.match(/<title>([^<]*)<\/title>/);
  assert.ok(title, "missing <title>");
  assert.notEqual(
    title[1],
    "Alankar Jewellers | Jadau, Diamond &amp; Polki Since 1980",
    "founders page should not reuse the homepage title verbatim"
  );
});
