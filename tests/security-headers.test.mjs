/**
 * SECURITY AND CACHING HEADERS, ENFORCED.
 *
 * The live storefront sent no security headers at all, and the admin sign-in
 * could be framed by another site. Photographs were served with max-age=0, so
 * every page view re-downloaded them. Both were found by reading response
 * headers off production, which is exactly the kind of check nobody repeats, so
 * it lives here instead.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { fetchWorker, renderPage } from "./helpers.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const REQUIRED = {
  "content-security-policy": /frame-ancestors 'none'/,
  "x-frame-options": /^DENY$/,
  "x-content-type-options": /^nosniff$/,
  "strict-transport-security": /^max-age=\d{7,}/,
  "permissions-policy": /camera=\(\)/,
};

function assertSecured(response, label) {
  for (const [name, pattern] of Object.entries(REQUIRED)) {
    assert.match(response.headers.get(name) ?? "", pattern, `${label} is missing ${name}`);
  }
}

test("every storefront page carries the security headers", async () => {
  for (const path of ["/", "/shop", "/shop/meenakari-bridal-choker", "/cart", "/founders"]) {
    const response = await renderPage(path, { raw: true });
    assertSecured(response, path);
    assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin", path);
  }
});

test("a not-found page is secured too, not only the pages that exist", async () => {
  const response = await renderPage("/shop/no-such-piece-exists", { raw: true });
  assert.equal(response.status, 404);
  assertSecured(response, "the 404");
});

test("an API response is secured", async () => {
  const response = await fetchWorker("/api/cart");
  assertSecured(response, "/api/cart");
});

/**
 * The admin already sends `Referrer-Policy: same-origin`. The worker adds
 * headers only where absent, and this is the assertion that it does: a blanket
 * set would have silently weakened the one surface that most needs it.
 */
test("the admin cannot be framed, and keeps its own stricter referrer policy", async () => {
  const response = await renderPage("/admin/login", { raw: true });
  assertSecured(response, "/admin/login");
  assert.equal(response.headers.get("referrer-policy"), "same-origin", "the worker overwrote the admin's own header");
});

test("a redirect is secured, since it is a response a frame could load", async () => {
  const response = await fetchWorker("/admin", { redirect: "manual", headers: { accept: "text/html" } });
  assert.ok(response.status >= 300 && response.status < 400, `expected a redirect, got ${response.status}`);
  assertSecured(response, "the /admin redirect");
});

/* =========================================================================
 * Static files: public/_headers
 * ====================================================================== */

const RULES = readFileSync(`${ROOT}public/_headers`, "utf8");

function block(path) {
  const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const match = RULES.match(new RegExp(`^${escaped}\\n((?:[ \\t]+.+\\n?)+)`, "m"));
  assert.ok(match, `no rule for ${path} in public/_headers`);
  return match[1];
}

test("hashed build output is cached immutably", () => {
  assert.match(block("/assets/*"), /Cache-Control: public, max-age=31536000, immutable/);
});

/**
 * Photographs keep their filename when regenerated, so an immutable rule would
 * pin an old photograph in a visitor's browser for a year.
 */
test("photographs are cached, but never as immutable", () => {
  const rule = block("/images/*");
  assert.match(rule, /max-age=(\d+)/);
  assert.ok(Number(rule.match(/max-age=(\d+)/)[1]) >= 86400, "photographs cached for less than a day");
  assert.doesNotMatch(rule, /immutable/);
});

/**
 * vinext writes its own _headers only when none exists, so this file replaces
 * it. If the build stopped copying it, vinext's default would quietly return
 * and photographs would go back to max-age=0.
 */
test("the build ships this _headers file, not vinext's default", () => {
  const built = readFileSync(`${ROOT}dist/client/_headers`, "utf8");
  assert.equal(built, RULES, "dist/client/_headers differs from public/_headers");
});
