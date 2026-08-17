/**
 * GET  /api/gold-rate  — read the current usable metal rate (public).
 * POST /api/gold-rate  — ingest a new one (shared-secret, never public).
 *
 * ===========================================================================
 * REQUIRED ENVIRONMENT — .env.example style, documented here because this
 * route owns the variable and `.env.example` is not this task's file to edit.
 * ===========================================================================
 *
 *   # GOLD_RATE_INGEST_TOKEN — REQUIRED to ingest rates. A long random shared
 *   # secret. POST /api/gold-rate writes to the production pricing table, so
 *   # it is never open to the public: without this set, every POST is refused.
 *   #
 *   # Generate one:   openssl rand -hex 32
 *   #
 *   # Set it as a Worker secret in the hosting control plane (NOT in a
 *   # committed .env), and send it on every ingest as either:
 *   #     Authorization: Bearer <token>
 *   #     X-Rate-Ingest-Token: <token>
 *   #
 *   # Rotate it by setting the new value and updating the cron/admin caller.
 *   GOLD_RATE_INGEST_TOKEN=
 *
 * ===========================================================================
 * SHAPES
 * ===========================================================================
 * GET /api/gold-rate?metal=gold&fineness=916          (defaults: gold, 916)
 *   200 { ok: true,  rate: { ... } }
 *   400 { ok: false, error }                          bad metal/fineness
 *   503 { ok: false, reason, error, unusableRate? }   no rate / stale / D1 down
 *
 *   503 is deliberate and is the whole point of this endpoint: a stale or
 *   missing rate is a REFUSAL, not a 200 carrying a null the caller might
 *   render as ₹0. `Cache-Control: no-store` on every response so a stale rate
 *   can never be served from an edge cache after it expires.
 *
 * POST /api/gold-rate                       Authorization: Bearer <token>
 *   { "mode": "ibja" }
 *       Fetch ibjarates.com, parse the current publication slot, write it.
 *   { "mode": "ibja", "dryRun": true, "asOf": "2026-08-08T06:35:00Z" }
 *       Parse and return what WOULD be written, touching no data. This is how
 *       an operator proves the parser still matches IBJA's markup — the page
 *       is scraped HTML and will change one day. `asOf` is accepted only with
 *       `dryRun` so a replay can never rewrite history.
 *   { "mode": "manual", "createdBy": "owner@shop", "quotes": [
 *       { "metal": "gold", "fineness": 916, "quote": "137053" } ] }
 *       Owner entry, read off ibjarates.com by hand. `quote` is the figure AS
 *       PUBLISHED (gold ₹/10 g, silver ₹/kg); the paise value is derived from
 *       it rather than sent alongside it, so `source_quote_raw` and the stored
 *       number can never disagree.
 */

import { env } from "cloudflare:workers";
import {
  IBJA_GOLD_FINENESS,
  IBJA_SILVER_FINENESS,
  type IngestibleMetal,
  type RateQuote,
  formatPaiseAsRupees,
  goldQuoteToPaisePerTenGrams,
  ingestRateQuotes,
  rateExpiryMs,
  readCurrentRate,
  readIbjaRates,
  silverQuoteToPaisePerTenGrams,
} from "../../_pricing/rates";

const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
} as const;

/** Fineness codes each metal may legitimately be quoted at. */
const ALLOWED_FINENESS: Record<IngestibleMetal, readonly number[]> = {
  gold: IBJA_GOLD_FINENESS,
  silver: [IBJA_SILVER_FINENESS],
};

function isIngestibleMetal(value: string): value is IngestibleMetal {
  return value === "gold" || value === "silver";
}

/* ==========================================================================
 * Ingest authentication
 * ======================================================================= */

function ingestToken() {
  const value = (env as unknown as Record<string, unknown>).GOLD_RATE_INGEST_TOKEN;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * Length-independent, byte-wise comparison. Workers has no
 * `crypto.timingSafeEqual` for strings, and `===` on a secret leaks its prefix
 * through timing to anyone patient enough to measure it.
 */
function secretsMatch(expected: string, presented: string) {
  const a = new TextEncoder().encode(expected);
  const b = new TextEncoder().encode(presented);
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

function presentedToken(request: Request) {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (bearer) return bearer[1].trim();
  return (request.headers.get("x-rate-ingest-token") ?? "").trim();
}

/** Returns a Response when the caller must be refused, or null when allowed. */
function refuseUnauthorised(request: Request) {
  const expected = ingestToken();

  if (!expected) {
    // Fail closed on misconfiguration. An unset secret must never mean
    // "anyone may write to the production pricing table".
    return Response.json(
      {
        ok: false,
        error:
          "Rate ingestion is not configured. Set the GOLD_RATE_INGEST_TOKEN secret in the hosting control plane before ingesting rates.",
      },
      { status: 503, headers: NO_STORE }
    );
  }

  const presented = presentedToken(request);
  if (!presented || !secretsMatch(expected, presented)) {
    return Response.json(
      { ok: false, error: "Unauthorised." },
      {
        status: 401,
        headers: { ...NO_STORE, "WWW-Authenticate": 'Bearer realm="gold-rate-ingest"' },
      }
    );
  }

  return null;
}

/* ==========================================================================
 * GET — the storefront's read path
 * ======================================================================= */

function describeRate(rate: {
  id: string;
  metal: string;
  fineness: number;
  ratePerTenGramsPaise: number;
  source: string;
  sourceRef: string | null;
  sourceQuoteRaw: string | null;
  effectiveFrom: string;
  expiresAt: string;
  ageMinutes: number;
}) {
  return {
    id: rate.id,
    metal: rate.metal,
    fineness: rate.fineness,
    /** The only figure pricing code may read. Paise per TEN grams. */
    ratePerTenGramsPaise: rate.ratePerTenGramsPaise,
    /** Display only, built from integers. Never parse money back out of it. */
    displayRupeesPerTenGrams: formatPaiseAsRupees(rate.ratePerTenGramsPaise),
    source: rate.source,
    sourceRef: rate.sourceRef,
    sourceQuoteRaw: rate.sourceQuoteRaw,
    effectiveFrom: rate.effectiveFrom,
    expiresAt: rate.expiresAt,
    ageMinutes: rate.ageMinutes,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const metalParam = (url.searchParams.get("metal") ?? "gold").trim().toLowerCase();
  const finenessParam = (url.searchParams.get("fineness") ?? "916").trim();

  if (!isIngestibleMetal(metalParam)) {
    return Response.json(
      { ok: false, error: "`metal` must be `gold` or `silver`." },
      { status: 400, headers: NO_STORE }
    );
  }

  const fineness = Number(finenessParam);
  if (!Number.isInteger(fineness) || !ALLOWED_FINENESS[metalParam].includes(fineness)) {
    return Response.json(
      {
        ok: false,
        error: `\`fineness\` must be millesimal fineness, one of ${ALLOWED_FINENESS[
          metalParam
        ].join(", ")} for ${metalParam}. Karat values such as 22 are not accepted.`,
      },
      { status: 400, headers: NO_STORE }
    );
  }

  const lookup = await readCurrentRate(metalParam, fineness);

  if (!lookup.ok) {
    // FAIL CLOSED. No 200, no null rate, no zero. The storefront is told, in
    // a status code it cannot mistake for success, that it may not quote.
    return Response.json(
      {
        ok: false,
        reason: lookup.reason,
        error: lookup.message,
        unusableRate: lookup.unusableRate ?? null,
      },
      { status: 503, headers: NO_STORE }
    );
  }

  return Response.json(
    { ok: true, rate: describeRate(lookup.rate) },
    { status: 200, headers: NO_STORE }
  );
}

/* ==========================================================================
 * POST — ingestion
 * ======================================================================= */

type ManualQuoteInput = {
  metal?: unknown;
  fineness?: unknown;
  quote?: unknown;
};

function buildManualQuotes(raw: unknown):
  | { ok: true; quotes: RateQuote[] }
  | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "`quotes` must be a non-empty array." };
  }
  if (raw.length > 12) {
    return { ok: false, error: "`quotes` may hold at most 12 entries." };
  }

  const quotes: RateQuote[] = [];
  const seen = new Set<string>();

  for (const entry of raw as ManualQuoteInput[]) {
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: "Every entry in `quotes` must be an object." };
    }

    const metal =
      typeof entry.metal === "string" ? entry.metal.trim().toLowerCase() : "gold";
    if (!isIngestibleMetal(metal)) {
      return { ok: false, error: `Unsupported metal \`${metal}\`. Use gold or silver.` };
    }

    const fineness = Number(entry.fineness);
    if (!Number.isInteger(fineness) || !ALLOWED_FINENESS[metal].includes(fineness)) {
      return {
        ok: false,
        error: `\`fineness\` must be one of ${ALLOWED_FINENESS[metal].join(
          ", "
        )} for ${metal}: millesimal fineness, never karat.`,
      };
    }

    const key = `${metal}:${fineness}`;
    if (seen.has(key)) {
      return { ok: false, error: `Duplicate quote for ${key}.` };
    }
    seen.add(key);

    const quote = typeof entry.quote === "string" ? entry.quote.trim() : "";
    if (!quote) {
      return {
        ok: false,
        error: `Missing \`quote\` for ${key}. Send the figure exactly as IBJA published it (gold ₹ per 10 g, silver ₹ per kg).`,
      };
    }
    if (quote.length > 32) {
      return { ok: false, error: `\`quote\` for ${key} is implausibly long.` };
    }

    const paise =
      metal === "gold"
        ? goldQuoteToPaisePerTenGrams(quote)
        : silverQuoteToPaisePerTenGrams(quote);

    if (paise === null) {
      return {
        ok: false,
        error: `\`quote\` for ${key} (${quote}) is not a rupee figure.`,
      };
    }

    quotes.push({
      metal,
      fineness,
      ratePerTenGramsPaise: paise,
      sourceQuoteRaw: quote,
    });
  }

  return { ok: true, quotes };
}

export async function POST(request: Request) {
  const refusal = refuseUnauthorised(request);
  if (refusal) return refusal;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: "Request body must be valid JSON." },
      { status: 400, headers: NO_STORE }
    );
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return Response.json(
      { ok: false, error: "Request body must be a JSON object." },
      { status: 400, headers: NO_STORE }
    );
  }

  const mode = typeof payload.mode === "string" ? payload.mode.trim() : "ibja";
  const dryRun = payload.dryRun === true;

  if (mode === "manual") {
    if (dryRun) {
      return Response.json(
        { ok: false, error: "`dryRun` applies to `mode: \"ibja\"` only." },
        { status: 400, headers: NO_STORE }
      );
    }

    const built = buildManualQuotes(payload.quotes);
    if (!built.ok) {
      return Response.json({ ok: false, error: built.error }, { status: 400, headers: NO_STORE });
    }

    const createdBy =
      typeof payload.createdBy === "string" && payload.createdBy.trim()
        ? payload.createdBy.trim().slice(0, 160)
        : null;

    // Manual entries are stamped with the moment of entry, not the IBJA slot,
    // so the owner can correct a typo minutes later and have the correction be
    // strictly newer than the row it replaces.
    const enteredAt = new Date().toISOString();
    const result = await ingestRateQuotes(built.quotes, {
      source: "manual",
      sourceRef: `manual:${enteredAt}`,
      effectiveFrom: enteredAt,
      createdBy,
    });

    if (!result.ok) {
      return Response.json({ ok: false, error: result.message }, { status: 503, headers: NO_STORE });
    }

    return Response.json(
      {
        ok: true,
        mode: "manual",
        effectiveFrom: enteredAt,
        expiresAt: new Date(rateExpiryMs(Date.parse(enteredAt))).toISOString(),
        inserted: result.inserted,
        outcomes: result.outcomes,
      },
      { status: 201, headers: NO_STORE }
    );
  }

  if (mode !== "ibja") {
    return Response.json(
      { ok: false, error: '`mode` must be "ibja" or "manual".' },
      { status: 400, headers: NO_STORE }
    );
  }

  let nowMs = Date.now();
  if (payload.asOf !== undefined) {
    if (!dryRun) {
      return Response.json(
        { ok: false, error: "`asOf` is accepted only alongside `dryRun: true`." },
        { status: 400, headers: NO_STORE }
      );
    }
    const parsed = typeof payload.asOf === "string" ? Date.parse(payload.asOf) : NaN;
    if (!Number.isFinite(parsed)) {
      return Response.json(
        { ok: false, error: "`asOf` must be an ISO-8601 timestamp." },
        { status: 400, headers: NO_STORE }
      );
    }
    nowMs = parsed;
  }

  const read = await readIbjaRates(nowMs);
  if (!read.ok) {
    return Response.json(
      { ok: false, error: read.message, detail: read.detail ?? null },
      { status: 502, headers: NO_STORE }
    );
  }

  const { reading } = read;
  const preview = {
    mode: "ibja" as const,
    slot: reading.effectiveFrom,
    slotRef: reading.slotRef,
    column: reading.column,
    /** IBJA's newest archived date. Operator sanity check — see rates.ts. */
    archiveLatestDate: reading.archiveLatestDate,
    quotes: reading.quotes.map((quote) => ({
      ...quote,
      displayRupeesPerTenGrams: formatPaiseAsRupees(quote.ratePerTenGramsPaise),
    })),
    unconverted: reading.unconverted,
    expiresAt: new Date(rateExpiryMs(reading.slotMs)).toISOString(),
  };

  if (dryRun) {
    return Response.json({ ok: true, dryRun: true, ...preview }, { status: 200, headers: NO_STORE });
  }

  const result = await ingestRateQuotes(reading.quotes, {
    source: "ibja",
    sourceRef: reading.slotRef,
    effectiveFrom: reading.effectiveFrom,
    createdBy: null,
  });

  if (!result.ok) {
    return Response.json({ ok: false, error: result.message }, { status: 503, headers: NO_STORE });
  }

  return Response.json(
    { ok: true, ...preview, inserted: result.inserted, outcomes: result.outcomes },
    { status: 201, headers: NO_STORE }
  );
}
