# 02 — Market & Technical Research: E-commerce for Alankar Jewellers

**Date:** 2026-07-27
**Sector:** Online store + admin panel added to an existing single-page marketing site
**Stack (fixed, non-negotiable):** Next.js 16.2.6 via `vinext` 0.0.50 → Cloudflare Workers · Cloudflare D1 (SQLite) via Drizzle ORM 0.45.2 · optional R2 · deployed through the OpenAI Sites control plane

> **How to read this.** Every external claim carries a source link. Where I could not verify something, it is marked **[UNVERIFIED]** or **[INFERENCE]**. Anything marked **[BLOCKER]** will break the build if ignored. Anything marked **[DECIDE]** is a question for Phase 2 planning, not something research can settle.

---

## 0. Runtime constraints — read this before anything else

I read `worker/index.ts`, `db/index.ts`, `vite.config.ts`, `.openai/hosting.json`, `drizzle.config.ts`, `package.json` and the installed `vinext` build output. These are the hard walls the design has to live inside.

### 0.1 What the repo actually is

| Fact | Evidence |
|---|---|
| Worker entry is `worker/index.ts`; it handles `/_vinext/image` then delegates everything to `vinext/server/app-router-entry` | `worker/index.ts:29-44` |
| D1 binding is `DB`, declared in `.openai/hosting.json` as `"d1": "DB"` | `.openai/hosting.json:3` |
| **R2 is currently off** — `"r2": null` | `.openai/hosting.json:4` |
| `vite.config.ts` reads `hosting.json` and synthesises local Wrangler bindings from it. Setting `r2` to a string creates a bucket binding of that name, bound to local bucket `site-creator-r2` | `vite.config.ts:16, 26-33` |
| `compatibility_flags: ["nodejs_compat"]`, compatibility date `2026-05-15` | `vite.config.ts:22`, `dist/server/wrangler.json` |
| There is **no `wrangler.jsonc`** — bindings come from `hosting.json` + the control plane | `README.md:19` |
| Drizzle migrations are generated locally (`npm run db:generate` → `drizzle/`) and copied to `dist/.openai/drizzle` at build time; **the platform applies them on deploy** | `build/sites-vite-plugin.ts:36-40`, `app/api/appointments/route.ts` error string |
| Existing schema is one table, `appointments` | `db/schema.ts` |
| **No CSS framework.** `app/globals.css` is 1,677 lines of hand-written BEM with a bespoke token set (`--garnet`, `--gold`, `--parchment`, Bodoni serif). Tailwind was deliberately removed | `app/globals.css:1-5` |
| Secrets are read off `env` at runtime (`LEAD_WEBHOOK_URL` pattern) and set in the control plane | `.env.example`, `app/api/appointments/route.ts:12-15` |

### 0.2 Platform limits that shape the architecture

Cloudflare Workers ([limits](https://developers.cloudflare.com/workers/platform/limits/)):

| Limit | Free | Paid |
|---|---|---|
| CPU time / request | 10 ms | 30 s default (up to 5 min) |
| Subrequests / invocation (incl. every D1 + R2 + `fetch`) | **50** | 10,000 |
| Request body size | 100 MB (account plan, not Workers plan) | — |
| Memory | 128 MB | 128 MB |
| Script size (compressed) | **3 MB** | 10 MB |
| `ctx.waitUntil` after response | 30 s | 30 s |

Cloudflare D1 ([limits](https://developers.cloudflare.com/d1/platform/limits/)):

| Limit | Free | Paid |
|---|---|---|
| Max DB size | 500 MB | 10 GB |
| Queries per Worker invocation | **50** | 1,000 |
| **Max bound parameters per query** | **100** | 100 |
| Max row / string / BLOB | 2 MB | 2 MB |
| Max query duration | 30 s | 30 s |
| Simultaneous D1 connections per Worker | 6 | 6 |
| Time Travel (point-in-time restore) | 7 days | 30 days |

Consequences that are easy to get wrong:

- **The 100-bound-parameter cap kills naive bulk inserts.** An order with 6 line items × ~20 snapshot columns = 120 parameters in one multi-row `INSERT`. Chunk it, or use `db.batch()` with one statement per row. This is a real footgun and will only show up under a large cart.
- **The 10 ms free-tier CPU limit** makes anything CPU-heavy (PDF invoice generation, image processing in JS, bcrypt/argon2 password hashing) non-viable on free. Argon2/bcrypt in particular are *designed* to burn CPU. **[BLOCKER for free tier]** — this is a strong argument for the auth design in §5 and against self-hosted password auth.
- **`db.batch()` is the only atomicity primitive.** D1 has no interactive transactions, and `drizzle.transaction()` on D1 throws — Drizzle emits `BEGIN TRANSACTION`, which the Workers D1 binding rejects ([drizzle-orm#2463](https://github.com/drizzle-team/drizzle-orm/issues/2463), [#4212](https://github.com/drizzle-team/drizzle-orm/issues/4212)). Two `batch()` calls are two separate transactions; if the second fails, the first is already committed ([writeup](https://firdausng.com/posts/d1-has-no-transactions-use-client-batch)). **This dictates the order-placement design in §7.6.**
- **D1 is single-threaded per database** and processes queries sequentially — roughly 1,000 queries/sec at 1 ms average ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). Fine for a single jeweller; do not design as if it were Postgres.

### 0.3 vinext feature support

`vinext` reimplements the Next.js API surface on Vite for Workers. I verified the following against the **README shipped inside the installed `vinext@0.0.50`** (`node_modules/vinext/README.md`), not just the GitHub `main` docs — so this matrix applies to the pinned version. It claims "~94% of the Next.js 16 API surface has full or partial support" (line 421). Fully supported, and these are exactly the pieces this project needs:

- **Server Actions** — action execution, `FormData`, re-render after mutation, `redirect()` in actions
- **`middleware.ts` / `proxy.ts`** (Next.js 16) with matcher patterns — this is how the `/admin` gate gets enforced
- **Route handlers** — named HTTP methods, auto `OPTIONS`/`HEAD`, cookie attachment (needed for the payment webhook)
- **`cookies()`, `headers()`, `draftMode()`** (async) — needed for sessions and for reading the SIWC identity headers
- **ISR / `revalidate`** with a pluggable `CacheHandler`

**Partial (🟡):**
- `next/image` — "Remote images via `@unpic/react` (28 CDNs). Local images via `<img>` + srcSet. **No build-time optimization/resizing**." Local images route through `/_vinext/image`, which "can resize and transcode on Cloudflare Workers (via the Images binding) in production." See §6 — this matters a lot.
- **`images` config in `next.config.ts` is "parsed but not used for optimization"** (line 501). So `remotePatterns` does nothing. `next.config.ts` in this repo is empty anyway.
- Route segment config — `revalidate`, `dynamic`, `dynamicParams` work; `runtime` and `preferredRegion` are **ignored**.

**Explicitly excluded:** Vercel-specific features, AMP, `next export`, Turbopack/webpack config, `next/jest`, and "bug-for-bug parity with undocumented behavior."

**Known limitation worth planning around:** "Native Node modules (sharp, resvg, satori, lightningcss, @napi-rs/canvas) crash Vite's RSC dev environment" — they work in production builds but not `npm run dev`, and are auto-stubbed on deploy. Reinforces §8.3.

**Env vars:** vinext auto-loads `.env*` Next-style. Only `NEXT_PUBLIC_*` is inlined to the browser; everything else stays server-only. Payment secrets go in `.env` locally and the control plane in production — never `NEXT_PUBLIC_`.

⚠️ **Version drift [DECIDE]:** the repo pins `vinext` `0.0.50`; npm `latest` is `1.0.0-beta.4` (published 2026-07-24). The feature matrix above is verified against the installed 0.0.50, so it is safe to plan on — but decide deliberately whether to upgrade before or after building the store. Upgrading a 0.0.x → 1.0.0-beta under a half-built checkout is the worst of both worlds.

### 0.4 The `IMAGES` binding is referenced but never declared

`worker/index.ts:6-13` types and uses `env.IMAGES` for image transformation. But:

- `vite.config.ts` `localBindingConfig` declares only `main`, `compatibility_flags`, `d1_databases`, `r2_buckets` — **no `images` binding**.
- `dist/server/wrangler.json` confirms it: no `images` key in the emitted config.

Cloudflare's Images binding requires an explicit `[images] binding = "IMAGES"` block in Wrangler config ([docs](https://developers.cloudflare.com/images/transform-images/bindings/)). So either the OpenAI Sites control plane injects it at deploy, or **image transformation silently never runs**. It fails gracefully — `handleImageOptimization` catches the throw and falls through to a passthrough response (`node_modules/vinext/dist/server/image-optimization.js`, the `catch` around `handlers.transformImage`) — so you get un-resized originals with no error. **[UNVERIFIED — control-plane behaviour I cannot see from here.]** Verify on a real deploy by requesting `/_vinext/image?url=/images/hero-jadau.webp&w=640` and checking whether the response `Content-Type` is negotiated (`image/avif`) or the original `image/webp`.

---

## 5. Admin panel & auth on this stack

### 5.1 What SIWC actually gives you

`app/chatgpt-auth.ts` reads three request headers injected by the platform:

- `oai-authenticated-user-email`
- `oai-authenticated-user-full-name` (percent-encoded UTF-8)
- `oai-authenticated-user-full-name-encoding`

`getChatGPTUser()` returns `null` when the email header is absent; `requireChatGPTUser(returnTo)` redirects to `/signin-with-chatgpt`. Dispatch (the platform) owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the OAuth cookies, and header injection — the app must not implement those routes (`README.md:76-79`).

The README is blunt about the limitation (`README.md:81-83`):

> SIWC establishes identity only; it does not prove workspace membership. Use the Sites hosting platform's access policy controls for workspace-wide restrictions, or enforce explicit server-side membership or allowlist checks.

Read that literally: **any ChatGPT account on earth can complete SIWC and arrive at your route with a valid `oai-authenticated-user-email` header.** SIWC is authentication, not authorisation. Using `requireChatGPTUser()` alone to gate `/admin` would expose the entire order book and catalogue to the public internet.

### 5.2 The header-trust question

There is a second, subtler issue. `getChatGPTUser()` trusts a plain request header. That is safe **only** if the platform edge strips any client-supplied `oai-authenticated-user-*` header before it reaches the Worker. That is the standard contract for identity-header injection and is almost certainly what Dispatch does — but I cannot verify it from this repo. **[UNVERIFIED — must be confirmed before shipping.]**

**Test to run before trusting it:** `curl -H 'oai-authenticated-user-email: attacker@example.com' https://<deployed-site>/admin`. If that returns an authenticated admin page, header spoofing is live and SIWC cannot be the only gate under any configuration.

### 5.3 Options evaluated

| Option | Works on Workers? | Verdict |
|---|---|---|
| **SIWC + server-side allowlist in D1** | Yes — pure header read + one indexed D1 lookup | ✅ **Recommended.** See §5.4 |
| **Cloudflare Access (Zero Trust)** | Technically ideal — JWT in `Cf-Access-Jwt-Assertion`, verified against the team's JWKS ([docs](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/)) | ❌ Requires you to own the Cloudflare zone and configure a Zero Trust policy. This site is deployed through the **OpenAI Sites control plane**; you almost certainly have no Cloudflare dashboard for it. **[UNVERIFIED but high confidence]** — if the control plane does expose an access-policy control, that is strictly better than anything below and should be layered on top |
| **Signed-cookie session with WebCrypto** (HMAC-SHA256 or AES-GCM) | Yes — WebCrypto is native ([Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)); the signing is async so cookie helpers return Promises ([Hono cookie helper](https://hono.dev/docs/helpers/cookie)) | 🟡 Good as the *mechanism*, bad as the *identity source* — you'd have to invent a login (password → CPU-expensive KDF → 10 ms CPU problem, §0.2) |
| **HTTP Basic auth** | Yes, trivially | ❌ No logout, no per-user audit trail, credentials replayed on every request, shared secret gets WhatsApped around the shop. For a route showing customer addresses and order values under DPDP, this is not defensible |
| **`better-auth`** (6.18M downloads/wk, v1.6.25, 2026-07-23) | Claims Workers support via a D1/Drizzle adapter | ❌ Overkill and risky. Brings its own route surface that will fight vinext's router, and adds materially to a 3 MB compressed script budget. Revisit only if customer accounts become a requirement |
| **`next-auth` v4 / `@auth/core`** | `@auth/core` is edge-oriented, `next-auth` v4 is not | ❌ v4 (4.24.15) assumes Node crypto and the Next.js pages/app router internals. High risk against a Next reimplementation. Do not attempt |

### 5.4 Recommendation: SIWC as identity + D1 allowlist as authorisation + middleware as the choke point

Three layers, each doing exactly one job:

1. **Identity — SIWC.** `requireChatGPTUser("/admin")` in a server component or in `middleware.ts`. Free, zero credential storage, no password reset flow, no CPU-bound hashing, and the shop owner already has a ChatGPT account (they got this site through it). No secret to leak.
2. **Authorisation — `admin_users` table in D1** (§7.9). One indexed lookup on lowercased email, `is_active = 1`. The allowlist is data, not config, so revoking a departed employee is a row update and takes effect on the next request — no redeploy. Seed the first row via a migration.
3. **Choke point — `middleware.ts` matching `/admin/:path*` and `/api/admin/:path*`.** Enforcing in middleware rather than per-page means a new admin page is protected by default, which is the failure mode that actually bites. **But also re-check in each route handler / server action** — defence in depth, because a matcher typo is a silent total bypass.

Additionally, treat every admin **mutation** as needing its own check. A read-only allowlist check in middleware does not protect a Server Action invoked directly.

**Why not a signed-cookie session on top?** You don't need one — SIWC already carries the session for you, and adding a second session layer means two expiries to keep in sync. Where you *will* need WebCrypto cookies is the **customer** side (guest cart identity, §7.5): a random opaque cart token in an `HttpOnly; Secure; SameSite=Lax` cookie, with the value HMAC-signed so a tampered token is rejected without a DB round-trip. That is a ~30-line `crypto.subtle.importKey` + `sign`/`verify` helper. Reference implementations: [azechi-learning/cloudflare-workers-stateless-session-hmac-cookie](https://github.com/azechi-learning/cloudflare-workers-stateless-session-hmac-cookie), [webcrypt-session](https://github.com/toyamarinyon/webcrypt-session), [Cloudflare's signing-requests example](https://developers.cloudflare.com/workers/examples/signing-requests/).

**Caveat to plan around [DECIDE]:** SIWC ties admin access to ChatGPT accounts. If the shop wants a staff member without a ChatGPT account to process orders, this breaks and you fall back to signed-cookie sessions with a proper KDF — which then needs the Workers **paid** plan for CPU headroom. Ask the owner who needs admin access before building.

### 5.5 Admin UI: build it, don't adopt a framework

**Do not use Payload CMS.** It does now ship a [Cloudflare D1 template](https://github.com/payloadcms/payload/tree/main/templates/with-cloudflare-d1) and Cloudflare has [blogged about it](https://blog.cloudflare.com/payload-cms-workers), but: (a) it requires **Workers Paid** because of script-size limits ([Payload's own README](https://github.com/payloadcms/payload/blob/main/templates/with-cloudflare-d1/README.md)); (b) the D1 adapter is explicitly less battle-tested than Postgres; and (c) — decisively — Payload owns the Next.js app structure and expects real Next.js, not vinext's reimplementation. Same reasoning rules out Strapi, Directus, and Medusa (all Node-server products).

Build the admin as plain server components + Server Actions against the existing hand-written CSS system. The surface is small: a product list, a product editor, an order list, an order detail, and the existing appointments table. Reuse the `--garnet`/`--gold`/`--parchment` tokens already in `app/globals.css` so the admin doesn't need a second design system.

---

## 6. Product images: R2 + the image-optimization endpoint

### 6.1 Enabling R2 here

`.openai/hosting.json` currently has `"r2": null`. `vite.config.ts:26-33` shows the mechanism: the value is used as the **binding name**.

```jsonc
// .openai/hosting.json
{ "project_id": "appgprj_…", "d1": "DB", "r2": "MEDIA" }
```

That produces `r2_buckets: [{ binding: "MEDIA", bucket_name: "site-creator-r2" }]` locally, and the control plane provisions the real bucket on deploy — exactly the pattern already proven by `"d1": "DB"`. Access it as `env.MEDIA` from `cloudflare:workers`, the same import `db/index.ts` uses. `Env` in `worker/index.ts:8-16` needs a matching `MEDIA: R2Bucket` field.

### 6.2 Upload flow from the admin panel

Two viable flows:

**A. Proxy upload through the Worker (recommended for v1).** Admin posts a `multipart/form-data` Server Action → the Worker validates the session, checks magic bytes / content type, then `await env.MEDIA.put(key, file.stream(), { httpMetadata: { contentType } })`.
- Pros: no CORS config, no presigning, no credentials to store, one code path, and you can enforce the admin check on the upload itself.
- Cons: the file transits the Worker. Body limit is 100 MB on Free/Pro ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)) — irrelevant for jewellery photos. Streaming the body straight to `.put()` keeps memory well under the 128 MB isolate cap.

**B. Presigned S3 URL, browser uploads direct to R2.** Use [`aws4fetch`](https://www.npmjs.com/package/aws4fetch) (5.6M downloads/wk, Workers-native, but **last published 2024-08-28 — outside the 12-month freshness bar**) to sign an S3-compat PUT. Known sharp edges: `signQuery: true` signs only the `host` header, so any extra header the browser sends causes R2 to reject the request; and R2 blocks browser requests entirely until CORS is configured on the bucket ([writeup](https://ishan.page/blog/cloudflare-r2-workers-presigned/), [Cloudflare docs issue #19190](https://github.com/cloudflare/cloudflare-docs/issues/19190)). It also needs R2 S3 access keys as secrets. **Not worth it at this scale** — a jeweller uploads a handful of photos per piece, not gigabytes.

Go with A.

### 6.3 ⚠️ The image-optimization endpoint will *not* serve R2 images without a code change

This is the most important finding in this section. I read `node_modules/vinext/dist/server/image-optimization.js`. `parseImageParams` rejects the request unless the `url` parameter is a **same-origin relative path**:

```js
const normalizedUrl = imageUrl.replaceAll("\\", "/");
if (!normalizedUrl.startsWith("/") || normalizedUrl.startsWith("//")) return null;
try {
  const base = "https://localhost";
  if (new URL(normalizedUrl, base).origin !== base) return null;
} catch { return null; }
```

So an absolute R2 public URL (`https://pub-….r2.dev/…`) or an R2 custom domain is a **400 Bad Request**. And `worker/index.ts:36` wires `fetchAsset` to `env.ASSETS.fetch(...)` — the static-assets binding, which serves `dist/client/` and knows nothing about R2. R2 images would 404.

**The fix is small and local to `worker/index.ts`:** serve R2 objects under a same-origin path and teach `fetchAsset` about it.

```ts
// worker/index.ts — inside the /_vinext/image branch
fetchAsset: async (path: string, req: Request) => {
  if (path.startsWith("/media/")) {
    const object = await env.MEDIA.get(decodeURIComponent(path.slice("/media/".length)));
    if (!object) return new Response("Not found", { status: 404 });
    const headers = new Headers();
    object.writeHttpMetadata(headers);          // sets Content-Type from httpMetadata
    return new Response(object.body, { headers });
  }
  return env.ASSETS.fetch(new Request(new URL(path, req.url)));
},
```

Then `<Image src="/media/sku-1041/front.jpg" … />` flows through the optimizer. You will also want a plain `GET /media/*` route in the Worker (outside the `/_vinext/image` branch) so unoptimized/original fetches resolve.

**Alternative worth knowing:** vinext routes *remote* (absolute-URL) images through `@unpic/react`, which auto-detects 28 CDN providers. If the control plane ever exposes an R2 custom domain fronted by Cloudflare Image Resizing, `<Image src="https://cdn.example/…">` would work with no Worker change. But that depends on infrastructure I cannot see (§6.4), and the same-origin `/media/*` route above works regardless. Build the `/media/*` route.

Two things `handleImageOptimization` does that you must design around:
- It requires the source `Content-Type` to be in a hardcoded allowlist (`image/jpeg|png|gif|webp|avif|x-icon|vnd.microsoft.icon|bmp|tiff`); anything else is a **400**. So the admin upload **must** set `httpMetadata.contentType` correctly on `.put()`, or every image 400s. SVG is blocked by default.
- On transform failure it logs and silently falls back to serving the original (§0.4). Great for availability, terrible for noticing that transformation is broken.

### 6.4 Limits and behaviour

- **Images binding input cap: 20 MB** per image, from any source including R2, `fetch()`, or a request body ([docs](https://developers.cloudflare.com/images/transform-images/bindings/)). Modern phone/DSLR jewellery shots can exceed this — validate and reject at upload, with a clear admin error.
- **Allowed output widths are enforced.** `worker/index.ts:33` passes `[...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES]` = `[640, 750, 828, 1080, 1200, 1920, 2048, 3840, 16, 32, 48, 64, 96, 128, 256, 384]`. A `w=` outside that set is a **400**, and `ABSOLUTE_MAX_WIDTH` is 3840. Pick `sizes`/widths from that list.
- **Billing:** each unique (source image × parameters) combination is billed once per calendar month; repeats are free within the month. `.info()` calls are free. Responses are **not** automatically cached and every uncached call does a full decode + re-encode — Cloudflare explicitly recommends putting Workers Cache in front ([binding docs](https://developers.cloudflare.com/images/transform-images/bindings/), [blog](https://blog.cloudflare.com/improve-your-media-pipelines-with-the-images-binding-for-cloudflare-workers/)). The endpoint already sets `Cache-Control: public, max-age=31536000, immutable`, which gets you browser + edge caching but not necessarily a Workers Cache hit before the Worker runs.
- **R2 limits** ([docs](https://developers.cloudflare.com/r2/platform/limits/)): 5 TiB max object, 5 GiB single-part upload, 1,024-byte key length, 8,192-byte custom metadata, 100 custom domains per bucket, and — worth knowing — **1 write/sec to the same object key** (429 beyond that), and the `r2.dev` endpoint is test-only and rate-limited. Use a custom domain or serve via the Worker in production.
- **In local dev `/_vinext/image` just 302-redirects to the raw path** (`node_modules/vinext/dist/index.js:1045-1062`). So the R2 path will not work in `npm run dev` unless you add the plain `GET /media/*` route. Don't debug production image behaviour locally.

### 6.5 Practical guidance

- Jewellery photography is the single highest-leverage asset in this project (see §9). Store one high-quality master per angle in R2 and let the Images binding produce every derivative; never store pre-resized copies.
- Key scheme: `products/{productId}/{variantId}/{ordinal}-{hash}.jpg`. Content-hash the filename so the immutable cache header is actually safe on re-upload.
- Store the R2 key in D1, never the full URL — the public origin may change.
- **[UNVERIFIED]** Whether the OpenAI Sites control plane exposes an R2 public bucket URL or custom domain at all. Assume it does not and serve through the Worker path; that also lets you keep the bucket private.

---

## 7. Data model (Drizzle + D1/SQLite)

### 7.0 Representation rules (apply everywhere)

| Concern | Rule | Why |
|---|---|---|
| **Money** | `integer` **paise**, never `real` | SQLite `REAL` is IEEE-754. `0.1 + 0.2 !== 0.3` on a GST calculation produces invoices that don't foot. ₹7,250.50 → `725050` |
| **Weight** | `integer` **milligrams** | Jewellery is quoted to 3 decimals (12.345 g). `12345` mg. Same float argument |
| **Rates / percentages** | `integer` **basis points** | GST 3% → `300` bps. Making charge 12% → `1200` bps |
| **IDs** | `text` primary keys, app-generated | Auto-increment integers leak order volume to competitors and to customers (`/orders/7` tells everyone you've had 7 orders). Use `nanoid`. Keep a *separate* human-readable `order_number` for the shop |
| **Timestamps** | `text` ISO-8601 UTC, `default sql\`CURRENT_TIMESTAMP\`` | Matches the existing `appointments` convention (`db/schema.ts`) — don't introduce a second style |
| **Enums** | `text` + `{ enum: [...] }` in Drizzle + a `CHECK` constraint | SQLite has no native enum; the CHECK is what actually protects you |

### 7.1 The central modelling decision: *design* vs *physical piece*

Antique Jadau and Polki pieces are typically one-of-a-kind. Modelling `products.stock_quantity` and calling it a day produces two failures: you cannot express "this exact necklace, 42.310 g, HUID `ABC123`" and you cannot express "this chain design, in 18" and 20", 22K or 18K."

So: **`products` is the design/listing. `variants` is the purchasable physical piece.** A one-of-a-kind Jadau set is a product with exactly one variant with `stock_quantity = 1`. A repeatable chain is a product with several variants. This costs one join and buys correctness for both cases.

### 7.2 Products, variants, categories

```ts
export const products = sqliteTable("products", {
  id: text("id").primaryKey(),                       // nanoid
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  subtitle: text("subtitle"),
  description: text("description"),
  craft: text("craft", { enum: ["jadau", "polki", "diamond", "gold", "kundan", "other"] }).notNull(),
  status: text("status", { enum: ["draft", "active", "archived"] }).notNull().default("draft"),
  /** Sold online vs. enquiry-only. See §1 — not every piece should be buyable. */
  saleMode: text("sale_mode", { enum: ["buy_online", "enquire_only", "appointment_only"] })
    .notNull().default("enquire_only"),
  isOneOfAKind: integer("is_one_of_a_kind", { mode: "boolean" }).notNull().default(true),
  seoTitle: text("seo_title"),
  seoDescription: text("seo_description"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  index("products_status_sale_mode_idx").on(t.status, t.saleMode),
  index("products_craft_idx").on(t.craft),
]);

export const variants = sqliteTable("variants", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  sku: text("sku").notNull().unique(),

  // --- Variant axes ---
  metal: text("metal", { enum: ["gold", "silver", "platinum", "none"] }).notNull().default("gold"),
  purity: text("purity", { enum: ["24K", "23K", "22K", "20K", "18K", "14K", "925", "950Pt"] }),
  size: text("size"),                                 // ring size / bangle 2.4 / chain 18in
  colour: text("colour", { enum: ["yellow", "white", "rose", "mixed"] }),

  // --- Pricing inputs (all integers) ---
  pricingMode: text("pricing_mode", { enum: ["dynamic_gold", "fixed", "on_request"] })
    .notNull().default("dynamic_gold"),
  netMetalWeightMg: integer("net_metal_weight_mg"),    // gold only, excludes stones
  grossWeightMg: integer("gross_weight_mg"),           // as weighed, incl. stones
  makingChargeType: text("making_charge_type", { enum: ["per_gram", "percent", "flat"] }),
  makingChargeValue: integer("making_charge_value"),   // paise/g | bps | paise
  stoneValuePaise: integer("stone_value_paise").notNull().default(0),
  otherChargesPaise: integer("other_charges_paise").notNull().default(0),
  /** Used only when pricingMode = 'fixed' (typical for antique/Polki quoted flat). */
  fixedPricePaise: integer("fixed_price_paise"),

  // --- Compliance (see §4) ---
  huid: text("huid"),                                 // 6-char BIS HUID
  hallmarkPurityMark: text("hallmark_purity_mark"),   // e.g. "22K916"
  certificateNumber: text("certificate_number"),
  certificateLab: text("certificate_lab"),            // IGI / GIA / SGL
  diamondOrigin: text("diamond_origin", { enum: ["natural", "lab_grown", "none"] }).notNull().default("none"),
  countryOfOrigin: text("country_of_origin").notNull().default("India"),

  // --- Inventory ---
  stockQuantity: integer("stock_quantity").notNull().default(0),
  isMadeToOrder: integer("is_made_to_order", { mode: "boolean" }).notNull().default(false),
  leadTimeDays: integer("lead_time_days"),

  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  index("variants_product_idx").on(t.productId),
  index("variants_stock_idx").on(t.stockQuantity),
]);
```

Add a `CHECK` (via a hand-edited migration, since Drizzle's SQLite CHECK support is thin) enforcing the pricing-mode contract:

```sql
CHECK (
  (pricing_mode = 'dynamic_gold' AND net_metal_weight_mg IS NOT NULL AND purity IS NOT NULL)
  OR (pricing_mode = 'fixed' AND fixed_price_paise IS NOT NULL)
  OR (pricing_mode = 'on_request')
)
```

Categories/collections are many-to-many (a piece is both "Bridal" and "Polki"):

```ts
export const collections = sqliteTable("collections", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  kind: text("kind", { enum: ["category", "collection", "occasion"] }).notNull().default("category"),
  parentId: text("parent_id"),                        // self-ref, one level only — keep it shallow
  position: integer("position").notNull().default(0),
  isVisible: integer("is_visible", { mode: "boolean" }).notNull().default(true),
});

export const productCollections = sqliteTable("product_collections", {
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  collectionId: text("collection_id").notNull().references(() => collections.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
}, (t) => [
  primaryKey({ columns: [t.productId, t.collectionId] }),
  index("product_collections_collection_idx").on(t.collectionId),
]);
```

Media (R2 keys, never URLs — §6.5):

```ts
export const productMedia = sqliteTable("product_media", {
  id: text("id").primaryKey(),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  variantId: text("variant_id").references(() => variants.id, { onDelete: "set null" }),
  r2Key: text("r2_key").notNull(),
  kind: text("kind", { enum: ["image", "video"] }).notNull().default("image"),
  alt: text("alt"),                                   // accessibility + SEO, make it required in the admin form
  width: integer("width"),
  height: integer("height"),
  contentType: text("content_type").notNull(),        // must be set, see §6.3
  byteSize: integer("byte_size"),
  position: integer("position").notNull().default(0),
}, (t) => [index("product_media_product_position_idx").on(t.productId, t.position)]);
```

### 7.3 Gold rates — the audit trail

```ts
export const goldRates = sqliteTable("gold_rates", {
  id: text("id").primaryKey(),
  metal: text("metal", { enum: ["gold", "silver", "platinum"] }).notNull(),
  purity: text("purity").notNull(),                   // "24K" | "22K" | "18K" | "14K" | "925"
  ratePerGramPaise: integer("rate_per_gram_paise").notNull(),
  source: text("source", { enum: ["manual", "ibja", "api", "derived"] }).notNull(),
  sourceRef: text("source_ref"),                      // API response id / provider name
  effectiveFrom: text("effective_from").notNull(),    // ISO-8601 UTC
  effectiveTo: text("effective_to"),                  // null = current
  createdBy: text("created_by"),                      // admin email when source = 'manual'
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  index("gold_rates_lookup_idx").on(t.metal, t.purity, t.effectiveFrom),
  uniqueIndex("gold_rates_current_idx").on(t.metal, t.purity).where(sql`effective_to IS NULL`),
]);
```

The partial unique index guarantees exactly one *current* rate per (metal, purity) — a cheap invariant that prevents the "two rates active, which one did we charge?" bug. Rate rows are **append-only**: never `UPDATE` a rate, always close the old row (`effective_to = now`) and insert a new one, in a single `db.batch()`. Historic orders reference the exact `gold_rates.id` they were priced from, so an invoice from 2027 still reconstructs.

Whether the rate arrives via an API or is typed in by the shop each morning is a **[DECIDE]** in Phase 2; the schema supports both, and `source: "manual"` should be the day-one default because it needs no third-party dependency and matches how the shop already works.

### 7.4 Price quotes — the rate lock

This is the table that solves the gold-rate volatility problem. **The price a customer sees at checkout must be honoured for a bounded window, and that window must be represented in the database, not in a comment.**

```ts
export const priceQuotes = sqliteTable("price_quotes", {
  id: text("id").primaryKey(),
  cartId: text("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  /** Frozen totals, in paise. */
  itemsSubtotalPaise: integer("items_subtotal_paise").notNull(),
  makingChargesPaise: integer("making_charges_paise").notNull(),
  stoneValuePaise: integer("stone_value_paise").notNull(),
  hallmarkingPaise: integer("hallmarking_paise").notNull().default(0),
  discountPaise: integer("discount_paise").notNull().default(0),
  shippingPaise: integer("shipping_paise").notNull().default(0),
  taxablePaise: integer("taxable_paise").notNull(),
  gstRateBps: integer("gst_rate_bps").notNull(),
  gstPaise: integer("gst_paise").notNull(),
  totalPaise: integer("total_paise").notNull(),
  /** Line-level frozen inputs, JSON, so the quote is self-contained. */
  linesJson: text("lines_json").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  expiresAt: text("expires_at").notNull(),
  status: text("status", { enum: ["active", "consumed", "expired"] }).notNull().default("active"),
}, (t) => [index("price_quotes_cart_status_idx").on(t.cartId, t.status)]);
```

Flow: customer clicks *Proceed to pay* → server recomputes from the **current** rate → writes a quote with `expires_at = now + N minutes` → the payment gateway order is created for exactly `totalPaise` → on webhook, the server verifies `quote.status = 'active' AND expiresAt > now` before converting to an order. If the quote has expired, the payment is **refunded**, not force-fitted. Never accept a payment against an expired quote and never silently re-price upward after payment — that is both a consumer-law problem (§4) and a trust catastrophe.

The window length is a **[DECIDE]** informed by §2.

### 7.5 Customers, carts

```ts
export const customers = sqliteTable("customers", {
  id: text("id").primaryKey(),
  phone: text("phone").notNull().unique(),            // E.164, reuse normalisePhone() from the appointments route
  email: text("email"),
  name: text("name"),
  /** DPDP §4/§5 — record that notice was shown and consent taken, and for what. */
  consentVersion: text("consent_version"),
  consentAt: text("consent_at"),
  marketingOptIn: integer("marketing_opt_in", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  /** DPDP erasure: set when the customer requests deletion; a scheduled job redacts PII. */
  deletionRequestedAt: text("deletion_requested_at"),
}, (t) => [index("customers_email_idx").on(t.email)]);

export const carts = sqliteTable("carts", {
  id: text("id").primaryKey(),                        // opaque; the signed cookie carries this
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  status: text("status", { enum: ["open", "converted", "abandoned"] }).notNull().default("open"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [index("carts_status_updated_idx").on(t.status, t.updatedAt)]);

export const cartItems = sqliteTable("cart_items", {
  id: text("id").primaryKey(),
  cartId: text("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  variantId: text("variant_id").notNull().references(() => variants.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(1),
  /** NOT the price of record — only for "the price of this item changed" messaging. */
  quotedUnitPricePaise: integer("quoted_unit_price_paise"),
  quotedAt: text("quoted_at"),
  addedAt: text("added_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [uniqueIndex("cart_items_cart_variant_idx").on(t.cartId, t.variantId)]);
```

**Deliberate: the cart does *not* snapshot price.** Freezing price at add-to-cart means a cart abandoned for three weeks resurrects at a stale gold rate — you either eat the loss or surprise the customer. Instead, recompute on every cart view and, when `quotedUnitPricePaise` differs from the fresh figure, show an explicit "the gold rate has changed since you added this" notice. That is honest, and it is what the price-validity model in §2 implies.

### 7.6 Orders and order line items — **where the snapshotting happens**

```ts
export const orders = sqliteTable("orders", {
  id: text("id").primaryKey(),
  orderNumber: text("order_number").notNull().unique(),  // human-facing: "AJ-2607-0042"
  customerId: text("customer_id").references(() => customers.id, { onDelete: "set null" }),
  quoteId: text("quote_id").references(() => priceQuotes.id),

  // --- Snapshotted contact + address (NOT foreign keys) ---
  contactName: text("contact_name").notNull(),
  contactPhone: text("contact_phone").notNull(),
  contactEmail: text("contact_email"),
  shipName: text("ship_name").notNull(),
  shipLine1: text("ship_line1").notNull(),
  shipLine2: text("ship_line2"),
  shipCity: text("ship_city").notNull(),
  shipState: text("ship_state").notNull(),
  shipPincode: text("ship_pincode").notNull(),
  shipCountry: text("ship_country").notNull().default("IN"),
  billingSameAsShipping: integer("billing_same_as_shipping", { mode: "boolean" }).notNull().default(true),
  billingJson: text("billing_json"),
  customerGstin: text("customer_gstin"),                // B2B buyers ask for this

  // --- Snapshotted money (paise) ---
  itemsSubtotalPaise: integer("items_subtotal_paise").notNull(),
  makingChargesPaise: integer("making_charges_paise").notNull(),
  stoneValuePaise: integer("stone_value_paise").notNull(),
  hallmarkingPaise: integer("hallmarking_paise").notNull().default(0),
  discountPaise: integer("discount_paise").notNull().default(0),
  shippingPaise: integer("shipping_paise").notNull().default(0),
  taxablePaise: integer("taxable_paise").notNull(),
  gstRateBps: integer("gst_rate_bps").notNull(),
  cgstPaise: integer("cgst_paise").notNull().default(0),
  sgstPaise: integer("sgst_paise").notNull().default(0),
  igstPaise: integer("igst_paise").notNull().default(0),
  totalPaise: integer("total_paise").notNull(),
  currency: text("currency").notNull().default("INR"),
  placeOfSupplyStateCode: text("place_of_supply_state_code"),  // decides CGST+SGST vs IGST

  // --- State ---
  status: text("status", {
    enum: ["pending_payment", "paid", "confirmed", "in_production", "shipped", "delivered", "cancelled", "refunded", "failed"],
  }).notNull().default("pending_payment"),
  paymentStatus: text("payment_status", {
    enum: ["unpaid", "authorized", "captured", "partially_refunded", "refunded", "failed"],
  }).notNull().default("unpaid"),
  fulfilmentStatus: text("fulfilment_status", {
    enum: ["unfulfilled", "partially_fulfilled", "fulfilled", "returned"],
  }).notNull().default("unfulfilled"),

  notes: text("notes"),
  placedAt: text("placed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  index("orders_status_placed_idx").on(t.status, t.placedAt),
  index("orders_customer_idx").on(t.customerId),
  index("orders_phone_idx").on(t.contactPhone),
]);
```

```ts
export const orderItems = sqliteTable("order_items", {
  id: text("id").primaryKey(),
  orderId: text("order_id").notNull().references(() => orders.id, { onDelete: "cascade" }),

  // --- Weak references, for reporting only. Nothing below is read from them. ---
  productId: text("product_id"),
  variantId: text("variant_id"),

  // ================= FULL SNAPSHOT =================
  sku: text("sku").notNull(),
  titleSnapshot: text("title_snapshot").notNull(),
  variantDescriptionSnapshot: text("variant_description_snapshot"),
  imageR2KeySnapshot: text("image_r2_key_snapshot"),

  metalSnapshot: text("metal_snapshot"),
  puritySnapshot: text("purity_snapshot"),
  netMetalWeightMg: integer("net_metal_weight_mg"),
  grossWeightMg: integer("gross_weight_mg"),

  /** The exact rate row used. Reconstructs the invoice forever. */
  goldRateId: text("gold_rate_id").references(() => goldRates.id),
  goldRatePerGramPaise: integer("gold_rate_per_gram_paise"),

  metalValuePaise: integer("metal_value_paise").notNull().default(0),
  makingChargeType: text("making_charge_type"),
  makingChargeValue: integer("making_charge_value"),
  makingChargePaise: integer("making_charge_paise").notNull().default(0),
  stoneValuePaise: integer("stone_value_paise").notNull().default(0),
  hallmarkingPaise: integer("hallmarking_paise").notNull().default(0),
  otherChargesPaise: integer("other_charges_paise").notNull().default(0),

  huidSnapshot: text("huid_snapshot"),
  certificateNumberSnapshot: text("certificate_number_snapshot"),
  diamondOriginSnapshot: text("diamond_origin_snapshot"),
  hsnCode: text("hsn_code"),                          // 7113 etc., see §4

  quantity: integer("quantity").notNull().default(1),
  unitPricePaise: integer("unit_price_paise").notNull(),
  lineSubtotalPaise: integer("line_subtotal_paise").notNull(),
  lineGstRateBps: integer("line_gst_rate_bps").notNull(),
  lineGstPaise: integer("line_gst_paise").notNull(),
  lineTotalPaise: integer("line_total_paise").notNull(),
  // =================================================
}, (t) => [index("order_items_order_idx").on(t.orderId)]);
```

**Where price is snapshotted, and exactly why:**

| Snapshot point | What is frozen | Why |
|---|---|---|
| `gold_rates` (append-only) | rate per gram, per purity, with `effective_from`/`effective_to` | The rate is itself a historical fact. Overwriting it destroys the ability to audit any past order |
| `price_quotes` | full order-level totals + `lines_json` + `expires_at` | The customer is shown a number and a validity window. The gateway order is created for this exact amount. Without it, the amount charged and the amount agreed can drift between page render and payment capture |
| `order_items` (**the critical one**) | product title, SKU, image key, metal, purity, both weights, `gold_rate_id` **and** the rate value, making-charge config *and* the computed amount, stone value, hallmarking, HUID, certificate number, HSN, unit price, GST rate, GST amount, line total | Four independent reasons: (1) the gold rate moves daily, so a join to `variants` reprices the past; (2) a GST invoice is a statutory document that must be reproducible years later; (3) the admin **will** edit product titles, weights and photos, and must not retroactively rewrite what a customer bought; (4) deleting or archiving a product must not orphan or corrupt an order |
| `orders` (address + contact inline, not FK) | name, phone, email, full shipping address, GSTIN, place of supply | A customer moving house must not change where a past order was shipped. Place of supply determines CGST+SGST vs IGST and cannot be re-derived later |
| `cart_items` | **deliberately NOT the price of record** | Freezing at add-to-cart resurrects stale rates from abandoned carts. Store `quotedUnitPricePaise` only to detect and *disclose* change |

Store both `goldRateId` **and** the denormalised `goldRatePerGramPaise`. The FK proves provenance; the value survives even if a rate row is ever purged. Belt and braces on the one number the whole invoice hangs off.

### 7.7 Payments, stock reservations, and D1's missing transactions

```ts
export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(),
  orderId: text("order_id").references(() => orders.id, { onDelete: "set null" }),
  quoteId: text("quote_id").references(() => priceQuotes.id),
  provider: text("provider", { enum: ["razorpay", "cashfree", "payu", "manual"] }).notNull(),
  providerOrderId: text("provider_order_id"),
  providerPaymentId: text("provider_payment_id"),
  method: text("method"),                             // upi | card | netbanking | emi
  amountPaise: integer("amount_paise").notNull(),
  status: text("status", { enum: ["created", "authorized", "captured", "failed", "refunded"] }).notNull(),
  /** Raw gateway payload, for dispute forensics. Watch the 2 MB D1 row cap. */
  rawPayloadJson: text("raw_payload_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  uniqueIndex("payments_provider_payment_idx").on(t.provider, t.providerPaymentId),
  index("payments_order_idx").on(t.orderId),
]);

/** Webhook idempotency. Gateways retry; without this you double-fulfil. */
export const webhookEvents = sqliteTable("webhook_events", {
  id: text("id").primaryKey(),                        // provider event id — natural PK
  provider: text("provider").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  processedAt: text("processed_at"),
  receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

/** Short-TTL hold on a one-of-a-kind piece during checkout. */
export const stockReservations = sqliteTable("stock_reservations", {
  id: text("id").primaryKey(),
  variantId: text("variant_id").notNull().references(() => variants.id, { onDelete: "cascade" }),
  cartId: text("cart_id").notNull().references(() => carts.id, { onDelete: "cascade" }),
  quantity: integer("quantity").notNull().default(1),
  status: text("status", { enum: ["held", "consumed", "released"] }).notNull().default("held"),
  expiresAt: text("expires_at").notNull(),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [
  /** THE concurrency primitive: at most one live hold per variant, enforced by SQLite. */
  uniqueIndex("stock_reservations_active_idx").on(t.variantId).where(sql`status = 'held'`),
]);
```

Because D1 has no interactive transactions (§0.2), you cannot do "read stock, decide, then write" safely. The pattern that *does* work:

1. **Claim** — `INSERT INTO stock_reservations (…) ON CONFLICT DO NOTHING`. The partial unique index means the database, not your code, decides who wins the race. Check `meta.changes === 1`. **This is why one-of-a-kind inventory is safe here** — for a single piece the reservation *is* the lock.
2. **Quote + gateway order** — create the `price_quotes` row and the Razorpay/Cashfree order.
3. **On verified webhook** — one `db.batch([...])` containing: insert `orders`, insert every `order_items` row, update `payments`, decrement `variants.stock_quantity` with a guarded `WHERE stock_quantity >= ?`, mark the reservation `consumed`, mark the quote `consumed`, mark the cart `converted`. One batch = one transaction.
4. **Expiry sweep** — release stale `held` reservations. **[DECIDE]** Workers Cron Triggers are the natural home, but I could not verify whether the OpenAI Sites control plane lets you configure one (`dist/server/wrangler.json` shows `"triggers": {}`). **[UNVERIFIED]** Fallback: sweep lazily on cart read, which is uglier but needs no platform feature.

Watch the **100-bound-parameter cap** in step 3: one `INSERT` per line item inside the batch, never a single multi-row insert.

### 7.8 Appointments — keep, don't touch

`appointments` (`db/schema.ts`) already works, is indexed for its flood guard, and the `/api/appointments` route has a considered fail-open design. **Leave it alone.** Add an admin list view over it and, if anything, one `assignedTo` column. Per §1, the appointment flow is likely to remain the *primary* conversion path for high-value Jadau and Polki — the store augments it, it does not replace it.

### 7.9 Admin users and audit

```ts
export const adminUsers = sqliteTable("admin_users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),            // store lowercased; compare lowercased
  displayName: text("display_name"),
  role: text("role", { enum: ["owner", "manager", "staff"] }).notNull().default("staff"),
  isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  lastSeenAt: text("last_seen_at"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const adminAuditLog = sqliteTable("admin_audit_log", {
  id: text("id").primaryKey(),
  actorEmail: text("actor_email").notNull(),
  action: text("action").notNull(),                   // "order.status_changed", "rate.updated"
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  diffJson: text("diff_json"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
}, (t) => [index("admin_audit_created_idx").on(t.createdAt)]);
```

The audit log is not optional polish. Two admins, one gold rate, and real money moving — you will need to answer "who changed the 22K rate at 4pm and why did that order price differ." It also gives you a defensible answer under DPDP for who accessed customer data.

### 7.10 Migration mechanics on this platform

`npm run db:generate` writes to `drizzle/`; the sites plugin copies it to `dist/.openai/drizzle`; the platform applies it on deploy (`build/sites-vite-plugin.ts:36-40`). Consequences:

- **Migrations are forward-only in practice.** There is no `drizzle-kit migrate` you run yourself and no visible rollback. Get the schema right before the first order exists.
- **SQLite `ALTER TABLE` is limited** — no drop-column-with-constraints, no type change. Drizzle emits the 12-step table-rebuild dance, which on a live table is a real risk. Prefer additive changes.
- **D1 Time Travel** gives 30 days of point-in-time restore on paid, 7 on free ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)). That is your only safety net. Know how to use it *before* you need it.

---

## 8. Library recommendations

All figures from the npm registry and downloads API, fetched 2026-07-27. "Published" is the publish date of the current `latest`.

### 8.1 Recommended

| Purpose | Package | Version | Published | Downloads/wk | Workers? | Note |
|---|---|---|---|---|---|---|
| Schema validation | **`zod`** | 4.4.3 | 2026-05-04 | 240.5M | ✅ pure JS, zero deps | The default. v4 is a substantial rewrite with a much smaller core. Standard Schema compliant |
| ↳ lighter alternative | `valibot` | 1.4.2 | 2026-06-28 | 15.6M | ✅ | Modular, tree-shakes to a fraction of Zod. Worth it only if the 3 MB script budget bites |
| Drizzle ↔ Zod bridge | **`drizzle-zod`** | 0.8.3 | 2025-08-06 | 2.1M | ✅ | Derives insert/select schemas from the tables above — one source of truth. ⚠️ **13 months since publish, just outside the freshness bar.** Low risk (thin adapter), but flag it |
| ID generation | **`nanoid`** | 6.0.0 | 2026-07-12 | 226.8M | ✅ uses WebCrypto | For all the `text` primary keys in §7 |
| Money arithmetic | **`decimal.js`** | 10.6.0 | 2025-07-06 | 74.5M | ✅ pure JS | Only if integer-paise arithmetic proves insufficient. **Prefer plain integers** (§7.0) and skip this |
| Admin tables | **`@tanstack/react-table`** | 8.21.3 | 2025-04-14 | 17.4M | ✅ headless, no styles | ⚠️ **15 months since publish.** Headless and stable, but for a 5-screen admin, hand-written `<table>` markup against the existing CSS is genuinely simpler. **[DECIDE]** |
| Admin forms | **`react-hook-form`** | 7.83.0 | 2026-07-25 | 57.6M | ✅ client-only | Pair with `@hookform/resolvers` 5.5.7 (2026-07-26) for Zod. Only if Server Actions + `useActionState` prove too coarse for the product editor |
| Payments | **Raw `fetch` to the REST API** | — | — | — | ✅ | See §3 and §8.3 |

### 8.2 Already in the tree — leave as-is

`drizzle-orm` 0.45.2 (16.4M/wk, published 2026-03-27) is current and is the correct D1 ORM. `next` 16.2.6, `react` 19.2.6 are pinned by the starter — don't drift them independently of `vinext`.

### 8.3 ⚠️ Will NOT work here, or will hurt

| Package | Why it fails on this stack |
|---|---|
| **`razorpay`** (2.9.8, 373k/wk) | **Depends on `axios` ^1.18.1.** Axios selects a transport adapter at runtime; on Workers it finds neither a real XHR nor a complete Node `http`, and behaviour under `nodejs_compat` is inconsistent. The published build is also a Babel-compiled CJS bundle (`dist/razorpay.js`, no ESM `module`/`exports` field), which is exactly the shape that breaks Workers bundling. **Use plain `fetch` against Razorpay's REST API instead** — it is HTTP Basic auth with `key_id:key_secret`, which is three lines. See §3 |
| **`cashfree-pg`** (6.0.4, 14.7k/wk) | Same class of problem plus very thin adoption. Use the REST API |
| **`stripe`** (22.3.2, 16.5M/wk) | The SDK does have a Workers/fetch path, but Stripe India is the wrong commercial choice — see §3 |
| **Payload CMS / Strapi / Directus / Medusa** | Node servers or full Next.js ownership; conflict with vinext; Payload additionally needs Workers Paid for script size ([README](https://github.com/payloadcms/payload/blob/main/templates/with-cloudflare-d1/README.md)) |
| **`next-auth` v4** (4.24.15) | Node crypto + Next.js internals. Do not attempt against a Next reimplementation |
| **`better-auth`** (1.6.25, 6.2M/wk) | Works on Workers in principle, but brings a route surface that fights vinext's router and eats the script budget for a feature (§5.4) SIWC already provides |
| **`bcrypt` / `argon2` / `bcryptjs`** | Native modules (first two) are impossible; `bcryptjs` is pure JS but deliberately CPU-expensive — **fatal against the 10 ms free-tier CPU limit** ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/)). If you ever need password hashing, use WebCrypto PBKDF2 with a tuned iteration count on the paid plan |
| **`sharp` / `jimp` / `canvas`** | Native bindings, and image work belongs in the Images binding anyway (§6) |
| **`pdfkit`, `puppeteer`, `@react-pdf/renderer`** | Node/Chromium. For GST invoice PDFs: render server-side HTML and let the customer print-to-PDF, or use Cloudflare Browser Rendering as a separate paid service. **[DECIDE]** |
| **`aws4fetch`** (1.0.20, 5.6M/wk) | Works fine and is Workers-native, but **last published 2024-08-28 — ~23 months stale.** Only needed for the presigned-URL flow in §6.2B, which I recommend skipping |
| **Any `pg` / `mysql2` / Prisma-with-engine** | TCP sockets and native engines. Not applicable — you're on D1 |
| **`hono`** (4.12.32, 52.7M/wk) | Excellent and perfectly Workers-native, but **you already have vinext's router**. Adding it means two routers. Skip |

### 8.4 Bundle-size discipline

The free-plan Worker script limit is **3 MB compressed** (`10 MB` paid). The app bundle, `drizzle-orm`, `zod`, and React server components all land in it. Every dependency added is script budget spent. Measure `dist/server/index.js` after each addition — a build that suddenly fails to deploy with a size error at 2am is the failure mode here.

---

## 9. Antipatterns — what to deliberately not do

### 9.1 Pricing and money (the ones that cost real money)

| Antipattern | Consequence | Do instead |
|---|---|---|
| **Storing money as `REAL`/float** | GST on a ₹4,20,000 order computed in floats produces invoices that don't foot by a rupee. In a statutory document that is a compliance problem, not a rounding nit | Integer paise everywhere (§7.0) |
| **Recomputing price at any point after the customer agreed to it** | Customer pays ₹4,20,000, the rate ticks up, the invoice prints ₹4,23,500. Guaranteed chargeback and a consumer-forum complaint | `price_quotes` with a hard `expires_at`; `order_items` fully snapshotted (§7.4, §7.6) |
| **Snapshotting price at add-to-cart** | A cart abandoned three weeks resurrects at a stale rate. You either eat the loss or ambush the customer at checkout | Recompute on cart view; store the old quote only to *disclose* the change (§7.5) |
| **Joining to `variants` to render a past order** | Editing a product weight silently rewrites order history and past invoices | Read only from `order_items` (§7.6) |
| **A single `price` column on the product** | Cannot show the weight/making/stone breakup that Indian buyers expect, cannot reprice on rate change, cannot produce a compliant invoice | Store pricing *inputs*, compute the price (§7.2) |
| **Mutating a gold-rate row** | Destroys the audit trail for every order priced from it | Append-only with `effective_from`/`effective_to` (§7.3) |
| **Rounding at each line then summing** | Line-level rounding drift makes the total disagree with the sum of lines | Compute in paise, round once, at a defined level, and store both line and order totals so they can be reconciled |

### 9.2 Inventory

- **Modelling one-of-a-kind stock as `quantity` with a read-then-write decrement.** D1 has no interactive transactions (§0.2), so two buyers can both read `stock = 1`. Selling the same antique Jadau set twice is unrecoverable — there is no second one. Use the partial-unique-index reservation in §7.7 and let SQLite arbitrate.
- **No reservation TTL.** Holds that never expire mean one abandoned checkout takes a unique piece off sale permanently.
- **Treating made-to-order and in-stock identically.** A made-to-order piece has no stock to reserve and a lead time that must be disclosed before payment.

### 9.3 Payments

- **Trusting the browser's "payment succeeded" callback.** The client can be replayed, spoofed, or simply lost when the customer closes the tab after paying. **The webhook is the source of truth**; the redirect is only a UX nicety.
- **Not verifying the webhook signature over the raw bytes.** Parsing the JSON first and re-serialising changes the byte representation and the HMAC will never match.
- **No webhook idempotency.** Gateways retry. Without the `webhook_events` table keyed on the provider event id (§7.7), a retry double-fulfils and double-decrements stock.
- **Creating the order before payment confirmation.** Leaves a table full of phantom orders and reserved stock.
- **Storing card data.** Never. There is no scenario where this application touches a PAN.
- **Putting gateway secrets in `NEXT_PUBLIC_*`.** vinext inlines those into the browser bundle (§0.3). The key id is public by design; the key **secret** and webhook secret are not.

### 9.4 Platform-specific traps on this stack

- **Assuming `drizzle.transaction()` works.** It throws on D1. Discovering this at checkout-integration time is a costly rewrite — design around `db.batch()` from day one (§0.2).
- **Multi-row inserts over the 100-bound-parameter cap.** Works for a 2-item cart, fails for a 6-item one (§0.2).
- **CPU-bound work in a request.** Password KDFs, PDF rendering, image processing in JS — all fatal against 10 ms on free tier (§8.3).
- **Forgetting the 50-subrequest cap on free tier.** Every D1 query, R2 get, and outbound `fetch` counts. An N+1 query over a product listing will hit it.
- **Not setting `httpMetadata.contentType` on R2 upload.** Every image then 400s at the optimizer (§6.3), and the failure is silent-ish.
- **Debugging image behaviour in `npm run dev`.** The dev server just 302-redirects `/_vinext/image` (§6.4). Production behaviour is entirely different.
- **Adding dependencies without watching the 3 MB compressed script limit** (§8.4).
- **Assuming the migration story is reversible.** Migrations are applied by the control plane, forward-only, with SQLite's weak `ALTER TABLE`. Get the schema right before real orders exist (§7.10).

### 9.5 Product and process

- **Replacing the appointment flow with a cart.** The existing flow converts high-value pieces; the store should sit alongside it, not on top of it. Keep `appointments` untouched (§7.8) and keep an "enquire / book a viewing" CTA on every high-value PDP.
- **Putting the entire catalogue online as buyable.** `products.sale_mode` exists precisely so the owner can choose per piece (§7.2).
- **Launching without a real photography plan.** For jewellery, the photograph *is* the product. A schema and a checkout cannot compensate for phone snapshots under shop lighting, and no amount of engineering fixes it afterwards.
- **Building customer accounts in v1.** Guest checkout with phone + address covers the actual need. Accounts add auth surface, DPDP obligations, and password-reset flows for near-zero conversion benefit at this scale.
- **Building an admin panel with more features than the shop will use.** The realistic surface is: see orders, mark them shipped, add/edit a piece, update today's gold rate, read appointments. Anything beyond that is unused code carrying real security surface.
