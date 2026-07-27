# 01 — Codebase Research: Alankar Jewellers

**Repo:** `/Users/architjain/alankar-jewellers`
**Date:** 2026-07-27
**Purpose:** map the ground before adding a storefront (browse / product / cart / checkout), an admin panel, a founders page, and a visual redesign.

Everything below was read from source. Where a claim about `vinext` behaviour could not be confirmed from `node_modules/vinext/dist`, it is labelled **UNVERIFIED** with the exact way to verify it.

---

## 0. TL;DR — the ten things that will actually shape the build

1. **`vinext` is a very high-fidelity Next.js 16 App Router implementation on Vite + workerd.** Route handlers, dynamic/catch-all routes, server actions, `proxy.ts`/`middleware.ts`, streaming, `generateStaticParams`, metadata file conventions, `cookies()` mutation in route handlers and actions — all implemented in `node_modules/vinext/dist`, not stubbed. Build the storefront as ordinary App Router code.
2. **Nothing is prerendered.** `vinext build` only prerenders when `--prerender-all` or `output: 'export'` is set (`node_modules/vinext/dist/cli.js:269`), and neither is. Every page request SSRs on the Worker. `dist/server/` contains no `prerendered-routes/` and no `vinext-prerender.json`. Product pages will hit D1 on every request unless you opt into ISR / `"use cache"`.
3. **There is no persistent cache backend.** The default cache handler is in-memory, per-isolate. `vinext/cloudflare` ships a `KVCacheHandler`, but `.openai/hosting.json` only accepts `d1` and `r2` — there is no KV binding available. ISR will work but will not be shared between isolates.
4. **`r2: null`.** No object storage. Product and founder imagery must be committed to `public/` (and is therefore in the git repo and the client asset bundle) unless the control plane is asked to enable R2.
5. **`worker/index.ts` references two bindings that do not exist in this project's Wrangler config** (`ASSETS`, `IMAGES`). See §7.1 — this makes `/_vinext/image` (i.e. `next/image` for local images) a 500, which is the real reason the codebase uses raw `<img>`.
6. **There is no type gate.** `npx tsc --noEmit` fails with 4 pre-existing errors and there is no `type-check` script, so nothing stops a type regression. See §7.2.
7. **Admin auth**: `app/chatgpt-auth.ts` is OpenAI-Sites Sign-in-with-ChatGPT, driven by request headers injected by the platform. It proves *identity*, not *authorisation*, and it depends on the owner having a ChatGPT account. `.claude-protocol/decisions.json` already chose password + signed WebCrypto cookie instead — that is compatible with the runtime (§5.4).
8. **Migrations have no runner.** `drizzle-kit generate` writes SQL to `drizzle/`; `build/sites-vite-plugin.ts` copies `drizzle/` into `dist/.openai/drizzle`; the control plane applies it on deploy. Locally you must apply SQL by hand. See §6.
9. **The CSS is 1,677 lines of hand-written BEM with 11 `:root` tokens** — colour + font family only. No spacing, radius, shadow, or type scale tokens. A redesign that adds ~20 commerce screens needs that scale defined first, or the file will double.
10. **All of yesterday's refactor is uncommitted** (`git status` shows 13 modified/deleted + 6 untracked paths against a single commit `453457c`). Commit before branching for new work.

---

## 1. Architecture map

### 1.1 Directory tree (excluding `node_modules`, `dist`, `.wrangler`, `.vinext`)

```
.
├── .openai/hosting.json          Control-plane binding declaration: d1="DB", r2=null
├── .claude-protocol/             Untracked planning state from the current protocol run
│   ├── state.json                phase/scope/toolchain + M1..M3 milestones
│   └── decisions.json            Locked product decisions (commerce model, admin auth, sequencing)
├── app/                          Next.js App Router root
│   ├── layout.tsx                Root layout: <html>/<body>, Metadata export, JSON-LD injection
│   ├── page.tsx                  The entire marketing site (single server component)
│   ├── globals.css               1,677 lines, hand-written BEM, imported by layout.tsx:2
│   ├── site-config.ts            Single source of truth for real-world business facts
│   ├── chatgpt-auth.ts           OpenAI Sites SIWC helpers (see §5.5)
│   ├── robots.ts                 Metadata file route -> /robots.txt
│   ├── sitemap.ts                Metadata file route -> /sitemap.xml
│   ├── _components/              Private folder (leading _ => never routed)
│   │   ├── appointment.tsx       "use client" — context + trigger + dialog (the only real island)
│   │   ├── site-header.tsx       "use client" — menu toggle
│   │   ├── brand-mark.tsx        Server component, deliberately no "use client"
│   │   └── contact-details.tsx   Server component, reads SITE_DETAILS_PENDING
│   ├── _seo/structured-data.ts   JewelryStore JSON-LD builder + script-safe serialiser
│   └── api/appointments/route.ts POST/GET route handler — the only write endpoint
├── db/
│   ├── index.ts                  getDb() — drizzle(env.DB) via cloudflare:workers
│   └── schema.ts                 One table: appointments
├── drizzle/
│   ├── 0000_many_nightmare.sql   The only migration
│   └── meta/{_journal,0000_snapshot}.json
├── examples/d1/                  Starter leftovers (notes table + notes route). Dead code.
├── worker/index.ts               Cloudflare Worker fetch entry
├── build/sites-vite-plugin.ts    Post-build: copies .openai/hosting.json + drizzle/ into dist/.openai
├── tests/                        node:test suite driving the built Worker in-process
│   ├── setup.mjs                 registerHooks — cloudflare:workers module stub
│   ├── helpers.mjs               fetchWorker / renderPage / postJson
│   ├── stubs/cloudflare-workers.mjs
│   ├── appointments-api.test.mjs (9 tests)
│   └── rendered-html.test.mjs    (9 tests)
├── public/                       favicon.png, apple-touch-icon.png, og.png, images/*.webp
├── vite.config.ts                vinext() + sites() + cloudflare() plugin wiring
├── next.config.ts                Empty object. No options set.
├── drizzle.config.ts             out=./drizzle, schema=./db/schema.ts, dialect=sqlite
├── eslint.config.mjs             eslint-config-next core-web-vitals + typescript
├── tsconfig.json                 strict, moduleResolution=bundler, paths {"@/*": ["./*"]}
└── README.md                     UNTOUCHED starter boilerplate (titled "vinext-starter")
```

### 1.2 Entry points

**`worker/index.ts` (48 lines)** — the Cloudflare Worker `fetch` handler.

- Declares `interface Env { ASSETS: Fetcher; DB: D1Database; IMAGES: {...} }` (`worker/index.ts:5-15`). These are *local* interface declarations, not real ambient types — hence the `tsc` failures in §7.2.
- Intercepts `/_vinext/image` and delegates to `handleImageOptimization` from `vinext/server/image-optimization`, passing `env.ASSETS.fetch` as the asset fetcher and `env.IMAGES` as the transformer (`worker/index.ts:32-41`).
- Everything else falls through to `handler.fetch(request, env, ctx)` from `vinext/server/app-router-entry` (`worker/index.ts:43`).

This file is **verbatim the template that `vinext deploy` generates** (compare `node_modules/vinext/dist/deploy.js:276-330`). But this project does not use `vinext deploy` — it uses `vinext build` + the OpenAI control plane, and the Wrangler config comes from `vite.config.ts`. That mismatch is the bug in §7.1.

**`app/layout.tsx` (81 lines)** — root layout.
- `import "./globals.css"` at line 2. Single global stylesheet, no CSS modules, no Tailwind (`postcss.config.mjs` was deleted in the refactor).
- `export const metadata: Metadata` with `metadataBase: new URL(site.url)` (line 14) — the comment at lines 12-13 records why: without it every `og:image`/canonical resolves relative and social previews break. `tests/rendered-html.test.mjs:47-66` is the regression guard.
- Injects the `JewelryStore` JSON-LD as a `<script type="application/ld+json">` at the end of `<body>` (lines 71-76).
- `lang="en-IN"`.

**`app/page.tsx` (280 lines)** — the whole marketing site as one default-exported server component. Data (`collections`, `milestones`) is defined as module-scope literal arrays (lines 13-79). Wraps everything in `<AppointmentProvider>` so the dialog is available anywhere, but the sections themselves stay server-rendered (the doc comment at lines 81-87 is explicit about this).

### 1.3 Request flow

```
Cloudflare edge
  └─ (assets.directory = dist/client — static files served before the Worker)
  └─ worker/index.ts fetch()
       ├─ /_vinext/image  → vinext image optimizer  [BROKEN, see §7.1]
       └─ * → vinext/server/app-router-entry
                ├─ open-redirect + URI-decode guards (app-router-entry.js:25-31)
                ├─ strips internal headers (filterInternalHeaders)
                ├─ runs `virtual:vinext-rsc-entry` — the generated App Router dispatcher
                │    ├─ proxy.ts / middleware.ts (if present — bundled at build time)
                │    ├─ metadata routes (/robots.txt, /sitemap.xml, ...)
                │    ├─ route handlers (route.ts)
                │    └─ page render → RSC → SSR stream → HTML
                └─ if the result signals a static asset and env.ASSETS exists, refetch it
```

---

## 2. `vinext` vs stock Next.js — verified feature support

`vinext@0.0.50` (`node_modules/vinext/`). Its README (`node_modules/vinext/README.md`, 47 KB) claims "~94% of the Next.js 16 API surface". I checked the claims that matter for this build against `dist/`.

### 2.1 Confirmed supported — build on these freely

| Feature | Verified at | Notes |
|---|---|---|
| **Route handlers (`route.ts`)** | `dist/server/app-route-handler-dispatch.js` (whole file); already proven by `app/api/appointments/route.ts` + 9 passing tests | Named method exports; auto-`OPTIONS` with `Allow` (lines 49-56); auto-`HEAD`; rejects non-HTTP methods with 400 (line 44-47); **warns in dev if you use a default export** (line 43). Pending `cookies().set()` are attached to the response. |
| **Dynamic / catch-all / optional-catch-all routes** | `dist/routing/route-pattern.js`, `dist/routing/route-trie.js`, `dist/routing/app-route-graph.js` | `[id]`, `[...slug]`, `[[...slug]]` all present in the trie matcher. |
| **Route groups `(group)`** | `dist/routing/app-route-graph.js` | URL-transparent; layouts still apply. Use `app/(shop)/...` and `app/(admin)/...` freely. |
| **Parallel routes `@slot` / intercepting routes** | `dist/routing/app-route-graph.js:262`, `:793-915` | `@`-prefixed dirs are excluded from routing and treated as slots; `default.tsx` supported. Useful for a cart drawer intercept, but this is the least-trodden path in the framework — treat as a stretch, not a foundation. |
| **`layout` / `template` / `loading` / `error` / `not-found` / `forbidden` / `unauthorized` / `default`** | `dist/routing/app-route-graph.js:503-510`, `:605-673` | Full nested-boundary discovery, per-layout-index. |
| **Private folders `_name`** | `dist/routing/app-route-graph.js:262`, `:461`, `:970`, `:1008` | `name.startsWith("_")` is excluded from route scanning. This is why `app/_components/` and `app/_seo/` are not routes. |
| **Server actions (`"use server"`)** | `dist/server/app-server-action-execution.js` | Real implementation: FormData + JSON payloads, `redirect()` inside actions (`ACTION_REDIRECT_HEADER`), revalidation signalling, CSRF origin validation (`validateCsrfOrigin`, imported line 3), 1000-argument cap, body-size limit → 413. |
| **`middleware.ts` / `proxy.ts`** | `dist/server/middleware.js:41-54`; bundled into the RSC entry at `dist/entries/app-rsc-entry.js:90`, `:636-641`; discovered at `dist/index.js:450` | **`proxy.ts` is preferred**; `middleware.ts` still works but logs `"[vinext] middleware.ts is deprecated in Next.js 16. Rename to proxy.ts"`. Matcher patterns (string/array/regex/`:param`/`:path*`/`:path+`) supported. Runs on the Worker, in the same isolate — not a separate edge runtime. |
| **Streaming SSR + Suspense** | `dist/server/app-ssr-stream.js`, `dist/server/rsc-stream-hints.js`, `dist/build/prerender.js` (RSC chunk embedding) | Both routers. `loading.tsx` works. |
| **`generateStaticParams`** | `dist/entries/app-rsc-entry.js:321-330`, `dist/server/app-page-request.js:28-70` | Works, **with a documented gap**: the generated `generateStaticParamsMap` only includes routes with a `pagePath` (leaf pages). **Layout-level `generateStaticParams` is not wired** — the TODO is in the source at `app-rsc-entry.js:325-329`. Also, since nothing is prerendered by default (§2.3), `generateStaticParams` currently only matters for `dynamicParams: false` enforcement. |
| **Metadata API** | `dist/shims/metadata.js`; already used in `app/layout.tsx` | `metadata`, `generateMetadata`, `viewport`, `generateViewport`, title templates. |
| **Metadata file conventions** | `dist/server/metadata-routes.js:23-120` (the full `METADATA_FILE_MAP`) | `sitemap.{ts,xml}`, `robots.{ts,txt}`, `manifest.{ts,json,webmanifest}`, `favicon.ico`, `icon.*`, `opengraph-image.*`, `twitter-image.*`, `apple-icon.*`. `sitemap`, `icon`, `opengraph-image` and `twitter-image` are `nestable: true` — i.e. you can put an `opengraph-image.tsx` inside `app/shop/[slug]/` for per-product social cards. `robots` and `manifest` are root-only. Proven live by `app/robots.ts` + `app/sitemap.ts` and `tests/rendered-html.test.mjs:152-162`. |
| **`cookies()` mutation in route handlers + server actions** | `dist/shims/headers.js:434-456` | `cookies()` returns *mutable* cookies when the phase allows (`_areCookiesMutableInCurrentPhase()`), read-only otherwise. Pending `Set-Cookie` values are drained by `getAndClearPendingCookies()` and attached by the dispatcher. **This is the mechanism the admin session must use.** Note `cookies()` calls `markDynamicUsage()` — any route reading cookies becomes dynamic. |
| **`headers()`** | `dist/shims/headers.js` | Async, as in Next 16. Used by `app/chatgpt-auth.ts:20`. |
| **Route segment config** | `dist/server/app-segment-config.js:1-80` | `dynamic` (`auto`/`error`/`force-dynamic`/`force-static`), `dynamicParams`, `revalidate`, `fetchCache` all honoured and reduced across the layout chain. **`runtime` and `preferredRegion` are silently ignored** (README "Known limitations"). |
| **`next/link`, `next/navigation`, `next/server`, `next/headers`, `next/form`, `next/script`, `next/dynamic`** | `dist/shims/*.js` | All real implementations. `useRouter`, `usePathname`, `useSearchParams`, `useParams`, `redirect`, `notFound`, `forbidden`, `unauthorized`. |
| **`"use cache"` / `cacheLife()` / `cacheTag()` / `revalidateTag` / `revalidatePath`** | `dist/shims/cache.js`, `dist/shims/cache-runtime.js`, `dist/server/isr-cache.js` | Implemented with stale-while-revalidate and deduped background regeneration. See the caveat in §2.4. |
| **Cloudflare bindings in server components** | `db/index.ts:1`; `node_modules/vinext/README.md` "Cloudflare Bindings" | `import { env } from "cloudflare:workers"` works in any server component, route handler or server action, because `@cloudflare/vite-plugin` runs the RSC environment in workerd. Confirmed live by `app/api/appointments/route.ts:1`. |

### 2.2 Partial / degraded

| Feature | Reality |
|---|---|
| **`next/image`** | Remote images go through `@unpic/react` (28 CDNs auto-detected). Local images get an `<img>` with a `srcSet` of `/_vinext/image?url=…&w=…&q=…` URLs (`dist/shims/image.js:196-208`, `:346`, `:415`). **In this project `/_vinext/image` is broken** (§7.1) — and even when the endpoint works, the fallback path just returns the *original, unresized* file (`dist/server/image-optimization.js:175-195`), so a broken `IMAGES` binding silently means "N requests for the same full-size file". No build-time image optimization exists at all. |
| **`next/font/google` / `next/font/local`** | Runtime CDN loading / runtime `@font-face` injection. No self-hosting, no subsetting, no `size-adjust` fallback metrics. Note: `vinext` has already downloaded Geist + Geist Mono into `.vinext/fonts/` and emitted them into `dist/client/assets/_vinext_fonts/` (11 woff2 files) even though **no source file imports `next/font`** — grep for `_vinext_fonts` in `dist/client/assets/*.{css,js}` returns zero hits. Dead weight in the asset bundle, harmless. |
| **i18n routing** | Pages Router only; no domain routing. Irrelevant here. |
| **`images` config in `next.config.ts`** | Parsed but not used for optimization. |

### 2.3 Prerendering — the single biggest deviation from stock Next

Stock Next.js statically prerenders every page it can at build time. **vinext does not, unless asked.**

`node_modules/vinext/dist/cli.js:268-280`:
```js
if (parsed.prerenderAll || resolvedNextConfig.output === "export") { … runPrerender(…) }
```

Neither is set here (`next.config.ts` is an empty object; `package.json:9` runs a bare `vinext build`). Confirmed empirically: `dist/server/` contains `index.js`, `wrangler.json`, `image-config.json`, `ssr/`, `assets/` — and **no `prerendered-routes/` directory and no `vinext-prerender.json`**.

Consequences for the storefront:

- Every `/shop`, `/shop/[slug]`, `/founders` request is a live SSR on the Worker.
- Every product page will issue its D1 query per request unless wrapped in `"use cache"` or given `export const revalidate = N`.
- `generateStaticParams` currently buys you nothing except `dynamicParams: false` enforcement.
- If you want static product pages, add `--prerender-all` to the build script — but understand that changes the deploy contract with the control plane. **UNVERIFIED**: whether the OpenAI Sites control plane invokes `npm run build` (and would therefore pick up a changed script) or its own `vinext build`. Verify by changing the script, deploying, and checking whether `dist/server/prerendered-routes/` appears in the deployed bundle.

### 2.4 Caching — no shared backend

`dist/server/isr-cache.js` implements ISR against a pluggable `CacheHandler`. The default is the in-memory `MemoryCacheHandler` (`dist/shims/cache.js`). `vinext/cloudflare` exports a `KVCacheHandler` (`dist/cloudflare/kv-cache-handler.js`) — but a KV namespace cannot be requested: `.openai/hosting.json` has exactly three keys (`project_id`, `d1`, `r2`) and `vite.config.ts:16` only destructures `{ d1, r2 }`.

So: `"use cache"` and `revalidate` will work, but the cache is per-isolate memory and evaporates constantly. **Treat D1 as the only durable store and design queries to be cheap**, rather than leaning on ISR.

### 2.5 Things vinext explicitly will not do

From `node_modules/vinext/README.md:545-556`: Vercel-specific features, AMP, legacy `next export`, webpack/Turbopack config, `next/jest`. Also: native Node modules (sharp, resvg, satori, `@napi-rs/canvas`) crash the RSC dev environment — so a **dynamic** `opengraph-image.tsx` using `next/og` will work in a production build but **not in `npm run dev`**. Static `opengraph-image.png` files are fine everywhere.

---

## 3. Tech stack — exact versions

From `package.json` and `package-lock.json` (lockfileVersion 3). All dependency versions are **pinned exactly** — no carets. Keep it that way.

| Package | Version | Role |
|---|---|---|
| `next` | 16.2.6 | Types + `next/*` module specifiers only; the runtime is vinext |
| `react` / `react-dom` | 19.2.6 | RSC-capable React |
| `vinext` | 0.0.50 | The actual framework runtime (`dev`/`build`/`start`) |
| `vite` | 8.0.13 | Bundler |
| `@vitejs/plugin-rsc` | 0.5.26 | RSC transform |
| `@vitejs/plugin-react` | 6.0.2 | |
| `react-server-dom-webpack` | 19.2.6 | RSC wire format |
| `@cloudflare/vite-plugin` | 1.37.1 | Runs the `rsc` environment inside workerd |
| `wrangler` | 4.92.0 | Miniflare/workerd host |
| `workerd` (transitive) | 1.20260515.1 | |
| `miniflare` (transitive) | 4.20260515.0 | |
| `drizzle-orm` | 0.45.2 | D1 query builder |
| `drizzle-kit` | 0.31.10 | Migration generator (dev only) |
| `typescript` | 5.9.3 | |
| `eslint` | 9.39.4 + `eslint-config-next` 16.2.6 | |
| `@unpic/react` (transitive of vinext) | 1.0.2 | Remote-image handling behind `next/image` |

- **Node engine: `>=22.13.0`** (`package.json:5-7`). `vinext` itself requires `>=22`.
- `"type": "module"` — everything is ESM. Tests are `.mjs`.
- **Workers runtime implications:** no Node built-ins except what `nodejs_compat` provides (`vite.config.ts:20`). No filesystem, no long-lived process memory you can trust, no `bcrypt`/`argon2` native modules. Use **WebCrypto (`crypto.subtle`)** for password hashing (PBKDF2 is available; scrypt/argon2 are not) and HMAC session signing. CPU time per request is bounded — do not iterate PBKDF2 into the hundreds of thousands without measuring.
- Compatibility date on the generated worker: `2026-05-15`, flags `["nodejs_compat"]` (`dist/server/wrangler.json`).

### Scripts (`package.json:8-15`)

```
dev          WRANGLER_LOG_PATH=.wrangler/wrangler.log vinext dev     # serves on :3000, not :5173
build        …vinext build
start        …vinext start
test         npm run build && node --import ./tests/setup.mjs --test tests/*.test.mjs
lint         eslint . --ignore-pattern dist --ignore-pattern .next
db:generate  drizzle-kit generate
```

Default dev port is 3000 (`node_modules/vinext/dist/cli.js:298`). **There is no `type-check` script** — see §7.2.

---

## 4. Code conventions

Anyone adding code must match these. They are consistent across every file and were clearly applied deliberately.

### 4.1 Naming & file layout

- Route-adjacent, non-routed code lives in **underscore-prefixed private folders**: `app/_components/`, `app/_seo/`. Keep that. New shared code should go in `app/_components/`, `app/_lib/`, `app/_seo/` — not a top-level `src/` or `lib/`.
- Files: `kebab-case.tsx` (`site-header.tsx`, `contact-details.tsx`, `structured-data.ts`, `site-config.ts`).
- Components: `PascalCase`, exported as **named** exports (`export function ContactDetails`). The only default exports are the ones the framework requires: `app/page.tsx`, `app/layout.tsx`, `app/robots.ts`, `app/sitemap.ts`.
- Types: `PascalCase` (`Interest`, `Lead`, `Status`, `ChatGPTUser`), derived from const arrays where possible: `export type Interest = (typeof INTEREST_OPTIONS)[number]` (`app/_components/appointment.tsx:15-22`).
- Module-scope constants: `SCREAMING_SNAKE` (`INTEREST_OPTIONS`, `FOCUSABLE_SELECTOR`, `DUPLICATE_WINDOW`, `DAILY_LIMIT_PER_PHONE`, `GENERIC_ERROR`, `SITE_DETAILS_PENDING`).
- **Comment style is load-bearing.** Nearly every non-obvious decision carries a comment explaining *why*, often naming the bug it prevents — e.g. `app/layout.tsx:12-13`, `app/page.tsx:1-6`, `app/api/appointments/route.ts:69-79`, `app/globals.css:1-5`, `globals.css:1273-1276`. Match this. It is the single most distinctive convention in the repo.
- British/Indian English in user-facing copy ("jewellery", "normalise", "personalised"), typographic apostrophes (`’`) and en-dashes in prose.

### 4.2 Server-component / client-island split

The pattern is: **the page is a server component; interactivity is pushed into the smallest possible `"use client"` leaf; server-rendered content is passed through client components as `children` so it never enters the client bundle.**

- `app/page.tsx` has no `"use client"`. It wraps everything in `<AppointmentProvider>` (`app/page.tsx:90`), whose implementation renders `{children}` verbatim (`appointment.tsx:84`). The static sections are therefore server-rendered and merely *forwarded* through the provider — costing zero client JS. The doc comment at `app/page.tsx:81-87` states this explicitly, and `tests/rendered-html.test.mjs:26-45` enforces it.
- Only three modules are client: `appointment.tsx`, `site-header.tsx`, and `brand-mark.tsx` *transitively* (it has no directive of its own — `brand-mark.tsx:1-5` explains that it renders as a server component in `page.tsx` and only enters the client bundle where `site-header.tsx` imports it).
- Confirmed in the build output: `dist/client/assets/` contains exactly `appointment-*.js`, `site-header-*.js`, `index-*.js`, `framework-*.js`, `layout-segment-context-*.js`, `rolldown-runtime-*.js`.

**For the storefront:** keep product listing/detail pages as server components reading D1 directly; make the cart/quantity/add-to-cart controls the client islands. Do not turn a whole page into a client component to get one button.

### 4.3 CSS methodology

Hand-written BEM in one file: `app/globals.css`, 1,677 lines, imported once at `app/layout.tsx:2`. **No CSS framework** — `postcss.config.mjs` was deleted in the refactor and the header comment (lines 1-5) explains the reset block replaces the handful of Tailwind preflight rules the design depended on.

**Existing tokens — the complete `:root` set (`app/globals.css:7-18`):**

| Token | Value | Used for |
|---|---|---|
| `--ink` | `#181311` | body text |
| `--black` | `#0c0908` | deepest backgrounds |
| `--garnet` | `#560f1b` | section labels, accents |
| `--garnet-deep` | `#380910` | dark section fills |
| `--gold` | `#c89b4b` | primary accent, focus ring |
| `--gold-soft` | `#d9b66e` | hover/secondary gold |
| `--parchment` | `#f3ebdd` | page background |
| `--parchment-light` | `#fbf7ef` | light text on dark |
| `--rule` | `rgba(184, 138, 68, 0.55)` | hairlines |
| `--serif` | `"Bodoni 72", Didot, "Iowan Old Style", "Times New Roman", serif` | display type |
| `--sans` | `"Helvetica Neue", Helvetica, Arial, sans-serif` | UI type |

That is the whole system. **There is no spacing scale, no radius scale, no shadow scale, no type scale, and no dark-mode surface.** 110 `var(--…)` references, but also ~16 unique hard-coded hex values and ~30 unique `rgba()` literals scattered through the file (e.g. `#635850`, `#655850`, `#776a60`, `#77685e`, `#574c46`, `#504640`, `#281a14` — seven near-identical warm greys). Fluid sizing is done with 35 hand-written `clamp()` calls rather than a scale.

**Naming:** strict BEM — `.block`, `.block__element`, `.block--modifier` (`.collection__frame`, `.brand-mark--compact`, `.contact__value--pending`, `.button--light`). Utility-ish primitives that exist and should be reused: `.section-shell` (page padding: `clamp(96px,11vw,160px) clamp(24px,6vw,96px)`, line 390), `.section-heading` (3-col grid, `max-width: 1280px`, line 403), `.section-label`, `.gold-rule`, `.button` + `--light`/`--dark`/`--gold`, `.visually-hidden`, `.form-wide`, `.form-error`.

**Breakpoints (max-width, mobile-last):** `1100px` (nav collapses to overlay — the comment at 1273-1276 records the 781-1100px dead zone bug this fixed), `780px`, `430px`, plus `@media (prefers-reduced-motion: reduce)` at 1664 which kills transitions/animations globally.

**Layout grid:** `.collection-list` is a 12-column grid at `max-width: 1360px` with `.collection { grid-column: span 4 }` (lines 443-453). A product grid should reuse this rather than inventing a second grid system.

> **Redesign note:** adding a storefront + admin to this file without first defining spacing/radius/type tokens will roughly double it and make the redesign unmaintainable. Extending `:root` is a strictly additive, low-risk first task.

### 4.4 Error handling shape

**API layer** (`app/api/appointments/route.ts`) — every response is `Response.json({ ok: boolean, error?: string }, { status })`:
- `400` for bad JSON / bad shape / failed validation, with a **human, customer-facing** error string ("Please tell us your name.", "Please enter a valid mobile number with at least 10 digits."). Never a machine code, never a field name.
- `201` on success — and also on honeypot hits (line 161) and throttled duplicates (line 228), deliberately indistinguishable from success so a bot learns nothing.
- `405` with an `Allow` header for the wrong method (lines 277-282).
- `500` only when *every* sink failed, with copy that gives the customer a way out ("Please call or WhatsApp us…", line 271).
- `toRouteErrorMessage()` (lines 17-33) translates a raw D1 "no such table" error into an actionable operator message naming `npm run db:generate`. Copy this helper shape for new tables.
- Failures are `console.error`'d with a `[appointments]` prefix (lines 99, 253, 260). **Adopt `[<domain>]` log prefixes** for new routes.
- **Fail-open guards, fail-closed writes.** The throttle check catches its own errors and returns `false` (lines 98-104) — "we would rather risk a duplicate row than drop a real customer's enquiry".

**Client layer** (`appointment.tsx:211-250`) — a `Status = "idle" | "pending" | "error" | "success"` state machine; the fetch is wrapped in try/catch; the response is `.json().catch(() => null)`; success requires **both** `response.ok` *and* `payload?.ok === true` (line 238); a `GENERIC_ERROR` constant is the fallback message. On error the dialog surfaces phone/WhatsApp fallbacks — but only if `SITE_DETAILS_PENDING` is false (lines 372-381).

**Notably absent:** there is no `app/error.tsx`, no `app/not-found.tsx`, no `app/loading.tsx`, and no `global-error.tsx`. A storefront with dynamic `[slug]` routes needs at least `not-found.tsx` and an `error.tsx`. vinext supports both (§2.1).

### 4.5 Validation approach

**Hand-rolled, no schema library.** There is no zod/valibot/yup in the dependency tree, and adding one is a real decision, not a default.

The existing style (`route.ts:35-56`, `:164-223`):
- `asTrimmedString(value: unknown)` coerces anything non-string to `""`.
- Each field is checked in order with an early `return Response.json({ok:false,error:…}, {status:400})`.
- Length caps are explicit constants in the message (`120`, `80`, `2000`).
- Domain normalisation lives in a named, documented function (`normalisePhone`, lines 39-56) that is **lenient by design** — accepts `+91`, leading `0`, spaces, hyphens, brackets, dots; returns `""` only when the input cannot plausibly be a number; keeps 10+-digit foreign numbers verbatim rather than rejecting an overseas client.

For checkout (address, pincode, quantity, price) you will have many more fields. Either (a) keep hand-rolled validators in a shared `app/_lib/validate.ts` following exactly this shape, or (b) introduce zod — but that is a dependency decision to surface, not to make silently, and it will change the error-response shape unless you map issues back to single customer-facing strings.

### 4.6 Testing pattern

See §8 for the mechanics. Conventions: `node:test` + `node:assert/strict`, `.mjs`, one file per surface, `assert.match(body.error, /pattern/i)` against the *customer-facing* copy, and a comment on every test explaining the bug it guards.

---

## 5. Existing functionality the new work overlaps or must reuse

### 5.1 The appointment dialog + `AppointmentProvider`

`app/_components/appointment.tsx` (400 lines) is the most reusable asset in the repo and the reference implementation for any modal you add (size guide, cart drawer, admin confirm).

What it already does correctly — **do not rebuild this badly**:
- Context exposing a single `open(interest?, trigger?)` function (`:41-54`), with a `useAppointment()` hook that throws a clear error outside the provider (`:48-54`).
- Dialog is **only mounted when open** (`:85-91`), so all its effects are naturally scoped.
- Focus moves into the first field on open and is **restored to the triggering element on unmount** (`:75-78`, `:146-150`) — the trigger element is captured at click time via `event.currentTarget` (`:112-115`).
- A real `Tab`/`Shift+Tab` focus trap that recomputes focusables each keypress and filters by `tabIndex >= 0 && getClientRects().length > 0` (`:169-209`).
- `Escape` closes; backdrop `onMouseDown` closes; the panel stops propagation (`:255`, `:263`).
- `document.body.style.overflow = "hidden"` with restore (`:159-165`).
- `role="dialog" aria-modal="true" aria-labelledby` + `tabIndex={-1}` on the panel.
- Focus re-homed to the success heading or the error alert when the form state changes (`:154-157`), because the submit button gets disabled and the form is replaced.
- Honeypot field inside `.visually-hidden` with `aria-hidden` + `tabIndex={-1}` + `autoComplete="off"` (`:347-360`).

**How to extend it:** the `Interest` union (`:15-22`) is the enquiry taxonomy and is consumed by `app/page.tsx:21` and `:32/:44/:54`. Product pages should offer "Enquire about this piece" — the cleanest extension is to widen `open()` to accept an optional product reference alongside `interest`, add a hidden `product` field to the form, and add a nullable `product_sku`/`product_id` column to `appointments`. Do **not** fork the dialog into a second component.

If the redesign introduces more than one dialog, promote the focus-trap/scroll-lock/restore-focus logic into a shared `useDialog()` hook in `app/_components/` rather than copy-pasting.

### 5.2 `POST /api/appointments`

`app/api/appointments/route.ts` (283 lines). The template for every write endpoint you add (`/api/orders`, `/api/cart`, admin mutations).

Pipeline, in order:
1. Parse JSON, 400 on failure (`:143-157`).
2. **Honeypot** — if `payload.company` is non-empty, return `201 {ok:true}` and do nothing (`:159-162`).
3. Field validation → 400 with human copy (`:164-223`).
4. **Throttle** — `isThrottled(phone)` (`:80-105`): one indexed D1 aggregate over `appointments` filtered to the last day for that phone, returning both `justNow` (submissions inside `DUPLICATE_WINDOW = "-3 minutes"`) and `today` (count, capped at `DAILY_LIMIT_PER_PHONE = 5`). Backed by the `appointments_phone_created_at_idx` index (`db/schema.ts:33`). **Fails open** on any error. Deliberately no IP-based limiting — the comment at `:69-79` says IP limiting belongs in a Cloudflare WAF rule because storing visitor IPs is PII the shop has no reason to hold.
5. Throttled → return `201 {ok:true}`, identical to success (`:227-229`).
6. **Dual sink** — `Promise.allSettled([persistLead(lead), notifyLead(lead)])` (`:244-247`). `persistLead` inserts into D1; `notifyLead` POSTs to `env.LEAD_WEBHOOK_URL` (optional, `:12-15`) with `{site:"alankar-jewellers", ...lead}` and throws on a non-2xx. **Either sink succeeding is a success**; only a double failure returns 500 (`:263-273`).
7. Request metadata harvested from headers: `user-agent`, `cf-ipcountry` (`:237-238`).

**Reuse for orders.** An order is a lead with money attached. Keep: honeypot, human error copy, `[domain]` logging, the fail-open throttle. **Change**: an order must NOT use the dual-sink "either is fine" semantics — a webhook-only order with no D1 row is a lost order. Orders must be **D1-write-or-fail**, with the webhook as a pure notification whose failure is logged and ignored. Say so explicitly in a comment, because it inverts the rule this file establishes.

`LEAD_WEBHOOK_URL` is documented in `.env.example` with setup instructions for Zapier/Make/n8n. An order webhook should follow the same documentation pattern.

### 5.3 `site-config.ts` + the `SITE_DETAILS_PENDING` convention

`app/site-config.ts` is the single source of truth for real-world facts, and `SITE_DETAILS_PENDING` (line 13) is an **honesty gate**: while true, no unverified business fact is presented as real.

The convention has three parts, and all three must be honoured by new work:
1. **Values marked `/** TODO */`** are placeholders: `url`, `phone`, `phoneDisplay`, `whatsapp`, `email`, every `address` field, `mapsUrl`, both social URLs.
2. **UI gating** — `contact-details.tsx:13-16` and `appointment.tsx:37-39` both widen the flag to `boolean` first (`const detailsPending: boolean = SITE_DETAILS_PENDING`) so TypeScript keeps both branches alive and flipping the flag is a one-line change. When pending, `tel:`/`wa.me`/maps hrefs are `null` and render as inert `<span>`s with a visible "Details pending" notice (`contact-details.tsx:26-33`). The stated reason: "a dead call button converts worse than an honest 'not live yet' label."
3. **Structured-data gating** — see §5.4.

**This is the precedent the storefront must follow for prices, weights, purity, making charges, founder names and bios.** `.claude-protocol/decisions.json` already commits to it ("No fabricated factual claims … presented as real"). Expect to need a second flag (e.g. `CATALOGUE_PENDING` / `FOUNDERS_PENDING`) rather than overloading `SITE_DETAILS_PENDING`, since the shop's phone number and the product catalogue will go live at different times.

`tests/rendered-html.test.mjs:78-97` enforces the gate in both directions — it reads the rendered HTML, detects which mode the site is in, and asserts the correct set of invariants. New gated facts should extend that test, not add a parallel one.

### 5.4 `JewelryStore` JSON-LD — and how to extend it for commerce

`app/_seo/structured-data.ts` (103 lines).

- `jewelryStoreJsonLd()` builds a `JewelryStore` (a `LocalBusiness` subtype) with a **stable node `@id`**: `` `${site.url}/#jewellery-store` `` (line 17). That `@id` is the anchor everything else should reference.
- Contact facts (`telephone`, `email`, `address`, `openingHoursSpecification`, `hasMap`, city-level `areaServed`) are **only emitted when `!detailsPending`** (lines 56-80). The header comment (lines 4-11) explains: placeholder LocalBusiness markup poisons Google Business Profile matching and can get the entity flagged.
- `sameAs` is omitted rather than emitted empty (lines 82-85).
- `serializeJsonLd()` (lines 95-102) escapes `<`, `>`, `&` and the U+2028/U+2029 line separators (legal in JSON, illegal in JS string literals) so the JSON cannot break out of the `<script>` context. **Every JSON-LD block must go through it.**

**How Product/Offer should extend this:**

1. Add sibling builders in the same file (or `app/_seo/product-structured-data.ts` if it grows): `productJsonLd(product)` returning `@type: "Product"` with `@id` = `` `${site.url}/shop/${slug}#product` ``, and a nested `offers: { "@type": "Offer", … }`.
2. **Tie the offer to the existing business node** rather than re-describing it: `offers.seller = { "@id": businessId }`. Export `businessId` from `structured-data.ts` (it is currently module-private at line 17) so there is exactly one business node identity in the graph.
3. **Gate price the same way contact facts are gated.** An `Offer` without `price`/`priceCurrency`/`availability` is legal schema; an `Offer` with a fabricated price is exactly the failure mode the file's honesty rule was written to prevent. While the catalogue is placeholder, emit the `Product` (name, image, description, `brand`, `material`) and either omit `offers` entirely or emit `availability: "https://schema.org/PreOrder"` with no price. Mirror the `if (!detailsPending)` structure literally.
4. `priceCurrency: "INR"` — consistent with `currenciesAccepted: "INR"` (line 45).
5. Emit the Product JSON-LD **from the product page**, not the root layout. The root layout's `JewelryStore` script (`layout.tsx:71-76`) should stay global; a product page adds its own `<script type="application/ld+json">` with the same `serializeJsonLd()` call. Consider also a `BreadcrumbList` for `/shop → category → product`.
6. **Do not emit `AggregateRating` or `Review`** — there are no reviews. Same honesty rule.
7. `app/sitemap.ts:4-6` says in a comment "add entries here as routes are added". Product/collection/founders routes must be added there; it is currently a hard-coded single entry.

### 5.5 `app/chatgpt-auth.ts` — read in full

87 lines. This is OpenAI-Sites "Sign in with ChatGPT" (SIWC), driven entirely by request headers the hosting platform injects.

- `getChatGPTUser()` (`:19-36`) — `await headers()`, reads `oai-authenticated-user-email`. Returns `null` if absent. Optionally decodes `oai-authenticated-user-full-name`, but **only** when `oai-authenticated-user-full-name-encoding === "percent-encoded-utf-8"` (`:24-29`), via a `safeDecodeURIComponent` that returns `null` on malformed input (`:80-86`). Returns `{ displayName: fullName ?? email, email, fullName }`.
- `requireChatGPTUser(returnTo)` (`:38-45`) — same, but `redirect(chatGPTSignInPath(returnTo))` when anonymous.
- `chatGPTSignInPath` / `chatGPTSignOutPath` (`:47-55`) — build `/signin-with-chatgpt?return_to=…` and `/signout-with-chatgpt?return_to=…`.
- `safeRelativeReturnPath` (`:57-70`) — rejects anything not starting with `/`, rejects protocol-relative `//`, parses against a sentinel origin `https://app.local` and rejects if the origin changed, and rejects the three reserved auth paths. Solid open-redirect defence.
- Reserved paths owned by the platform, which the app must **not** define routes for: `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback` (`:15-17`, `:72-78`).

**What it does not give you** (README lines 82-84): "SIWC establishes identity only; it does not prove workspace membership." There is no role, no allowlist, no session store. Any page using it must be marked `export const dynamic = "force-dynamic"` because it depends on per-request identity headers.

`.claude-protocol/decisions.json` already rejected SIWC for the admin panel (the shop owner may not have a ChatGPT account) in favour of password + signed cookie. That is the right call. **But keep this file** — it is untouched starter surface that costs nothing, and it is the correct mechanism if you ever want per-customer order history for ChatGPT-authenticated visitors.

---

## 6. Integration surface for the new features

### 6.1 Where storefront routes live

Ordinary App Router files under `app/`. Route groups are supported and URL-transparent, so:

```
app/
├── (site)/                       optional — group the marketing pages
├── shop/
│   ├── page.tsx                  /shop           — catalogue grid (server component, D1 read)
│   ├── loading.tsx               streaming skeleton (supported)
│   ├── [collection]/page.tsx     /shop/jadau     — filtered listing
│   └── product/[slug]/
│       ├── page.tsx              /shop/product/… — server component
│       ├── not-found.tsx         404 for unknown slug (currently MISSING sitewide)
│       └── opengraph-image.tsx   per-product social card (nestable: true, see §2.1)
├── founders/page.tsx             /founders
├── cart/page.tsx                 /cart
├── checkout/page.tsx             /checkout
├── (admin)/admin/…               see §6.3
├── api/
│   ├── appointments/route.ts     existing
│   ├── cart/route.ts
│   └── orders/route.ts
├── not-found.tsx                 add
└── error.tsx                     add
```

Reminder: `app/_components/`, `app/_seo/`, `app/_lib/` are never routed (`dist/routing/app-route-graph.js:262`).

### 6.2 Dynamic product routes

Declare as `app/shop/product/[slug]/page.tsx`. In Next 16 / React 19, **`params` is a Promise**:

```tsx
export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  …
}
```
vinext models this with `makeThenableParams` (`dist/server/app-route-handler-dispatch.js:7`, `dist/shims/thenable-params.js`), so the promise form is correct here too.

- `notFound()` from `next/navigation` is supported and will render the nearest `not-found.tsx`.
- `generateStaticParams` works but currently buys nothing (§2.3) — skip it for v1 unless you also turn on prerendering.
- `generateMetadata({ params })` works and should be used for per-product titles/canonicals.
- Catch-all `[...slug]` and optional catch-all `[[...slug]]` are supported if you want a flat `/[…]` slug space instead.

### 6.3 Gating the admin route

Three viable mechanisms, in order of preference:

**(a) `proxy.ts` at the repo root** — the Next 16 name for middleware. Discovered at `dist/server/middleware.js:41-54`, bundled into the RSC entry (`dist/entries/app-rsc-entry.js:90`), runs on the Worker. Matcher patterns supported. Use `matcher: ["/admin/:path*", "/api/admin/:path*"]`, verify the signed session cookie, and redirect to `/admin/login` on failure. **Name the file `proxy.ts`, not `middleware.ts`** — the latter logs a deprecation warning (`middleware.js:49`).
  - Caveat: the middleware module is resolved from disk at build/dev time by `fs.existsSync` (`middleware.js:42-48`), i.e. it must be at the project root (or `src/`), not inside `app/`.
  - Caveat: it must not import anything Node-only; it runs in workerd.

**(b) An admin layout that checks the session** — `app/(admin)/admin/layout.tsx` as an async server component that reads `cookies()`, verifies the HMAC, and `redirect("/admin/login")` on failure. Simpler, fully within App Router semantics, and colocated. Its weakness is that it does not cover `app/api/admin/*` route handlers, which need their own check.

**(c) Both.** Recommended: `proxy.ts` as the coarse gate for `/admin/*` and `/api/admin/*`, plus an explicit `requireAdmin()` helper called at the top of every admin route handler and server action, so authorisation is not solely a routing concern. Server actions in particular are POSTs to the *page's own URL* — do not assume a path-matcher covers them.

Whichever you choose: any admin page reading cookies is automatically dynamic (`cookies()` calls `markDynamicUsage()`, `dist/shims/headers.js:443`), but add `export const dynamic = "force-dynamic"` explicitly for clarity, as the project README already instructs for SIWC pages.

### 6.4 Where session state lives

There is **no session infrastructure today** — no cookies are set anywhere in the codebase.

Available primitives:
- `cookies()` from `next/headers`, **mutable inside route handlers and server actions** (`dist/shims/headers.js:434-456`). Pending `Set-Cookie` headers are drained by the dispatcher and attached to the response. This is the mechanism.
- WebCrypto (`crypto.subtle`) for HMAC-signing a stateless session cookie and for PBKDF2 password hashing. No Node `crypto` module, no native bcrypt/argon2.
- D1 for a server-side session table, if you want revocation.
- **No KV** (§2.4) — so no KV session store.

Recommended shape, consistent with the decision already recorded:
- **Admin:** `admin_session` cookie = `payload.HMAC(payload, ADMIN_SESSION_SECRET)`, `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=…`. The password hash and the session secret are **Worker environment variables/secrets**, read via `env` from `cloudflare:workers` exactly as `LEAD_WEBHOOK_URL` is (`app/api/appointments/route.ts:12-15`). Document them in `.env.example` next to `LEAD_WEBHOOK_URL`. Never in `site-config.ts` (it is imported by client components — `appointment.tsx:13` — so anything in it can end up in the client bundle).
- **Cart:** either a signed `cart` cookie holding line items (no DB round-trip, but a 4 KB limit and no server-side view of abandoned carts), or a `carts` table in D1 keyed by an opaque cookie id. Given the admin panel will want to see abandoned carts eventually, D1-backed is the better default — and it costs one indexed lookup, same as the existing throttle query.

**Cookie size and caching interaction:** any route that reads `cookies()` becomes dynamic and uncacheable. Keep the cart cookie read out of the catalogue listing page if you ever want to cache it.

### 6.5 How server components read from D1

Exactly like the existing route handler:

```ts
import { getDb } from "@/db";           // or a relative path — see the note below
import { products } from "@/db/schema";

export default async function ShopPage() {
  const rows = await getDb().select().from(products).where(eq(products.published, true));
  …
}
```

`db/index.ts:5-13` calls `env.DB` from `cloudflare:workers` and throws a specific, actionable error if the binding is missing. `@cloudflare/vite-plugin` runs the RSC environment inside workerd (`vite.config.ts:57`), so `cloudflare:workers` resolves natively there and is externalized in the production build. vinext's own README documents this pattern explicitly for server components.

Two practical notes:
- **Always call `getDb()` lazily inside the render/handler function.** Never at module scope — module evaluation can happen outside a request context.
- Import paths: `tsconfig.json` declares `"paths": {"@/*": ["./*"]}` and vinext bundles `vite-tsconfig-paths`, but **every existing import uses relative paths** (`app/api/appointments/route.ts:3` → `"../../../db"`). With the storefront's deeper nesting, `../../../../` will get silly. Switching to `@/db` is a small, safe improvement — but verify it resolves in the RSC/SSR/client environments with a build before adopting it repo-wide. **UNVERIFIED**: no file in the repo currently uses the `@/` alias.

### 6.6 `.openai/hosting.json`

```json
{ "project_id": "appgprj_6a649962e2f08191b49d4a2ddb83c6aa", "d1": "DB", "r2": null }
```
- `d1: "DB"` was flipped from `null` in yesterday's refactor (`git diff .openai/hosting.json`). It names the **binding**, which `vite.config.ts:22-30` turns into a local Miniflare D1 (`database_name: "site-creator-d1"`, placeholder `database_id`). In production the control plane injects the real database id.
- `r2: null` — **no object storage**. Product and founder images must live in `public/` (committed to git, served from `dist/client/`), or be hosted externally. If the catalogue is meant to be admin-editable *including images*, R2 is required and enabling it is a control-plane request, not a code change. Flag this early: an admin panel that can add a product but not its photograph is half a feature.
- `build/sites-vite-plugin.ts:27-42` copies `hosting.json` and the whole `drizzle/` directory into `dist/.openai/` after every build — that is how the control plane receives migrations.
- The file has exactly three keys. **KV, Queues, Durable Objects and the Cloudflare Images binding are not requestable through it.**

---

## 7. Data layer

### 7.1 Current schema

`db/schema.ts` — one table, `appointments` (35 lines):

| Column | Type | Notes |
|---|---|---|
| `id` | integer PK autoincrement | |
| `name`, `phone`, `interest`, `preferred_time` | text NOT NULL | |
| `note` | text NULL | |
| `created_at` | text NOT NULL DEFAULT `CURRENT_TIMESTAMP` | text, not integer timestamp |
| `status` | text NOT NULL DEFAULT `'new'` | documented workflow: `new → contacted → booked/closed` |
| `source` | text NOT NULL DEFAULT `'website'` | future channels |
| `user_agent`, `country` | text NULL | from `User-Agent` and `CF-IPCountry` |

Indexes: `appointments_created_at_idx`, `appointments_phone_created_at_idx (phone, created_at)` — the second exists specifically for the throttle query (comment at `:29-33`).

Conventions to match: `snake_case` column names mapped to `camelCase` TS properties; timestamps as `text` with `sql\`CURRENT_TIMESTAMP\``; a documented `status` string column rather than a separate state table; indexes declared in the array form `(table) => [ index(...)… ]` with a comment saying which query each serves.

`examples/d1/db/schema.ts` (a `notes` table) is starter leftover and is not wired into `drizzle.config.ts` (`schema: "./db/schema.ts"` only). It is dead code — safe to delete, and probably should be so nobody mistakes it for real.

### 7.2 How migrations are generated and applied — **there is no runner**

This is the single most operationally important thing in this section.

**Generation:** `npm run db:generate` → `drizzle-kit generate` → reads `db/schema.ts`, writes `drizzle/NNNN_name.sql` plus `drizzle/meta/_journal.json` and a snapshot. `drizzle.config.ts` sets `dialect: "sqlite"` (not `"sqlite"` + `driver: "d1-http"`), so drizzle-kit **only generates**; it never connects to or pushes anything.

**Packaging:** `build/sites-vite-plugin.ts:38-42` copies the whole `drizzle/` tree into `dist/.openai/drizzle` on `closeBundle`. Confirmed present in the current `dist/`.

**Application:** the OpenAI Sites control plane applies the generated SQL to the real D1 on deploy. There is **no migration runner in vinext and none in this repo** — no `migrate()` call, no `wrangler d1 migrations apply` in any script. The evidence this is the intended contract is the error message in `app/api/appointments/route.ts:29`: *"Generate the migration locally with `npm run db:generate`, then deploy so the platform can apply the generated SQL to the real D1 database."*

**Locally, you must apply it by hand.** The Miniflare D1 lives at `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite`; it currently contains `appointments` and `_cf_METADATA`, so somebody ran the SQL manually. Options: `npx wrangler d1 execute site-creator-d1 --local --file=./drizzle/0000_many_nightmare.sql`, or `sqlite3` directly against that file.

### 7.3 What this means for adding many tables

The storefront + admin needs roughly: `products`, `product_images`, `product_variants` (if size/metal variants), `collections`, `product_collections`, `carts`, `cart_items`, `orders`, `order_items`, `admin_users` or a single hashed-password secret, and possibly `sessions`. That is ~8-11 new tables.

Consequences of a hand-applied, control-plane-driven migration flow:

1. **Every schema change is a two-step ritual**: `npm run db:generate`, then apply the new SQL file to local D1 by hand, then deploy so the control plane applies it to prod. Anyone who forgets step 2 sees `no such table` locally; anyone who forgets to deploy sees it in prod. Add an explicit `db:apply:local` script (e.g. `wrangler d1 execute site-creator-d1 --local --file=…`) so the ritual is one command, and write it into the README (which is currently starter boilerplate anyway — §8.1).
2. **Prefer few, large migrations over many small ones during the build-out.** Each generated file is another thing that must be applied in order in two places. Batch the storefront schema into one migration and the admin schema into another, rather than one per table.
3. **`drizzle/meta/_journal.json` is committed and ordered** — it was modified in yesterday's refactor. Two people generating migrations on separate branches will produce conflicting journal entries and possibly the same `0001_` index. Serialise schema changes, or resolve the journal by hand and regenerate.
4. **SQLite/D1 has weak `ALTER TABLE`.** Drizzle emits table-recreate sequences for column drops/renames. On a live D1 with real orders that is a genuine risk. Design the order/product tables to be additive-friendly from the start: nullable new columns, no renames.
5. **Snapshot price at order time.** Already recorded in `.claude-protocol/decisions.json` ("Order and line-item tables must snapshot price at order time (gold rate volatility)"). Concretely: `order_items` carries its own `unit_price`, `metal_rate`, `making_charge` and `currency` columns — never a join to `products` for price at read time.
6. **`toRouteErrorMessage()` must learn the new table names.** It currently pattern-matches `"no such table"` and `'from "appointments"'` (`route.ts:26-28`). Generalise it into a shared helper in `app/_lib/` rather than copy-pasting a per-table variant into every new route.
7. **No seed mechanism exists.** A demo catalogue needs either a committed `drizzle/seed.sql` applied the same way, or an admin-only import endpoint.

---

## 8. Technical debt and hazards

Ordered by whether they block the new work.

### BLOCKING

**8.1 `worker/index.ts` references bindings that this project never declares.**
`worker/index.ts:6-14` declares `ASSETS: Fetcher` and `IMAGES: {...}`, and `:35-38` calls `env.ASSETS.fetch(...)` and `env.IMAGES.input(...)`. But the Wrangler config for this project comes from `vite.config.ts:18-32` (`localBindingConfig`), which declares **only** `main`, `compatibility_flags`, `d1_databases` and `r2_buckets`. The emitted `dist/server/wrangler.json` confirms it: `"assets":{"directory":"../client"}` — **no `binding` key** — and **no `images` block at all**.

For contrast, `vinext deploy` generates a config that *does* declare them (`node_modules/vinext/dist/deploy.js:253-258`: `assets: { directory, not_found_handling: "none", binding: "ASSETS" }, images: { binding: "IMAGES" }`). This project does not use `vinext deploy`.

Consequences:
- `env.ASSETS` is `undefined` → `worker/index.ts:35` throws a `TypeError` before `handleImageOptimization` can catch anything → **`GET /_vinext/image?...` is a 500.**
- `env.IMAGES` is `undefined` → even with `ASSETS` fixed, the transform throws; `dist/server/image-optimization.js:190-192` catches it and falls back to a passthrough of the **original, unresized** file. So `next/image` would emit a `srcSet` of 8 widths that all download the same 284 KB original — strictly worse than the current `<img>`.
- Page rendering is unaffected: `dist/server/app-router-entry.js:38` guards with `if (env?.ASSETS)`.
- `tests/helpers.mjs:16-18` stubs `ASSETS` explicitly, which is why no test catches this.

**Blocks:** any plan that assumes `next/image` will handle product photography. It will not. **Fix:** either add `assets: { binding: "ASSETS", not_found_handling: "none" }` and `images: { binding: "IMAGES" }` to `localBindingConfig` in `vite.config.ts` and confirm the control plane honours the emitted `wrangler.json` (**UNVERIFIED** — verify by deploying and curling `/_vinext/image?url=/images/hero-jadau.webp&w=1080`, expecting a resized WebP/AVIF rather than a 500 or the full-size original), **or** accept the constraint, delete the `/_vinext/image` branch from `worker/index.ts`, and ship hand-generated responsive `<img srcset>` sets (see 8.4).

**8.2 There is no type gate.**
`npx tsc --noEmit` currently emits 4 errors, all pre-existing:
```
app/api/appointments/route.ts(1,21): TS2307: Cannot find module 'cloudflare:workers'
db/index.ts(1,21):                   TS2307: Cannot find module 'cloudflare:workers'
worker/index.ts(6,11):               TS2304: Cannot find name 'Fetcher'
worker/index.ts(7,7):                TS2552: Cannot find name 'D1Database'
```
Cause: the Cloudflare ambient types are never installed or referenced — no `@cloudflare/workers-types` dependency, no `worker-configuration.d.ts`, no `types` entry in `tsconfig.json`. And there is **no `type-check` script** in `package.json`, so nothing runs `tsc` in CI or locally.

Consequence: **types are decorative.** Nothing catches a wrong `params` shape, a wrong Drizzle column, a wrong prop. With ~20 new screens and ~10 new tables, that is not survivable.

**Blocks:** the quality gates in the protocol (Phase 5 requires "Type Check: 0 errors"). **Fix (small, do it first):** `npx wrangler types` to generate `worker-configuration.d.ts` (it emits the `cloudflare:workers` module declaration and the `D1Database`/`Fetcher` globals from the actual bindings), add it to `tsconfig.json` `include`, add `"type-check": "tsc --noEmit"` to scripts, confirm 0 errors, and wire it into CI. There is no `.github/workflows/` directory at all — CI does not exist yet either.

**8.3 Everything is uncommitted.**
`git log` has exactly one commit (`453457c Build royal Alankar Jewellers website`). `git status` shows 12 modified, 1 deleted (`postcss.config.mjs`), and 6 untracked paths — including all of `app/_components/`, `app/_seo/`, `app/api/`, `app/site-config.ts`, `app/robots.ts`, `.env.example`. `app/globals.css` alone is +450 lines against HEAD.

**Blocks:** any branch-per-task workflow. There is no clean baseline to branch from and no way to revert a bad task. **Fix:** commit the refactor before starting M1.

### DEFER-ABLE, BUT FIX EARLY

**8.4 Images: raw `<img>`, no `srcset`, and a hero below its own display resolution.**
`app/page.tsx:1-6` disables `@next/next/no-img-element` for the whole file with a documented rationale (which is *almost* right — see 8.1 for the real reason). Every image is a bare `<img src>` with intrinsic `width`/`height` and no `srcset`/`sizes`. Actual assets:

| File | Dimensions | Size |
|---|---|---|
| `hero-jadau.webp` | **1536×1024** | 284 KB |
| `artisan-setting.webp` | 1536×1024 | 276 KB |
| `private-salon.webp` | 1536×1024 | 212 KB |
| `collection-jadau.webp` | 1024×1536 | 240 KB |
| `collection-diamond.webp` | 1024×1536 | 152 KB |
| `collection-polki.webp` | 1024×1536 | 344 KB |

The hero is a full-bleed `100vw` element. At 1536px wide it is **under-resolution on any display wider than 1536 CSS px, and badly so on a 2× laptop** (a 1440px-wide MacBook viewport wants ~2880px). Simultaneously, a 390px phone downloads all 284 KB of it. Both problems are the same missing `srcset`.

`tests/rendered-html.test.mjs:109-124` already enforces `width`/`height`/`alt` on every image and that the hero is never `loading="lazy"` — extend that test to require `srcset` once you add it.

**Fix:** generate 3-4 widths per image at build time (a small script + `sharp` run locally, output committed to `public/images/`) and hand-write `srcset`/`sizes`. This sidesteps the whole `/_vinext/image` problem. **This becomes urgent with a product catalogue** — 40 products × 1 unresized 300 KB hero image is a 12 MB catalogue page.

**8.5 The favicon is an OG banner letterboxed into a square.**
`public/favicon.png` is 512×512, 80 KB — and is the 1200×630 OG artwork ("ALANKAR JEWELLERS / Jewels that become heirlooms." with a necklace photo) padded with black bars top and bottom. At 16-32px in a browser tab it is an illegible dark smudge. `app/layout.tsx:32-35` points both `icon` and `shortcut` at it. `public/apple-touch-icon.png` (180×180) is a *photo crop* of the necklace with no mark at all — better shaped, but not a brand icon either.

**Fix during the redesign:** a real monogram (an "A" in the Bodoni display face on garnet or gold) at 32/180/512, plus an `.ico`. Note the App Router alternative: dropping `app/icon.png` / `app/apple-icon.png` / `app/favicon.ico` uses the metadata file convention (supported, §2.1) and removes the need for the manual `icons` block in `layout.tsx`.

**8.6 `package.json` is still named `site-creator-vinext-starter`.**
`package.json:2`. This name propagates: `dist/server/wrangler.json` has `"topLevelName": "site-creator-vinext-starter"` and `"name": "site-creator-vinext-starter"` — i.e. **the deployed Worker is named after the starter template.** Low functional risk, but it will show up in Cloudflare dashboards and logs. Rename to `alankar-jewellers`; check with the control plane first whether the Worker name is derived from `hosting.json`'s `project_id` or from `package.json` (**UNVERIFIED**) — renaming could theoretically orphan the existing Worker.

**8.7 `README.md` is untouched starter boilerplate.**
Titled `# vinext-starter`. Describes `db/schema.ts` as "intentionally empty" (it is not), says `npm test` "verifies its rendered loading skeleton" (it does not — there is no skeleton, and `tests/rendered-html.test.mjs:44` explicitly asserts the skeleton is *absent*), and documents `examples/d1/` as a live surface. Everything a new contributor needs — the `SITE_DETAILS_PENDING` gate, the migration ritual, the dual-sink lead flow, `LEAD_WEBHOOK_URL` — is absent.

Defer-able for a solo build, but the migration ritual (§7.2) and the honesty gate (§5.3) genuinely need to be written down somewhere before the codebase triples in size.

**8.8 Dead starter surface.**
`examples/d1/` (a `notes` table + route handler that imports `../../../../../db`) is not routed and not in `drizzle.config.ts`. It is a decoy. Delete it.

**8.9 No error/not-found/loading boundaries.**
No `app/error.tsx`, `app/not-found.tsx`, `app/loading.tsx`, or `global-error.tsx`. Today the site is one route that cannot 404, so it has not mattered. With `[slug]` routes it matters immediately — an unknown product slug will fall through to vinext's default 404 with no site chrome. All four are supported (§2.1). Add `not-found.tsx` and `error.tsx` in the same task that adds the first dynamic route.

**8.10 `app/sitemap.ts` is a hard-coded single entry.**
`app/sitemap.ts:9-16` returns one URL. Its own comment says "add entries here as routes are added". Once products come from D1, this must query D1 — which is supported (`sitemap.ts` is a dynamic metadata route running server-side) but will then hit the database on every crawl. Give it `export const revalidate = 3600` when you do.

**8.11 Only anchor links exist — no `next/link` anywhere.**
Every navigation in `page.tsx` and `site-header.tsx` is a raw `<a href="#…">` to an in-page anchor, which is correct for a one-pager. The moment there are real routes, using `<a href="/shop">` instead of `<Link href="/shop">` means a full document reload and loses prefetch. `next/link` is fully supported (§2.1). Grep for raw `<a href="/` when reviewing new code.

**8.12 `.env.example` documents one variable; secrets have no home yet.**
Only `LEAD_WEBHOOK_URL`. The admin password hash, session secret, and (later) payment keys need the same treatment: documented in `.env.example`, read via `env` from `cloudflare:workers`, set as Worker secrets in the control plane. **Never in `app/site-config.ts`** — that module is imported by `app/_components/appointment.tsx:13`, a `"use client"` file, so anything in it can reach the browser bundle.

**8.13 Dead font assets in the build.**
`.vinext/fonts/` and `dist/client/assets/_vinext_fonts/` contain Geist + Geist Mono (11 woff2 files) even though no source file imports `next/font`. Grepping the built CSS and every built JS chunk for `_vinext_fonts` returns zero references. Harmless dead weight in `dist/client/`; noted only so nobody spends an hour wondering where Geist came from.

**8.14 CSS token gap (restated as debt).**
See §4.3. 11 tokens covering colour and font-family only; ~16 stray hex values and ~30 `rgba()` literals; 35 hand-written `clamp()` calls with no scale. Adding a storefront and admin on top of this without first defining spacing/radius/shadow/type tokens will make the redesign much harder to keep coherent. **This is the cheapest high-leverage first task of M1.**

**8.15 Throttle semantics do not transfer to orders.**
`isThrottled()` (`route.ts:80-105`) silently absorbs a second submission from the same phone within 3 minutes and caps at 5/day, returning a fake `201 {ok:true}`. That is exactly right for an enquiry form and **exactly wrong for an order** — a customer legitimately placing a second order, or retrying after a network blip, must not get a silent no-op that looks like success. Write the order endpoint's idempotency deliberately (client-generated idempotency key + a unique index), not by copying this function.

---

## 9. Test infrastructure

### 9.1 How it works

`npm test` = `npm run build && node --import ./tests/setup.mjs --test tests/*.test.mjs`. **The build is part of the test command** — the suite exercises the real production bundle, not source modules. There is no Vitest, no jsdom, no Playwright, and no wrangler/miniflare in the loop.

**`tests/setup.mjs` (19 lines) — the `cloudflare:workers` module hook.**
```js
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: STUB_URL, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
```
**Why it is needed:** `cloudflare:workers` is a workerd built-in that does not exist in Node. `dist/server/index.js` reaches it through `db/index.ts:1` (and `app/api/appointments/route.ts:1`), and vinext externalizes that specifier in the production build rather than bundling it — so `import("../dist/server/index.js")` under plain Node throws `ERR_MODULE_NOT_FOUND` before a single test runs. The `node:module` resolve hook redirects the specifier to `tests/stubs/cloudflare-workers.mjs`, which makes the whole Worker bundle importable in-process. That buys speed (no workerd startup) at the cost of fidelity (no real D1, no real `CF-*` headers).

**`tests/stubs/cloudflare-workers.mjs` (13 lines)** exports a **mutable** `export const env = {}` plus a default export. Mutability is the point: `tests/appointments-api.test.mjs:38-40` sets `env.LEAD_WEBHOOK_URL` per test and `afterEach` deletes it (`:35`).

**`tests/helpers.mjs` (48 lines)** — lazily imports `dist/server/index.js` once into a module-level promise (`:6-13`), then:
- `fetchWorker(path, init)` — builds a `Request` against `http://localhost${path}` and calls `worker.fetch(request, bindings, ctx)` with `bindings = { ASSETS: { fetch: async () => new Response("Not found", {status:404}) } }` and a no-op `ctx` (`:15-24`). **Note there is no `DB` binding** — so `getDb()` throws in every test.
- `renderPage(path, {raw})` — GET with `accept: text/html`, returns the HTML string or the raw `Response`.
- `postJson(path, payload, headers)` — returns `{status, body, response}` with the body already `.json()`-parsed (or `null`).

### 9.2 What the existing tests assert

- **`tests/appointments-api.test.mjs` (9 tests)** — deliberately runs with **no D1 binding**, so the database sink always fails. The comment at `:16-20` says this is on purpose: it isolates the webhook sink and proves the route's contract that "a lead reaching EITHER sink is a captured lead". `globalThis.fetch` is monkey-patched in `beforeEach` to record webhook calls and restored in `afterEach`. Covers: 405 + `Allow` header, webhook success, **both sinks failing must NOT report success** (`:61-70`, the exact bug the old form had), 5 phone-normalisation cases, 7 validation-rejection cases, malformed body, honeypot absorbed-but-not-delivered, failing webhook reported.
- **`tests/rendered-html.test.mjs` (9 tests)** — fetches `/` once and caches the HTML (`:6-10`), then asserts against the raw markup: content-type, every section server-rendered, exactly one `<h1>`, no loading skeleton, absolute `og:image`/`og:url`/`twitter:image`/canonical, `og:image:width/height` matching the real file, JSON-LD parse + `@type === "JewelryStore"`, **the `SITE_DETAILS_PENDING` invariant in both directions** (`:78-97`), contact section copy, every `<img>` has width/height/alt and the hero is not lazy, anchor targets exist for every anchor link, and `robots.txt`/`sitemap.xml` serve with absolute URLs.

Style notes worth copying: assertions carry failure messages that name the bug; regexes are matched against **customer-facing copy**, not implementation details; `structuredData()` (`:12-18`) reverses the `serializeJsonLd` escaping before parsing; `:148-149` documents that React emits a `<!-- -->` separator between literal text and an interpolated value, so patterns must allow for it.

### 9.3 How to write a test for a storefront or admin route

Follow the existing shape exactly.

**A storefront route handler (`POST /api/orders`)** — new file `tests/orders-api.test.mjs`:
```js
import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { env } from "cloudflare:workers";        // resolves to the stub via setup.mjs
import { postJson, fetchWorker } from "./helpers.mjs";
```
- Use `env.X = …` in a helper and `delete env.X` in `afterEach` to inject Worker environment variables.
- Monkey-patch `globalThis.fetch` in `beforeEach` and restore in `afterEach` to intercept outbound webhooks.
- Assert `{status, body}` from `postJson`, and match `body.error` against the customer-facing copy.
- **Remember `getDb()` throws** — with no `DB` binding, any D1 path fails. That is fine (and useful) for validation and error-shape tests. If a test needs a working database, you must supply one: add a `DB` binding to `bindings` in `tests/helpers.mjs` backed by `node:sqlite`'s `DatabaseSync` (Node 22+) wrapped in a minimal D1 shim (`prepare().bind().all()/run()/first()`), and apply `drizzle/*.sql` to it in a `before` hook. **UNVERIFIED**: nobody has done this here yet; the exact D1 surface Drizzle's `drizzle-orm/d1` driver calls needs checking against `node_modules/drizzle-orm/d1/`. The alternative is `wrangler dev`-backed integration tests, which is a much bigger change to the test setup.

**A storefront page (`/shop`, `/shop/product/[slug]`)** — extend or mirror `tests/rendered-html.test.mjs`:
- `await renderPage("/shop")` and assert on the HTML.
- Assert the Product JSON-LD parses and, while the catalogue is placeholder, that **no price is emitted** — the direct analogue of the existing `never publishes unverified contact facts` test (`:78-97`). This is the single most valuable new test.
- Assert `<img srcset=` on product images once 8.4 is fixed, alongside the existing width/height/alt checks.
- Assert `renderPage("/shop/product/does-not-exist", {raw: true})` returns 404.
- Note pages will render with `getDb()` throwing unless you add a `DB` binding — so a `/shop` page must be written to render an empty/error state rather than crash, and the test should assert *that*.

**An admin route** — assert the gate, not the content:
- `fetchWorker("/admin", {redirect: "manual"})` → expect 302/307 to `/admin/login`.
- `fetchWorker("/api/admin/orders")` → expect 401/403 with no leakage of order data.
- Post a forged/expired signed cookie via `headers: { cookie: "admin_session=…" }` and assert rejection.
- Set the real secret through `env` (the mutable stub) and assert a validly signed cookie is accepted.
- Caveat: if the gate is implemented in `proxy.ts`, confirm it actually runs inside the bundled Worker under this in-process harness — it is bundled into the RSC entry at build time (`dist/entries/app-rsc-entry.js:90`), so it *should*, but **UNVERIFIED** here. Verify with one throwaway test before writing twenty that depend on it.

Finally: the suite currently runs 18 tests. Keep the one-file-per-surface convention (`orders-api.test.mjs`, `admin-auth.test.mjs`, `storefront-html.test.mjs`) rather than growing the two existing files without bound.
