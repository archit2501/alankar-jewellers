# 03 — UI/UX Research: Alankar Jewellers

**Brief:** rich Indian heritage craft, run by modern people. The design must not read as a dusty
traditional gold-shop site, nor as a generic minimal DTC startup. Find the synthesis.

**Scope of this document:** (A) honest audit of what exists, (B) research into how premium
jewellery commerce actually works, (C) three art directions with a recommendation, (D) admin panel,
(E) founders page.

**Files read:** `app/page.tsx`, `app/globals.css`, `app/layout.tsx`, `app/site-config.ts`,
`app/_components/{site-header,appointment,brand-mark,contact-details}.tsx`, `db/schema.ts`,
`public/images/*`.

---

## Part A — Audit of the current site

The technical state is genuinely good: server components with three small client islands, a real
focus trap, honest handling of unknown business data, zero-CLS images, a reduced-motion block. None
of what follows is about code quality. It is about whether the page earns money from someone
deciding where to spend ₹4 lakh.

### A1. Typography

**The display face does not exist for most of the audience.** `app/globals.css:17`:

```css
--serif: "Bodoni 72", Didot, "Iowan Old Style", "Times New Roman", serif;
```

Bodoni 72, Didot and Iowan Old Style are all macOS/iOS-only system fonts. There is no `@font-face`,
no `next/font`, no webfont anywhere — `app/layout.tsx` imports only `globals.css`. On Windows and
Android, which is the majority of Indian traffic, **every heading, the wordmark, and all body copy
falls through to Times New Roman.** The `--sans` stack (`globals.css:18`) has the same problem and
lands on Arial.

This is not a nitpick. The site's entire visual argument is "we have taste," delivered in Times New
Roman and Arial to most of the people it is arguing with. Worse, the hero is set at
`clamp(4.2rem, 6vw, 7.4rem)` with `letter-spacing: -0.045em` (`globals.css:295-297`) — tracking
tuned for Bodoni's tight didone fit. Times at 118px with −4.5% tracking produces visible collisions
between round and straight letterforms. **This is the single highest-priority fix in the audit and
it is one file.**

**There are seven display sizes that all look identical.** Every section H2 got its own clamp:

| Element | Rule | Size |
|---|---|---|
| `.hero h1` | `globals.css:295` | `clamp(4.2rem, 6vw, 7.4rem)` |
| `.section-heading h2` | `:429` | `clamp(3.2rem, 5vw, 5.8rem)` |
| `.legacy h2` | `:585` | `clamp(3.5rem, 5vw, 6rem)` |
| `.craft h2` | `:694` | `clamp(3.7rem, 5vw, 6.1rem)` |
| `.appointment h2` | `:796` | `clamp(3.3rem, 4.5vw, 5.4rem)` |
| `.contact h2` | `:829` | `clamp(2.6rem, 4vw, 4.2rem)` |
| `.appointment-dialog h2` | `:1122` | `clamp(2.6rem, 5vw, 4.8rem)` |

5.8 vs 6.0 vs 6.1rem is a 3px difference at max. Nobody can perceive it, so it produces no
hierarchy, but every one of the seven has to be maintained. Same story in the accompanying
`letter-spacing` (−0.045 / −0.04 / −0.03 / −0.015em) and `line-height` (0.91 / 0.94 / 0.96 / 0.98 /
1.0 / 1.02). These are not decisions, they are drift.

**Body sizes are a decimal soup.** Distinct `font-size` values in the file: 0.68, 0.7, 0.72, 0.74,
0.82, 0.85, 0.86, 0.94, 1.0, 1.02, 1.05, 1.1, 1.12, 1.34, 1.35, 2rem — sixteen values with no ratio
between them. There is no type scale, only a history of adjustments.

**Two specific legibility failures:**
- `.timeline__item > p:last-child` (`:671-676`) sets the brand's 45-year story at **0.85rem = 13.6px**
  in a serif, at `rgba(251,247,239,0.76)`. It is the smallest text on the page carrying the most
  important claim.
- `.brand-mark__category` (`:154-159`) sets "JEWELLERS" at 0.72rem with **`letter-spacing: 0.58em`**.
  Nine letters spread across roughly eleven character-widths of air. `.brand-mark__since` is 0.37em
  (`:168`), section labels are 0.28em (`:417`), buttons 0.17em (`:332`), nav 0.14em (`:203`). Five
  different tracking values for the same "small uppercase label" role.

### A2. Spacing — there is no system

Counting unique padding/margin/gap values in `globals.css`: roughly forty, and they include
**22, 23, 25, 26, 27, 28, 30, 31, 32, 34, 35** px. Examples: header padding `22px`
(`:134`), brand category margin `11px` (`:155`), brand since margin `14px` gap `12px` (`:165-167`),
nav button padding `0 23px` (`:233`), hero h1 margin `30px` (`:293`), hero p margin `27px 0 35px`
(`:303`), section-label margin `19px` (`:413`) with a `14px` padding-top override (`:424`),
`.collection__copy` padding `31px 16px 0` (`:488`) then `8px` (`:494`), `12px` (`:501`), `23px`
(`:512`), timeline `54px` / `68px` / `-18px` / `87px` / `35px` / `9px` / `3px` / `11px`
(`:612-658`).

Nothing lands on a common multiple. Every value was eyeballed once and frozen. For a design whose
entire premium signal is restraint, **spacing discipline is the product**, and there isn't any. This
is also the reason the page reads "close but not quite" — the eye registers inconsistent rhythm long
before it can name it.

The one place a system does exist — `clamp()` on section padding (`.section-shell`, `:390-392`) — is
good and should survive.

### A3. Colour — four tokens, eleven jobs, seven undeclared greys

Declared palette (`globals.css:8-16`): ink, black, garnet, garnet-deep, gold, gold-soft, parchment,
parchment-light, rule. Nine tokens. What actually ships:

**`--gold` #c89b4b does eleven different jobs** — hairlines, frame borders, the timeline dot, all
eyebrow labels, button hover fills, the focus ring (`:108`), the timeline arc, the footer top
border, contact card top borders, the dashed notice border, the dialog border. When one accent
carries every hierarchical signal, none of them is emphatic. The page is uniformly gold-ish and the
eye gets no ladder to climb.

**Gold is also failing contrast in two places.** Computed against the parchment field
(#f3ebdd, relative luminance ≈ 0.837):
- `.collection__copy > span` (`:492-498`) — the "01/02/03" numerals — gold on parchment at
  **0.72rem (11.5px)** measures **≈ 2.2:1**. WCAG AA for small text is 4.5:1. This is a plain
  accessibility failure.
- `.collection__frame` border (`:463`) — 1px gold against the parchment page at **≈ 2.2:1**, below
  the 3:1 non-text minimum. The frame that is supposed to say "this is precious" is invisible to a
  meaningful share of viewers.

Gold simply cannot be an interface colour on a light ground. It is a *material*, and it belongs in
the photographs.

**Garnet is announced as a brand colour but never becomes one.** `--garnet` #560f1b appears only as
ink and as 1–2px borders (`:414`, `:503`, `:318`, `:352`, `:1150`). It is never a field. The one
garnet-family surface is `.legacy` (`:544`), and there it is `--garnet-deep` with a hardcoded
`rgba(196, 64, 74, 0.4)` radial bloom — colour `#c4404a`, which appears nowhere in `:root`. That
bloom is the single most saturated moment on the entire page and it reads as a lens flare, not as
a material.

**Seven undeclared greys/browns** picked by eye and never tokenised: `#635850` (`:437`), `#574c46`
(`:513`), `#504640` (`:703`), `#776a60` (`:748`), `#655850` (`:1131`, `:1249`), `#77685e` (`:72`),
`#281a14` (`:464`). Plus `#0b0908` for the footer (`:993`) sitting one value away from `--black`
`#0c0908` — an invisible duplicate that exists for no reason.

**The two parchments do nothing.** `--parchment` #f3ebdd vs `--parchment-light` #fbf7ef differ by
about 4% luminance. `.collections` uses one, `.craft` uses the other. A visitor cannot perceive that
as an intentional field change, so the boundary reads as an accident rather than a chapter break.

### A4. Section transitions — the weakest structural thing on the page

The page is six stacked slabs:

```
black hero → parchment collections → garnet-deep legacy → parchment-light craft → black visit → black footer
```

Every seam is a hard horizontal edge with **nothing crossing it**. No image bleeding through, no
rule continuing, no element hanging into the next field, no change of texture or grid. Premium
sites earn their transitions; this one just changes `background`.

The only element that tries to break a box is `.craft__image::before` (`:725-734`) — a 1px gold
rectangle offset −22px/−22px/+64px/+22px behind the photo. That specific device (an offset outline
frame peeking out from behind an image) is a 2012–2016 Squarespace/Divi signature and is one of the
strongest "template" tells on the page.

### A5. The collection grid isn't staggered, and its numbering is decorative

`.collection--2 { margin-top: 70px }` (`:455`) offsets **only** the middle card. Cards 1 and 3 stay
level. So the "stagger" is a single dip in the middle, which reads as a layout bug rather than a
rhythm. A real editorial stagger alternates or is driven by content.

Compounding it: `.collection__copy` is centre-aligned (`:489`) and the three copy blocks are 118,
110 and 106 characters. Centred text of unequal length under staggered images means the three
"Enquire about…" CTAs land at three unrelated y-positions with three different left edges. There is
no line anywhere for the eye to rest on.

**The 01/02/03 numbering encodes nothing.** `page.tsx:148` renders `0{index + 1}`. Jadau, Diamond
and Polki are not a sequence — there is no first, no progression, no order the reader needs. The
numbering asserts a hierarchy the content does not have, purely because numbered eyebrows look
designed. Cut it.

### A6. The timeline is geometrically broken and isn't a timeline

Three devices overlap in the same 90px band:
- `.timeline::before` (`:616-624`) — a flat 1px gold rule at `top: 68px`.
- `.timeline::after` (`:626-636`) — an 87px-tall half-ellipse (`border-radius: 50% 50% 0 0`) at
  `top: -18px`, spanning the full four-column track.
- `.timeline__dot` (`:644-655`) — rotated squares at `top: 9px`.

The dots sit 59px above the straight rule and are not on the arc either. Nothing connects to
anything. Look at it for three seconds and the relationship simply fails to resolve; the arc reads
as an unrelated ornament floating over a line.

**And the content is not a timeline.** `page.tsx:58-79` gives four entries: `1980`, `The 1990s`,
`A new generation`, `Today`. Half the axis is non-temporal. A timeline whose axis is 50% vibes is a
list wearing a costume.

The copy is also unfalsifiable — "With a belief that fine jewellery begins with integrity",
"One family introduction, one cherished occasion at a time." A buyer spending lakhs reads that as
filler, because it is: nothing in it could be untrue of any jeweller.

### A7. Motion — there is essentially none, and what exists is inconsistent

The entire site has four transitions:

| What | Rule | Duration / easing |
|---|---|---|
| Nav underline `scaleX` | `:222` | 220ms `ease` |
| Button bg/colour | `:235`, `:334` | 200ms `ease` |
| Menu overlay opacity | `:1298` | 180ms `ease` |
| Collection image `scale(1.035)` | `:479` | 900ms `cubic-bezier(0.16,1,0.3,1)` |

Four durations (180/200/220/900), and every one except the last uses the browser default `ease` —
which is not a choice, it's the absence of one. There is **zero** scroll-triggered behaviour, zero
page-load orchestration, zero image-load treatment. The hero photograph simply pops in.

`scale(1.035)` over 900ms is also below the just-noticeable threshold for most viewers. It promotes
a composite layer and buys nothing perceptible.

For a category where the product *is* light moving across facets, having no motion is a wasted
thesis. But the fix is not to sprinkle fade-ups on every section — that is precisely the
AI-generated default. The answer is one orchestrated moment (see Part C).

### A8. Quality-floor bugs found while reading

- **`body::selection` (`:42-45`) is dead code.** `::selection` on `body` does not cascade to
  descendants; the selector must be `::selection` / `*::selection`. The gold selection colour never
  applies to any copy on the page.
- **The mobile menu uses `z-index: -1`** (`:1286`, `:1303`). A full-screen overlay behind the
  stacking context works here only because no ancestor paints a background. Add one `background` to
  `main` and the menu disappears. It also has no scroll-lock (the dialog has one,
  `appointment.tsx:159-165`; the menu does not) and no `inert`/`aria-hidden` on the page behind it.
- **`.dialog-close` is 42×42px** (`:1088-1096`) — under the 44px minimum touch target — and the X is
  drawn by pseudo-elements at hardcoded `top: 20px; left: 11px` (`:1100`), which only centres at
  exactly 42×42. It also wraps an empty `<span />` (`appointment.tsx:271`) that does nothing.
- **Hero H1 on small phones.** `page.tsx:107` hard-codes `<br />` between "Jewels that" and "become
  heirlooms." At 360px the mobile rule gives `clamp(3.6rem, 15vw, 5.4rem)` = 54px (`:1427`) inside a
  312px content box (`:1422`). "become heirlooms." wraps to a third line, and at
  `line-height: 0.91` (`:298`) the descenders of line 2 collide with the ascenders of line 3.
- **`.hero__promise`** (`:376-388`) is a `rotate(-90deg)` label at 11.2px with 0.24em tracking,
  `display: none` below 780px (`:1437`). Rotated micro-type in a corner is a 2016 agency tic, and
  here it is desktop-only decoration.
- **`.legacy::before` / `::after`** (`:551-575`) are 260px rings with 68px shadow spreads at
  −150/−170px offsets. At `rgba(200,155,75,0.14)` they are either invisible or, on a good display,
  look like a rendering artifact sitting behind the "Four decades." headline.
- **`.contact__value--pending`** (`:913-917`) styles a non-link phone number with
  `text-decoration: underline dashed`. It looks exactly like a link. People will tap it.
- **`.brand-mark--compact`** (`:180-186`) scales the wordmark to `clamp(2.4rem, 3vw, 3.8rem)` but
  `.brand-mark__since::before/::after` (`:172-178`) stay `width: 100%` of a `min-width: 280px` box,
  so the "SINCE 1980" rules overhang the name in the footer.
- **`overflow-x: hidden` on `body`** (`:33) hides overflow instead of fixing it, and breaks
  `position: sticky` in some containment contexts — which matters, because a sticky gold-rate strip
  and a sticky PDP price panel are both things this site will need.

### A9. Imagery — the most expensive problem, and no CSS fixes it

All six images are AI-generated at native model output sizes:

| File | Pixels | Bytes |
|---|---|---|
| `hero-jadau.webp` | 1536 × 1024 | 287 KB |
| `artisan-setting.webp` | 1536 × 1024 | 280 KB |
| `private-salon.webp` | 1536 × 1024 | 217 KB |
| `collection-jadau.webp` | 1024 × 1536 | 244 KB |
| `collection-polki.webp` | 1024 × 1536 | 349 KB |
| `collection-diamond.webp` | 1024 × 1536 | 155 KB |

**Resolution.** The hero renders at `100vw × min(920px, 100svh)` (`:250-257`). On a 2× 1440px
laptop that demands ~2880px of width and receives 1536 — a **1.9× upscale**, soft exactly where the
product must be sharp. `object-fit: cover` on a 3:2 source in a 16:9-or-taller viewport also crops
hard; the mobile fix is a hand-tuned `object-position: 64% center` (`:1408`), i.e. one magic number
patching one crop.

**Authenticity, which matters more.** AI jewellery renders plausible-but-wrong metallurgy: kundan
bezels that don't close around the stone, meena work that smears at the boundary, stone counts that
change between glances, chain links that don't interlock. The one audience on earth whose entire
purchasing skill is *looking closely at jewellery* is the audience for this page. They will see it,
and what they will conclude is not "AI" but "these aren't their pieces."

**Real photography of real inventory is the highest-ROI item in this entire document, ahead of every
CSS change below.** Everything else here is refinement of a container; this is the contents.

### A10. What a luxury buyer subconsciously distrusts

1. **Money is never mentioned.** No price, no range, and no "price on request" either. High-end
   jewellers either publish a price or explicitly decline to — the explicit decline is itself a tier
   signal. Saying nothing at all reads as "not built yet," not as discretion.
2. **There is no proof of anything.** Zero mentions of BIS hallmark, HUID, IGI/GIA/SGL
   certification, karat, weight, buyback, exchange, or return policy. For Indian jewellery the
   hallmark is the load-bearing trust object and it appears nowhere — while the site asks for the
   visitor's phone number in a modal.
3. **Placeholders are live.** `site-config.ts:27-28` ships `+91 00000 00000`; the address is
   "Shop address line 1, Locality, City, State 000000". `contact-details.tsx:26-33` labels this
   honestly ("Details pending"), which is the right engineering call and the wrong business
   outcome: a 45-year-old business whose website does not know its own address reads as a business
   that may not exist.
4. **Nobody is named.** The brief is "the people running it are modern," and the page contains no
   person, face, name, or signature. The artisan photograph shows hands. `contact-details.tsx:50`
   says "speak to the family directly" without saying who the family is.
5. **"Serving trust since generations"** (`page.tsx:119`, `page.tsx:256`) is ungrammatical — an
   Indian-English calque for "for generations." It appears twice, once rotated in the hero. On a
   site whose thesis is "we are modern," a grammar slip in the tagline is the loudest available
   counter-signal, aimed precisely at the customer who has other options.
6. **Every path ends at the same form.** "Enquire about Jadau" (`page.tsx:151`), "Begin a bespoke
   conversation" (`:203`), "Book an Appointment" (`:245`), "Private Appointments" (`:269`) are four
   labels for one modal asking for a phone number. A first-time visitor not ready to hand over a
   number has literally nothing else to do on the site.

### A11. Verdict — premium or template?

**Template, with premium instincts.**

Right instincts, keep them: the parchment field, the restraint in accent usage, serif display, real
section padding, the editorial two-column craft block, the honest treatment of unknown business
data, and the decision to hand-write BEM rather than reach for a framework.

Template tells, all present at once: centred card copy under an image; 01/02/03 numbering; the
offset-rectangle frame behind the craft photo; a 72×2px gold rule reused four times as generic
punctuation (`:310`); uppercase 11px letterspaced eyebrows in three different colours doing one job;
corner circle-ring flourishes; double-border image frames; seven H2 sizes that look the same.

Individually each is defensible. Together they are the vocabulary of a 2018 premium-restaurant
template. **Nothing currently on the page could only be Alankar.** That is the thing Part C has to
fix.

---

<!--PART-B-->

---

## Part C — Three art directions

Constraint I set for myself before designing: not to land on any of the three looks that current
AI-generated design defaults to — (1) warm cream ground + high-contrast serif + terracotta accent,
(2) near-black + one acid accent, (3) broadsheet hairlines and dense columns. The existing site is
already three-quarters of the way into default (1), which is a large part of why it feels templated.

All three directions below derive from material facts about the craft rather than from a mood board.

---

### Direction 1 — **"Meena Reverse"** ← RECOMMENDED

**Thesis.** In Jadau and Polki work, the back of the piece is enamelled. Vivid opaque green, red and
white meenakari sits on the reverse of a necklace that shows only gold and stone from the front —
decoration the wearer knows about and the room does not. That is the exact shape of this brand's
tension, already solved in the object: disciplined and quiet on the face, alive underneath, and the
only people who see it are the ones who turn it over. So the site is built cool, quiet and
contemporary — near-neutral paper, no gold lines, no ornament — and **colour arrives only when a
piece is turned over.** Every hue on the site is a real enamel pigment. Nothing is decorative;
saturation is always a physical event.

**Signature element.** *The flip.* Every product image on the site has a front and a reverse. On the
listing card, hovering (desktop) or tapping a small `⟲` (touch) crossfades to the enamelled back —
and as it does, the card's field colour transitions from paper to meena green. On the PDP the
reverse is the second gallery slide, not an afterthought thumbnail. On the founders page the same
gesture reveals a workshop photo behind a portrait. One interaction, used everywhere, that is
literally the brand's product knowledge made operable. No template ships this, and no competitor
does it.

**Type.**

| Role | Face | Notes | Fallback stack |
|---|---|---|---|
| Display | **Eczar** (Rosetta Type Foundry, Vaibhav Singh, SIL OFL, weights 400–800) | High-contrast display serif with flared, energetic terminals, drawn as a **Devanagari face with a matching Latin** — not a Latin face with Devanagari bolted on. Indian type authorship, made for headlines, and nothing like the Bodoni/Playfair default. Verified present on Google Fonts. | `Eczar, Newsreader, "Iowan Old Style", Georgia, serif` |
| Body / UI | **Mukta** (Ek Type, OFL, weights 200–800) | Humanist sans drawn alongside its own Devanagari, so a Hindi line later sets natively in the same voice. Verified present on Google Fonts. | `Mukta, "Helvetica Neue", Arial, sans-serif` |
| Data | **IBM Plex Mono** (OFL, 400/500) | Weights, karat, HUID, gold rate, order IDs, certificate numbers. Tabular by construction. | `"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace` |

All three self-hosted as subset `.woff2` (latin + latin-ext), `font-display: swap`, preloaded for
the display face only. Budget ≈ 180 KB total.

**Type scale.** Three display sizes, not seven. Text on a 1.25 ratio.

```
--d-xl   clamp(3.25rem, 7vw, 6rem)      hero only, once per page
--d-l    clamp(2.25rem, 4vw, 3.5rem)    section openers
--d-m    1.75rem                        product name, founder name, pull quote
--t-lg   1.375rem   lede paragraphs
--t-md   1.125rem   body
--t-sm   1rem       secondary body
--t-xs   0.875rem   captions, table cells
--t-2xs  0.75rem    utility labels, tracking 0.08em max (never 0.28em)
```

**Colour ramp.**

```css
--paper        #F1F2EE  /* page ground — cool paper, not cream */
--paper-raised #FAFAF8  /* cards, sheets, dialogs */
--paper-sunk   #E5E7E1  /* filter bar, table zebra */
--ink          #17191A  /* primary text          — 15.9:1 on paper */
--ink-2        #55595A  /* secondary text */
--ink-3        #8B8F8C  /* captions, disabled */
--hairline     #D3D6CF  /* the ONLY rule colour on the site */
--meena        #0A5C3C  /* primary brand: enamel green — 7.2:1 on paper */
--meena-deep   #063E29  /* hover, dark fields */
--meena-tint   #E6EFE9  /* selected chips, focus wash */
--sindoor      #A5142B  /* second enamel — reverse-side moments and urgency only */
--kundan       #B98A3C  /* metal — 2.8:1 on paper, therefore NEVER text and NEVER a rule */
--polki        #C9C7BE  /* uncut-stone grey — skeletons, image placeholders */
```

The load-bearing decision: **green is the interface colour, gold is not.** Gold measures ~2.5–2.8:1
on any light ground, so it can never legally carry text or a 1px rule — which is exactly the mistake
the current site makes in two places (A3). Meena green measures **7.2:1** on this paper, so it can
be text, a button, a link and a field. Gold is demoted to what it actually is: a material that
appears in the photographs and, at most, as a filled area ≥16px with ink on top. That single move
also breaks the visual tie with every gold-on-cream competitor.

The cool paper is the second load-bearing decision. Every Indian jeweller online is warm. A ground
at #F1F2EE reads contemporary at zero cost and makes the photography — which is all gold, red and
green — the warmest thing on screen, which is where the warmth belongs.

**Spacing scale.** Two tiers, hard rule: no raw px in any component.

```
micro (component internals, strict 4px): 4  8  12  16  24  32  40
macro (section rhythm, ×1.55 ladder):    56  88  136  208
```
Section padding uses macro values only. If a value of 23px seems needed, the composition is wrong.

**Border and edge treatment.** This is where the direction is most opposed to the current site.
- **No borders on images. Ever.** No frames, no double-frames, no offset outlines. Images sit
  directly on the field, bleeding to the edge of their column.
- Structure comes from **field colour changing**, not from lines.
- One hairline colour (`--hairline`), one weight (1px), used for exactly one job: separating a row
  of data from the next row of data. If a hairline is not separating tabular information, delete it.
- Radius: `3px` on images and media (enough to remove the "screenshot" feel, not enough to read as
  a rounded card), `0` on everything else.
- No shadows anywhere except the modal (`0 24px 64px rgba(23,25,26,.18)`).

**Motion principles.**
- **One orchestrated arrival, then nothing.** On first paint the hero image resolves from a 6%
  desaturated state to full over 300ms while the headline sets in place (no slide). The page
  assembles like a print job coming up to colour. Nothing else animates on load.
- **No scroll-triggered fade-ups anywhere.** That pattern is the current AI-design tell and it makes
  a long page feel like a slideshow.
- **The flip is the only motion with a transform**: 420ms `cubic-bezier(.2,.7,.2,1)`, crossfade plus
  2% scale, with the card field colour on the same curve so image and field move as one object.
- Everything else is 160ms `ease-out` on `color`, `background-color`, `opacity` only.
- `prefers-reduced-motion`: the flip becomes an instant crossfade at 0ms **but keeps the colour
  change** — the information survives, the movement doesn't.

**Imagery direction.** Every piece shot twice — face and reverse — on the same neutral mid-grey
sweep (#8C8F89-ish), one soft source from the upper left, a hard raking second source at 20% to
catch the foil edges. Consistent scale across the catalogue so a `41g` haar looks heavier than an
`18g` chandbali on screen. 4:5 portrait, minimum 2400px on the short edge. Plus, per piece: one
on-body/on-hand shot for scale, one macro detail at the setting. No lifestyle photography, no
models in bridal costume, no black-and-white.

---

### Direction 2 — **"Rate of the Day"**

**Thesis.** The most modern thing a heritage jeweller can do is not to look modern — it is to
disclose. The Indian jewellery trade runs on information the customer doesn't have: today's rate,
the making-charge percentage, gross versus net weight, what the wastage is, what buyback actually
pays. A shop that publishes all of it is making a generational statement without a single visual
flourish. So the design system *is* the disclosure: the site is built like a document of record —
numbers as typography, the day's rate as a headline rather than a widget, the price breakup as the
hero of the product page rather than a collapsed accordion.

**Signature element.** *The rate line.* A single line of type, sticky under the header, set in the
display face at the same size as a section heading: `22K · ₹7,412/g · 11:04 today`, with the delta
against yesterday. It is not styled as a ticker or a badge — it is styled as a masthead, the way a
newspaper sets its date. On the PDP it becomes a live sentence: "This price holds for 14:52."

**Type.** Display **Anek Latin** (Ek Type for Google, OFL, variable — width 75–125 × weight
100–800). One family covers a wide, serene wordmark and tight 87.5-width caps for data labels, and
its Devanagari sibling (**Anek Devanagari**) matches exactly. Body **Source Serif 4** (Adobe, OFL,
variable). Data **Anek Latin** at width 87.5 with tabular figures. All verified present on Google
Fonts.
Fallbacks: `"Anek Latin", Inter, "Helvetica Neue", Arial, sans-serif` /
`"Source Serif 4", Charter, Georgia, serif`.

**Colour.**
```css
--sheet       #FFFFFF   /* page */
--sheet-2     #F6F6F4   /* table stripe, filter bar */
--ink         #101010
--ink-2       #5A5A57
--rule        #DCDCD6
--signal      #1F4FD8   /* primary action & links */
--signal-wash #E8EDFD
--up          #0C7A3E   /* rate up */
--down        #B3261E   /* rate down */
--gold-mark   #8A6A2A   /* used ONLY inside the BIS hallmark lockup, nowhere else */
```
The risk this direction takes deliberately: **a blue on an Indian jewellery site is heresy.** That is
the point — #1F4FD8 is the colour of a bank statement and a certificate, and the entire premise here
is proof rather than romance. Gold appears exactly once, inside the hallmark mark.

**Spacing.** Strict 8px baseline with a 24px line-height rhythm; every block starts on the grid.
Section rhythm 48 / 96 / 144. Rigidity is the aesthetic.

**Edges.** Hairline rules everywhere they carry meaning (they always separate data), 0 radius, no
shadows, no image borders. Tables are first-class UI, not a styling afterthought.

**Motion.** Almost none by design. Numbers change with a 120ms tabular tick (digit crossfade, no
sliding odometer). The rate-hold countdown is the only continuously moving element on the site, and
it is text.

**Imagery.** Documentary. Pieces shot flat-lay on the actual bench with the actual scale in frame;
certificates and hallmark punches photographed as objects; rate-board and ledger photography. Almost
no styling. Product shots stay clinical on white so they read as evidence.

**Honest risk.** This is one axis away from the "broadsheet" AI default, and it can read cold and
transactional — the opposite of what a bridal purchase feels like. It also asks the shop to publish
its making-charge percentage, which is a real business decision, not a design one.

---

### Direction 3 — **"Lac & Foil"**

**Thesis.** The material truth of Jadau is a warm shellac (lac) core with 24-karat foil pressed
around each uncut stone by hand. It is a warm, dark, soft-edged craft, and the only reason any of it
is visible is light raking across foil. So the site is a dark warm field throughout, with gold used
as *foil* — filled surfaces, gradients, specular sweeps — never as the 1px lines every heritage
jeweller draws. The modernity comes from the restraint and from the motion: this is the only one of
the three directions where light moves.

**Signature element.** *The sweep.* A scroll-linked specular highlight travels across each product
image as it passes the viewport centre — a narrow, low-opacity gradient band moving at a fixed
angle, driven by scroll position rather than time, so it feels like the viewer is tilting the piece
rather than watching an animation. Implemented once, applied to every product image, disabled under
`prefers-reduced-motion`.

**Type.** Display **Petrona** (OFL, variable) — a moderate-contrast serif that survives being
reversed out of a dark field, where a Didone's hairlines would bloom and break. Body **Karla**
(OFL, variable) — a grotesque with enough eccentricity to avoid feeling generic. Data
**IBM Plex Mono**.
Fallbacks: `Petrona, Charter, Georgia, serif` / `Karla, "Helvetica Neue", Arial, sans-serif`.

**Colour.**
```css
--lac       #1C0E0B   /* page ground — warm near-black, the colour of shellac */
--lac-2     #2A1611   /* raised surfaces */
--ash       #3E2A22   /* hairlines */
--bone      #EFE9E0   /* primary text */
--bone-2    #B6A99C   /* secondary text */
--foil      #D8B26B   /* metal, used as FILL only */
--foil-hot  #F0D9A6   /* specular highlight, gradients only */
--enamel    #14503A   /* the single cool note */
```

**Spacing.** 4px micro (4/8/12/16/24/32/48); macro 64 / 104 / 168 / 272. Dark fields need more air
than light ones or the type feels crowded.

**Edges.** No borders at all. Separation comes from `--lac` vs `--lac-2` surface steps. Radius 0.
The only "edge" on the site is the specular sweep.

**Motion.** The sweep, plus a 200ms image reveal from `--lac-2`. Nothing else.

**Imagery.** Single hard source, deep falloff, black velvet or dark wood ground, shot the way a
jeweller actually shows a piece — under a lamp, on a bench, tilted. Very high contrast, deep shadow,
no fill.

**Honest risk.** This is the dusty-traditional trap with better execution. Dark-on-gold is what
every mid-tier Indian jeweller's site already looks like, so the direction's entire survival depends
on photography that is genuinely better than theirs — and it converts worse on Indian mobile, where
a large share of sessions are outdoors in daylight. It is the highest-ceiling and highest-floor-risk
of the three.

---

### The recommendation: Direction 1, "Meena Reverse"

Six reasons, in order of weight.

1. **It resolves the brief with a fact instead of a mood.** "Heritage craft, modern people" is a
   mood board sentence. "The back of the piece is enamelled and only the wearer knows" is a real
   property of the exact categories this shop sells. Design that comes from the object cannot be
   arrived at generically, which is the whole failure mode of the current page (A11).
2. **It forces the photography fix.** You cannot fake a meena reverse — the enamel/gold boundary is
   precisely where generated imagery falls apart. Adopting this direction makes real photography of
   real inventory structurally non-optional, which is the highest-value item in this document (A9).
   Choosing a direction that quietly permits AI images would be choosing to keep the biggest problem.
3. **The colour system is legal.** Green at 7.2:1 can be text, buttons, links and fields. Gold at
   2.5–2.8:1 can be none of those, which is why the current site has two live contrast failures. This
   direction is the only one of the three that gives the brand a saturated colour it can actually
   build an interface out of.
4. **It differentiates on the cheapest available axis.** A cool paper ground costs nothing and
   instantly separates the brand from every warm-cream and gold-on-black competitor. Meanwhile gold
   stays fully present — in the product, where it is real.
5. **The signature is an interaction, not an ornament.** Every ornament on the current page
   (`gold-rule`, the rings, the offset frame, the arc) is removable without losing information. The
   flip is not removable, because it carries information — you learn what the back of the piece
   looks like. That is the difference between a decorated site and a designed one.
6. **It has somewhere to go.** The flip extends naturally to the founders page (portrait → workshop),
   to the craft page (finished → in progress), and to the admin (front thumbnail → reverse for
   identification). Directions 2 and 3 have a single strong idea each and then stop.

**One thing to steal regardless of direction:** Direction 2's disclosure system — the rate line, the
itemised price breakup, the hallmark/HUID lockup, the returns block — is not really an art
direction. It is information architecture, it is what the category demands (Part B), and it should
ship whichever visual direction wins. In Direction 1 it renders in IBM Plex Mono against
`--paper-sunk` with `--hairline` row rules, and it becomes the quiet, factual counterweight to the
colour.

**The one risk I'm taking, stated plainly:** making the primary brand colour green rather than gold,
for a gold jeweller. If the owner rejects it, the fallback is not "add gold back as the accent" —
it is to promote `--sindoor` #A5142B (the other real enamel pigment, and close to the garnet already
in `:root`) to primary. Do not promote `--kundan`; it fails contrast and the whole system unravels.

---

### Wireframe — storefront listing page (Direction 1)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  ALANKAR            Jadau   Polki   Diamond   Bridal          ⌕    ♡    Bag(2) │  56px · paper · hairline base
├────────────────────────────────────────────────────────────────────────────────┤
│  22K ₹7,412/g   18K ₹6,065/g                        updated 11:04, 14 Aug      │  34px · Plex Mono · paper-sunk
└────────────────────────────────────────────────────────────────────────────────┘

     Polki                                                            41 pieces
     ──────────────────────────────────────────────────────────────────────────
     Uncut diamonds, closed-set in gold. Every piece shown from both sides.       ← d-l heading + one lede line

     Metal ▾    Stone ▾    Occasion ▾    Weight ▾    Price ▾    ⃞ Ready to ship
     ──────────────────────────────────────────────────────────────────────────
     ✕ 22K      ✕ ₹1L–₹3L                             Clear all      [2-up|3-up]
     ──────────────────────────────────────────────────────────────────────────

     ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
     │                    │   │////////////////////│   │                    │
     │                    │   │//  REVERSE SHOWN  /│   │                    │
     │      4:5 front     │   │//  field: meena   /│   │      4:5 front     │
     │                    │   │////////////////////│   │                    │
     │                 ⟲  │   │                 ⟲  │   │                 ⟲  │
     └────────────────────┘   └────────────────────┘   └────────────────────┘
      Kanthi haar              Chandbali                Rani haar
      22K · 41.2g · polki      22K · 18.4g · polki      22K · 96.0g · polki      ← Plex Mono, ink-2
      ₹4,82,000                ₹1,84,500                Price on request
      BIS 916                  BIS 916                  BIS 916 · IGI            ← hallmark lockup, always

     ┌────────────────────┐   ┌────────────────────┐   ┌────────────────────┐
     …                        …                        …

                              Showing 12 of 41
                            [  Show 12 more  ]                                    ← button, not infinite scroll
```

Grid: 3-up ≥1200px, 2-up 640–1199px, 2-up on phone (a 1-up phone grid makes browsing 41 pieces
feel endless — see Part B). 4:5 portrait throughout, because necklaces and haars are tall and a
square crop decapitates them. No card borders, no shadows; the card *is* the image plus a text
block. Card gap = 24px micro. Hover state = the flip, not a lift or a shadow.

### Wireframe — product detail page (Direction 1)

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  ALANKAR            Jadau   Polki   Diamond   Bridal          ⌕    ♡    Bag(2) │
├────────────────────────────────────────────────────────────────────────────────┤
│  22K ₹7,412/g                        this price holds for 14:52                │  sticky
└────────────────────────────────────────────────────────────────────────────────┘
  Polki  ›  Necklaces  ›  Kanthi haar

  ┌──────────────────────────────────┐    Kanthi haar                      d-m
  │                                  │    Uncut polki, closed setting,     t-md
  │                                  │    green meena reverse.
  │                                  │
  │        FRONT   4:5  @2400px      │    ₹4,82,000   incl. GST            d-l, tabular
  │                                  │
  │                                  │    ┌──────────────────────────────┐
  │                                  │    │ Gold   41.2 g × ₹7,412       │ ← Plex Mono
  │                            ⤢     │    │                    ₹3,05,374 │   paper-sunk
  └──────────────────────────────────┘    │ Polki  8.40 ct     ₹1,12,000 │   hairline rows
   ┌────┐┌────┐┌────┐┌────┐┌────┐         │ Making 12%           ₹50,220 │
   │front││BACK││ on ││deta││ 360││        │ GST    3%            ₹14,046 │
   │     ││meena││neck││ il ││    ││       ├──────────────────────────────┤
   └────┘└────┘└────┘└────┘└────┘          │ Total              ₹4,82,000 │
    ↑ reverse is slide 2, never buried     └──────────────────────────────┘
                                            Rate locks for 15 min at checkout.

                                            [    Add to bag              ]   meena fill
                                            [    See it in the shop      ]   outline
                                            ♡ Save          ⇪ Send on WhatsApp

                                            ── The details ──────────────────
                                            Gross weight        43.6 g
                                            Net gold weight     41.2 g
                                            Purity              22K · BIS 916
                                            HUID                HA7X2K
                                            Polki               8.40 ct · 112 st
                                            Certificate         IGI, ships with
                                            Made in             Jaipur
                                            Availability        Ready to ship

                                            ── If it isn't right ────────────
                                            15-day return, full refund.
                                            Lifetime exchange at the day's rate.
                                            Buyback at 90% of gold value.
                                            Insured shipping, free.
  ────────────────────────────────────────────────────────────────────────────
   The reverse                                                                    ← full-bleed section
   ┌──────────────────────────────────────────────────────────────────────────┐
   │        large meena-reverse photograph, field switches to --meena          │
   └──────────────────────────────────────────────────────────────────────────┘
   Two hundred and eleven enamel cells, fired individually. Nobody but you
   will ever see them.                                                            ← the brand, in one caption
```

On phone the gallery becomes a full-bleed swipe deck with a dot rail; the price panel collapses to
price + total, with the breakup one tap away; and a sticky bottom bar carries `Add to bag` plus the
rate-hold timer. The breakup is never hidden behind an accordion on desktop — hiding it is the
behaviour this brand is trying to distinguish itself from.

---

### Does Direction 1 extend or replace the current CSS system?

**It extends the architecture and replaces the values.** Concretely:

**Keep.** `app/globals.css` is 1,678 lines of hand-written BEM against a `:root` token block, with
no framework. That is a good architecture for a site of this size and there is no reason to
introduce Tailwind. Keep the file, keep BEM, keep the reset, keep the `clamp()` approach to section
padding, keep the `prefers-reduced-motion` block (`:1664-1677`).

**Replace (small, contained).** The nine tokens in `:root` (`:8-18`) become roughly thirty — colour
ramp, two font stacks plus a data stack, the type scale, the two-tier spacing scale, two motion
tokens. Add self-hosted `@font-face` declarations or `next/font/local`. This is the highest-value
hour of work in the migration, and on its own it fixes the Times New Roman failure (A1) and both
contrast failures (A3).

**Rewrite (~400 lines).** `.hero`, `.collection*`, `.timeline`, `.section-heading`, `.legacy`,
`.craft`. These carry the ornament and the ad-hoc spacing.

**Survives on token substitution alone (~500 lines).** `.contact*`, `.appointment-dialog`,
`.appointment-form`, `.site-footer`, `.button*`, `.form-error*`, `.dialog-*`. These are structurally
fine; they need new values, not new rules. Mostly find-and-replace.

**Delete outright.** `.legacy::before` / `::after` rings (`:551-575`), `.timeline::after` arc
(`:626-636`), `.craft__image::before` offset frame (`:725-734`), `.collection__frame::after` inner
border (`:467-473`), `.hero__promise` (`:376-388`), `.gold-rule` / `.gold-rule--dark` (`:310-319`),
`body::selection` (`:42-45`, already dead), and `.collection__copy > span` (`:492-498`, the 01/02/03
numbering). That is about 90 lines removed and nothing lost.

**Migration cost.** Roughly **2–3 focused days** for tokens plus the homepage rebuild, plus a day for
font subsetting and self-hosting. Critically, **the storefront (grid, filters, PDP, cart) and the
admin are net-new regardless of which direction wins**, so the direction decision adds no rework
there — provided it is made *before* that work starts. The one genuine new cost is fonts: four
subset `.woff2` files, ≈180 KB, preload the display face only, and add a `size-adjust` fallback so
the swap doesn't shift layout.

**What is not a CSS cost at all:** the photography (A9), the real business details in
`site-config.ts`, and the two founder portraits (Part E). Those gate the launch more than any of
this.

---

## Part D — Admin panel

**The user.** A small shop owner. Not technical. Probably on a phone, standing at a counter, between
customers, possibly at 11pm doing the day's accounts. Reads English fine but does not read
"Processing / Fulfilled / Refunded" as words that mean anything about jewellery.

**The single most important decision: this is not a dashboard.** A dashboard is what gets built when
nobody knows what the user does. This user does one thing — works a queue. So the home screen is
the queue. Charts are a separate, deliberately-entered tab.

### D1. Layout

Single column, mobile-first, `max-width: 720px` **even on desktop**. No sidebar. Navigation is four
items — a bottom tab bar on phone, a row of four text links under the wordmark on desktop:

```
Orders  ·  Enquiries  ·  Catalogue  ·  Numbers
```

`Enquiries` is the existing `appointments` table (`db/schema.ts`) — the appointment form already has
a `status` column with a `new → contacted → booked/closed` workflow, so that surface is half-built
and should be the first admin screen shipped.

**Visual register: deliberately unglamorous.** The admin does not wear meena green and paper. It
uses the neutral chart surfaces from the design-system defaults (`#FCFCFB` light / `#1A1A19` dark)
with system UI sans, because a shop owner reading numbers at 11pm needs contrast, not atmosphere.
The brand appears once, in the wordmark. Brand colours are checked, not assumed:
`--garnet` #560f1b measures **13.8:1** on the light admin surface, so garnet is available as ink and
as a primary button. `--gold` #c89b4b measures **2.5:1**, below the 3:1 non-text floor, so **gold is
never used for a chart series, a status dot, a border, or a label in the admin.**

### D2. Orders list — information hierarchy

The header is one line of plain text, not a row of stat tiles:

```
6 new  ·  3 to dispatch  ·  2 awaiting payment
```

Each phrase is a filter link. Rationale, from the form heuristic: these are counts of things the
owner must *act on*, so they belong as filters. A stat tile you cannot click is a dead end, and four
KPI cards at the top of a queue screen is the canonical dashboard mistake.

Then the rows, ~96px each, entire row tappable:

```
┌──────────────────────────────────────────────────────────┐
│  Priya Sharma                              ₹1,84,500     │  name 18px semibold · amount 18px tabular
│  #1042 · Polki necklace · 22K · 18.4g      2 items       │  13px mono id, 14px ink-2
│  Placed 2h ago                    ● Payment pending      │  status = dot + word, never colour alone
│  [ Call ]              [ WhatsApp ]                      │  44px targets, on the row
└──────────────────────────────────────────────────────────┘
```

Three deliberate choices:
- **The customer's name is the largest thing on the row**, not the order ID. The owner recognises
  people; the ID is a lookup key and belongs in muted mono.
- **Call and WhatsApp live on the row, not inside the detail page.** Follow-up on Indian jewellery
  orders happens by phone, and forcing a tap-through to find a number is the most common admin
  design failure in this category. `tel:` link and a `wa.me` deep link with the order number
  prefilled in the message body.
- **Status is a coloured dot plus the word.** Status colours are reserved (good / warning / serious /
  critical) and never reused as category colours, and they always ship with a label so meaning never
  rides on hue alone.

**Status vocabulary uses the shop's words, not the system's:**

```
New  →  Confirmed  →  Making  →  Ready  →  Delivered            (+ Cancelled)
```

"Making" is a real state for a jeweller — a piece being made, sized or set — and no generic
e-commerce status vocabulary has a word for it. Naming it correctly is most of what makes an admin
feel built for the business rather than adapted to it.

### D3. Order detail — information hierarchy, top to bottom

1. **Customer + contact.** Name at 22px, phone below it, `Call` and `WhatsApp` as the first two
   tappable things on the screen. This is above the order contents on purpose.
2. **What they ordered.** 64px thumbnail (front image; tap flips to reverse for identification —
   the Direction 1 signature, reused where it is functionally useful), name, SKU, metal and purity,
   gross and net weight, stone detail, quantity, line total.
3. **Money, itemised exactly as the storefront PDP showed it.** Metal value (rate × net weight),
   making charges, stone value, GST, total, then paid and balance. If a single number here differs
   from what the customer saw on the product page, the shop loses that argument on the phone.
4. **The locked gold rate and its timestamp** — `22K ₹7,412/g · locked 14 Aug, 11:04`, in mono. This
   one field prevents most price disputes and belongs on the detail page, not in a log.
5. **Delivery address with a `Copy` button.** Owners paste into courier portals. One button saves a
   transcription error on every order.
6. **Status changer as a segmented row**, current state highlighted — not a `<select>`. A dropdown
   hides the state machine; a visible row teaches it.
7. **Append-only note log with timestamps**, not editable. This is the answer to "did I already call
   her?", which is the question the owner actually opens the app to answer.

### D4. Phone-first, non-technical details that decide whether it gets used

- Amounts in Indian digit grouping — `₹1,84,500` via `Intl.NumberFormat('en-IN')` — with
  `font-variant-numeric: tabular-nums` in every column so figures align down the list.
- Dates as `Today, 11:04 AM` / `Yesterday` / `14 Aug`. Never ISO, never relative-only.
- **Search matches phone number as you type.** Owners search by number, because the number is what
  the customer reads out on the call. Name and order-ID matching are secondary.
- One **`Export today's orders` → CSV** button. Owners hand this to their accountant. It is four
  lines of code and it is the most-requested feature in Indian retail admin tooling.
- Renders from cache with a `last updated 11:04` line, because shop wifi is unreliable and a
  spinner over an empty screen reads as "the site is down."
- 44px minimum targets; destructive actions use a full-screen confirm sheet on phone, never a modal.

### D5. The `Numbers` tab — and only three things in it

Metrics live behind a deliberate tap, because none of them change what the owner does in the next
five minutes. When they are shown, they follow the visualisation method: pick the form first, assign
colour by job, validate, then apply mark specs.

1. **Today's revenue as a hero figure, not a chart.** One large tabular number, a small label, and a
   plain-language comparison underneath: `₹2,41,300 today` / `₹1,84,000 the same day last week`.
   A single headline value is a stat tile's job; wrapping it in a chart adds nothing.
2. **Orders per day, last 30 days — one bar chart, one series.** Single series, so **no legend** —
   the title names it. 2px surface gap between bars, 4px rounded tops anchored to the baseline,
   hairline recessive gridlines, per-bar hover tooltip. One colour throughout (the sequential blue's
   mid step, `#2a78d6` light / `#3987e5` dark), because there is nothing to distinguish.
3. **Top categories this month — horizontal ranked bars**, value direct-labelled at the end of each
   bar, maximum six rows then `Other`. These bars are already identified by their row labels, so
   they take **one hue**, not six. Assigning six categorical colours to six labelled rows is
   decoration pretending to be encoding.

Explicitly **not** built: revenue-over-time line charts on the home screen, conversion funnels, an
AOV tile, a customer map, or any dual-axis chart. And no chart on this screen may use gold — at
2.5:1 on the light surface it fails the non-text contrast floor, which is exactly why the storefront
demotes it too.

Dark mode for the admin is real, not an inversion: its own steps against `#1A1A19`, declared under
both `prefers-color-scheme` and a `[data-theme]` scope so a manual toggle wins in both directions.
A table view of the same numbers is always one tap away.

---

## Part E — Founders page

**The trap to avoid:** two circular headshots side by side, name, job title, two-sentence bio. That
is the about page of a dental practice, and it actively works against the brief — job titles are the
single most "not modern" thing a founder page can contain.

**Page title:** plain and descriptive. `The people` or `Who makes this`. Not "Our Story", not
"Legacy", not "The Alankar Family" — all three are the register the brand is trying to escape.

### E1. Structure, top to bottom

**1 — One sentence, no image.** Full-width, `--d-l`, left-aligned in a 60% column, with macro space
above and below. It states the tension in the brand's own voice before showing a single face. The
form matters more than the words; the words are the owner's to approve. As a working example:

> The techniques are two hundred years old. The people are not.

Eleven words that do the entire job of the brief. If the page earns nothing else, it earns this.

**2 — Portrait one.** 4:5 portrait, large, bleeding to the edge of its column. **Not a headshot** —
an environmental portrait at the bench or behind the counter, so the room does the heritage work and
the person doesn't have to perform it.

Caption below, in the utility face:

```
Rajesh Jain — buys the stones.
```

**Roles as verbs, not titles.** "Buys the stones" / "Draws the pieces" / "Runs the bench." One copy
decision that does more "modern" work than any layout choice on the page, because it says these are
people with jobs rather than an org chart.

**3 — Their own words, first person.** Two or three short paragraphs, `--t-md`, max 62ch, set beside
or below the portrait. First person is the whole trick: *"Rajesh founded Alankar in 1980 with a
vision to…"* is corporate; *"My father would not let me touch a stone until I could name it"* is a
person. Close with a **pull quote** — one line at `--d-m`, indented, a hairline above it only, and
**no quotation marks**. The type change already signals speech; the marks are decoration.

**4 — The hinge: an object strip.** This is where most founder pages fail — they simply repeat the
first block for the second person, and two identical blocks read as a list. Put something between
them that belongs to neither: a horizontal strip of **five square photographs of objects**, each
with a one-line caption.

```
┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐
│ loupe│ │ledger│ │packet│ │ punch│ │ scale│
└──────┘ └──────┘ └──────┘ └──────┘ └──────┘
 10× since  kept in   stones travel  the BIS   accurate to
 1980       Mahajani  in paper       mark      0.01 g
```

Three reasons this specific element: objects are the connective tissue between two people; they show
the craft without requiring a third good portrait; and they can be shot beautifully with a phone and
a window, which means they will actually get shot. The loupe, the bahi-khata ledger, the folded
glassine stone packet, the hallmark punch and the scale are also the five most credible objects in
the shop — each one is quiet proof.

**5 — Portrait two, mirrored.** Same aspect, same treatment, opposite alignment. The mirroring is
what makes two portraits read as a *pair* rather than a list. Same caption grammar, same first-person
treatment, same pull-quote close.

**6 — "What changed" — the load-bearing section for this brief.** Three or four items, one sentence
each. Not numbered, not a timeline (the current site already has a timeline that isn't one — A6).
Each states a concrete, checkable thing the newer generation actually changed:

> Every stone now leaves with its certificate.
> We publish the day's gold rate on this website.
> You can see the reverse of every piece before you buy it.
> Buyback is 90%, written down, not negotiated.

This is the entire "modern" claim, and it is made in verifiable facts rather than adjectives. It is
the direct replacement for `page.tsx:58-79`, where four milestones say nothing that could be untrue
of any jeweller.

**7 — Signature.** At most one, from the founder, as an inline SVG single path stroked in `--ink`
(never gold), at small size. **Only if a real signature exists** — a set signature typeface is
exactly the kind of thing this audience notices, and a fake one costs more credibility than a real
one earns.

**8 — Close on a named CTA.** Not "Book an Appointment." On this page it reads:

```
Ask for Rajesh.       [ Book a viewing ]
```

Naming a person is the highest-converting change available on a founder page, because the entire
premise of a 45-year-old jeweller is that you are buying from *someone*. It also fixes A10.6 — this
becomes a second, warmer entry point to the same form, with a different promise.

### E2. Photography direction for the two portraits

"Get good photos" is useless advice, so, specifically:

- **Both shot the same day, same lens (35mm or 50mm equivalent), same window light, no flash, no
  seamless backdrop.** Portraits taken months apart never look like a pair, no matter the layout.
- **In the shop**, with real depth behind them — the safe, the counter, the mirror, the stock. The
  room carries the heritage so the person doesn't have to signal it.
- **No arms crossed. No middle-distance gaze. No black-and-white.** Monochrome on a founder portrait
  is the single strongest "dusty" tell available.
- **One of the two looks at the camera and one does not.** Two identical poses read as a corporate
  slide; asymmetry reads as two people.
- **4:5, minimum 2400px on the short edge**, so the page holds at 2× on a 1440px laptop — a direct
  correction of the current 1024×1536 upscaling problem (A9).
- **Graded warm-neutral against the cool `--paper` ground.** The skin tones then become the warmest
  thing on the page, which is exactly right for a page about people.

### E3. Layout behaviour

Desktop: portrait and text share a 12-column grid — image on 1–6, text on 8–12 for the first
founder; mirrored for the second. Object strip is full-width inside the content measure.

Phone: everything stacks, and the portraits go **full-bleed edge to edge with no side padding**.
That is the one place in the whole design where the grid should be broken, because a face at full
device width is the most arresting thing a phone screen can do — and this page's job is to make two
people memorable.
