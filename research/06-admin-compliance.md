# 06 — Admin panel: threat model, legal obligations, and what the code must guarantee

> **Scope.** This document covers only three things: (a) what attacks a single-password admin panel over this data realistically faces, (b) what the law obliges the *shop* to do once a human being can read and act on customer records, and (c) what those two together force the code to guarantee. It deliberately does **not** cover admin route architecture, session plumbing choice, or admin UX — two other documents own those lanes. Where a finding constrains their design, it is stated as a requirement, not as an implementation.
>
> **Verification key** (same as `research/02-market-tech.md` §4): ✅ read from the primary gazette/standard/vendor text · ⚠️ secondary source only · **[UNVERIFIED]** could not confirm, with a note on what would settle it.
>
> **Reading order.** §0 is the five findings that change the build plan. §8 is the consolidated list of places where this document **contradicts** `db/schema.ts` or `research/02-market-tech.md`. §9 is the requirement checklist. §10 is the UNVERIFIED register. Everything between is the reasoning.

---

## 0. The five findings most likely to change the admin build plan

**F1 — The chosen auth mechanism contradicts the two documents that drive this build, and the platform cannot host it properly.**
`db/schema.ts` says of `admin_users`: *"Identity comes from the platform's sign-in; this table decides who is allowed to do what."* §5.4 recommends **SIWC identity + D1 allowlist**, and §5.3 rates a password-backed signed-cookie session **🟡 "good as the *mechanism*, bad as the *identity source* — you'd have to invent a login (password → CPU-expensive KDF → 10 ms CPU problem, §0.2)"**. §0.2 marks self-hosted password auth **[BLOCKER for free tier]**. The milestone brief now specifies password + signed cookie. That is a reversal, and the platform bites back: ✅ Cloudflare Workers **rejects PBKDF2 above 100,000 iterations** with a `DOMException` ([workerd#1346](https://github.com/cloudflare/workerd/issues/1346)), bcrypt and Argon2 are unavailable in the Workers runtime, and ⚠️ OWASP's current guidance is **Argon2id**, or **PBKDF2-HMAC-SHA-256 at ≥600,000** where FIPS forces PBKDF2 ([OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)). **The KDF therefore cannot carry the security of this login and no amount of care will make it.** See §1.2 for the design that works anyway (generated high-entropy passphrase + env-secret pepper), and §10 for the plan-tier question that must be answered before a single line is written.

**F2 — CERT-In Direction (iv) is live *today*, imposes a 180-day log floor, and requires the logs to be *in India*. D1 cannot be in India.**
✅ Verbatim, [CERT-In Directions under s.70B(6), 28 Apr 2022](https://www.cert-in.org.in/PDF/CERT-In_Directions_70B_28.04.2022.pdf), direction (iv): *"All service providers, intermediaries, data centres, body corporate and Government organisations shall mandatorily enable logs of all their ICT systems and maintain them securely for a rolling period of 180 days **and the same shall be maintained within the Indian jurisdiction**."* ✅ "Body corporate" under IT Act s.43A Explanation (i) *"means any company and includes a firm, **sole proprietorship** or other association of individuals engaged in commercial or professional activities"* ([s.43A](https://indiankanoon.org/doc/76191164/)) — a proprietor jeweller is inside the definition. ✅ D1's location hints are `wnam`, `enam`, `weur`, `eeur`, `apac`, `oc` — **there is no India region** ([Cloudflare, D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/)). This directly qualifies §4.6's conclusion that *"nothing in DPDP requires Indian hosting for a non-SDF, so Cloudflare is fine"*: true of DPDP, **false of CERT-In**. See §2.5 and §8-C2.

**F3 — Every order already opens a Rule 4(5) grievance clock that no consumer started, and it has already consumed the order's only complaint-ticket slot.**
`app/_data/orders.ts:1596-1616` writes a `support_tickets` row inside the placement batch with `kind = 'query'`, `status = 'open'`, `acknowledge_due_at = now + 48 h` and `redress_due_at = now + 30 d`, and `orders.complaint_ticket_number` (a UNIQUE-indexed column) is filled with its number. ✅ Rule 4(5) of G.S.R. 462(E) binds the grievance officer to acknowledge *"any **consumer complaint**"* within 48 hours — a system-generated order acknowledgement is not a complaint lodged, so **no statutory clock was ever due to start**. What the code has built instead is a permanent, discoverable record showing an *"open"* ticket with a **breached 48-hour acknowledgement deadline on every single order**. It also means a real complaint on that order has nowhere to record its own Rule 7(1)(f) ticket number. See §5.

**F4 — Placing an order decrements stock, and nothing in the codebase can put it back. With payment off, this is the highest-frequency real-world failure the admin must fix.**
`DECREMENT_STOCK` (`app/_data/orders.ts:1230-1233`) runs unconditionally inside the placement batch, while `PAYMENT_CAPTURE_ENABLED = false` means **no money is attached to the order at all**. Every abandoned or refused unpaid order therefore takes a one-of-a-kind piece off sale permanently. There is no increment path anywhere in `app/`. Cancelling an order and restoring the piece is not a nice-to-have admin feature; it is the operational precondition for the flag-off checkout being usable. See §6.3.

**F5 — Append-only orders can probably be enforced by the database, contrary to what `db/schema.ts` assumes.**
The schema's compensation (7) says a `DELETE FROM orders` *"cannot be made to refuse this without triggers, **which the migration pipeline does not emit**, so it is a review rule."* But `build/sites-vite-plugin.ts:36-40` copies the **entire `drizzle/` directory verbatim** into `dist/.openai/drizzle`, and the platform applies whatever SQL is in it. drizzle-kit does not *generate* triggers, but nothing stops a hand-written `CREATE TRIGGER … BEFORE DELETE ON orders … RAISE(ABORT, …)` being added to a migration file. The only real obstacle is whether the platform's applier splits statements on `--> statement-breakpoint` or on bare `;` (a trigger body contains internal semicolons). **[UNVERIFIED]**, and cheaply settled — `wrangler d1 execute --local` against a scratch DB proves it without touching production. See §3.2.

---

## 1. Threat model

### 1.0 What is actually behind the door

One password reaches, in a single query each: every `customers` row (name, phone, email, consent record); every `orders` row (contact name, phone, email, full shipping address, GSTIN, **PAN**, the complete statutory price breakup, and the payment plan); every `order_items` row; every `support_tickets` row (snapshotted contact details); and every `appointments` row (name, phone, interest, free-text note). There is no per-record encryption, no field-level masking and no second factor between the internet and that set.

Two properties make the blast radius unusually bad for a shop this size. First, **`customerPan` is in the clear** — a PAN plus a name plus a phone plus an address is a complete identity-fraud kit under Indian conditions, and `db/schema.ts` itself calls it *"sensitive PII"*. Second, **order values are large and the addresses are residential** — a leak of this table is a shopping list for physical burglary of the buyers, which is a category of harm that ordinary e-commerce breaches do not carry. Every control below should be read against that, not against "someone sees an order list".

### 1.1 Credential stuffing and online brute force

**Attack.** The shop owner reuses a password that is already in a breach corpus, or an attacker runs a slow guessing campaign against the single known account. There is exactly one valid credential in the entire system, so the attacker's search space is not divided by a username guess.

**What the code must do.**

- ✅ NIST SP 800-63B-4 §3.1.1.2: *"Verifiers and CSPs **SHALL** require passwords that are used as a single-factor authentication mechanism to be a minimum of **15 characters** in length"*; *"verifiers **SHALL** compare the prospective secret against a blocklist that contains known commonly used, expected, or compromised passwords"*; *"Verifiers and CSPs **SHALL NOT** impose other composition rules"* and *"**SHALL NOT** require subscribers to change passwords periodically"* ([NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b/authenticators/)). All four are cheap and all four should be enforced at credential-set time, not at login.
- ✅ Rate limiting is a **SHALL** (§3.1.1.2 → §3.2.2); the standard's reference control is *"no more than 100"* consecutive failed attempts on an account.
- ⚠️ **Do not implement a hard permanent lockout.** With one account, a lockout is a complete, attacker-triggerable denial of the shop's own order book. Use increasing delay keyed on `(account, source IP)` with a ceiling, plus an out-of-band unlock the owner controls (redeploying a new env secret is one such unlock and needs no extra code).
- There is **no KV and no Durable Object binding** in `.openai/hosting.json` (`{"d1":"DB","r2":null}`), so the throttle state must live in D1. That is one extra indexed write per login attempt — acceptable at this volume, but it means a failed-login table is part of the schema change, not an afterthought. `app/api/appointments/route.ts:80-105` is the existing precedent for a D1-backed throttle; note that it deliberately **fails open**, which is correct for a lead form and **wrong here**. An admin login throttle must **fail closed**.
- ⚠️ A Cloudflare WAF rate-limiting rule in front of `/admin/login` would be strictly better than anything in-app. **[UNVERIFIED]** whether the OpenAI Sites control plane exposes WAF configuration for this zone (§5.3 flags the same uncertainty about Cloudflare Access). Ask before assuming.

### 1.2 Offline attack on the stored verifier

**Attack.** Anyone who can read the D1 database — a leaked control-plane credential, a `wrangler d1 execute --remote` from a compromised laptop, a future SQL-injection defect, a support engineer — obtains the password hash and cracks it offline.

**What the code must do.** This is the finding in F1, restated as a design.

- ✅ Workers caps PBKDF2 at **100,000** iterations ([workerd#1346](https://github.com/cloudflare/workerd/issues/1346)); ⚠️ Argon2id/bcrypt/scrypt are not available in the runtime ([Web Crypto on Workers](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/) exposes PBKDF2 only). So the work factor is fixed at roughly one-sixth of OWASP's PBKDF2 floor and there is no path to the recommended algorithm.
- **Therefore the entropy must do the work the KDF cannot.** The owner must not choose the password. Generate it — ≥20 characters from a CSPRNG, or a 6-word diceware phrase (~77 bits) at minimum, ≥128 bits preferred. At ≥100 bits of entropy, a 100,000-iteration PBKDF2 is irrelevant to an offline attacker; at 40 bits it is worthless. This is the single decision that determines whether F1 is survivable.
- **Pepper the input with a Worker secret.** HMAC the password with an env-held key before it enters the KDF, exactly as `GOLD_RATE_INGEST_TOKEN` is held today (`app/api/gold-rate/route.ts:86-89`). A D1-only leak then yields nothing crackable at all, because the attacker is missing a 256-bit key that never touches the database. This costs about eight lines and is the highest-value control in this section.
- Salt ≥16 bytes per NIST's *"at least 32 bits"* floor (§3.1.1.2) — take the larger.
- Compare **derived keys**, not strings, and compare them in constant time. `secretsMatch()` in `app/api/gold-rate/route.ts:96-105` is the house implementation and is correct (length-independent, byte-wise, no early return). Reuse it; do not write a second one.
- **Never log the password, the pepper, the salt or the derived key.** `console.error` output on this platform leaves the shop's control.

### 1.3 CSRF, and the `SameSite=Lax` bug class the cart already hit

The brief asks specifically whether the `app/api/cart/route.ts:72-108` `isCrossSite()` problem recurs for an admin session. **It does, in a worse form, and the existing fix is not sufficient as written.**

The cart's comment states the mechanism exactly: *"`SameSite=Lax` already stops the cart cookie riding along on a cross-site POST… What it does NOT stop is a third-party page POSTing here and having the browser **accept the fresh `Set-Cookie`** that comes back."* `SameSite` governs whether a cookie is *sent* on an outbound request; it says nothing about whether a `Set-Cookie` in the *response* is stored. For a cart this is *"a nuisance rather than a breach"*. For a login endpoint it is **session fixation by cookie planting**:

> **Attack (login CSRF / forced session).** An attacker hosts a page that POSTs the *attacker's own* admin credentials to `https://<shop>/admin/login`. The response carries `Set-Cookie: <session>=…` for the shop's origin, and the owner's browser stores it. The owner is now silently operating inside a session the attacker also holds. Anything the owner types — a customer's phone number pasted into a note, a rate correction, an uploaded document — lands in state the attacker can read. In a single-account shop the attacker has to already possess *a* valid credential for the full version of this, but the degraded version (planting an *expired or invalid* cookie to force a re-login, then phishing the re-login) needs nothing.

**What the code must do.**

1. **Origin/Host check on every state-changing admin request, `POST` only**, using the same comparison as `app/api/cart/route.ts:88-108`.
2. **But invert the permissiveness.** The cart deliberately allows a request with **no `Origin` header** through, because *"`curl`, a server-to-server call and the test harness do not [send it], and refusing those would break the JSON API for no security gain."* There is no legitimate non-browser client for the admin panel. An admin mutation with a missing or `null` `Origin` must be **refused**. Copying `isCrossSite()` verbatim into the admin lane reproduces a deliberate storefront trade-off in a place where it is a hole.
3. **`Sec-Fetch-Site: same-origin`** as a second, independent signal; treat any other value as cross-site.
4. **A synchroniser CSRF token bound to the session**, in every admin form, verified server-side. Origin checking alone depends on a header the shop does not control.
5. **No admin mutation may be reachable by `GET`.** `SameSite=Lax` *does* send the cookie on top-level navigations, so `GET /admin/orders/AJ-2607-0042/cancel` is a working CSRF payload delivered by a link in a WhatsApp message. Every mutation is a POST or a Server Action.
6. **Rotate the session identifier on successful authentication**, and never adopt one supplied by the request.

Point 6 is already solved in this codebase and the pattern should be lifted directly. `app/_data/cart.ts` (4c): *"A well-formed token that matches no open cart does NOT become a cart. `resolveCartId` never inserts the value it was given; it generates a fresh server-side id. That is what stops session fixation."* The admin session store must obey the identical rule.

### 1.4 Session theft and session lifetime

**Attack.** The session cookie is captured — an XSS payload, a shared/kiosk machine, a browser extension, a `Set-Cookie` overwritten by a sibling host.

**What the code must do.**

- `HttpOnly; Secure; Path=/; SameSite=Lax` at minimum, and **the `__Host-` cookie name prefix**. `__Host-` is refused by the browser unless the cookie is `Secure`, has `Path=/` and carries **no `Domain` attribute** — which is precisely what stops a sibling or parent host from overwriting the session cookie (cookie tossing). The storefront's `aj_cart` (`app/_data/cart.ts:176`) has no prefix; the admin cookie must not copy that.
- **Server-side sessions in D1, not a self-contained signed cookie.** A stateless signed cookie carrying `{email, role, exp}` cannot be revoked before it expires: logout becomes advisory, a stolen cookie stays valid, and deactivating `admin_users.is_active` has no effect until expiry. §5.4 already sells the allowlist on the grounds that *"revoking a departed employee is a row update and takes effect on the next request"* — a stateless cookie destroys exactly that property. Store an opaque ≥128-bit random id (`crypto.randomUUID()`, as the cart does) and look it up. The signature on the cookie is then belt-and-braces, letting a forged id be rejected without a D1 round-trip.
- **Both an idle timeout and an absolute lifetime.** The cart's 30-day cookie is right for a cart and wrong here. A reasonable pair for a shop terminal: ~8 hours idle, ~7 days absolute.
- **A visible, working sign-out** that deletes the D1 row, not just the cookie.
- **Do not bind the session to the client IP** — Indian mobile networks re-NAT constantly and the owner will be logged out mid-order. Binding loosely to the User-Agent string is acceptable; binding to IP is a support burden disguised as a control.

### 1.5 Privilege escalation via a forged or stale cookie

**Attack.** The attacker mints or edits a cookie asserting `role: "owner"`, or replays a cookie issued before a role was downgraded.

**What the code must do.** Carry **no authorisation data in the cookie at all.** Role and active-status are read from `admin_users` on every request, by the id the session row names. This makes forgery pointless (there is nothing in the cookie to forge except an opaque id that must exist in D1) and makes staleness impossible.

A note on the schema: `admin_users.role` is `owner | manager | staff`, but **with a single shared password the role column is decorative**, because every human who knows the password is whichever row that password maps to. See §1.8.

### 1.6 An admin route accidentally left unauthenticated

This is the failure that actually happens, and §5.4 names it: *"a matcher typo is a silent total bypass."*

**What the code must do.**

- ✅ vinext 0.0.50 supports `middleware.ts` with matcher patterns (§0.3, verified against the installed README). There is **no `middleware.ts` in the repo today** — this is new surface, not a modification.
- **Middleware matcher covering `/admin/:path*` AND `/api/admin/:path*`** — deny-by-default for anything new.
- **Re-check inside every route handler and every Server Action.** §5.4 says this and it is not optional: **a Server Action is invoked by POST to the URL of the page that imported it.** An action defined in an admin module but imported into a *public* page is reachable without ever passing the matcher. There is no matcher expression that closes that; only the check in the action body does.
- **The durable guarantee is a test, not a review rule.** Add a test that walks `app/admin/**` and `app/api/admin/**`, requests every route with no cookie, and asserts a 401 or a redirect. The suite already builds the app and asserts on rendered HTML (`tests/rendered-html.test.mjs`, `tests/orders.test.mjs`), so the machinery exists. A route added next year is then protected by CI rather than by memory.
- **`app/chatgpt-auth.ts` must not become a second door.** §5.2 flags **[UNVERIFIED]** that `getChatGPTUser()` trusts a plain `oai-authenticated-user-email` request header, safe only if the platform edge strips a client-supplied copy. If the admin now authenticates by password, SIWC must not *also* be accepted as admin identity anywhere — otherwise the unverified header-trust question becomes a live bypass of the password entirely. Either delete the helper's use on admin paths or run §5.2's curl test before shipping.

### 1.7 Secret handling in the admin's own outbound calls

The admin panel will drive rate ingestion. `POST /api/gold-rate` authenticates on `GOLD_RATE_INGEST_TOKEN` (`app/api/gold-rate/route.ts:107-143`).

**What the code must do.** The token must never reach the browser — not in a hidden form field, not in a data attribute, not in a client component's props. An admin rate update should call `ingestRateQuotes()` from a Server Action, or `POST /api/gold-rate` must additionally accept an authenticated admin session so no shared secret needs to travel at all. `gold_rates.createdBy` is documented as *"admin email when source = 'manual'"* — that column is the audit join and must be populated from the session, never from a form field the client can set.

Also note `refuseUnauthorised()` fails **closed** when the secret is unset: *"An unset secret must never mean 'anyone may write to the production pricing table'."* Every admin gate must adopt the same posture — a missing session secret is a 503, never an open door.

### 1.8 The insider case, which is the one that will actually occur

The brief says "a single shop owner". Shops do not work that way. The password will be given to a son, a manager, an accountant, or typed into a shared terminal at the counter — and the moment it is, `admin_audit_log.actor_email` records a **false** attribution for every action taken. That is not a cosmetic defect: it is the point at which the audit trail stops being evidence and starts being a liability, because it positively asserts something untrue about who read a customer's PAN.

**What the code must do.** Nothing can fix this at the code layer if the credential is shared, which is why it appears in §7 as a business decision. What the code *can* do is (a) support more than one `admin_users` row with independent credentials from day one, so adding a second person is a row insert rather than a redesign, and (b) print the logged-in identity persistently in the admin chrome so a shared session is at least visible to whoever is using it.

---

## 2. DPDP obligations once a human can read the data

### 2.1 What is and is not in force, restated precisely

§4.6 establishes this and it holds: ✅ the DPDP Rules were notified as **G.S.R. 846(E), 13 Nov 2025** ([MeitY](https://www.meity.gov.in/static/uploads/2025/11/53450e6e5dc0bfa85ebd78686cadad39.pdf)), and Rules 3, 5–16, 22 and 23 — which is everything that matters below — commence at **eighteen months**, i.e. ~13 May 2027. **Live today** instead: the SPDI Rules 2011 under IT Act s.43A, and the CERT-In Directions of 28 Apr 2022.

One live-today item §4.6 does not draw out: ✅ **SPDI Rule 3(i) lists "password" as sensitive personal data or information.** The admin's own credential is therefore SPDI, and SPDI Rule 8's reasonable-security-practices standard (ISO/IEC 27001 or an equivalent documented policy) applies to how it is stored — **today, not in 2027** ([SPDI Rules 2011](https://www.wipo.int/edocs/lexdocs/laws/en/in/in098en.pdf)). PAN, by contrast, is **not** in the SPDI Rule 3 list; it becomes protected only under DPDP in 2027. That asymmetry is worth knowing: the thing the law protects *today* is the admin's password, and the thing it protects *later* is the customers' PANs.

### 2.2 Rule 6 makes access control and access logging mandatory, not advisory

This is the rule that changes most when a human can log in. ✅ **Rule 6(1), DPDP Rules 2025** requires reasonable security safeguards including:

| Clause | Verbatim requirement | What it forces here |
|---|---|---|
| 6(1)(a) | *"securing of personal data through **encryption, obfuscation, masking or the use of virtual tokens**"* | At rest, D1 is encrypted by the platform. **Masking is the clause the admin UI must answer**: a PAN or a full phone rendered on a list page, in a screenshot, on a shop terminal visible from the counter, is unmasked processing. Mask by default; reveal on an explicit, logged action. |
| 6(1)(b) | *"appropriate measures to **control access to the computer resources** used by such Data Fiduciary"* | §1.6. Deny by default; the middleware matcher plus the in-handler check. |
| 6(1)(c) | *"**visibility on the accessing of such personal data, through appropriate logs, monitoring and review**, for enabling detection of unauthorised access"* | **This settles the audit-trail question in §4: read logging is required, not merely wise.** |
| 6(1)(e) | *"retain such logs and personal data for a period of **one year**, unless compliance with any law… requires otherwise"* | The audit log's own retention floor. |
| 6(1)(f) | *"appropriate provision in the **contract**… between such Data Fiduciary and such a Data Processor… for taking reasonable security safeguards"* | Written DPAs with Cloudflare/OpenAI Sites, the gateway, the courier and any mailer. Paperwork, not code, but it is a hard requirement and nobody owns it yet. |
| 6(1)(g) | *"appropriate **technical and organisational measures**"* | — |

### 2.3 Purpose limitation — the obligation an admin panel is most likely to breach

✅ DPDP s.7(a) legitimate use covers data *"voluntarily provided"* for the specified purpose. §4.6 already notes it is **purpose-locked**. Once a human has a search box over `customers` and `orders`, three specific breaches become one click away and must be closed in code:

1. **Export.** A "download CSV" button over the customer table produces a file of names, phones, addresses and PANs that leaves every technical control the shop has. If an export exists at all it must be **column-limited by default (never PAN, never full address), logged as a first-class audited action, and reason-tagged**.
2. **Marketing.** `customers.marketing_opt_in` defaults `false` and ✅ E-Commerce Rule 4(9) forbids pre-ticked consent. Any admin list that can be used to contact customers must **filter on `marketing_opt_in = 1` in the query itself**, not in the operator's head. Order-fulfilment contact under s.7(a) is fine; a festival promotion to the same list is not.
3. **Browsing.** Opening a customer record with no order, ticket or enquiry in play is processing without a purpose. It cannot be prevented, which is exactly why 6(1)(c) requires it to be *visible*.

### 2.4 Erasure — what it means when the order must legally survive

✅ **DPDP s.12(3), verbatim:** *"A Data Principal shall make a request in such manner as may be prescribed to the Data Fiduciary for erasure of her personal data, and upon receipt of such a request, the Data Fiduciary shall erase her personal data **unless retention of the same is necessary for the specified purpose or for compliance with any law for the time being in force**."* ([s.12](https://indiankanoon.org/doc/32698339/)) ⚠️ Rule 14 gives *"a reasonable period not exceeding ninety days"* to respond (per §4.6, read from the primary text there).

The lawful retentions that survive an erasure request:

| Record | Why it survives | Floor |
|---|---|---|
| `orders` + `order_items` price/weight/purity snapshot | ✅ BIS (Hallmarking) Regulations 2018 Reg. 5(11) invoice content; Reg. 5(13) record-keeping | five years, or until sold, whichever is longer |
| The tax invoice and its supporting records | ⚠️ CGST s.36 — books and records retained until 72 months from the due date of the annual return | 72 months |
| Recipient **name, delivery address and State code** on an invoice ≥ ₹50,000 to an unregistered buyer | ✅ CGST Rule 46(e)/(f) ([CBIC](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule46_v1.00.html)) | as above |
| **PAN**, where the order was ≥ ₹2,00,000 | ✅ Income-tax Act 2025 s.262(9) puts the duty to *ensure* PAN was quoted on the seller; proof of compliance must exist | per income-tax record-keeping |
| Logs of processing | ✅ DPDP Rule 6(1)(e) one year; ✅ CERT-In (iv) 180 days rolling | see §2.5 |

**And the ones that do not.** `orders.contact_phone` and `orders.contact_email` are **not** required by CGST Rule 46, by BIS Reg. 5(11), or by anything else in the list above. `support_tickets.contact_phone` / `contact_email` on a long-closed ticket are likewise not statutory. On the s.12(3) test — *"unless retention is necessary"* — a blanket refusal to touch those columns six years after the sale is not defensible.

> ⚠️ **This contradicts `db/schema.ts`.** The `customers` comment says flatly: *"The purge job **MUST NOT touch `orders` or `order_items`**. Those are GST documents and BIS Reg. 5(13) records… Redact the customer row; keep the order."* Keeping the *order* is right. Keeping **every column** of the order forever is over-retention wearing a compliance justification. The erasure job must operate at **column granularity**, driven by a written table of which columns are statutorily required and which are convenience. See §8-C3.

**And the retention floor is measured from the wrong event.** ✅ Rule 8(3), verbatim: *"Without prejudice to sub-rules (1) and (2), a Data Fiduciary shall retain, in respect of any processing of personal data undertaken by it or on its behalf by a Data Processor, such personal data, associated traffic data and other logs of the processing for a minimum period of **one year from the date of such processing**, for the purposes as specified in the Seventh Schedule…"* The clock runs **from the processing**, not from the erasure request. `db/schema.ts` computes `purgeNotBeforeAt` as *"`deletionRequestedAt + 365 days`, computed at request time and stored"*, and §4.6 repeats it. For a customer who bought in January 2026 and asks for erasure in August 2027, the schema forces a further year of retention that no rule requires — and s.12(3) requires erasure *unless retention is necessary*, so the extra year is itself the exposure. See §8-C1.

> **The good news is that this is a comment-and-code fix, not a migration.** `customers_retention_floor_ck` only asserts `redacted_at >= purge_not_before_at` and that the pair is written together. It does not dictate how `purge_not_before_at` is computed. Setting it to `max(latest_processing_date + 1 year, deletion_requested_at)` satisfies the constraint unchanged.

⚠️ One caveat on Rule 8(3)'s reach: sub-rules 8(1) and 8(2) are addressed to *"a Data Fiduciary, who is of such class… as are specified in [the] Third Schedule"* — i.e. the ≥2-crore-user e-commerce class, which this shop is nowhere near — and 8(3) opens *"Without prejudice to sub-rules (1) and (2)"*. Commentators split on whether "a Data Fiduciary" in 8(3) is general or carries the Third Schedule limitation forward ([Mondaq analysis](https://www.mondaq.com/india/privacy-protection/1710314/), [dpdpa.in](https://www.dpdpa.in/dpdpa_rules_2025/Rule_8.htm) reads Rule 8 as Third-Schedule-scoped). **It does not matter for the build**: Rule 6(1)(e) independently requires *"retain such logs and personal data for a period of one year"* of every Data Fiduciary, so the one-year floor holds either way. Recording the reasoning here so nobody re-litigates it later. §4.6 cites only Rule 8(3) for this and should cite 6(1)(e) as the load-bearing one.

**What the admin must be able to do.**

- Record an erasure request against a customer, writing `deletion_requested_at` and `purge_not_before_at` **together** (the CHECK enforces it).
- See a queue of open requests **with the 90-day clock**, and record the response sent. ⚠️ **Schema gap:** `customers` has `deletionRequestedAt`, `purgeNotBeforeAt` and `redactedAt`, but nothing to record *that a response was given and when*. Rule 14's ninety days is a duty to respond, and the current schema cannot evidence compliance with it.
- **Never** perform an erasure by `DELETE`. §3.
- See, per customer, what will and will not be erased — because the admin has to say that to the customer in the response.

### 2.5 Breach notification — and why the audit log determines its cost

Two regimes, different triggers, and the fast one is live today.

**CERT-In, live now.** ✅ Direction (ii): *"Any service provider, intermediary, data centre, body corporate and Government organisation shall mandatorily report cyber incidents as mentioned in Annexure I to CERT-In **within 6 hours** of noticing such incidents or being brought to notice about such incidents."* Annexure I includes **(iii) Unauthorised access of IT systems/data**, **(x) Attacks on Application such as… E-Commerce**, **(xi) Data Breach** and **(xii) Data Leak**. Six hours is not an SLA the shop can meet by noticing a problem on Monday — it needs a named point of contact (direction (iii) requires one to be registered with CERT-In) and a pre-written report. Non-compliance is punishable under IT Act s.70B(7).

**DPDP, from 2027.** ✅ s.8(6) plus Rule 7: to each affected Data Principal *"without delay"*, with the nature/extent/timing, the consequences relevant to her, the mitigations, what she should do, and a contact; to the Board *"without delay"* for the first description and **within seventy-two hours** for the detailed report including *"findings regarding responsible persons"*. ✅ There is **no materiality threshold** — a one-record breach is notifiable.

**The build consequence, and it is the strongest practical argument for read logging.** Rule 7(1) obliges notification of *each affected* Data Principal. If the system cannot say which records a compromised session actually read, the affected set is *every customer in the database*, and the shop must notify all of them. A read log turns "notify everyone and explain publicly" into "notify the eleven customers whose records were opened between 02:14 and 02:41". That difference is the entire commercial case for §4, independent of the legal one.

⚠️ **And this is where F2 bites.** CERT-In (iv) requires those logs to be *"maintained within the Indian jurisdiction"*, and D1 offers no India region. Options, none free: (a) accept the exposure and document the decision; (b) mirror every audit event to an India-hosted sink — the `LEAD_WEBHOOK_URL` pattern in `app/api/appointments/route.ts:12-15` is the existing, proven mechanism for pushing an event off-box and would need only an Indian endpoint behind it; (c) obtain counsel's view on whether a proprietor jeweller's website is within the intended reach of directions aimed at service providers and intermediaries. **This is not resolvable in code and must not be resolved by a developer.** See §7.

---

## 3. What the admin must not be able to do

### 3.1 The three prohibitions

**P1 — Delete an order or an order line.** `db/schema.ts` compensation (7): *"No code path may `DELETE FROM orders` or `DELETE FROM order_items`."* The legal basis is BIS Reg. 5(13) (five years or until sold, whichever is longer) and ⚠️ CGST s.36 (72 months). Deleting an order destroys a statutory record and, if it had a `support_tickets` row, destroys the evidence of a consumer complaint's handling.

**P2 — Edit a placed order's price snapshot.** ✅ Reg. 5(11) requires the bill to show *"separately description of each article, net weight of precious metal, purity in carat and fineness, and hallmarking charges"*, and §7.6/`order_items` exists so that document reconstructs to the paise in 2031. An admin who can retype `metal_value_paise` can retroactively rewrite what a customer was told they bought.

**P3 — Delete or edit a customer row.** `db/schema.ts`: *"DELETION IS SOFT… Every PII column here is nullable… so the erasure job nulls the columns in place and the row survives as a tombstone."* A hard delete orphans `orders.customer_id` and `support_tickets.customer_id` (both deliberately FK-less) and destroys the consent record that ✅ DPDP s.6(10) puts the burden of proving on the shop.

### 3.2 What can actually be enforced, versus what is only a review rule

| Prohibition | Enforceable by the database today | Enforceable by code | Review/UI only |
|---|---|---|---|
| No `DELETE FROM orders` | ❌ today — but **probably yes via a hand-written trigger**, see below | ✅ the data layer exposes no delete; `getOrderDb()` returns a 4-method port, and adding a delete is a visible diff | the residual: `wrangler d1 execute --remote` bypasses the app entirely |
| No `DELETE FROM order_items` | same | same | same |
| No edit of a price snapshot | ❌ SQLite has no per-column immutability — but a `BEFORE UPDATE … WHEN OLD.total_paise <> NEW.total_paise` trigger would do it | ✅ **the admin data layer must contain no `UPDATE orders SET …_paise` statement at all** | which columns *are* updatable is the review rule |
| No hard delete of a customer | ✅ **already structurally impossible via the app**: no FK from `orders` to `customers`, so no `ON DELETE CASCADE` edge exists to be mis-annotated | ✅ | direct SQL |
| No purge inside the retention floor | ✅ `customers_retention_floor_ck` rejects it at the database | — | — |
| Payment capture cannot be switched on from the UI | ✅ `PAYMENT_CAPTURE_ENABLED` is a **compile-time constant**, not an env binding — *"it must not be possible for the deployed copy to disagree with the deployed behaviour because someone set a variable in a dashboard"* | — | — |

**The trigger question (F5).** `db/schema.ts` treats append-only as unenforceable because *"triggers… the migration pipeline does not emit"*. That is true of drizzle-kit's **generator**; it is not true of the **pipeline**. `build/sites-vite-plugin.ts:36-40` copies `drizzle/` wholesale, and the platform applies the SQL it finds. A hand-written migration containing

```sql
CREATE TRIGGER orders_no_delete BEFORE DELETE ON orders
BEGIN SELECT RAISE(ABORT, 'orders are append-only'); END;
```

would convert P1 from a review rule into a database guarantee that survives a future developer, a bad migration, **and a direct `wrangler d1 execute --remote`**. That last point is what makes it worth doing: it is the only control in this document that constrains the person holding the database credentials.

**[UNVERIFIED]:** whether the platform's migration applier splits statements on `--> statement-breakpoint` (safe — the trigger body's internal `;` survives) or on bare `;` (the trigger is split into fragments and the migration fails). **Settle it locally** with `wrangler d1 execute --local` against a throwaway database plus a `npm run build` inspection of `dist/.openai/drizzle` — no production access needed, and the brief's prohibition on `--remote` is not engaged. A second [UNVERIFIED]: whether drizzle-kit's snapshot mechanism tolerates hand-edited migration files on the *next* `db:generate` (it should, since snapshots are per-migration, but confirm before relying on it).

**The residual that no trigger closes.** The one person who can log in is also, realistically, the person who can run `wrangler d1 execute --remote` and who controls the hosting console. Triggers can be dropped by whoever can create them. **There is no technical control inside this system that binds its own administrator.** State that plainly in the build plan rather than implying the audit log or the constraints provide it. What *does* survive: ⚠️ D1 Time Travel gives point-in-time restore for **7 days (free) / 30 days (paid)** ([D1 limits](https://developers.cloudflare.com/d1/platform/limits/)) — a recovery path outside the application, though also outside the shop's discipline.

### 3.3 What the admin *must* be able to do to the same tables

Immutability must not be over-applied, or the panel is useless and the owner will go around it:

- **Order state.** `status`, `payment_status`, `fulfilment_status`, `updated_at`, and `notes` are workflow, not statutory content. All are freely updatable, all are audited.
- **`complaint_ticket_number`** — writable when a real complaint is lodged. See §5.
- **Stock.** `variants.stock_quantity` must be restorable on cancellation (F4). `variants` is not a statutory record; `order_items` snapshots everything the invoice needs precisely so the catalogue can move.
- **Catalogue.** Products, variants, media, prices-in, HUIDs — fully editable. `db/schema.ts` anticipates exactly this: *"the admin will edit titles, weights and photographs and must not retroactively rewrite what a customer bought"*, which is an argument for the snapshot, not against editing.
- **Rates.** Append-only by a different mechanism — `gold_rates_current_idx` plus close-then-insert. An admin "correct today's rate" action must close the old row and insert, in one batch, never `UPDATE`.

### 3.4 A refinement on *when* the order becomes a statutory document

`db/schema.ts` calls `order_items` **"THE STATUTORY SNAPSHOT"** from the instant of placement. Legally that is slightly early, and the difference matters for §6.

✅ BIS Reg. 5(11) binds *"the bill or invoice of sale"*. ⚠️ CGST s.31(1) requires a tax invoice *"before or at the time of removal of goods for supply to the recipient, where the supply involves movement of goods"* ([s.31](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter7/section31_v1.00.html)). With `PAYMENT_CAPTURE_ENABLED = false`, nothing has been paid, nothing has moved, and **no tax invoice has been raised**. The `orders` row is at that point an order confirmation and a record of what the customer was quoted — evidentially important, contractually important, but not yet the document Reg. 5(11) and CGST Rule 46 govern.

**The practical consequence is liberating, not loosening.** Before invoice issue, the clean correction for a wrong order is **cancel and re-place** — a new order number, the old one preserved as `cancelled` with a reason. After invoice issue, an edit is not available at all: ⚠️ the instrument is a **credit note under CGST s.34**, whose details must be declared *"not later than the thirtieth day of November following the end of the financial year in which such supply was made, or the date of furnishing of the relevant annual return, whichever is earlier"* ([s.34](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter7/section34_v1.00.html)). **The schema has no credit-note table.** That is not a gap for this milestone — no invoices exist yet — but it must not be discovered on the day the flag flips.

So: keep the snapshot immutable from placement (it is the right engineering answer and the right consumer-trust answer), but do not let the *immutability* argument stop the admin cancelling an unpaid, uninvoiced order — which §6 shows is the most common thing they will need to do.

---

## 4. The audit log

### 4.1 Is it required, or merely wise?

**Required.** ✅ Rule 6(1)(c) of the DPDP Rules 2025 obliges *"visibility on the accessing of such personal data, through appropriate logs, monitoring and review, for enabling detection of unauthorised access"* — from ~May 2027. ✅ CERT-In direction (iv) obliges *"logs of all their ICT systems"* for a rolling 180 days — **today**. `db/schema.ts` describes `admin_audit_log` as *"the record of who accessed customer data, which is the defensible answer under DPDP"*. That understates it: it is a mandated safeguard, not a defence.

### 4.2 What must be recorded

**Every mutation**, with `actor`, `action`, `entity_type`, `entity_id`, `created_at`, and a `diff`. The dotted-action convention in the schema (`order.status_changed`, `rate.updated`) is right; extend it rather than inventing a second scheme.

**And — the part that does not exist yet — reads of personal data.** Rule 6(1)(c) is about *accessing*, and §2.5 shows read logging is what bounds a breach notification. Minimum set: opening a customer record, opening an order detail, revealing a masked PAN or phone, running a search that returns customer rows (log the query shape and the result count, not the results), and any export.

**And authentication events**, which no one owns today: `admin.login_succeeded`, `admin.login_failed`, `admin.locked_out`, `admin.logout`, `admin.session_expired`, `admin.password_changed`. Without these the 6-hour CERT-In clock has nothing to start from, because there is no signal that says "someone got in".

For login events, recording the admin's own source IP and `cf-ipcountry` is proportionate — it is the shop's own operator, not a customer.

### 4.3 What must NOT be recorded

The schema gives `diff_json` as free text and nothing stops a naive whole-row diff of an `orders` or `customers` update from writing **a name, a phone, a full address and a PAN** into the audit table — creating a second, unmanaged copy of the exact data the log exists to protect, outside the erasure job's reach.

**Hard rules:**

- **Never** a PAN, a password, a password hash, a salt, a pepper, a session id, a CSRF token, `GOLD_RATE_INGEST_TOKEN`, a gateway signature, or a `payments.raw_payload_json` body.
- **Never a whole-row diff.** `diff_json` must be built from an **allowlist of loggable column names**, with everything else recorded as a change indicator (`{"customer_pan": "changed"}`) rather than a value. This is a ten-line helper and it must be the only writer to the table.
- Never a full phone or a full address — record `entity_id` and let the reader join if they are authorised to.
- The same discipline applies to `console.error`. The order layer already logs only order numbers and SKUs (`app/_data/orders.ts:1634-1646`); an admin panel that logs a customer object breaks that and ships PII to the platform's log pipeline.
- ⚠️ Do **not** start recording customer IP addresses. `app/api/appointments/route.ts:74-78` deliberately declines to: *"IP-level limiting belongs in a Cloudflare WAF rate-limiting rule, not here — doing it in D1 would mean storing visitor IPs, which is PII this shop has no reason to hold."* An audit log is not a reason to reverse that.

### 4.4 Retention

Two floors and one ceiling: ✅ Rule 6(1)(e) **one year**; ✅ CERT-In (iv) **180 days rolling, in India** (§2.5, F2); and — because the log itself contains personal data (which customer was read) — it is subject to erasure once the purpose is exhausted. **A safe, defensible policy is: retain audit rows for 24 months, then delete.** Do not retain indefinitely: an audit log kept forever is a permanent record of every customer the shop ever looked at, and it will outlive the customer record it describes.

`admin_audit_log` has an index on `created_at`, so an age-based sweep is one query. There is no cron trigger on this control plane (per §7.7 and `app/_data/cart.ts:296-303`), so it must be a **lazy sweep on admin login** — the same pattern the cart uses for expired holds, bounded so a single login does not do unbounded work.

### 4.5 Can it be tampered with by the only person who can log in?

**Yes, and no design in this repository prevents it.** The owner holds, or can obtain, the D1 credentials; `wrangler d1 execute --remote "DELETE FROM admin_audit_log WHERE …"` needs no admin session at all. Say this out loud in the build plan, because a log that is presented as tamper-proof and is not is worse than one that is honestly described.

What is achievable, in increasing order of cost:

1. **Append-only via the application** — the admin data layer contains no `UPDATE` or `DELETE` against `admin_audit_log`. Stops accidents, stops a compromised session, stops nothing else.
2. **A `BEFORE UPDATE`/`BEFORE DELETE` trigger** that `RAISE(ABORT)`s (§3.2, subject to the same [UNVERIFIED] applier question). Raises the bar to "drop the trigger first" — which is itself a detectable event if anyone looks.
3. **Hash chaining.** Each row stores `prev_hash = SHA-256(previous row's hash ‖ this row's canonical fields)`. Deleting or editing a row breaks the chain and is *detectable*. Against the owner it is only partially effective — they can recompute the chain — **unless** the head hash is periodically anchored somewhere they do not control.
4. **Off-box mirroring**, which is the only real answer, and which also satisfies CERT-In's Indian-jurisdiction requirement (§2.5, option (b)). The `LEAD_WEBHOOK_URL` pattern already in the tree is the mechanism; it needs an India-hosted endpoint and must be **best-effort and non-blocking** — an audit mirror that fails must never abort the action it was describing, and must itself be recorded as a failure.

**Honest framing.** Against an *intruder*, the audit log is a detection and scoping control and it works. Against the *owner*, it is evidence the owner keeps in order to be able to demonstrate to a regulator, a customer or an insurer what happened — which is a real and sufficient purpose. It is not, and cannot be made into, a control over the owner.

---

## 5. Support tickets and Rule 4(5)

### 5.1 What the rule actually requires

✅ **Rule 4(5), G.S.R. 462(E), verbatim** ([consumeraffairs.gov.in](https://consumeraffairs.gov.in/public/upload/files/E%20commerce%20rules_1732703966.pdf)): the grievance officer *"**acknowledges the receipt of any consumer complaint within forty-eight hours and redresses the complaint within one month from the date of receipt**."*
✅ **Rule 7(1)(f):** display *"a **ticket number for each complaint lodged**, through which the consumer can track the status of their complaint."*
✅ **Rule 4(4):** publish the grievance officer's *"name, contact details, and designation."*

Three things follow from the text. The trigger is a **complaint**, received from a **consumer**. The clocks run from **receipt** of that complaint. And the ticket number is per **complaint lodged**, not per order — a single order can generate more than one.

⚠️ On the arithmetic: `TICKET_REDRESS_DAYS = 30` (`app/_data/orders.ts:236`) implements *"one month"* as 30 days. Under the General Clauses Act 1897 s.3(35) a "month" is reckoned by the British calendar, so from 31 January one month expires 28 February — 28 days, not 30. A fixed 30-day computation is therefore **later than the statutory deadline** in short months. The value is stored in a column rather than recomputed, so calendar-correct arithmetic costs nothing. Minor, but free to fix.

### 5.2 Is a ticket per order correct?

**No. It manufactures a compliance liability that the law did not impose, and it consumes a slot that a real complaint needs.**

What the code does today (`app/_data/orders.ts:1596-1616`): every successful placement writes a `support_tickets` row with `kind = 'query'`, `status = 'open'`, `subject = "Order AJ-…"`, `acknowledge_due_at = now + 48 h`, `redress_due_at = now + 30 d`, and copies its number into `orders.complaint_ticket_number`. The intent is sound — it makes the batch atomic and guarantees `complaint_ticket_number` never names a ticket that does not exist. The consequences are not:

1. **A self-inflicted, permanently breached SLA.** Nobody is going to "acknowledge" an order acknowledgement within 48 hours. Within two days of launch, the database asserts that every order has an open grievance ticket past its acknowledgement deadline. In a consumer-commission proceeding or a CCPA inquiry, that record is produced and it reads as systemic Rule 4(5) failure. **A record of a breach the shop did not commit is worse than no record.**
2. **The overdue queue is destroyed before it exists.** `support_tickets_status_due_idx` on `(status, redress_due_at)` exists so *"an overdue queue is one indexed query"*. If every order is in it, the one genuinely angry customer is invisible.
3. **The complaint slot is already taken.** `orders.complaint_ticket_number` is a single column under `uniqueIndex("orders_complaint_ticket_idx")`. It is filled at placement with a `kind='query'` ticket. When a real complaint arrives — which is the *only* thing Rule 7(1)(f) is about — the order has nowhere to record its number. And the column cannot hold a second one.
4. **`kind` and the column name disagree.** `db/schema.ts` documents `complaintTicketNumber` as *"Ticket number for a **complaint** lodged against this order"*, and the code fills it with a `query`. Any future report that trusts the column name is wrong.

### 5.3 What to do instead

- **Do not open a ticket at placement.** `orders.complaint_ticket_number` is nullable; leave it null. Rule 7(1)(f) is satisfied when a complaint is lodged, and only then.
- **The order-confirmation page still needs a reference** — it already has one: `orders.order_number`. That is what the customer quotes when they call. A separate ticket number at placement adds a second identifier for the same thing and helps nobody.
- **If the placement-time record is wanted for internal workflow** ("call this customer to settle payment", §6), it belongs in `orders.notes` or in a dedicated follow-up state, **not** in the table that carries statutory grievance clocks.
- **`acknowledge_due_at` and `redress_due_at` are `notNull`.** Any ticket that exists has clocks. That is correct *for complaints* and is another reason non-complaints must not be tickets.
- **A second complaint on the same order** needs a home. `support_tickets.order_id` is a weak reference and already supports many-to-one; only the denormalised `orders.complaint_ticket_number` does not. Treat that column as *"the first complaint's number, for printing on the order page and the invoice"* — exactly what its comment says — and make `support_tickets` authoritative in every query.

### 5.4 What the admin must be able to do

- **Lodge a complaint** received by any channel (phone, WhatsApp, walk-in, email) against an order or against no order, issuing a ticket number, with `acknowledge_due_at` and `redress_due_at` computed from **the date of receipt** — which may be earlier than the date of entry. Both columns are `notNull`, so the form must capture receipt time and not silently use `now()`.
- **Acknowledge**, setting `acknowledged_at`, and see the 48-hour clock.
- **An overdue queue** on `(status, redress_due_at)`, defaulting to overdue-first.
- **Resolve**, setting `resolved_at` and a `resolution_note` — the evidence that redressal happened within one month.
- **See the ticket as the consumer sees it**, because Rule 7(1)(f) requires the consumer to be able to *track the status*. That implies a customer-facing lookup by ticket number, which is out of this document's lane but is a Rule 7(1)(f) requirement that nothing currently satisfies.
- Every one of these is an audited action (§4.2).

⚠️ **Also unaddressed:** Rule 4(4) requires the grievance officer's name, contact details and designation to be **published**, and §4.3 already records that `SITE_DETAILS_PENDING = true` makes most of §4.3 undeliverable. A grievance workflow with no published grievance officer is half a compliance story.

---

## 6. What is owed while payment capture is off

### 6.1 The state the customer is actually in

`PAYMENT_CAPTURE_ENABLED = false`. Placement writes a real `orders` row with `status = 'pending_payment'`, `payment_status = 'unpaid'`, `advance_paid_paise = 0`, and a `payments` row with `provider = 'manual'`, `status = 'created'`. The customer is told, in the shop's own words (`paymentStanding()`, `app/_data/orders.ts:1960-1980`): *"Nothing has been charged and nothing has been paid… we will call you to confirm the piece."*

That copy is honest and it is the right design. Three obligations follow from it.

### 6.2 What the shop owes

**A prompt human response.** The flag-off flow is, by construction, a promise that a person will call. §3.9 makes this explicit — the flag-off path *"needs a real terminus, not a dead end"*. If nobody calls, the shop has taken a one-of-a-kind piece off sale (§6.3) and left a customer waiting, which is an unfair trade practice risk under the Consumer Protection Act 2019 long before it is a Rule 4 problem.

**A free cancellation.** ✅ E-Commerce **Rule 4(8)**: no cancellation charge on a consumer *"unless similar charges are also borne by the e-commerce entity"* if it cancels unilaterally. With ₹0 taken, there is nothing to deduct and nothing to argue about. Both sides can walk away.

**Clarity about whether a contract exists.** With no payment and no published terms, **when the contract forms is undefined**, and the only evidence is the confirmation copy. §4.3 records that `app/` has no `/terms`, `/privacy`, `/returns` or `/shipping` route at all. The safe reading, and the one the copy already supports, is that the customer's order is an **offer** and the shop's confirming call is the **acceptance**. That reading must be stated somewhere the customer can read it. **Whether it holds is a lawyer's question (§7).**

**Nothing that implies money moved.** `app/_data/orders.ts` (1): *"NOTHING HERE MAY SAY OR IMPLY THAT MONEY WAS RECEIVED… There is no code path below that writes `captured`, `paid` or `advance_paid`, and there must not be one until the flag flips."* **The admin panel is the most likely place this rule gets broken** — a status dropdown listing `paid`, `advance_paid`, `refunded` lets an operator set them with one click while no gateway exists. Requirement: while `PAYMENT_CAPTURE_ENABLED` is false, the admin may set only `confirmed`, `in_production`, `ready_for_pickup`, `shipped`, `delivered`, `cancelled` and `failed`; the money states are **not selectable**, and a payment recorded at the counter goes through a `payments` row with `provider = 'manual'`, `method = 'in_store'` (which the enum already provides) rather than by editing the order.

### 6.3 What the admin must be able to do — and the one thing that is missing

**Cancel** — `status = 'cancelled'`, a reason, and **restore `variants.stock_quantity`**. This is F4 and it is the gap. `DECREMENT_STOCK` runs in the placement batch; nothing anywhere increments. Requirements:

- The status change and the stock restoration are **one `db.batch()`** — the only atomicity primitive D1 offers. A cancelled order with un-restored stock is a piece permanently off sale; a restored piece on a live order is an oversell of a one-of-a-kind item, which `db/schema.ts` calls *"unrecoverable, because there is no second one"*.
- The restore must be **idempotent**. Two clicks on "Cancel" must not add two pieces of a one-of-a-kind item to stock. Guard it on the transition (`WHERE status <> 'cancelled'`) and assert `changes === 1`, in the style of the existing decrement check (`app/_data/orders.ts:1631-1638`).
- ⚠️ `variants_unique_piece_stock_ck` (`is_unique_piece = 0 OR stock_quantity <= 1`) means a buggy double-restore on a unique piece **aborts the batch** rather than corrupting stock. Good — but only if the restore is inside the same batch as the status change.
- `stock_reservations` for that cart is already `consumed` and should stay so; the reservation is a checkout lock, not an inventory record.

**Amend** — only outside the price snapshot. A wrong shipping address on an unshipped, uninvoiced order is a correction the shop must be able to make; a wrong price is a **cancel-and-re-place** (§3.4). The admin UI must make that distinction structurally, by simply not offering the money fields, rather than by warning about them.

**Refuse** — a shop may decline an order (the piece is already promised, the customer is not reachable, the value is one the shop wants at the counter). `status = 'cancelled'` with a distinct reason, and the customer must be told. ⚠️ Rule 4(8) means the refusal cannot cost the customer anything.

**Record an in-store settlement** — a `payments` row, `provider = 'manual'`, `method = 'in_store'`, `kind = 'in_store_balance'` or `'full_payment'`, `status = 'captured'`. ⚠️ §3.9 explicitly anticipates this: *"Add a `provider: 'manual'` payment row… that is how a shop-settled order gets recorded while the flag is off."* But note **the flag gates the webhook capture branch, not this** — so the admin panel is the *only* path by which any `payments` row ever reaches `captured` today, and the copy in §6.2 must not be contradicted by it. ⚠️ And anything settled in cash re-engages Income-tax Act 2025 **s.186** (₹2,00,000 aggregating per person per day **and per event**, s.451 penalty of 100% of the sum received). If the admin can record a cash settlement, it needs a per-customer-per-day aggregation check, not a per-order one — §4.7 is emphatic about this and it is the highest-severity money rule in the whole build.

**Handle a torn order.** `PlacementFailure.reason = "torn"` exists and the customer is told to call the shop. Somebody has to be able to look at that order and decide. It must be visible, flagged, and **not invoiceable or fulfillable** until reconciled.

### 6.4 What must be recorded on every one of these

`admin_audit_log`: actor, dotted action (`order.cancelled`, `order.address_amended`, `order.refused`, `payment.recorded_in_store`, `stock.restored`), `entity_type = 'order'`, `entity_id`, an allowlisted diff (§4.3), and — for cancel and refuse — **a reason**, because that is what Rule 4(8) and any subsequent dispute turn on. `orders.notes` should carry the human sentence; the audit row carries the machine record. Neither is a substitute for the other.

---

## 7. What needs a lawyer, not a developer

§4.8 already flags two, and both stand:

1. ⚠️ **Legal Metrology / MRP** — whether shipped jewellery is a "pre-packaged commodity" requiring Rule 6(1) declarations including an MRP inclusive of all taxes (§4.4). Unresolved; product-changing.
2. ⚠️ **BIS "certified sales outlets"** — whether QCO cl. 2(1)'s *"sold only by registered jewellers through certified sales outlets"* accommodates online sale or dispatch from unregistered premises (§4.1). Unresolved.

This milestone adds five more. **None of these has a published answer and none should be guessed at by whoever builds the panel.**

3. **Does CERT-In's Direction (iv) — 180 days of logs "within the Indian jurisdiction" — bind this shop, and if so, is a D1-hosted audit log a breach of it?** The directions are addressed to *"service providers, intermediaries, data centres, body corporate"*; ✅ s.43A's definition of body corporate reaches a sole proprietorship engaged in commercial activity, which is a wide net that was probably not drafted with a jeweller's website in mind. **What would settle it:** counsel's opinion, or a query to CERT-In. **What it changes:** whether an India-hosted log mirror is mandatory infrastructure (§2.5) or an optional nicety. This is the single most build-shaping of the five.

4. **When does the contract form on a flag-off order, and does the current confirmation copy say so adequately?** With no `/terms` route and no money taken, the shop's position rests entirely on `paymentStanding()`'s wording. **What would settle it:** counsel drafting terms of sale that state the offer/acceptance model, alongside the Rule 7(1)(a)/(c) disclosures that are already missing. **What it changes:** the confirmation copy and the cancellation UI.

5. **How far does the erasure obligation reach into an order row?** §2.4 argues that `contact_phone` and `contact_email` on a decade-old order are not statutorily required and therefore not exempt from s.12(3). That is a reasoned position, not an authority. **What would settle it:** counsel's view on the s.12(3) *"necessary for… compliance with any law"* test applied column-by-column to a GST invoice's supporting record. **What it changes:** whether the erasure job is a one-line customer-row redaction or a column-level policy across three tables.

6. **Who is the grievance officer, and who is the DPDP Rule 9 contact person?** ✅ Rule 4(4) requires the former's name, contact and designation to be published; ✅ Rule 9 requires *every* Data Fiduciary to *"prominently publish on its website"* and *"mention in every response"* a business contact for data-principal questions. In a one-person shop these are the same person, and naming them creates personal exposure. **What would settle it:** a decision by the owner, on advice. **What it changes:** `app/site-config.ts`, the footer, the ticket workflow's acknowledgement template.

7. **Is a shared admin password acceptable, and does the shop want per-person credentials?** §1.8. Not strictly a legal question — but the moment the audit log misattributes an access, its evidential value under Rule 6(1)(c) collapses, and that *is* legal. **What would settle it:** the owner deciding who needs access. §5.4 asks the same question for a different reason (*"Ask the owner who needs admin access before building"*) and it still has no answer.

⚠️ Also inherited and still open, because the admin will now be the one exercising them: whether the site must publish a daily gold rate (§4.1, [UNVERIFIED negative]); e-way bill applicability for Chapter 71 in the shop's own state (§4.7, state-dependent per Rule 138F); and whether *"irrespective of the mode of payment"* survived the Rule 114B → Rule 159 renumbering, which decides whether a ₹2.5 lakh UPI order needs PAN at all (§4.7, and the code already assumes it does — `PAN_REQUIRED_AT_PAISE`).

---

## 8. Contradictions with existing documents

These are the most valuable output of this document. Each one is a place where `db/schema.ts` or `research/02-market-tech.md` — both of which drive the build — assumes something this research finds to be wrong or incomplete.

**C1 — The one-year retention floor is measured from the wrong event.**
*They say:* `db/schema.ts` (`customers.purgeNotBeforeAt`): *"`deletionRequestedAt + 365 days`, computed at request time and stored"*; §4.6 repeats it.
*Actually:* ✅ Rule 8(3) measures *"one year from the date of such processing"*, and Rule 6(1)(e) says *"a period of one year"* of the logs and data themselves. Neither runs from the erasure request. The current rule over-retains by up to a year and puts the shop on the wrong side of s.12(3)'s *"unless retention is necessary"* test.
*Cost to fix:* a comment and one computation. `customers_retention_floor_ck` does not need to change.

**C2 — "Cloudflare is fine" is true of DPDP and false of CERT-In.**
*They say:* §4.6: *"nothing in DPDP requires Indian hosting for a non-SDF, so **Cloudflare is fine**."*
*Actually:* ✅ CERT-In Direction (iv) requires ICT-system logs to be *"maintained within the Indian jurisdiction"* for 180 rolling days, is **in force today**, and ✅ D1 has no India region. §4.6 cites CERT-In only for the 6-hour reporting rule and misses (iv) entirely.
*Cost to fix:* either an accepted, documented risk or an India-hosted log mirror. Needs counsel (§7-3).

**C3 — "The purge job MUST NOT touch `orders`" is too broad.**
*They say:* `db/schema.ts` (`customers`): *"The purge job MUST NOT touch `orders` or `order_items`… Redact the customer row; keep the order."*
*Actually:* keeping the order is right; keeping `contact_phone` and `contact_email` forever is not defensible under s.12(3), because neither is required by CGST Rule 46, BIS Reg. 5(11), or anything else.
*Cost to fix:* a column-level retention policy table instead of a table-level rule. No migration.

**C4 — Append-only orders may be database-enforceable after all.**
*They say:* `db/schema.ts` compensation (7): *"SQLite cannot be made to refuse this without triggers, **which the migration pipeline does not emit**, so it is a review rule."*
*Actually:* `build/sites-vite-plugin.ts:36-40` copies `drizzle/` verbatim and the platform applies it. drizzle-kit does not *generate* triggers; nothing prevents one being *written*. **[UNVERIFIED]** only on the applier's statement-splitting, settleable locally.
*Cost to fix:* one hand-written migration, if the applier cooperates. Upgrades the single most important prohibition in the schema from convention to guarantee.

**C5 — The auth decision reverses the research's own recommendation, and the platform will not carry it.**
*They say:* §5.4 recommends SIWC + D1 allowlist; §5.3 rates password sessions *"good as the mechanism, bad as the identity source"*; §0.2 marks self-hosted password auth **[BLOCKER for free tier]**; `db/schema.ts` (`admin_users`): *"Identity comes from the platform's sign-in."*
*Actually:* the milestone specifies password + signed cookie, and ✅ Workers caps PBKDF2 at 100,000 iterations with no Argon2/bcrypt available, versus ⚠️ OWASP's ≥600,000 / Argon2id.
*Cost to fix:* §1.2's mitigations (generated ≥100-bit passphrase, env-secret pepper, constant-time compare) make it survivable. But `admin_users` has **no `password_hash`, no salt, no failed-attempt counters, no lockout, and there is no sessions table at all** — so this is a schema migration, and the schema comment describing the table's purpose becomes wrong the moment it lands.

**C6 — The Rule 7(1)(f) ticket is issued for the wrong event and blocks the right one.**
*They say:* `app/_data/orders.ts` (4): *"`support_tickets` is added to the list"* of the placement batch, so `orders.complaintTicketNumber` never names a missing ticket. `db/schema.ts` describes `complaintTicketNumber` as the number *"for a complaint lodged against this order"*.
*Actually:* ✅ Rule 4(5)/7(1)(f) are triggered by a **consumer complaint**, not by an order. The placement-time ticket starts statutory clocks nobody owes, is recorded as `kind = 'query'` under a column named for complaints, and permanently occupies the order's only complaint-number slot.
*Cost to fix:* remove one statement from the placement batch; leave `complaint_ticket_number` null until a complaint exists. §5.3.

**C7 — There is no path back for stock, so the flag-off order state is one-way.**
*They say:* §3.9: *"The flag-off path needs a real terminus, not a dead end… Build it as the real product."*
*Actually:* it is a dead end for inventory. Placement decrements `variants.stock_quantity` unconditionally and nothing restores it; every unpaid order that does not convert silently retires a one-of-a-kind piece.
*Cost to fix:* one batched admin action, guarded for idempotency. §6.3.

**C8 — The storefront's deliberate `Origin`-optional CSRF check must not be copied verbatim.**
*They say:* `app/api/cart/route.ts:82-87` and `app/api/orders/route.ts:69-73`: a request with **no `Origin`** is allowed through, *"because the attack needs a browser and a browser sends the header."*
*Actually:* correct for a public JSON API with no privileged state; wrong for admin, where there is no legitimate non-browser client and the missing header is free to forge from a server. §1.3.
*Cost to fix:* invert one condition — but only if someone notices, which is why it is here.

**C9 (minor) — "One month" is implemented as 30 days.**
`TICKET_REDRESS_DAYS = 30` vs ✅ Rule 4(5)'s *"one month"*; ⚠️ General Clauses Act 1897 s.3(35) reckons a month by the British calendar, so a 30-day clock runs **past** the deadline in February. Free to fix, since the deadline is stored rather than recomputed.

**C10 (minor, out of lane, noted because it invalidates a documented finding) —** §0.1 states *"There is **no `wrangler.jsonc`** — bindings come from `hosting.json` + the control plane"*, and §0.4 flags the `IMAGES` binding as undeclared. `wrangler.jsonc` now exists at the repo root and declares `"images": {"binding": "IMAGES"}`. Whoever owns §0 should recheck it; it does not affect this document's conclusions.

---

## 9. Requirement checklist — every hard requirement the code must satisfy

### Authentication and session

- [ ] The admin password is **generated**, ≥20 characters / ≥100 bits of entropy, never chosen by the owner. *(F1, §1.2)*
- [ ] Stored as PBKDF2-HMAC-SHA-256 at the Workers maximum (100,000), salt ≥16 bytes, **peppered with an env-held secret** so a D1-only leak is uncrackable. *(§1.2)*
- [ ] Password comparison is on derived keys, constant-time, reusing `secretsMatch()` from `app/api/gold-rate/route.ts`. *(§1.2)*
- [ ] ≥15-character minimum, breached-password blocklist check at set time, **no** composition rules, **no** forced periodic rotation. *(NIST 800-63B-4 §3.1.1.2)*
- [ ] Failed-attempt throttling in D1, **fail-closed**, keyed on `(account, source IP)`, increasing delay, **no permanent lockout**. *(§1.1)*
- [ ] Session id is opaque, CSPRNG, ≥128 bits, stored server-side in D1; **no role, email or expiry is trusted from the cookie**. *(§1.4, §1.5)*
- [ ] Session id is **minted fresh on successful login** and never adopted from the request — the `resolveCartId` rule. *(§1.3)*
- [ ] Cookie is `__Host-`-prefixed, `HttpOnly; Secure; Path=/; SameSite=Lax`, no `Domain`. *(§1.4)*
- [ ] Idle timeout **and** absolute lifetime; sign-out deletes the D1 row. *(§1.4)*
- [ ] `admin_users.is_active` and `role` are re-read on **every** request. *(§1.5)*
- [ ] A missing session secret / misconfiguration yields a **503, never an open door**. *(§1.7)*

### CSRF and route protection

- [ ] Every admin mutation is `POST` (or a Server Action); **no state change is reachable by `GET`**. *(§1.3)*
- [ ] Origin-vs-Host check on every mutation, with a **missing or `null` `Origin` refused** — the inverse of the storefront's rule. *(§1.3, C8)*
- [ ] `Sec-Fetch-Site` checked as a second signal. *(§1.3)*
- [ ] Per-session synchroniser CSRF token in every admin form. *(§1.3)*
- [ ] `middleware.ts` matcher covering `/admin/:path*` **and** `/api/admin/:path*`. *(§1.6)*
- [ ] **Every route handler and every Server Action re-checks authorisation in its own body.** *(§1.6)*
- [ ] A CI test enumerates every admin route and asserts 401/redirect unauthenticated. *(§1.6)*
- [ ] SIWC (`app/chatgpt-auth.ts`) is **not** accepted as admin identity anywhere. *(§1.6)*
- [ ] `GOLD_RATE_INGEST_TOKEN` never reaches the browser; `gold_rates.created_by` comes from the session. *(§1.7)*

### Data handling

- [ ] PAN and full phone are **masked by default**; revealing either is an explicit, audited action. *(Rule 6(1)(a), §2.2)*
- [ ] Any export is column-limited, excludes PAN, and is audited with a reason. *(§2.3)*
- [ ] Any list usable for outbound contact filters `marketing_opt_in = 1` **in the query**. *(§2.3)*
- [ ] No customer object is ever passed to `console.error`. *(§4.3)*
- [ ] No customer IP addresses are stored. *(§4.3)*

### What the admin must not be able to do

- [ ] No `DELETE FROM orders` / `order_items` / `customers` / `admin_audit_log` anywhere in the admin data layer. *(§3.1)*
- [ ] No `UPDATE` against any `*_paise`, `*_mg`, `fineness*`, `*_snapshot`, `hsn_code` or `gst_*` column on `orders` / `order_items`. *(§3.1)*
- [ ] A price correction is **cancel-and-re-place**, never an edit. *(§3.4)*
- [ ] Erasure is `UPDATE … SET NULL`, never `DELETE`, and never inside the retention floor. *(§3.1)*
- [ ] While `PAYMENT_CAPTURE_ENABLED` is false, `paid` / `advance_paid` / `refunded` / `captured` are **not selectable** in the admin UI. *(§6.2)*
- [ ] Investigate and, if the applier permits, ship `BEFORE DELETE` / `BEFORE UPDATE` triggers on `orders`, `order_items` and `admin_audit_log`. *(F5, §3.2)*

### Audit log

- [ ] Every mutation logged: actor, dotted action, entity type, entity id, allowlisted diff, timestamp. *(§4.2)*
- [ ] **Reads of personal data logged** — record opened, PAN/phone revealed, search run (shape + count), export taken. *(Rule 6(1)(c), §4.2)*
- [ ] Authentication events logged: login success, failure, lockout, logout, session expiry, credential change. *(§4.2)*
- [ ] `diff_json` is built by **one allowlist-driven helper**; a whole-row diff is never written. *(§4.3)*
- [ ] Never logged: PAN, password, hash, salt, pepper, session id, CSRF token, ingest token, gateway signature, raw gateway payload. *(§4.3)*
- [ ] The admin data layer contains **no `UPDATE`/`DELETE`** against `admin_audit_log`. *(§4.5)*
- [ ] Retention: keep ≥1 year (Rule 6(1)(e)), sweep at 24 months, lazily on login — there is no cron trigger. *(§4.4)*
- [ ] Decide and document the off-box mirror (§4.5 option 4 / §2.5 option (b)), which is also the CERT-In answer.

### Support tickets

- [ ] **Stop opening a `support_tickets` row at order placement.** *(F3, §5.3)*
- [ ] `orders.complaint_ticket_number` stays null until a real complaint is lodged. *(§5.3)*
- [ ] Complaint intake captures the **date of receipt**, and both clocks are computed from it. *(§5.4)*
- [ ] `redress_due_at` uses calendar-month arithmetic, not 30 days. *(C9)*
- [ ] Acknowledge / resolve actions write `acknowledged_at`, `resolved_at`, `resolution_note`. *(§5.4)*
- [ ] An overdue queue on `(status, redress_due_at)`. *(§5.4)*
- [ ] A consumer-facing ticket-status lookup exists (Rule 7(1)(f) — currently nothing satisfies it). *(§5.4)*

### Orders while payment is off

- [ ] **Cancel restores `variants.stock_quantity` in the same `db.batch()` as the status change**, idempotently, asserting `changes === 1`. *(F4, §6.3)*
- [ ] Cancellation is free to the customer. *(Rule 4(8), §6.2)*
- [ ] Address/contact amendment is permitted; money amendment is not. *(§6.3)*
- [ ] In-store settlement is a `payments` row (`manual` / `in_store`), never an edit to `orders`. *(§6.3)*
- [ ] Any cash settlement path aggregates **per customer per day and per event** against ₹2,00,000. *(Income-tax Act 2025 s.186, §6.3)*
- [ ] Torn orders (`reason: "torn"`) are visible, flagged, and blocked from invoicing and fulfilment. *(§6.3)*
- [ ] Cancel / refuse capture a **reason** in the audit row. *(§6.4)*

### Data-principal rights

- [ ] Erasure requests write `deletion_requested_at` **and** `purge_not_before_at` together, with the floor computed from **the date of processing**, not the request. *(C1, §2.4)*
- [ ] A request queue with the **90-day** Rule 14 clock, and somewhere to record the response — **a schema gap today**. *(§2.4)*
- [ ] Column-level erasure policy across `customers`, `orders` and `support_tickets`, not a table-level exclusion. *(C3, §2.4)*
- [ ] A pre-written CERT-In 6-hour report and a registered point of contact. *(§2.5)*
- [ ] A breach-notification path that can enumerate affected principals from the read log. *(§2.5)*

---

## 10. UNVERIFIED register

| # | Claim | Why it matters | What would settle it |
|---|---|---|---|
| U1 | **Which Workers plan this site is on.** `.openai/hosting.json` gives no plan. §0.2 puts the free CPU limit at **10 ms/request**; PBKDF2-SHA-256 at 100,000 iterations is well beyond that. | If free, the login **will fail** with a CPU exception at any defensible iteration count, and the whole §1.2 design must be rebuilt around a much lower work factor plus pure entropy. This is build-blocking. | Ask the control plane / OpenAI Sites owner. Then measure the actual CPU cost of the chosen KDF on a deployed preview before designing around it. |
| U2 | **Whether the platform's migration applier can apply a `CREATE TRIGGER`** with internal semicolons, i.e. whether it splits on `--> statement-breakpoint` or on `;`. | Decides whether append-only orders (F5, C4) become a database guarantee or stay a review rule. | `wrangler d1 execute --local` against a scratch DB, plus inspecting `dist/.openai/drizzle` after `npm run build`. No production access required. |
| U3 | **Whether CERT-In Direction (iv) binds this shop, and whether D1 satisfies "within the Indian jurisdiction".** ✅ s.43A's "body corporate" reaches a sole proprietorship; ✅ D1 has no India region. | Decides whether an India-hosted audit mirror is mandatory infrastructure. §7-3. | Counsel's opinion, or a written query to CERT-In. |
| U4 | **Whether the OpenAI Sites control plane exposes Cloudflare WAF rate-limiting or Access policies for this zone.** §5.3 flags the same uncertainty for Cloudflare Access. | A WAF rule in front of `/admin/login` is strictly better than any in-app throttle, and Access would be better than the password entirely. | Ask the control plane owner; or attempt to configure and observe. |
| U5 | **Whether `getChatGPTUser()`'s trusted `oai-authenticated-user-*` headers are stripped at the edge.** §5.2's open item, inherited. | If not stripped and SIWC is accepted anywhere on an admin path, the password is bypassable by a header. §1.6 closes it by refusing SIWC on admin paths, so this is only load-bearing if that rule is broken. | §5.2's test: `curl -H 'oai-authenticated-user-email: attacker@example.com' https://<site>/admin`. |
| U6 | **Whether Rule 8(3)'s one-year floor is general or carries the Third Schedule limitation forward.** Commentators split. | Does not change the build — Rule 6(1)(e) independently imposes a one-year log-and-data floor on every Data Fiduciary. Recorded so it is not re-litigated. | The gazette text of Rule 8 read alongside the Third and Seventh Schedules; the MeitY PDF 403s from this environment. |
| U7 | **⚠️ CGST s.36's 72-month record-retention period**, cited from secondary sources here. | Sets the outer retention bound for order and invoice records against which erasure is measured. | The CBIC primary text for s.36. |
| U8 | **⚠️ General Clauses Act 1897 s.3(35)** as the basis for reading Rule 4(5)'s "one month" as a calendar month. | Minor; affects `redress_due_at` arithmetic by up to two days. | The India Code text of s.3(35). |
| U9 | Inherited and still open: Legal Metrology/MRP (§4.4); BIS "certified sales outlets" online (§4.1); whether *"irrespective of the mode of payment"* survived Rule 114B → Rule 159 (§4.7), which decides whether PAN is needed on a ₹2.5 lakh UPI order at all. | The last one directly governs whether `orders.customer_pan` is ever populated — i.e. whether the most sensitive column in the database needs to exist. | §4's notes; counsel; the G.S.R. 198(E) gazette PDF. |

---

## 11. The single largest risk

**It is not the password. It is that one credential collapses three separations at once, and the audit log — the control that is supposed to catch that — is the thing the collapse breaks first.**

A single shared secret merges *authentication* (who is at the keyboard), *authorisation* (what they may do), and *attribution* (what the record says they did) into one artefact. The `admin_users` table anticipates three roles and the audit log has an `actor_email` column, but with one password every action is attributed to whichever row that password maps to — regardless of whether it was the owner, the owner's son, the counter assistant, or an attacker who bought the password in a credential dump. And that password protects, in one query, several thousand rows containing a name, a phone number, a residential address, a PAN, and the value of the jewellery delivered to that address.

That combination is what makes the failure mode so bad. The data is a burglary list and an identity-fraud kit at the same time. The breach obligations that follow are absolute — ✅ CERT-In within **six hours**, live today; ✅ DPDP s.8(6) to **every affected principal with no materiality threshold**, from 2027. And the one artefact that would let the shop scope that notification to eleven customers instead of all of them is a log whose actor field, under a shared credential, is **not true**. A false audit trail is worse than an absent one: it will be produced in evidence, and it will assert something the shop cannot stand behind.

Every control in §1 is worth building and together they make the panel defensible against the internet. None of them addresses this. The only things that do are outside the code: **a credential per person, and a second factor.** They should be asked for now, while the panel is a design rather than a deployment — the schema already has the seats for the first, and §5.4 has been waiting on the same answer since §5 was written.
