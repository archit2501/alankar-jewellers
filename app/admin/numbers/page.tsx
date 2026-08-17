/* eslint-disable @next/next/no-html-link-for-pages --
 * Plain anchors, for the reason app/admin/layout.tsx gives: `next/link`
 * prefetches, and in an audited panel a prefetch is a fully authenticated
 * render of a page nobody opened.
 */

/**
 * THE NUMBERS — /admin/numbers.
 *
 * ===========================================================================
 * TWO CHARTS, AND NO TILES AT ALL
 * ===========================================================================
 * Two independent reasons, either sufficient on its own:
 *
 *   1. THE HONEST NUMBERS ARE NOT TAKINGS. `PAYMENT_CAPTURE_ENABLED` is false,
 *      the `payments` row is written `status = 'created'`, `advancePaidPaise`
 *      is 0, and `paymentStanding()` refuses the words "paid" and "received".
 *      A "Revenue today" tile would print a figure that no bank account
 *      contains. Every rupee figure on this screen is therefore what was
 *      ORDERED, and it is rendered by one component that CANNOT print a total
 *      without printing that sentence beside it.
 *   2. A TILE THAT CANNOT BE TAPPED IS A DEAD END. Every count that is
 *      actionable — not settled, making, ready to collect — is already a
 *      filter link on the Orders screen, where the owner can do something
 *      about it. Duplicating them here makes two places to look and one place
 *      to act.
 *
 * So the screen holds only what the Orders screen cannot answer: SHAPE OVER
 * TIME, and METAL COMMITTED.
 *
 * ===========================================================================
 * WHY BARS, AND WHY GRAMS
 * ===========================================================================
 * Orders a day are counts on discrete days. A line drawn through them passes
 * straight over the days with nothing, and how many days had nothing is the
 * one thing a shopkeeper reads off this chart. Bars show those as gaps.
 *
 * Gold committed is in GRAMS because a jeweller's stock is metal. Rupees move
 * with the rate twice a business day; grams do not. "38.400 g of 916 went out
 * this month" tells the owner what to buy, and the same figure in rupees does
 * not, because the same rupee figure means different amounts of gold in
 * different weeks. It comes straight from `order_items.net_metal_weight_mg`
 * grouped by `fineness_snapshot` — exact, because the snapshot is statutory.
 *
 * ===========================================================================
 * THE PALETTE, VALIDATED, AND WHY THERE IS NO CATEGORICAL ONE
 * ===========================================================================
 * Every chart here is SINGLE-SERIES. There is no categorical palette in this
 * admin at all, which is fortunate, because the brand's jewel notes fail as
 * one: `validate_palette.js` puts emerald against sindoor at ΔE 4.0 under
 * protanopia, so a colourblind owner could not tell "good" from "late". That
 * settles the status question too — there is no green in this admin.
 *
 * The two colours that do exist were validated as a pair in both modes and
 * both pass every check: data `#2f5591` light / `#5b86c9` dark, alert
 * `#8c2f23` / `#d0674f`. Gold, gold-leaf and brass appear on no chart in
 * either mode — 1.90:1 on plaster.
 *
 * The rows in the metal chart are identified by their LABELS. Six categorical
 * colours against six labelled rows would be decoration pretending to be
 * encoding.
 *
 * ===========================================================================
 * NO SCRIPT, AND THEREFORE NO TOOLTIP
 * ===========================================================================
 * Both charts are inline SVG rendered on the server. There is no charting
 * library and there is no hover layer, because there is no hover on a phone
 * and this panel is designed to work with JavaScript switched off. What a
 * tooltip would have carried is carried instead by a real `<table>` under a
 * `<details>` — which is also the screen-reader path, the print path and the
 * forced-colours path. The 30-bar chart's table is OPEN by default: at 390px
 * those bars are 9.9px wide, which is a shape and not a figure.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";

import { formatWhen, readClock, resolveAdmin } from "../../_admin/data";
import {
  COLUMN_CHART,
  NUMBER_WINDOWS,
  RECORDED_NOT_RECEIVED,
  columnPath,
  formatMilligrams,
  layOutColumns,
  layOutRows,
  readMetalCommitted,
  rowPath,
  shortDate,
  toNumberWindow,
  type CommittedResult,
  type OrdersOverTime,
  readOrdersOverTime,
} from "../../_admin/rate-data";
import { getAdminDb } from "../../_admin/session";
import { formatPaiseAsRupees } from "../../_pricing/rates";
import { site } from "../../site-config";
import "./numbers.css";

/** Keyed on one admin's cookie. There is nothing here that may be cached. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Numbers | ${site.name}`,
  robots: { index: false, follow: false, nocache: true },
};

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/* =========================================================================
 * The one component allowed to print a rupee figure on this screen
 * ====================================================================== */

/**
 * MONEY AND THE TRUTH ABOUT MONEY TRAVEL TOGETHER.
 *
 * There is no way to render a total on this screen without also rendering
 * `RECORDED_NOT_RECEIVED`, because they are the same component. That is a
 * structural guarantee rather than a careful one: a future edit that adds a
 * figure somewhere else has to import this, and this cannot be told to leave
 * the sentence out.
 */
function Recorded({
  orders,
  totalPaise,
  window,
}: {
  orders: number;
  totalPaise: number;
  window: string;
}) {
  return (
    <>
      <p className="num__lede">
        In the {window.toLowerCase()} the shop recorded{" "}
        {orders === 1 ? "1 order" : `${orders} orders`}
        {orders === 0 ? "." : (
          <>
            {" "}
            worth <span className="num__amount">₹{formatPaiseAsRupees(totalPaise)}</span>.
          </>
        )}
      </p>
      <p className="num__disclaimer">{RECORDED_NOT_RECEIVED}</p>
    </>
  );
}

/* =========================================================================
 * (b) Orders a day — single-series columns
 * ====================================================================== */

function OrdersADay({ data, windowLabel }: { data: OrdersOverTime; windowLabel: string }) {
  const chart = layOutColumns(data.days);
  const firstDay = data.days[0];
  const lastDay = data.days[data.days.length - 1];
  const maxBar = chart.bars.find((bar) => bar.isMax) ?? null;

  return (
    <section className="num__chart" aria-labelledby="chart-orders">
      <h2 className="num__chart-head" id="chart-orders">
        Orders a day
      </h2>
      <p className="num__chart-sub">{windowLabel}</p>

      <svg
        className="num__svg"
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        role="img"
        /* NOT a <title> element. React 19 hoists <title> to the document head
           wherever it appears — including inside an <svg> — which leaves the
           chart with an empty accessible name and puts its text in the browser
           tab. `aria-label` is the name; <desc> is the detail, and it renders
           where it was written. */
        aria-label={`Orders a day, ${windowLabel.toLowerCase()}`}
        aria-describedby="chart-orders-desc"
      >
        <desc id="chart-orders-desc">
          {`One bar for each day. The busiest day had ${chart.max} ${
            chart.max === 1 ? "order" : "orders"
          }; ${data.days.length - data.daysWithAnOrder} of the ${data.days.length} days had none. Every day's figure is in the table below.`}
        </desc>

        {/* ONE gridline, at the maximum, a solid hairline. A full grid behind
            thirty 9px bars is more ink than data. */}
        <line
          className="num__grid"
          x1="0"
          x2={chart.width}
          y1={chart.gridY}
          y2={chart.gridY}
        />
        <line
          className="num__grid"
          x1="0"
          x2={chart.width}
          y1={chart.baselineY}
          y2={chart.baselineY}
        />

        {chart.bars.map((bar) => (
          <path className="num__bar" key={bar.dayKey} d={columnPath(bar)} />
        ))}

        {/* THE MAXIMUM IS DIRECT-LABELLED, AND NOTHING ELSE IS. A number on
            every bar is chaos and goes unread. The label wears a text token,
            never the bar's colour. */}
        {maxBar === null ? null : (
          <text
            className="num__value"
            x={Math.min(chart.width - 6, Math.max(6, maxBar.x + maxBar.width / 2))}
            y={COLUMN_CHART.topBand - 5}
            textAnchor="middle"
          >
            {maxBar.value}
          </text>
        )}

        {firstDay === undefined ? null : (
          <text className="num__axis" x="0" y={chart.height - 5} textAnchor="start">
            {shortDate(firstDay.dayKey)}
          </text>
        )}
        {lastDay === undefined ? null : (
          <text
            className="num__axis"
            x={chart.width}
            y={chart.height - 5}
            textAnchor="end"
          >
            {shortDate(lastDay.dayKey)}
          </text>
        )}
      </svg>

      {/* The table is the values. It is open by default because at 390px the
          bars are under 10px wide — a shape, not a figure. */}
      <details className="num__figures" open>
        <summary>See the figures</summary>
        <div className="num__scroll">
          <table className="num__table">
            <caption>
              Orders recorded each day, {windowLabel.toLowerCase()}. Days with no orders are
              listed with a zero.
            </caption>
            <thead>
              <tr>
                <th scope="col">Day</th>
                <th scope="col">Orders</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((day) => (
                <tr key={day.dayKey}>
                  <th scope="row">{shortDate(day.dayKey)}</th>
                  <td className="num__cell">{day.orders}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

/* =========================================================================
 * (c) Gold committed, by purity, in grams
 * ====================================================================== */

function MetalCommittedChart({
  data,
  windowLabel,
}: {
  data: CommittedResult;
  windowLabel: string;
}) {
  const chart = layOutRows(data.rows);

  return (
    <section className="num__chart" aria-labelledby="chart-metal">
      <h2 className="num__chart-head" id="chart-metal">
        Gold committed
      </h2>
      <p className="num__chart-sub">{windowLabel}, by purity</p>

      <svg
        className="num__svg"
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        role="img"
        aria-label={`Metal committed by purity, ${windowLabel.toLowerCase()}`}
        aria-describedby="chart-metal-desc"
      >
        <desc id="chart-metal-desc">
          {`One bar for each purity, in grams. ${formatMilligrams(
            data.totalMilligrams
          )} grams in all. Every figure is in the table below.`}
        </desc>

        {chart.bars.map((bar) => (
          <g key={bar.label}>
            <text className="num__row-label" x="0" y={bar.labelY} dominantBaseline="middle">
              {bar.label}
            </text>
            <path className="num__bar" d={rowPath(bar)} />
            {/* Direct-labelled at the end of the bar, in a text colour. The
                right gutter is reserved before the bars are scaled, so the
                longest bar cannot push its own figure off the canvas. */}
            <text
              className="num__value"
              x={bar.x + bar.width + 6}
              y={bar.labelY}
              dominantBaseline="middle"
            >
              {formatMilligrams(bar.milligrams)} g
            </text>
          </g>
        ))}
      </svg>

      <p className="num__total">
        <span className="num__amount">{formatMilligrams(data.totalMilligrams)} g</span> in all.
        {data.goldOnly ? " No silver and no platinum." : null}
      </p>

      <details className="num__figures">
        <summary>See the figures</summary>
        <div className="num__scroll">
          <table className="num__table">
            <caption>
              Net metal weight committed by purity, {windowLabel.toLowerCase()}, in grams.
            </caption>
            <thead>
              <tr>
                <th scope="col">Purity</th>
                <th scope="col">Grams</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td className="num__cell">{formatMilligrams(row.milligrams)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}

/* =========================================================================
 * The page
 * ====================================================================== */

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="num">
      <p>
        <a className="num__back" href="/admin">
          &larr; Today
        </a>
      </p>
      <h1 className="num__title">Numbers</h1>
      {children}
    </div>
  );
}

export default async function AdminNumbersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nowMs = readClock();
  const inbound = await headers();

  // The layout has already refused an anonymous request, and this asks again.
  const current = await resolveAdmin({
    cookie: inbound.get("cookie"),
    ip: inbound.get("cf-connecting-ip"),
    userAgent: inbound.get("user-agent"),
  });

  if (current === null) {
    return (
      <Shell>
        <p className="num__lede">
          This session has ended, so nothing is shown. Signing in again brings the figures back.
        </p>
      </Shell>
    );
  }

  const params = await searchParams;
  const key = toNumberWindow(first(params.days));
  const chosen = NUMBER_WINDOWS[key];

  let orders: OrdersOverTime;
  let committed: CommittedResult;
  try {
    const db = getAdminDb();
    [orders, committed] = await Promise.all([
      readOrdersOverTime(db, { days: chosen.days, nowMs }),
      readMetalCommitted(db, { days: chosen.days, nowMs }),
    ]);
  } catch (error) {
    // NEVER a half-drawn chart. The orders themselves are fine and they are on
    // a screen that can be acted on, so the failure says so and points there.
    console.error("[admin-numbers] the figures could not be worked out:", error);
    return (
      <Shell>
        <p className="num__notice num__notice--problem">
          Could not work out the figures just now. Nothing is wrong with the orders themselves
         , they are all on the <a className="num__link" href="/admin/orders">Orders screen</a>.
        </p>
      </Shell>
    );
  }

  /* `Object.keys` on a numeric-keyed record hands back STRINGS, and `"90" ===
     90` is false — which would silently mark no window as current. The list is
     therefore written out, which is also the order it reads in. */
  const windows: (keyof typeof NUMBER_WINDOWS)[] = [30, 90, 365];

  return (
    <div className="num">
      <p>
        <a className="num__back" href="/admin">
          &larr; Today
        </a>
      </p>

      <h1 className="num__title">Numbers</h1>

      <Recorded
        orders={orders.totalOrders}
        totalPaise={orders.recordedTotalPaise}
        window={chosen.label}
      />

      {orders.tornOrders === 0 ? null : (
        <p className="num__wrong">
          <span className="num__mark" aria-hidden="true" />
          {orders.tornOrders === 1
            ? "One order did not save fully, so it is counted but not totalled and its metal is left out of the second chart."
            : `${orders.tornOrders} orders did not save fully, so they are counted but not totalled and their metal is left out of the second chart.`}
        </p>
      )}

      {/* ONE filter row, above everything it scopes. Both charts redraw against
          the same slice; there is no per-chart control. */}
      <p className="num__windows">
        {windows.map((option, index) => (
          <span key={option}>
            {index === 0 ? null : <span className="num__sep"> · </span>}
            <a
              className="num__window"
              href={`/admin/numbers?days=${option}`}
              aria-current={option === key ? "true" : undefined}
            >
              {NUMBER_WINDOWS[option].label}
            </a>
          </span>
        ))}
      </p>

      {orders.daysWithAnOrder < 2 ? (
        /* NOT an empty axis. An axis with no bars claims there is data and it
           happens to be zero, which is a different statement from "nothing has
           happened" — and the second one is the true one. */
        <section className="num__chart">
          <h2 className="num__chart-head">Not enough has happened yet to draw anything</h2>
          <p className="num__lede">
            Charts start once there are orders on more than one day. There{" "}
            {orders.totalOrders === 1 ? "has been 1 so far" : `have been ${orders.totalOrders} so far`}
            .
          </p>
          <p className="num__lede">
            The last order recorded, if there is one, is on the{" "}
            <a className="num__link" href="/admin/orders">
              Orders screen
            </a>
            . It is where anything can actually be done about a number.
          </p>
        </section>
      ) : (
        <>
          <OrdersADay data={orders} windowLabel={chosen.label} />
          {committed.rows.length === 0 ? (
            <section className="num__chart">
              <h2 className="num__chart-head">Gold committed</h2>
              <p className="num__lede">
                No piece with a weight and a purity has been ordered in this period, so there is
                no metal to count. A piece priced at a fixed figure carries no metal weight.
              </p>
            </section>
          ) : (
            <MetalCommittedChart data={committed} windowLabel={chosen.label} />
          )}
        </>
      )}

      <p className="num__note">
        Read {formatWhen(new Date(nowMs).toISOString(), nowMs)}. Nothing on this screen changes
        what to do next, that is the{" "}
        <a className="num__link" href="/admin">
          Today
        </a>{" "}
        screen&rsquo;s job.
      </p>
    </div>
  );
}
