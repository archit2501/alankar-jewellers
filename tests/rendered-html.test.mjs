import assert from "node:assert/strict";
import test from "node:test";

import { renderPage } from "./helpers.mjs";

const { known, site, formattedAddress, whatsappUrl } = await import("../app/site-config.ts");

let cached;
async function html() {
  cached ??= await renderPage("/");
  return cached;
}

/** React's own attribute escaping, so an expected href can be matched literally. */
function attr(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function structuredData(body) {
  const match = body.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(match, "no JSON-LD block in the rendered HTML");
  return JSON.parse(
    match[1].replace(/\\u003c/g, "<").replace(/\\u003e/g, ">").replace(/\\u0026/g, "&")
  );
}

test("serves the homepage as HTML", async () => {
  const response = await renderPage("/", { raw: true });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
});

test("server-renders every section", async () => {
  const body = await html();

  // The whole page must arrive in the HTML rather than being hydrated in --
  // this is what the server-component split bought us.
  for (const copy of [
    "Jewels that",
    "become heirlooms.",
    "Turn one over.",
    "The part with no audience.",
    "Made slowly.",
    "One date, and no mythology.",
    "A private experience,",
  ]) {
    assert.ok(body.includes(copy), `missing server-rendered copy: ${copy}`);
  }

  assert.equal((body.match(/<h1/g) ?? []).length, 1, "expected exactly one h1");
  assert.doesNotMatch(body, /codex-preview|Building your site|react-loading-skeleton/i);
});

test("emits absolute social URLs so link previews resolve", async () => {
  const body = await html();

  // Regression guard: these were relative, which silently broke the preview
  // image on WhatsApp, Facebook, LinkedIn and X.
  for (const property of ["og:image", "og:url"]) {
    const match = body.match(new RegExp(`<meta property="${property}" content="([^"]+)"`));
    assert.ok(match, `missing ${property}`);
    assert.match(match[1], /^https:\/\//, `${property} must be absolute, got ${match[1]}`);
  }

  const twitterImage = body.match(/<meta name="twitter:image" content="([^"]+)"/);
  assert.ok(twitterImage);
  assert.match(twitterImage[1], /^https:\/\//);

  assert.match(body, /<link rel="canonical" href="https:\/\//);
  // Must match the real dimensions of public/og.png.
  assert.match(body, /<meta property="og:image:width" content="1200"\/>/);
  assert.match(body, /<meta property="og:image:height" content="630"\/>/);
});

test("publishes JewelryStore structured data", async () => {
  const data = structuredData(await html());

  assert.equal(data["@context"], "https://schema.org");
  assert.equal(data["@type"], "JewelryStore");
  assert.equal(data.foundingDate, "1980");
  assert.match(data.url, /^https:\/\//);
  assert.match(data.image, /^https:\/\//);
});

/**
 * The contact-honesty guard, per fact.
 *
 * It used to be all-or-nothing: "if the page says 'Details pending' anywhere,
 * then no tel: and no wa.me link exists". That encoded a model the project has
 * outgrown. The shop supplied a real, verified phone number while its street
 * address was still unknown, so both halves of that implication became true at
 * once and the test could only be satisfied by suppressing a fact we actually
 * have — which is the exact failure the honesty rule exists to prevent.
 *
 * Each fact is now checked on its own, in BOTH directions, and the direction
 * matters as much as the prohibition:
 *
 *   known  -> the fact must be live: a working link on the page AND published
 *             in the JSON-LD. Hiding a verified fact now fails the suite.
 *   unknown-> the fact must be absent from the page, absent from the JSON-LD,
 *             and its placeholder in site-config must not have leaked into the
 *             HTML anywhere.
 *
 * Note what this does NOT do: it cannot tell a true address from a convincing
 * invention, and no test can. What it enforces is the gate — a value only
 * reaches the page or the structured data once someone has flipped its flag in
 * `known` to say the shop supplied it. So filling `site.address` with a
 * plausible-looking street would not make this test pass; it would fail on the
 * leak check, and flipping the flag to silence that is a deliberate, reviewable
 * claim of verification rather than an accident.
 */
test("publishes exactly the contact facts it knows, and no others", async () => {
  const body = await html();
  const data = structuredData(body);

  // Adding a fact to `known` without a guard below must fail loudly rather
  // than sail through an assertion that never runs.
  assert.deepEqual(
    Object.keys(known).sort(),
    ["address", "email", "hours", "maps", "phone", "social", "whatsapp"],
    "a fact was added to `known` in site-config without a guard in this test"
  );

  // --- telephone ---------------------------------------------------------
  if (known.phone) {
    assert.equal(data.telephone, site.phone, "a verified telephone belongs in the JSON-LD");
    assert.ok(
      body.includes(`href="tel:${site.phone}"`),
      "a verified telephone must be a working tel: link, not inert text"
    );
    assert.ok(body.includes(site.phoneDisplay), "the number must also be readable on the page");
  } else {
    assert.ok(!("telephone" in data), "telephone must be omitted while unverified");
    assert.doesNotMatch(body, /href="tel:/, "no dead tel: link while the number is unverified");
    assert.ok(!body.includes(site.phone), "an unverified number must not leak into the HTML");
  }

  // --- WhatsApp ----------------------------------------------------------
  if (known.whatsapp) {
    assert.ok(
      body.includes(`href="${attr(whatsappUrl())}"`),
      "a verified WhatsApp line must be a working wa.me link with the prefilled message"
    );
  } else {
    assert.doesNotMatch(body, /href="https:\/\/wa\.me/, "no dead WhatsApp link while unverified");
  }

  // --- email -------------------------------------------------------------
  if (known.email) {
    assert.equal(data.email, site.email, "a verified email belongs in the JSON-LD");
    assert.ok(body.includes(`href="mailto:${site.email}"`), "a verified email must be linked");
  } else {
    assert.ok(!("email" in data), "email must be omitted while unverified");
    assert.doesNotMatch(body, /href="mailto:/, "no dead mailto: link while unverified");
    assert.ok(!body.includes(site.email), "the placeholder email must not reach the page");
  }

  // --- postal address ----------------------------------------------------
  // The one that would do real damage: a fabricated street address inside
  // LocalBusiness markup poisons Google Business Profile matching.
  if (known.address) {
    assert.ok(data.address, "a verified address belongs in the JSON-LD");
    assert.equal(data.address.streetAddress, site.address.street);
    assert.match(body, /<address/, "a verified postal address should use <address>");
    assert.ok(body.includes(formattedAddress()), "a verified address must be readable on the page");
  } else {
    assert.ok(!("address" in data), "address must be omitted while unverified");
    assert.doesNotMatch(
      body,
      /<address/,
      "no <address> element while the address is unknown — an <address> holding an apology is still machine-readable"
    );
    for (const part of [
      site.address.street,
      site.address.locality,
      site.address.city,
      site.address.region,
      site.address.postalCode,
    ]) {
      assert.ok(!body.includes(part), `unverified address fragment leaked into the page: ${part}`);
    }
    // ...and the gap has to be admitted, not silently omitted.
    assert.ok(body.includes("Details pending"), "an unknown address must be disclosed as pending");
  }

  // --- opening hours -----------------------------------------------------
  // `site.hours` is an assumption the site made, not a statement the shop
  // made. Wrong hours send somebody to a closed shutter.
  if (known.hours) {
    assert.ok(data.openingHoursSpecification, "verified hours belong in the JSON-LD");
    assert.ok(body.includes(site.hours[0].time), "verified hours must be readable on the page");
  } else {
    assert.ok(!("openingHoursSpecification" in data), "hours must be omitted while assumed");
    for (const entry of site.hours) {
      assert.ok(!body.includes(entry.days), `assumed opening days leaked: ${entry.days}`);
      assert.ok(!body.includes(entry.time), `assumed opening time leaked: ${entry.time}`);
    }
  }

  // --- map and socials ---------------------------------------------------
  if (!known.maps) {
    assert.ok(!("hasMap" in data), "hasMap must be omitted while the map link is unknown");
  }
  if (!known.social) {
    assert.ok(!("sameAs" in data), "sameAs must be omitted while no profile is confirmed");
  }
});

test("renders the contact section", async () => {
  const body = await html();

  assert.ok(body.includes("Come and see them in person."));
  assert.ok(body.includes("Call or WhatsApp"));
  assert.ok(body.includes("The salon"));
  // The heading stays whether or not the hours behind it are confirmed; what
  // changes is whether real times sit under it. That split is asserted above.
  assert.ok(body.includes("Opening hours"));
});

test("every image declares intrinsic dimensions", async () => {
  const body = await html();
  const imgs = body.match(/<img\b[^>]*>/g) ?? [];
  assert.ok(imgs.length >= 6, `expected at least 6 images, found ${imgs.length}`);

  for (const img of imgs) {
    assert.match(img, /\bwidth="\d+"/, `image without width (causes CLS): ${img}`);
    assert.match(img, /\bheight="\d+"/, `image without height (causes CLS): ${img}`);
    assert.match(img, /\balt="/, `image without alt text: ${img}`);
  }

  // Exactly one image — the LCP hero — may be eager. Everything below the fold
  // must be lazy, or the catalogue costs the visitor megabytes on first paint.
  const eager = imgs.filter((tag) => !/loading="lazy"/.test(tag));
  assert.equal(eager.length, 1, `expected exactly 1 eager image, found ${eager.length}`);
  assert.match(eager[0], /fetchPriority="high"/, "the LCP image should be high priority");
});

test("collection links point at real anchors", async () => {
  const body = await html();

  // Previously all three footer links pointed at the same #collections anchor.
  for (const id of ["jadau", "polki", "chandbali", "kada", "tikka"]) {
    assert.match(body, new RegExp(`id="${id}"`), `missing anchor target #${id}`);
    assert.match(body, new RegExp(`href="#${id}"`), `missing link to #${id}`);
  }

  for (const id of ["top", "collections", "reverse", "legacy", "craft", "visit"]) {
    assert.match(body, new RegExp(`id="${id}"`), `missing section #${id}`);
  }
});

test("exposes navigation and honest calls to action", async () => {
  const body = await html();

  assert.match(body, /Book an Appointment/);
  assert.match(body, /id="site-navigation"/);
  assert.match(body, /aria-controls="site-navigation"/);
  // The card CTA must describe what it actually does (it opens the enquiry
  // dialog; it does not navigate to a collection page). React emits a `<!-- -->`
  // separator between literal text and an interpolated value.
  assert.match(body, /Enquire about (<!-- -->)?Jadau/);
});

test("serves robots.txt and sitemap.xml with absolute URLs", async () => {
  const robots = await renderPage("/robots.txt", { raw: true });
  assert.equal(robots.status, 200);
  const robotsBody = await robots.text();
  assert.match(robotsBody, /Sitemap: https:\/\//);
  assert.match(robotsBody, /Disallow: \/api\//);

  const sitemap = await renderPage("/sitemap.xml", { raw: true });
  assert.equal(sitemap.status, 200);
  assert.match(await sitemap.text(), /<loc>https:\/\/[^<]+<\/loc>/);
});
