import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the complete Alankar Jewellers experience", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(
    html,
    /<title>Alankar Jewellers \| Jadau, Diamond &amp; Polki Since 1980<\/title>/i,
  );
  assert.match(html, /Jewels that/);
  assert.match(html, /become heirlooms\./);
  assert.match(html, /Serving trust since generations/);
  assert.match(html, />Jadau</);
  assert.match(html, />Diamond</);
  assert.match(html, />Polki</);
  assert.match(html, /Four decades\./);
  assert.match(html, /A private experience/);
  assert.match(html, /Book an Appointment/);
  assert.doesNotMatch(html, /codex-preview|Building your site|react-loading-skeleton/i);
});

test("ships responsive styling, metadata and production imagery", async () => {
  const [page, css, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /AppointmentDialog/);
  assert.match(page, /aria-modal="true"/);
  assert.match(page, /\/images\/hero-jadau\.webp/);
  assert.match(page, /prefers-reduced-motion|loading="lazy"/);
  assert.match(css, /@media \(max-width: 780px\)/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(layout, /openGraph/);
  assert.match(layout, /\/og\.png/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton|playwright/);

  await Promise.all([
    access(new URL("../public/images/hero-jadau.webp", import.meta.url)),
    access(new URL("../public/images/collection-jadau.webp", import.meta.url)),
    access(new URL("../public/images/collection-diamond.webp", import.meta.url)),
    access(new URL("../public/images/collection-polki.webp", import.meta.url)),
    access(new URL("../public/images/artisan-setting.webp", import.meta.url)),
    access(new URL("../public/images/private-salon.webp", import.meta.url)),
    access(new URL("../public/og.png", import.meta.url)),
  ]);
});
