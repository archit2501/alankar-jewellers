/**
 * THE ORDER ACTION ENDPOINT — /api/admin/orders.
 *
 * ===========================================================================
 * WHAT IT CAN DO, AND WHAT IT STRUCTURALLY CANNOT
 * ===========================================================================
 * Three intents, and there is no fourth:
 *
 *   cancel          -> `cancelOrder()`, which is the only path in the whole
 *                      application that puts a piece back on the wall.
 *   mark_ready      -> status `ready_for_pickup`
 *   mark_collected  -> status `delivered`, fulfilment `fulfilled`
 *
 * THE TOP-RATED RISK IN research/04 IS THAT AN ADMIN CONTROL LEARNS TO SAY
 * MONEY ARRIVED. `orders.status` has eleven members; three of them
 * (`advance_paid`, `paid`, `refunded`) assert a payment. No CHECK constraint
 * stops a write of any of them, `PAYMENT_CAPTURE_ENABLED` is false, and the
 * visible consequence of getting it wrong is a customer being told they paid
 * when nothing was ever taken.
 *
 * The remedy is structural rather than careful:
 *
 *   1. The request never names a status. It names an INTENT, and the target
 *      status is looked up in `STATUS_ACTIONS`, a compile-time table. A POST
 *      carrying `status=paid` has nothing to bind to.
 *   2. `assertNoPaymentClaim()` re-checks the looked-up target against
 *      `PAYMENT_BEARING_STATUSES` immediately before the batch is built, so
 *      the guarantee survives someone editing the table later.
 *   3. `payment_status` is not in any statement this file issues. The column
 *      is untouched by every path here.
 *
 * ===========================================================================
 * THE TRANSITION IS GATED BY A CONSTRAINT, NOT BY A WHERE CLAUSE
 * ===========================================================================
 * `UPDATE_STATUS` copies the shape `cancelOrder()` uses: an ineligible state
 * writes NULL into a NOT NULL column, which raises a constraint error and
 * ABORTS THE BATCH — taking the audit row with it. A guard written as a WHERE
 * clause would instead make an illegal transition a silent no-op, and a silent
 * no-op is how an order that has already gone out of the door gets marked
 * ready to collect.
 *
 * ===========================================================================
 * EVERY WRITE IS AUDITED IN THE SAME BATCH
 * ===========================================================================
 * `auditStatement()` puts the audit row inside the caller's own `db.batch()`,
 * which is the only atomicity primitive D1 offers. An audit row written in a
 * second batch either records a change that did not commit or misses one that
 * did. `cancelOrder()` already writes its own `order.cancelled` row inside its
 * batch, so the cancel path here adds none — a second row would report the
 * same act twice.
 *
 * ===========================================================================
 * TWO CALLERS, ONE CODE PATH
 * ===========================================================================
 * A browser form gets a 303 back to the order with a notice code from a closed
 * set; a JSON caller gets the real status code. Nothing from the request body
 * is ever reflected into a `Location`: the order number is matched against
 * `ORDER_NUMBER_PATTERN` before it is used to build one, and the notice is one
 * of nine constants.
 */

import {
  ADMIN_RESPONSE_HEADERS,
  getAdminDb,
  readAdminCookieValue,
  refuseCrossSite,
  requireAdmin,
  tokenFromCookieValue,
  verifyCsrfToken,
} from "../../../_admin/session";
import { auditStatement, buildDiff, toAuditRow } from "../../../_admin/audit";
import {
  CANCELLATION_REASON_CODES,
  cancelOrder,
  isOrderNumber,
  type CancellationReasonCode,
} from "../../../_data/orders";
import { actorFrom, readAdminOrderDetail } from "../../../_admin/data";
import {
  STATUS_ACTIONS,
  isPaymentBearingStatus,
  type StatusIntent,
} from "../../../admin/orders/orders-data";

/* =========================================================================
 * Notices — a closed set, rendered by exact match on the page
 * ====================================================================== */

export const ORDER_ACTION_NOTICES = {
  cancelled: "cancelled",
  alreadyCancelled: "already-cancelled",
  notCancellable: "not-cancellable",
  needsReason: "needs-reason",
  torn: "torn",
  ready: "ready",
  collected: "collected",
  notAllowed: "not-allowed",
  refused: "refused",
  unavailable: "unavailable",
} as const;

export type OrderActionNotice =
  (typeof ORDER_ACTION_NOTICES)[keyof typeof ORDER_ACTION_NOTICES];

/**
 * Where the browser is sent back to. The order number is validated against the
 * pattern before it is interpolated, so the only thing that can appear in a
 * `Location` is a well-formed order number and one of the constants above.
 */
export function orderHref(orderNumber: string | null, notice?: OrderActionNotice): string {
  const base =
    orderNumber !== null && isOrderNumber(orderNumber)
      ? `/admin/orders/${orderNumber}`
      : "/admin/orders";
  return notice ? `${base}?notice=${notice}` : base;
}

/* =========================================================================
 * Request plumbing
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
  readonly notice: OrderActionNotice;
  readonly error?: string;
  readonly ok?: boolean;
};

function respond(request: Request, orderNumber: string | null, answer: Answer): Response {
  const result = headers();

  if (isFormPost(request)) {
    // Even a refusal is a 303: a 4xx carrying a Location is a blank page the
    // browser will not follow, and a blank page tells the owner nothing. The
    // failure travels as the notice code and the page says it in words.
    result.set("Location", orderHref(orderNumber, answer.notice));
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
  readonly orderNumber: string;
  readonly reasonCode: string;
  readonly note: string;
  readonly csrf: string;
};

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function readSubmission(request: Request): Promise<Submission> {
  const empty = { intent: "", orderNumber: "", reasonCode: "", note: "", csrf: "" };

  if (isFormPost(request)) {
    const form = await request.formData();
    return {
      intent: asText(form.get("intent")),
      orderNumber: asText(form.get("orderNumber")).toUpperCase(),
      reasonCode: asText(form.get("reasonCode")),
      note: asText(form.get("note")),
      csrf: asText(form.get("csrf")),
    };
  }

  try {
    const payload = (await request.json()) as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") return empty;
    return {
      intent: asText(payload.intent),
      orderNumber: asText(payload.orderNumber).toUpperCase(),
      reasonCode: asText(payload.reasonCode),
      note: asText(payload.note),
      csrf: asText(payload.csrf),
    };
  } catch {
    return empty;
  }
}

/* =========================================================================
 * The two writes
 * ====================================================================== */

/**
 * See `cancelOrder()`'s `CANCEL_ORDER` for the argument. The CASE is evaluated
 * against the pre-UPDATE row, so an order that is not in a state this intent
 * may be applied from writes NULL into `orders.status`, which is NOT NULL, and
 * the batch aborts with its audit row.
 */
function updateStatusSql(from: readonly string[]): string {
  const list = from.map((status) => `'${status}'`).join(", ");
  return `
    UPDATE orders
    SET status = CASE
          WHEN status IN (${list}) AND fulfilment_status = 'unfulfilled'
          THEN ? ELSE NULL
        END,
        fulfilment_status = CASE
          WHEN status IN (${list}) AND fulfilment_status = 'unfulfilled'
          THEN ? ELSE fulfilment_status
        END,
        updated_at = ?
    WHERE id = ?`;
}

/**
 * The last gate before the write. A target status that asserts money was
 * received is a programming error, not a user outcome, so it throws rather
 * than returning something the UI would render.
 */
function assertNoPaymentClaim(status: string): void {
  if (isPaymentBearingStatus(status)) {
    throw new Error(
      `[admin-orders] refusing to write status "${status}": it asserts a payment this shop cannot have taken.`
    );
  }
}

/** The human sentence stored on the order beside the reason code. */
const REASON_SENTENCES: Readonly<Record<CancellationReasonCode, string>> = {
  customer_request: "The customer asked for the order to be cancelled.",
  not_reachable: "The shop could not reach the customer to settle the order.",
  shop_declined: "The shop declined the order.",
  piece_unavailable: "The piece cannot be supplied.",
  placed_in_error: "The order was placed in error.",
  other: "Cancelled by the shop.",
};

function isReasonCode(value: string): value is CancellationReasonCode {
  return (CANCELLATION_REASON_CODES as readonly string[]).includes(value);
}

/* =========================================================================
 * POST
 * ====================================================================== */

export async function POST(request: Request): Promise<Response> {
  // A missing Origin is refused on this side of the door: there is no
  // legitimate non-browser admin client, so the header a browser always sends
  // is one an admin request must always carry.
  if (refuseCrossSite(request)) {
    return respond(request, null, {
      status: 403,
      notice: ORDER_ACTION_NOTICES.refused,
      error: "That request did not come from this site, so nothing was changed.",
    });
  }

  const submission = await readSubmission(request);
  const orderNumber = isOrderNumber(submission.orderNumber) ? submission.orderNumber : null;

  let db;
  try {
    db = getAdminDb();
  } catch (error) {
    console.error("[admin-orders] no database, so no order can be changed:", error);
    return respond(request, orderNumber, {
      status: 503,
      notice: ORDER_ACTION_NOTICES.unavailable,
      error: "The order book could not be reached, so nothing was changed.",
    });
  }

  // `proxy.ts` is defence; this is the defence. It is the only check that sees
  // a revoked, expired, idled-out or deactivated session, none of which a
  // signed cookie can express on its own.
  const session = await requireAdmin(request, { db });
  if (!session.ok) {
    return respond(request, orderNumber, {
      status: 401,
      notice: ORDER_ACTION_NOTICES.refused,
      error: "Sign in to use the admin panel.",
    });
  }

  const token = await tokenFromCookieValue(readAdminCookieValue(request.headers.get("cookie")));
  if (!token || !(await verifyCsrfToken(token, submission.csrf))) {
    return respond(request, orderNumber, {
      status: 403,
      notice: ORDER_ACTION_NOTICES.refused,
      error: "That request could not be verified, so nothing was changed.",
    });
  }

  if (orderNumber === null) {
    return respond(request, null, {
      status: 400,
      notice: ORDER_ACTION_NOTICES.notAllowed,
      error: "That is not an order number this shop issues.",
    });
  }

  const identity = session.identity;

  try {
    if (submission.intent === "cancel") {
      return await handleCancel(request, db, orderNumber, submission, identity.email);
    }

    if (submission.intent === "mark_ready" || submission.intent === "mark_collected") {
      return await handleStatus(request, db, orderNumber, submission.intent, {
        identity,
        ip: request.headers.get("cf-connecting-ip"),
        userAgent: request.headers.get("user-agent"),
      });
    }
  } catch (error) {
    console.error(`[admin-orders] ${submission.intent} on ${orderNumber} failed:`, error);
    return respond(request, orderNumber, {
      status: 503,
      notice: ORDER_ACTION_NOTICES.unavailable,
      error: "Nothing was changed. Try again, and if it happens twice tell whoever runs the site.",
    });
  }

  // An intent nobody publishes. Note what this refusal covers: `paid`,
  // `advance_paid`, `refunded` and every other status name land here, because
  // a status is not an intent.
  return respond(request, orderNumber, {
    status: 400,
    notice: ORDER_ACTION_NOTICES.notAllowed,
    error: "That is not something this screen can do to an order.",
  });
}

/* -------------------------------------------------------------------------
 * cancel
 * ---------------------------------------------------------------------- */

async function handleCancel(
  request: Request,
  db: ReturnType<typeof getAdminDb>,
  orderNumber: string,
  submission: Submission,
  actorEmail: string
): Promise<Response> {
  if (!isReasonCode(submission.reasonCode)) {
    // `cancelOrder()` refuses without a reason, and it is right to: Rule 4(8)
    // turns on why an order ended and who ended it. The screen asks again
    // rather than inventing one.
    return respond(request, orderNumber, {
      status: 400,
      notice: ORDER_ACTION_NOTICES.needsReason,
      error: "Say why the order is being cancelled.",
    });
  }

  const reasonCode = submission.reasonCode;
  const typed = submission.note.slice(0, 800);
  const note =
    reasonCode === "other"
      ? typed
      : typed === ""
        ? REASON_SENTENCES[reasonCode]
        : `${REASON_SENTENCES[reasonCode]} ${typed}`;

  if (note === "") {
    return respond(request, orderNumber, {
      status: 400,
      notice: ORDER_ACTION_NOTICES.needsReason,
      error: "Say why the order is being cancelled.",
    });
  }

  // The actor is the signed-in admin's email and nothing else. A cancellation
  // nobody is named for is a false audit trail, and a false audit trail is
  // worse than none because it gets produced in evidence.
  const outcome = await cancelOrder(db, { orderNumber, actor: actorEmail, reasonCode, note });

  if (outcome.ok) {
    return respond(request, orderNumber, {
      status: 200,
      ok: true,
      notice: ORDER_ACTION_NOTICES.cancelled,
    });
  }

  switch (outcome.reason) {
    case "already_cancelled":
      // Truthful, and not an error: the stock was restored once, by the first
      // cancellation, and the idempotency key in `cancelOrder()`'s batch is
      // what guarantees it — not this branch.
      return respond(request, orderNumber, {
        status: 200,
        notice: ORDER_ACTION_NOTICES.alreadyCancelled,
        error: "This order was already cancelled. Nothing was changed again.",
      });
    case "torn":
      return respond(request, orderNumber, {
        status: 409,
        notice: ORDER_ACTION_NOTICES.torn,
        error:
          "Part of this order is missing from the records, so what it took off the wall is not known. It has not been cancelled.",
      });
    case "not_found":
      return respond(request, orderNumber, {
        status: 404,
        notice: ORDER_ACTION_NOTICES.notAllowed,
        error: "There is no order with that number.",
      });
    case "not_cancellable":
      return respond(request, orderNumber, {
        status: 409,
        notice: ORDER_ACTION_NOTICES.notCancellable,
        error:
          "This order cannot be cancelled now. The piece has already left the shop. That needs a return, which is a different act.",
      });
    default:
      return respond(request, orderNumber, {
        status: 503,
        notice: ORDER_ACTION_NOTICES.unavailable,
        error: "Nothing was changed. Try again, and if it happens twice tell whoever runs the site.",
      });
  }
}

/* -------------------------------------------------------------------------
 * mark_ready / mark_collected
 * ---------------------------------------------------------------------- */

async function handleStatus(
  request: Request,
  db: ReturnType<typeof getAdminDb>,
  orderNumber: string,
  intent: StatusIntent,
  who: {
    readonly identity: { readonly email: string; readonly adminUserId: string };
    readonly ip: string | null;
    readonly userAgent: string | null;
  }
): Promise<Response> {
  const action = STATUS_ACTIONS[intent];
  assertNoPaymentClaim(action.toStatus);

  // The SAME reader the screen used, so what the endpoint believes it may do
  // and what the screen offered cannot come apart — and so `allowedActions`
  // has exactly one definition. It writes its own record-opened audit row.
  const order = await readAdminOrderDetail(db, orderNumber, {
    actor: actorFrom(who.identity, { ip: who.ip, userAgent: who.userAgent }),
  });
  if (order === null) {
    return respond(request, orderNumber, {
      status: 404,
      notice: ORDER_ACTION_NOTICES.notAllowed,
      error: "There is no order with that number.",
    });
  }

  // An order that does not reconcile against its own line count is not
  // fulfillable, and `db/schema.ts` compensation (5) says so plainly.
  if (!order.intact) {
    return respond(request, orderNumber, {
      status: 409,
      notice: ORDER_ACTION_NOTICES.torn,
      error:
        "Part of this order is missing from the records, so it cannot be moved on. Ring the customer and take the order again.",
    });
  }

  if (!order.allowedActions.includes(intent)) {
    return respond(request, orderNumber, {
      status: 409,
      notice: ORDER_ACTION_NOTICES.notAllowed,
      error: "This order is not in a state that can be moved that way.",
    });
  }

  const now = new Date().toISOString();
  const audit = toAuditRow({
    actorEmail: who.identity.email,
    actorAdminUserId: who.identity.adminUserId,
    // The convention `db/schema.ts` sets for this entity.
    action: "order.status_changed",
    entityType: "order",
    entityId: order.id,
    // Allowlist-driven: `status` and `fulfilment_status` are workflow states
    // and carry their values; anything else would come back as "changed".
    // Nothing here is a name, a number or an address.
    diff: buildDiff(
      "order",
      { status: order.status, fulfilment_status: order.fulfilmentStatus },
      { status: action.toStatus, fulfilment_status: action.toFulfilment }
    ),
    ip: who.ip,
    userAgent: who.userAgent,
  });

  const results = await db.batch([
    {
      sql: updateStatusSql(action.from),
      params: [action.toStatus, action.toFulfilment, now, order.id],
    },
    auditStatement(audit),
  ]);

  if ((results[0]?.changes ?? 0) !== 1) {
    console.error(`[admin-orders] ${orderNumber}: the transition changed no row, yet it committed.`);
    return respond(request, orderNumber, {
      status: 503,
      notice: ORDER_ACTION_NOTICES.unavailable,
      error: "Nothing was changed. Try again, and if it happens twice tell whoever runs the site.",
    });
  }

  return respond(request, orderNumber, {
    status: 200,
    ok: true,
    notice: action.notice as OrderActionNotice,
  });
}

/**
 * There is no GET, and there is no DELETE.
 *
 * No GET because `SameSite=Lax` sends the session cookie on a top-level
 * navigation, so a GET that changed anything would be a CSRF payload delivered
 * by a link. No DELETE because ORDERS ARE APPEND-ONLY: an order is a GST and
 * hallmarking record the shop must keep for five years, a cancellation is a
 * status transition rather than a removal, and there is no code path anywhere
 * in this application that deletes one.
 */
export function GET(): Response {
  const result = headers();
  result.set("Allow", "POST");
  result.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      ok: false,
      error: "Use POST. Orders cannot be read or deleted through this endpoint.",
    }),
    { status: 405, headers: result }
  );
}
