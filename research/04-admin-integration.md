# 04 — Admin panel: technical foundations (mechanics, reuse, auth)

Scope: what the admin must reuse, how auth actually works on this stack, what the
schema already gives us and what it does not, what is missing, the R2 situation,
how to test it, and what will go wrong.

Out of scope by assignment: admin UX/IA, and compliance/legal obligations. Two
other agents own those.

Method note: every claim about `vinext` below was checked against
`node_modules/vinext/dist` (v0.0.50, `package.json:3`), and the load-bearing ones
were additionally **executed** — a throwaway copy of this repo was built in
`/private/tmp/.../scratchpad/probe` with a real `proxy.ts` and admin routes, and
driven in-process. Nothing in this repo was modified. Crypto claims were executed
against the real `workerd` binary in `node_modules/workerd` (v1.20260515.1) with
`nodejs_compat`, not inferred from documentation.

Baseline at time of writing: `npm run build` exit 0; `npm test` → 231 pass / 0 fail;
HEAD = `45e2984 feat(checkout): order creation…`; branch `main`.

---

## 0. Corrections to earlier documents

Three claims that other documents in this repo assert, that are now false. They
matter because two of them change what the admin can build.

### 0.1 CORRECTION — `env.ASSETS` and `env.IMAGES` **are** bound on the local build path

`research/01-codebase.md:562-572` and `env.d.ts:9-13` both state that
`vite.config.ts`'s `localBindingConfig` declares neither `ASSETS` nor `IMAGES`, so
they are undefined at runtime and `/_vinext/image` 500s. `.claude-protocol/state.json`
carries the same claim as a hazard. The commit message on `1bc60ec` half-corrected
it ("true of the LOCAL build path, but `vinext deploy` generates its own config").

**All of that is now wrong, and it is wrong in a way nobody has noticed.**

`@cloudflare/vite-plugin`'s `config` option is not a replacement for the Wrangler
config — it is a *customizer* applied on top of the discovered one. Its own types
say so: `config?: WorkerConfigCustomizer<true>` where
`WorkerConfigCustomizer = Partial<WorkerConfig> | ((config: WorkerConfig) => …)`
(`node_modules/@cloudflare/vite-plugin/dist/index.d.mts:65,82`). The base is
`wrangler.jsonc` at the repo root, which was committed in `1bc60ec` and declares
both bindings (`wrangler.jsonc:9-16`).

Verified empirically. I re-ran `npm run build` and read the resolved config the
plugin emits, `dist/server/wrangler.json` (the file `.wrangler/deploy/config.json`
points at):

```
"configPath": "/Users/architjain/alankar-jewellers/wrangler.jsonc",
"assets": { "directory": "../client", "not_found_handling": "none", "binding": "ASSETS" },
"images": { "binding": "IMAGES" },
"d1_databases": [ { "binding": "DB", … } ],
"r2_buckets": [],
"compatibility_flags": ["nodejs_compat", "nodejs_compat"]
```

The duplicated `nodejs_compat` is the tell: it is `wrangler.jsonc:5-7` **plus**
`vite.config.ts:31`, merged. `d1_databases` comes only from `localBindingConfig`
(`vite.config.ts:32-40`); `assets`/`images` come only from `wrangler.jsonc`. Both
sources are present in one output, so the merge is proven, not assumed.

Consequences for the admin:
- `next/image` / `/_vinext/image` is **not** structurally broken any more. Whether
  it *works* additionally depends on the account having Cloudflare Images enabled
  — see §5.4. `UNVERIFIED`.
- `env.d.ts:9-13`'s note should be deleted when someone next touches that file.
- `env.d.ts` declares `MEDIA: R2Bucket` as **non-optional** (`env.d.ts:29`), which
  is now a type lie: `r2_buckets` is `[]`. Any admin code that writes
  `env.MEDIA.put(...)` will type-check and throw at runtime. See §5.

### 0.2 CORRECTION — `proxy.ts` in the production bundle is verified, not `UNVERIFIED`

`research/01-codebase.md:711` says it is unverified whether a `proxy.ts` gate
actually runs inside the bundled Worker under the in-process test harness, and
recommends "one throwaway test before writing twenty that depend on it". I wrote
that throwaway test. Results in §2.2 — it works, for pages and route handlers,
through `tests/helpers.mjs`'s exact harness.

### 0.3 CORRECTION — `crypto.timingSafeEqual` **is** available

`app/api/gold-rate/route.ts:92-95` says "Workers has no `crypto.timingSafeEqual`
for strings" and hand-rolls a byte comparison. The parenthetical "for strings" is
technically true, but `node:crypto`'s `timingSafeEqual` (which takes typed arrays)
is present under `nodejs_compat` and returns correctly — executed against workerd,
§2.4. The hand-rolled `secretsMatch()` is still fine (it is length-independent,
which `timingSafeEqual` is not — it throws on length mismatch), so this is a note,
not a defect. The admin's session-token comparison should prefer
`timingSafeEqual` over fixed-length digests.

---

## 1. What already exists that the admin must reuse

The storefront's data layer is unusually opinionated. Most of the invariants that
matter are enforced by the *database* or by *nominal types*, not by convention —
which means the admin cannot casually route around them, and should not try.

### 1.1 `app/_data/cart.ts` — the SQL port, and the cart

**The single most reusable thing in the repo is the database port, not the cart.**

| Export | `file:line` | Admin use |
|---|---|---|
| `type SqlValue`, `SqlRow`, `CartStatement`, `CartWriteResult` | `app/_data/cart.ts:117-127` | Reuse verbatim. |
| `type CartDb` — `{ all(sql, params), batch(statements) }` | `:133-136` | **This is the admin's database interface.** Four methods, injectable, already exercised against real SQLite in tests. |
| `d1CartDb(database: D1Database): CartDb` | `:139-155` | Reuse verbatim. It is the only place `meta.changes` is read off a D1 result (`:152`), and `changes` is the arbitration signal for every guarded write. Do **not** write a second adapter — `app/_data/orders.ts:2112-2116` explains why in the module the admin will edit most. |
| `getCartDb()` | `:163-170` | Throws when `env.DB` is absent. Admin should have its own `getAdminDb()` with the same shape and a different message, or just call `getOrderDb()`. |
| `CART_COOKIE`, `cartCookieHeader()`, `readCartTokenFromCookieHeader()`, `isWellFormedCartToken()` | `:176`, `:219-228`, `:231-243`, `:202-208` | **Do not reuse for the session — copy the shape.** `cartCookieHeader` is a hand-built `Set-Cookie` string with `HttpOnly; Secure; SameSite=Lax; Path=/` and a 30-day Max-Age. The admin cookie wants a *shorter* lifetime, `SameSite=Lax` (needed — see §2.6), and a signature. Write `adminSessionCookieHeader()` alongside it; the string-building idiom is the thing to copy. |
| `addToCart`, `removeFromCart`, `readCart` | `:440`, `:537`, `:602` | Storefront-only. The admin has no cart. |
| `HOLD_MINUTES = 30`, `SWEEP_EXPIRED_HOLDS`, `CLAIM_HOLD` | `:188`, `:300-303`, `:319-323` | **Storefront-shaped, and the admin needs a parallel view.** `readCart()` sweeps expired holds lazily *for one cart* (`:612`). An admin "who is holding what right now" screen needs an unscoped query over `stock_reservations` joined to `variants`/`products` — new SQL, but it must run the same `SWEEP_EXPIRED_HOLDS` first or it will show phantom holds. |
| `CART_NOTICES`, `toCartNotice`, `cartHref` | `:678-702` | The closed-notice-code + 303 pattern is the house idiom for no-JavaScript forms. The admin should have its own `ADMIN_NOTICES` object of exactly the same shape. Do not extend `CART_NOTICES`. |
| `formatHoldExpiry(iso)` | `:714-725` | Reuse. Fixed +05:30, deliberately not `toLocaleString` (`:709-713`) because Workers ICU data is not guaranteed. **Every admin timestamp renderer must follow this rule.** |

**Storefront-shaped, needs an admin twin:** `SELECT_CART_ITEMS` (`:344-358`) is
scoped `WHERE ci.cart_id = ?`. That scoping *is* the isolation guarantee
(`:94`). An admin abandoned-cart view is the deliberate inversion of it and must be
written as new SQL with an explicit "this is admin, scope is intentional" comment,
or a future reviewer will read it as the isolation bug.

### 1.2 `app/_data/orders.ts` — 2130 lines, and most of it is admin-reusable

This module is the highest-value reuse target and also the biggest trap: it is
built around *customer-scoped* reads.

**Reuse directly:**

| Export | `file:line` | Note |
|---|---|---|
| `getOrderDb()` | `:2122-2129` | The admin's DB handle. Throws rather than falling back — correct for admin writes too. |
| `assertOrderIntact(db, orderId, lineItemCount)` | `:1719-1727` | **Mandatory, not optional.** `db/schema.ts:1136-1141` (compensation 5) requires any reader that invoices, refunds or fulfils an order to assert this first. The admin order-detail page and every state transition owe this call. It is exported specifically so the admin can make it. |
| `PAYMENT_CAPTURE_ENABLED` | `:196` | A compile-time constant, deliberately not a binding (`:186-195`). The admin must read it, never shadow it, and never write `captured`/`paid`/`advance_paid` while it is false (`:26-30`). |
| `paymentStanding(captureEnabled, ctx)` | `:1957-1980` | **The only place payment copy is written.** Admin screens that say anything about money owed must call this, not compose their own sentence. |
| `GST_STATES`, `isGstStateCode`, `gstStateName` | `:264-317` | The state control for any admin address form. 25 and 28 are deliberately absent (`:259-263`). |
| `shopStateCode()` | `:333-341` | Returns `null` today because `SITE_DETAILS_PENDING` is `true` (`app/site-config.ts:13`) and `SHOP_GST_STATE_CODE` is unset. **This blocks order creation entirely right now** (`app/api/orders/route.ts:197` returns 503). An admin "shop settings" screen is the natural home for setting it — but note it is read as a *binding*, not from the database, so an admin form cannot set it without a schema addition. See §4.7. |
| `normalisePhone(raw)` | `:415-425` | E.164 normalisation. The admin customer search must use it or "9876543210" will not find "+919876543210". |
| `newOrderNumber()`, `ticketNumberFor()`, `isOrderNumber()`, `ORDER_NUMBER_PATTERN`, `TICKET_NUMBER_PATTERN` | `:377-402`, `:358-360` | Reuse for validation of any admin-typed order number. |
| `formatWeightMg(mg)` | `:2103-2107` | Integer-only grams. Reuse everywhere weight is shown. |
| `paymentLegs(totalPaise, plan)`, `BOOKING_ADVANCE_BPS` | `:1157-1169`, `:220` | Needed if the admin ever records an in-store balance payment. |
| `PriceableOrderCheckout`, `resolveCheckout`, `placeOrder` | `:605`, `:744`, `:1362` | The admin should **not** call these to create an order on a customer's behalf: `resolveCheckout` is keyed on a *cart cookie token* (`:746`). If "phone order entry" is ever wanted, it needs a parallel producer of `PriceableOrderCheckout` — and the class is nominal (`:607`) precisely so that producer has to construct one and pass the constructor's checks (`:620-665`), plus the runtime `instanceof` guard at `:1373`. That is the correct seam; do not weaken it. |
| `TICKET_ACKNOWLEDGE_HOURS = 48`, `TICKET_REDRESS_DAYS = 30` | `:233`, `:236` | The overdue-ticket queue's arithmetic. Reuse the constants. |
| `CONSENT_VERSION` | `:243` | Bump when consent copy changes. |

**STOREFRONT-SHAPED — the admin needs a parallel query.** This is the single
biggest piece of new SQL the admin milestone requires:

- `SELECT_ORDER_RECEIPT` (`:1743-1775`) joins `price_quotes` and filters
  `WHERE o.order_number = ? AND q.cart_id = ?`. The `cart_id` predicate **is** the
  authorisation (`:1734-1742`: "an order number is not a credential"). `readOrderForCart()`
  (`:1844-1933`) additionally refuses when `cartToken === null` (`:1848`). There is
  therefore **no way to read an order as an admin today**, by design.
  The admin needs `readOrderForAdmin(db, { orderNumber | orderId })` and
  `listOrders(db, { status, from, to, limit, offset })`. Both must:
  1. run `assertOrderIntact()` before showing money (`:1866-1873` is the precedent);
  2. return `customerPan` **only** on an explicit, audited reveal — `orders.customerPan`
     is called out as sensitive PII that must never be logged (`db/schema.ts:874-875`);
  3. read money from `orders`/`order_items` snapshots only, never by joining back to
     `variants`/`products` (`db/schema.ts:1024-1047`).
- `SELECT_CHECKOUT_LINES` (`:471-507`) filters `p.status = 'active'`. An admin
  order view must not; it reads `order_items` snapshots instead.
- `SELECT_ORDER_FOR_CART` (`:1266-1272`) is the duplicate-placement lookup, cart-scoped.

**Do not duplicate:** the placement batch (`:1405-1619`). If the admin ever needs
to write an order it must go through `placeOrder()`. The nine-statement ordering,
the `webhook_events` idempotency key `manual:cart:<cartId>` (`:1412`), the
unguarded decrement (`:1226-1233` and the reasoning at `:135-151`), and the
`support_tickets` insert inside the same batch (`:102-105`) are all load-bearing.

### 1.3 `app/_data/catalogue.ts` — read-only, and half of it is a manifest

| Export | `file:line` | Admin use |
|---|---|---|
| `readCatalogue()`, `listCatalogue()`, `listPricedCatalogue()`, `getCataloguePiece()`, `getPricedCataloguePiece()` | `:559`, `:799`, `:805`, `:815`, `:821` | **All storefront-shaped.** `readCommerceRows()` (`:423-522`) filters `WHERE products.status = 'active'` (`:456`) and **silently skips any product with no `PRESENTATION` entry** (`:476-484`) or an unknown pricing mode (`:485-488`). An admin catalogue list that used these would be unable to see drafts, archived pieces, or anything it had just created. |
| `CATALOGUE_SEED_ROWS`, `CATALOGUE_SEED` | `:275`, `:359` | The compiled fallback. `readCatalogue()` returns it whenever D1 is unreachable **or empty** (`:559-569`). **The admin must never read through a layer that can fall back to a seed** — the same argument `app/_data/orders.ts:462-470` makes for checkout. An admin that edits a seeded row edits nothing. |
| `PRESENTATION` (module-private, `:102-137`) | `:89-137` | Imagery, alt text and `spec` live here, keyed by slug, **not** in the database. `app/_data/types.ts:5-17` explains why: `product_media.r2Key` is `notNull` and R2 is off. This is the seam the admin has to break. See §5. |
| `CATALOGUE_COLLECTIONS`, `collectionTitle()` | `:158`, `:200` | Hard-coded array of 8 collections that duplicates what `collections` (the table) is for. `readCollectionMembership()` (`:527-556`) *does* read the table. So collection **membership** is live but the collection **list** is compiled. An admin that creates a collection row would produce a collection the storefront filter UI never offers (`catalogueFacets()` at `:949-967` filters `CATALOGUE_COLLECTIONS` by presence). Fix or accept, but decide. |
| `toFineness()` | `:380-383` | Reuse for admin form validation — it narrows to the `Fineness` union rather than casting. |
| `priceCataloguePieces()`, `matchesStructuralFilter()`, `matchesPriceFilter()` | `:653`, `:579`, `:601` | Reusable as-is for an admin price preview. `priceCataloguePieces` batches rate lookups per `(metal, fineness)` (`:660-676`) — keep that when previewing a repriced catalogue. |
| `formatPricePaise()`, `priceUnavailableCopy()` | `:979-982`, `:985-1007` | Reuse. `priceUnavailableCopy` is the "never a zero" copy. |
| `parseCatalogueFilter()`, `catalogueHref()`, `PRICE_BANDS`, `FILTER_PARAMS` | `:880`, `:912`, `:839`, `:854` | Query-string plumbing for a no-JS filter form. The admin list filters should copy this idiom exactly. |
| `CATALOGUE_IS_PLACEHOLDER = true` | `:371` | The admin needs to be able to flip this. It is a source constant, so today that is a code change. Candidate for the settings table in §4.7. |

**What the admin needs instead:** `readAdminCatalogue()` that selects **all**
statuses, does **not** require a `PRESENTATION` entry, does **not** fall back to the
seed, and returns `product.status` / `saleMode` / `createdAt` / `updatedAt` plus a
per-row `hasImagery: boolean` so the admin list can show "this piece will not
appear on the storefront and here is why". That last part is the useful bit: the
current skip is a `console.warn` (`:480-483`) nobody reads.

### 1.4 `app/_data/types.ts`

`CataloguePiece` (`:30-71`), `CatalogueFilter` (`:74-81`), `PricedPiece` (`:91-99`),
`Fineness` (`:22`), `PricingMode` (`:24`).

Reuse `Fineness` and `PricingMode` for form validation. **`CataloguePiece` is not
the admin's editing type** — it carries `mediaKey`/`alt`/`altBack` from the
manifest (`:66-68`) and omits `status`, `saleMode`, `craft`, `sku`, `size`,
`colour`, `diamondOrigin`, `countryOfOrigin`, `hsnCode`, `isMadeToOrder`,
`leadTimeDays`, `position`, `seoTitle`, `seoDescription` — all of which the admin
must edit. Define `AdminProductDraft` / `AdminVariantDraft` separately; do not
widen `CataloguePiece` or the storefront starts carrying admin-only fields.

The header comment at `:5-17` is the canonical statement of the imagery problem
and is where the seam change in §5 should be documented.

### 1.5 `app/_pricing/price.ts` — reuse wholesale, it is pure

Pure, no I/O, no ambient clock. Everything the admin needs for a "what would this
piece cost?" preview.

- `priceLine(input): PricedLine` (`:897`) — throws `PriceEngineError` (`:259`) with
  code `not_priceable` for `on_request`. Returns the full breakup; there is
  deliberately no total-only variant (`:892-896`).
- `priceQuote(input): PricedQuote` (`:989`) — maps field-for-field onto
  `price_quotes` and satisfies the footing CHECKs by construction.
- `splitGst(gstPaise, { interState })` (`:1106`) — CGST/SGST/IGST.
- `purityLabel(fineness, metal)` (`:613-627`) — the "995 fineness" vs "22K (916)"
  renderer. **Any admin field that shows purity must go through this**; 995 must
  never round to 24K.
- `isPriceableMetal()` (`:587`) — narrows a `string` from the database. Use it
  instead of casting when validating an admin form.
- `GST_RATE_BPS = 300` (`:194`), `BIS_HALLMARKING_GOLD_PAISE = 4500` (`:197`),
  `BIS_HALLMARKING_SILVER_PAISE = 3500` (`:200`) — the admin variant form's
  defaults come from here, not from a hard-coded 45.

**Admin-specific need:** a *validation* wrapper. The variant form can produce
input combinations that `variants_pricing_inputs_ck` (`db/schema.ts:376-381`) will
reject at write time with an opaque SQLite constraint error. The admin should
call `priceLine()` (or a thin `validateVariantPricingInputs()`) *before* the
insert and render a field-level message. Reuse the engine; do not re-implement
the rule.

### 1.6 `app/_pricing/rates.ts` — the admin's rate screen is 80% built already

| Export | `file:line` | Admin use |
|---|---|---|
| `readCurrentRate(metal, fineness, nowMs)` | `:785-824` | Returns `RateLookup`, a discriminated union whose failure arm has **no** `rate` property (`:354-374`). The failure arm carries `unusableRate` — deliberately not named `rate` — **specifically so the admin screen can display it** (`:363-366`). That is the admin affordance, already designed in. |
| `ingestRateQuotes(quotes, meta)` | `:892-1001` | Insert-only, one batch, idempotent on `sourceRef` (`:848-891`). The admin "enter today's rate by hand" action calls this with `source: "manual"`, `sourceRef: "manual:<iso>"`, `createdBy: <admin email>`. `goldRates.createdBy` (`db/schema.ts:493`) exists for exactly this. |
| `readIbjaRates(nowMs, fetchImpl)` | `:718-748` | The scrape. An admin "fetch from IBJA now" button. |
| `parseIbjaRatesHtml(html, column)` | `:535-645` | Pure. Carries six numbered `UNVERIFIED` items (`:495-533`) about IBJA's markup. An admin **dry-run** view over this is the cheapest way to keep those verified — `POST /api/gold-rate {mode:"ibja", dryRun:true}` already exists (`app/api/gold-rate/route.ts:428-430`). |
| `classifyRate(row, nowMs)`, `rateExpiryMs()`, `RATE_STALE_GRACE_MINUTES` | `:401-436`, `:291-297`, `:143` | The staleness rule. The admin dashboard's "rate expires at …" is `rateExpiryMs()`. |
| `formatPaiseAsRupees()`, `rupeesToPaise()` | `:213-219`, `:167-186` | Integer-only. Reuse for every money field in the admin. |
| `mostRecentPublicationAtOrBefore()`, `nextPublicationAfter()`, `publicationSlotRef()`, `slotColumn()` | `:253`, `:276`, `:696`, `:270` | Publication-slot arithmetic for the dashboard. |
| `unwrapRate()` / `RateUnavailableError` | `:392-395`, `:377-385` | For admin code that genuinely cannot proceed. |

**Note the closing UPDATE.** `ingestRateQuotes` writes `effective_to` on the
outgoing row and nothing else (`:948-960`); `gold_rates_current_idx`
(`db/schema.ts:503-505`) is a partial unique index that makes a second open row
impossible. **The admin must never UPDATE a rate value.** A typo correction is a
new row — which is why manual entries are stamped with the entry instant, not the
IBJA slot (`app/api/gold-rate/route.ts:351-354`).

### 1.7 `app/api/**` — four routes, and the two idioms worth copying

| Route | `file:line` | What the admin takes from it |
|---|---|---|
| `app/api/gold-rate/route.ts` | `GET :178`, `POST :309` | **The auth precedent.** `refuseUnauthorised()` (`:115-143`) fails closed when the secret is unset (`:118-129`) — an unset secret must never mean "anyone may write". `secretsMatch()` (`:96-105`) is length-independent constant-time. `presentedToken()` (`:107-112`) accepts `Authorization: Bearer` or `X-Rate-Ingest-Token`. **Admin rate operations should call this endpoint, not re-implement ingestion** — but a browser session cannot present `GOLD_RATE_INGEST_TOKEN`, so either the admin server action calls `ingestRateQuotes()` directly (preferred: the session already authenticated the human) or the route learns to accept an admin session as an alternative credential. Pick one; do not do both silently. |
| `app/api/cart/route.ts` | `POST :178`, `GET :329` | **`isCrossSite()` (`:88-108`) is the CSRF idiom.** Origin vs Host, with a no-`Origin` request allowed through because the attack needs a browser and browsers send it (`:81-87`). **Every admin POST must carry this check** — see §2.6 for why it is not sufficient on its own for admin. `respond()` (`:134-147`) is the form-vs-JSON dual shape and the 303-on-failure rule. |
| `app/api/orders/route.ts` | `POST :164`, `GET :328` | `GET` is deliberately 405 (`:320-333`) — an order number is not a credential. The admin's order read must be a *different* endpoint with a *different* authorisation, never a relaxation of this one. |
| `app/api/appointments/route.ts` | `POST :140`, `GET :277` | Appointments are the only lead table with a workflow column already (`appointments.status`, `db/schema.ts:29`) and **no way to change it**. `GET` is 405. `DUPLICATE_WINDOW = "-3 minutes"` (`:7`) and `DAILY_LIMIT_PER_PHONE = 5` (`:9`) throttle by fabricating a `201` (`app/api/cart/route.ts:20-24` describes this) — the admin must know that a "captured lead" count is not a submission count. |

**Idiom the admin must copy, not invent:** `Cache-Control: no-store` on every
response that carries anything private. `app/api/gold-rate/route.ts:68-70` sets it
on *every* response including errors, and explains why (`:32-35`). Admin pages
additionally need `X-Robots-Tag: noindex` — the root layout sets
`robots: { index: true, follow: true }` (`app/layout.tsx:21-31`) and `app/robots.ts:11`
only disallows `/api/`.

---

## 2. Auth mechanics on this stack — verified against source and executed

Decision (fixed, not mine to revisit): password + signed cookie session.
`.claude-protocol/decisions.json` → `decisions.adminAuth`.

### 2.1 `cookies()` mutability — verified in source

`vinext` implements this exactly as Next.js does, and the gate is a *phase*:

```js
// node_modules/vinext/dist/shims/headers.js:171-174
function _areCookiesMutableInCurrentPhase() {
  const phase = _getState().phase;
  return phase === "action" || phase === "route-handler";
}
```

- `cookies()` (`shims/headers.js:434-445`) returns `_getMutableCookies(...)` when
  that predicate holds and `_getReadonlyCookies(...)` otherwise (`:444`).
- The read-only proxy throws `ReadonlyRequestCookiesError` on `set`/`delete`
  (`:285-291`, `:376-381`), message: *"Cookies can only be modified in a Server
  Action or Route Handler."*
- `.set()` pushes a serialised `Set-Cookie` onto `pendingSetCookies` (`:556`);
  `.delete()` pushes an expired one (`:573`).
- Route handlers: `executeAppRouteHandler` sets the phase at
  `server/app-route-handler-execution.js:39`, drains at `:85` (and at `:94` on the
  error path, so a cookie set before a throw still ships), restores at `:121`.
- Server actions: `server/app-server-action-execution.js:162` and `:256` set phase
  `"action"`; drained at `:178`, `:291`, `:311`.
- The drained cookies are attached by `applyMutableCookieFallbacks()`
  (`server/app-route-handler-response.js:55-76`) — note `:73-76`, it *rebuilds*
  the `Set-Cookie` list, and cookies the handler set on the `Response` itself win
  over `cookies().set()` for the same name.
- Reading `cookies()` calls `markDynamicUsage()` (`shims/headers.js:438`), so any
  page that reads it is dynamic and gets `Cache-Control: no-store`. Good for admin.

**Server components can read but not write.** A login *page* cannot set the
session; the login *form action* or *route handler* must.

### 2.2 `proxy.ts` gating a route subtree — EXECUTED, works

Discovery: `findMiddlewareFile()` (`server/middleware.js:41-54`) checks
`proxy.{ts,tsx,js,…}` at root and `src/`, then falls back to `middleware.*` with a
deprecation warning (`:49`). It is called during config resolution at
`dist/index.js:450`, and the resolved path is statically imported into the
generated RSC entry (`entries/app-rsc-entry.js:90`, wired at `:641` as
`middlewareModule`). It is therefore **in the production bundle**, not a dev-only
feature.

Executed. In a throwaway copy of this repo (untouched original), I added:

```ts
// proxy.ts
import { NextResponse, type NextRequest } from "next/server";
export const config = { matcher: ["/admin/:path*", "/api/admin/:path*"] };
export function proxy(request: NextRequest) {
  if (request.cookies.get("aj_admin")?.value === "good") return NextResponse.next();
  return NextResponse.redirect(new URL("/admin/login", request.url), 303);
}
```

plus `app/admin/page.tsx`, `app/api/admin/ping/route.ts`, and
`app/api/admin/session/route.ts`. `npx vinext build` succeeded; the bundle contains
`middlewareModule: proxy`. Driving `dist/server/index.js` through **the same
harness `tests/helpers.mjs` uses** (`node --import ./tests/setup.mjs`):

```
GET /admin              (no cookie) → 303  Location: http://localhost/admin/login
GET /api/admin/ping     (no cookie) → 303  Location: http://localhost/admin/login
GET /admin              (cookie)    → 200  body contains ADMIN_HOME_OK
GET /api/admin/ping     (cookie)    → 200  {"ok":true,"where":"admin-ping"}
GET /shop               (unmatched) → 200
POST /api/admin/session (cookie)    → 200
     set-cookie: ["aj_admin=good; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=lax"]
     body: {"ok":true,"macLen":32,"pbkdf2Len":32}
```

So, all in one run: the matcher gates **both** a page subtree and an API subtree;
unmatched routes are untouched; `cookies().set()` in a route handler emits a real
`Set-Cookie`; and WebCrypto HMAC-SHA-256 + PBKDF2 work inside the bundle.

Notes from the run:
- `NextResponse.redirect` requires an **absolute** URL (`shims/server.js:142-144`
  validates and throws `RangeError` on a bad status).
- `sameSite: "lax"` serialises lower-case (`SameSite=lax`). RFC 6265bis is
  case-insensitive so it is correct, but it differs from
  `app/_data/cart.ts:226`'s `SameSite=Lax`. If any test asserts `/SameSite=Lax/`
  (as `tests/cart.test.mjs:230` does) it will fail against a `cookies().set()`
  cookie. Assert case-insensitively, or hand-build the header.
- Middleware runs **before** rewrites, metadata routes, public-file resolution and
  route dispatch (`dist/server/index.js:9364-9380` in the built pipeline).

### 2.3 What middleware CANNOT gate — static assets

`wrangler.jsonc:9-13` binds assets with `not_found_handling: "none"`. On Cloudflare
Workers with static assets, an asset request is served by the platform's asset
server **before** the Worker script runs. `proxy.ts` therefore cannot protect
anything under `public/` → `dist/client/`.

Consequence: **never place admin-only material in `public/`.** In particular, if
the R2 fallback in §5.5 is taken and uploaded photographs are committed to
`public/`, they are world-readable at a guessable URL regardless of the admin gate.

### 2.4 Password hashing with only WebCrypto — EXECUTED against workerd

I ran a probe worker under `node_modules/workerd/bin/workerd serve` with
`compatibilityFlags = ["nodejs_compat"]` — the same flag this project sets
(`wrangler.jsonc:5-7`, `vite.config.ts:31`). Results, real runtime:

**Available in `node:crypto` under `nodejs_compat`** (all `typeof === "function"`):
`scrypt`, `scryptSync`, `pbkdf2`, `pbkdf2Sync`, `timingSafeEqual`, `randomBytes`,
`createHmac`. `timingSafeEqual(Uint8Array, Uint8Array)` returned `true` correctly.
`scryptSync("pw","salt",32,{N:16384,r:8,p:1})` returned 32 bytes in **31 ms**.

**Not available anywhere:** bcrypt, argon2. Both are native addons; there is no
NAPI on Workers. Do not plan on them, and do not add a pure-JS bcrypt — see the
cost table.

**Measured cost of PBKDF2-HMAC-SHA-256 via WebCrypto `deriveBits`, in workerd:**

| Iterations | workerd (this machine) | Node WebCrypto (same machine) |
|---:|---:|---:|
| 10,000 | 3 ms | 1.4 ms |
| 50,000 | 6 ms | — |
| 100,000 | 8 ms | 11.8 ms |
| 210,000 | 18 ms | 24.7 ms |
| 600,000 | 47 ms | 70.9 ms |

**The iteration count is bounded by the Workers CPU limit, not by policy.** The
Workers Free plan allows **10 ms CPU per invocation**; paid allows 30 s. At the
measured rate, OWASP's 600,000-iteration PBKDF2-SHA256 recommendation costs ~47 ms
of pure CPU and **will be killed on a free-plan Worker**. Even 100,000 (~8 ms
here, and Cloudflare edge cores are generally slower than this laptop) is marginal.

`UNVERIFIED`: which plan `alankar-jewellers.architjain2501.workers.dev` is on.
Settled by the Cloudflare dashboard (Workers & Pages → the Worker → usage), or by
deploying a login attempt and reading `wallTime`/`cpuTime` in `wrangler tail`.

**Defensible recommendation, in order of preference:**

1. **PBKDF2-HMAC-SHA-256, 100,000 iterations, 16-byte CSPRNG salt, 256-bit output**,
   *combined with* a shop-owner password that is **generated, not chosen** —
   e.g. 6 words from a 7776-word list (~77 bits) or 16 Crockford-base32 characters
   (~80 bits, and `app/_data/orders.ts:352` already has the alphabet and the
   argument for it). At 77+ bits of entropy the KDF work factor is close to
   irrelevant: no offline attack is feasible at *any* iteration count. This turns a
   CPU-limit problem into a password-issuance problem, which is the right trade
   for a single-owner panel.
   Store `algo`, `iterations`, `salt` and `hash` as columns (§3.3) so the count can
   be raised later without a second migration.
2. `scrypt` via `node:crypto` (N=16384, r=8, p=1) — verified working, 31 ms, ~16 MB
   memory (fits the 128 MB Worker limit). Better resistance per unit time than
   PBKDF2, but 31 ms is *definitely* over a free-plan budget and it drags
   `nodejs_compat` into the auth path.
3. Do **not** ship a pure-JS bcrypt. It runs 1–2 orders of magnitude slower than
   native and will blow any CPU budget.

Comparison and MAC:
- Compare with `crypto.subtle.timingSafeEqual`-equivalent semantics: derive, then
  `nodeCrypto.timingSafeEqual(derived, stored)` (both 32 bytes, so the
  length-mismatch throw is not reachable). Or reuse
  `app/api/gold-rate/route.ts:96-105`'s `secretsMatch()`.
- Session signature: **HMAC-SHA-256 via `crypto.subtle`** — verified, 32-byte
  output, sub-millisecond. This is what runs on *every* admin request, so it must
  be the cheap primitive. PBKDF2 runs only at login.
- `crypto.randomUUID()` and `crypto.getRandomValues()` are CSPRNG-backed on Workers
  and are already used for exactly this purpose (`app/_data/cart.ts:210-216`,
  `app/_data/orders.ts:382`).

### 2.5 Session storage — there is no KV, so it is D1 or it is stateless

`.openai/hosting.json` has exactly three keys: `project_id`, `d1`, `r2`. There is
no KV field, no cron field, no queue field. `dist/server/wrangler.json` confirms
`"kv_namespaces": []`. `.claude-protocol/state.json` records "no KV binding is
available" as a hazard, and `app/_data/cart.ts:293-299` records the absence of a
Cron Trigger as the reason the hold sweep is lazy.

Two shapes, and they are not equivalent:

**(a) Stateless signed cookie.** Value = `base64url(payload) + "." + base64url(HMAC(payload))`,
payload = `{ sub: adminUserId, iat, exp }`. Verify with HMAC on every request.

- Pro: zero D1 reads per request. D1 is single-threaded and every page here already
  SSRs against it.
- Con: **no revocation.** Deactivating an admin (`admin_users.isActive`, schema
  `:1364`) does nothing until the cookie expires. Rotating the signing secret is
  the only kill switch, and it logs everyone out.
- Con: `lastSeenAt` (`:1365`) cannot be maintained without a write anyway.

**(b) D1-backed session table.** Cookie carries an opaque 128-bit token; the row
holds `tokenHash` (SHA-256 of the token — never the token itself), `adminUserId`,
`expiresAt`, `createdAt`, `lastSeenAt`, `revokedAt`.

- Pro: real revocation, real "sign out everywhere", real `lastSeenAt`, and an
  audit trail that `admin_audit_log` can point at.
- Con: one indexed D1 read per admin request. At this shop's volume (one owner,
  maybe three staff) that is nothing.

**Recommendation: (b), with the HMAC signature kept.** Sign the token as well as
storing its hash. The signature makes a forged or truncated cookie fail *before*
D1 is touched — the same discipline `isWellFormedCartToken()` applies at
`app/_data/cart.ts:202-208` ("a forged or truncated cookie must not cost a
database round trip"). Store SHA-256 of the token, not the token: a leaked
database dump then does not hand over live sessions.

The HMAC secret is a Worker secret (`ADMIN_SESSION_SECRET`), read the way
`GOLD_RATE_INGEST_TOKEN` is read at `app/api/gold-rate/route.ts:86-89` — and it must
fail closed when unset, exactly as `refuseUnauthorised()` does at `:118-129`.

### 2.6 CSRF, and why `SameSite=Lax` is not enough on its own

`SameSite=Lax` still sends the cookie on **top-level GET navigations** from a third
party. That is fine for the cart (a GET changes nothing) but the admin will have
GET-triggered actions unless it is disciplined. Rules:

1. Every state-changing admin operation is a POST (or a server action, which is a POST).
2. Every admin POST calls the `isCrossSite()` check from
   `app/api/cart/route.ts:88-108`. **But note:** that function allows a request with
   *no* `Origin` header through (`:89`, reasoned at `:81-87`). For the storefront
   that is right. For the admin it is a hole for any non-browser client that has
   somehow obtained the cookie — small, but the admin should tighten it to
   *require* `Origin` (or `Sec-Fetch-Site: same-origin`) on POST, and say so in a
   comment explaining the divergence.
3. **Server actions POST to the page's own URL.** A matcher of
   `["/admin/:path*"]` covers actions defined in admin pages. It does **not** cover
   an action defined in a component rendered by a *storefront* page. Do not define
   admin actions outside the admin subtree.
4. `proxy.ts` is the coarse gate; a `requireAdmin()` helper called at the top of
   every admin route handler and server action is the fine one. Both.
   Defence in depth here is cheap and the failure mode of a mis-typed matcher is
   total.

### 2.7 Rate limiting login

No KV, no Durable Objects, no Rate Limiting binding. The only counter available is
D1. `appointments` already demonstrates the pattern — an indexed
`(phone, created_at)` lookup with a time window (`db/schema.ts:42`,
`app/api/appointments/route.ts:7-9`). The admin equivalent is a failed-attempt
counter on `admin_users` plus a `lockedUntil` timestamp (§3.3), which is one
UPDATE per failed login and one read per attempt.

Do **not** copy the appointments throttle's *response* behaviour — it fabricates a
`201` so a bot learns nothing (`app/api/cart/route.ts:20-24`). For login, a lockout
must be **stated**, or a locked-out owner will think they have forgotten the
password.

---

## 3. The schema that exists — read, and what is missing

`db/schema.ts` has 19 tables. Two are admin tables, both empty in local D1
(`admin_users` 0 rows, `admin_audit_log` 0 rows — read read-only from
`.wrangler/state/v3/d1/…sqlite`). The migration `drizzle/0000_brainy_azazel.sql`
is the only one; `drizzle/meta/_journal.json` has a single entry.

### 3.1 `adminUsers` — `db/schema.ts:1357-1367`, DDL at `drizzle/0000_brainy_azazel.sql:13-21`

| Column | SQL | Notes |
|---|---|---|
| `id` | `text PRIMARY KEY NOT NULL` | Application-generated. `db/schema.ts:79-81`: text PKs everywhere, auto-increment leaks volume. |
| `email` | `text NOT NULL`, `UNIQUE` via `admin_users_email_unique` (`:23`) | Header comment `:1352-1356` says *"Store the email lowercased and compare lowercased — a case mismatch here is a silent lockout."* **This is a comment, not a constraint.** No `CHECK (email = lower(email))`. Add one, or normalise in exactly one function. |
| `displayName` | `text` nullable | |
| `role` | `text NOT NULL DEFAULT 'staff'`, TS enum `owner \| manager \| staff` | **Type-level only — no CHECK.** Consistent with `db/schema.ts:88-94` (enums get a CHECK only when a database guarantee depends on the value). But authorisation *is* a guarantee. If the admin ever branches on role for a destructive action, add the CHECK. |
| `isActive` | `integer NOT NULL DEFAULT true` | The deactivation switch. Only meaningful with a session table (§2.5). |
| `lastSeenAt` | `text` nullable | Needs a write path. Nothing writes it today. |
| `createdAt` | `text NOT NULL DEFAULT CURRENT_TIMESTAMP` | Note `CURRENT_TIMESTAMP` is `YYYY-MM-DD HH:MM:SS` with no zone — `parseTimestampMs()` (`app/_pricing/rates.ts:310-320`) exists because of exactly this. Reuse it; do not `Date.parse` these directly. |

**What the design implies:** it was written for a world where *identity* came from
the platform (`db/schema.ts:1352-1353`: "Identity comes from the platform's
sign-in; this table decides who is allowed to do what"). It is an **authorisation
allowlist, not a credential store.** The `adminAuth` decision changed that and the
table has not caught up. Its doc comment is now actively misleading and should be
rewritten in the same migration.

### 3.2 `adminAuditLog` — `db/schema.ts:1375-1391`, DDL at `drizzle/0000_…sql:1-12`

`id`, `actorEmail` (NOT NULL — a *string*, not an FK, deliberately, so it survives
an admin row being deleted), `action` (dotted: `"order.status_changed"`,
`"rate.updated"` — `:1380`), `entityType` NOT NULL, `entityId` nullable,
`diffJson` nullable, `createdAt`. Indexed on `created_at` (`:1388`) and
`(entity_type, entity_id)` (`:1389`).

The doc comment (`:1369-1374`) is emphatic that this is not optional: it is the
answer to "who changed the 916 rate at 4pm" and the DPDP record of who accessed
customer data.

**Adequate as-is for writes.** Missing for a real forensic trail: `ip`,
`userAgent`, `sessionId`, and a `result` (`ok`/`refused`) so *failed* attempts are
recorded too. All nullable additions — cheap.

### 3.3 What is missing for a working login

Everything. There is no password column, no session table, no lockout counter.
Concretely, the migration must add:

**To `admin_users` (all `ALTER TABLE ADD COLUMN`, all nullable → safe on SQLite):**

| Column | Type | Why |
|---|---|---|
| `password_hash` | `text` | base64url of the derived bits. Nullable so a row can exist before a password is set. |
| `password_salt` | `text` | base64url, 16 CSPRNG bytes, per user. |
| `password_algo` | `text` | `'pbkdf2-sha256'`. Named so a future migration to a different KDF can rehash on next successful login instead of locking everyone out. |
| `password_iterations` | `integer` | Stored per row, so the count can be raised without a migration and old rows still verify. |
| `password_updated_at` | `text` | |
| `must_change_password` | `integer` (bool) | For the initial issued password. |
| `failed_login_count` | `integer` default 0 | §2.7. |
| `locked_until` | `text` | §2.7. Nullable = not locked. |
| `last_login_at` | `text` | Distinct from `last_seen_at`. |

**New table `admin_sessions`:**

| Column | Type | Why |
|---|---|---|
| `id` | `text` PK | |
| `admin_user_id` | `text NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE` | The one place a cascade is right — a deleted admin's sessions must die with them. |
| `token_hash` | `text NOT NULL UNIQUE` | SHA-256 of the bearer token. Never the token. |
| `created_at`, `expires_at` | `text NOT NULL` | `expires_at` indexed for the sweep. |
| `last_seen_at` | `text` | |
| `revoked_at` | `text` | Nullable. Sign-out and "sign out everywhere". |
| `user_agent`, `ip` | `text` | For "these are your active sessions". |

Indexes: `UNIQUE(token_hash)`, `(admin_user_id, revoked_at)`, `(expires_at)`.
CHECK: `expires_at > created_at`.

**Optional but likely: `admin_password_reset` / bootstrap path.** There is no
email sender in this project (`LEAD_WEBHOOK_URL` is an outbound webhook, not
email — `.env.example:5-9`). So "forgot password" cannot be self-service. The
recovery path is a Worker secret (`ADMIN_BOOTSTRAP_TOKEN`) that permits a one-shot
password set, following `GOLD_RATE_INGEST_TOKEN`'s pattern exactly. Say so in the
plan; do not discover it after launch.

### 3.4 Migrations are forward-only — what that constrains

`db/schema.ts:88-94` states it, and `.claude-protocol/state.json` repeats it. The
pipeline is: `npm run db:generate` → `drizzle/NNNN_*.sql` → `build/sites-vite-plugin.ts:36-40`
copies `drizzle/` into `dist/.openai/drizzle/` → the control plane applies it on
deploy. There is no down-migration and no `wrangler d1 migrations` in `package.json`.

SQLite-specific hazards for the additions above:

1. `ALTER TABLE … ADD COLUMN` **cannot** add a `NOT NULL` column without a
   constant default, and **cannot** add `UNIQUE`. Every added column above is
   nullable or has a literal default, so all are safe.
2. Adding a **CHECK constraint** to an existing table is impossible in SQLite;
   drizzle-kit emulates it by *recreating the table* (create new → copy → drop →
   rename). On `admin_users` that is harmless (0 rows). On `orders` or
   `order_items` it would rewrite statutory records inside a deploy step with no
   rollback. **Do not add CHECKs to commerce tables in an admin migration.**
3. `admin_sessions` is a new table — no hazard.
4. The `email = lower(email)` CHECK on `admin_users` triggers hazard (2), but on an
   empty table. Do it **now**, in this migration, or never.

That is the real argument for getting §3.3's list right in one pass: the empty-table
window is open today and closes the moment the owner logs in.

---

## 4. What the admin needs that does not exist yet

### 4.1 Product / variant creation and editing

**Exists:** the tables (`products` `:193-222`, `variants` `:260-399`,
`productCollections` `:224-239`, `collections` `:165-180`), every constraint, and
`scripts/seed-catalogue.mjs` as a worked example of how to write them (upserts on
deterministic ids, one statement per row, membership rows deleted then re-added).

**Missing:** all of it. No write path exists. No admin-shaped read exists (§1.3).
Specifically needed:

- `readAdminCatalogue()` / `getAdminProduct(id)` — all statuses, no seed fallback,
  no `PRESENTATION` requirement.
- `createProduct` / `updateProduct` / `createVariant` / `updateVariant`, each one
  `db.batch()` so a product and its first variant are one transaction.
- Slug uniqueness: `products.slug` is `UNIQUE` (`:197`). A collision must be caught
  as a field error, not surfaced as a SQLite constraint message.
- **Pre-flight validation against the CHECKs**, because their error text is opaque:
  `variants_pricing_inputs_ck` (`:376-381`), `variants_unique_piece_stock_ck`
  (`:385-388`), `variants_fineness_range_ck` (`:390-393`),
  `variants_money_non_negative_ck` (`:394-397`), `variants_stock_non_negative_ck`
  (`:383`).
- Collection membership editing — `product_collections` has a composite PK
  (`:236`), so it is delete-then-insert.
- `updatedAt` is `DEFAULT CURRENT_TIMESTAMP` but **nothing bumps it on UPDATE**
  (no trigger). Every admin UPDATE must set it explicitly. This is a silent
  correctness trap.
- Every write emits an `admin_audit_log` row **in the same batch** — a diff written
  outside the transaction can record a change that did not commit.

### 4.2 Image upload

**Exists:** `productMedia` table (`:407-431`), `env.IMAGES` binding (verified §0.1),
`scripts/build-images.mjs` as the derivative-generation precedent, and
`app/_media/images.ts` as the generated manifest the storefront reads today.

**Missing:** R2, the upload handler, the serving path, and the seam change in
`app/_data/catalogue.ts`. This is §5, entire.

### 4.3 Order state transitions

**Exists:** three orthogonal status columns with TS enums —
`orders.status` (11 members, `:918-934`), `orders.paymentStatus` (7, `:935-947`),
`orders.fulfilmentStatus` (4, `:948-952`). `assertOrderIntact()` (`app/_data/orders.ts:1719`)
is exported for exactly this consumer.

**Missing:**

- **A legal-transitions table.** None of the three enums has a CHECK, and there is
  no state machine anywhere. Nothing stops `delivered → pending_payment`. The admin
  must define the allowed edges in code (a `Record<Status, readonly Status[]>`) and
  refuse the rest — with a stated reason, not a silent no-op.
- **The `PAYMENT_CAPTURE_ENABLED` interlock.** `app/_data/orders.ts:26-30` forbids
  any path that writes `captured`, `paid` or `advance_paid` while the flag is
  false. The admin's transition function must enforce that *as code*, or the first
  admin UI is precisely the thing that breaks the invariant the whole checkout
  module was built around. Recording an in-store payment is a `payments` row with
  `provider = 'manual'`, `method = 'in_store'` (`db/schema.ts:1147-1160`), and the
  advance/balance columns — not a status flip.
- **Money columns move too.** `advancePaidPaise` / `balanceDuePaise` are subject to
  `orders_payment_legs_foot_ck` (`:998-1001`) and `orders_no_cod_ck` (`:1008-1012`).
  Any admin write that touches them must keep both footing.
- **Orders are append-only.** `db/schema.ts:148-152`: no code path may DELETE from
  `orders` or `order_items`; there is no trigger enforcing it, it is a review rule.
  The admin must have no delete affordance at all — cancellation is a status.
- **`readOrderForAdmin` / `listOrders`.** §1.2. The single largest piece of new SQL.

### 4.4 Gold-rate operations

**Exists:** nearly everything (§1.6). `ingestRateQuotes` (`app/_pricing/rates.ts:892`),
`readIbjaRates` (`:718`), the dry-run endpoint (`app/api/gold-rate/route.ts:428-430`),
`goldRates.createdBy` for the admin email (`db/schema.ts:493`).

**Missing:**

- A UI, and an `ADMIN_SESSION → ingestRateQuotes` path that does not require the
  human to hold `GOLD_RATE_INGEST_TOKEN` (§1.7).
- A **rate history view** — `gold_rates` is the audit trail and nothing reads it
  back except `readCurrentRate` (which filters `effective_to IS NULL`).
  `sourceQuoteRaw` (`:489`) exists so a 10× ingest bug is *provable*; that is only
  true if something displays it.
- A **stale-rate alarm.** With the storefront failing closed
  (`app/_data/catalogue.ts:63-70`), a stale rate silently turns every dynamic
  price into "price on request". Nothing tells anyone. There is no cron
  (`app/_data/cart.ts:293-299`), so the alarm has to be on the admin dashboard, or
  it has to be pushed via `LEAD_WEBHOOK_URL`'s pattern.
- **Nothing currently ingests rates at all.** `gold_rates` has 0 rows locally.
  Every dynamic price in this shop is unpriceable today, which is why every seeded
  piece is `on_request` (`app/_data/catalogue.ts:41-60`).

### 4.5 Support-ticket handling

**Exists:** `supportTickets` (`db/schema.ts:1307-1346`) with `acknowledgeDueAt` /
`redressDueAt` stored rather than recomputed (`:1300-1303`) and indexed
`(status, redress_due_at)` (`:1343`) — so the overdue queue is one query. Tickets
are created automatically inside the order batch (`app/_data/orders.ts:1597-1616`)
with both clocks already running. `orders.complaintTicketNumber` is a denormalised
copy under a UNIQUE index (`db/schema.ts:980`).

**Missing:** every read and every write. No list, no detail, no acknowledge, no
resolve, no assign. `assignedTo` (`:1331`) is a free-text column with no consumer.
`resolutionNote` (`:1338`) likewise. There is no `ticket_messages` table — a thread
is a single `body` column (`:1325`), so a back-and-forth cannot be recorded at all.
That may be acceptable (the shop phones people) but it should be a decision, not a
discovery. Note the ticket the checkout creates is `kind = 'query'`
(`app/_data/orders.ts:1245`), not `'complaint'` — the queue must not treat every
order as a complaint.

### 4.6 Appointments

Not on the assigned list but it is the oldest table and the only one with a
workflow column already: `appointments.status` `new → contacted → booked/closed`
(`db/schema.ts:28-29`). Nothing reads or writes it. This is the cheapest possible
first admin screen and a good vertical slice for proving auth end to end.

### 4.7 Settings — the gap nobody has named

Four facts are compile-time constants or bindings that the owner will need to change:

| Fact | Where it lives | Problem |
|---|---|---|
| `SITE_DETAILS_PENDING` | `app/site-config.ts:13` | Source constant. |
| Shop GST state code | `shopStateCode()` reads `env.SHOP_GST_STATE_CODE` (`app/_data/orders.ts:339-340`) | A **binding**, so an admin form cannot set it. And it is `null` today, which 503s every order. |
| `CATALOGUE_IS_PLACEHOLDER` | `app/_data/catalogue.ts:371` | Source constant. |
| `PAYMENT_CAPTURE_ENABLED` | `app/_data/orders.ts:196` | Source constant, and **correctly so** (`:186-195`) — this one must stay a reviewed code change. |

The first three want a `settings` table (key/value, audited). The fourth must not
get one. Decide this explicitly, because a `settings` table that grows to include
the payment flag would quietly undo a deliberate design.

---

## 5. The R2 problem

### 5.1 Current state, precisely

- `.openai/hosting.json:4` → `"r2": null`. Disabled for the production deploy
  because the account has not opted into R2 (dashboard step, error 10042) —
  documented in `1bc60ec`'s commit message.
- `vite.config.ts:41-48` builds `r2_buckets` from that field, so it is `[]`.
  Confirmed in the freshly built `dist/server/wrangler.json`: `"r2_buckets": []`.
- `env.d.ts:29` still declares `MEDIA: R2Bucket` **non-optional**. Type-checks,
  throws at runtime. Fix this before writing upload code, or the failure will
  surface as `Cannot read properties of undefined (reading 'put')` in production.
- `product_media.r2Key` is `notNull` (`db/schema.ts:417`) and `contentType` is
  `notNull` (`:425`, reasoned at `:403-406`: an R2 object without a content type
  makes the optimizer reject the image *quietly*).
- `product_media` has 0 rows. Imagery resolves through the generated manifest
  `app/_media/images.ts` keyed by slug via `PRESENTATION`
  (`app/_data/catalogue.ts:102-137`), which is why a product with no manifest entry
  is skipped rather than rendered (`:476-484`).
- `order_items.imageR2KeySnapshot` (`db/schema.ts:1065`) is written as a literal
  `NULL` in the placement statement (`app/_data/orders.ts:1217`). Once R2 exists,
  that placeholder should be filled — an invoice reprinted in 2031 should show the
  piece.

### 5.2 What must happen for admin image upload to work, end to end

1. **Enable R2 on the Cloudflare account** — one-time dashboard opt-in. Not a code
   change and not something an agent can do.
2. Set `.openai/hosting.json` → `"r2": "MEDIA"`. `vite.config.ts:41-48` then emits
   `r2_buckets: [{ binding: "MEDIA", bucket_name: "alankar-jewellers-media" }]`
   (`vite.config.ts:22`) and `env.MEDIA` becomes real.
3. Make `env.d.ts:29` honest: `MEDIA?: R2Bucket` while the enablement is uncertain,
   with a `getMediaBucket()` that throws a stated message — the
   `getCartDb()` idiom (`app/_data/cart.ts:163-170`).
4. **Upload handler**, `app/api/admin/media/route.ts` (POST, `multipart/form-data`):
   - session check + `isCrossSite()` (tightened per §2.6);
   - allow-list content types (`image/jpeg`, `image/png`, `image/webp`, `image/avif`)
     by **sniffing magic bytes**, not by trusting the client's `Content-Type` —
     `contentType` is `notNull` and is what the optimizer keys off (`db/schema.ts:425`);
   - size cap. The Workers request body limit is 100 MB on paid / 100 MB free, but
     memory is 128 MB — stream, do not buffer. A 10 MB cap is generous for jewellery.
   - key shape: `products/<productId>/<uuid>.<ext>`. Never the client's filename.
   - `env.MEDIA.put(key, stream, { httpMetadata: { contentType } })`.
   - then one `db.batch()` inserting the `product_media` row **and** the
     `admin_audit_log` row.
   - **The R2 write and the D1 write cannot be atomic.** R2 has no transaction with
     D1. Order them R2-first, D1-second: an orphaned R2 object is garbage (sweep it
     later by diffing `env.MEDIA.list()` against `product_media`); an orphaned D1
     row is a broken image on the storefront, which is worse. `db/schema.ts:133-135`
     already states the rule: work that cannot fit in one batch must be separately
     idempotent and safe to re-run.
   - `width`/`height` (`:423-424`) are nullable but the storefront needs them to
     avoid layout shift — `app/_media/images.ts:1-7` says the manifest exists
     precisely so no `<img>` ships without intrinsic dimensions. Get them from
     `env.IMAGES.info()` at upload time, or parse the header bytes, or make them
     required admin input. **Do not leave them null.**
   - `alt` is nullable in the schema but the comment says *"Make it required in the
     admin form"* (`:421`). Honour that: a product whose imagery has no alt text is
     currently not rendered at all.
5. **Serving path.** Two options; take (a).
   - **(a) A route handler.** `app/media/[...key]/route.ts` → `env.MEDIA.get(key)`,
     stream the body with `Content-Type` from `httpMetadata`, a long
     `Cache-Control: public, max-age=31536000, immutable` (keys are content-unique),
     and `ETag` from the R2 `httpEtag`. Works today with zero framework
     involvement. This is the honest answer to "the public URL shape is a
     rendering concern" (`db/schema.ts:402-405`).
   - **(b) `/_vinext/image`.** Does not work for R2 without a code change:
     `worker/index.ts:35` resolves sources exclusively via
     `env.ASSETS.fetch(new URL(path, request.url))`, and
     `vinext/dist/server/image-optimization.d.ts:1-11` says the endpoint "only
     serves local files". Making it work means teaching `fetchAsset` to route a
     `/media/` prefix to `env.MEDIA`. Possible, ~10 lines, but it puts a
     per-request transform on the hot path.
6. **Change the catalogue seam.** `app/_data/catalogue.ts:20-27` names it: today
   `mediaKey`, `alt`, `altBack`, `spec` come from `PRESENTATION`. Once uploads
   exist, `mediaKey`/`alt` come from `product_media` and only `spec` remains
   homeless (there is still no column for it — see §5.6). Keep the manifest as a
   **fallback** for the five seeded pieces rather than deleting it, or the
   storefront goes blank the moment the seam moves and before real photographs are
   uploaded.

### 5.3 Do the resizing at upload time, not per request

`env.IMAGES` is bound (§0.1) and `worker/index.ts:36-40` already shows the call
shape: `env.IMAGES.input(stream).transform({ width }).output({ format, quality })`.

The admin should use that **at upload** to generate the same 400/800/1400 WebP
ladder `scripts/build-images.mjs` produces at build time, store each derivative in
R2 as its own key, and record them in `product_media` (one row per derivative, or a
JSON `variants` column). Reasons:

- It mirrors the pipeline that already exists and that the storefront's `srcSet`
  shape (`app/_media/images.ts:15-21`) is built around, so the rendering code
  barely changes.
- It moves the CPU cost to a rare admin action instead of every page view — which
  matters given the CPU limit discussed in §2.4.
- It removes the dependency on `/_vinext/image` entirely.

### 5.4 Does `env.IMAGES` actually transform? `UNVERIFIED`

The **binding** is present (`dist/server/wrangler.json`, and `1bc60ec` reports
"Bindings attached: env.DB, env.IMAGES, env.ASSETS" from the deploy output). That
is not the same as the Images product being enabled on the account — R2 was
attachable in config and still failed with 10042 at the account level.

Settle it with one read-only request against production, no deploy required:

```
curl -sI "https://alankar-jewellers.architjain2501.workers.dev/_vinext/image?url=/images/hero-jadau.webp&w=800" \
  -H "Accept: image/avif,image/webp,*/*"
```

- Resized WebP/AVIF, `Content-Length` well below the original → Images works.
- Original size returned → `transformImage` threw and the passthrough at
  `vinext/dist/server/image-optimization.js:190-201` caught it. Images is **not**
  working; §5.3's upload-time resize is then impossible and the admin must accept
  client-supplied sizes or resize in the browser before upload.
- 404/500 → `ASSETS` is not resolving; §0.1 is wrong and I want to know.

Do this before planning anything that depends on server-side transforms.

### 5.5 If the account never enables R2

Ranked, with the trade stated.

1. **Ship the admin without image upload; keep the build-time pipeline.** The owner
   sends photographs, someone runs `scripts/build-images.mjs`, the manifest
   regenerates, a deploy ships them. Everything else in the admin (orders, rates,
   tickets, appointments, product *text* and *pricing*) works. This is the honest
   answer and it is not a small feature — it is 5 of the 6 things in §4.
   **Recommended.** `research/01-codebase.md:499` calls an admin that can add a
   product but not its photograph "half a feature"; that framing is too harsh once
   the alternative is *no admin at all*.
2. **Store images as base64 in D1.** Do not. D1 caps a row at 2 MB
   (`db/schema.ts:1159-1160` already warns about this cap for webhook payloads), a
   database read becomes an image download, and every product page already SSRs
   against a single-threaded D1.
3. **A third-party image host** (Cloudinary, imgix, uploadcare free tier). Upload
   from the Worker, store the returned URL. But `product_media.r2Key` is `notNull`
   and named `r2Key`; putting a URL in it is exactly the lie
   `app/_data/types.ts:12-15` refuses to tell. It would need a new nullable
   `external_url` column and a CHECK that exactly one of the two is set — a
   forward-only migration for a stopgap.
4. **Commit uploads to `public/`.** Not possible from a running Worker (no
   filesystem, and assets are immutable at deploy). Only viable as a human
   workflow, which is option 1.

### 5.6 The `spec` field has no home

`CataloguePiece.spec` (`app/_data/types.ts:37-38`) — "the line the shop would say
out loud" — comes from `PRESENTATION` (`app/_data/catalogue.ts:94-95`) and has **no
column in any table**. R2 does not fix this. If the admin is to edit product copy,
`products` needs a `spec` column (nullable text). Small, but it is a migration and
it belongs in the same one as §3.3 so there is only one.

---

## 6. Testing an authenticated admin route

The harness already does everything needed. `tests/setup.mjs:8-15` redirects
`cloudflare:workers` to `tests/stubs/cloudflare-workers.mjs`, whose `env` is a
mutable object (`stubs/cloudflare-workers.mjs:9`) — so a test can inject bindings
and secrets. `tests/helpers.mjs:5-13` imports the built Worker once and
`fetchWorker()` (`:19-22`) drives it with `bindings = { ASSETS: … }` and a no-op ctx.

**Note `tests/helpers.mjs:20` passes no `DB`.** Tests that need one set `env.DB`
themselves (`tests/cart.test.mjs:610`), which works because the bundle reaches D1
through `db/index.ts`'s `env`, not through the `bindings` argument.

### 6.1 The real-SQLite pattern, reused

`tests/cart.test.mjs:72-186` is the template and it should be **extracted into
`tests/helpers.mjs` before the admin suite is written**, not copy-pasted a third
time (`tests/orders.test.mjs` already has its own copy).

- `d1Over(sqlite)` (`:133-148`) — a D1-shaped client over `node:sqlite`.
  `batch()` is `BEGIN`/`COMMIT` with `ROLLBACK` on throw and is **synchronous on
  purpose** (`:139-141`) so nothing interleaves inside a transaction.
  `meta.changes` is SQLite's own count (`:110-118`), never synthesised — which is
  what makes guarded-write assertions meaningful.
- `migratedDatabase()` (`:156-180`) — applies every `drizzle/*.sql` split on
  `--> statement-breakpoint`, with `PRAGMA foreign_keys = ON` (`:158`), then the
  project's own seed. **A new admin migration is picked up automatically** by the
  `readdirSync().filter(.sql).sort()` at `:161-164`. Nothing to wire.
- `before()` / `beforeEach()` / `after()` (`tests/cart.test.mjs:605-627`) —
  `env.DB = d1Over(worker)` once, truncate between tests, `delete env.DB` at the end.

### 6.2 Testing that an authenticated request succeeds

```
before: env.DB = d1Over(migratedDatabase());
        env.ADMIN_SESSION_SECRET = "test-secret-…";
        insert an admin_users row with a known password hash
        (derive it with the same production function — never a literal)

1. POST /api/admin/login  { email, password }
   → assert 303 (form) or 200 (json)
   → assert exactly one Set-Cookie, and assert on it:
       /HttpOnly/, /Secure/, /SameSite=lax/i  ← case-insensitive, see §2.2
       /Path=\//, a Max-Age within the intended range
   → assert the cookie VALUE is not the password, not the email, and not
     the raw session token if a hash is stored (query admin_sessions and
     assert the stored token_hash !== the cookie value)
2. GET /admin/orders with that cookie → 200, and the body contains an order
3. read Set-Cookie via response.headers.getSetCookie() — tests/cart.test.mjs:631-635
   shows the fallback for runtimes without it
```

`fetchWorker` must be called with `redirect: "manual"` (as `tests/cart.test.mjs:664`
does) or the 303 is followed and the assertion evaporates.

### 6.3 Testing that an UNauthenticated request is refused — six cases

This is the part that is easy to under-test. Each of these is a distinct failure
mode with a distinct bug behind it.

| Case | Request | Expected |
|---|---|---|
| No cookie at all | `GET /admin/orders` | 303 → `/admin/login`. **And assert the body contains none of the protected content** — a redirect with the page still rendered underneath is a real framework bug class. |
| No cookie, API | `GET /api/admin/orders` | 303 or 401. Assert the JSON body carries no order data. |
| Garbage cookie | `aj_admin=not-a-token` | Refused **without a D1 read**. Prove it by pointing `env.DB` at a throwing stub for this one test — the same discipline `app/_data/cart.ts:196-198` applies to the cart token. |
| Tampered signature | valid payload, flipped last byte of the MAC | Refused. Loop over several flipped positions. |
| Expired session | row with `expires_at` in the past | Refused, and assert the *reason* differs from "no session" in the log/notice, or a support call is unanswerable. |
| Revoked / deactivated | `revoked_at` set, or `admin_users.is_active = 0` | Refused. **This is the test that proves §2.5(b) was actually implemented** — a stateless cookie passes every other row in this table and fails only this one. |

Plus two structural ones:

- **Enumerate the routes.** A test that walks a list of admin paths and asserts each
  is refused anonymously. When someone adds `/admin/settings` and forgets the
  matcher, this fails. Without it, nothing does.
- **Assert the storefront is unaffected.** `GET /shop`, `/cart`, `/api/cart` still
  200 with no admin cookie. My probe run confirms `proxy.ts` leaves unmatched routes
  alone, but a matcher typo (`/admin*` vs `/admin/:path*`) can gate `/administrivia`
  or, worse, `/` — and 231 existing tests would catch that only by accident.

### 6.4 Two harness caveats

- **`npm test` runs `npm run build` first** (`package.json:11`). Every test drives
  `dist/server/index.js`, so `proxy.ts` is exercised as bundled — which is what my
  probe proved. There is no separate middleware harness to build.
- **Timing-dependent tests.** Every existing data-layer function takes an injectable
  `nowMs` (`app/_data/cart.ts:443`, `app/_pricing/rates.ts:788`). The session
  verifier must do the same, or the expiry test becomes a `sleep`.
- **Do not run PBKDF2 at production iteration counts in tests.** 231 tests currently
  run in 1.19 s. Twenty login tests at 100k iterations would add ~1.6 s of pure CPU.
  Make the iteration count a parameter read from `env` with a production default, and
  set it low in tests — the *algorithm* is what is under test, not the work factor.

---

## 7. Sequencing and risk

### 7.1 Build order

Strictly ordered; each step is independently shippable and testable.

**0. Settle three facts before writing code.**
   (a) Is R2 being enabled? (§5.5 branches on it.)
   (b) Does `env.IMAGES` transform? One curl, §5.4.
   (c) Free plan or paid? It sets the PBKDF2 iteration ceiling, §2.4.
   All three are questions for a human or a browser, not for code. Getting them
   wrong costs a rewrite of the media layer.

**1. One migration, containing everything in §3.3 + §5.6.**
   `admin_users` columns, `admin_sessions`, the `email = lower(email)` CHECK, the
   `products.spec` column, the audit-log additions. Forward-only, and `admin_users`
   is empty *today* — that window closes at first login (§3.4). Extract the
   `migratedDatabase()` helper into `tests/helpers.mjs` in the same change.

**2. Auth, end to end, with nothing behind it.**
   `proxy.ts` + `requireAdmin()` + login route handler + logout + a
   `/admin` page that says "signed in as X". The full §6.3 refusal suite.
   This is the throwaway-probe shape from §2.2, made real. Everything after this
   depends on it, so it is worth over-testing.

**3. Appointments admin.** §4.6. One table, one status column, no money, no
   compliance. The cheapest possible proof that the whole vertical works — session
   → gated page → D1 read → form POST → audited write → 303 → notice.

**4. Order read.** `readOrderForAdmin` + `listOrders` (§1.2). Read-only.
   `assertOrderIntact()` on every detail view. PAN behind an audited reveal.
   No writes yet — this alone is most of the operational value.

**5. Gold rates.** §4.4. Highest business value per line: the storefront cannot
   quote a price at all until a rate exists, and `gold_rates` has 0 rows. Mostly
   wiring existing functions to a form.

**6. Order state transitions.** §4.3. Needs the transition table and the
   `PAYMENT_CAPTURE_ENABLED` interlock designed before any of it is written.

**7. Product/variant CRUD, text and pricing only.** §4.1. Deliberately before
   images, so it ships even if R2 never arrives.

**8. Image upload** — only if step 0(a) says yes. §5.

**9. Support tickets.** §4.5. Last because it is the least urgent and because the
   "is a thread needed?" question should be answered with real tickets in hand.

Steps 4, 5 and 9 are independent of each other and could be parallelised after 3.
2 blocks everything. 1 blocks 2.

### 7.2 What is most likely to go wrong

Ordered by expected damage.

1. **The admin becomes the thing that breaks the payment invariant.**
   `app/_data/orders.ts:26-30` forbids writing `paid`/`captured`/`advance_paid`
   while the flag is false. An admin order screen with a status dropdown containing
   all 11 members of the enum is the single most natural way to violate it — no
   CHECK constraint stops it, and the customer-facing consequence is the site
   claiming money was received when none was. **Mitigation:** the transition table
   is code, it is tested, and `paymentStanding()` is the only copy source.

2. **The catalogue read fallback silently eats admin writes.**
   `readCatalogue()` returns `CATALOGUE_SEED` when D1 is unreachable *or empty*
   (`app/_data/catalogue.ts:559-568`). An admin that reads through it after creating
   a product sees the seed, concludes the write failed, and creates it again.
   **Mitigation:** the admin read path never falls back, and says so in a comment
   citing `app/_data/orders.ts:462-470`.

3. **The PBKDF2 iteration count exceeds the CPU limit and login 500s in production
   but passes every test.** Node's WebCrypto and workerd differ, tests run at a
   reduced count, and the free-plan 10 ms ceiling is invisible locally.
   **Mitigation:** settle the plan question in step 0; make iterations
   configurable; measure with `wrangler tail` on the first deployed login.

4. **The migration is wrong and there is no way back.** Forward-only, applied by
   the control plane on deploy, no down-migration, and adding a CHECK later means
   drizzle-kit recreating a table (§3.4). On `admin_users` that is free today and
   expensive after first login.
   **Mitigation:** one migration, reviewed against §3.3 line by line, applied to a
   throwaway SQLite copy first (the test harness does this for free).

5. **`env.MEDIA` is typed non-optional and is `undefined`.** `env.d.ts:29`.
   Upload code will compile and throw. **Mitigation:** fix the type in step 1.

6. **A matcher typo.** `/admin*` matches `/administrivia`; a missing
   `/api/admin/:path*` leaves every admin endpoint open while every admin *page*
   looks correctly gated. Nothing in the current 231 tests would notice.
   **Mitigation:** the route-enumeration test in §6.3, plus `requireAdmin()` inside
   every handler so the matcher is defence, not the defence.

7. **`updatedAt` never moves.** No trigger, `DEFAULT CURRENT_TIMESTAMP` only fires
   on INSERT. Every admin UPDATE must set it. Symptom: an "recently edited" sort
   that is really a "recently created" sort, discovered months later.

8. **Audit rows written outside the transaction.** `admin_audit_log` records a
   change that did not commit, or misses one that did. **Mitigation:** same
   `db.batch()`, always. `app/_data/orders.ts:102-105` makes exactly this argument
   about `support_tickets`.

9. **Session cookie interacts with caching.** `cookies()` marks a render dynamic
   (`shims/headers.js:438`), which is correct — but if anything ever caches an
   admin response, it caches one admin's data for another. **Mitigation:**
   `Cache-Control: no-store` on every admin response, as
   `app/api/gold-rate/route.ts:68-70` already does, plus `X-Robots-Tag: noindex`
   (the root layout says `index: true`, `app/layout.tsx:21-31`).

10. **`shopStateCode()` returns `null` and nobody notices until an order is
    attempted.** Every order 503s today (`app/api/orders/route.ts:197`). It is a
    *binding*, so no admin form can fix it (§4.7). **Mitigation:** the admin
    dashboard shows it as a red precondition alongside "no gold rate recorded" and
    "catalogue is placeholder" — three facts that between them mean the storefront
    cannot currently sell anything.

11. **Static assets bypass the gate.** §2.3. Anything under `public/` is public,
    permanently, at a guessable URL. Matters most if §5.5 option 1 is taken and
    photographs are committed.

12. **Someone builds a second D1 adapter.** `meta.changes` is the arbitration signal
    for the cart claim and the stock decrement; a second adapter that reports it
    differently breaks both, subtly, under concurrency only.
    `app/_data/orders.ts:2112-2116` already says this. Reuse `d1CartDb()`.
