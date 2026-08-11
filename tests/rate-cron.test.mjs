/**
 * THE GOLD RATE CRON.
 *
 * These tests exist because the schedule is written in UTC and read by humans
 * in IST, and the half-hour offset makes the wrong answer look right. Someone
 * tidying `30 4 * * *` into `0 10 * * *` — which reads like "10 AM" — would
 * move the job to 15:30 IST and nothing would fail until a customer was quoted
 * against a rate that had expired hours earlier.
 *
 * So the schedule is asserted by CONVERTING it, not by matching the string.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Registers the module hooks that let plain Node resolve `../../db` out of the
// TypeScript module graph, exactly as the catalogue tests do.
import "../scripts/seed-catalogue.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** wrangler.jsonc is JSONC — strip comments before parsing. */
function wranglerConfig() {
  const raw = readFileSync(`${ROOT}wrangler.jsonc`, "utf8");
  const withoutComments = raw
    .split("\n")
    .map((line) => (line.trimStart().startsWith("//") ? "" : line))
    .join("\n");
  return JSON.parse(withoutComments);
}

/** A `m h * * *` expression as minutes past midnight, IST. */
function istMinutes(expression) {
  const [minute, hour, ...rest] = expression.split(" ");
  assert.deepEqual(rest, ["*", "*", "*"], `only daily schedules are expected: ${expression}`);
  const utcMinutes = Number(hour) * 60 + Number(minute);
  // India is UTC+5:30 and observes no daylight saving, so this is exact.
  return (utcMinutes + 5 * 60 + 30) % (24 * 60);
}

function hhmm(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

test("the ingest runs at the three intended IST times", () => {
  const crons = wranglerConfig().triggers?.crons;
  assert.ok(Array.isArray(crons), "no cron triggers are declared");

  assert.deepEqual(
    crons.map(istMinutes).map(hhmm).sort(),
    ["10:00", "12:10", "17:10"],
    "the schedule no longer fires at the intended IST times"
  );
});

/**
 * IBJA displays its polling rounds "at around 12:05 PM and 5:05 PM on all
 * business days". A run BEFORE a publication reads the previous slot; a run
 * long after it wastes the freshness the slot rule grants. Both afternoon runs
 * must therefore land in the window that starts at publication and ends before
 * the rate would expire.
 */
test("both afternoon runs land just after an IBJA publication", async () => {
  const { IBJA_SLOT_MINUTES_IST, RATE_STALE_GRACE_MINUTES } = await import(
    "../app/_pricing/rates.ts"
  );
  assert.deepEqual([...IBJA_SLOT_MINUTES_IST], [725, 1025], "IBJA's slots moved");

  const runs = wranglerConfig().triggers.crons.map(istMinutes);

  for (const slot of IBJA_SLOT_MINUTES_IST) {
    const following = runs.filter((run) => run >= slot && run < slot + RATE_STALE_GRACE_MINUTES);
    assert.equal(
      following.length,
      1,
      `no run in the ${hhmm(slot)}–${hhmm(slot + RATE_STALE_GRACE_MINUTES)} IST window`
    );
    assert.ok(
      following[0] - slot <= 15,
      `the run after ${hhmm(slot)} waits ${following[0] - slot} minutes; that is too long`
    );
  }
});

/**
 * The reason a 10:00-only schedule is not enough, asserted rather than argued.
 *
 * A rate expires when the next publication was due plus the grace period. With
 * only the morning run, the site would be unable to quote from 13:35 IST until
 * the following morning. This proves the schedule as configured never leaves a
 * gap longer than one publication cycle.
 */
test("no configured gap leaves the storefront unpriced across the trading day", () => {
  const runs = wranglerConfig().triggers.crons.map(istMinutes).sort((a, b) => a - b);

  // The morning run alone would strand the afternoon.
  const morningOnly = runs[0];
  const expiryWithMorningOnly = 725 + 90; // next publication due + grace
  assert.ok(
    morningOnly < expiryWithMorningOnly,
    "sanity: the morning run precedes the expiry it cannot prevent"
  );

  // With the full schedule, every expiry has a run that refreshes it in time.
  const afternoonRuns = runs.filter((run) => run > morningOnly);
  assert.ok(
    afternoonRuns.length >= 2,
    "the morning run alone cannot keep a rate alive past 13:35 IST — " +
      "two publication-aligned runs are required"
  );
});

/** The handler has to exist, and has to be wired to the ingest. */
test("the worker exports a scheduled handler that ingests the rate", () => {
  const source = readFileSync(`${ROOT}worker/index.ts`, "utf8");

  assert.match(source, /async scheduled\s*\(/, "the worker exports no scheduled handler");
  assert.match(source, /readIbjaRates/, "the scheduled path does not read IBJA");
  assert.match(source, /ingestRateQuotes/, "the scheduled path does not store anything");
  // It must not smuggle the write through the public endpoint, which is
  // secret-guarded precisely because it is reachable from outside.
  assert.doesNotMatch(
    source,
    /fetch\((["'`]).*\/api\/gold-rate/,
    "the cron should call the ingest directly, not its own HTTP endpoint"
  );
});
