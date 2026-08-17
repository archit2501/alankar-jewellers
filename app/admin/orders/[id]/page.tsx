/* eslint-disable @next/next/no-html-link-for-pages --
 * Plain anchors. `next/link` prefetches, and a prefetch in here is a fully
 * authenticated render of a page nobody opened — which, because reads of
 * customer data are audited, would write `customer_data.record_opened` rows
 * for records that were never looked at. See app/admin/layout.tsx.
 */

/**
 * ONE ORDER — /admin/orders/[id], where `[id]` is the ORDER NUMBER.
 *
 * The number and never `orders.id`: `db/schema.ts` says plainly "never expose
 * `id` in the UI", and the number is what the shop reads out on the phone. It
 * is not a credential — the session is what authorises this page, which is why
 * `readAdminOrderDetail()` writes a `customer_data.record_opened` row for
 * every render.
 *
 * ===========================================================================
 * TWO DOCUMENTS LIVE HERE AND THEY MUST NOT BE CONFUSED
 * ===========================================================================
 *   THE WORKING PAGE — who to ring, where the piece is, what may be done to it
 *   next. Controls, phone numbers, plain sentences.
 *
 *   THE BILL — a BIS Reg. 5(11) and GST record that has to read as one
 *   document, print as one document, and reconstruct to the paise in 2031.
 *
 * research/05 §8 separates them: the working page is the screen, and the bill
 * is a single bracketed panel that begins at a rule, CONTAINS NO INTERACTIVE
 * CONTROL, and is very nearly the only thing `@media print` emits.
 * `.illuminated--brass` appears on that panel and nowhere else in the admin —
 * ornament marks the statutory.
 *
 * ===========================================================================
 * A TORN ORDER IS REPORTED, NEVER TOTALLED
 * ===========================================================================
 * `assertOrderIntact()` runs on every admin read. When `line_item_count` does
 * not match the rows that exist, the order MUST NOT be invoiced: the torn
 * panel REPLACES the bill entirely, no figure appears anywhere on the page,
 * `allowedActions` is empty so nothing can be done to it, and there is no
 * Print button — not a disabled one, because a disabled control invites a
 * retry.
 *
 * ===========================================================================
 * THE STATUS CONTROL CANNOT CLAIM MONEY ARRIVED
 * ===========================================================================
 * `orders.status` has eleven members and three of them assert a payment. This
 * screen renders `AdminOrderDetail.allowedActions`, whose TYPE cannot express
 * one, so there is no markup path to `paid`, `advance_paid` or `refunded`. And
 * `paymentActionsBlockedReason` is printed as a sentence rather than the
 * options being silently absent, because an unexplained missing control is
 * what produces the phone call to the nephew.
 *
 * ===========================================================================
 * THERE IS NO DELETE, AND THE SCREEN SAYS SO
 * ===========================================================================
 * The same argument. The owner will look for it, and a control that is simply
 * absent reads as a missing feature. One sentence turns a limitation into a
 * reason to trust the tool.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";

import {
  formatWhen,
  readAdminOrderDetail,
  readClock,
  resolveAdmin,
} from "../../../_admin/data";
import { getAdminDb } from "../../../_admin/session";
import type { AdminOrderDetail, AdminOrderLine } from "../../../_admin/view-types";
import {
  CANCELLATION_REASON_CODES,
  PAYMENT_CAPTURE_ENABLED,
  formatWeightMg,
  isOrderNumber,
  type CancellationReasonCode,
} from "../../../_data/orders";
import { formatPaiseAsRupees } from "../../../_pricing/rates";
import { site } from "../../../site-config";
import {
  STATUS_ACTIONS,
  hallmarkingPaiseOf,
  isTaxLabel,
  pieces,
  readRateProvenance,
  statusWord,
  taxOfLine,
  waNumber,
  type RateProvenance,
} from "../orders-data";
import "../orders.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `An order | ${site.name}`,
  robots: { index: false, follow: false, nocache: true },
};

/* =========================================================================
 * Notices — a closed set, rendered by exact match
 * ====================================================================== */

/**
 * Nothing from the query string is ever printed: the code is looked up here
 * and the COPY comes from this table, exactly as `CHECKOUT_NOTICES` does it on
 * the storefront. An unknown code renders nothing at all.
 */
const NOTICES: Readonly<Record<string, { readonly copy: string; readonly problem: boolean }>> = {
  cancelled: {
    copy: "Cancelled. The piece is back on the website, and the order stays in the records.",
    problem: false,
  },
  "already-cancelled": {
    copy: "This order was already cancelled, so nothing happened twice. The piece went back on the website the first time.",
    problem: false,
  },
  "not-cancellable": {
    copy: "This order cannot be cancelled. The piece has already left the shop. That needs a return, which is a different act and a different record.",
    problem: true,
  },
  "needs-reason": {
    copy: "Say why the order is being cancelled. Nothing was changed.",
    problem: true,
  },
  torn: {
    copy: "Part of this order is missing from the records, so nothing was changed. Ring the customer and take the order again.",
    problem: true,
  },
  ready: { copy: "Marked ready to collect.", problem: false },
  collected: { copy: "Marked collected.", problem: false },
  "not-allowed": {
    copy: "That is not something this screen can do to this order, so nothing was changed.",
    problem: true,
  },
  refused: {
    copy: "That request could not be verified, so nothing was changed. Try it again from this page.",
    problem: true,
  },
  unavailable: {
    copy: "Nothing was changed. Try again, and if it happens twice tell whoever runs the site.",
    problem: true,
  },
};

/** The reasons in the owner's language rather than the code's. */
const REASON_LABELS: Readonly<Record<CancellationReasonCode, string>> = {
  customer_request: "The customer changed their mind",
  not_reachable: "We could not reach the customer",
  shop_declined: "The shop is not taking this order",
  piece_unavailable: "The piece is no longer available",
  placed_in_error: "The order was a mistake",
  other: "Something else",
};

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function money(paise: number): string {
  return `₹${formatPaiseAsRupees(paise)}`;
}

/* =========================================================================
 * The bill
 * ====================================================================== */

/**
 * The hallmark number, or the REASON there is not one. Never a blank.
 *
 * `variants.huid` is nullable on purpose: Kundan, Polki and Jadau are exempt
 * under QCO cl. 2(3), and those are this shop's flagship categories. The
 * schema comment is explicit that a missing HUID must not be rendered as an
 * omission. Which of the two sentences applies is decided by whether the bill
 * actually raised a hallmarking charge — `priceLine()` raises none on an
 * exempt article, and a charge with no number against it is a different fact
 * that the shop needs to hear about before the bill is handed over.
 */
function HallmarkRow({ line }: { line: AdminOrderLine }) {
  if (line.huid !== null) {
    return (
      <tr>
        <th scope="row">Hallmark number (HUID)</th>
        <td>{line.huid}</td>
      </tr>
    );
  }

  const charged = hallmarkingPaiseOf(line) > 0;

  return (
    <tr>
      <th scope="row">
        Hallmark number (HUID)
        <span className="bill__why">
          {charged
            ? "Not recorded. A hallmarking charge was raised on this piece, so a number is owed against it. Find it before this bill is given to anyone."
            : "This piece is exempt from hallmarking (QCO cl. 2(3)) and no hallmarking charge was raised on it."}
        </span>
      </th>
      <td>&mdash;</td>
    </tr>
  );
}

function BillLine({
  line,
  index,
  provenance,
}: {
  line: AdminOrderLine;
  index: number;
  provenance: RateProvenance | undefined;
}) {
  return (
    <div className="bill__line">
      <p className="bill__lineTitle">
        {index + 1}. {line.title}
      </p>
      <p className="ord__mono">{line.sku}</p>

      <table className="bill__table">
        <caption>What this piece is</caption>
        <tbody>
          {line.purityLabel === null ? null : (
            <tr>
              <th scope="row">Purity</th>
              <td>{line.purityLabel}</td>
            </tr>
          )}
          {line.netMetalWeightMg === null ? null : (
            <tr>
              <th scope="row">Net metal weight</th>
              <td>{formatWeightMg(line.netMetalWeightMg)}</td>
            </tr>
          )}
          <HallmarkRow line={line} />
        </tbody>
      </table>

      <table className="bill__table">
        <caption>
          What it was priced from
          {line.quantity > 1 ? `, per piece, and this line is ${line.quantity}` : null}
        </caption>
        <tbody>
          {line.breakup.map((entry) => (
            <tr key={entry.label}>
              <th scope="row">{entry.label}</th>
              <td>{money(entry.amountPaise)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bill__foot">
            <th scope="row">Line total</th>
            <td>{money(line.lineTotalPaise)}</td>
          </tr>
        </tfoot>
      </table>

      {/* THE RATE PRINTS INSIDE THE DOCUMENT. research/05 §8 moved it here from
          beside the document deliberately: this line is what makes the price
          defensible when the customer argues on the phone, and it is what a
          Reg. 5(11) reconstruction depends on. It is the rate as it stood when
          the order was taken, never recomputed from today's. */}
      {provenance?.line === undefined || provenance.line === null ? null : (
        <p className="bill__provenance">{provenance.line}</p>
      )}
    </div>
  );
}

/**
 * The statutory panel. No control inside it, ever: a button inside a document
 * prints with the document.
 */
function Bill({
  order,
  provenance,
  nowMs,
}: {
  order: AdminOrderDetail;
  provenance: readonly RateProvenance[];
  nowMs: number;
}) {
  /* The tail is summed off the ROWS THE LINES PRINT, so the document and its
     own total cannot drift: they are the same numbers added twice. A row whose
     label names a tax is a tax row — the one naming convention the view type's
     opaque breakup obliges. */
  const taxTotals = new Map<string, number>();
  let tax = 0;
  for (const line of order.lines) {
    tax += taxOfLine(line);
    for (const entry of line.breakup) {
      if (!isTaxLabel(entry.label)) continue;
      taxTotals.set(entry.label, (taxTotals.get(entry.label) ?? 0) + entry.amountPaise);
    }
  }

  const total = order.totalPaise ?? 0;

  return (
    <section className="bill illuminated illuminated--brass" aria-labelledby="bill-heading">
      <div className="bill__head">
        <h2 className="bill__title" id="bill-heading">
          Bill of sale
        </h2>
        <p className="ord__mono">
          {site.name}
          <br />
          {/* Never a blank where a statutory identifier belongs. */}
          GSTIN &mdash; not yet recorded for this shop
          <br />
          {order.orderNumber} ·{" "}
          <time dateTime={order.placedAt}>{formatWhen(order.placedAt, nowMs)}</time>
        </p>
      </div>

      {order.lines.map((line, index) => (
        <BillLine
          key={`${line.sku}-${index}`}
          line={line}
          index={index}
          provenance={provenance[index]}
        />
      ))}

      <table className="bill__table">
        <caption>What is owed on the whole order</caption>
        <tbody>
          <tr>
            <th scope="row">Taxable value</th>
            <td>{money(total - tax)}</td>
          </tr>
          {/* Whichever tax rows the lines carried, and only those: a printed
              "IGST ₹0" on an intra-state bill is a line an accountant has to
              stop and think about. */}
          {[...taxTotals.entries()].map(([label, amount]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td>{money(amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="bill__foot bill__total">
            <th scope="row">Total</th>
            <td>{money(total)}</td>
          </tr>
          {/* Printable only because capture is off, which makes both figures
              facts rather than guesses: nothing can have been taken. If the
              flag is ever switched on, these two rows must come from the data
              layer instead of being derived here. */}
          {PAYMENT_CAPTURE_ENABLED ? null : (
            <>
              <tr className="bill__foot">
                <th scope="row">Paid</th>
                <td>{money(0)}</td>
              </tr>
              <tr className="bill__foot">
                <th scope="row">Balance due</th>
                <td>{money(total)}</td>
              </tr>
            </>
          )}
        </tfoot>
      </table>
    </section>
  );
}

/** What replaces the bill when the order does not reconcile with itself. */
function TornPanel({ order }: { order: AdminOrderDetail }) {
  return (
    <section className="bill bill--torn" aria-labelledby="torn-heading">
      <h2 className="bill__title ord__alert" id="torn-heading">
        <span className="ord__mark" aria-hidden="true" />
        This order did not save fully
      </h2>
      <p className="ord__what">
        It says it has {pieces(order.lineCount)}, and not all of them were recorded. A bill
        made from this would be wrong, so none is shown and no total is given.
      </p>
      <p className="ord__what">
        Ring {order.contact.name ?? "the customer"} and take the order again. Nothing has been
        charged. Nothing here can be invoiced, cancelled or moved on until a person has looked
        at it.
      </p>
    </section>
  );
}

/* =========================================================================
 * Cancel — a page, not a dialog
 * ====================================================================== */

function CancelPage({ order, csrf }: { order: AdminOrderDetail; csrf: string }) {
  return (
    <div className="ord">
      <p>
        <a className="ord__back" href={`/admin/orders/${order.orderNumber}`}>
          &larr; Back to the order
        </a>
      </p>

      <h1 className="ord__title">
        {order.contact.name === null
          ? "Cancel this order?"
          : `Cancel ${order.contact.name}’s order?`}
      </h1>

      <p className="ord__mono">
        {order.orderNumber}
        {order.totalPaise === null ? null : ` · ₹${formatPaiseAsRupees(order.totalPaise)}`}
      </p>

      <p className="ord__lede">
        This marks the order cancelled and puts the piece back on the website. The order itself
        stays in the records &mdash; it cannot be removed. Nothing has been charged, so there is
        nothing to refund.
      </p>

      <form method="post" action="/api/admin/orders">
        <input type="hidden" name="intent" value="cancel" />
        <input type="hidden" name="orderNumber" value={order.orderNumber} />
        {/* Bound to this session and to no other. An origin check alone rests
            on a header the shop does not control. */}
        <input type="hidden" name="csrf" value={csrf} />

        <fieldset className="ord__reasons">
          <legend>Why?</legend>
          {CANCELLATION_REASON_CODES.map((code, index) => (
            <label className="ord__reason" key={code} htmlFor={`reason-${code}`}>
              <input
                type="radio"
                id={`reason-${code}`}
                name="reasonCode"
                value={code}
                defaultChecked={index === 0}
                required
              />
              <span>{REASON_LABELS[code]}</span>
            </label>
          ))}
        </fieldset>

        <label className="ord__label" htmlFor="cancel-note">
          Anything to add. It is kept with the order
        </label>
        <textarea className="ord__input" id="cancel-note" name="note" rows={3} />

        <p className="ord__acts">
          {/* The button repeats the number, so a mis-tap from the list cannot
              cancel the wrong order. */}
          <button className="ord__btn ord__btn--primary" type="submit">
            {`Yes, cancel ${order.orderNumber}`}
          </button>
        </p>
      </form>

      <p>
        <a className="ord__link" href={`/admin/orders/${order.orderNumber}`}>
          Keep the order
        </a>
      </p>
    </div>
  );
}

/* =========================================================================
 * The page
 * ====================================================================== */

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="ord">
      <p>
        <a className="ord__back" href="/admin/orders">
          &larr; Orders
        </a>
      </p>
      <h1 className="ord__title">{title}</h1>
      {children}
    </div>
  );
}

export default async function AdminOrderPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nowMs = readClock();
  const inbound = await headers();

  const current = await resolveAdmin({
    cookie: inbound.get("cookie"),
    ip: inbound.get("cf-connecting-ip"),
    userAgent: inbound.get("user-agent"),
  });

  if (current === null) {
    return (
      <Shell title="Sign in to see this order">
        <p className="ord__lede">
          This session has ended, so nothing is shown. Signing in again brings the order back
          exactly as it was.
        </p>
      </Shell>
    );
  }

  const { id } = await params;
  const orderNumber = decodeURIComponent(id).toUpperCase();
  const query = await searchParams;

  // Checked before the database is asked, so a malformed handle is a sentence
  // rather than a query. It is also why nothing typed into the URL can reach
  // the log: an unmatched number is never read and never recorded.
  if (!isOrderNumber(orderNumber)) {
    return (
      <Shell title="That is not an order number">
        <p className="ord__lede">
          Order numbers look like <span className="ord__mono">AJ-2608-7QW2XF</span>. Search for
          the customer&rsquo;s phone number instead &mdash; it is the quickest way to find an
          order.
        </p>
      </Shell>
    );
  }

  let order: AdminOrderDetail | null;
  let provenance: readonly RateProvenance[] = [];
  try {
    const db = getAdminDb();
    order = await readAdminOrderDetail(db, orderNumber, { actor: current.actor, nowMs });
    if (order !== null && order.intact) {
      provenance = await readRateProvenance(db, orderNumber, nowMs);
    }
  } catch (error) {
    console.error("[admin-order] the order book could not be read:", error);
    return (
      <Shell title="Orders">
        <p className="ord__notice ord__notice--problem">
          The order book could not be read just now, so nothing is shown. This is the
          website&rsquo;s own problem and not a sign that the order is missing.
        </p>
      </Shell>
    );
  }

  if (order === null) {
    return (
      <Shell title="No order with that number">
        <p className="ord__lede">
          Nothing in the book has the number <span className="ord__mono">{orderNumber}</span>.
          Check it against what the customer has, or search by their phone number.
        </p>
      </Shell>
    );
  }

  if (first(query.action) === "cancel" && order.allowedActions.includes("cancel")) {
    return <CancelPage order={order} csrf={current.identity.csrfToken} />;
  }

  const notice = NOTICES[first(query.notice)];
  const name = order.contact.name ?? "No name recorded";
  const phone = order.contact.phone;

  return (
    <div className="ord">
      <p>
        <a className="ord__back" href="/admin/orders">
          &larr; Orders
        </a>
      </p>

      {notice === undefined ? null : (
        <p
          className={`ord__notice${notice.problem ? " ord__notice--problem" : ""}`}
          role="status"
        >
          {notice.copy}
        </p>
      )}

      {/* The person, above everything. */}
      <h1 className="ord__title">{name}</h1>

      {phone === null ? (
        <p className="ord__lede">No phone number was recorded with this order.</p>
      ) : (
        <>
          <p className="ord__mono">{phone}</p>
          <p className="ord__acts">
            <a className="ord__btn ord__btn--call" href={`tel:${phone}`}>
              Call
            </a>
            <a
              className="ord__btn ord__btn--call"
              href={`https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(
                `${site.name}: about your order ${order.orderNumber}`
              )}`}
              rel="noreferrer"
            >
              WhatsApp
            </a>
          </p>
        </>
      )}

      <p className="ord__mono">
        {order.orderNumber} · Placed{" "}
        <time dateTime={order.placedAt}>{formatWhen(order.placedAt, nowMs)}</time>
      </p>
      <p className="ord__what">
        {statusWord(order.status)}
        {order.cancelledAt === null ? null : (
          <>
            {" "}
            <time dateTime={order.cancelledAt}>{formatWhen(order.cancelledAt, nowMs)}</time>
          </>
        )}
      </p>

      {/* --- What to do now ---------------------------------------------- */}
      <section className="ord__section" aria-labelledby="do-now">
        <h2 className="ord__label" id="do-now">
          What to do now
        </h2>

        {order.allowedActions.length === 0 ? (
          <p className="ord__what">
            {order.intact
              ? "There is nothing left to do to this order here. It has been collected, sent or cancelled, and an order is never edited after that. It is a record."
              : "Nothing can be done to this order until someone has looked at why it did not save fully."}
          </p>
        ) : (
          <div className="ord__acts">
            {(["mark_ready", "mark_collected"] as const).map((intent) =>
              order.allowedActions.includes(intent) ? (
                <form key={intent} method="post" action="/api/admin/orders">
                  <input type="hidden" name="intent" value={intent} />
                  <input type="hidden" name="orderNumber" value={order.orderNumber} />
                  <input type="hidden" name="csrf" value={current.identity.csrfToken} />
                  <button className="ord__btn" type="submit">
                    {STATUS_ACTIONS[intent].label}
                  </button>
                </form>
              ) : null
            )}
          </div>
        )}

        {/* Said in words rather than left as an absence. This is the sentence
            that stops the owner hunting for a "mark as paid" button that must
            not exist. */}
        {order.paymentActionsBlockedReason === null ? null : (
          <p className="ord__blocked">{order.paymentActionsBlockedReason}</p>
        )}

        {order.allowedActions.includes("cancel") ? (
          <p className="ord__what">
            {/* A link to a page, not a button: the confirmation is a second
                page rather than a dialog, so it works without JavaScript and
                can actually be read. */}
            <a className="ord__link" href={`/admin/orders/${order.orderNumber}?action=cancel`}>
              Cancel this order
            </a>
          </p>
        ) : null}
      </section>

      {/* --- The document ------------------------------------------------- */}
      {order.intact ? (
        <>
          <Bill order={order} provenance={provenance} nowMs={nowMs} />
          {/* No Print BUTTON. `window.print()` is the whole of what one would
              do, and a control that needs a bundle to do what the browser
              already does from its own menu is a control that can fail on a
              locked-down shop terminal. The stylesheet does the real work. */}
          <p className="ord__mono">
            To print this bill, use Print in your browser. Only the panel above prints &mdash;
            the buttons, the phone numbers and this note are left off the page.
          </p>
        </>
      ) : (
        <TornPanel order={order} />
      )}

      <p className="ord__nodelete">
        This order cannot be deleted or edited. It is a GST and hallmarking record and the shop
        must keep it for five years, so there is no delete button anywhere on this screen and
        nothing here can change what a customer was charged. An order that was wrong is
        cancelled and taken again, which leaves both facts on the record.
      </p>
    </div>
  );
}
