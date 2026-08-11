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

/** The one supplied fact about a person on this page. */
const NAMED = "Saksham Goel";

/** Language that may only ever describe a placeholder. */
const STAND_IN = /stand-?in|placeholder|not (yet )?been taken|not a photograph of a real person/i;

/**
 * Claims this page has NOT been given: a role, a title, a relationship to the
 * 1980 founding, a date. The shop opened in 1980 and the man in the photograph
 * is plainly much younger, so "founder" is an inference — a likely one, which
 * is exactly why it needs a guard rather than a judgement call.
 */
const UNSUPPLIED_CLAIM =
  /\b(founder|co-?founder|founded|proprietor|owner|owns|runs|director|partner|son|grandson|daughter|father|nephew|heir|successor|since|generation|19\d{2}|20\d{2})\b/i;

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
 * The honesty guard, now per person rather than per page.
 *
 * It used to lean on one site-wide flag, so every portrait was a stand-in and
 * every field was blank together. One real name and one real photograph have
 * arrived while everything around them is still unsupplied, so the page has to
 * hold a real person beside a placeholder without either contaminating the
 * other: the placeholder must still confess, and the real man must not be
 * handed a title to fill the silence where his role should be.
 *
 * Deliberately NOT asserted: that he is the founder, the son of the founder,
 * or anything else. Nobody told us, and the guard's job is to keep it that way.
 */
test("names the one person it was given, and claims nothing else about him", async () => {
  const body = await html();
  const text = visibleText(body);

  // The supplied fact must actually be live — hiding it would be its own
  // failure, the same way an unpublished verified phone number was.
  assert.ok(text.includes(NAMED), "the supplied name must appear in the rendered page");

  // His photograph is real, so none of the stand-in language may attach to it.
  const realAlt = altFor(body, "founder-saksham-goel");
  assert.doesNotMatch(realAlt, STAND_IN, `a real photograph described as a placeholder: ${realAlt}`);
  assert.doesNotMatch(realAlt, UNSUPPLIED_CLAIM, `alt text asserts an unsupplied claim: ${realAlt}`);

  // The caption beside it carries the name and nothing appended to it.
  assert.equal(
    captionFor(body, "founder-saksham-goel"),
    NAMED,
    "his caption must be his name alone — no title, relationship or date"
  );

  // Nowhere on the page may a claim sit in the same sentence as his name.
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const sentence of sentences) {
    if (!sentence.includes(NAMED)) continue;
    assert.doesNotMatch(
      sentence,
      UNSUPPLIED_CLAIM,
      `an unsupplied claim is attached to his name: ${sentence}`
    );
  }

  // What is genuinely unknown about him stays visibly unanswered.
  assert.ok(text.includes("a verb, not a job title"), "his role must still read as pending");
  assert.ok(text.includes("counter, bench or both"), "his whereabouts must still read as pending");
});

test("keeps the unsupplied second portrait marked as a placeholder", async () => {
  const body = await html();

  // Nothing about the second mount was supplied — not a name, not a picture.
  const placeholderAlt = altFor(body, "founder-portrait-b");
  assert.match(
    placeholderAlt,
    STAND_IN,
    `an unsupplied portrait must say so in its alt text: ${placeholderAlt}`
  );
  assert.match(
    captionFor(body, "founder-portrait-b"),
    STAND_IN,
    "an unsupplied portrait must say so in its caption"
  );

  // The stand-in disclaimer must be worn by the placeholder alone. Two would
  // mean it had spread back onto the real photograph. Counted over rendered
  // text rather than raw HTML: client-component props are also serialised into
  // the RSC flight payload, so every caption appears twice in the source.
  const disclaimers = visibleText(body).match(/Not a photograph of a real person/g) ?? [];
  assert.equal(disclaimers.length, 1, "exactly one portrait on this page is a stand-in");
});

test("invents no dates", async () => {
  const body = await html();

  // 1980 is the one date this business can evidence. Nothing else numeric
  // should be asserted as history -- and a named person is not a licence to
  // start dating anything.
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
