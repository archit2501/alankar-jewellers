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

test("invents no biographical facts while details are pending", async () => {
  const body = await html();

  // The two portraits are AI-generated stand-ins. Until real people are
  // supplied, the page may carry structure but must not carry a fabricated
  // life story -- and it must say so rather than quietly implying the images
  // depict the actual proprietors.
  if (body.includes("pending") || body.includes("Pending")) {
    assert.match(
      body,
      /stand-?in|not (yet )?been taken|placeholder|pending/i,
      "pending state must be visible to the reader"
    );
  }

  // 1980 is the one date this business can evidence. Nothing else numeric
  // should be asserted as history.
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
