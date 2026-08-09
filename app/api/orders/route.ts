/**
 * THE ORDER ENDPOINT — /api/orders.
 *
 * ===========================================================================
 * THIS ROUTE INVERTS TWO OF /api/appointments' RULES, AND COPIES ONE
 * ===========================================================================
 * The appointments route is a considered design for a LEAD. An order is not a
 * lead, and `.claude-protocol/state.json` records both inversions as hazards.
 *
 *  1. THERE IS NO DUAL SINK. Appointments treat "D1 **or** the webhook accepted
 *     it" as success, because a lead that reached a human is a captured lead.
 *     For an order that is backwards: a webhook-only order with no database row
 *     has no invoice, no stock decrement and no record that money is owed
 *     against anything. It is a LOST ORDER wearing a confirmation page. So D1
 *     is the only sink here, it is not optional, and a failure to write is
 *     reported — 503, `ok: false`, "nothing was ordered". This route never
 *     answers 201 on a write it did not make.
 *
 *  2. THERE IS NO THROTTLE. Appointments answer a repeat submission with a
 *     fabricated `201 {ok:true}` so a bot learns nothing. Doing that here would
 *     tell a customer placing their second, legitimate order that it worked
 *     when nothing happened — and that customer is owed a piece. The only
 *     duplicate suppression is the one the database performs: a second
 *     submission of the SAME cart collides on `webhook_events.id` inside the
 *     placement batch, and the answer is a truthful "already placed" carrying
 *     the number of the order that stands. Never a fake success.
 *
 *  3. THE SAME-ORIGIN CHECK IS COPIED FROM /api/cart, verbatim in behaviour: a
 *     cross-site POST cannot place an order in someone's name off the back of
 *     their cart cookie. A request with NO `Origin` is allowed through, because
 *     the attack needs a browser and a browser sends the header.
 *
 * ===========================================================================
 * TWO CALLERS, TWO SHAPES, ONE CODE PATH
 * ===========================================================================
 *   application/x-www-form-urlencoded  ->  303 See Other to /checkout?…
 *   application/json  (or anything else)->  JSON, the house `{ok, …}` shape
 *
 * The redirect target is built by `checkoutHref()` from a closed set of notice
 * codes plus, on success, an order number matched against
 * `ORDER_NUMBER_PATTERN`. Nothing from the request body is ever reflected into
 * a `Location` header, so there is no open redirect and nothing to inject into.
 *
 * ===========================================================================
 * NOTHING HERE SAYS A PAYMENT SUCCEEDED
 * ===========================================================================
 * `PAYMENT_CAPTURE_ENABLED` is false. Every response below carries
 * `paid: false`, `amountPaidPaise: 0` and `paymentStatus: "unpaid"`, and the
 * human sentence comes from `paymentStanding()` in the data layer — the single
 * place payment copy is written, so the endpoint and the page cannot drift.
 */

import {
  CHECKOUT_NOTICES,
  PAYMENT_CAPTURE_ENABLED,
  checkoutHref,
  getOrderDb,
  noticeForBlock,
  paymentStanding,
  placeOrder,
  resolveCheckout,
  validateCheckoutDetails,
  type CheckoutField,
  type CheckoutNotice,
} from "../../_data/orders";
import { readCartTokenFromCookieHeader } from "../../_data/cart";

/**
 * Same-origin check for the one state-changing method here. `SameSite=Lax`
 * already stops the cart cookie riding along on a cross-site POST; this closes
 * the remaining case of a third-party page driving an order off a request the
 * browser will still attach cookies to on a top-level navigation.
 */
function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return false;

  let host = request.headers.get("host");
  if (!host) {
    try {
      host = new URL(request.url).host;
    } catch {
      return false;
    }
  }

  try {
    return new URL(origin).host !== host;
  } catch {
    // An Origin header that is not a URL was not written by a browser.
    return true;
  }
}

function isFormPost(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  );
}

type Answer = {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly notice: CheckoutNotice;
  readonly ref?: string;
  readonly fields?: readonly CheckoutField[];
};

/**
 * One outcome, rendered for whichever caller asked.
 *
 * A JSON caller gets the real status code. A BROWSER FORM always gets the 303,
 * including on failure, because a 4xx with a `Location` is a blank page the
 * browser will not follow, and a blank page tells a customer nothing. The
 * failure is not swallowed: it travels as the notice code and `/checkout`
 * renders it in the shop's own words.
 */
function respond(request: Request, answer: Answer): Response {
  if (isFormPost(request)) {
    return new Response(null, {
      status: 303,
      headers: {
        Location: checkoutHref({
          notice: answer.notice,
          ...(answer.ref === undefined ? {} : { ref: answer.ref }),
          ...(answer.fields === undefined ? {} : { fields: answer.fields }),
        }),
      },
    });
  }

  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Read the submitted fields from either body shape, as plain strings. */
async function readSubmission(
  request: Request
): Promise<Record<string, unknown> | null> {
  if (isFormPost(request)) {
    const form = await request.formData();
    const values: Record<string, unknown> = {};
    for (const [key, value] of form.entries()) {
      if (typeof value === "string") values[key] = value;
    }
    return values;
  }

  try {
    const payload = (await request.json()) as unknown;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function POST(request: Request): Promise<Response> {
  if (isCrossSite(request)) {
    return respond(request, {
      status: 403,
      body: { ok: false, error: "Orders must be placed from this site." },
      notice: "bad-request",
    });
  }

  const submission = await readSubmission(request);
  if (submission === null) {
    return respond(request, {
      status: 400,
      body: { ok: false, error: "Request body must be valid JSON or a form submission." },
      notice: "bad-request",
    });
  }

  const token = readCartTokenFromCookieHeader(request.headers.get("cookie"));

  try {
    const db = getOrderDb();

    // The cart, resolved into either something that can lawfully become an
    // order or a list of stated reasons. There is no third outcome, and the
    // `PriceableOrderCheckout` this returns is the only thing `placeOrder()`
    // will accept — an unpriceable cart cannot be expressed as an order.
    const resolution = await resolveCheckout(db, { token });

    if (!resolution.ok) {
      const notice = noticeForBlock(resolution.reason);
      return respond(request, {
        // `shop_state_unknown` is our gap, not the customer's, so it is a 5xx.
        status: resolution.reason === "shop_state_unknown" ? 503 : 409,
        body: {
          ok: false,
          error: CHECKOUT_NOTICES[notice],
          reason: resolution.reason,
          blocked: resolution.blocked.map((line) => ({
            slug: line.slug,
            reason: line.reason,
          })),
        },
        notice,
      });
    }

    const { checkout, shopStateCode } = resolution;

    const validation = validateCheckoutDetails(submission, {
      totalPaise: checkout.quote.totalPaise,
    });
    if (!validation.ok) {
      return respond(request, {
        status: 400,
        body: {
          ok: false,
          error: CHECKOUT_NOTICES["needs-detail"],
          fields: validation.fields,
        },
        notice: "needs-detail",
        fields: validation.fields,
      });
    }

    const placed = await placeOrder(db, checkout, validation.details, { shopStateCode });

    if (!placed.ok) {
      switch (placed.reason) {
        case "already_placed":
          // Truthful, and it carries the order that stands. Not a fake success:
          // `ok` is false and `placed` is false, because THIS request placed
          // nothing.
          return respond(request, {
            status: 200,
            body: {
              ok: false,
              placed: false,
              alreadyPlaced: true,
              orderNumber: placed.orderNumber,
              error: CHECKOUT_NOTICES["already-placed"],
            },
            notice: "already-placed",
            ref: placed.orderNumber,
          });
        case "sold_out":
          return respond(request, {
            status: 409,
            body: { ok: false, placed: false, error: CHECKOUT_NOTICES["sold-out"] },
            notice: "sold-out",
          });
        case "torn":
          return respond(request, {
            status: 500,
            body: {
              ok: false,
              placed: true,
              intact: false,
              orderNumber: placed.orderNumber,
              error: CHECKOUT_NOTICES.torn,
            },
            notice: "torn",
            ref: placed.orderNumber,
          });
        default:
          console.error("[orders] placement failed:", placed.message);
          return respond(request, {
            status: 503,
            body: { ok: false, placed: false, error: CHECKOUT_NOTICES.unavailable },
            notice: "unavailable",
          });
      }
    }

    const standing = paymentStanding(PAYMENT_CAPTURE_ENABLED, {
      plan: placed.paymentPlan,
      fulfilment: placed.fulfilmentMode,
    });

    return respond(request, {
      status: 201,
      body: {
        ok: true,
        placed: true,
        // The reference the customer quotes. There is no separate ticket
        // number here any more: E-Commerce Rule 7(1)(f) issues one per
        // COMPLAINT LODGED, and a purchase is not a complaint — opening one at
        // placement started Rule 4(5)'s clocks on every order and consumed the
        // single `orders.complaint_ticket_number` slot a real complaint needs.
        // See section (10) of app/_data/orders.ts.
        orderNumber: placed.orderNumber,
        lineItemCount: placed.lineItemCount,
        totalPaise: placed.totalPaise,
        amountDuePaise: placed.advanceDuePaise,
        balanceDuePaise: placed.balanceDuePaise,
        // Nothing has moved, and every field says so on its own.
        paid: false,
        amountPaidPaise: 0,
        paymentStatus: "unpaid",
        orderStatus: "pending_payment",
        paymentCaptureEnabled: PAYMENT_CAPTURE_ENABLED,
        paymentPlan: placed.paymentPlan,
        fulfilmentMode: placed.fulfilmentMode,
        message: standing.body,
      },
      notice: "placed",
      ref: placed.orderNumber,
    });
  } catch (error) {
    // The single sink failed. There is no second one, and no pretending.
    console.error("[orders] the order book is unavailable:", error);
    return respond(request, {
      status: 503,
      body: { ok: false, placed: false, error: CHECKOUT_NOTICES.unavailable },
      notice: "unavailable",
    });
  }
}

/**
 * Deliberately not readable.
 *
 * An order number is short, printable and read out over a phone, so it is not a
 * credential; a `GET /api/orders?number=…` would hand a stranger's name, phone
 * and address to anyone who guessed one. The confirmation is read on
 * `/checkout`, scoped by the cart cookie that produced the order.
 */
export function GET(): Response {
  return Response.json(
    { ok: false, error: "Method not allowed. Use POST /api/orders." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
