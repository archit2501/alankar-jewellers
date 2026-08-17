/**
 * THE INVERTED GOLD RULE, ENFORCED RATHER THAN DESCRIBED.
 *
 * `app/tokens.css` has carried this rule in a comment block since the design
 * system was written:
 *
 *     GOLD IS TEXT ON DARK FIELDS AND NEVER ON LIGHT ONES.
 *
 * It shaped every field, every button and every rule on the site, and until now
 * nothing checked it. Two consequences of that, both real:
 *
 *   1. `--ink-3` sat at 4.40:1 on `--plaster-lift` for weeks. It is the
 *      placeholder colour in three forms, it was below the 4.5:1 floor, and it
 *      was found by an audit rather than by the suite.
 *   2. The comment's own figures drifted from the tokens they described the
 *      moment the palette moved.
 *
 * So the numbers are computed from the FILE, not copied from it. If someone
 * edits a hex, this fails; if someone edits the comment, the comment is wrong
 * and this still fails on the hex. There is no way to satisfy both except by
 * making the palette actually correct.
 *
 * WCAG 2.1 relative luminance, sRGB, per the published formula.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Every `--token: #rrggbb;` declared in tokens.css. */
function readTokens() {
  const css = readFileSync(`${ROOT}app/tokens.css`, "utf8");
  const out = new Map();
  for (const m of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    out.set(m[1], m[2].toLowerCase());
  }
  return out;
}

function luminance(hex) {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  const [hi, lo] = x > y ? [x, y] : [y, x];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every file under a directory, recursively. */
function* readdirSyncDeep(dir) {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) yield* readdirSyncDeep(full);
    else yield full;
  }
}

/** Comments may legitimately discuss the retired palette; declarations may not. */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const T = readTokens();

function pair(fg, bg) {
  const f = T.get(fg);
  const b = T.get(bg);
  assert.ok(f, `token --${fg} is not declared in tokens.css`);
  assert.ok(b, `token --${bg} is not declared in tokens.css`);
  return ratio(f, b);
}

/* =========================================================================
 * 1. Gold IS legal on every dark field
 * ====================================================================== */

test("gold reads as body text on every ceremonial field", () => {
  for (const field of ["meena", "meena-deep", "meena-lift", "teak", "teak-deep"]) {
    const r = pair("gold", field);
    assert.ok(
      r >= 4.5,
      `--gold on --${field} is ${r.toFixed(2)}:1, below the 4.5:1 body-text floor`
    );
  }
});

test("gold-leaf clears AAA on the two darkest fields", () => {
  for (const field of ["meena", "meena-deep"]) {
    const r = pair("gold-leaf", field);
    assert.ok(r >= 7, `--gold-leaf on --${field} is ${r.toFixed(2)}:1, below AAA`);
  }
});

/* =========================================================================
 * 2. Gold is ILLEGAL on every light field — the half everyone forgets
 * ====================================================================== */

test("gold is not legible on any light field, and must never be used as one", () => {
  for (const field of ["plaster", "plaster-lift", "plaster-sunk", "ivory"]) {
    const r = pair("gold", field);
    assert.ok(
      r < 4.5,
      `--gold on --${field} is ${r.toFixed(2)}:1. If this now PASSES, the palette ` +
        `changed underneath the rule and the ban in tokens.css needs rewriting rather ` +
        `than deleting.`
    );
  }
});

test("brass is never a letterform on plaster", () => {
  const r = pair("brass", "plaster");
  assert.ok(r < 4.5, `--brass on --plaster is ${r.toFixed(2)}:1 — it must stay ornament-only`);
});

/* =========================================================================
 * 3. The light field's own text, including the token that was failing
 * ====================================================================== */

test("every ink tone is legible on every light ground it can land on", () => {
  const grounds = ["plaster", "plaster-lift", "plaster-sunk"];
  for (const ink of ["ink", "ink-2", "ink-3"]) {
    for (const ground of grounds) {
      const r = pair(ink, ground);
      assert.ok(
        r >= 4.5,
        `--${ink} on --${ground} is ${r.toFixed(2)}:1. --ink-3 in particular is the ` +
          `placeholder colour and sat at 4.40:1 before the palette moved.`
      );
    }
  }
});

test("sindoor is the light-field accent, and earns it", () => {
  for (const ground of ["plaster", "plaster-lift"]) {
    const r = pair("sindoor", ground);
    assert.ok(r >= 4.5, `--sindoor on --${ground} is ${r.toFixed(2)}:1`);
  }
});

test("ivory carries body text on the ceremonial fields", () => {
  for (const field of ["meena", "meena-deep", "teak-deep"]) {
    const r = pair("ivory", field);
    assert.ok(r >= 4.5, `--ivory on --${field} is ${r.toFixed(2)}:1`);
  }
});

/* =========================================================================
 * 4. The comment cannot drift from the tokens
 * ====================================================================== */

/**
 * tokens.css prints four figures in its rule block. They are the first thing a
 * reader trusts and the last thing anyone updates, so they are checked against
 * the computed value with the same tolerance a rounded figure deserves.
 */
test("the ratios printed in tokens.css match the tokens it declares", () => {
  const css = readFileSync(`${ROOT}app/tokens.css`, "utf8");
  const claims = [...css.matchAll(/--(\S+) on --(\S+)\s+([\d.]+):1/g)];

  assert.ok(claims.length >= 4, "the rule block no longer prints its figures");

  for (const [, fg, bg, claimed] of claims) {
    const actual = pair(fg, bg);
    assert.ok(
      Math.abs(actual - Number(claimed)) < 0.02,
      `tokens.css claims --${fg} on --${bg} is ${claimed}:1, actual ${actual.toFixed(2)}:1`
    );
  }
});

/**
 * The palette that was replaced. Not nostalgia: the reason for the change was
 * that this exact family is what every generative tool produces for a premium
 * heritage brief, so drifting back to it is a real failure mode, not a
 * hypothetical one.
 */
test("the retired palette has not crept back in, in any colour notation", () => {
  const retired = {
    "#4a0e17": "oxblood",
    "#2e080e": "oxblood-deep",
    "#61151f": "oxblood-lift",
    "#ede3d0": "the cream plaster",
    "#f6efe0": "the cream plaster-lift",
    "#dccdb2": "the cream plaster-sunk",
    "#1c1611": "the espresso ink",
    "#4f4034": "the espresso ink-2",
    "#7d6c5b": "the ink-3 that measured 4.40:1",
    "#1b4d3e": "the old decorative emerald",
  };

  /**
   * WHY THIS NORMALISES INSTEAD OF MATCHING STRINGS.
   *
   * The first version of this guard only read tokens.css and missed nine live
   * declarations. The second listed three rgb() triples by hand and missed a
   * fourth on the very next deploy — a modal shadow written
   * `rgba(28, 22, 17, 0.42)`, which is the retired ink and looks like nothing
   * at all. Enumerating notations is a losing game: #rgb, #rrggbb, #rrggbbaa,
   * rgb(), rgba(), and any spacing inside them all name the same colour.
   *
   * So every colour in every stylesheet is reduced to #rrggbb first, and the
   * comparison happens there.
   */
  const toHex = (r, g, b) =>
    "#" + [r, g, b].map((n) => Number(n).toString(16).padStart(2, "0")).join("");

  function coloursIn(css) {
    const found = new Set();
    for (const m of css.matchAll(/#([0-9a-fA-F]{3,8})\b/g)) {
      const h = m[1].toLowerCase();
      if (h.length === 3) found.add("#" + [...h].map((c) => c + c).join(""));
      else if (h.length >= 6) found.add("#" + h.slice(0, 6));
    }
    for (const m of css.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/g)) {
      found.add(toHex(m[1], m[2], m[3]));
    }
    return found;
  }

  const sheets = [...readdirSyncDeep(`${ROOT}app`)].filter((f) => f.endsWith(".css"));
  assert.ok(sheets.length >= 5, "no stylesheets found — this guard is looking at nothing");

  for (const file of sheets) {
    const painted = coloursIn(stripComments(readFileSync(file, "utf8")));
    const rel = file.slice(ROOT.length);
    for (const [hex, name] of Object.entries(retired)) {
      assert.ok(
        !painted.has(hex),
        `${rel} still paints ${hex} (${name}), in some notation — that is the retired family`
      );
    }
  }
});
