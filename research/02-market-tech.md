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

## 1. Competitive landscape — what Indian jewellery e-commerce actually is

### 1.1 The two numbers that should frame every decision below

The best available sizing is the **Redseer Industry Report on the Jewellery Market in India**, commissioned for BlueStone's IPO ([PDF](https://kinclimg1.bluestone.com/static/ir/anno/Redseer_Industry_Report_on_Jewellery_Market_in_India.pdf)) and reproduced in the [BlueStone DRHP](https://www.axiscapital.co.in/contents/Bluestone-Jewellery-and-Lifestyle-Ltd-DRHP.pdf).

| Metric (CY2023 unless noted) | Value |
|---|---|
| Indian jewellery market | ~₹5,562 bn (~USD 67 bn) |
| **Online channels as % of the total market** | **4–6%** (projected 10–12% by CY2028) |
| **Purchases that are *online-influenced*** | **50–60%** |
| Online + online-influenced market | ₹306 bn, growing 28–30% CAGR to CY2028 |
| Average ticket size — branded | ₹0.10–0.13 mn |
| Average ticket size — unbranded | ₹0.03–0.05 mn |
| Omnichannel shopper spend vs single-channel | 2.5× |
| Old-gold exchange as share of all transactions | 15–20% |
| Wedding-wear as share of market | ~55% |

Redseer's own explanation: *"most consumers who purchase high value products prefer to research online and then buy from the offline physical stores, since the online mode does not allow consumers to look, touch and feel the product."*

**4–6% transacted, 50–60% influenced.** That gap is the entire strategic argument for this project, and it says the store is a *discovery and trust* surface whose measurable output is a footfall or an appointment — not a GMV channel. It is direct evidence for the position already taken in §9.5 and §7.8.

⚠️ Reject the widely-circulated claim that ~18% of Indian jewellery sells online ([Indian Retailer](https://www.indianretailer.com/article/technology/digital-trends/impact-of-e-commerce-boom-on-local-indian-jewelry-segment.a7652)) — it is ~3× Redseer with no stated methodology.

### 1.2 What the players actually sell online — and the surprise

The common assumption is that incumbents gate high-value pieces behind an enquiry form. **That is only half true, and the half that is true is not the half you'd guess.**

**Tanishq sells ₹7 lakh pieces with a plain cart.** On the product page for *Petal Crest Gold Necklace* (18K, 35.21 g, **₹7,13,635**, `tanishq.co.in/product/petal-crest-gold-necklace-50o6vrncxab37.html`) the CTAs are **Add to Cart**, **Try It On** (virtual try-on) and **Find In Store**. No appointment gate, no enquiry form. The page carries a full **Price Breakup** tab and an old-gold exchange calculator that explicitly routes the exchange *to the store* (*"when you bring 35.21 grams of 18k gold to our store"*). The Necklaces category returns 702 results spanning ₹81,864–₹7,13,635.

The gate sits one level up, at the **collection**. The Rivaah bridal landing page (`/shop/rivaah`) has **no products and no cart** — only *"Searching for wedding jewellery Rivaah? Our Specialists are here to help you select the perfect piece! Get in touch"* plus category tiles.

> **The industry pattern is: individual high-value pieces are transactional; curated bridal *sets* are assisted.** A necklace is a SKU. A bridal set is a consultation. That is a far more useful rule than "expensive things need a form", and it maps cleanly onto `products.sale_mode` in §7.2.

Tanishq also runs Book-an-Appointment, video calling, Endless Aisle, virtual try-on and live assisted chat across **230 of 335 stores** ([GJEPC](https://gjepc.org/news_detail.php?news=tanishq-introduces-digital-features-across-200-stores), [Adgully](https://www.adgully.com/tanishq-implements-digital-features-across-its-200-stores-95103.html)).

**CaratLane's Try At Home is an everyday-price product, not a bridal one.** Its own catalogue filters (`caratlane.com/jewellery/try+at+home.html`) skew hard: weight 0–2 g (3,685 items) and 2–5 g (4,325) against 10–20 g (401); price ₹15,001–20,000 (1,051) against Under ₹5,000 (84). Pincode-gated, free, no obligation.

**BlueStone's own segmentation** (Q4/FY26 [Investor Presentation](https://kinclimg1.bluestone.com/static/ir/msf/files/iu/InvestorPresentation.pdf), slide 7) is the single most useful table in the sector:

| Segment | Karat / weight | Average selling price | Gross margin | Repeat |
|---|---|---|---|---|
| Daily-wear | 18KT/14KT, 5–30 g | ₹25,000–35,000 | 25–35% | High |
| Non-wedding occasion-wear | higher studded, silver/Pt | ₹35,000–50,000 | 30–40% | Medium |
| **Wedding** | 22KT, 30–250 g | **₹0.1–0.2 mn and above** | **5–15%** | **Low** |

Bridal is ~4× the ticket at roughly a third of the margin with low repeat. Digital-first brands deliberately do not chase it. A shop whose identity is antique Jadau and Polki is in exactly the low-margin, low-repeat, high-consideration corner — which argues for appointment-led conversion on those pieces, not because the tech can't take the money but because the economics don't reward it.

### 1.3 Every player that started online has moved offline

| Company | Online share of revenue | Source |
|---|---|---|
| **BlueStone** | **15.63% (FY23) → 6.66% (FY25)** | [Entrackr](https://entrackr.com/fintrackr/bluestones-losses-surge-56-in-fy25-online-sales-make-up-just-7-9632418), [Inc42](https://inc42.com/buzz/bluestone-sees-fy25-losses-soar-56-on-offline-push/) |
| **CaratLane** | ~50% (Q1 FY22) → now 322 stores in 139 cities; split no longer disclosed **[UNVERIFIED]** | [MediaNews4U](https://www.medianews4u.com/caratlane-reports-272-yoy-growth-with-q1-fy-2022-revenue-at-157-crores/) |
| **Titan / Tanishq** | *"~20% FY25 digitally influenced sales"* — **influenced, not transacted**. Pure-online % not disclosed **[UNVERIFIED]** | [Titan Q4 FY25 earnings deck](https://www.titancompany.in/sites/default/files/2025-05/Q4FY25%20-%20Earnings%20presentation%20Uploaded.pdf) |
| **Candere (Kalyan)** | ~₹55 Cr/quarter against group FY25 revenue of ₹25,045 Cr ≈ **0.7–1% of group** | [Storyboard18](https://www.storyboard18.com/brand-marketing/kalyan-jewellers-online-platform-records-89-yoy-revenue-increase-during-q3-fy2025-52460.htm) |
| **Giva** | **~50% online** — but AOV is silver-tier | [Entrackr](https://entrackr.com/fintrackr/givas-revenue-jumps-89-to-rs-518-cr-in-fy25-11103039) |
| **Melorra** | The pure-online lightweight-gold play. Raised $88 Mn; revenue ~₹605 Cr (FY23) → ~₹174 Cr (FY24); reportedly in talks to sell for ₹40–50 Cr | [Inc42](https://inc42.com/buzz/after-raising-88-mn-melorra-may-sell-for-pennies-on-the-dollar/), [Inc42](https://inc42.com/features/melorras-golden-promise-soured/) |

BlueStone's deck states the model in its own words: *"Online drives discovery and store presence completes the physical [sale]"*, *"Stores are added where digital demand is proven"*, *"Stores act as conversion engines, monetising digital demand."* It went from 192 stores (Mar '24) to **340 (Mar '26)**.

Giva is the only sustained ~50%-online business in the set, and it gets there by selling **silver at ₹999–₹15,399** (I sampled 37 listed prices on giva.co: median **₹4,199**). Low-ticket silver is a genuinely different e-commerce category. It is not a template for a gold-and-Polki house.

**Average order value — the digital-first players are the *low* end, not the high end:**

| Period | BlueStone | Senco Gold | Thangamayil |
|---|---|---|---|
| FY22 | ₹27,905 | ₹56,900 | ₹38,730 |
| FY24 | ₹41,205 | ₹63,700 | ₹47,097 |
| Q1 FY25 | ₹45,084 | ₹73,900 | ₹52,623 |
| FY26 | **₹66,311** (Q4: ₹74,816) | — | — |

(BlueStone DRHP p. 148 peer table, which defines AOV and ATS interchangeably; FY26 from the investor deck. Note Entrackr's caveat that the FY26 jump is [substantially gold-price inflation, not mix](https://entrackr.com/analysis/bluestones-fy26-glow-up-has-a-gold-price-problem-11780802).) The traditional offline jewellers carry consistently *higher* tickets than the digital-first player.

**[UNVERIFIED]** absolute AOV for CaratLane, Giva and Melorra — none is published. Titan discloses direction only (CaratLane Q4 FY25 average bill value +18% YoY). Settling these needs analyst-call transcripts or a future Giva DRHP.

### 1.4 Returns, exchange and buyback — the operational reality

Fetched 2026-07-27. This is the part small jewellers underestimate.

| | Tanishq | CaratLane | BlueStone | Candere (Kalyan) |
|---|---|---|---|---|
| **Online return window** | **7 days** (Mia: 30) | **15 days**, 100% of invoice **but capped at ₹2,00,000** | **30 days** | 15 days |
| **Exclusions** | domestic only | — | solitaires **above ₹3 lakh**, custom solitaires, coins, customised orders | — |
| **Return shipping** | free, **tamper-evident "orange lock"**; serial confirmed by phone before pickup | free, insured | free India-wide, insured | ₹500, customer pays |
| **Refund timing** | 7–15 working days post-QC | — | 2–3 working days post-QC | — |
| **Lifetime exchange** | in-store only — *"not applicable for an online transaction"* | Gold/Pt 100% · Diamond 100% · Gemstone 90% · **Kundan/glass NIL** · **Polki/uncut/chakri 75%** | metal 100% · stones 100% | Gold 100% · Diamond 90% · **Uncut 70%** |
| **Buyback** | no cash buyback published | exchange value **−10%** (diamond) / **−3%** (plain), max ₹10 lakh | metal 100% + **stones 90%**; **₹500 fee online, waived in store** | as above |
| **Making charges + taxes on exchange** | *"Making charges, taxes, and any discount given on the original invoice, will be deducted in full."* | deducted | deducted | *"doesn't cover manufacturing charges and/or taxes"* |

Sources: [Tanishq returns](https://www.tanishq.co.in/return-policy.html) and [exchange T&Cs](https://www.tanishq.co.in/exchange-terms-and-conditions.html) (read in browser — the site 403s automated fetches), [CaratLane](https://www.caratlane.com/returns-exchanges), [BlueStone](https://www.bluestone.com/shipping-return.html), [Candere](https://www.candere.com/buy-back-lifetime-exchange-policy.html).

Two corrections to commonly-repeated claims: **Tanishq's window is 7 days, not 15**, and **CaratLane's money-back is capped at ₹2,00,000** — which is, in effect, that business's declared online price ceiling.

⚠️ **Note carefully for §2: none of these is a gold-rate lock.** Lifetime exchange values metal at *the prevailing rate on the day of the exchange request*, which hands gold-price upside to the customer — the opposite of price protection. No player in this set publishes a "rate protect" scheme on an online order. **[UNVERIFIED for the sector]** — Kalyan/Malabar advance-booking scheme T&Cs were not read; that is what would settle it.

### 1.5 What a small independent jeweller can and cannot copy

**Realistically copyable — low capex, high trust signal:**

1. **A per-SKU price breakup** (metal weight × rate, making, stones, GST). Tanishq ships this on every SKU; Redseer names pricing transparency as a differentiator where omnichannel beats traditional. This is also **legally required** at listing level — see §4.
2. **A live gold-rate page.** Tanishq runs `/gold-rate.html`.
3. **Multi-angle and 360° photography.** Redseer names discovery as driver #1. BlueStone's 3D rendering pipeline is a moat; *good photography is not*. Reinforces §9.5.
4. **"Enquire / Book a viewing" on high-value pieces.** This is literally what Tanishq does on Rivaah. It is a form, not infrastructure — and this site already has one (§7.8).
5. **Video-call shopping and WhatsApp.** Near-zero cost; Tanishq rolled video calling out during COVID.
6. **"Find in store" / reserve-and-collect** — turns the site into a footfall driver, which is what the online channel is doing for every player above.
7. **Old-gold exchange as an on-site calculator, settled in store.** 15–20% of all jewellery transactions. Tanishq's own PDP routes the exchange to the store. The shop already does this offline; it just isn't on the website.

**Out of reach, and expensive to discover late:**

1. **Try-at-home.** CaratLane, with 322 stores, still pincode-gates it and restricts it to 0–5 g pieces. BlueStone services 12,661 PIN codes to make it work.
2. **15/30-day returns with insured reverse logistics.** Even incumbents cap it (CaratLane ₹2 lakh, BlueStone excludes solitaires above ₹3 lakh) and Tanishq allows 7 days behind a serial-numbered tamper-lock protocol. This needs transit insurance, tamper-evident packaging, in-house QC/assaying and a claims process. BlueStone's DRHP discloses ₹1.14 mn of outstanding claims for goods lost by transport providers.
3. **Published lifetime exchange/buyback percentages** — open-ended balance-sheet liabilities priced off in-house manufacturing and assaying.
4. **Paid demand generation.** The decisive barrier: **Giva spent ₹135 Cr marketing on ₹518 Cr FY25 revenue (~26%)**; BlueStone ~9% (FY25 ₹159 Cr on ₹1,770 Cr). Compare Kalyan at **1.92%** and Thangamayil at **0.95%** (DRHP peer table). Both digital-first players were loss-making while spending it. A small jeweller cannot buy its way to online demand and should not model as if it can.
5. **Per-piece IGI/GIA certification at scale**, and EMI underwriting (which comes from the gateway/NBFC, not the jeweller).

### 1.6 What this section changes in the build

- **`products.sale_mode` (§7.2) is validated, but its default is arguably wrong.** The evidence says individual pieces — even at ₹7 lakh — are transactable, and it is *curated bridal sets* that go to consultation. Consider defaulting to `buy_online` for single pieces and reserving `enquire_only` for sets and made-to-order. **[DECIDE]**
- **A ₹2,00,000 ceiling shows up three times independently** and from three unrelated directions: CaratLane's online refund cap (commercial), the NPCI UPI cap for the jewellery category (§3.6), and s.186 of the Income-tax Act, 2025 on cash receipts (§4.7). Treat ₹2,00,000 as a first-class threshold in the checkout, not a coincidence.
- **No incumbent offers an online gold-rate lock.** Whatever quote-validity window §7.4 chooses, it is an invention, not a copy. §2 has the detail.
- **§9.5's "don't replace the appointment flow with a cart" is the strongest-evidenced claim in this document.** 4–6% transacted vs 50–60% influenced; BlueStone 15.63% → 6.66%; Melorra in distress.

---

## 2. The gold-rate problem

Indian jewellery price = (gold rate × net weight) + making charges + stone value + hallmarking + GST. The rate moves twice a day. This section establishes what the rate actually is, where to get it, and how long a quote can honestly be held — which directly determines `expires_at` in the `price_quotes` table already drafted in §7.4.

### 2.1 What the incumbents actually render on a product page

I captured four of five sites live, from server-rendered HTML or their own JSON. Tanishq is WAF-blocked from this environment (403 to curl with full browser headers, to WebFetch, and to its Salesforce Commerce Cloud endpoints) — **[UNVERIFIED]**, settle with a headless browser from an Indian IP.

| | BlueStone | CaratLane | GIVA | Melorra | Tanishq |
|---|---|---|---|---|---|
| Gold rate ₹/g shown | ✗ | ✓ `Rs. 13411/g` | ✓ `₹8664/g` | ✓ `5416 /g` | [UNVERIFIED] |
| Net metal weight | ✓ | ✓ | ✓ `1.64 gm` | ✓ `3.185 g` | [UNVERIFIED] |
| **Distinct gross weight** | ✗ | ✓ (field) | ✓ `1.68 gm` | ✗ | [UNVERIFIED] |
| Purity | ✓ | ✓ | ✓ | ✓ | [UNVERIFIED] |
| Making-charge form | flat ₹ | flat ₹ | flat ₹ | **₹/gram** | [UNVERIFIED] |
| Stone value | ✓ one line | schema only | ✓ per-quality + carat | schema null | [UNVERIFIED] |
| GST as ₹ | ✓ | ✓ (`TAX`) | ✓ | ✓ | [UNVERIFIED] |
| **GST as %** | ✗ | ✗ | ✗ | ✗ | [UNVERIFIED] |
| **Hallmarking line** | ✗ | ✗ | **✓ ₹43.68** | ✗ | [UNVERIFIED] |
| Discount inside breakup | ✗ | schema only | ✓ negative line | ✓ column | [UNVERIFIED] |
| Effective GST | 3.00% | 3.00% | ~3.0% | 3.00% | — |

Sources, all live 2026-07-27: [BlueStone](https://www.bluestone.com/rings/the-swarna-ring~17842.html) renders a server-side `<section id="section-price-breakup">` — Gold ₹78,306 / Making ₹18,793 / GST ₹2,913 / Total ₹1,00,012 — with a tooltip *"The final invoice amount will be adjusted in case of variation in weight."* [CaratLane](https://www.caratlane.com/jewellery/bhivita-22kt-gold-ring-kr01809-2y0000.html) ships an SSR `price_breakup` array of `{title, rate, finalRate, weight, value, discount, final_value}`. [Melorra](https://www.melorra.com/gold-rings/lunar-light-gold-rings_product_1258_9/) carries `gold_details`/`mc_details`/`total` in its Next.js payload. **GIVA exposes the whole thing through a public JSON API** — `https://api.givadiva.co/v2/products/productInfo?id=…` — and has the richest breakup of the five.

**GIVA's shape is the one to copy.** Columns are `Component | Rate | Weight | Final Value`:

```
14K Gold            | ₹8664/g | 1.640 g | ₹14,210.33
Total Gold Value                        | ₹14,210.33
VVS/VS Round – 6 Nos.                   |  ₹7,425
Total Diamond Value | 0.160 ct          |  ₹9,900
Making Charges                          |  ₹8,396.64
0% Making Charges                       | −₹8,396.64
Hallmarking                             |     ₹43.68
Certification                           |    ₹149.50
GST                                     |    ₹729.07
Grand Total                             | ₹25,031.40
```

Three things worth stealing and one worth avoiding:
- **It is the only one of the four carrying a hallmarking line.** ₹43.68 × 1.03 = ₹44.99 ≈ **₹45**, the BIS published per-article gold charge (§4.1). That is my arithmetic inference, not a GIVA statement — but it reconciles exactly.
- **Discounts are modelled as negative line items**, not as a separate discount field. That keeps the breakup summing to the total, which is the property that matters.
- **Net vs gross weight is shown separately** (metal 1.64 g, total 1.68 g) — the only site besides CaratLane to model both. §7.2 already has `netMetalWeightMg` and `grossWeightMg`; this validates carrying both.
- **Avoid CaratLane's making-charge row.** It is labelled `Rs. 5794/g` × `1.800 g` with `value` = `Rs. 5794`. 5,794 × 1.8 = 10,429 ≠ 5,794. The actual charge is a flat ₹5,794 and the `/g` suffix is simply wrong. A breakup that does not reconcile is worse than no breakup.

Melorra is the only site expressing making charges as a true rate per gram that reconciles: `2900/g × 3.185 g = 9,236 → −10% → 8,312`. §7.2's `makingChargeType: per_gram | percent | flat` covers every form observed in the market.

### 2.2 What the law requires versus what is competitive

This distinction gets muddled constantly, so state it plainly:

- **Legally required on the page:** a total price in a single figure **plus a breakup of all compulsory and voluntary charges including tax** — Rule 7(1)(e) of the Consumer Protection (E-Commerce) Rules, 2020 ([gazette](https://egazette.gov.in/WriteReadData/2020/220661.pdf)). See §4.3.
- **Legally required on the invoice:** description of each article, **net weight of precious metal, purity in carat and fineness, and hallmarking charges** — BIS (Hallmarking) Regulations 2018, Reg. 5(11) ([gazette](https://www.bis.gov.in/bs/BIS_Hallmarking_Regulations_2018_Gazette_notification.pdf)). Reg. 5(13) requires records to be kept **five years or until sold, whichever is longer** — relevant to the §7.6 snapshot and to the DPDP retention discussion in §4.6.
- **Not legally required anywhere:** the gold rate per gram, the making charge as a separate figure, or a GST percentage. I full-text-searched the Mandatory Hallmarking Order 2020 — **zero occurrences of "price", "rate", "invoice" or "bill"**. Do not cite HUID rules as a price-transparency requirement.

So the metal/making/stone breakup is **competitive table stakes, not statute** — but 4 of 4 accessible competitors ship one and 3 of 4 publish ₹/g. Build it.

⚠️ **One legal risk in the other direction, and it is real: drip pricing.** If making charges or hallmarking appear only at checkout rather than on the product page, that is precisely the pattern the **CCPA Dark Patterns Guidelines, 2023** are reported to prohibit (drip pricing, basket sneaking). **[UNVERIFIED]** — I could not reach consumeraffairs.nic.in to read the guidelines; settle from the CCPA notification. Either way, showing the full breakup on the PDP is both the competitive answer and the safe one.

**GST is a single 3% on the whole subtotal, never a 3%/5% split** — see §4.2 for the CBIC FAQ text. All four competitors compute it exactly this way. §7.4's and §7.6's single `gstRateBps` column is correct.

### 2.3 Rate lock — there is no industry norm for finished jewellery

**Searched hard, found nothing.** Every incumbent's terms operate at *day* granularity with an unbounded change-at-will clause:

| Player | Published position |
|---|---|
| **Tanishq** | *"Prices on our Website are subject to change without notice."* / *"you will be charged the price for the jewellery as it is listed on the day of purchase."* No gold-rate clause, no cart-repricing clause |
| **BlueStone** | *"Our pricing is calculated using current precious metal and gem prices… These prices change from time to time, owing to the fluctuations… so our prices change as well"* ([T&C](https://www.bluestone.com/tnc.html)) |
| **Melorra** | The only one naming a binding moment: *"For any order the price is the prevailing price on the day the order is confirmed"* ([terms](https://www.melorra.com/terms-of-use/)) |
| **GIVA** | Cuts the *opposite* way from a lock: *"The price on the website/app is based on average product weight… A deviation in weight of the actual product may result in a minor excess charge/refund, both of which shall be communicated **within 48 hours of placing your order**"* ([terms](https://www.giva.co/pages/terms-of-service)) — an explicit **post-order upward repricing window** |
| **CaratLane** | **No pricing clause of any kind.** Telling asymmetry: the same company publishes a 5-minute validity for its *digital gold* product and nothing at all for jewellery |

> **So whatever §7.4 chooses is an invention, not a copy.** That is liberating and also means there is no benchmark to hide behind. Note that a hard `expires_at` with a forced re-quote is *stricter and more consumer-friendly* than what any of these five publish — none of them commits to honouring a price at all.

**Minute-level validity exists only on the digital-gold rail**, and there the numbers are concrete:

| Platform | Published validity | Confidence |
|---|---|---|
| **SafeGold** (refiner, the reference implementation) | **7 min server-side**, **5 min** recommended at the distributor, **10 min** buy-confirm ceiling | Published in API docs |
| **CaratLane digital gold** | *"Price is only valid for 5 mins"* | **Verified, primary** ([page](https://www.caratlane.com/caratlane-digital-gold/buy-gold)) |
| Amazon Pay | *"valid for a period of 5 mins, post which it will be refreshed"* | Semi-verified |
| MMTC-PAMP | *"a specific time period window"* — **no number published** | Verified absent |
| PhonePe (5 min) / Paytm (6 min) | secondary sources only | **[UNVERIFIED]** |
| Google Pay, Augmont, Jar, Gullak | none published | Verified absent / [UNVERIFIED] |

**SafeGold's mechanism is the single most useful architectural datum in this section.** From its API docs: *"The rate would be valid for **7 minutes** on SafeGold's side"* and *"The timer for the Buy Price should be valid for **5 mins** at the Distributor's side as there is a validity of 7 minutes on SafeGold's side"* — a deliberate two-minute safety buffer. The server issues a **`rate_id`**; the distributor sends the `rate_id`, **never a price**, to Buy Verify; Buy Confirm must follow within 10 minutes or the transaction fails. ⚠️ `api-doc.safegold.com` is a JS-rendered ReadMe site that failed direct fetch; text came from the search index of those exact URLs, consistent across three queries — **[UNVERIFIED by direct render]**.

Note also that **digital gold is unregulated**: SEBI wrote to NSE on 3 Aug 2021, and NSE's [circular of 10 Aug 2021](https://www.moneylife.in/article/nse-bars-members-from-selling-digital-gold-after-sebi-raises-concerns/64952.html) required members to *"cease to undertake all activities in this regard within one month"*, citing Rule 8(3)(f) SCRR 1957. Borrow the *engineering pattern*; do not borrow the product.

### 2.4 Multi-day locks exist, but they are bought with cash and are always lower-of-two

| Scheme | Advance | Lock duration | Structure |
|---|---|---|---|
| **Malabar Gold & Diamonds** | 10% / 50% / 100% | **30 / 90 / 180 days** | *"If gold rate increases… customers can avail the blocked rate and if it reduces they can still draw mileage of the reduced rate"* ([Khaleej Times](https://www.khaleejtimes.com/kt-network/pay-10-advance-to-block-gold-rate-at-malabar-gold-and-diamonds), [Retail Jeweller](https://retailjewellerindia.com/malabar-extends-gold-rate-protection-scheme-until-september-30/)) |
| **Tanishq** (2023 offer) | min 50% | ~6 weeks | *"the lowest gold rate between advances booking date and billing date will be applicable"*. Episodic, not standing — Titan's jewellery CEO: *"We typically bring it out from our armoury whenever there is a lot of gold price volatility"* ([Retail Jeweller](https://retailjewellerindia.com/tanishq-reintroduces-advanced-booking-option-for-gold-amid-soaring-prices/)) |
| **Kalyan × Instamart**, Akshaya Tritiya 2026 | 5% (min ₹500) | **3–9 days**, with a 4-hour redemption window | lower-of-two ([source](https://www.passionateinmarketing.com/instamart-and-kalyan-jewellers-enable-customers-to-lock-todays-gold-price-for-akshaya-tritiya/)) |
| **Senco** | min ₹5,000 | no stated expiry | **The cleanest pattern: they book *grams*, not a price** — *"The gold quantity will be booked on gold rate of 22K published on the website on the date of online transaction"* ([page](https://sencogoldanddiamonds.com/book-gold-online)). No forward price promise, therefore no exposure |

**Every multi-day lock in India is "lower of the locked rate or the prevailing rate", which caps the retailer's downside at exactly zero.** If Alankar ever offers one, offer it that way.

⚠️ **And there is a hard 365-day ceiling with a legal reason.** Under **Rule 2(1)(c)(xii)(a) of the Companies (Acceptance of Deposits) Rules, 2014**, an advance for supply of goods is not a deposit only if *"appropriated against supply of goods or provision of services within a period of three hundred and sixty five days from the date of acceptance."* Beyond that it becomes a deposit and s.73 of the Companies Act 2013 bars it; a pooled corpus above ₹100 crore risks being a collective investment scheme under s.11AA(1) of the SEBI Act ([LiveLaw](https://www.livelaw.in/articles/law-relating-to-jewellery-brands-gold-savings-schemes-279580)). **Correction to a commonly-cited figure: the "25% of net worth" cap does *not* apply to customer advances** — the 25% in Rule 3(3) caps *deposits from members* at 25% of paid-up capital plus free reserves. Do not cite it. And note this is Companies Act / SEBI territory: **RBI has no rule here.**

Instalment schemes are **not** price locks. Tanishq Swarnanidhi redeems *"at gold rate applicable at the time of redemption"*; BlueStone's Gold Reserve is explicit that *"The Gold Rate applies at the time of payment and at maturity"*. Grams are locked; price is not.

### 2.5 Where to get the rate — IBJA is the answer

**IBJA rates are free to view and are the exact number an Indian jeweller quotes from.** [ibjarates.com](https://ibjarates.com/) publishes AM and PM rates for gold purities **999 / 995 / 916 / 750 / 585** plus silver 999 and platinum 999, with a rolling 30-day history. The footer states: *"Gold rates per 10gm & Silver rate per 1kg"* and *"The above rates are without 3% GST and Making Charges."*

> **IBJA 916 *is* 22K, pre-GST, pre-making, duty-inclusive, India-local.** It is precisely the input `gold_rates.ratePerGramPaise` needs.

**The publication mechanism is the LBMA-fix analogue, and it is documented** ([spot polling mechanism PDF](https://ibjarates.com/pdf/spot-polling-mechanism/spot-polling-mechanism.pdf), verbatim):

> *"'Tradable Prices' are polled twice daily from **29 physical market participants** between **11:30 AM to 12:00 PM** and **4:30 PM to 5:00 PM**. Prices is displayed at around **12:05 PM and 5:05 PM** on all business days."*
> *"While calculating average price, **one highest price and one lowest price is discarded**."*
> *"Inclusive of all taxes and levies relating to import duty, customs but **excluding GST**… This price are India prices."*
> *"After arriving at 995 purity rates, the price for 999 purity is worked out. The price for other purity is worked out keeping 999 purity price as base price."*

IBJA is RBI-recognised for the 30-day rates banks use for gold-loan LTV and for SGB issue/redemption pricing.

**The machine-readable feed is paid and email-gated.** [indiagoldratesapi.com](https://indiagoldratesapi.com/) states only *"It is a paid subscription. To know more about the pricing write to"* (nagaraj.iyer@ibja.in). No published price, no free tier, no public docs, no self-serve signup, and the auth scheme is undocumented. ibjarates.com carries a notice that parties using IBJA prices *"for valuation and pricing activities and in transactions & financial products are advised to subscribe IBJA rates only through OFFICIAL IBJA API"* — i.e. **scraping the free page for commercial pricing is discouraged by the publisher**, though ibjarates.com/terms.html 404s and no licence text is published. **[UNVERIFIED]** price: SPMCIL (a Government of India PSU) publishes an [awarded tender](https://www.spmcil.com/en/awarded-tender/ibja-rates-data-subscription-yearly-fees/) titled *"IBJA Rates Data Subscription Yearly Fees"* naming "Indian Bullion and Jewellers" and carrying the figure **354000** — but that page's label/value pairs are visibly misaligned, so ₹3,54,000/yr is a plausible read, not a fact. One email settles it.

**MCX is out, for two independent reasons.** From the [data feed policy](https://www.mcxindia.com/technology/datafeed) and the [domestic vendor price list](https://www.mcxindia.com/docs/default-source/datafeedlink/mcx-data-feed-price-list-for-domestic-vendors----effective-from-july-01-20246be30cd5-d0b6-46c8-a0de-10c9cfabed14.pdf):

1. **The licence forbids what you want to do.** Verbatim: *"Both real-time and delayed data can be displayed on mobile apps or any other electronic display; however, **only delayed data is allowed for public display on the websites**. Resale of data, in any form, whatsoever, is not permitted."*
2. **The price is absurd at this scale.** Real-time single non-agri commodity with website display: **₹6,00,000/yr**. The cheapest legally-clean path — 15-minute delayed, single segment at 80% of list — is ₹1,60,000/yr plus ₹1,00,000/yr connectivity ≈ **₹2.6 lakh/yr + taxes**. There is also no HTTP API: access requires a signed undertaking, an order form on letterhead with seal, and annual payment in advance.

**Commercial aggregators, if a machine-readable feed is wanted:**

| Provider | Endpoint / auth | Free tier | Paid from | Gives Indian retail 22K ₹/g? |
|---|---|---|---|---|
| **Metals.Dev** | `api.metals.dev/v1/latest?api_key=…&currency=INR&unit=g`; also `/v1/metal/authority?authority=ibja` (and `mcx`) — query-param key | **100 req/month**, no card | $1.79/2k req per month ([pricing](https://metals.dev/pricing)) | **Partly — and it resells IBJA.** Ships `ibja_gold`, `mcx_gold`, `mcx_gold_am`, `mcx_gold_pm`; supports `currency=INR`, `unit=g`. **Purity is not broken out** — one gold number, derive 916/750/585 yourself |
| **Metals-API** | `metals-api.com/api/gold-price-india` — query-param key | **None** | $19.99/2.5k req per month ([pricing](https://metals-api.com/pricing)) | **Yes, best-in-class.** Dedicated India endpoint working exclusively in INR; **114 symbols = 38 Indian cities × {18k, 22k, 24k}, per gram** — `MUMB-22k`, `DELH-22k`, `JAIP-22k`, … ([symbols](https://metals-api.com/symbols)) |
| **GoldAPI.io** | `goldapi.io/api/XAU/INR` — **`x-access-token` header** | 100 req/month | **$99/month** unlimited ([pricing](https://www.goldapi.io/pricing)) | **No — spot only.** Returns `price_gram_22k` etc., but these are pure metal-proportion derivations of XAU spot (`exchange: "FOREXCOM"`) |
| **MetalpriceAPI** | `api.metalpriceapi.com/v1/latest`, `/v1/carat` — key as query or `X-API-KEY` | 100 req/month | $5/1k per month | **No — spot-derived** |
| **Zyla "Gold Price India"** | `zylalabs.com/api/6254/…/price+22+k` — `Authorization: Bearer` | 7-day trial | $24.99/500 req per month | **Yes but thin** — national 24K/22K in ₹ **per 10 grams**, no city breakdown, no parameters |
| Twelve Data / Alpha Vantage / exchangerate.host / UniRateAPI / API Ninjas | various | 25–800 req/day | $9–$49/month | **No** — XAU or LBMA spot. API Ninjas' free tier is additionally **non-commercial and 15-min delayed** |
| Augmont / MMTC-PAMP / SafeGold / Jar / Gullak | partner-gated | — | not published | **These are transaction rails, not rate feeds.** No self-serve rate API from any of them |

**All of these are edge-compatible** — plain HTTPS GET plus a static credential in a query param or header, no SDK, no Node built-ins, no mTLS. Every one works from a Worker with `fetch()`. The only two that do not are MCX (signed agreement, leased line, no HTTP API) and IBJA's official API (auth scheme undocumented until you subscribe). Note the free tiers are small — but **one cron pull per IBJA publication window (12:05 and 17:05 IST) is ~44 requests/month** and fits every free tier with enormous headroom.

⚠️ **"swapsAPI" does not exist** as an indexed service. If it is real it is under another name.

### 2.6 Do not derive the rate from XAU spot

This is the trap. The naive chain is `XAU/USD per troy oz → ÷31.1035 → ×USDINR → ×0.916`. It produces a number that is not what any Indian jeweller quotes, because the landed-cost stack is both large and unstable:

- **Import duty is a live variable.** The July 2024 Budget cut it from 15% to ~6%. Then, per the [World Gold Council, 22 May 2026](https://www.gold.org/goldhub/gold-focus/2026/05/india-gold-market-update-import-tightening): *"the gold import duty was raised sharply by 9% – from 6% to 15%, the steepest increase on record."* **[UNVERIFIED]** exact BCD/AIDC split and CBIC notification date — settle from the customs tariff notification before hard-coding anything.
- **The domestic-vs-international spread is not a constant.** Same WGC source: after the duty hike Indian domestic gold traded at a *discount* to international parity, *"widening from an average of US$14/oz the week prior to the duty hike to nearly US$150/oz."* A spread that moves $136/oz inside one week cannot be modelled as a fixed premium.
- IBJA's own methodology states its rate is *"Inclusive of all taxes and levies relating to import duty, customs but excluding GST."* **Deriving from XAU is reconstructing — badly — a number that is published free twice a day.**

Use an India-native rate. Keep an XAU feed, if at all, only as a staleness sanity-check.

### 2.7 Recommendation, and how it lands against §7.3, §7.4 and §7.5

**Rate source.** Day one: **manual entry from ibjarates.com**, which is exactly what `gold_rates.source = "manual"` in §7.3 already defaults to, and exactly what the small end of the trade does. The ERP vendors' own marketing confirms manual entry is the incumbent behaviour — [Synergics](https://www.synergicssolutions.com/20-must-have-features-in-modern-jewellery-erp-software) sells against *"time-consuming manual price edits"*, and the distribution channel below ERP is [a WhatsApp rate card](https://richautomate.in/blog/whatsapp-gold-rate-broadcast-jewellers-india-2026). When automation is wanted, **Metals.Dev's free tier with `authority=ibja&currency=INR&unit=g`** is the cheapest correct answer; **Metals-API's `gold-price-india`** is the only feed giving true city-level 22K ₹/g.

**Quote validity.** There is no norm to copy, so copy the *mechanism* from SafeGold and set the *duration* from the product:

- **The listing price is day-granular** (or half-day, matching IBJA's AM/PM publication). That is what every competitor does and what §7.5's "recompute on every cart view" already implies.
- **The checkout quote is minute-granular**, issued as a `price_quotes` row, with the gateway order created for exactly `totalPaise` and the client never permitted to send a price. This is already the §7.4 design.
- **Suggested window: 15 minutes user-facing against a 20-minute server-side `expires_at`**, mirroring SafeGold's deliberate 5-vs-7 buffer at a scale appropriate to the transaction. SafeGold's 5 minutes is right for a ₹5,000 impulse purchase on a rail that hedges continuously; it is hostile for a ₹3 lakh Jadau set where the customer may need to switch to a banking app, complete a two-factor step, or phone their spouse. **[DECIDE]** — this is a product judgement, and the research cannot settle it because nobody in the market publishes one.

**Where this confirms §7.4 and §7.6:**
- The `rate_id`-not-price pattern is exactly what `price_quotes` + `order_items.goldRateId` implement. Independent confirmation from the only published reference implementation in the Indian market.
- Refusing to accept payment against an expired quote, and refunding rather than force-fitting, is *stricter* than every incumbent's published terms. Keep it.
- `gold_rates` being append-only with `effective_from`/`effective_to` maps perfectly onto IBJA's twice-daily publication: **two rate rows per business day**, closed and opened at 12:05 and 17:05 IST. The partial unique index on "exactly one current rate per (metal, purity)" is exactly right for this cadence.
- §7.5's decision **not** to snapshot price at add-to-cart is confirmed by the whole market: every incumbent reprices at day granularity and none freezes at add-to-cart. GIVA goes further and reserves an upward adjustment 48 hours *after* order.

**Three concrete conflicts or gaps with what §7 already says:**

1. **Purity vocabulary mismatch.** `gold_rates.purity` in §7.3 is documented as `"24K" | "22K" | "18K" | "14K" | "925"`. **IBJA publishes 999 / 995 / 916 / 750 / 585.** These are fineness, not karat, and 995 has no karat equivalent in the enum at all. Either store IBJA's fineness codes and map to karat for display, or add an explicit `fineness` column. Getting this wrong means silently mapping 995 onto 24K, which is a real pricing error. **Resolve before the first migration** — §7.10 notes migrations are forward-only.
2. **Unit conversion.** IBJA quotes **per 10 grams**; `ratePerGramPaise` is per gram. ₹98,500/10 g → 985,000 paise/g. The division is exact so long as IBJA quotes whole rupees per 10 g. **Verify that assumption against a live IBJA page before relying on it**, and if IBJA ever publishes paise, decide the rounding rule explicitly rather than letting integer division silently truncate.
3. **`hallmarkingPaise` defaults to 0 and should not stay there.** BIS publishes **₹45 per article for gold and ₹35 for silver** plus applicable taxes (Revised Guidelines for Jewellers, Jan 2024, cl. 3.3.5). GIVA is the only competitor showing it as a line, and it appears to be charging exactly the BIS figure. The original 2018 Regulations Schedule IV had ₹35/article gold with a **₹200 minimum per consignment**; **[UNVERIFIED]** whether that consignment minimum was revised alongside the per-article rate — settle from the BIS (Hallmarking) Amendment Regulations gazette. Note that under §4.1 the hallmarking charge must appear **separately on the invoice**, so this is not optional polish.

---

## 3. Payments in India, from a Cloudflare Workers runtime

### 3.1 The shortlist, and why Stripe is out

**Stripe India is not available to you.** Stripe's own help page: *"Businesses from India can't sign up for a new Stripe account through our website, and must request an invite instead"*, and Stripe *"currently only supports a select number of businesses, with a focus on international expansion"* ([Stripe support](https://support.stripe.com/questions/stripe-accounts-are-invite-only-in-india); background: [TechCrunch, 31 May 2024](https://techcrunch.com/2024/05/31/stripe-curbs-india-ambitions-over-regulatory-changes/)). A single-shop jeweller is precisely the profile Stripe India is not onboarding. This confirms the §8.3 line on the `stripe` package for a commercial reason, not a technical one.

| | Razorpay | Cashfree | PayU |
|---|---|---|---|
| Domestic cards / netbanking | 2% + GST | 0% promo / 1.95% standard | ⚠️ 2% (secondary source only) |
| UPI | **still 2% + GST** — see below | 0% promo / 1.95% | ⚠️ 2% |
| Settlement | **T+2** (docs) | T+1 | **[UNVERIFIED]** |
| Webhook signature | HMAC-SHA256, hex, dedicated header | HMAC-SHA256, base64, dedicated header | plain SHA-512 reverse-hash in the payload + IP allowlist |
| Setup / AMC | zero | zero | ⚠️ zero |

- Razorpay pricing: [razorpay.com/pricing](https://razorpay.com/pricing/). On UPI the page says *"merchants are not charged a transaction fee by the bank. However, a standard platform or technology fee of 2% will be applied"* — i.e. **UPI's regulatory MDR is zero but Razorpay bills 2% anyway.** ⚠️ The same page carries a footnote reading `* Platform fee 2.15% + GST`. **[UNVERIFIED]** which applies to a new standard-plan merchant; settle with a written rate card from Razorpay sales before modelling margins.
- Cashfree: [payment-gateway-charges](https://www.cashfree.com/payment-gateway-charges/) — 0% is a limited-period offer for merchants signing up 18 Sep 2025 – 31 Jul 2026, valid to 31 Mar 2027, **capped at ₹20 L/month** and requiring **UPI ≥ 40% of monthly volume**. For a jeweller with a ₹70k AOV, a single ₹5 lakh month is 25% of the cap.
- PayU: `payu.in/payment-gateway-charges` 404s. Figures are from [PayUmoney's FAQ](https://ux.payumoney.com/faq-pricing.html) and third parties. **[UNVERIFIED against a current first-party page.]**

**Recommendation: Razorpay, with Cashfree as the fallback.** Razorpay has the cleanest webhook contract, the best docs, and Basic-auth REST. Cashfree is materially cheaper *today* but the promo has real strings and expires inside this project's likely lifetime. **PayU is the one to avoid on this stack** — see §3.2.

### 3.2 Webhook signature schemes — exact specifications

**Razorpay webhook** ([docs](https://razorpay.com/docs/webhooks/validate-test/)):

| | |
|---|---|
| Header | `X-Razorpay-Signature` |
| Algorithm | HMAC-SHA256 |
| Key | the **webhook secret** set in the Dashboard — *not* `key_secret` |
| Message | the **raw request body**, verbatim bytes |
| Encoding | **hex** |
| Replay defence | no timestamp in the signed string; dedupe on the `x-razorpay-event-id` header |

Razorpay's docs are explicit about the trap: *"The hash signature is calculated using HMAC with SHA256 algorithm; with your webhook secret set as the key and the webhook request body as the message"* and *"ensure that the webhook body passed as an argument is the raw webhook request body. **Do not parse or cast the webhook request body.**"* This is the same warning already recorded in §9.3.

**Razorpay checkout-handler verification** ([integration steps](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/)) — a *different* signature with a *different* key:

```
generated_signature = HMAC_SHA256(order_id + "|" + razorpay_payment_id, key_secret)   // hex digest
```

Single pipe separator, hex digest, keyed with the **API `key_secret`**. The docs add an instruction that matters for §7.7: *"order_id: Retrieve the order_id from your server. **Do not use the razorpay_order_id returned by Checkout.**"* Read it from D1, keyed off the `price_quotes` / `payments` row.

**Cashfree webhook** ([docs](https://www.cashfree.com/docs/payments/online/webhooks/overview)) — cross-check, and note it is *not* the same shape:

```
signature = Base64( HMAC_SHA256( x-webhook-timestamp + rawBody, clientSecret ) )
```

Headers `x-webhook-signature` and `x-webhook-timestamp`; timestamp concatenated directly onto the raw body with **no delimiter**; **base64**, not hex. Same raw-body warning.

**PayU is the outlier and the reason to avoid it here.** PayU publishes no HMAC signature header for payment webhooks. Integrity comes from a `hash` field *inside* the payload plus an **IP allowlist** ([webhooks](https://docs.payu.in/docs/webhooks), which lists prod IPs `3.7.89.1/2/3` and DR `52.140.8.88/89/64`). The reverse hash is a plain SHA-512 over a pipe-delimited string with the salt as a *field*, not a key ([hashing docs](https://docs.payu.in/docs/hashing-request-and-response)):

```
sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)
```

The SHA-512 itself is trivial on Workers (`crypto.subtle.digest`). The problem is the **IP allowlist**: on Cloudflare Workers you do not cleanly control ingress IP filtering, and `CF-Connecting-IP` on a request that has traversed Cloudflare is not a security boundary you'd want to stake payment capture on. Combined with an unverifiable rate card, PayU is the weakest fit.

### 3.3 Confirmed implementable with `crypto.subtle`

I verified the Workers Web Crypto support matrix directly ([docs](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)): **`HMAC` is supported for `importKey()`, `sign()` and `verify()`**, alongside `SHA-256` and `SHA-512` digests. Nothing any candidate needs is RSA-signed, X.509-based, or a Node-only primitive.

```ts
const key = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(webhookSecret),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
);
const raw = await request.text();                       // MUST be before any JSON.parse
const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
```

Two runtime details worth knowing:

- **Workers ships a non-standard `crypto.subtle.timingSafeEqual(a, b)`** — *"Compare two buffers in a way that is resistant to timing attacks. This is a non-standard extension to the Web Crypto API."* Use it (or `crypto.subtle.verify`) rather than `===` on the hex string.
- **Read the raw body first, once.** `await request.text()` before any parse; HMAC that exact string; `JSON.parse` the same string afterwards. Re-serialising a parsed object changes bytes and the MAC will never match. Razorpay is hex, Cashfree is base64 — do not copy the encoding step between them.

Razorpay's REST API itself is **HTTP Basic auth**: *"All Razorpay APIs are authenticated using `Basic Auth`"* with Key ID as username and Key Secret as password, base URL **`https://api.razorpay.com/v1`** ([auth docs](https://razorpay.com/docs/api/authentication/), [API docs](https://razorpay.com/docs/api/)). On Workers that is `Authorization: 'Basic ' + btoa(keyId + ':' + keySecret)`. The docs warn the header must adhere strictly to the format — lowercase `basic` or an uppercase `BASIC` will fail. **This is the whole reason §8.3 rejects the `razorpay` npm package: there is nothing an SDK gives you here.**

### 3.4 KYC, onboarding, and whether jewellery is a restricted category

**Jewellery is not prohibited — I verified this directly.** I fetched `https://razorpay.com/terms/` and extracted the prohibited-goods enumeration (Part A, the list running "Adult goods and services … Alcohol … Body parts … Counterfeit and unauthorized goods … Gaming/gambling … virtual currency"). The strings **"jewell", "gold", "bullion" and "precious" appear zero times anywhere in the document.** Cashfree's equivalent list likewise omits jewellery.

**But it is extra-underwritten, with a jewellery-specific document requirement.** Razorpay's [Account Activation Support](https://razorpay.com/docs/payments/account-activation-support/) page names it explicitly: *"If your business involves the sale of precious gems or jewellery, you are required to have a **BIS Certificate**"* (916 Hallmark / BIS), plus a **GIA Certificate** for merchants dealing in precious stones/diamonds and an **MMTC PAMP Certificate** for advanced precious metals. Cashfree matches, requiring a *"BIS certificate, or 916/925 hallmark"* ([onboarding FAQs](https://www.cashfree.com/docs/help/onboarding-related/onboarding-faqs)).

> **This creates a hard dependency between §3 and §4: the payment gateway will not activate without BIS registration.** The compliance work in §4.1 is not a parallel workstream that can slip — it is a blocker on taking any money at all.

**Documents** ([Razorpay KYC by business type](https://razorpay.com/docs/payments/business-types-kyc-documents/); the per-entity list is JS-rendered and did not resolve — **[UNVERIFIED]** at line-item level). Cashfree's published equivalent is a good proxy: proprietorship needs any one of a Registrar of Companies certificate, a **Shops & Establishment licence**, or a Sales/Income-Tax return; partnership needs a **partnership deed** or Registrar of Firms certificate; both need PAN, phone-linked Aadhaar, bank details and a beneficial-ownership declaration. Razorpay's own rule: *"The PAN Card details and authorised signatory address proof… should be of the same person."*

**Timelines — the official claim and the reported reality diverge sharply:**

- Official: Razorpay markets [*"Express Activation — Get Started with Razorpay Within 1 Hour"*](https://razorpay.com/blog/introducing-express-activation/) and CKYC fast-track activation "in minutes"; realistically 3–7 working days with clean documents. Cashfree publishes 24–48 working hours after document verification.
- Reported: [Trustpilot](https://www.trustpilot.com/review/razorpay.com) and [ConsumerComplaints](https://www.consumercomplaints.in/razorpay-b115695) carry accounts of KYC dragging past **six months**, 40–50 day waits ending in suspension, and **settlements held pending open-ended "additional documents"** requests.
- The single most common rejection trigger is a **name mismatch** between bank account, PAN, GST legal name and shop licence. For a proprietorship, make these match character-for-character before applying.

**[UNVERIFIED]** any published per-transaction ceiling. The binding limits in practice are the UPI category cap (§3.6), issuer limits, and the PA's own risk-based velocity caps, which are set per-merchant at underwriting and never published. **Ask for your assigned per-transaction and daily caps in writing at onboarding** — for a jeweller expecting ₹1–2 lakh tickets this is a pre-integration question.

### 3.5 Settlement

Razorpay's docs are unambiguous: *"The standard settlement cycle for domestic payments is **T+2** working days"*, and *"The settlement cycle is subject to bank approval and can vary based on your business vertical, risk factors and so on"* ([settlements](https://razorpay.com/docs/payments/settlements/)). ⚠️ The marketing pricing page claims T+1. **Trust the docs.** Given the explicit "business vertical" carve-out and jewellery's underwriting profile, plan for T+2 or worse. Cashfree publishes T+1. PayU **[UNVERIFIED]**.

### 3.6 UPI — and the ₹2,00,000 wall

NPCI raised P2M limits by merchant category via a circular dated **28 August 2025, effective 15 September 2025** (addendum to OC-185-A). Some categories went to ₹5 lakh per transaction. **Jewellery is a named category with a *lower* limit: ₹2 lakh per transaction, ₹6 lakh cumulative daily** ([Outlook Money](https://www.outlookmoney.com/banking/npci-changes-upi-transaction-limits-for-key-categories-from-september-15-2025-know-the-details)), and enhanced limits apply **only to verified merchants** in the classified category ([Paytm](https://paytm.com/blog/news/upi-higher-transaction-limits-sep-2025/)).

⚠️ **[UNVERIFIED at source.]** npci.org.in serves an Akamai 403 to this environment for both WebFetch and curl-with-browser-UA, so the figures are from secondary reporting, and sources disagree on whether ₹2 lakh is the per-transaction or the daily limit. **Settle it by downloading OC-185-B from [the NPCI circular list](https://www.npci.org.in/what-we-do/upi/circular) in a browser.** This is the number I would most want re-verified before writing checkout logic.

**Design consequences either way:**
- UPI cannot be the only payment path. A ₹2,50,000 Jadau set will not clear on UPI.
- The merchant category must actually be classified as jewellery *and verified* with the PA for even ₹2 lakh to apply; the default P2M limit is lower.
- The checkout should decide which methods to offer **based on the order total**, and say so before the customer commits.

### 3.7 COD — do not offer it

**Couriers largely prohibit shipping jewellery at all, never mind collecting cash for it.** Blue Dart's [banned commodities list](https://www.bluedart.com/banned-commodities) bans *"Precious & Semi-Precious Items"* and *"Bullion"* across **all** services, domestic and international; its "Domestic Priority Dutiable" workaround is scoped to **imitation** jewellery ([press release](https://bluedart.com/press255)). Shiprocket lists *"Precious stones, gems and jewelry"* as [restricted with no liability](https://support.shiprocket.in/support/solutions/articles/43000460506-which-products-are-prohibited-dangerous-to-ship-via-shiprocket-), and precious metals and gold/silver jewellery are [excluded from Shiprocket Secure insurance](https://support.shiprocket.in/support/solutions/articles/43000640225-list-of-goods-not-covered-under-shiprocket-secure). Delhivery's list is published as an image — **[UNVERIFIED]**.

What the trade actually does is a **token advance**. Candere (Kalyan) publishes the clearest version: *"Maximum Cash to be paid on delivery is Rs. 50,000/-"*, *"you can pay 25% of the total product value in advance online and the remaining amount on delivery"*, selected pincodes only, photo ID at handover ([shipping & COD](https://www.candere.com/shipping-cod.html)). BlueStone offers pincode-checked COD with no published cap ([FAQ](https://www.bluestone.com/faq.html)).

> **Recommendation: no COD.** Offer (a) full prepaid online, and (b) a **booking advance** with the balance settled at in-store pickup. That single choice sidesteps the courier prohibition, the UPI ₹2 lakh ceiling, and the s.186 cash limit in §4.7 simultaneously — and it matches how this shop already sells (§7.8).

### 3.8 RBI card tokenisation — applies, but not to you

Under RBI's card-on-file tokenisation regime (circular `CO.DPSS.POLC.No.S-516/02-14-003/2021-22`, 7 Sep 2021, and the [storage restriction notification](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=12363&Mode=0)), **no entity in the transaction chain other than card issuers and networks may store card-on-file data**, enforced from 1 Oct 2022, irrespective of PCI-DSS status. The only permitted retention is the last four digits plus the issuer name.

**Use hosted or Standard Checkout and this is entirely the gateway's problem.** Your Worker sees only `razorpay_order_id`, `razorpay_payment_id` and `razorpay_signature`; no PAN ever reaches it. The only way to create a compliance problem is to build a custom card form — don't. This is already the correct instinct in §9.3 ("Storing card data. Never."); the citation above is why it is a regulatory obligation and not just hygiene.

⚠️ **[UNVERIFIED at source]** — rbidocs.rbi.org.in PDFs are CAPTCHA-gated from this environment; circular numbers and operative text come from search extraction plus explainers ([SISA](https://www.sisainfosec.com/blogs/rbi-tokenization-circular-update-the-what-why-and-how/)). Settle by opening the RBI notification link in a browser.

Separately and **live today**: RBI's [Storage of Payment System Data directive (6 Apr 2018)](https://www.rbi.org.in/Scripts/NotificationUser.aspx?Id=11244) requires payment system data to be stored only in India. Using an Indian PCI-compliant gateway and never touching card data is what discharges this. Note this is the one place where "Cloudflare, everywhere" needs a conscious answer — and the answer is that *payment* data never lands in your D1 at all.

### 3.9 What the feature flag must actually gate

The decision is a full checkout UI now, real capture behind a flag until KYC clears. Being precise about the seam matters, because a flag that gates too little leaks real money and a flag that gates too much leaves the untested path untested.

**Gate (off until KYC clears):**
- Creating a **gateway order** — the outbound `POST /v1/orders` to `api.razorpay.com`.
- Mounting the gateway's **checkout widget / redirect**.
- The **webhook route's capture branch** — the part that transitions `payments.status` to `captured` and, per §7.7 step 3, runs the order-placement `db.batch()`.
- Any **refund** call.

**Do NOT gate (build and exercise from day one):**
- Cart, address capture, shipping and **the whole §7.4 quote computation**. Pricing correctness is the hard part and it must be exercised long before payments go live.
- Writing the `price_quotes` row and reserving stock (§7.7 steps 1–2).
- The **`webhook_events` idempotency table** and signature-verification helper — these should be unit-tested against Razorpay's published test vectors regardless of activation state.
- Order creation, admin order list, invoice rendering.

**The flag-off path needs a real terminus, not a dead end.** With capture disabled, "Proceed to pay" should place the order in a `pending_payment` state and hand off to the existing appointment/enquiry flow — *"reserve this piece, pay at the shop"*. That is not a stub: per §1.3 it is what the business actually converts on, and per §3.7 it is the recommended permanent path for anything over ₹2 lakh. **Build it as the real product, and let the flag add card/UPI later rather than switch a placeholder off.**

**Add a `provider: "manual"` payment row** — §7.7's `payments.provider` enum already has it. That is how a shop-settled order gets recorded while the flag is off, and it keeps the order and invoice tables exercised.

**Sequencing note:** since gateway activation requires the BIS certificate (§3.4), the realistic order is *BIS registration → gateway KYC → flip the flag*. Start the BIS paperwork now.

---

## 4. Legal and compliance for selling jewellery online in India

> **Verification key used below:** ✅ read from the primary gazette/government text · ⚠️ secondary source only · **[UNVERIFIED]** could not confirm, with a note on what would settle it.
>
> ⚠️ **Two structural findings before the detail.** First, `app/site-config.ts` currently has `SITE_DETAILS_PENDING = true` with placeholder phone, address and email. **Most of §4.3 is undeliverable until those are real** — compliance is blocked on business facts, not on code. Second, `app/` has no `/terms`, `/privacy`, `/returns` or `/shipping` route at all. Those pages are not polish; several are legally mandatory.

### 4.1 BIS hallmarking and HUID

✅ The instrument is the **Hallmarking of Gold Jewellery and Gold Artefacts Order, 2020** ([S.O. 205(E), 15 Jan 2020](https://www.bis.gov.in/wp-content/uploads/2020/01/Mandatory-Hallmarking-Order-15.01.2020.pdf)), amended in phases. ✅ [PIB, 13 Mar 2026](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2239540) gives the rollout: 256 districts (Jun 2021) → 288 → 343 → 361 → 373 → **380 (2 Mar 2026)**.

> ✅ **The 380 figure every news source still quotes is already stale.** A seventh expansion was gazetted: **S.O. 2117(E), 28 April 2026** — *Hallmarking of Gold Jewellery and Gold Artefacts (Second Amendment) Order, 2026*, e-gazette CG-DL-E-29042026-272152 — which **substitutes the entire Annexure** with **385 districts** ([BIS PDF](https://www.bis.gov.in/wp-content/uploads/2026/05/Hallmarking-of-gold-jewellery-and-gold-artefacts-order-2026-second-amendments-385-districts-1.pdf)). **Check the shop's district against the Annexure of S.O. 2117(E), not against a news article.**

✅ **Caratages: all six of 14K, 18K, 20K, 22K, 23K and 24K are covered.** The 2021 amendment had limited the Order to 14/18/22K; [S.O. 1594(E), 4 Apr 2022](https://www.bis.gov.in/wp-content/uploads/2022/04/Hallmarking-of-Gold-Jewellery-and-Gold-Artefacts-Amendment-Order-2022.pdf) (in force 1 Jun 2022) **omitted** that restriction. **9K remains voluntary** under IS 1417:2016 — ⚠️ blogs claiming 9K became mandatory in July 2025 are wrong; PIB still calls it voluntary in March 2026. ✅ Silver hallmarking remains **voluntary**; HUID-based silver hallmarking under IS 2112:2025 started 1 Sep 2025 ([PIB](https://www.pib.gov.in/PressReleasePage.aspx?PRID=2163768)).

✅ **HUID.** Six-digit alphanumeric, laser-inscribed per article. **Sale of hallmarked gold without a HUID has been prohibited since 1 April 2023** ([PIB](https://www.pib.gov.in/PressReleaseIframePage.aspx?PRID=1904262)). ✅ The marks went from four to **three**: BIS Standard Mark + purity in carat and fineness + the 6-digit HUID ([BIS](https://www.bis.gov.in/hallmarking-jewellers/?lang=en)).

✅ **Exemptions (QCO cl. 2(3)) that matter enormously to this shop.** Alongside articles **under two grams** and gold bullion, the 2021 Second Amendment added exemptions for **Kundan, Polki and Jadaau**, and for **jewellers with annual turnover up to ₹40 lakh**. Definitions of Kundan, Jadaau and Polki are in [BIS guideline HMD/G-1, 04.01.2022](https://www.bis.gov.in/wp-content/uploads/2022/01/QCO_HMD.pdf).

> **This is directly relevant to a house selling antique Jadau and Polki: those categories are exempt from mandatory hallmarking.** Two consequences for §7.2. (a) `variants.huid` **must be nullable and the UI must not imply it is missing data** — for a Polki piece its absence is correct and lawful. (b) The site must not make a blanket "every piece is hallmarked" claim, because it will be false for the flagship category. ✅ The turnover exemption is an exemption from the *obligation*, not permission to sell unhallmarked goods as hallmarked: BIS states a sub-₹40-lakh jeweller *"may sell hallmarked jewellery… provided they have a certificate of registration from BIS."*

✅ **Registration is premises-based.** QCO cl. 2(1): gold articles *"shall be sold **only by registered jewellers through certified sales outlets**"*; Reg. 4(4): *"The certificate of registration shall be valid for the **premises mentioned in the certificate of registration**."* ⚠️ BIS's current published position is that registration is granted instantly, free, and valid for lifetime.

> **[UNVERIFIED — and material.]** Whether an online sale, or dispatch from premises other than the registered certified sales outlet, satisfies clause 2(1). I read the QCO, the 2018 Regulations, the 2021/2022/2026 amendments and the [Jan 2024 Revised Guidelines for Jewellers](https://www.bis.gov.in/wp-content/uploads/2024/01/Revised-Guidelines-for-JEWELLERS-Jan-24.pdf): **the words "e-commerce", "online sale" and "website" create no obligation anywhere in any of them.** Consultancy blogs asserting e-commerce-specific BIS duties cite no primary source. **Settle it** with a written query to the BIS Hallmarking Department or an RTI. **Safe design meanwhile:** register the physical shop as the certified sales outlet, ship from that address, and mirror the mandated in-store displays on the site (BIS logo, "Hallmarked Jewellery Available for Sale", registration number, the marking-components explainer, BIS contact details).

✅ **Invoice content is mandatory — Regulation 5(11), BIS (Hallmarking) Regulations, 2018** ([gazette](https://www.bis.gov.in/bs/BIS_Hallmarking_Regulations_2018_Gazette_notification.pdf)): *"The bill or invoice of sale of hallmarked precious metal articles shall indicate **separately description of each article, net weight of precious metal, purity in carat and fineness, and hallmarking charges**."* ✅ The Jan-2024 Guidelines (cl. 7.3) add a line stating the consumer may get purity verified at any BIS-recognised A&H centre.

> **This validates the §7.6 `order_items` snapshot design directly.** `netMetalWeightMg`, `puritySnapshot`, `hallmarkingPaise` and `titleSnapshot` are not merely good practice — Reg. 5(11) is why the invoice must be reconstructable years later, exactly as §7.6 argues. **Note `hallmarkingPaise` defaults to 0 and must be populated**: BIS publishes hallmarking charges of **₹45/article for gold and ₹35/article for silver**, and the charge must appear separately on the invoice.

⚠️ **Penalty:** BIS Act 2016 s.29 — imprisonment up to one year, or fine not less than ₹1 lakh extending to five times the value of the goods, or both. ✅ PIB records over 30 enforcement actions against jewellers in 2025-26.

**[UNVERIFIED negative]** — I found **no legal requirement to publish the daily gold rate** anywhere in BIS, the QCO, the Regulations, the Guidelines or Legal Metrology. Publishing it is a trust convention (§1.5), not a duty. A Department of Consumer Affairs advisory would settle it.

### 4.2 GST on jewellery

✅ **The September 2025 "GST 2.0" reform did *not* change jewellery rates.** I verified this against the primary instrument — **Notification No. 9/2025-Central Tax (Rate), 17 Sep 2025, effective 22 Sep 2025**, which superseded Notification 1/2017 ([ICAI mirror](https://d23z1tp9il9etb.cloudfront.net/download/gstlaw/NOTIFICATION%20NO.%209_2025-CENTRAL%20TAX%20(RATE)1759486688.pdf), [TaxReply](https://taxreply.com/gstnotifications-html/Notification-No-09-2025-2126.html)). Do not assume the two-slab reform touched Chapter 71 — it did not.

| Goods | HSN | GST |
|---|---|---|
| **Articles of jewellery of precious metal** (gold, silver, diamond-studded, sold as a finished article) | **7113** | **3%** (Schedule IV @ 1.5% CGST) |
| Gold, unwrought/semi-manufactured | 7108 | 3% |
| Silver | 7106 | 3% |
| Articles of pearls / precious or semi-precious stones | 7116 | 3% |
| Coin | 7118 | 3% |
| Imitation jewellery | 7117 | 3% |
| Rough/sawn diamonds; loose coloured stones | 7102 / 7103 / 7104 | **0.25%** (Schedule V) |
| **Cut and polished diamonds (loose)** | 7102-other | **1.5%** (Schedule VI) |

> **§7.6's `hsnCode` column should default to `7113` for finished jewellery** and only diverge for loose stones or coins. Note that a diamond-studded gold necklace is **7113 at 3%** — the stones are absorbed into the article; the 0.25%/1.5% rates apply to *loose* stones, which this shop is unlikely to sell online.

✅ **Making charges are taxed at 3%, not 5% — from CBIC's own FAQ.** The [DGTS Sectoral FAQ, Gems & Jewellery, Q7](https://gstcouncil.gov.in/sites/default/files/2024-02/sectoral-fq-gems-jewellery.pdf) poses exactly this question and answers verbatim: *"**GST is payable at the rate of 3% of the total transaction value of jewellery, whether the making charge is shown separately or not.**"* It is a composite supply with gold as the principal supply. You may — and under BIS Reg. 5(11) largely must — *show* the breakup; showing it does not split the rate.

> **This is a direct correction to a natural reading of §7.4 and §7.6.** Those tables carry a single `gstRateBps` at order and line level, which is **correct** — but only because of the composite-supply position. Do **not** build per-component GST (3% on metal, 5% on making). One rate, applied to the whole taxable value, with the breakup shown for disclosure. ✅ The 5% rate is **job work** (Notification 15/2025-CT(R), Heading 9988: 5% for Chapter 71 other than diamonds, 1.5% for diamonds) — that is a customer bringing their own gold, or your karigar invoicing you. Different transaction; out of scope for a storefront but relevant if repairs are ever sold online.

**Registration, invoicing and place of supply:**

| Item | Position |
|---|---|
| GST registration | ⚠️ ₹40 lakh goods threshold — **but mandatory regardless of turnover for inter-State taxable supplies of goods**, which a pan-India storefront makes from day one ([ClearTax](https://cleartax.in/s/gst-registration-limits-increased)) |
| E-invoicing (IRN) | ⚠️ ₹5 crore AATO; **B2C supplies are exempt entirely**. A small jeweller has no obligation. **[UNVERIFIED]** notification number (widely cited as 10/2023-CT); cbic-gst.gov.in 404'd |
| Dynamic QR on B2C invoices | ✅ Notification 14/2020-CT — applies only above **₹500 crore** turnover. Not applicable |
| HSN digits | ⚠️ AATO ≤ ₹5 cr → 4 digits on **B2B**; not required on B2C invoices |
| **Invoice to unregistered buyer** | ⚠️ **CGST Rule 46(e)/(f): where taxable value is ₹50,000 or more, the invoice must carry the recipient's name and address, the address of delivery, and the name of the State and its State code** ([CBIC](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)) |
| **Place of supply** | **IGST Act s.10(1)(a)**: where supply involves movement of goods, place of supply is where movement terminates for delivery. **The ship-to state governs.** Bill-to ≠ ship-to falls under s.10(1)(b) |

> **Two build consequences.** (1) §7.6's `placeOfSupplyStateCode` must be derived from the **delivery** pincode's state, never the billing address, and it must drive the CGST+SGST ↔ IGST switch — the columns are already there, the derivation rule is the thing to get right. (2) Rule 46 means **almost every jewellery order needs a full name, delivery address and State code on the invoice**, since typical tickets clear ₹50,000 comfortably (§1.3). Guest checkout can stay guest, but it cannot be anonymous.

### 4.3 Mandatory site disclosures — Consumer Protection (E-Commerce) Rules, 2020

✅ Primary text: **G.S.R. 462(E), 23 July 2020** ([consumeraffairs.gov.in](https://consumeraffairs.gov.in/public/upload/files/E%20commerce%20rules_1732703966.pdf)).

✅ A jeweller selling its own stock on its own site is an **"inventory e-commerce entity"** (Rule 3(1)(f)) and is governed by **Rule 4 + Rule 7**. Rule 6 (duties of *marketplace sellers*) does not apply — which also means **the marketplace safe harbours are unavailable; correctness is entirely yours.**

✅ **Rule 4(2) — display prominently:** (a) legal name; (b) **principal geographic address of headquarters and all branches**; (c) name and details of the website; (d) *"contact details like e-mail address, fax, landline and mobile numbers of **customer care** as well as of **grievance officer**."*

✅ **Rule 4(4)** — appoint a grievance officer and display *"the **name, contact details, and designation** of such officer."*

✅ **Rule 4(5) — the timelines, verbatim:** the grievance officer *"**acknowledges the receipt of any consumer complaint within forty-eight hours and redresses the complaint within one month** from the date of receipt."*

✅ **Rule 7(1) — display prominently:**
- (a) *"accurate information related to **return, refund, exchange, warranty and guarantee, delivery and shipment, cost of return shipping, mode of payments, grievance redressal mechanism**"*
- (b) all mandatory notices and information required by applicable laws
- (c) *"information on available payment methods, the **security** of those payment methods, the procedure to **cancel regular payments**, any **fees or charges** payable by users, **charge back options**, if any, and the **contact information of the relevant payment service provider**"*
- (e) *"**total price in single figure** of any good or service along with the **breakup price**… showing all the **compulsory and voluntary charges**, such as delivery charges, postage and handling charges, conveyance charges and the applicable tax"*
- (f) *"a **ticket number for each complaint** lodged, through which the consumer can track the status of their complaint"*

> **Rule 7(1)(e) is the legal basis for the price breakup.** §2 discusses what the industry does; this is what the law requires. A single total with no breakup is non-compliant. The `price_quotes` and `orders` column sets in §7.4/§7.6 already decompose exactly along these lines — items subtotal, making, stone, hallmarking, shipping, GST — so the schema satisfies this; it is the **rendering** that must not collapse them.
>
> **Rule 7(1)(f) is a schema gap.** Nothing in §7 issues a **complaint ticket number**. That needs a small `support_tickets` table (or at minimum a ticket id on an enquiry record) before launch.

✅ Three more Rule 4 duties that shape the build:
- **4(8):** no cancellation charges on a consumer *"unless similar charges are also borne by the e-commerce entity"* if it cancels unilaterally.
- **4(9):** consent must be *"expressed through an **explicit and affirmative action**"* and may not be recorded automatically *"including in the form of pre-ticked checkboxes."* — this constrains the `customers.marketingOptIn` UI in §7.5.
- **4(10):** refunds *"within a reasonable period of time"* — ⚠️ **there is no statutory 14-day refund deadline in Indian e-commerce law.**

✅ **Rule 4(1) was substituted by G.S.R. 328(E), 17 May 2021** ([e-gazette](https://egazette.gov.in/WriteReadData/2021/227003.pdf)), removing the original requirement that an e-commerce entity *"be a company incorporated under the Companies Act."* **A proprietorship or partnership jeweller is not required to incorporate.** ✅ The June 2021 draft amendments (flash-sale ban, fall-back liability) remain at **"Draft"** ([PRS](https://prsindia.org/billtrack/draft-amendments-to-the-consumer-protection-e-commerce-rules-2020)).

✅ **Penalties are indirect.** Rule 8 routes contraventions to the Consumer Protection Act 2019. A display breach becomes an unfair trade practice → a CCPA order under s.20/21 → and it is **disobeying that order** that triggers s.88 (up to 6 months' imprisonment or ₹20 lakh). Plus ordinary consumer-commission complaints.

⚠️ **Country of origin is a genuine gap.** "Country of origin" appears in Rule **6(5)(d)**, which binds *marketplace sellers*. Rule 7(1) has no such clause. For a first-party seller the duty arrives via Rule 7(1)(b) → Legal Metrology (§4.4). **Display it anyway** — §7.2 already has `variants.countryOfOrigin` defaulting to `"India"`.

### 4.4 Legal Metrology — the largest unresolved legal question in this build

✅ **Rule 6(10) of the Legal Metrology (Packaged Commodities) Rules, 2011** requires an e-commerce entity to display the Rule 6(1) mandatory declarations (except month/year of packing) on the digital network, with an Explanation confirming this *"shall not provide exemption from the declarations required to be made… on pre-packaged commodities delivered to the consumers."* The marketplace safe-harbour proviso is unavailable to a first-party seller. ✅ Rule 6(1) declarations include name and address of the manufacturer/packer, country of origin for imported goods, common name, **net quantity**, and **retail sale price (MRP), inclusive of all taxes** (rule 2(m)).

✅ **Rule 26 exemptions do not list jewellery.** They cover net weight ≤10 g/10 ml, restaurant fast food, DPCO formulations, handloom thread, and loose garments/hosiery. None helps.

> ⚠️ **The open question, stated plainly.** ✅ Legal Metrology Act 2009 s.2(l) defines a pre-packaged commodity as one packed *"**without the purchaser being present**"* with a *"pre-determined quantity."*
> - **Counter sale, weighed in front of the customer** → purchaser present, quantity not pre-determined → outside LMPC. This is why physical jewellers print no MRP labels.
> - **Online order, boxed and shipped at a listed weight and price** → satisfies s.2(l) on its face → Rule 6 declarations **and** Rule 6(10) PDP display appear to apply.
>
> **No DoCA clarification, circular or judicial authority either way was found.** The only sources asserting jewellery is covered are law-firm blogs (e.g. [GNS Legal](https://www.gnslegal.in/legal-metrology-compliance-why-net-quantity-matters-in-diamond-gold-and-silver-jewellery/)). There is also an unresolved practical tension: **a fixed printed MRP on an article whose price moves with the daily bullion rate (§2) is close to unworkable.**
>
> **Do not treat "jewellery is exempt" as safe, and do not treat "MRP required" as settled. Budget for Indian legal-metrology counsel before launch.** This is the single item most likely to require a product change late.

⚠️ Also relevant if imported stones are ever listed: the **Legal Metrology (Packaged Commodities) Amendment Rules, 2026 (G.S.R. 128(E), 13 Feb 2026, in force 1 July 2026)** insert rule 6(10A) requiring imported-product listings *"in a searchable and sortable filter specifying the country of origin"* ([SCC Online](https://www.scconline.com/blog/post/2026/02/21/legal-metrology-packaged-commodities-amendment-rules-2026-explained/), [Chambers](https://chambers.com/articles/lmpc-rules-amended-new-compliance-for-e-commerce)). **[UNVERIFIED]** GSR number is single-sourced.

✅ **Weighing scales:** Legal Metrology Act s.24(1) requires every weight or measure used in a transaction to be **verified** before use; s.25 penalises non-conforming instruments up to ₹25,000; s.36(1) penalises a pre-packaged commodity not conforming to its declarations (₹25,000 rising to ₹1,00,000 or one year). BIS separately requires a **0.01 g** balance in the outlet.

### 4.5 Returns and refunds — what the law requires vs what is custom

✅ **CONFIRMED: India has no general statutory cooling-off period or right of return for online purchases.** I read the Consumer Protection Act 2019 and G.S.R. 462(E) in full; there is no analogue to the EU's 14-day right of withdrawal. **The 7/15/30-day windows in §1.4 are contractual, not statutory.**

> ⚠️ Two claims circulating widely are wrong and must not be built against: an alleged statutory "30 days to return a faulty item", and a "15-day right for durable goods". Neither has a section number. **Ask anyone asserting them to produce one.**

✅ What the Rules *do* require:
- **Rule 7(1)(a):** publish the policy, expressly including **"cost of return shipping"** — you must state who pays.
- **Rule 7(4), the non-refusal duty, verbatim:** *"No inventory e-commerce entity shall **refuse to take back goods**… or refuse to refund consideration, if paid, **if such goods or services are defective, deficient, spurious, or if the goods or services are not of the characteristics or features as advertised or as agreed to, or if such goods or services are delivered late** from the stated delivery schedule"* (force majeure excepted for late delivery).
- **Rule 7(5), directly on point for purity and certification claims:** *"Any inventory e-commerce entity which explicitly or implicitly **vouches for the authenticity** of the goods… shall bear appropriate liability in any action related to the authenticity."*

✅ **CPA 2019 s.2(46) "unfair contract"** catches *"imposing any penalty on the consumer… **wholly disproportionate to the loss** occurred"* and *"any **unreasonable charge, obligation or condition**."*

> **Net position: a restrictive return policy is lawful, but it cannot override Rule 7(4), and any making-charge or restocking deduction must be defensible as recovery of actual loss, not as a penalty.** The commercially safe pattern — a stated window with named exclusions, plus an always-on defect/misdescription lane — is exactly what every major Indian jeweller runs (§1.4). **Rule 7(5) is the reason to be conservative about certification claims in product copy**: vouching for authenticity attaches liability. It is also why §7.2's `certificateNumber` / `certificateLab` / `diamondOrigin` fields should be populated from the actual certificate or left null — never inferred.

### 4.6 DPDP Act 2023 — nothing binds you today; the cliff is May 2027

✅ **Act assented 11 Aug 2023.** ✅ **Final Rules notified: G.S.R. 846(E), 13 November 2025**, MeitY ([PDF](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf)), alongside G.S.R. 843(E) (commencement), 844(E) (Board established) and 845(E).

✅ **Phased commencement, from Rule 1 verbatim:** Rules 1, 2 and 17–21 on publication; **Rule 4 at twelve months**; **Rules 3, 5–16, 22 and 23 at eighteen months**. ✅ Per G.S.R. 843(E), the Act's substantive provisions — ss.3–5, s.6, ss.7–17, ss.28–34, 36, 37 — are all in the **eighteen-month** cohort.

> **So as of July 2026: only institutional plumbing is live. There is no notice duty, no consent duty, no data-principal right, no breach-notification duty and no penalty machinery in force.** ✅ The Data Protection Board exists on paper but **has no members** — MeitY circular F. No. 2(1)/2026-Pers.I dated **6 May 2026** was still inviting applications for *"(i) Chairperson : 01 Post (ii) Member : 04 Posts"* ([PDF](https://www.meity.gov.in/static/uploads/2026/05/cd481c027470b420b4cb85fb40a91c53.pdf)).
>
> **[UNVERIFIED]** whether "date of publication" is 13 or 14 Nov 2025 (the notification is dated the 13th; the e-gazette reference carries 14112025). Law firms split — [Shardul Amarchand Mangaldas](https://www.amsshardul.com/insight/enforcement-of-the-dpdp-act-and-notification-of-the-dpdp-rules/) reads it as 14 May 2027. **Plan to the conservative date: 13 May 2027.**

⚠️ **Live *today*, and easy to miss: the IT Act s.43A and the SPDI Rules 2011 remain in force.** ✅ s.44(2) of DPDP (which omits s.43A) is itself in the eighteen-month cohort. So until ~May 2027 the operative regime is [SPDI 2011](https://www.wipo.int/edocs/lexdocs/laws/en/in/in098en.pdf): **rule 4 requires a published privacy policy** and rule 5 requires consent for sensitive personal data. ✅ Also live: [CERT-In Directions of 28 April 2022](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf), requiring certain cyber incidents to be reported **within 6 hours**.

**What to build now because it is architectural, even though it bites in 2027:**

| Obligation | Requirement | Cite |
|---|---|---|
| **Notice** | ✅ Rule 3: must *"be presented and be understandable **independently of any other information**"* — standalone, **not buried in T&Cs** — with an *"itemised description"* of the data and the purposes, plus means to withdraw consent, exercise rights and complain to the Board. ✅ s.5(3): available in English or any of the 22 Eighth Schedule languages | Act s.5, Rule 3 |
| **Consent** | ✅ s.6(1) *"free, specific, informed, unconditional and unambiguous with a clear affirmative action"*. ✅ **s.6(10): the burden of proof is on you** | Act s.6 |
| **Order fulfilment** | ✅ **s.7(a) legitimate use** covers data *"voluntarily provided"* for the specified purpose — checkout data fits squarely. **But it is purpose-locked: it does not cover marketing SMS/email, retargeting pixels, or profiling on order history.** Those need separate s.6 consent | Act s.7 |
| **Processor contracts** | ✅ **s.8(2): a Data Processor may be engaged "only under a valid contract"** → written DPAs with the gateway, courier, mailer and Cloudflare | Act s.8 |
| **Retention floor** | ✅ **Rule 8(3) applies to everyone**: retain personal data, traffic data and logs *"for a minimum period of one year"* — its own Illustration is an e-commerce order, retained *"even if X deletes her account"* | Rule 8 |
| **Erasure** | ✅ s.8(7): erase on consent withdrawal or when the purpose is no longer served, whichever is earlier, unless law requires retention | Act s.8(7) |
| **Contact person** | ✅ **Rule 9: *every* Data Fiduciary must "prominently publish on its website" and "mention in every response"** the business contact of the DPO *"if applicable"* or a person who can answer the Data Principal's questions. **A DPO is mandatory only for a Significant Data Fiduciary** | Act s.8(9), Rule 9 |
| **Rights & grievance** | ✅ ss.11–14 (access, correction, erasure, grievance, nomination); ✅ **Rule 14(3): respond within *"a reasonable period not exceeding ninety days"*** | Act ss.11–14 |
| **Breach notification** | ✅ s.8(6): intimate **the Board *and* every affected Data Principal — no materiality threshold**. ✅ Rule 7: to principals *"without delay"*; to the Board *"without delay"* for a first description **and "within seventy-two hours" for detailed information** | Act s.8(6), Rule 7 |

> **Two direct reads on §7.5.** (1) `consentVersion` / `consentAt` are correctly anticipated — s.6(10) puts the burden of proof on you, so log the notice version and timestamp, not just a boolean. (2) **`deletionRequestedAt` must trigger a *soft* delete, not a purge.** Rule 8(3) imposes a **one-year retention floor** on order and log data even after account deletion. The §7.5 comment says "a scheduled job redacts PII" — that job must respect the twelve-month floor and must not touch the §7.6 order snapshot, which is a statutory GST document (§4.2) with its own retention need. **Redact the customer row; keep the order.**

✅ **Third Schedule three-year erasure does not apply** — it binds e-commerce entities with *"not less than two crore registered users in India."* ✅ **Significant Data Fiduciary status is by Central Government notification** (s.10(1)), not self-assessment; none has been notified. ✅ **Cross-border transfer is permissive** — Rule 15 allows transfer outside India by default, subject only to future restrictions; **nothing in DPDP requires Indian hosting for a non-SDF, so Cloudflare is fine.** (The one that does bite is RBI payment-data localisation — §3.8.)

✅ **Penalties (the Schedule to s.33):** ₹250 crore for failure of reasonable security safeguards; ₹200 crore for failure to notify a breach; **₹200 crore for breach of the children obligations**; ₹50 crore for any other breach. These are ceilings, and s.33 requires proportionate determination.

⚠️ **s.9(3) is the highest-risk item for a retail build and deserves a decision now:** *"A Data Fiduciary shall not undertake **tracking or behavioural monitoring of children or targeted advertising directed at children**."* **Absolute prohibition — no consent cure, and the Fourth Schedule contains no retail exemption.** Meta/Google remarketing pixels and lookalike audiences are precisely tracking and targeted advertising, and there is no "we don't knowingly serve minors" safe harbour. If this site is ever going to run retargeting, that needs an age-assurance answer or a tracking pipeline that excludes unconfirmed-adult traffic. Not live until 2027, but it is a structural choice.

### 4.7 PMLA, PAN and cash limits

✅ **The PMLA notification for dealers in precious metals and stones is still in force.** **G.S.R. 799(E), 28 December 2020** ([India Code](https://upload.indiacode.nic.in/showfile?actid=AC_CEN_2_2_00035_200315_1517807326550&type=notification&filename=notification_dated_28.12.2020_to_notify_the_dealers_in_precious_metals_and_precious_stones.pdf)) notifies dealers in precious metals and stones under **s.2(1)(sa)(iv)** *"if they engage in any cash transactions with a customer equal to or above Rupees ten lakhs, carried out in a single operation or in several operations that appear to be linked."*

> ⚠️ **The withdrawal commonly remembered is the *2017* episode, not 2020** — Notification 4/2017 (turnover ≥ ₹2 crore) was rescinded by G.S.R. 1223(E) dated 6 Oct 2017 ([RSM](https://www.rsm.global/india/insights/tax-insights/newsflash-government-withdraws-pmla-notification-relating-gems-and-jewellery)). Confusingly, the *same gazette page* as G.S.R. 799(E) carries G.S.R. 798(E), which rescinds a 2017 notification and notifies real-estate agents — easy to misread. ⚠️ CBIC's [AML-CFT Guidelines for DPMS](https://www.gjc.org.in/pdf/AML-CFT-CPF%20Guidelines_DPMS_29.11.2023.pdf) still cite G.S.R. 799(E) as operative, and GJC lists DPMS circulars dated 04.07.2026.

⚠️ **The ₹10 lakh figure is a reporting-entity *trigger*, not a per-sale KYC rule.** CBIC's guidelines (para 3.5) state a dealer *"needs to register itself with the Director, FIU-IND at the first instance of engaging in cash transaction with a customer equal to or above Rupees ten lakhs."* **A jeweller that never touches ₹10 lakh in cash is not a reporting entity.** The guidelines flag that realistic exposure is on the **old-gold buying** side (dealer paying cash out), since s.186 already blocks receiving ₹2 lakh.

✅ **Section 269ST is now Section 186 of the Income-tax Act, 2025** (Act 30 of 2025, assent 21 Aug 2025, [gazette](https://egazette.gov.in/WriteReadData/2025/265620.pdf)), in force from 1 April 2026. The limit is unchanged, verbatim:

> *"**No person shall receive an amount of ₹ 200000 or more** — (a) **in aggregate from a person in a day**; or (b) **in respect of a single transaction**; or (c) **in respect of transactions relating to one event or occasion from a person**, except through [an account payee cheque, draft, ECS or prescribed electronic mode]."*

✅ **Penalty — s.451 (the successor to 271DA): *"a penalty equal to the sum received"* — 100% of the amount, on the receiver, i.e. on the jeweller.**

> **This is the highest-severity, easiest-to-get-wrong item in the whole document.** Three traps:
> - The comparator is *"or more"* — **₹2,00,000 exactly is caught.**
> - Limb (a) aggregates **per person per calendar day**: three ₹80,000 cash orders from one customer in one day is a violation.
> - Limb (c) aggregates across *"one event or occasion"* — a bridal purchase split over several days for one wedding aggregates. **A jewellery site is unusually exposed to this limb.**
>
> Combined with §3.7, this is a second independent reason to not build COD. If any cash-at-pickup path exists, it needs per-customer-per-day aggregation, not a per-order check.

⚠️ **PAN quoting: the citation everyone knows is stale.** The Income-tax Rules renumbered on 1 April 2026 (Income-tax Rules, 2026, notified by CBDT Notification 22/2026, G.S.R. 198(E), 20 Mar 2026). **Rule 114B → Rule 159; Form 60 → Form 97.** ✅ The statutory hook is **s.262(9)**, which puts an affirmative duty on the *seller*: *"every person **receiving any document** relating to the transactions… **shall ensure** that Permanent Account Number or Aadhaar number has been duly quoted… and that such number is authenticated."* ✅ **Penalty s.467: ₹10,000 per default.** ⚠️ The **₹2,00,000 goods-and-services threshold survives into Rule 159** ([CAclubindia](https://www.caclubindia.com/articles/new-income-tax-rules-2026-all-major-changes-explained-for-salaried-businesses-investors-55040.asp)).

> **[UNVERIFIED — flag loudly.]** The primary text of the Rule 159 table could not be obtained (incometaxindia.gov.in 403s). Specifically unverified: the exact wording of the goods-and-services entry, and whether *"irrespective of the mode of payment"* survived the renumbering. **That last clause is the one that matters** — under the old Rule 114B (as amended by [CBDT Notification 95/2015](https://abcaus.in/incometax/new-pan-rules-114b-applicable-from-01012016-cbdt-notification-95-2015.html), effective 1 Jan 2016), PAN was required on any sale over ₹2,00,000 **regardless of payment mode** — card, UPI and bank transfer included, not just cash. **Settle it with the G.S.R. 198(E) gazette PDF before building the checkout.** If it survived, a ₹2,50,000 UPI order needs PAN capture, and §7.6's `orders` table needs a PAN/Form-97 field it currently lacks.

✅ **TCS: jewellery is not covered.** CBDT Notification 36/2025 (S.O. 1825(E), 22 Apr 2025) notified **ten** luxury goods under s.206C(1F) at 1% above ₹10 lakh per single item — wrist watches, art, collectibles, yachts, sunglasses, bags, shoes, sportswear, home theatre systems, racing horses ([BDO](https://www.bdo.in/en-gb/insights/alerts-updates/direct-tax-alert-cbdt-notifies-luxury-goods-for-levy-of-tcs-under-section-206c(1f)-of-the-it-act)). **Jewellery, gems, gold and bullion do not appear.** ✅ s.206C(1H) (sale of goods above ₹50 lakh) was **omitted with effect from 1 April 2025**. ✅ The old s.206C(1D) cash-sale TCS on bullion and jewellery is dead. ⚠️ **Watch item:** s.394(1) of the 2025 Act keeps the power alive for *"any other goods, as may be notified"* — jewellery is one CBDT notification away.

⚠️ **E-way bill for Chapter 71 — [UNVERIFIED].** The industry position is that Chapter 71 is excluded via the Annexure to CGST Rule 138(14), with **Kerala** mandating intra-state e-way bills for gold. Every CBIC and e-way-bill portal URL returned 404/403 from this environment. **What matters for the build:** **Rule 138F empowers *States* to mandate e-way bills for intra-State movement of gold and precious stones — so the answer is state-dependent. Treat it as a per-state configurable flag, not a global boolean.**

### 4.8 What must appear on the site to be compliant

Consolidated. Everything here is required by one of the instruments above; nothing is aspirational.

**Identity and contact (Rule 4(2), 4(4)):**
- [ ] Legal name of the entity
- [ ] Principal geographic address of headquarters **and all branches**
- [ ] Website name and details
- [ ] Customer-care email, landline and mobile
- [ ] **Grievance officer: name, designation and contact**, plus a statement of the **48-hour acknowledgement / one-month redressal** commitment
- [ ] **A named data-protection contact person** (DPDP Rule 9 — publish now, it costs nothing)

**On every product page (Rule 7(1)(e), BIS, Legal Metrology):**
- [ ] **Total price in a single figure *and* a full breakup** — metal value, making charges, stone value, hallmarking charges, GST, delivery
- [ ] Net weight of precious metal, purity in carat and fineness
- [ ] HUID where the article is hallmarked — **and no implication of hallmarking on exempt Kundan/Polki/Jadaau pieces (§4.1)**
- [ ] Country of origin
- [ ] Delivery timeline and, for made-to-order pieces, the lead time before payment

**Policy pages — none of which exist in `app/` today (Rule 7(1)(a), 7(1)(c)):**
- [ ] **Returns, refunds and exchange**, expressly stating **who bears the cost of return shipping**, with the Rule 7(4) defect/misdescription lane visible
- [ ] **Shipping and delivery**
- [ ] **Payment methods, their security, applicable fees, chargeback options, and the payment service provider's contact details**
- [ ] **Privacy policy** — required *today* by SPDI Rule 4, not only by DPDP
- [ ] Terms of sale
- [ ] BIS display mirror: BIS logo, *"Hallmarked Jewellery Available for Sale"*, registration number, marking-components explainer, BIS contact, and the A&H-centre purity-verification line (§4.1)

**In the flow:**
- [ ] **A complaint ticket number** issued per complaint, trackable (Rule 7(1)(f)) — **not currently in the §7 schema**
- [ ] **No pre-ticked consent boxes** (Rule 4(9))
- [ ] Invoice carrying, at minimum: description of each article, net weight of precious metal, purity in carat and fineness, hallmarking charges (BIS Reg. 5(11)); HSN 7113; GST split as CGST+SGST or IGST by **delivery** state; and, for any order ≥₹50,000 to an unregistered buyer, the buyer's name, address, address of delivery and State code (CGST Rule 46)

**Two things to get counsel on before launch:** (a) whether Legal Metrology treats shipped jewellery as a pre-packaged commodity requiring an MRP (§4.4); (b) whether BIS's *"certified sales outlets"* language accommodates online sale or dispatch from unregistered premises (§4.1). Neither has a published answer, and both can force a product change.

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
