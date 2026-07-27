import assert from "node:assert/strict";
import test from "node:test";

import { renderPage } from "./helpers.mjs";

let cached;
async function html() {
  cached ??= await renderPage("/");
  return cached;
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

test("never publishes unverified contact facts", async () => {
  const body = await html();
  const data = structuredData(body);
  const pending = body.includes("Details pending");

  if (pending) {
    // Fabricated LocalBusiness contact data poisons Google Business Profile
    // matching, so while placeholders stand it must be absent entirely -- and
    // the page must not render dead tel:/wa.me links either.
    for (const field of ["telephone", "email", "address", "openingHoursSpecification"]) {
      assert.ok(!(field in data), `${field} must be omitted while details are pending`);
    }
    assert.doesNotMatch(body, /href="tel:/, "no dead tel: link while pending");
    assert.doesNotMatch(body, /href="https:\/\/wa\.me/, "no dead WhatsApp link while pending");
  } else {
    assert.ok(data.telephone, "telephone expected once details are live");
    assert.ok(data.address, "address expected once details are live");
    assert.match(body, /href="tel:/, "live tel: link expected");
  }
});

test("renders the contact section", async () => {
  const body = await html();

  assert.ok(body.includes("Come and see them in person."));
  assert.ok(body.includes("Call or WhatsApp"));
  assert.ok(body.includes("Opening hours"));
  assert.ok(body.includes("Monday – Saturday"));
  assert.match(body, /<address/, "postal address should use <address>");
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
