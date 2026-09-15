/**
 * Two accessibility defects found by reading rendered HTML, held in place.
 *
 * 1. The homepage wrapped its site header AND its footer inside <main>. Every
 *    other page puts them outside, which is what screen readers rely on to jump
 *    past navigation straight to the content.
 * 2. The founders strip scrolls sideways but held nothing focusable, so it
 *    could not be scrolled from a keyboard at all.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { renderPage } from "./helpers.mjs";

test("every storefront page has one main, with the site header and footer outside it", async () => {
  for (const path of ["/", "/shop", "/shop/meenakari-bridal-choker", "/cart", "/founders", "/privacy"]) {
    const body = await renderPage(path);
    const mains = (body.match(/<main\b/g) ?? []).length;
    assert.equal(mains, 1, `${path} has ${mains} main elements`);

    const inside = body.slice(body.indexOf("<main"), body.indexOf("</main>"));
    assert.doesNotMatch(inside, /<header class="site-header/, `${path} nests the site header inside main`);
    assert.doesNotMatch(inside, /<footer\b/, `${path} nests a footer inside main`);
  }
});

test("the founders strip can be scrolled from the keyboard", async () => {
  const body = await renderPage("/founders");
  const tag = body.match(/<ul[^>]*class="f-strip__list"[^>]*>/);
  assert.ok(tag, "no founders strip on the page");
  assert.match(tag[0], /tabindex="0"/, "the strip is not a tab stop");
  assert.match(tag[0], /aria-label="[^"]+"/, "the strip has no accessible name");
});
