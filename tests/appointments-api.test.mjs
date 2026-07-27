import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";

import { env } from "cloudflare:workers";

import { fetchWorker, postJson } from "./helpers.mjs";

const VALID = {
  name: "Meera Sharma",
  phone: "98765 43210",
  interest: "Jadau and Polki",
  time: "Weekday evening",
  note: "Looking for a bridal set for December.",
};

/**
 * No D1 binding exists in-process, so `getDb()` throws and the database sink
 * always fails. That is deliberate: it isolates the webhook sink and proves the
 * route's promise -- that a lead reaching EITHER sink is a captured lead.
 */
let webhookCalls;
let originalFetch;

beforeEach(() => {
  webhookCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    webhookCalls.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete env.LEAD_WEBHOOK_URL;
});

function withWebhook() {
  env.LEAD_WEBHOOK_URL = "https://hooks.example.test/lead";
}

test("GET is rejected with an Allow header", async () => {
  const response = await fetchWorker("/api/appointments");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "POST");
  assert.equal((await response.json()).ok, false);
});

test("a valid lead delivered to the webhook succeeds", async () => {
  withWebhook();
  const { status, body } = await postJson("/api/appointments", VALID);

  assert.equal(status, 201);
  assert.deepEqual(body, { ok: true });
  assert.equal(webhookCalls.length, 1);
  assert.equal(webhookCalls[0].url, "https://hooks.example.test/lead");
  assert.equal(webhookCalls[0].body.name, "Meera Sharma");
  assert.equal(webhookCalls[0].body.interest, "Jadau and Polki");
});

test("both sinks failing surfaces an error instead of a false confirmation", async () => {
  // No webhook configured and no database: the visitor must NOT be told their
  // request was received. This is the exact bug the old form had.
  const { status, body } = await postJson("/api/appointments", VALID);

  assert.equal(status, 500);
  assert.equal(body.ok, false);
  assert.match(body.error, /call or WhatsApp/i);
  assert.equal(webhookCalls.length, 0);
});

test("normalises Indian phone numbers to E.164", async () => {
  withWebhook();

  const cases = [
    ["98765 43210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["09876543210", "+919876543210"],
    ["98765-43210", "+919876543210"],
    ["(98765) 43210", "+919876543210"],
  ];

  for (const [input, expected] of cases) {
    webhookCalls.length = 0;
    const { status } = await postJson("/api/appointments", { ...VALID, phone: input });
    assert.equal(status, 201, `rejected a valid number: ${input}`);
    assert.equal(webhookCalls[0].body.phone, expected, `bad normalisation for ${input}`);
  }
});

test("rejects incomplete submissions", async () => {
  withWebhook();

  const cases = [
    [{ ...VALID, name: "   " }, /name/i],
    [{ ...VALID, phone: "" }, /mobile number/i],
    [{ ...VALID, phone: "12345" }, /valid mobile number/i],
    [{ ...VALID, interest: "" }, /interested/i],
    [{ ...VALID, time: "" }, /preferred time/i],
    [{ ...VALID, name: "x".repeat(121) }, /120 characters/i],
    [{ ...VALID, note: "x".repeat(2001) }, /2000 characters/i],
  ];

  for (const [payload, pattern] of cases) {
    const { status, body } = await postJson("/api/appointments", payload);
    assert.equal(status, 400, `expected 400 for ${JSON.stringify(payload).slice(0, 60)}`);
    assert.equal(body.ok, false);
    assert.match(body.error, pattern);
  }

  assert.equal(webhookCalls.length, 0, "invalid leads must never reach the webhook");
});

test("rejects a malformed body", async () => {
  const { status, body } = await postJson("/api/appointments", "not json at all");
  assert.equal(status, 400);
  assert.match(body.error, /valid JSON/i);
});

test("absorbs honeypot submissions without delivering them", async () => {
  withWebhook();
  const { status, body } = await postJson("/api/appointments", {
    ...VALID,
    company: "Acme Backlinks Ltd",
  });

  // Answers exactly like success so the bot learns nothing...
  assert.equal(status, 201);
  assert.deepEqual(body, { ok: true });
  // ...but nothing is delivered anywhere.
  assert.equal(webhookCalls.length, 0);
});

test("a failing webhook is reported when it is the only sink", async () => {
  withWebhook();
  globalThis.fetch = async () => new Response("nope", { status: 502 });

  const { status, body } = await postJson("/api/appointments", VALID);
  assert.equal(status, 500);
  assert.equal(body.ok, false);
});
