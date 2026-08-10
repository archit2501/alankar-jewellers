/**
 * THE RATE ENDPOINT — /api/admin/rate.
 *
 * ===========================================================================
 * TWO INTENTS, AND THERE IS NO THIRD
 * ===========================================================================
 *   enter    -> a rate read off IBJA by hand, appended.
 *   correct  -> the rate in force was wrong: close it, append the right one.
 *
 * There is NO edit and there is NO delete, and their absence is structural
 * rather than remembered. `gold_rates` is append-only — `db/schema.ts`: "never
 * UPDATE a rate row. Close the old row and insert a new one, both inside one
 * `db.batch()`" — because an invoice reprinted in 2031 has to reconstruct to
 * the paise from the exact row it was priced from. An UPDATE of a rate value
 * would silently reprice history, and the orders already billed from it would
 * stop adding up.
 *
 * The single UPDATE this file issues writes `effective_to` and nothing else.
 * It is the interval terminator, not a mutation of the observation.
 *
 * ===========================================================================
 * THE UNIT IS GUARDED HERE, NOT TRUSTED
 * ===========================================================================
 * A human typing a metal rate can put a per-gram figure into a per-ten-grams
 * box, and `db/schema.ts` names that exact mistake as the worst bug the system
 * can have: it does not throw, it does not look wrong in a table, and it
 * multiplies every order by ten. `checkRateFigure()` refuses it against the
 * rate in force, and that refusal cannot be confirmed away.
 *
 * The figure travels as the STRING the owner typed. The paise value is derived
 * from it inside the guard rather than sent alongside it, so `source_quote_raw`
 * and the stored integer can never disagree — the anchor that makes a bad
 * entry provable rather than arguable.
 *
 * ===========================================================================
 * CONCURRENCY IS ARBITRATED BY THE DATABASE
 * ===========================================================================
 * A correction names the row it replaces. If somebody else closed that row
 * while this form was open, the close changes nothing, the insert collides
 * with their still-open row on `gold_rates_current_idx`, and the whole batch
 * aborts — audit row included. The owner is told what the rate says now. A
 * guard written as a WHERE clause would instead make the lost update a silent
 * no-op, which is how two people end up believing different rates.
 *
 * ===========================================================================
 * THE AUDIT ROW IS IN THE SAME BATCH
 * ===========================================================================
 * `db.batch()` is the only atomicity primitive D1 offers. An audit row written
 * in a second batch either records a change that did not commit or misses one
 * that did. The diff is allowlist-driven (`gold_rate` in
 * `AUDIT_VALUE_ALLOWLIST`) so it carries the metal, the purity, the source and
 * the effective dates — and never a customer, never a name, never a number
 * belonging to a person.
 */

import { auditStatement, buildDiff, toAuditRow } from "../../../_admin/audit";
import {
  checkRateFigure,
  correctionRef,
  findRateSlot,
  isCorrectionReason,
  planRateAppend,
  readOpenRateById,
  readRateBefore,
  readRateBoard,
} from "../../../_admin/rate-data";
import {
  ADMIN_RESPONSE_HEADERS,
  getAdminDb,
  readAdminCookieValue,
  refuseCrossSite,
  requireAdmin,
  tokenFromCookieValue,
  verifyCsrfToken,
} from "../../../_admin/session";

/* =========================================================================
 * Notices — a closed set, rendered by exact match on the page
 * ====================================================================== */

export const RATE_NOTICES = {
  entered: "entered",
  corrected: "corrected",
  refused: "refused",
  needsFigure: "needs-figure",
  perGram: "per-gram",
  tenTimes: "ten-times",
  bigMove: "big-move",
  needsReason: "needs-reason",
  notAllowed: "not-allowed",
  conflict: "conflict",
  unavailable: "unavailable",
} as const;

export type RateNotice = (typeof RATE_NOTICES)[keyof typeof RATE_NOTICES];

/**
 * Where the browser is sent back to. Everything interpolated here is either a
 * constant from the set above or a UUID this application generated: `rateId`
 * is checked against `UUID` before it is used, so nothing typed into a request
 * can reach a `Location`.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function rateHref(
  notice?: RateNotice,
  extra?: { readonly billed?: string | null; readonly wrong?: string | null }
): string {
  const params = new URLSearchParams();
  if (notice) params.set("notice", notice);
  if (extra?.billed && UUID.test(extra.billed)) params.set("billed", extra.billed);
  if (extra?.wrong && UUID.test(extra.wrong)) params.set("wrong", extra.wrong);
  const query = params.toString();
  return query ? `/admin/rate?${query}` : "/admin/rate";
}

/* =========================================================================
 * Request plumbing — the shape app/api/admin/orders/route.ts established
 * ====================================================================== */

function isFormPost(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  );
}

function headers(): Headers {
  return new Headers(ADMIN_RESPONSE_HEADERS);
}

type Answer = {
  readonly status: number;
  readonly notice: RateNotice;
  readonly error?: string;
  readonly ok?: boolean;
  readonly billed?: string | null;
  readonly wrong?: string | null;
};

function respond(request: Request, answer: Answer): Response {
  const result = headers();

  if (isFormPost(request)) {
    // Even a refusal is a 303. A 4xx carrying a Location is a blank page the
    // browser will not follow, and a blank page tells the owner nothing.
    result.set("Location", rateHref(answer.notice, { billed: answer.billed, wrong: answer.wrong }));
    return new Response(null, { status: 303, headers: result });
  }

  result.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      ok: answer.ok ?? false,
      notice: answer.notice,
      ...(answer.error === undefined ? {} : { error: answer.error }),
    }),
    { status: answer.status, headers: result }
  );
}

type Submission = {
  readonly intent: string;
  /**
   * The metal and the purity as ONE value, `gold:916`, because a form that
   * asks for them separately can express `silver:585` — a combination nobody
   * publishes. It is matched against `RATE_SLOTS` by exact equality, so
   * nothing here reaches a query. A JSON caller may send the two fields
   * instead; the compound wins when both are present.
   */
  readonly metal: string;
  readonly fineness: number;
  /** The figure exactly as typed. Never parsed before the guard sees it. */
  readonly figure: string;
  readonly note: string;
  readonly supersedes: string;
  readonly reasonCode: string;
  readonly confirmed: boolean;
  readonly csrf: string;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readSubmission(request: Request): Promise<Submission> {
  const read = (source: (key: string) => unknown): Submission => {
    const compound = asText(source("slot")).toLowerCase();
    const cut = compound.indexOf(":");
    const fromSlot =
      cut > 0
        ? { metal: compound.slice(0, cut), fineness: Number(compound.slice(cut + 1)) }
        : null;

    return {
    intent: asText(source("intent")),
    metal: fromSlot ? fromSlot.metal : asText(source("metal")).toLowerCase(),
    fineness: fromSlot ? fromSlot.fineness : Number(asText(source("fineness"))),
    // NOT trimmed away to nothing and NOT normalised: the raw string is the
    // audit anchor, and `checkRateFigure()` is the only thing that reads it.
    figure: typeof source("figure") === "string" ? (source("figure") as string).slice(0, 32) : "",
    note: asText(source("note")).slice(0, 160),
    supersedes: asText(source("supersedes")),
    reasonCode: asText(source("reasonCode")),
    confirmed: asText(source("confirmed")) === "yes",
    csrf: asText(source("csrf")),
    };
  };

  if (isFormPost(request)) {
    const form = await request.formData();
    return read((key) => form.get(key));
  }

  try {
    const payload = (await request.json()) as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") return read(() => null);
    return read((key) => payload[key]);
  } catch {
    return read(() => null);
  }
}

/** The notice each refusal from the figure guard travels back as. */
const FIGURE_NOTICES = {
  not_a_figure: RATE_NOTICES.needsFigure,
  looks_per_gram: RATE_NOTICES.perGram,
  looks_ten_times: RATE_NOTICES.tenTimes,
  out_of_band: RATE_NOTICES.needsFigure,
} as const;

/* =========================================================================
 * POST
 * ====================================================================== */

export async function POST(request: Request): Promise<Response> {
  // A missing Origin is refused on this side of the door: there is no
  // legitimate non-browser admin client, so the header a browser always sends
  // is one an admin request must always carry.
  if (refuseCrossSite(request)) {
    return respond(request, {
      status: 403,
      notice: RATE_NOTICES.refused,
      error: "That request did not come from this site, so nothing was changed.",
    });
  }

  let db;
  try {
    db = getAdminDb();
  } catch (error) {
    console.error("[admin-rate] no database, so no rate can be written:", error);
    return respond(request, {
      status: 503,
      notice: RATE_NOTICES.unavailable,
      error: "The rate book could not be reached, so nothing was changed.",
    });
  }

  // `proxy.ts` is defence; this is the defence. It is the only check that sees
  // a revoked, expired, idled-out or deactivated session.
  const session = await requireAdmin(request, { db });
  if (!session.ok) {
    return respond(request, {
      status: 401,
      notice: RATE_NOTICES.refused,
      error: "Sign in to use the admin panel.",
    });
  }

  const submission = await readSubmission(request);

  const token = await tokenFromCookieValue(readAdminCookieValue(request.headers.get("cookie")));
  if (!token || !(await verifyCsrfToken(token, submission.csrf))) {
    return respond(request, {
      status: 403,
      notice: RATE_NOTICES.refused,
      error: "That request could not be verified, so nothing was changed.",
    });
  }

  if (submission.intent !== "enter" && submission.intent !== "correct") {
    // Note what this refusal covers: "edit", "delete", "update" and every
    // other verb a rate table does not have. There is no intent that mutates.
    return respond(request, {
      status: 400,
      notice: RATE_NOTICES.notAllowed,
      error: "That is not something this screen can do to a rate.",
    });
  }

  try {
    return await handleWrite(request, db, submission, session.identity);
  } catch (error) {
    // The unique index on (metal, fineness) WHERE effective_to IS NULL is what
    // lands here: somebody else changed this rate while the form was open, so
    // the close matched nothing and the insert collided with their row. The
    // batch aborted, audit row and all, and NOTHING was written.
    console.error(`[admin-rate] ${submission.intent} failed:`, error);
    const conflict = String(error).toLowerCase();
    const isConflict = conflict.includes("unique") || conflict.includes("constraint");

    return respond(request, {
      status: isConflict ? 409 : 503,
      notice: isConflict ? RATE_NOTICES.conflict : RATE_NOTICES.unavailable,
      error: isConflict
        ? "Someone else changed this rate while you were typing, so nothing was written. Open the rate screen again and correct the one that is in force now."
        : "Nothing was changed. Try again, and if it happens twice tell whoever runs the site.",
    });
  }
}

/* -------------------------------------------------------------------------
 * The one write path both intents share
 * ---------------------------------------------------------------------- */

async function handleWrite(
  request: Request,
  db: ReturnType<typeof getAdminDb>,
  submission: Submission,
  identity: { readonly email: string; readonly adminUserId: string }
): Promise<Response> {
  const correcting = submission.intent === "correct";

  /* ---- Which metal and purity ---------------------------------------- */

  let metal: "gold" | "silver";
  let fineness: number;
  let supersedes: string | null = null;

  if (correcting) {
    if (!UUID.test(submission.supersedes)) {
      return respond(request, {
        status: 400,
        notice: RATE_NOTICES.notAllowed,
        error: "That is not a rate this shop recorded.",
      });
    }

    // A correction supersedes the rate IN FORCE. A closed row cannot be
    // corrected, because it is already history: the orders priced from it were
    // priced from it, and appending a replacement for a row that no longer
    // governs anything would say something untrue about the past.
    const open = await readOpenRateById(db, submission.supersedes);
    if (open === null) {
      return respond(request, {
        status: 409,
        notice: RATE_NOTICES.conflict,
        error:
          "That rate is no longer the one in force, so it cannot be corrected. What it was is part of the record now — the orders billed from it were billed from it. Correct the rate that is in force instead.",
      });
    }

    if (!isCorrectionReason(submission.reasonCode)) {
      // Why a figure was wrong is the difference between a typo and a bad
      // source, and it is the thing anyone reading this trail later needs.
      return respond(request, {
        status: 400,
        notice: RATE_NOTICES.needsReason,
        error: "Say why the rate was wrong.",
        wrong: submission.supersedes,
      });
    }

    metal = open.metal === "silver" ? "silver" : "gold";
    fineness = open.fineness;
    supersedes = open.id;
  } else {
    const slot = findRateSlot(submission.metal, submission.fineness);
    if (slot === null) {
      return respond(request, {
        status: 400,
        notice: RATE_NOTICES.notAllowed,
        error:
          "Choose one of the purities the rate is published at. Purity is millesimal fineness — 916, never 22 carat.",
      });
    }
    metal = slot.metal;
    fineness = slot.fineness;
  }

  const slot = findRateSlot(metal, fineness);
  const unit = slot?.unit ?? "per_ten_grams";

  /* ---- The figure, and the guard -------------------------------------- */

  const board = await readRateBoard(db);
  const inForce = board.find((row) => row.metal === metal && row.fineness === fineness) ?? null;

  /*
   * WHICH FIGURE THE GUARD MEASURES AGAINST.
   *
   * A new entry is measured against the rate in force, because that is the
   * last thing believed to be right. A CORRECTION is measured against the rate
   * BEFORE the one being corrected — the row in force is the wrong one, and
   * measuring against it would make the ten-times guard refuse exactly the
   * correction it exists to invite: putting right a per-gram typo means typing
   * a figure ten times what the table currently says.
   */
  const benchmark = correcting
    ? await readRateBefore(db, {
        metal,
        fineness,
        before: inForce?.effectiveFrom ?? new Date().toISOString(),
      })
    : inForce;

  const verdict = checkRateFigure({
    raw: submission.figure,
    unit,
    previousPaise: benchmark?.ratePerTenGramsPaise ?? null,
    confirmed: submission.confirmed,
  });

  if (!verdict.ok) {
    return respond(request, {
      status: 400,
      notice: FIGURE_NOTICES[verdict.code],
      error: verdict.message,
      wrong: supersedes,
    });
  }

  if (verdict.needsConfirmation) {
    return respond(request, {
      status: 400,
      notice: RATE_NOTICES.bigMove,
      error: verdict.message,
      wrong: supersedes,
    });
  }

  /* ---- The write ------------------------------------------------------ */

  const nowMs = Date.now();
  const sourceQuoteRaw = submission.figure.trim();
  const sourceRef =
    correcting && supersedes !== null
      ? correctionRef(supersedes, submission.reasonCode as "typo" | "source_wrong" | "other")
      : `manual:${new Date(nowMs).toISOString()}${submission.note ? ` ${submission.note}` : ""}`;

  const plan = planRateAppend({
    metal,
    fineness,
    ratePerTenGramsPaise: verdict.paise,
    sourceQuoteRaw,
    sourceRef,
    // The actor is the signed-in admin and nothing else. A rate nobody is
    // named for is a false trail, and a false trail is worse than none.
    createdBy: identity.email,
    supersedes,
    nowMs,
  });

  /*
   * The diff carries the metal, the purity, the source and the two effective
   * dates — every one of them on `AUDIT_VALUE_ALLOWLIST.gold_rate`. The RATE
   * ITSELF is deliberately absent and comes back as "changed": money is not on
   * that allowlist anywhere in this application, and the figure is in
   * `gold_rates` forever regardless, which is where a reader should read it.
   * Nothing here is a name, a number or an address.
   */
  const audit = toAuditRow({
    actorEmail: identity.email,
    actorAdminUserId: identity.adminUserId,
    action: correcting ? "rate.corrected" : "rate.updated",
    entityType: "gold_rate",
    entityId: plan.id,
    diff: buildDiff(
      "gold_rate",
      {
        metal,
        fineness,
        source: inForce?.source ?? null,
        effective_from: inForce?.effectiveFrom ?? null,
        effective_to: null,
      },
      {
        metal,
        fineness,
        source: "manual",
        effective_from: plan.effectiveFrom,
        effective_to: null,
        rate_per_ten_grams_paise: verdict.paise,
      }
    ),
    ip: request.headers.get("cf-connecting-ip"),
    userAgent: request.headers.get("user-agent"),
    nowMs,
  });

  const results = await db.batch([...plan.statements, auditStatement(audit)]);

  if (correcting && (results[0]?.changes ?? 0) !== 1) {
    // The insert committed, so the corrected rate IS in force — but the row it
    // claimed to replace was not the one it closed. Loud in `wrangler tail`,
    // and not a lie to the owner: the correction did land.
    console.error(
      `[admin-rate] correction ${plan.id} closed ${results[0]?.changes ?? 0} rows, not 1.`
    );
  }

  return respond(request, {
    status: correcting ? 200 : 201,
    ok: true,
    notice: correcting ? RATE_NOTICES.corrected : RATE_NOTICES.entered,
    billed: supersedes,
  });
}

/**
 * There is no GET, and there is no DELETE.
 *
 * No GET because `SameSite=Lax` sends the session cookie on a top-level
 * navigation, so a GET that changed anything would be a CSRF payload delivered
 * by a link. No DELETE because a rate is never removed: every figure this shop
 * has ever quoted from stays readable forever, which is what lets an invoice
 * reprinted in 2031 reconstruct to the paise.
 */
export function GET(): Response {
  const result = headers();
  result.set("Allow", "POST");
  result.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      ok: false,
      error:
        "Use POST. Rates cannot be read, edited or deleted through this endpoint — a wrong rate is superseded, never changed.",
    }),
    { status: 405, headers: result }
  );
}
