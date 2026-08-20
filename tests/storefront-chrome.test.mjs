/**
 * THREE THINGS AN AUDIT FOUND THAT NOTHING WAS HOLDING IN PLACE.
 *
 * ---------------------------------------------------------------------------
 * 1. THE CART WAS UNREACHABLE
 * ---------------------------------------------------------------------------
 * Six storefront routes carried six hand-copied headers, and only two of them
 * ever served an `href="/cart"`: the cart itself and checkout. A visitor who
 * added a piece to the bag from the homepage, the catalogue or a product page
 * had the browser back button and nothing else. Every route now renders one
 * shared band, so the guard is simply that every route can still reach the bag.
 *
 * ---------------------------------------------------------------------------
 * 2. "THE SHOP" MEANT TWO DIFFERENT PLACES
 * ---------------------------------------------------------------------------
 * On the homepage it pointed at /shop. On the other five it was the label for
 * the link back to /, while /shop itself was called "The catalogue" in three
 * headers and "All pieces" in a fourth. One label per destination, checked.
 *
 * ---------------------------------------------------------------------------
 * 3. MONEY WAS SET IN A TERMINAL FACE
 * ---------------------------------------------------------------------------
 * Prices rendered in IBM Plex Mono. Mono is right for a HUID, an order number
 * or a rate per ten grams, which is why --font-data survives and why the admin
 * is out of scope here. It is wrong for the price of a necklace: it reads as an
 * invoice line, not a figure a jeweller quotes. tokens.css states the matching
 * rule for the display face ("nothing is set in it below --d-m"), and that rule
 * decides which of the two remaining faces each figure gets.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { renderPage } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every route a shopper can be on with a bag in hand. */
const STOREFRONT = ["/", "/shop", "/shop/rani-haar", "/cart", "/founders"];

test("every storefront route can reach the cart", async () => {
  for (const path of STOREFRONT) {
    const body = await renderPage(path);
    assert.match(
      body,
      /href="\/cart"/,
      `${path} serves no link to the cart. Adding a piece to the bag from here ` +
        `would leave the browser back button as the only way to it.`
    );
  }
});

test("every storefront route renders the one shared band", async () => {
  for (const path of STOREFRONT) {
    const body = await renderPage(path);
    assert.match(body, /id="site-navigation"/, `${path} has no shared header`);
    // The five retired copies. If one comes back, so does the drift.
    for (const dead of [
      "shop-topbar",
      "pdp-topbar",
      "cart-topbar",
      "checkout-topbar",
      "f-topbar",
    ]) {
      assert.doesNotMatch(
        body,
        new RegExp(dead),
        `${path} renders ${dead}, which was replaced by the shared header`
      );
    }
  }
});

test("one destination carries one label", async () => {
  const body = await renderPage("/shop");
  for (const retired of ["The catalogue<", "All pieces<"]) {
    assert.ok(
      !body.includes(`>${retired}`),
      `the nav still calls /shop "${retired.slice(0, -1)}". It is "The pieces".`
    );
  }
});

/* ==========================================================================
 * Money is not machine data
 * ======================================================================= */

/**
 * The selectors that render a rupee figure a shopper reads as a price. Traced
 * from the CSS to the JSX that uses each one, so this list is the real set
 * rather than a guess at it.
 */
const PRICE_SELECTORS = [
  ".pdp-breakup dd",
  ".shop-card__figure",
  ".cart-item__figure",
  ".cart-total__figure",
  ".order-line__figure",
  ".order-summary__figure",
  ".order-line__breakuprow dd,\n.order-totals__row dd",
];

function ruleBody(css, selector) {
  const at = css.indexOf(`\n${selector} {`);
  assert.notEqual(at, -1, `selector ${selector} is gone from globals.css`);
  return css.slice(at, css.indexOf("\n}\n", at));
}

test("no price on the storefront is set in the mono face", () => {
  const css = readFileSync(`${ROOT}app/globals.css`, "utf8");
  for (const selector of PRICE_SELECTORS) {
    const body = ruleBody(css, selector);
    assert.doesNotMatch(
      body,
      /var\(--font-data\)/,
      `${selector} sets a price in --font-data. Mono belongs on a HUID or an ` +
        `order number, not on the price of a necklace.`
    );
  }
});

/**
 * tokens.css: "Rozha One is very high contrast, so it needs size to survive.
 * Nothing is set in it below --d-m." So the one big total per page gets the
 * display face and every smaller figure gets the body face. Putting Rozha on a
 * 17px card price is the obvious wrong turn here, and this is what stops it.
 */
test("the display face carries only the figures large enough for it", () => {
  const css = readFileSync(`${ROOT}app/globals.css`, "utf8");

  for (const selector of [".cart-total__figure", ".order-summary__figure"]) {
    const body = ruleBody(css, selector);
    assert.match(body, /var\(--font-display\)/, `${selector} should match .pdp-price__total`);
    assert.match(body, /var\(--d-m\)/, `${selector} is no longer at display size`);
  }

  for (const selector of [".shop-card__figure", ".cart-item__figure", ".order-line__figure"]) {
    const body = ruleBody(css, selector);
    assert.doesNotMatch(
      body,
      /var\(--font-display\)/,
      `${selector} is set at --t-md, which is below --d-m, so the display face ` +
        `is the wrong one for it. Use --font-body.`
    );
  }
});

test("stacked money stays in a column a reader can scan", () => {
  const css = readFileSync(`${ROOT}app/globals.css`, "utf8");
  for (const selector of [
    ".pdp-breakup dd",
    ".order-line__breakuprow dd,\n.order-totals__row dd",
  ]) {
    const body = ruleBody(css, selector);
    assert.match(
      body,
      /tabular-nums/,
      `${selector} stacks figures, so it needs tabular numerals to line up`
    );
  }
});

/* ==========================================================================
 * The catalogue leads with the jewellery
 * ======================================================================= */

/**
 * The placeholder notice ran to roughly 1,200px at 360px and put the first
 * product card about seven screens down. It is collapsed rather than deleted:
 * the claim still has to be readable, and it still has to sit above the Add to
 * cart buttons in the grid.
 */
test("the catalogue notice is disclosed, not dumped", async () => {
  const body = await renderPage("/shop");

  // Matched as a whole tag rather than a prefix: React is free to order the
  // attributes as it likes, and the first version of this check looked for
  // `open` only AFTER the class, so an `open` written before it sailed through.
  const tag = body.match(/<details\b[^>]*\bclass="[^"]*\bshop-notice\b[^"]*"[^>]*>/);
  assert.ok(tag, "the notice is not a disclosure");
  assert.doesNotMatch(
    tag[0],
    /\sopen(?=[\s=>])/,
    `the notice ships open, which is what buried the grid: ${tag[0]}`
  );

  // Collapsed is not hidden. The whole claim is still in the served HTML, and
  // the one-line summary states it without anyone opening anything.
  assert.match(body, /Placeholder catalogue/);
  assert.match(body, /none of those has been recorded/);
  assert.match(body, /Some of these pieces do not exist yet/);

  const summaryAt = body.indexOf("Some of these pieces do not exist yet");
  const firstCardAt = body.indexOf("shop-card");
  assert.ok(summaryAt !== -1 && firstCardAt !== -1);
  assert.ok(
    summaryAt < firstCardAt,
    "the disclosure must precede the grid: the Add to cart buttons are in it"
  );
});
