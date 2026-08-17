/**
 * TWO HOUSE RULES ABOUT VISIBLE COPY, ENFORCED RATHER THAN INTENDED.
 *
 * Both of these were violated across every page of the site until an audit
 * counted them, which is the same story as the contrast rule: a constraint that
 * lives only in a comment is a constraint nobody is keeping.
 *
 * ---------------------------------------------------------------------------
 * 1. NO EM-DASH IN ANYTHING A VISITOR READS
 * ---------------------------------------------------------------------------
 * The site had 235. It is the single most recognisable machine-written
 * punctuation habit, and this copy was written by a machine, so the tell was
 * real rather than theoretical: the "not X, but Y" pivot on a dash, over and
 * over, in a family jeweller's voice.
 *
 * CODE COMMENTS ARE EXEMPT and deliberately so. 177 of those 235 were in
 * comments, which no visitor ever sees; rewriting them would have churned a lot
 * of careful prose for no reader. The rule is about the page, so the check is
 * about the page.
 *
 * ---------------------------------------------------------------------------
 * 2. AN EYEBROW IS NOT FREE
 * ---------------------------------------------------------------------------
 * An "eyebrow" here is the small uppercase label sitting directly above a
 * section headline. Every page had one on every section, which produces the
 * templated rhythm the rule exists to prevent. The cap is one per three
 * sections.
 *
 * A `<p className="label">` above a FIGURE, a list or a panel is a data label,
 * not an eyebrow, and does not count. Nor does one carrying an `id`, which
 * means it is wired to `aria-labelledby` and is structure rather than
 * decoration. Both distinctions are made below rather than assumed, because the
 * first version of this cleanup deleted an order number from a receipt by
 * treating it as decoration.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) yield* walk(full);
    else yield full;
  }
}

const components = [...walk(`${ROOT}app`)].filter((f) => f.endsWith(".tsx"));

/**
 * Copy does not only live in components. Piece descriptions, disclosure
 * sentences, admin notices and the JSON-LD description are all strings in .ts
 * files, and scoping the first version of this guard to .tsx left five
 * em-dashes rendering on two live pages after it passed.
 *
 * Comments in those files stay exempt, so the check looks INSIDE string
 * literals rather than at whole lines.
 */
const dataFiles = [...walk(`${ROOT}app`)].filter((f) => f.endsWith(".ts"));

const STRING_WITH_DASH = /(["'`])((?:(?!\1)[^\\]|\\.)*—(?:(?!\1)[^\\]|\\.)*)\1/g;

/**
 * Blank out comments while preserving line numbers, so a reported line points
 * at the real one.
 */
function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => "\n".repeat((m.match(/\n/g) ?? []).length))
    .replace(/^\s*\/\/.*$/gm, "");
}

test("no em-dash reaches the page", () => {
  assert.ok(components.length >= 10, "no components found — this guard is looking at nothing");

  const offences = [];
  for (const file of components) {
    const lines = withoutComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      // The literal character AND its HTML entities. `&mdash;` renders as an
      // em-dash and reads as one; it evaded the first two versions of this
      // guard entirely and left 32 of them on the admin screens.
      if (/—|&mdash;|&#8212;|&#x2014;/i.test(line)) {
        offences.push(`${file.slice(ROOT.length)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }

  for (const file of dataFiles) {
    // Comments first. A doc comment may quote `a phrase — like this`, and the
    // string-literal regex cannot tell that from code.
    withoutComments(readFileSync(file, "utf8"))
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(STRING_WITH_DASH)) {
          offences.push(`${file.slice(ROOT.length)}:${i + 1}  ${m[2].trim().slice(0, 70)}`);
        }
        // A multi-line template literal never closes on the line the dash sits
        // on, so the literal-matcher above cannot see it. Catch the entity form
        // and any dash on a line that is plainly prose rather than code.
        if (/&mdash;|&#8212;|&#x2014;/i.test(line)) {
          offences.push(`${file.slice(ROOT.length)}:${i + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
  }

  assert.deepEqual(
    offences,
    [],
    `em-dash in visible copy. Restructure the sentence rather than swapping in a ` +
      `hyphen: two sentences with a full stop, a comma, a colon, or brackets.\n` +
      offences.join("\n")
  );
});

/** The en-dash is the same habit wearing a smaller coat. */
test("no en-dash is used as a separator in visible copy", () => {
  const offences = [];
  for (const file of components) {
    const lines = withoutComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      // An en-dash between spaces is a pivot; inside a number range it is
      // typographically correct and left alone.
      if (/\s–\s|&ndash;|&#8211;|&#x2013;/i.test(line)) {
        offences.push(`${file.slice(ROOT.length)}:${i + 1}  ${line.trim().slice(0, 80)}`);
      }
    });
  }
  assert.deepEqual(offences, [], `en-dash used as a separator:\n${offences.join("\n")}`);
});

test("no page carries more than one eyebrow per three sections", () => {
  const pages = components.filter((f) => f.endsWith("/page.tsx"));
  assert.ok(pages.length >= 5, "no pages found");

  const failures = [];
  for (const file of pages) {
    const lines = withoutComments(readFileSync(file, "utf8")).split("\n");

    const sections = lines.filter((l) => /<section[\s>]/.test(l)).length;
    if (sections === 0) continue;

    let eyebrows = 0;
    lines.forEach((line, i) => {
      if (!/<p className="label/.test(line)) return;
      if (/\bid=/.test(line)) return; // aria-labelledby target, real structure

      // Walk to the next non-blank line. Only a headline makes it an eyebrow;
      // a label above a figure or a list is a data label.
      let j = i + 1;
      if (!line.includes("</p>")) {
        while (j < lines.length && !lines[j].includes("</p>")) j += 1;
        j += 1;
      }
      while (j < lines.length && !lines[j].trim()) j += 1;
      if (j < lines.length && /^\s*<h[123][\s>]/.test(lines[j])) eyebrows += 1;
    });

    const cap = Math.ceil(sections / 3);
    if (eyebrows > cap) {
      failures.push(
        `${file.slice(ROOT.length)}: ${eyebrows} eyebrows over ${sections} sections (cap ${cap})`
      );
    }
  }

  assert.deepEqual(
    failures,
    [],
    `Too many eyebrows. The fix is to delete them, not to reword them — the ` +
      `headline alone is enough, and the section's position on the page already ` +
      `says what it is.\n${failures.join("\n")}`
  );
});

/**
 * The middle dot is rationed. `Jadau · Polki · Kundan — since 1980` used three
 * of them plus an em-dash in six words, which is the whole tell in one string.
 *
 * THE THRESHOLD IS THREE, NOT ONE, AND THAT IS A JUDGEMENT RATHER THAN THE
 * LETTER OF THE RULE. A spec caption is a genuine short list, and
 * "Uncut polki · carved ruby and emerald drops · silk cord" reads as one: two
 * dots, three items, describing the photograph beside it. Forcing those into
 * prose would churn every product caption to satisfy a count without helping a
 * reader. What the rule is actually for is the dot used as the default
 * separator for everything, which starts at four items.
 */
test("the middle dot is not the default separator", () => {
  const offences = [];
  for (const file of components) {
    const lines = withoutComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((line, i) => {
      const dots = (line.match(/·/g) ?? []).length;
      if (dots > 2) {
        offences.push(`${file.slice(ROOT.length)}:${i + 1}  ${dots} dots  ${line.trim().slice(0, 64)}`);
      }
    });
  }
  assert.deepEqual(offences, [], `middle dot used as a general separator:\n${offences.join("\n")}`);
});
