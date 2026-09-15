/**
 * THE POLICY PAGES, HELD TO THE CODE THEY DESCRIBE.
 *
 * A privacy notice that drifts from the checkout form is worse than none: it is
 * a written promise about data handling that the site no longer keeps. So these
 * tests do not trust the notice. They read the checkout form, the appointments
 * route and the cookie constants straight from source, and fail if the notice
 * stops describing what they actually do.
 *
 * The other half is the gate. A policy fact the shop has not supplied never
 * prints, a page missing one is noindex and out of the sitemap, and a flag set
 * to true without a value fails rather than rendering a blank.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Registers the module hooks that let plain Node resolve the app's TypeScript.
import "../scripts/seed-catalogue.mjs";
import { renderPage } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const source = (path) => readFileSync(`${ROOT}${path}`, "utf8");

const {
  CHECKOUT_DATA,
  COOKIE_FACTS,
  ENQUIRY_DATA,
  PENDING,
  POLICY_PAGES,
  hasValue,
  isPublished,
  outstanding,
  policyKnown,
} = await import("../app/_policies/facts.ts");
const { known, site } = await import("../app/site-config.ts");

/** The one arithmetic shape these constants use: `60 * 60 * 24 * 30`. */
function product(expression) {
  assert.match(expression, /^[\d\s*]+$/, `not a plain product: ${expression}`);
  return expression.split("*").reduce((total, factor) => total * Number(factor.trim()), 1);
}

/* =========================================================================
 * Held to the code
 * ====================================================================== */

test("the privacy notice covers every field the checkout form submits", async () => {
  const submitted = new Set([...source("app/checkout/page.tsx").matchAll(/name="([a-zA-Z0-9_]+)"/g)].map((m) => m[1]));
  assert.ok(submitted.size >= 10, "found almost no checkout fields; the parser is looking at nothing");

  const described = new Set(CHECKOUT_DATA.flatMap((entry) => entry.fields));
  const missing = [...submitted].filter((field) => !described.has(field));
  assert.deepEqual(missing, [], `checkout submits fields the privacy notice does not describe: ${missing.join(", ")}`);

  const body = await renderPage("/privacy");
  for (const entry of CHECKOUT_DATA) {
    assert.ok(body.includes(entry.item), `the privacy page does not render "${entry.item}"`);
  }
});

test("the privacy notice covers every column an appointment request stores", async () => {
  const route = source("app/api/appointments/route.ts");
  const insert = route.match(/db\.insert\(appointments\)\.values\(\{([\s\S]*?)\}\)/);
  assert.ok(insert, "could not find the appointments insert");
  const stored = [...insert[1].matchAll(/(\w+):\s*lead\.\w+/g)].map((m) => m[1]);
  assert.ok(stored.length >= 5, "found almost no stored columns; the parser is looking at nothing");

  const described = new Set(ENQUIRY_DATA.flatMap((entry) => entry.fields));
  const missing = stored.filter((field) => !described.has(field));
  assert.deepEqual(missing, [], `enquiries store columns the privacy notice does not describe: ${missing.join(", ")}`);

  const body = await renderPage("/privacy");
  for (const entry of ENQUIRY_DATA) {
    assert.ok(body.includes(entry.item), `the privacy page does not render "${entry.item}"`);
  }
});

test("the cookies the notice names are the cookies the code sets, for as long as it sets them", async () => {
  const cart = source("app/_data/cart.ts");
  const session = source("app/_admin/session.ts");

  assert.equal(COOKIE_FACTS.cart.name, cart.match(/export const CART_COOKIE = "([^"]+)"/)[1]);
  assert.equal(COOKIE_FACTS.cart.days * 86400, product(cart.match(/export const CART_COOKIE_MAX_AGE_SECONDS = ([^;]+);/)[1]));
  assert.equal(COOKIE_FACTS.admin.name, session.match(/export const ADMIN_SESSION_COOKIE = "([^"]+)"/)[1]);
  assert.equal(COOKIE_FACTS.admin.idleHours * 3600, product(session.match(/export const ADMIN_IDLE_SECONDS = ([^;]+);/)[1]));
  assert.equal(COOKIE_FACTS.admin.absoluteDays * 86400, product(session.match(/export const ADMIN_ABSOLUTE_SECONDS = ([^;]+);/)[1]));

  const body = await renderPage("/privacy");
  assert.ok(body.includes(COOKIE_FACTS.cart.name));
  assert.ok(body.includes(COOKIE_FACTS.admin.name));
});

/* =========================================================================
 * Reachable
 * ====================================================================== */

test("every policy page renders with one h1", async () => {
  for (const page of POLICY_PAGES) {
    const response = await renderPage(page.href, { raw: true });
    assert.equal(response.status, 200, page.href);
    const body = await response.text();
    assert.equal((body.match(/<h1[\s>]/g) ?? []).length, 1, `${page.href} has ${(body.match(/<h1[\s>]/g) ?? []).length} h1s`);
    assert.match(body, new RegExp(`<h1[^>]*>${page.title}</h1>`), page.href);
  }
});

test("every storefront route links to every policy page", async () => {
  for (const path of ["/", "/shop", "/shop/meenakari-bridal-choker", "/cart", "/checkout", "/founders"]) {
    const body = await renderPage(path);
    for (const page of POLICY_PAGES) {
      assert.match(body, new RegExp(`href="${page.href}"`), `${path} has no link to ${page.href}`);
    }
  }
});

/* =========================================================================
 * The gate
 * ====================================================================== */

test("every fact a page depends on has a name a visitor can read", () => {
  for (const page of POLICY_PAGES) {
    for (const fact of page.requires) {
      assert.ok(fact in policyKnown, `${page.href} depends on an undeclared fact "${fact}"`);
      assert.ok(PENDING[fact], `no visitor-facing name for "${fact}"`);
    }
  }
});

/** The both-directions rule rendered-html.test.mjs applies to `known`. */
test("a policy fact marked as supplied must carry its value", () => {
  for (const fact of Object.keys(policyKnown)) {
    if (policyKnown[fact]) {
      assert.ok(hasValue(fact), `"${fact}" is marked supplied but has no value, so it would render blank`);
    }
  }
});

test("an unpublished page is noindex, names what is missing, and stays out of the sitemap", async () => {
  const sitemap = await renderPage("/sitemap.xml");
  let unpublished = 0;
  for (const page of POLICY_PAGES) {
    const body = await renderPage(page.href);
    const url = `${site.url}${page.href}</loc>`;
    if (isPublished(page)) {
      assert.doesNotMatch(body, /<meta name="robots" content="[^"]*noindex/, `${page.href} is published but noindex`);
      assert.ok(sitemap.includes(url), `${page.href} is published but not in the sitemap`);
      assert.doesNotMatch(body, /Not yet published/);
      continue;
    }
    unpublished += 1;
    assert.match(body, /<meta name="robots" content="[^"]*noindex/, `${page.href} is unpublished but indexable`);
    assert.ok(!sitemap.includes(url), `${page.href} is unpublished but listed in the sitemap`);
    assert.match(body, /Not yet published/);
    for (const fact of outstanding(page)) {
      assert.ok(body.includes(PENDING[fact]), `${page.href} does not say it is still waiting on ${PENDING[fact]}`);
    }
  }
  assert.ok(unpublished > 0 || POLICY_PAGES.every(isPublished));
});

test("no placeholder from site-config leaks onto a policy page", async () => {
  for (const page of POLICY_PAGES) {
    const body = await renderPage(page.href);
    if (!known.address) {
      for (const placeholder of ["Shop address line 1", "000000", ">Locality"]) {
        assert.ok(!body.includes(placeholder), `${page.href} leaks the placeholder "${placeholder}"`);
      }
    }
    if (!known.email) {
      assert.ok(!body.includes(site.email), `${page.href} leaks the unconfirmed email ${site.email}`);
    }
    assert.doesNotMatch(body, />\s*(null|undefined)\s*</, `${page.href} rendered a literal null or undefined`);
  }
});
