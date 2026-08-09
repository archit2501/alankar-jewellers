# 05 — Admin panel: interface design

**Scope.** The interface only. Authentication mechanics, session storage, route
protection, role enforcement and the compliance/retention questions are two other
agents' lanes; where this document touches them it is describing *what the owner
sees*, not how it is enforced. No application code is modified by this document.

**Status.** Design document. Nothing here is built.

---

## 0. The short version

The admin is the **back room of the shop**, not the shop floor and not a dashboard.
It uses the Haveli and Vitrine registers of the existing brand — plaster, teak, ink,
sindoor — and it **discards the Darbar register entirely**: no oxblood ground, no
cusped arches, no jali screens, no gold rules between rows. Ceremony is persuasion,
and persuasion aimed at the owner is noise.

Two rules carry the whole design:

1. **Nothing has fixed prominence. A thing grows only when it is wrong.** The gold
   rate is one quiet line until it goes stale, at which point it becomes the top of
   the screen. This is the antidote to the KPI-tile row, which gives four numbers
   permanent prominence regardless of whether any of them needs attention.
2. **Ornament marks the statutory.** The only ornament that survives into the admin
   is `.illuminated--brass` corner brackets, and they appear on exactly one thing:
   the price breakup, which is a BIS Reg. 5(11) document. Brackets mean "this is a
   record", not "this is pretty". Ornament that encodes something is the only
   ornament this interface can afford.

The single most consequential thing found while reading the code: **every order
opens a 48-hour clock.** `placeOrder()` writes a `support_tickets` row in the same
batch as the order, with `acknowledgeDueAt = placedAt + 48h`
(`app/_data/orders.ts:1596–1616`, `TICKET_ACKNOWLEDGE_HOURS = 48`). So the orders
list is not a list of orders. It is a list of statutory reply deadlines that happen
to have money attached. Everything downstream of that fact changes shape.

---

## 1. The central design question, answered

> Should the admin look like the shop, or should it look like a tool?

**Neither. It should look like the shop's back room.**

The temptation is to treat this as a binary and pick "tool" — which is what Part D
did, reaching for neutral chart surfaces and system UI sans. That answer *sounds*
rigorous ("a shop owner reading numbers at 11pm needs contrast, not atmosphere")
but it is the generic-admin-template answer wearing an argument. It fails one
specific test.

**The owner is not a stranger to this brand. They are the brand.** A back office
that looks like nothing in particular signals *this is IT software* — the category
of thing you phone your nephew about. A back office that is recognisably the same
house signals *this is my shop's book*. The failure mode named in the brief is
abandonment, not confusion, and visual estrangement is a real contributor to
abandonment in a way that a 4% contrast difference is not.

But the storefront's ornament is doing a job that has no analogue here. The cusped
arch, the jali band, the doubled gold rule and the generous vertical rhythm exist
to make a stranger feel that a ₹4 lakh bridal set is safe to buy from a website.
The owner already knows the set is safe. Aimed at them, that apparatus costs
vertical space, costs scanning speed, and — in the case of gold — is illegal on the
field the admin needs to use.

So the split is not *brand vs. tool*. It is **which register**:

| Register | Storefront | Admin | Why |
|---|---|---|---|
| **Darbar** — oxblood, gold, arches, generous gold rules | hero, the reverse, the invitation, the footer | **discarded**, except the sign-in card and the 48px header strip | Ceremony is a sales instrument. It has no addressee here. |
| **Haveli** — plaster ground, ink, sindoor accent, brass hairlines | the pieces, the craft, the house | **the whole admin** | It is already the reading register. Warm, high-contrast, legible, and it is where the storefront puts its own tabular data. |
| **Vitrine** — teak-deep, gold legal | the bench, inside the case | **dark mode, and the header strip** | 11pm needs a dark field, and this system already has one that is warm rather than a flat near-black. |

**Where the brand shows up:** the ground is plaster, not white — the page is warm and
grained, and it is unmistakably the same house. The type is Karma throughout. Money
and weight are set in IBM Plex Mono, as they are on the product pages. The header is
a teak-deep strip with the wordmark in gold-leaf. Sign-in is a single Vitrine card
where the display face and one doubled gold rule are allowed to appear once. The
statutory panel carries brass corner brackets.

**Where the brand gets out of the way:** no arch masks anything (they eat 32% of a
photograph's height for no informational gain). No jali veil sits behind any data
(the `_ornament.css` comment already forbids it behind text; a list of orders is
text). No `.rule-gold` divides rows — row separation is a 1px `--ink-3` hairline at
20%, which is the one hairline the storefront's own rule permits ("no hairline
appears anywhere except between two rows of tabular data", `globals.css:46`). Grain
drops from `--grain-opacity: 0.055` to `0.03`, because grain behind 13px mono is
texture on top of texture. Rozha One appears exactly once per session, on sign-in.

**Where it gets out of the way completely:** the print stylesheet. The bill of sale
prints black on white, no grain, no plaster, brackets reduced to 0.5pt rules. A
statutory document that arrives at an accountant's desk on a cream ground with a
noise overlay is a document that looks forged.

### The risk this takes

The risk is that plaster + grain + a serif body face is a *slower-reading* surface
than white + Inter, and I am spending some of that on identity. I think the trade is
right — Karma at `--t-md` on plaster measures 7.80:1 for `--ink-2` and 14.08:1 for
`--ink`, which is well past the floor, and the numbers are all mono anyway. But it
is a real trade and it is worth naming rather than pretending the two are equal.

---

## 2. The measured token contract

Every figure below was computed against the actual token values, not assumed.

### Light field (Haveli) — ground `--plaster #ede3d0`

| Token | Hex | Ratio | Allowed to be |
|---|---|---|---|
| `--ink` | #1c1611 | **14.08** | headings, names, amounts |
| `--ink-2` | #4f4034 | **7.80** | body, secondary lines |
| `--ink-3` | #7d6c5b | **3.96** | captions, mono order numbers, hairlines. **never body text** |
| `--sindoor` | #8c2f23 | **6.48** | the one accent: overdue markers, alert text, primary button fill |
| `--lapis` | #1f3a6e | **8.74** | legal as text; **not used** — see §12 |
| `--brass` | #a8802c | **2.85** | ornament only. corner brackets, rules. **never a letterform** |
| `--gold` | #c9a227 | **1.90** | **banned on this field.** not text, not a border, not a chart mark, not a dot |

### Dark field (Vitrine) — ground `--teak-deep #241409`

| Token | Hex | Ratio | Allowed to be |
|---|---|---|---|
| `--plaster` | #ede3d0 | **13.99** | body and headings |
| `--gold-leaf` | #e3c766 | **10.71** | the wordmark, headings |
| `--gold` | #c9a227 | **7.36** | labels, the focus ring |
| `--ink-3` | #7d6c5b | 3.54 | hairlines only |
| `--sindoor` | #8c2f23 | **2.16** | **fails on dark.** must not be used as the alert colour here |
| `--brass` | #a8802c | 4.91 | technically legal as text; **kept to ornament anyway**, so the house rule stays one rule with no exceptions |

### Two new tokens the admin needs

`--sindoor` fails on the dark field and there is no existing token that carries the
"something is wrong" job there. Likewise the single chart hue.

```css
/* admin only */
--sindoor-lift: #d0674f;  /* 4.86:1 on --teak-deep — the alert colour, dark field */
--lapis-lift:   #2f5591;  /* 5.83:1 on --plaster  — the one data hue, light field */
--lapis-glow:   #5b86c9;  /* 4.83:1 on --teak-deep — the one data hue, dark field */
```

Both pairs were run through the dataviz validator (§12). Both pass all six checks.

### Field variables for the admin surfaces

The admin declares its registers through the same `--field-*` contract as the
storefront, so buttons, links, labels and focus rings follow without any component
knowing which surface it is on.

```css
.admin            { --field: var(--plaster);      --field-ink: var(--ink-2);
                    --field-head: var(--ink);     --field-label: var(--sindoor);
                    --field-metal: var(--brass);  --field-focus: var(--oxblood-deep); }

.admin-bar        { --field: var(--teak-deep);    --field-ink: var(--plaster);
                    --field-head: var(--gold-leaf); --field-label: var(--gold);
                    --field-metal: var(--gold);   --field-focus: var(--gold-leaf); }

/* dark mode swaps .admin to the Vitrine values and lifts the two admin tokens */
```

Dark mode is a **selection**, not an inversion: it is the Vitrine register, declared
under both `@media (prefers-color-scheme: dark)` and a `[data-theme]` scope so a
manual toggle wins in both directions.

---

## 3. What is kept and discarded from Part D

Part D was written for the retired "Meena Reverse" direction. The structure is
mostly sound; the visual language is dead and one or two of the structural calls
were made without the schema in front of them.

### Kept, unchanged — these were right

- **"This is not a dashboard. The user works a queue."** The single best sentence in
  Part D. Everything in this document is downstream of it.
- **Single column, `max-width: 720px` even on desktop. No sidebar.** A sidebar is
  navigation for a system with more than seven destinations. This has five.
- **Counts are filter links in a sentence, never stat tiles.** "A stat tile you
  cannot click is a dead end."
- **The customer's name is the largest thing on a row; the order ID is muted mono.**
- **Call and WhatsApp live on the row**, not behind a tap-through.
- **Status is a word, never colour alone.**
- **"Making" is a real jeweller's state** and no generic e-commerce vocabulary has
  it. Naming states in the shop's words is most of what makes this feel built for
  the business.
- **`Intl.NumberFormat('en-IN')` with `tabular-nums` everywhere**; dates as
  "Today, 4:12 pm" / "Yesterday" / "14 Aug", never ISO.
- **Search matches phone number first.**
- **`Export today's orders` → CSV.**
- **Renders from cache with a "last read" line**; never a spinner over an empty
  screen.
- **Append-only note log** as the answer to "did I already call her?"
- **The Numbers tab is behind a deliberate tap** because nothing in it changes what
  the owner does in the next five minutes.
- **Gold is banned from charts, dots, borders and labels on the light field.** Part D
  measured 2.5:1 against its own surface; measured against plaster it is 1.90:1. The
  conclusion is the same and stronger.
- **Segmented status control, not a `<select>`.** A dropdown hides the state machine.

### Discarded

| Part D said | Replaced with | Why |
|---|---|---|
| Neutral chart surfaces `#FCFCFB` / `#1A1A19`, system UI sans | Plaster / teak-deep, Karma + IBM Plex Mono | §1. The neutral surface is the template answer, and it strands the owner in software that does not look like their shop. Contrast is not at risk: 14.08:1 and 13.99:1. |
| `--garnet #560f1b` as ink and primary button | `--sindoor #8c2f23` (6.48:1) as the light-field accent; `--oxblood-deep` as the focus ring | `--garnet` no longer exists. `--sindoor` is the declared light-field accent in the live system. |
| Nav: `Orders · Enquiries · Catalogue · Numbers` | `Today · Orders · Enquiries · Pieces`, with Numbers and Rate reached from Today | Part D's own argument — that Numbers is behind a deliberate tap — is inconsistent with giving it a permanent tab. And Part D has **no gold-rate screen at all**, which is one of the five questions the owner opens this to answer. |
| Orders list as the home screen | A **Today** screen that merges orders, enquiries and reply deadlines into one queue sorted by *deadline*, not recency | The owner's unit of work is a person, not an order. Two of the five stated questions ("who do I call back", "what did they say about the necklace") resolve to a person who may exist in `orders`, in `appointments`, or in `support_tickets`. A screen that shows only one of those tables answers neither question. |
| `New → Confirmed → Making → Ready → Delivered (+ Cancelled)` | The same vocabulary, extended to cover all eleven schema statuses and the payment truth (§5) | The six words do not cover `pending_payment`, `refunded` or `failed`, and with `PAYMENT_CAPTURE_ENABLED = false` **every order in the system today is `pending_payment`** — so the one state Part D's vocabulary omits is currently the only state that exists. |
| Row height ~96px | ~132px on phone | The 48-hour clock line and 48px tap targets do not fit in 96px. This list is short; density is not the constraint. |
| Order detail: rate line at position 4, on the page | Rate provenance **inside** the statutory panel | The rate is what makes the price defensible. It belongs in the document, not next to it. |
| "Top categories this month — horizontal ranked bars" | **Gold committed this month, by fineness, in grams** | Same form, better subject. See §12. |
| Order detail thumbnails that "tap to flip to reverse" | A plain 64px thumbnail | The flip is the storefront's signature. Reused here it is a novelty in a screen whose job is speed, and it costs JavaScript that this admin otherwise does not need. Chanel's rule: take one accessory off. |

### Missing from Part D, added here

- **Sign in** — not designed at all.
- **Gold rate: view the trail, correct a bad entry, see ingest staleness** — not
  designed at all, and it is the one screen where the schema's append-only rule has
  to be explained to a non-technical person in one sentence.
- **The 48-hour clock**, which changes the shape of the orders list.
- **The torn-order state.** `assertOrderIntact()` exists because D1 cannot roll back;
  an order whose `lineItemCount` does not match its rows **must not be invoiced**.
  That state needs a design or the code that detects it has nowhere to report to.
- **A catalogue form that a half-finished piece survives.**

---

## 4. Rules that hold across every screen

### Navigation

Four destinations in the bottom bar on phone, four text links under the wordmark on
desktop. Rate and Numbers are reached from Today.

```
Today · Orders · Enquiries · Pieces
```

`Enquiries` is the existing `appointments` table, which already carries
`new → contacted → booked/closed`. It is the cheapest surface to ship first and it
should be.

The bottom bar is 64px plus `env(safe-area-inset-bottom)`, teak-deep, with the
current item marked by a 2px gold-leaf rule above the label **and** `aria-current="page"`.

### No JavaScript, wherever practical

The storefront's cart and filters already work without it, and the admin has less
excuse than the storefront does. Every control below is a real form:

| Control | Mechanism |
|---|---|
| Search, filters, date range | `<form method="get">`, submitted by a real button |
| Status change, mark replied, add note, publish, correct rate | `<form method="post">` → 303 back to the page with `?notice=<code>` |
| Confirm before destructive/irreversible | a **second page**, not a modal |
| Chart table view | `<details><summary>` |
| Outcome messages | a closed set of notice codes rendered by exact match, exactly as `CHECKOUT_NOTICES` does — nothing from the query string is ever printed |

Three things genuinely want JavaScript and each degrades honestly:

- **Copy address** → without JS, a `readonly` `<textarea>` with the address already
  selected on focus.
- **Chart hover tooltips** → without JS, the table view is the answer, and the max
  bar is direct-labelled regardless.
- **Live price preview on the catalogue form** → without JS it is computed on save
  and shown on the confirmation step, which is where it matters most anyway.

Nothing that changes data depends on JavaScript.

### Writing

- Second person, present tense, plain verbs. "Ring her back", not "Initiate customer
  contact".
- A control keeps its name through the whole flow. The button says **Publish this
  piece**; the notice says **Published**.
- Errors say what happened and what to do. They never apologise and they are never
  vague.
- Statuses use the shop's words, and the shop's words appear in the same case
  everywhere.
- **No jargon, and specifically:** never "SKU" without the piece's name beside it,
  never "variant", never "fulfilment", never "webhook", never "quote expired",
  never "HUID" without "hallmark number" the first time it appears on a screen.

### The one naming decision that matters most

Every order writes a `support_tickets` row whose `kind` defaults to `"complaint"`.
**The admin must never show the word "complaint" for these.** An owner who opens the
app and sees "14 complaints" against 14 orders will close it and not come back. The
row is a reply obligation, so the interface calls it:

> **Reply due** — and, once answered, **Replied**.

The word "complaint" appears only where a ticket was genuinely raised by a customer
(`kind` is set to `complaint` by a human), and even then it is "Problem raised by
Priya Sharma", because that is what it is.

### Accessibility floor

- Body text ≥ 4.5:1 everywhere; `--ink-3` is capped at captions and mono metadata,
  which are all ≥ 3.96:1 and never carry unique information.
- Focus: `outline: 2px solid var(--field-focus); outline-offset: 2px` — the storefront's
  existing rule, inherited. Never removed, never `outline: none`.
- Real semantics: `<nav>`, `<main>`, one `<h1>` per screen, `<ol>` for the queue,
  `<table>` with `<th scope>` for figures, `<time datetime>` for every date, `<fieldset>`
  + `<legend>` for every radio group, `<label>` bound to every input. No `<div role="button">`.
- Every status carries a word. Colour is never the only channel; where a mark is
  coloured it also has a shape (a filled square) and a label.
- 48px minimum tap targets, 8px minimum between adjacent targets.
- `prefers-reduced-motion` respected; there is almost no motion to reduce.

---

## 5. Screen 1 — Sign in

One password field. No email, no username, no "remember me" checkbox that the owner
will not understand the consequences of.

### 390px

```
┌────────────────────────────────────────┐   .admin-bar register
│                                        │   --field: --teak-deep
│                                        │   grain at 0.03
│               अलंकार                    │   --font-deva, 40px, --gold-leaf
│                                        │
│        ALANKAR  JEWELLERS              │   Rozha One 20px, tracking .16em
│        ══════════════════              │   .rule-gold — the only one
│                                        │   in the whole admin
│        Shop sign-in                    │   Karma 600 18px, --plaster
│                                        │
│  Password                              │   Karma 500 15px, --gold
│  ┌──────────────────────────────────┐  │
│  │ ••••••••••                       │  │   56px tall, 18px text
│  └──────────────────────────────────┘  │   type=password
│                                        │   autocomplete=current-password
│                                        │   autofocus
│  ┌──────────────────────────────────┐  │
│  │            Sign in               │  │   56px, full width
│  └──────────────────────────────────┘  │   --gold fill, --oxblood-deep text
│                                        │
│  ────────────────────────────────────  │
│  If you cannot get in, ring the shop   │   Karma 400 15px, --plaster
│  line and ask for the current          │   at 80%
│  password. It is not emailed to        │
│  anyone.                               │
│                                        │
└────────────────────────────────────────┘
```

**Desktop:** identical card, centred, `max-width: 420px`. It does not widen. There is
nothing to put in the extra space and a 900px-wide sign-in card is the visual tell of
software nobody thought about.

### Information hierarchy

The wordmark is first because it answers "am I in the right place" before anything
else, and because it is the one moment the brand is allowed to be ceremonial. Then
the field. Then the button. The help text is last and is the only thing on the screen
that is not part of the transaction.

### Error state — and how it avoids being an oracle

**There is exactly one failure string on this screen.**

```
┌────────────────────────────────────────┐
│  ■ That password is not right.         │   ■ 10px --gold square
│    Try again.                          │   --gold-leaf text, 16px
│                                        │
│  Password                              │
│  ┌──────────────────────────────────┐  │   the field is empty and focused
│  │                                  │  │   aria-describedby → the message
│  └──────────────────────────────────┘  │
```

The interface guarantees, in design terms:

1. **One message, byte-identical, for every failure.** Wrong password, empty submit,
   throttled, expired session, session cookie missing, no admin configured at all —
   all render the same sixteen words. There is no second string to compare against.
2. **No field-level validation that differs from the failure.** No minimum length, no
   `pattern`, no "must contain a number" — those describe the secret. The only
   client-side constraint is `required`, which fires identically whether or not a
   password exists on the server.
3. **Throttling is silent.** After repeated failures the same message appears. It does
   **not** say "locked", does not say "try again in 15 minutes", and does not show a
   countdown — a message that appears only on the *wrong* path is an oracle, and a
   countdown that appears only after N attempts tells an attacker their attempts are
   being counted, which tells them the endpoint is real.
   *If* a lockout must ever be communicated (the timing agent's call), the design
   constraint is: it must be shown on the correct-password path too, or not at all.
4. **No "forgot password" link.** There is no email identity to send to, and a
   reset flow is an enumeration surface. The help text routes to a human instead.
5. **The password is never echoed**, never placed in a query string, never in the
   redirect target. The notice travels as `?notice=signin`, a single closed-set code,
   rendered by exact match.
6. **No progressive feedback.** No "checking…", no spinner that lasts longer on one
   path than the other. The form submits and a page comes back.
7. **The success and failure pages are the same page.** A failure is the sign-in page
   with a message; a success is a redirect to Today. Nothing about the page shape
   differs.

### Empty state

None. There is no state in which this screen has nothing to show.

### Signed out by expiry

The same screen, same single string. It does **not** say "your session expired",
because that message is only true when a valid session once existed, which is
information.

---

## 6. Screen 2 — Today (the landing screen)

> What does a shop owner see first at 11pm?

### What earns the top of the screen

The candidates are: today's takings, a count of new orders, the callback queue, and
the gold rate. Working through them:

- **Today's takings is a lie.** `PAYMENT_CAPTURE_ENABLED = false` and will stay false
  until the shop holds a BIS certificate. There is no figure this screen could print
  that any bank account contains. A revenue tile here would be the single most
  damaging thing in the interface, because the first time the owner compares it to
  reality they stop believing everything else.
- **A count of new orders is not an action.** And for the foreseeable future it is
  zero, twice a day, forever, which is how you teach someone to stop opening an app.
- **The gold rate matters enormously — but only when it is wrong.** When it is fine it
  is one line the owner glances at. When it is stale the storefront cannot price
  anything and the shop is silently shut. Those two states deserve wildly different
  amounts of screen.
- **The callback queue is the only thing here that is always an action.**

So the rule: **the top of the screen is whatever will be wrong tomorrow if it is not
seen tonight.** That is exactly two things — a 48-hour reply clock about to breach,
and a stale or missing gold rate. Everything else sorts below them.

And the corollary that shapes the whole admin: **nothing has fixed prominence.**

### 390px — the normal case

```
┌────────────────────────────────────────┐
│ अलंकार  ALANKAR              Sign out  │  48px, .admin-bar, gold-leaf
├────────────────────────────────────────┤
│ 916 gold  ₹73,240 / 10 g               │  --font-data 15px, --ink
│ IBJA, today 11:25 am           Rate →  │  13px --ink-3 · link --sindoor
├────────────────────────────────────────┤   1px --ink-3 @ 20%
│                                        │
│  Needs you                             │  Karma 600 20px, --ink
│                                        │
│  ■ Reply to Priya Sharma               │  ■ 10px --sindoor square
│    by 9:40 tomorrow morning            │  --sindoor 16px  (< 12h left)
│    ₹1,84,500 · AJ-2608-7QW2XF          │  --font-data 13px --ink-3
│    ┌──────────┐  ┌──────────────┐      │
│    │   Call   │  │   WhatsApp   │      │  48px, side by side
│    └──────────┘  └──────────────┘      │
│  ────────────────────────────────────  │
│    Reply to Rakesh Mehta               │  --ink 17px (no square:
│    by Sunday 4:12 pm                   │  36h left, not urgent yet)
│    ₹2,41,300 · AJ-2608-9MK4RT          │
│    ┌──────────┐  ┌──────────────┐      │
│    │   Call   │  │   WhatsApp   │      │
│    └──────────┘  └──────────────┘      │
│  ────────────────────────────────────  │
│    Anjali Rao asked about Polki        │
│    Wants Saturday evening              │
│    Enquiry, 6:20 pm today              │
│    ┌──────────┐  ┌──────────────┐      │
│    │   Call   │  │   WhatsApp   │      │
│    └──────────┘  └──────────────┘      │
│                                        │
│  ────────────────────────────────────  │
│  Today                                 │  Karma 600 20px
│                                        │
│  2 orders recorded, ₹4,25,800 worth.   │  Karma 400 17px --ink-2
│  No money has been taken — card and    │  measure capped at 42ch
│  UPI are not switched on yet.          │
│  3 enquiries. 1 reply is close to      │
│  its 48-hour deadline.                 │
│                                        │
│  Numbers →      Rate history →         │  --sindoor 16px links
│                                        │
│  Last read 11:04 pm                    │  --ink-3 13px
└────────────────────────────────────────┘
┌────────────────────────────────────────┐
│  Today  │  Orders  │Enquiries│ Pieces  │  64px + safe-area, teak-deep
└────────────────────────────────────────┘
```

### Information hierarchy

1. **The queue, sorted by deadline** — not by recency, not by value. A ₹40,000 order
   placed 47 hours ago outranks a ₹4 lakh order placed ten minutes ago, because one
   of them breaches a statutory deadline tonight.
2. Each item carries **a name, a deadline in words, the money, and two phone
   buttons.** Nothing else. The order number is present because the owner reads it
   out on the call, and it is the smallest thing on the row.
3. **One sentence about today**, in prose. Not tiles. It says the true thing about
   money in the same breath as the number, so the two can never be separated.
4. The two deliberate-tap links.
5. The "last read" line, so a cached render never masquerades as live.

The three sources are merged and **visually undifferentiated**, because the owner does
not care which table a person came from. The kind is stated in the second line
("Reply to…" / "asked about…") where it belongs — as context, not as a category
header.

### Empty state — and placeholder honesty

The honest empty state is not "You have no orders 🎉". It is a list of the specific
unfinished things that are the reason nothing is arriving:

```
┌────────────────────────────────────────┐
│  Needs you                             │
│                                        │
│  Nothing is waiting.                   │
│                                        │
│  ────────────────────────────────────  │
│  Before the shop can take orders       │
│                                        │
│  · The website has no phone number or  │
│    address yet. It says so on the      │
│    page rather than inventing them.    │
│                             Fill in →  │
│                                        │
│  · There are no pieces in the          │
│    catalogue.                          │
│                     Add the first →    │
│                                        │
│  · No gold rate has been recorded, so  │
│    nothing can show a price.           │
│                    Enter a rate →      │
│                                        │
│  · Card and UPI are switched off until │
│    the shop holds a BIS certificate.   │
│    Orders can still be recorded and    │
│    settled at the counter.             │
│                                        │
└────────────────────────────────────────┘
```

Each bullet is driven by real state: `SITE_DETAILS_PENDING`, a count of `products`,
a `readCurrentRate()` miss, and `PAYMENT_CAPTURE_ENABLED`. As each is resolved the
bullet disappears. When all four are gone the block never renders again.

**This is the most important screen in the document**, and §13 explains why.

### The stale-rate state — the prominence rule in action

The rate strip stops being a strip and becomes the top of the screen:

```
┌────────────────────────────────────────┐
│  ■ The gold rate is out of date        │  --sindoor, Karma 600 20px
│                                        │
│    The last good 916 rate is from      │  --ink 17px
│    yesterday, 3:25 pm.                 │
│                                        │
│    While it is out of date the         │
│    website cannot price anything.      │
│    Every piece shows "price on         │
│    request" and nobody can check out.  │
│    That is deliberate — a wrong price  │
│    is worse than no price.             │
│                                        │
│    ┌──────────────────────────────┐    │
│    │   Enter today's rate         │    │  48px, --sindoor fill,
│    └──────────────────────────────┘    │  --plaster text (6.48:1)
│                                        │
│    The automatic check has failed 3    │  --ink-2 15px
│    times since yesterday 7:25 am.      │
└────────────────────────────────────────┘
```

Note what the copy does: it names the **consequence to the business** before it names
the technical fact. "The website cannot price anything" is what a non-technical
person needs; "rate_stale" is what a log needs.

### Error state

```
│  Could not read the shop's records     │
│  just now.                             │
│                                        │
│  Nothing is lost. This is what was     │
│  showing at 11:04 pm.                  │
│                                        │
│  ┌──────────────────────┐              │
│  │   Try again          │              │
│  └──────────────────────┘              │
```

The cached content renders underneath, dimmed to 70%, with the stale timestamp. A
spinner over an empty screen reads as "the site is down" — Part D's point, kept.

### Desktop

Same single column at `max-width: 720px`, centred. The bottom bar becomes four text
links under the wordmark. The two phone buttons per row become one `Call` button plus
the number as selectable text, because a desktop `tel:` link usually does nothing
useful and a number you can copy does.

---

## 7. Screen 3 — Orders

### The shape-changing fact

Every order carries a 48-hour reply clock from the moment it is placed
(`app/_data/orders.ts:1596`). So the primary sort is **deadline**, and the primary
filter set is about deadlines, not about fulfilment.

### 390px

```
┌────────────────────────────────────────┐
│ अलंकार  ALANKAR              Sign out  │
├────────────────────────────────────────┤
│ Orders                                 │  Karma 600 24px --ink
│                                        │
│ ┌────────────────────────────────┐ ┌─┐ │
│ │ Phone number, name or order no.│ │→│ │  <form method="get">
│ └────────────────────────────────┘ └─┘ │  48px, type=search
│                                        │
│ 2 replies overdue · 3 to reply ·       │  each phrase a link, --sindoor
│ 2 to make · 1 ready to collect ·       │  17px, wraps naturally
│ All 14                                 │  current filter is --ink 600
├────────────────────────────────────────┤
│ ■ Priya Sharma            ₹1,84,500    │  name Karma 600 18px --ink
│   Polki necklace and 1 more            │  amount --font-data 18px
│   AJ-2608-7QW2XF · 4:12 pm today       │  --font-data 13px --ink-3
│   Reply overdue by 3 hours             │  --sindoor 15px 600
│   ┌──────────┐  ┌──────────────┐       │
│   │   Call   │  │   WhatsApp   │       │  48px
│   └──────────┘  └──────────────┘       │
├────────────────────────────────────────┤  1px --ink-3 @ 20%
│   Rakesh Mehta            ₹2,41,300    │
│   Jadau set                            │
│   AJ-2608-9MK4RT · 11:40 am today      │
│   Reply by 11:40 am Sunday             │  --ink-2 15px (not urgent)
│   Making                               │  --ink 15px 600
│   ┌──────────┐  ┌──────────────┐       │
│   │   Call   │  │   WhatsApp   │       │
│   └──────────┘  └──────────────┘       │
├────────────────────────────────────────┤
│              Export today's orders     │  --sindoor link, → CSV
└────────────────────────────────────────┘
```

Row height ≈ 132px. The whole card is a link to the detail page; the two buttons
`stopPropagation`-equivalent by being real `<a href="tel:">` / `<a href="https://wa.me/…">`
siblings rather than nested inside the card link (nested interactive elements are
invalid HTML and break keyboard order).

### What a row must show, and why

| Element | Type | Reason |
|---|---|---|
| Customer name | Karma 600 18px `--ink` | The owner recognises people. This is the largest thing on the row. |
| Amount | `--font-data` 18px tabular, right-aligned `--ink` | Right edge alignment means the column can be scanned as a column without a table. |
| What it is | Karma 400 16px `--ink-2` | "Polki necklace and 1 more" — the piece, not the item count. |
| Order number + time | `--font-data` 13px `--ink-3` | Read out on the call. Smallest thing on the row. |
| **Reply deadline** | 15px, `--sindoor` when < 12h or breached, `--ink-2` otherwise | The statutory clock. This is the row's real subject. |
| Fulfilment state | 15px 600 `--ink` | Omitted entirely when the state is the default (`Not settled`), because printing the same word on every row teaches nothing. |
| Call / WhatsApp | 48px | Follow-up happens by phone. |

**Colour appears on a row only when something is late.** Everything else is
typography and position. This is what keeps the list scannable: the eye is looking
for the one red square, and there is nothing else competing for that job.

### Status vocabulary — the full map

| Schema `status` | Shown as | Note |
|---|---|---|
| `pending_payment` | **Not settled** | The only state that exists today. Never "Unpaid" — that implies they owe and did not pay. |
| `advance_paid` | Advance taken | |
| `paid` | Paid | |
| `confirmed` | Confirmed | |
| `in_production` | **Making** | Part D's word. Kept. |
| `ready_for_pickup` | Ready to collect | |
| `shipped` | Sent | |
| `delivered` | Delivered | |
| `cancelled` | Cancelled | |
| `refunded` | Refunded | |
| `failed` | Did not go through | Never "Failed", which reads as the shop's fault. |

Payment standing is drawn from `paymentStanding()` so the admin and the customer's
own order page can never say different things about money.

### Empty state

```
│  No orders yet.                        │
│                                        │
│  When someone buys through the         │
│  website their order lands here, and   │
│  a 48-hour clock to reply to them      │
│  starts at the same moment. You will   │
│  see the deadline on the row.          │
```

The empty screen teaches the one mechanic the owner needs to understand before the
first order arrives. It does not promise that orders are coming.

### Error state — the torn order

`assertOrderIntact()` exists because D1 cannot roll back a partial write. When
`lineItemCount` does not match the actual rows, the order **must not be invoiced**,
and that has to reach a human:

```
│ ■ AJ-2608-7QW2XF did not save fully    │  --sindoor
│   Priya Sharma · 4:12 pm today         │
│                                        │
│   Part of this order is missing, so    │
│   its bill would be wrong. Do not      │
│   invoice it and do not take money     │
│   for it. Nothing has been charged.    │
│                                        │
│   Ring the customer and take the       │
│   order again.                         │
│   ┌──────────┐  ┌──────────────┐       │
│   │   Call   │  │   WhatsApp   │       │
│   └──────────┘  └──────────────┘       │
```

The row is not tappable through to a bill. There is no disabled "Print" button —
there is no button, because a disabled control invites a retry.

### Search

One field, one form, `method="get"`. If the query is four or more digits it is
matched against `contact_phone` first (normalised with the same `normalisePhone()`
the appointments route uses), then order number, then name. The placeholder names all
three in the owner's order of preference: **"Phone number, name or order no."**

No autocomplete dropdown. It needs JavaScript, it obscures the list underneath, and
on a phone it fights the keyboard.

### Desktop

Rows become a two-column grid inside the same 720px: name/description/order-no on the
left, amount/deadline/state right-aligned. Buttons collapse to one `Call` plus the
number as text. Row height drops to ~88px.

---

## 8. Screen 4 — Order detail

Two documents live here and they must not be confused:

- **the working page** — who to ring, what state it is in, what was said;
- **the bill** — a BIS Reg. 5(11) and GST record that has to read as one document,
  print as one document, and reconstruct to the paise in 2031.

Part D interleaved them. This design separates them: the working page is the screen,
and the bill is a single bracketed panel that begins at a rule, contains no
interactive control, and is the only thing `@media print` emits.

### 390px

```
┌────────────────────────────────────────┐
│ ← Orders                               │  48px back, --sindoor
├────────────────────────────────────────┤
│ Priya Sharma                           │  Karma 600 24px --ink
│ +91 98765 43210                        │  --font-data 17px --ink-2
│ ┌──────────────┐  ┌──────────────────┐ │
│ │     Call     │  │    WhatsApp      │ │  56px — the first two
│ └──────────────┘  └──────────────────┘ │  tappable things on the page
│                                        │
│ AJ-2608-7QW2XF                         │  --font-data 15px --ink-3
│ Placed 4:12 pm today                   │
│ Not settled · no money has been taken  │  --ink-2 16px
│                                        │
│ ■ Reply overdue by 3 hours             │  --sindoor 17px 600
│   The deadline was 9:40 am today.      │  --ink-2 15px
│                                        │
├────────────────────────────────────────┤
│ WHAT TO DO NOW                          │  label: Karma 500 13px
│                                        │  --sindoor, tracking .16em
│ ┌────────────────────────────────────┐ │
│ │      Mark that you have replied    │ │  56px, --sindoor fill
│ └────────────────────────────────────┘ │  closes the 48-hour clock
│                                        │
│ Then, as the piece moves:              │  --ink-2 15px
│ ┌──────┬──────┬───────┬──────┬───────┐ │  segmented, POST form
│ │Confi-│Making│Ready  │ Sent │Deliv- │ │  current = --ink fill,
│ │ rmed │      │to     │      │ ered  │ │  --plaster text
│ └──────┴──────┴───────┴──────┴───────┘ │  48px tall, 5 across at 390
│                                        │  = 70px each. Tight but legal.
│ Cancel this order                      │  --sindoor text link, not a
│                                        │  button — it goes to a page
├────────────────────────────────────────┤
│ WHERE IT GOES                           │
│ Priya Sharma                           │
│ 12 Nehru Bazar, Johari Bazar Road      │  --ink 16px
│ Jaipur, Rajasthan 302003               │
│ ┌──────────────────┐                   │
│ │  Copy address    │                   │  48px
│ └──────────────────┘                   │
│                                        │
│ ╔══════════════════════════════════════╗  ← .illuminated--brass
│ ║ BILL OF SALE                         ║  brackets, top-left and
│ ║ Alankar Jewellers                    ║  bottom-right only.
│ ║ GSTIN —— not yet issued              ║  ground: --plaster-lift
│ ║ AJ-2608-7QW2XF · 8 August 2026       ║
│ ║ ──────────────────────────────────── ║
│ ║ 1. Polki necklace                    ║  Karma 600 17px
│ ║    AJ-PN-0031 · HSN 7113             ║  --font-data 13px --ink-3
│ ║                                      ║
│ ║    Gold, 22K (916 fineness)          ║  --ink-2 15px
│ ║    Net metal weight      18.400 g    ║  --font-data, tabular,
│ ║    Gross weight          24.100 g    ║  right-aligned
│ ║    Hallmark number       —           ║
│ ║      Polki is exempt from            ║  --ink-2 14px — NOT blank
│ ║      hallmarking (QCO cl. 2(3))      ║
│ ║    ────────────────────────────────  ║
│ ║    Gold 916, ₹73,240 per 10 g        ║
│ ║      × 18.400 g          ₹1,34,762   ║
│ ║    Making, 12% of gold      ₹16,171  ║
│ ║    Stones                   ₹22,400  ║
│ ║    Hallmarking                   ₹0  ║
│ ║    ────────────────────────────────  ║
│ ║    Piece total           ₹1,73,333   ║
│ ║    GST at 3%                ₹5,200   ║
│ ║    Line total            ₹1,78,533   ║
│ ║                                      ║
│ ║ ──────────────────────────────────── ║
│ ║ Taxable value            ₹1,73,333   ║
│ ║ CGST 1.5%                   ₹2,600   ║
│ ║ SGST 1.5%                   ₹2,600   ║
│ ║ ──────────────────────────────────── ║
│ ║ TOTAL                    ₹1,78,533   ║  Karma 600 19px
│ ║ Paid                            ₹0   ║
│ ║ Balance due              ₹1,78,533   ║
│ ║                                      ║
│ ║ Rate used: 916 gold, ₹73,240 per     ║  --font-data 13px --ink-2
│ ║ 10 grams, in force from 8 Aug        ║
│ ║ 11:25 am, read at 4:11 pm. Source    ║
│ ║ IBJA.                                ║
│ ║ Complaint reference AJ-C-2608-K3M9P  ║
│ ╚══════════════════════════════════════╝
│ ┌──────────────────┐                   │
│ │  Print this bill │                   │  outside the brackets
│ └──────────────────┘                   │
│                                        │
├────────────────────────────────────────┤
│ NOTES                                   │
│ 8 Aug 4:40 pm — Rang her, no answer.   │  --ink 16px
│ 8 Aug 4:12 pm — Order recorded.        │
│ ┌────────────────────────────────────┐ │
│ │ Add a note…                        │ │  textarea, 3 rows
│ └────────────────────────────────────┘ │
│ ┌──────────────────┐                   │
│ │    Save note     │                   │
│ └──────────────────┘                   │
│                                        │
│ ────────────────────────────────────── │
│ This order cannot be deleted or         │  --ink-2 15px
│ edited. It is a GST and hallmarking     │
│ record and the shop must keep it for    │
│ five years.                             │
└────────────────────────────────────────┘
```

### Information hierarchy, and the changes from Part D

1. **Person and phone, above everything.** Kept from Part D and reinforced: the two
   buttons are 56px, not 48px, because they are the most-pressed controls in the
   whole admin.
2. **The clock, immediately after.** New. It is the only thing on the page that has
   a deadline attached to it.
3. **Actions, grouped under one label**, with the clock-closing action separated from
   the fulfilment rail — they are different kinds of act (one answers a legal
   obligation, one records physical progress) and merging them into one control would
   let the owner accidentally satisfy a statutory deadline by marking a piece
   "Making".
4. **Address with Copy**, kept from Part D verbatim — one button saves a
   transcription error on every order.
5. **The bill.** Everything statutory, in one bracketed block, in reading order, with
   no control inside it.
6. **Notes, append-only.**
7. **The sentence explaining why there is no Delete.**

### Why the rate provenance moved inside the bill

Part D put it on the page at position 4. It belongs in the document. The line
`Gold 916, ₹73,240 per 10 g, in force from 8 Aug 11:25 am, read at 4:11 pm` is what
makes the price defensible when the customer argues on the phone, and it is what
Reg. 5(11) reconstruction depends on. A number that justifies the invoice must print
with the invoice.

Both `goldRateId` and the denormalised value exist in `order_items` for exactly this
reason; the interface renders the denormalised value and never recomputes.

### The HUID rule

`variants.huid` is nullable **on purpose** — Kundan, Polki and Jadau are exempt, and
those are this shop's flagship categories. The schema comment is explicit that the UI
must not render a missing HUID as an omission. So the bill never shows a blank; it
shows the em dash **and the reason**:

- exempt → `— Polki is exempt from hallmarking (QCO cl. 2(3))`
- genuinely not yet entered → `— not recorded` **and the piece cannot be published**
  (see §9), so this string should never reach a bill.

### GST split

CGST+SGST or IGST, never both. Render whichever is non-zero and **omit the other rows
entirely** — a printed `IGST ₹0` on an intra-state bill is a line an accountant has to
stop and think about.

### Actions that exist

| Action | Mechanism | Note |
|---|---|---|
| Call / WhatsApp | `tel:` / `wa.me` deep link with the order number pre-filled | |
| Mark replied | POST | writes `acknowledgedAt`, stops the clock |
| Change fulfilment state | POST, segmented control | writes `status` |
| Add a note | POST | append-only; existing notes are never editable |
| Copy address | JS, with a `readonly textarea` fallback | |
| Print the bill | `window.print()`, or the browser's own print | |
| Cancel | full-page confirm, then POST | writes `status = 'cancelled'` |
| **Delete** | **does not exist** | |

### Why the absence of Delete is stated on screen

The owner will look for it. A control that is simply absent, with no explanation,
reads as a missing feature and is exactly the kind of thing that produces a phone
call to the nephew. One sentence converts a limitation into a reason to trust the
tool: *"This order cannot be deleted or edited. It is a GST and hallmarking record
and the shop must keep it for five years."*

### Cancel — a page, not a modal

```
┌────────────────────────────────────────┐
│ ← Back to the order                    │
│                                        │
│ Cancel Priya Sharma's order?           │  Karma 600 24px
│                                        │
│ AJ-2608-7QW2XF · ₹1,78,533             │
│                                        │
│ This marks the order cancelled and      │
│ puts the piece back on the website.     │
│ The order itself stays in the records   │
│ — it cannot be removed. Nothing has     │
│ been charged, so there is nothing to    │
│ refund.                                 │
│                                        │
│ Why?                                    │
│ ( ) Customer changed their mind         │
│ ( ) Piece is no longer available        │
│ ( ) Order was a mistake                 │
│ ( ) Something else  [             ]     │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │  Yes, cancel AJ-2608-7QW2XF        │ │  --sindoor fill
│ └────────────────────────────────────┘ │
│                                        │
│ Keep the order                          │  text link
└────────────────────────────────────────┘
```

The confirm button repeats the order number, so a mis-tap from a list cannot cancel
the wrong order. The reason is required and goes into the note log.

### Print stylesheet

```
@media print {
  header, nav, .admin-actions, .admin-notes, button, a[href^="tel"] { display: none }
  .bill { background: #fff; color: #000; }
  .grained::after { display: none }
  .bill.illuminated::before, .bill.illuminated::after { border-color: #000; border-width: 0.5pt }
  body { font-size: 11pt }
}
```

A4, one page for a single-line order. The brackets survive as hairlines because they
are the document's own frame; everything warm is dropped.

### Empty and error states

There is no empty state — an order always has content. The error state is the torn
order, and on the detail page it **replaces the bill panel entirely**:

```
│ ╔══════════════════════════════════════╗
│ ║ ■ This order did not save fully      ║
│ ║                                      ║
│ ║ It says it has 2 pieces but only 1   ║
│ ║ was recorded. A bill made from this  ║
│ ║ would be wrong, so none is shown.    ║
│ ║                                      ║
│ ║ Ring Priya and take the order again. ║
│ ║ Nothing has been charged.            ║
│ ╚══════════════════════════════════════╝
```

There is no Print button on this page at all.

### Desktop

At ≥ 900px the working page and the bill sit side by side inside 720px + a 360px
column? **No.** They stay stacked in one 720px column. Splitting them puts the bill
in a narrow gutter where its tabular figures wrap, and the whole reason the bill is a
bracketed block is that it reads as one continuous document. The desktop gains
larger type and a wider `measure`, nothing else.

---

## 9. Screen 5 — Pieces (catalogue)

The hardest screen. Long, error-prone, used rarely, by someone who is not a
data-entry clerk, and a mistake here is a mis-priced piece rather than a typo.

### The core decision: there is no long form

A piece is **created in one step and completed in many.** The creation step asks for
exactly what is needed for a `draft` row to exist — a name and a craft. Everything
else is added afterwards on the piece's own page, in named sections, each of which is
its own small form that saves on its own.

Three reasons:

1. **Without JavaScript, a rejected long form loses everything.** The checkout already
   pays this cost deliberately (`app/_data/orders.ts` — "a rejected form loses its
   values, which is a real cost paid deliberately"). For a 20-field jewellery form
   that cost is abandonment on the first mistake.
2. **`variants_pricing_inputs_ck` refuses a `dynamic_metal` variant without weight and
   fineness.** A single form that asks for pricing mode and weight at the same time
   can be filled in an order that the database will not accept, and the owner has no
   way to know which of eight fields caused it.
3. **A half-finished piece is the normal case.** The owner will start a piece at the
   counter, get interrupted by a customer, and come back at 11pm. `status = 'draft'`
   is already the schema default. The interface should make that the *expected* path,
   not the failure path.

### The list

```
┌────────────────────────────────────────┐
│ Pieces                                 │
│ ┌────────────────────────────────────┐ │
│ │        Add a piece                 │ │  56px, --sindoor fill
│ └────────────────────────────────────┘ │
│                                        │
│ Not finished — not on the website (2)  │  Karma 600 18px
│ ┌────────────────────────────────────┐ │
│ │ Polki necklace                     │ │
│ │ Started 3 days ago                 │ │  --ink-3 14px
│ │ Still needs: weight, hallmark      │ │  --sindoor 15px
│ └────────────────────────────────────┘ │
│ ┌────────────────────────────────────┐ │
│ │ Untitled                           │ │  --ink-3 when no title
│ │ Started today                      │ │
│ │ Still needs: a name, a photograph, │ │
│ │ weight, price, hallmark            │ │
│ └────────────────────────────────────┘ │
│                                        │
│ On the website (0)                     │
│ Nothing is published yet.              │  --ink-2
│                                        │
│ Put away (0)                           │  = archived
└────────────────────────────────────────┘
```

"Still needs:" on every draft row is the whole safety mechanism made visible from the
list. The owner never has to open a draft to find out what is missing.

### Add a piece — step one only

```
┌────────────────────────────────────────┐
│ ← Pieces                               │
│ Add a piece                            │
│                                        │
│ What is it?                            │
│ ┌────────────────────────────────────┐ │
│ │ Polki necklace                     │ │  56px, required
│ └────────────────────────────────────┘ │
│ The name a customer will see.           │  --ink-3 14px
│                                        │
│ What kind?                             │  <fieldset><legend>
│ ┌────────┐┌────────┐┌────────┐         │
│ │ Jadau  ││ Polki  ││ Kundan │         │  48px radio pills
│ └────────┘└────────┘└────────┘         │  selected = --ink fill
│ ┌────────┐┌────────┐┌────────┐         │
│ │  Gold  ││Diamond ││ Other  │         │
│ └────────┘└────────┘└────────┘         │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │      Start this piece              │ │  56px
│ └────────────────────────────────────┘ │
│                                        │
│ It saves straight away as a draft.      │  --ink-2 15px
│ Nothing goes on the website until you   │
│ publish it, and you can leave and come  │
│ back to it whenever you like.           │
└────────────────────────────────────────┘
```

Two fields. That is the entire barrier to starting.

### The piece page — a checklist, not a form

```
┌────────────────────────────────────────┐
│ ← Pieces                               │
│ Polki necklace                Draft    │  Karma 600 24px / 15px badge
│ This is not on the website.            │  --ink-2 16px
│                                        │
│ ┌────────────────────────────────────┐ │
│ │ Before you can publish             │ │  panel, --plaster-sunk
│ │ ✓ A name and a kind                │ │  ✓ = --ink 600
│ │ ✓ At least one photograph          │ │
│ │ ✓ A description of every photo     │ │
│ │ · Weight and purity        Add →   │ │  · = --sindoor, Add is a link
│ │ · How it is priced        Add →    │ │
│ │ · Hallmark number or the reason    │ │
│ │   there isn't one         Add →    │ │
│ └────────────────────────────────────┘ │
│                                        │
│ PHOTOGRAPHS (3)          Add a photo → │
│ ┌────┐┌────┐┌────┐                     │  96px thumbs, drag order
│ │    ││    ││    │                     │  (no-JS: ↑ ↓ buttons)
│ └────┘└────┘└────┘                     │
│                                        │
│ WEIGHT AND PURITY              Add →   │
│ Not entered yet.                       │  --ink-2
│                                        │
│ PRICE                          Edit →  │
│ Price on request                       │  the safe default
│ The website will show "price on         │  --ink-2 15px
│ request" and invite an enquiry.         │
│                                        │
│ HALLMARK AND CERTIFICATE       Add →   │
│ Not entered yet.                       │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │      Publish this piece            │ │  disabled — and beneath it,
│ └────────────────────────────────────┘ │  in words, what is missing
│ Three things are still missing. They    │  --ink-2 15px
│ are ticked off in the list above.       │
│                                        │
│ Put this piece away                    │  → archived, text link
└────────────────────────────────────────┘
```

**The disabled Publish button is never bare.** A disabled control with no explanation
is the second-most-common reason a non-technical user gives up (the first is an error
message that names a field they cannot see). The checklist above it and the sentence
below it both name what is missing.

### Weight and purity — the highest-risk section

```
┌────────────────────────────────────────┐
│ ← Polki necklace                       │
│ Weight and purity                      │
│                                        │
│ Net metal weight                       │  Karma 500 16px
│ ┌──────────────────┐                   │
│ │ 18.400           │  grams            │  56px, inputmode=decimal
│ └──────────────────┘                   │  step=0.001, max=5000
│ Just the gold, without the stones.      │  --ink-2 15px
│ Type it the way you weigh it —          │
│ 18.4 and 18.400 both work.              │
│                                        │
│ Gross weight                           │
│ ┌──────────────────┐                   │
│ │ 24.100           │  grams            │
│ └──────────────────┘                   │
│ The whole piece, stones included.       │
│ This is shown to the customer but it    │
│ is never used to work out the price.    │
│                                        │
│ Purity                                 │  <fieldset>
│ ┌──────┐┌──────┐┌──────┐┌──────┐       │
│ │ 24K  ││ 995  ││ 22K  ││ 18K  │       │  48px pills.
│ │ 999  ││      ││ 916  ││ 750  │       │  Both labels on every pill,
│ └──────┘└──────┘└──────┘└──────┘       │  because Reg. 5(11) needs
│ ┌──────┐                               │  carat AND fineness, and 995
│ │ 14K  │                               │  has no carat at all.
│ │ 585  │                               │
│ └──────┘                               │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │       Save                         │ │
│ └────────────────────────────────────┘ │
└────────────────────────────────────────┘
```

The purity control shows **both** the carat label and the fineness on every pill, and
995 shows only "995" — because it has no carat equivalent and rounding it to 24K
mis-prices every 995 piece by ~0.4% forever. The schema comment says exactly this; the
interface is where it becomes visible.

### The echo confirmation — the ten-times guard

A factor-of-ten weight error is invisible in a number field and catastrophic
downstream. So saving a weight passes through one confirmation that states the figure
**in words and in money**:

```
┌────────────────────────────────────────┐
│ Save 18.400 grams?                     │  Karma 600 22px
│                                        │
│ That is eighteen grams and four         │  --ink 17px
│ hundred milligrams.                     │
│                                        │
│ At today's 916 rate that is             │
│ ₹1,34,762 of gold in this piece.        │  --font-data 20px --ink
│                                        │
│ ┌────────────────────────────────────┐ │
│ │       Yes, save it                 │ │
│ └────────────────────────────────────┘ │
│ Go back and change it                   │  text link
└────────────────────────────────────────┘
```

`184.00 g` produces "one hundred and eighty-four grams" and "₹13,47,620 of gold",
which is unmissable. This is the one place in the admin worth spending an extra tap.

If no rate is available the money line is replaced by *"There is no gold rate
recorded yet, so this cannot be shown in rupees."* — never a zero, never a guess.

### Price — three meanings, three inputs

`variants.makingChargeValue` is a single integer meaning paise-per-gram, or basis
points, or paise, depending on `makingChargeType`. That is the most confusable field
in the schema. The interface never exposes a field called "value":

```
│ How is this piece priced?              │
│ (•) By weight, at the day's gold rate  │
│ ( ) A fixed price                      │
│ ( ) Price on request                   │  ← the default
│                                        │
│ ── shown only for "By weight" ──       │
│                                        │
│ How is the making charge worked out?   │
│ (•) A percentage of the gold value     │
│     ┌──────┐                           │
│     │ 12   │  %                        │
│     └──────┘                           │
│ ( ) So much for each gram              │
│     ┌──────┐                           │
│     │      │  ₹ per gram               │
│     └──────┘                           │
│ ( ) One flat amount                    │
│     ┌──────┐                           │
│     │      │  ₹                        │
│     └──────┘                           │
│                                        │
│ Stones                                 │
│ ┌──────────┐  ₹                        │
│ │ 22,400   │                           │
│ └──────────┘                           │
│                                        │
│ Hallmarking charge                     │
│ (•) ₹45, the BIS charge for gold        │
│ ( ) ₹0 — this piece is exempt          │
│     Kundan, Polki and Jadau do not      │
│     have to be hallmarked.              │
│ ( ) Something else  ┌──────┐ ₹          │
│                     └──────┘            │
```

Each radio reveals only its own input; the other two are `disabled` so a no-JS
browser cannot submit a value against an unselected mode. Selecting **Price on
request** hides all of it — and that mode is always writable, which is what makes the
database constraint a sequence the owner can follow rather than a wall they hit.

Under it, the live consequence:

```
│ At today's rate this piece would show   │
│ on the website as ₹1,78,533, including  │
│ GST.                                    │
│                                        │
│ Gold 916 × 18.400 g       ₹1,34,762    │  --font-data, tabular
│ Making, 12%                 ₹16,171    │
│ Stones                      ₹22,400    │
│ Hallmarking                      ₹0    │
│ GST at 3%                    ₹5,200    │
│ ──────────────────────────────────────  │
│ ₹1,78,533                              │
```

This preview is the most valuable element on the screen, because it is where a wrong
weight, a wrong making mode or a wrong purity becomes obvious. Without JavaScript it
appears on the save confirmation instead.

### Photographs

Alt text is **required at upload**, and the field is not called alt text:

```
│ Describe this photograph for someone    │
│ who cannot see it                       │
│ ┌────────────────────────────────────┐ │
│ │ A Polki necklace with seven         │ │
│ │ uncut diamond pendants…             │ │
│ └────────────────────────────────────┘ │
```

`product_media.contentType` is required by the schema and its absence fails quietly
in the image pipeline, so the upload control accepts a fixed list of types and says
so: *"JPEG, PNG or WebP."* A rejected file names the file and the reason.

### Empty state

```
│ No pieces yet.                          │
│                                        │
│ The catalogue is empty, and the         │
│ website says so rather than showing     │
│ pictures that aren't of anything.       │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │       Add the first piece          │ │
│ └────────────────────────────────────┘ │
```

### Error state

A rejected save re-renders **that one section** with the typed value still in the
field — safe here, unlike checkout, because none of these are PII. The message names
the field and the fix in the owner's terms:

- *"Purity has to be one of 999, 995, 916, 750 or 585. 22K is 916."*
- *"A piece priced by weight needs both a weight and a purity. Add them, or set it to
  price on request for now."*
- *"A one-of-a-kind piece can only have one in stock."* (the
  `variants_unique_piece_stock_ck` constraint, in shop English)

### Desktop

The checklist moves to a sticky column on the right at ≥ 1000px; the sections stay in
the 720px column. That is the one place a second column earns itself, because the
checklist is a persistent reference rather than content.

---

## 10. Screen 6 — Gold rate

Five of the owner's questions, one of them is "today's rate went in wrong, fix it" —
and the schema says rates are **append-only**: never `UPDATE`, close the old row and
insert a new one, both in one batch.

So this screen must do something unusual: it must offer a **correction** without ever
offering an **edit**, and it must explain why in one sentence a non-technical person
accepts.

### 390px — the normal case

```
┌────────────────────────────────────────┐
│ ← Today                                │
│ Gold rate                              │
│                                        │
│ ┌────────────────────────────────────┐ │  --plaster-lift panel
│ │ In use now                         │ │  Karma 500 13px --sindoor
│ │                                    │ │  tracking .16em
│ │ 916   ₹73,240  per 10 g            │ │  --font-data 28px --ink
│ │                                    │ │
│ │ From IBJA, in force since today    │ │  --ink-2 15px
│ │ 11:25 am. Read 4 minutes ago.      │ │
│ │ Good until 2:35 pm.                │ │
│ └────────────────────────────────────┘ │
│                                        │
│ The other purities                     │  Karma 600 18px
│ ┌────────────────────────────────────┐ │
│ │ 999  ₹79,950   IBJA, 11:25 am      │ │  --font-data 16px tabular
│ │ 995  ₹79,550   IBJA, 11:25 am      │ │  rows separated by 1px
│ │ 750  ₹59,960   IBJA, 11:25 am      │ │  --ink-3 @ 20%
│ │ 585  ₹46,760   IBJA, 11:25 am      │ │
│ │ Silver 999  ₹935  IBJA, 11:25 am   │ │
│ └────────────────────────────────────┘ │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │    Enter a rate by hand            │ │  48px, outline button
│ └────────────────────────────────────┘ │
│                                        │
│ The automatic check                    │  Karma 600 18px
│ Last ran today 11:25 am and took all    │  --ink-2 16px
│ five gold rates and the silver rate     │
│ from IBJA.                              │
│ Next due 2:25 pm.                       │
│                                        │
│ History — 916                          │  Karma 600 18px
│ ┌────────────────────────────────────┐ │
│ │ Today 11:25 am  ₹73,240   IBJA     │ │  --font-data 15px
│ │ Today  7:25 am  ₹73,180   IBJA     │ │
│ │ Yest.  2:25 pm  ₹73,010   IBJA     │ │
│ │   ■ corrected. Was ₹7,301,         │ │  --sindoor 14px
│ │     entered by hand, closed at     │ │
│ │     2:31 pm the same day.          │ │
│ │ Yest. 11:25 am  ₹72,940   IBJA     │ │
│ └────────────────────────────────────┘ │
│ Show 999 · 995 · 750 · 585 · Silver     │  filter links
└────────────────────────────────────────┘
```

### Information hierarchy

1. **The rate in force**, at 28px mono — the biggest number anywhere in the admin,
   because it is the one number the whole shop hangs off.
2. **Its provenance and its expiry.** "Good until 2:35 pm" is computed from
   `rateExpiryMs()`; the owner can see the shelf life rather than discovering it.
3. The other purities, as a quiet table.
4. The manual entry route.
5. **When the automatic check last ran and when it is next due.** This is the "is the
   ingest healthy" answer, and it is phrased as an event rather than a status.
6. The audit trail, with corrections shown inline against the row they correct.

### Correcting a bad entry

There is no Edit control anywhere on this screen. Each history row offers
**"This one is wrong"**:

```
┌────────────────────────────────────────┐
│ ← Gold rate                            │
│ This rate is wrong                     │  Karma 600 24px
│                                        │
│ 916, ₹7,301 per 10 g, entered by hand   │  --font-data 17px
│ yesterday 2:25 pm.                      │
│                                        │
│ What should it be?                     │
│ ┌──────────────────┐                   │
│ │ 73,010           │  ₹ per 10 grams   │  56px, inputmode=numeric
│ └──────────────────┘                   │
│                                        │
│ ■ ₹7,301 per 10 grams is ₹730 a gram.   │  --sindoor panel
│   The rate before it was ₹7,294 a       │  the ten-times guard
│   gram. This one looks ten times too    │
│   small.                                │
│                                        │
│ Why was it wrong?                      │  <fieldset>, required
│ ( ) A typing mistake                   │
│ ( ) The figure from IBJA was wrong     │
│ ( ) Something else ┌───────────────┐   │
│                    └───────────────┘   │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │     Correct this rate              │ │  56px --sindoor fill
│ └────────────────────────────────────┘ │
│                                        │
│ This does not erase anything. The old   │  --ink-2 16px
│ figure stays in the history with your   │
│ correction beside it, because the        │
│ orders that were priced from it still    │
│ have to add up.                          │
└────────────────────────────────────────┘
```

That closing paragraph is the whole append-only design explained in one sentence of
shop English. It is the difference between a rule the owner works around and a rule
the owner understands.

### The consequence disclosure — the part most tools skip

Correcting a rate does not fix the invoices already made from it. Naming them is the
single most useful thing this screen does:

```
│ ────────────────────────────────────── │
│ ■ 2 orders were priced from the wrong   │
│   figure.                               │
│                                        │
│   AJ-2608-7QW2XF  Priya Sharma          │
│                   billed ₹18,533        │
│   AJ-2608-9MK4RT  Rakesh Mehta          │
│                   billed  ₹4,120        │
│                                        │
│   Their bills do not change when you    │
│   correct the rate. Ring them.          │
│                                        │
│   ┌──────────────────────────────────┐ │
│   │     See both orders              │ │
│   └──────────────────────────────────┘ │
```

Reachable because `order_items.goldRateId` points at the exact rate row.

### Entering a rate by hand

```
│ Which metal and purity?                │
│ ┌────┐┌────┐┌────┐┌────┐┌────┐         │
│ │999 ││995 ││916 ││750 ││585 │         │  48px pills
│ └────┘└────┘└────┘└────┘└────┘         │
│ ┌────────────┐                         │
│ │ Silver 999 │                         │
│ └────────────┘                         │
│                                        │
│ Rate                                   │
│ ┌──────────────────┐                   │
│ │                  │  ₹ per 10 grams   │  56px
│ └──────────────────┘                   │
│ IBJA publishes gold per 10 grams.       │  --ink-2 15px
│ Type the figure exactly as they print   │
│ it. Do not work out a per-gram price.   │
│                                        │
│ Where did you get it from?             │
│ ┌────────────────────────────────────┐ │
│ │ IBJA website, 11:25 am             │ │  → sourceQuoteRaw
│ └────────────────────────────────────┘ │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │       Use this rate                │ │
│ └────────────────────────────────────┘ │
│ This closes the rate in use now and     │
│ starts this one from this moment.       │
```

Silver is published per kilogram and converted on ingest. The manual form therefore
**changes its unit label to "₹ per kilogram" when Silver is selected**, and the
conversion is stated on the confirmation: *"₹1,19,500 per kg is ₹1,195 per 10 grams."*
Asking the owner to convert is asking for the exact bug the schema's unit naming
exists to prevent.

### Stale state

```
│ ■ The rate is out of date              │
│                                        │
│   The last good 916 rate is from        │
│   yesterday 3:25 pm.                    │
│                                        │
│   While it is out of date the website   │
│   cannot price anything. Every piece    │
│   shows "price on request" and nobody   │
│   can check out. That is deliberate —   │
│   a wrong price is worse than no price. │
│                                        │
│   The automatic check has failed 3      │
│   times since yesterday 7:25 am.        │
│                                        │
│   ┌──────────────────────────────────┐ │
│   │   Enter today's rate by hand     │ │
│   └──────────────────────────────────┘ │
```

### Empty state — today's real state

```
│ No gold rate has been recorded.        │
│                                        │
│ Nothing on the website can show a       │
│ price until one is. Every piece is      │
│ showing "price on request", which is    │
│ the truth rather than a placeholder.    │
│                                        │
│ ┌────────────────────────────────────┐ │
│ │    Enter the first rate            │ │
│ └────────────────────────────────────┘ │
```

### Error state

If the correction is rejected — the new figure is not a positive integer, or the
purity already has a current row that a concurrent write closed — the form re-renders
with the typed value and a message naming the fix. If SQLite rejects the batch on
`gold_rates_current_idx`, the message is: *"Someone else changed this rate while you
were typing. Here is what it says now: 916, ₹73,240. Correct that one instead."*

### Desktop

The history table gains a fifth column (`Entered by`) from `gold_rates.createdBy`.
Nothing else changes.

---

## 11. Screen 7 — Numbers

Behind a deliberate tap from Today. Nothing in here changes what the owner does in
the next five minutes, and a screen that changes nothing does not earn a tab.

### The argument against a KPI-tile row

Two independent reasons, and either is sufficient:

1. **The honest numbers are not takings.** `PAYMENT_CAPTURE_ENABLED = false`; the
   `payments` row is written `status = 'created'`, `advancePaidPaise` is 0, and
   `paymentStanding()` refuses to use the words "paid" or "received". A "Revenue
   today" tile would print a figure that no bank account contains. Every number on
   this screen is therefore **recorded**, not received, and the screen says so in
   words rather than in a footnote.
2. **A tile that cannot be tapped is a dead end.** Every count that is actually
   actionable — replies overdue, to make, ready to collect — is already a filter link
   on the Orders screen, where the owner can do something about it. Duplicating them
   as tiles here creates two places to look and one place to act.

So the screen is a sentence and two charts, and it holds only what the Orders screen
cannot answer: **shape over time**, and **metal committed**.

### The palette, validated

Every chart on this screen is **single-series**. There is no categorical palette in
this admin at all, by design — which is fortunate, because the brand's jewel notes
fail as one. Run for the record:

```
$ node scripts/validate_palette.js "#1f3a6e,#8c2f23,#1b4d3e,#8a6b18" --mode light --surface "#ede3d0"
  [FAIL] Lightness band    outside band: lapis 0.357, emerald 0.382
  [FAIL] Chroma floor      below floor (reads gray): lapis 0.096, emerald 0.06
  [FAIL] CVD separation    worst adjacent emerald↔sindoor ΔE 4.0 (protan)
```

Emerald against sindoor is ΔE 4.0 under protanopia — a colourblind owner cannot tell
"good" from "late". That settles the status question too: **there is no green in this
admin.** "Everything is fine" needs no colour. The only coloured state is the
exception, and it always ships with a filled square and a word.

The two colours that do exist were then validated as a pair, in both modes:

```
$ node scripts/validate_palette.js "#2f5591,#8c2f23" --mode light --surface "#ede3d0"
  [PASS] Lightness band · [PASS] Chroma floor · [PASS] CVD separation ΔE 17.7 protan
  [PASS] Normal-vision floor ΔE 21.6 · [PASS] Contrast vs surface
  → ALL CHECKS PASS

$ node scripts/validate_palette.js "#5b86c9,#d0674f" --mode dark --surface "#241409"
  [PASS] × 5 · CVD separation ΔE 18.0 protan · normal ΔE 23.3
  → ALL CHECKS PASS
```

- **Data hue:** `#2f5591` light (5.83:1 on plaster) / `#5b86c9` dark (4.83:1 on teak-deep).
  A lift of `--lapis`, the block-print blue. It appears nowhere else in the admin, so
  a mark in this colour can only mean "data".
- **Alert:** `--sindoor #8c2f23` light / `#d0674f` dark.
- **Gold, gold-leaf and brass appear on no chart, in no mode.** 1.90:1 on plaster.

### (a) A sentence, not tiles

```
│ Numbers                                │
│                                        │
│ In the last 30 days the shop recorded   │  Karma 400 18px --ink
│ 14 orders worth ₹18,42,300.             │  amounts in --font-data
│                                        │
│ No money has come through the website   │  --ink-2 16px
│ yet — card and UPI are not switched     │
│ on. Every figure here is what was       │
│ ordered, not what was taken.            │
│                                        │
│ Last 30 days · Last 90 days · This year │  <form method=get>, links
```

### (b) Orders a day, last 30 days

Single-series vertical bars.

```
│ Orders a day                           │  Karma 600 18px --ink
│ Last 30 days                            │  --ink-3 14px
│                                        │
│ 4 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄  4  │  hairline at max only,
│                              ▐          │  --ink-3 @ 25%, dashed
│              ▐         ▐  ▐  ▐   ▐      │  bars #2f5591
│        ▐  ▐  ▐     ▐   ▐  ▐  ▐   ▐  ▐   │  4px rounded tops,
│ ▐   ▐  ▐  ▐  ▐  ▐  ▐   ▐  ▐  ▐   ▐  ▐   │  anchored to baseline,
│ ─────────────────────────────────────── │  2px surface gap
│ 10 Jul                        8 Aug     │  --ink-3 13px
│                                        │
│ ▾ See the figures                       │  <details> — open by
└────────────────────────────────────────┘  default at ≤ 430px
```

- **Bars, not a line.** These are counts on discrete days, and the thing a shop owner
  reads is *how many days had nothing* — which bars show as gaps and a line hides by
  drawing straight through zero.
- **No legend.** One series; the title names it.
- **One gridline**, at the maximum, dashed, `--ink-3` at 25%. A full grid behind
  thirty 9px bars is more ink than data.
- **Direct-label the maximum bar only.** Never a number on every bar.
- **Hover tooltip per bar** on desktop: `Tue 22 Jul — 3 orders, ₹2,41,300`. Hit target
  is the full column height, not the bar.
- On a 390px phone: 358px of plot, 30 bars → 9.9px each with a 2px gap. That is a
  shape, not a readable figure, so **the table below it is open by default at ≤430px**
  and the chart sits above it as an overview.

### (c) Gold committed this month, by fineness

This is the chart that replaces Part D's "top categories", and it is the one
genuinely shop-specific view in the system.

```
│ Gold committed                         │
│ This month, by purity                   │
│                                        │
│ 916  ████████████████████   38.400 g   │  horizontal bars,
│ 750  ██████                 11.200 g   │  one hue #2f5591,
│ 995  ██                      3.900 g   │  4px rounded right ends,
│                                        │  2px gap, value direct-
│ 53.500 g in all.                        │  labelled in --font-data
│ No silver and no platinum.              │  --ink, not the bar colour
│                                        │
│ ▾ See the figures                       │
```

**Why this and not a revenue chart.** A jeweller's stock is metal. Rupees move with
the rate; grams do not. "38.400 g of 916 went out this month" tells the owner what to
buy, which a rupee figure cannot, because the same rupee figure means different
amounts of gold in different weeks. This number comes straight from
`order_items.netMetalWeightMg` summed by `finenessSnapshot` — it exists precisely
because the snapshot is statutory, so it is exact and it is already there.

**One hue, not six.** The rows are identified by their labels. Six categorical
colours against six labelled rows is decoration pretending to be encoding — Part D's
line, and it is right.

Maximum six rows, then "Other". Values direct-labelled at the end of each bar in
`--font-data` `--ink` — **text wears text tokens, never the series colour.**

### Table view

Every chart carries `<details><summary>See the figures</summary>` containing a real
`<table>` with `<th scope="col">` and `<caption>`. Works with no JavaScript, is the
CVD/print/forced-colors answer, and is the screen-reader path. Open by default on
phone for the 30-bar chart.

### Empty state

```
│ Not enough has happened yet to draw     │
│ anything.                               │
│                                        │
│ Charts start once there are orders on   │
│ more than one day. There have been 0    │
│ so far.                                 │
```

**Not** an empty axis. An axis with no bars is a claim that there is data and it
happens to be zero; that is a different statement from "nothing has happened", and
the second one is true.

### Error state

If the aggregation query fails, the charts are replaced by the sentence
*"Could not work out the figures just now. Nothing is wrong with the orders
themselves — they are all on the Orders screen."* and a link. Never a half-drawn
chart.

### Dark mode

Bars `#5b86c9` on `--teak-deep`; gridline `--plaster` at 18%; labels `--plaster`;
direct labels `--plaster`. Validated above. Never gold.

### Explicitly not built

Revenue-over-time lines on any screen, conversion funnels, an average-order-value
tile, a customer map, sparklines in list rows, and **any dual-axis chart** —
two measures of different scale get two charts or an indexed common base, never two
y-axes.

---

## 12. The phone-first decisions, collected

390px is the design target; desktop is the adaptation, not the other way round.

| Decision | Reason |
|---|---|
| **Single column, 720px max, on every viewport.** No sidebar, ever. | The desktop layout is the phone layout with more air. There is no second information architecture to learn, and nothing that only exists on one device. |
| **Bottom tab bar, 64px + safe-area inset.** | Reachable with a thumb on a 390px phone held one-handed at a counter. Top tabs are not. |
| **48px minimum targets, 56px on the primary action of each screen, 8px minimum between adjacent targets.** | The owner is tapping with one hand while holding something in the other. |
| **Call and WhatsApp on every row**, not behind a tap-through. | Follow-up happens by phone. This is the highest-frequency action in the entire tool. |
| **Row height 132px, not 96px.** | The 48-hour clock line plus two 48px buttons does not fit in 96px. This list is short; density is not the constraint. |
| **Confirm on a page, never a modal.** | A modal on a 390px screen is a full-screen sheet with worse scrolling, no back-button semantics, and a JavaScript dependency. A page has all three for free. |
| **No horizontal scrolling anywhere, including the bill.** | The bill's figures are right-aligned within 358px and wrap the *labels*, never the numbers. |
| **The 30-bar chart's table is open by default at ≤430px.** | 9.9px bars are a shape, not a figure. The chart shows trend; the table shows values. |
| **Segmented status control is 5 across at 70px each** — the tightest thing in the design. | It is still above the 48px floor in both dimensions and it teaches the state machine, which a `<select>` hides. At ≤ 360px it wraps to two rows of 3 + 2 rather than shrinking. |
| **`inputmode` on every numeric field** — `decimal` for weights, `numeric` for rates, `tel` for phone search. | The wrong keyboard on a weight field is how a decimal point goes missing. |
| **Amounts in `en-IN` grouping with `tabular-nums`, always.** | ₹1,84,500 not ₹184,500. Columns that align down a list can be scanned without a table. |
| **Dates in words: "4:12 pm today", "Sunday 11:40 am", "14 Aug".** Never ISO, never bare relative. | "2 hours ago" is useless for a deadline; "by 9:40 tomorrow morning" is actionable. |
| **Renders from cache with a "Last read 11:04 pm" line.** | Shop wifi is unreliable and a spinner over an empty screen reads as "the site is down". |
| **`autocomplete` and `enterkeyhint` on every field**, `enterkeyhint="search"` on search, `"done"` on the last field of a form. | Removes one tap per form on a phone keyboard. |
| **Nothing depends on hover.** Tooltips are an enhancement; direct labels and the table carry the same information. | There is no hover on a phone. |

---

## 13. The single thing most likely to make the owner abandon this tool

**A landing screen that is empty, and does not say why.**

Not a bug, not a slow query, not a confusing form. The shop has no inventory, no real
contact details, no gold rate, and payment capture is switched off until it holds a
BIS certificate. Every one of those is true today and none of them will resolve on
its own. So the honest prediction is that the owner signs in, sees nothing, signs in
again the next evening, sees nothing, and never opens it again. By the time the first
real order arrives there is nobody watching the screen — and its 48-hour clock starts
anyway.

That is why the Today empty state (§6) is the most important design in this document,
and why it is a **list of the four specific unfinished things, each with the action
that resolves it**, rather than a friendly nothing. An admin whose empty state is a
to-do list for opening the shop is an admin that gets opened. It also satisfies the
placeholder-honesty house rule exactly: it does not invent a founder, a phone number
or an encouraging metric, and it names `SITE_DETAILS_PENDING`, the empty catalogue,
the missing rate and the payment flag as the real reasons the screen is quiet.

**The runner-up, for after launch:** a price the owner cannot defend on the phone. The
customer says "your website said ₹1,78,533"; if the owner cannot produce that exact
figure, with the rate it came from and the minute it was locked, inside two taps, they
lose the argument and they stop trusting the tool for everything else. That is why the
bill panel and its rate-provenance line are load-bearing and the charts are not, and
why the bill was given the only piece of ornament in the whole interface.

---

## 14. Notes for the other two agents

Flagged, not designed — these are interface observations that land in someone else's
lane:

- **`support_tickets.kind` defaults to `"complaint"`** for the ticket every order
  creates. The interface will never show that word (§4), but if the enum can carry a
  `"reply_due"` member without disturbing Rule 7(1)(f), the data would match the
  language.
- **`assertOrderIntact()` needs a reporting path.** The design assumes the torn-order
  state is queryable for the list view, not only on detail read.
- **The rate-correction screen needs "which orders were priced from this rate row"**,
  reachable via `order_items.goldRateId`. That query does not exist yet.
- **Sign-in's one-string guarantee constrains the auth layer**, not just the template:
  constant-time comparison, identical response shape and timing on every failure path,
  and no differential rate-limit messaging.
- **The Today queue is a union across three tables** (`orders`, `appointments`,
  `support_tickets`) sorted by deadline. That shape should be settled before the
  screen is built.
```
