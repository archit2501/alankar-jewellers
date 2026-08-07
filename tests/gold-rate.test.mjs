import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { env } from "cloudflare:workers";

import { fetchWorker, postJson } from "./helpers.mjs";

/**
 * Gold-rate ingestion and the fail-closed read path.
 *
 * NO TEST HERE TOUCHES THE NETWORK. `globalThis.fetch` is replaced with a stub
 * serving the fixture below, which is a trimmed copy of the real markup taken
 * from ibjarates.com on 2026-08-08 at 03:17 IST — same span ids, same values,
 * same archive-row shape. That fixture is the whole reason `rates.ts` splits
 * parsing (pure) from fetching (one thin function).
 *
 * There is also no D1 binding in-process, so `getDb()` throws. That is used
 * deliberately: it is the exact production incident "the database is gone" and
 * it proves the route refuses to quote rather than quoting zero.
 */

const TOKEN = "test-ingest-token-0123456789abcdef";

/**
 * Trimmed from the live page. Values are the real ones published for
 * 2026-08-07: gold ₹ per 10 g, silver ₹ per 1 kg (IBJA's own footer says
 * "Gold rates per 10gm & Silver rate per 1kg").
 */
const IBJA_FIXTURE = `<!DOCTYPE html><html><body>
<table id="TodayRatesTableDataYes" class="tableContainer ctrate">
<tr><th>Purity</th><th>AM</th><th>PM </th></tr>
<tr><td>Gold 999</td>
  <td><span id="lblGold999_AM">149020</span></td>
  <td><span id="lblGold999_PM">149621</span></td></tr>
<tr><td>Gold 995</td>
  <td><span id="lblGold995_AM">148423</span></td>
  <td><span id="lblGold995_PM">149022</span></td></tr>
<tr><td>Gold 916</td>
  <td><span id="lblGold916_AM">136502</span></td>
  <td><span id="lblGold916_PM">137053</span></td></tr>
<tr><td>Gold 750</td>
  <td><span id="lblGold750_AM">111765</span></td>
  <td><span id="lblGold750_PM">112216</span></td></tr>
<tr><td>Gold 585</td>
  <td><span id="lblGold585_AM">87177</span></td>
  <td><span id="lblGold585_PM">87528</span></td></tr>
<tr><td>Silver 999</td>
  <td><span id="lblSilver999_AM">229950</span></td>
  <td><span id="lblSilver999_PM">231381</span></td></tr>
<tr><td>Platinum 999</td>
  <td><span id="lblPlatinum999_AM">60120</span></td>
  <td><span id="lblPlatinum999_PM">62707</span></td></tr>
</table>
<table class="table-striped"><tbody>
<tr><td data-label="AM"><strong>06/08/2026</strong></td><td>148361</td></tr>
<tr><td data-label="AM"><strong>05/08/2026</strong></td><td>145577</td></tr>
</tbody></table>
</body></html>`;

/** Real IBJA markup with the 916 row renamed — i.e. the site changed shape. */
const IBJA_CHANGED_MARKUP = IBJA_FIXTURE.replace(/lblGold916_/g, "lblGold22K_");

/** Real IBJA markup where 750 has been replaced by something non-numeric. */
const IBJA_GARBAGE_FIGURE = IBJA_FIXTURE.replace(">111765<", ">N/A<").replace(
  ">112216<",
  ">N/A<"
);

let fetchCalls;
let originalFetch;
let respondWith;

beforeEach(() => {
  fetchCalls = [];
  respondWith = () => new Response(IBJA_FIXTURE, { status: 200 });
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push(String(url));
    return respondWith(String(url), init);
  };
  env.GOLD_RATE_INGEST_TOKEN = TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete env.GOLD_RATE_INGEST_TOKEN;
});

const auth = { Authorization: `Bearer ${TOKEN}` };

/* ==========================================================================
 * GET — the fail-closed read path
 * ======================================================================= */

test("GET refuses with 503 when the rate store is unreachable, never a 200 with a null rate", async () => {
  const response = await fetchWorker("/api/gold-rate?fineness=916");
  const body = await response.json();

  // No D1 binding in-process => getDb() throws => this is the "database gone"
  // incident. The storefront must be told it may not price.
  assert.equal(response.status, 503);
  assert.equal(body.ok, false);
  assert.equal(body.reason, "rate_store_unavailable");
  // Nothing in the payload can be mistaken for a price.
  assert.equal(body.rate, undefined);
  assert.equal(body.ratePerTenGramsPaise, undefined);
});

test("GET never allows a stale rate to be cached at the edge", async () => {
  const response = await fetchWorker("/api/gold-rate");
  assert.match(response.headers.get("cache-control") ?? "", /no-store/);
});

test("GET rejects karat values and unknown finenesses", async () => {
  for (const fineness of ["22", "24", "900", "abc", "0"]) {
    const response = await fetchWorker(`/api/gold-rate?fineness=${fineness}`);
    const body = await response.json();
    assert.equal(response.status, 400, `accepted a bad fineness: ${fineness}`);
    assert.equal(body.ok, false);
    assert.match(body.error, /fineness/i);
  }
});

test("GET rejects an unsupported metal", async () => {
  const response = await fetchWorker("/api/gold-rate?metal=platinum&fineness=999");
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.match(body.error, /gold.*silver/i);
});

test("GET defaults to gold 916 — IBJA's 22K line", async () => {
  const bare = await fetchWorker("/api/gold-rate");
  const explicit = await fetchWorker("/api/gold-rate?metal=gold&fineness=916");
  assert.equal(bare.status, explicit.status);
  assert.equal((await bare.json()).reason, (await explicit.json()).reason);
});

/* ==========================================================================
 * POST — ingestion is not open to the public
 * ======================================================================= */

test("ingestion without a token is refused", async () => {
  const { status, body } = await postJson("/api/gold-rate", { mode: "ibja" });
  assert.equal(status, 401);
  assert.equal(body.ok, false);
  assert.equal(fetchCalls.length, 0, "an unauthenticated caller must never trigger a fetch");
});

test("ingestion with the wrong token is refused", async () => {
  const { status } = await postJson(
    "/api/gold-rate",
    { mode: "ibja" },
    { Authorization: "Bearer not-the-token" }
  );
  assert.equal(status, 401);
  assert.equal(fetchCalls.length, 0);
});

test("a token of the right length but wrong bytes is still refused", async () => {
  const { status } = await postJson(
    "/api/gold-rate",
    { mode: "ibja" },
    { Authorization: `Bearer ${"x".repeat(TOKEN.length)}` }
  );
  assert.equal(status, 401);
});

test("an unset ingest secret fails closed rather than opening the endpoint", async () => {
  delete env.GOLD_RATE_INGEST_TOKEN;
  const { status, body } = await postJson("/api/gold-rate", { mode: "ibja" }, auth);
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.match(body.error, /GOLD_RATE_INGEST_TOKEN/);
  assert.equal(fetchCalls.length, 0);
});

test("the x-rate-ingest-token header is accepted as an alternative", async () => {
  const { status } = await postJson(
    "/api/gold-rate",
    { mode: "ibja", dryRun: true, asOf: "2026-08-08T06:35:00Z" },
    { "X-Rate-Ingest-Token": TOKEN }
  );
  assert.equal(status, 200);
});

/* ==========================================================================
 * POST ibja — parsing, units and slot derivation, all offline
 * ======================================================================= */

async function dryRun(asOf) {
  return postJson("/api/gold-rate", { mode: "ibja", dryRun: true, asOf }, auth);
}

test("a dry run parses IBJA into paise per TEN grams without writing", async () => {
  // 2026-08-08T06:35Z = 12:05 IST Saturday. Saturday is not a business day, so
  // the most recent publication is Friday 2026-08-07 17:05 IST => the PM column.
  const { status, body } = await dryRun("2026-08-08T06:35:00Z");

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.dryRun, true);
  assert.equal(body.column, "PM");
  assert.equal(body.slot, "2026-08-07T11:35:00.000Z"); // 17:05 IST
  assert.equal(fetchCalls[0], "https://ibjarates.com/");

  const g916 = body.quotes.find((q) => q.metal === "gold" && q.fineness === 916);
  // IBJA published ₹137,053 per 10 g. x100 => paise per 10 g. NOT x1000.
  assert.equal(g916.ratePerTenGramsPaise, 13_705_300);
  assert.equal(g916.sourceQuoteRaw, "137053", "the published figure must survive verbatim");
  assert.equal(g916.displayRupeesPerTenGrams, "1,37,053.00");

  // The 10x guard, stated as an assertion rather than a comment: per GRAM must
  // land in the ~₹13.7k range, not ₹137k and not ₹1,370.
  const perGramRupees = g916.ratePerTenGramsPaise / 100 / 10;
  assert.ok(perGramRupees > 10_000 && perGramRupees < 20_000, `per-gram was ${perGramRupees}`);

  assert.equal(body.quotes.filter((q) => q.metal === "gold").length, 5);
  assert.deepEqual(
    body.quotes.filter((q) => q.metal === "gold").map((q) => q.fineness).sort((a, b) => b - a),
    [999, 995, 916, 750, 585]
  );
});

test("silver converts from ₹/kg to paise per ten grams, not ₹/kg to paise", async () => {
  const { body } = await dryRun("2026-08-08T06:35:00Z");
  const silver = body.quotes.find((q) => q.metal === "silver");

  // ₹231,381 per kg -> 23,138,100 paise per kg -> /100 -> 231,381 paise per 10 g
  // = ₹2,313.81 per 10 g = ₹231.38/g, which is a silver price. ₹231,381 per
  // 10 g would be a gold price, and that is the bug this asserts against.
  assert.equal(silver.fineness, 999);
  assert.equal(silver.ratePerTenGramsPaise, 231_381);
  assert.equal(silver.sourceQuoteRaw, "231381");
  const perGramRupees = silver.ratePerTenGramsPaise / 100 / 10;
  assert.ok(perGramRupees > 100 && perGramRupees < 500, `silver per-gram was ${perGramRupees}`);
});

test("platinum is read but never converted, because IBJA never states its unit", async () => {
  const { body } = await dryRun("2026-08-08T06:35:00Z");
  assert.equal(body.quotes.some((q) => q.metal === "platinum"), false);
  const platinum = body.unconverted.find((row) => row.label === "Platinum999");
  assert.ok(platinum, "the platinum figure should still be surfaced to an operator");
  assert.equal(platinum.sourceQuoteRaw, "62707");
  assert.match(platinum.reason, /unit/i);
});

test("the clock picks the column: a weekday afternoon reads AM, an evening reads PM", async () => {
  // Fri 2026-08-07, 13:00 IST (07:30Z) -> most recent slot is 12:05 IST => AM.
  const morning = await dryRun("2026-08-07T07:30:00Z");
  assert.equal(morning.body.column, "AM");
  assert.equal(morning.body.slot, "2026-08-07T06:35:00.000Z");
  assert.equal(
    morning.body.quotes.find((q) => q.fineness === 916).ratePerTenGramsPaise,
    13_650_200
  );

  // Fri 2026-08-07, 18:00 IST (12:30Z) -> most recent slot is 17:05 IST => PM.
  const evening = await dryRun("2026-08-07T12:30:00Z");
  assert.equal(evening.body.column, "PM");
  assert.equal(
    evening.body.quotes.find((q) => q.fineness === 916).ratePerTenGramsPaise,
    13_705_300
  );
});

test("before the first publication of a business day, the previous evening's slot is used", async () => {
  // Mon 2026-08-10, 09:00 IST (03:30Z). Nothing published yet today, and the
  // preceding two days are the weekend, so this must land on Fri 17:05 IST.
  const { body } = await dryRun("2026-08-10T03:30:00Z");
  assert.equal(body.slot, "2026-08-07T11:35:00.000Z");
  assert.equal(body.column, "PM");
});

test("the derived expiry survives the weekend and dies on Monday, not on Saturday", async () => {
  const { body } = await dryRun("2026-08-08T06:35:00Z");
  // Friday 17:05 IST rate: next publication due Mon 12:05 IST, +90 min grace
  // => Mon 13:35 IST = 08:05Z. A flat 24-hour rule would have killed this rate
  // on Saturday evening with the shop open and no new IBJA publication due.
  assert.equal(body.expiresAt, "2026-08-10T08:05:00.000Z");
});

test("a weekday morning rate expires the same evening, not the next day", async () => {
  const { body } = await dryRun("2026-08-07T07:30:00Z");
  // Fri 12:05 IST rate: next publication Fri 17:05 IST + 90 min => 18:35 IST.
  assert.equal(body.expiresAt, "2026-08-07T13:05:00.000Z");
});

test("the publication slot is the idempotency key, so a retry cannot inflate the trail", async () => {
  const first = await dryRun("2026-08-08T06:35:00Z");
  const second = await dryRun("2026-08-08T09:00:00Z"); // same Friday-PM slot
  assert.equal(first.body.slotRef, second.body.slotRef);
  assert.equal(first.body.slotRef, "ibja:2026-08-07T11:35:00.000Z");
});

test("IBJA's newest archived date is surfaced as an operator sanity check", async () => {
  const { body } = await dryRun("2026-08-08T06:35:00Z");
  assert.equal(body.archiveLatestDate, "06/08/2026");
});

/* ==========================================================================
 * POST ibja — refusing to guess
 * ======================================================================= */

test("a changed IBJA markup is refused outright, not ingested partially", async () => {
  respondWith = () => new Response(IBJA_CHANGED_MARKUP, { status: 200 });
  const { status, body } = await dryRun("2026-08-08T06:35:00Z");

  assert.equal(status, 502);
  assert.equal(body.ok, false);
  assert.match(body.error, /markup/i);
  assert.deepEqual(body.detail, ["Gold916_PM"]);
});

test("a non-numeric IBJA figure is refused rather than guessed at", async () => {
  respondWith = () => new Response(IBJA_GARBAGE_FIGURE, { status: 200 });
  const { status, body } = await dryRun("2026-08-08T06:35:00Z");

  assert.equal(status, 502);
  assert.equal(body.ok, false);
  assert.match(body.error, /not a rupee amount/i);
  assert.deepEqual(body.detail, ["Gold750_PM=N/A"]);
});

test("an IBJA outage is a 502, and nothing is written", async () => {
  respondWith = () => new Response("upstream down", { status: 503 });
  const { status, body } = await dryRun("2026-08-08T06:35:00Z");
  assert.equal(status, 502);
  assert.match(body.error, /IBJA responded 503/);
});

test("a network failure reaching IBJA is a 502, not an exception", async () => {
  respondWith = () => {
    throw new Error("connect ETIMEDOUT");
  };
  const { status, body } = await dryRun("2026-08-08T06:35:00Z");
  assert.equal(status, 502);
  assert.match(body.error, /Could not reach IBJA/);
});

test("a real ingest attempt fails closed when D1 is unavailable", async () => {
  // Not a dry run: this reaches ingestRateQuotes, where getDb() throws.
  const { status, body } = await postJson("/api/gold-rate", { mode: "ibja" }, auth);
  assert.equal(status, 503);
  assert.equal(body.ok, false);
  assert.equal(fetchCalls.length, 1, "IBJA was still read before the write was attempted");
});

test("asOf is rejected outside a dry run so history cannot be rewritten", async () => {
  const { status, body } = await postJson(
    "/api/gold-rate",
    { mode: "ibja", asOf: "2026-01-01T00:00:00Z" },
    auth
  );
  assert.equal(status, 400);
  assert.match(body.error, /dryRun/);
  assert.equal(fetchCalls.length, 0);
});

/* ==========================================================================
 * POST manual — the owner typing today's IBJA figure in
 * ======================================================================= */

test("manual entry validates fineness as fineness, never karat", async () => {
  const cases = [
    [{ fineness: 22, quote: "137053" }, /fineness/i],
    [{ fineness: 916.5, quote: "137053" }, /fineness/i],
    [{ metal: "platinum", fineness: 999, quote: "60120" }, /gold or silver/i],
    [{ metal: "silver", fineness: 916, quote: "231381" }, /fineness/i],
  ];

  for (const [quote, pattern] of cases) {
    const { status, body } = await postJson(
      "/api/gold-rate",
      { mode: "manual", quotes: [quote] },
      auth
    );
    assert.equal(status, 400, `accepted ${JSON.stringify(quote)}`);
    assert.match(body.error, pattern);
  }
});

test("manual entry refuses a figure it cannot parse, and refuses an empty batch", async () => {
  const cases = [
    [{ mode: "manual", quotes: [] }, /non-empty/i],
    [{ mode: "manual", quotes: [{ fineness: 916, quote: "" }] }, /Missing `quote`/i],
    [{ mode: "manual", quotes: [{ fineness: 916, quote: "one lakh" }] }, /not a rupee figure/i],
    [{ mode: "manual", quotes: [{ fineness: 916, quote: "-137053" }] }, /not a rupee figure/i],
    [
      {
        mode: "manual",
        quotes: [
          { fineness: 916, quote: "137053" },
          { fineness: 916, quote: "137054" },
        ],
      },
      /Duplicate/i,
    ],
  ];

  for (const [payload, pattern] of cases) {
    const { status, body } = await postJson("/api/gold-rate", payload, auth);
    assert.equal(status, 400, `accepted ${JSON.stringify(payload)}`);
    assert.match(body.error, pattern);
  }
});

test("a valid manual entry passes validation and then fails closed on the missing database", async () => {
  const { status, body } = await postJson(
    "/api/gold-rate",
    {
      mode: "manual",
      createdBy: "owner@alankar.test",
      quotes: [
        { metal: "gold", fineness: 916, quote: "1,37,053" },
        { metal: "silver", fineness: 999, quote: "231381" },
      ],
    },
    auth
  );

  // Validation and unit conversion succeeded (a 400 would mean they did not);
  // the 503 is D1 being absent in-process.
  assert.equal(status, 503);
  assert.equal(body.ok, false);
});

test("unknown modes and malformed bodies are rejected", async () => {
  const malformed = await postJson("/api/gold-rate", "not json at all", auth);
  assert.equal(malformed.status, 400);
  assert.match(malformed.body.error, /valid JSON/i);

  const wrongMode = await postJson("/api/gold-rate", { mode: "mcx" }, auth);
  assert.equal(wrongMode.status, 400);
  assert.match(wrongMode.body.error, /ibja.*manual/i);

  const arrayBody = await postJson("/api/gold-rate", [1, 2, 3], auth);
  assert.equal(arrayBody.status, 400);
  assert.match(arrayBody.body.error, /JSON object/i);
});

test("MCX and XAU are not reachable code paths — IBJA is the only host contacted", async () => {
  await dryRun("2026-08-08T06:35:00Z");
  await postJson("/api/gold-rate", { mode: "ibja" }, auth);

  assert.ok(fetchCalls.length > 0);
  for (const url of fetchCalls) {
    assert.match(url, /^https:\/\/ibjarates\.com\//, `unexpected upstream: ${url}`);
  }
});
