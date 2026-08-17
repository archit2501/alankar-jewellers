/* eslint-disable @next/next/no-html-link-for-pages --
 * Plain anchors, for the reason app/admin/layout.tsx gives at length:
 * `next/link` prefetches, and in here a prefetch is a fully authenticated
 * render of a page nobody opened — which, because reads of customer data are
 * audited, would write `customer_data.record_opened` rows for records that
 * were never looked at. An audit log that reports reads which did not happen
 * is worse than one that is merely slow.
 */

/**
 * THE ORDERS LIST — /admin/orders.
 *
 * ===========================================================================
 * THIS IS A QUEUE, NOT A DASHBOARD
 * ===========================================================================
 * The owner's unit of work is a PERSON. So the customer's name is the largest
 * thing on a row, the amount is right-aligned so the column can be scanned as
 * a column without being a table, and Call and WhatsApp sit on the row itself
 * rather than behind a tap-through — follow-up happens by phone.
 *
 * Counts are filter links in a sentence, never stat tiles: research/05 §3,
 * "a stat tile you cannot click is a dead end."
 *
 * ===========================================================================
 * WHAT CHANGED SINCE research/05 WAS WRITTEN, AND WHY
 * ===========================================================================
 * §7 of that document calls the 48-hour reply clock "the shape-changing fact"
 * and sorts this list by deadline. THAT FACT NO LONGER HOLDS, and reinstating
 * it here would undo a fix. Task 0.2 stopped `placeOrder()` opening a
 * `support_tickets` row per order: Consumer Protection (E-Commerce) Rule 4(5)
 * runs from the receipt of a CONSUMER COMPLAINT, not from a purchase, and a
 * database asserting a breached SLA against every order made the overdue queue
 * worthless. An order therefore carries no statutory reply deadline and this
 * screen prints none. The clock belongs to complaints.
 *
 * So the sort is recency, which is what is left when the deadline is gone, and
 * the filters are about where the piece is rather than about a countdown.
 *
 * ===========================================================================
 * THE FILTERS GROUP A PAGE, AND THE SENTENCE SAYS SO
 * ===========================================================================
 * `listAdminOrders()` returns the most recent orders up to a limit; it has no
 * status predicate. Rather than write a second query for one — a second reader
 * of orders is a second place for `assertOrderIntact()` to be forgotten — the
 * buckets group the rows that came back, and the sentence above them says
 * "of the latest N" whenever the page is full. A count that silently means
 * "of the fifty I happened to fetch" is the kind of number an owner makes a
 * decision on and should not.
 *
 * ===========================================================================
 * THE READ IS LOGGED BY THE READER
 * ===========================================================================
 * This page prints names and phone numbers, so opening it is an access to
 * personal data under DPDP Rule 6(1)(c). `listAdminOrders()` writes that row
 * itself, recording which FIELDS were searched and how many rows came back —
 * never the term, because a phone number typed into a search box is the same
 * personal datum whether it sits in a customer row or in a log line about one.
 * This page therefore writes no audit row of its own; a second would report
 * one read as two.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";

import { listAdminOrders, readClock, resolveAdmin, formatWhen } from "../../_admin/data";
import { getAdminDb } from "../../_admin/session";
import type { AdminOrderRow } from "../../_admin/view-types";
import { formatPaiseAsRupees } from "../../_pricing/rates";
import { site } from "../../site-config";
import {
  DEFAULT_STATUS,
  ORDER_FILTERS,
  matchesFilter,
  pieces,
  statusWord,
  toOrderFilter,
  waNumber,
  type OrderFilter,
} from "./orders-data";
import "./orders.css";

/** Keyed on one admin's cookie. A cached admin list is one shop's customers
 *  served to whoever asks next. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Orders | ${site.name}`,
  robots: { index: false, follow: false, nocache: true },
};

/** How many the reader is asked for. The sentence names it when it is hit. */
const PAGE_SIZE = 50;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/* =========================================================================
 * A row
 * ====================================================================== */

function Row({ order, nowMs }: { order: AdminOrderRow; nowMs: number }) {
  const name = order.customerName ?? "No name recorded";
  const phone = order.customerPhone;

  const contact =
    phone === null ? null : (
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
    );

  /* A TORN ORDER IS REPORTED, NEVER TOTALLED.
   *
   * No amount, because `assertOrderIntact()` has already said the figures are
   * incomplete and a partial sum shown as a total is worse than an error
   * message. No link through to a bill either, and no disabled control — a
   * disabled button invites a retry. What the row gives instead is the two
   * things that resolve it: the customer's name, and a way to ring them. */
  if (!order.intact) {
    return (
      <li className="ord__row">
        <p className="ord__name ord__alert">
          <span className="ord__mark" aria-hidden="true" />
          {order.orderNumber} did not save fully
        </p>
        <p className="ord__what">
          {name} · <time dateTime={order.placedAt}>{formatWhen(order.placedAt, nowMs)}</time>
        </p>
        <p className="ord__what">
          Part of this order is missing, so its bill would be wrong. Do not invoice it and do
          not take money for it. Nothing has been charged. Ring the customer and take the
          order again.
        </p>
        {contact}
      </li>
    );
  }

  return (
    <li className="ord__row">
      <div className="ord__rowhead">
        <h2 className="ord__name">
          <a href={`/admin/orders/${order.orderNumber}`}>{name}</a>
        </h2>
        <span className="ord__amount">₹{formatPaiseAsRupees(order.totalPaise ?? 0)}</span>
      </div>
      <p className="ord__what">{pieces(order.lineCount)}</p>
      <p className="ord__mono">
        {order.orderNumber} ·{" "}
        <time dateTime={order.placedAt}>{formatWhen(order.placedAt, nowMs)}</time>
      </p>
      {/* The default state prints on no row: the same word on every row teaches
          nothing. Everything else is named in the shop's own words. */}
      {order.status === DEFAULT_STATUS ? null : (
        <p className="ord__state">{statusWord(order.status)}</p>
      )}
      {contact}
    </li>
  );
}

/* =========================================================================
 * The page
 * ====================================================================== */

export default async function AdminOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nowMs = readClock();
  const inbound = await headers();

  // The layout has already refused an anonymous request, and this asks again.
  // Both, always: a Server Action defined in an admin module but rendered by a
  // public page never passes a matcher, and a page that trusts its layout is
  // trusting a file it does not import.
  const current = await resolveAdmin({
    cookie: inbound.get("cookie"),
    ip: inbound.get("cf-connecting-ip"),
    userAgent: inbound.get("user-agent"),
  });

  if (current === null) {
    return (
      <div className="ord">
        <h1 className="ord__title">Sign in to see the orders</h1>
        <p className="ord__lede">
          This session has ended, so nothing is shown. Signing in again brings the orders back
          exactly as they were.
        </p>
      </div>
    );
  }

  const params = await searchParams;
  const filter: OrderFilter = toOrderFilter(first(params.show));
  const query = first(params.q).slice(0, 80).trim();

  let rows: AdminOrderRow[];
  try {
    rows = await listAdminOrders(getAdminDb(), {
      actor: current.actor,
      search: query === "" ? null : query,
      limit: PAGE_SIZE,
      nowMs,
    });
  } catch (error) {
    // An admin panel that cannot read the database says so. It never renders
    // an empty list, which reads as "you have no orders".
    console.error("[admin-orders] the order book could not be read:", error);
    return (
      <div className="ord">
        <h1 className="ord__title">Orders</h1>
        <p className="ord__notice ord__notice--problem">
          The order book could not be read just now, so nothing is shown. This is the
          website&rsquo;s own problem and not a sign that an order is missing. Try again in a
          moment.
        </p>
      </div>
    );
  }

  const filters = Object.keys(ORDER_FILTERS) as OrderFilter[];
  const counts = {} as Record<OrderFilter, number>;
  for (const key of filters) {
    counts[key] = rows.filter((order) => matchesFilter(order.status, key)).length;
  }

  const shown = rows.filter((order) => matchesFilter(order.status, filter));
  const full = rows.length >= PAGE_SIZE;

  return (
    <div className="ord">
      <h1 className="ord__title">Orders</h1>

      <form className="ord__search" method="get" action="/admin/orders" role="search">
        <label className="ord__label" htmlFor="ord-q">
          Find an order
        </label>
        <input
          className="ord__input"
          id="ord-q"
          type="search"
          name="q"
          defaultValue={query}
          placeholder="Phone number, name or order no."
          autoCapitalize="none"
          spellCheck={false}
        />
        <button className="ord__go" type="submit">
          Search
        </button>
      </form>

      {query === "" ? (
        <p className="ord__filters">
          {full ? "Of the 50 most recent orders: " : null}
          {filters.map((key, index) => (
            <span key={key}>
              {index === 0 ? null : <span className="ord__sep"> · </span>}
              <a
                className="ord__filter"
                href={key === "all" ? "/admin/orders" : `/admin/orders?show=${key}`}
                aria-current={key === filter ? "true" : undefined}
              >
                {ORDER_FILTERS[key].label} {counts[key]}
              </a>
            </span>
          ))}
        </p>
      ) : (
        <p className="ord__filters">
          {shown.length === 1 ? "1 order" : `${shown.length} orders`} found for that search{" "}
          <span className="ord__sep">·</span>{" "}
          <a className="ord__filter" href="/admin/orders">
            All orders
          </a>
        </p>
      )}

      {shown.length === 0 ? (
        query === "" ? (
          /* The empty screen teaches the one mechanic the owner needs to
             understand before the first order arrives. It does not promise
             that orders are coming. */
          <>
            <p className="ord__lede">
              {filter === "all" ? "No orders yet." : "Nothing is in that state at the moment."}
            </p>
            <p className="ord__lede">
              When someone buys through the website their order lands here, with the
              customer&rsquo;s name and number on the row so you can ring them straight back.
            </p>
            <p className="ord__lede">
              Card and UPI are not switched on yet, so an order is a reservation rather than a
              sale: the piece comes off the wall, nothing is charged, and the money is settled
              with the customer directly.
            </p>
          </>
        ) : (
          <>
            <p className="ord__lede">Nothing matches that.</p>
            <p className="ord__lede">
              Try the phone number on its own, or the order number exactly as it is printed.
              They look like <span className="ord__mono">AJ-2608-7QW2XF</span>.
            </p>
          </>
        )
      ) : (
        <ol className="ord__list">
          {shown.map((order) => (
            <Row key={order.id} order={order} nowMs={nowMs} />
          ))}
        </ol>
      )}
    </div>
  );
}
