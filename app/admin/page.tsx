/**
 * TODAY — the landing screen, and the answer to "what does a shop owner see
 * first at 11pm?"
 *
 * ===========================================================================
 * WHAT EARNS THE TOP OF THE SCREEN
 * ===========================================================================
 * Not today's takings: `PAYMENT_CAPTURE_ENABLED` is false and stays false until
 * the shop holds a BIS certificate, so there is no figure this screen could
 * print that any bank account contains. A revenue tile would be the single most
 * damaging thing in the panel, because the first time the owner compares it to
 * reality they stop believing everything else.
 *
 * Not a count of new orders either. A count is not an action, and for the
 * foreseeable future it is zero, twice a day, forever — which is how you teach
 * someone to stop opening an app.
 *
 * The rule instead: THE TOP OF THE SCREEN IS WHATEVER WILL BE WRONG TOMORROW IF
 * IT IS NOT SEEN TONIGHT. That is exactly two things — a reply clock about to
 * breach, and a stale gold rate — and everything else sorts below them. The
 * corollary shapes the whole page: NOTHING HAS FIXED PROMINENCE. The gold rate
 * is one quiet line until it goes stale, at which point the website cannot
 * price anything and it becomes the largest block here.
 *
 * ===========================================================================
 * THE EMPTY STATE IS THE MOST IMPORTANT SCREEN IN THE PANEL
 * ===========================================================================
 * research/05-admin-ux.md §13. The shop has no contact details, nothing weighed
 * or assayed, no rate and no payment capture — and none of those resolves on its
 * own. The honest prediction is that the owner signs in, sees nothing, signs in
 * again the next evening, sees nothing, and never opens it again; by the time a
 * real order arrives nobody is watching and its clock starts anyway.
 *
 * So "nothing is waiting" is followed by a to-do list for opening the shop: the
 * four real unfinished things, each checked in code by `readSetupGaps()`, each
 * disappearing as it is resolved. It invents no founder, no phone number and no
 * encouraging metric, which is the same placeholder-honesty rule every other
 * surface on this site already follows.
 *
 * ===========================================================================
 * THE QUEUE IS PEOPLE, NOT RECORDS
 * ===========================================================================
 * Orders, enquiries and open tickets are merged and rendered visually
 * undifferentiated, because the owner does not care which table a person came
 * from. What each row carries is a name, a deadline when there is one, what it
 * is about, and two phone buttons. Following up happens by phone; that is the
 * highest-frequency action in the whole tool, so it is on the row rather than
 * behind a tap-through.
 *
 * AN ORDINARY ORDER HAS NO DEADLINE AND IS NEVER CALLED A COMPLAINT. Phase 0
 * removed the grievance ticket that every order used to open; printing a
 * deadline against an order here would put the defect back into the interface,
 * where it would look correct.
 *
 * ===========================================================================
 * NO JAVASCRIPT
 * ===========================================================================
 * There is none on this page and nothing here needs any. Every control is a
 * link or a form, as the storefront's cart and filters already are.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";

import {
  QUEUE_LIMIT,
  TORN_ORDER_SUMMARY,
  formatIstClock,
  formatWhen,
  readClock,
  readRateStanding,
  readSetupGaps,
  readTodayQueue,
  readTodayTally,
  resolveAdmin,
  type TodayTally,
} from "../_admin/data";
import { ADMIN_LOGIN_PATH, getAdminDb } from "../_admin/session";
import type { QueueItem, SetupGap } from "../_admin/view-types";
import { formatPricePaise } from "../_data/catalogue";
import { PAYMENT_CAPTURE_ENABLED } from "../_data/orders";
import { formatPaiseAsRupees, type RateLookup } from "../_pricing/rates";
import { site } from "../site-config";

/** Keyed on one admin's session. Nothing on it may be cached or prerendered. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Today | ${site.name}`,
  description: "The shop panel.",
  robots: { index: false, follow: false, nocache: true },
};

/** Under this much time left, a deadline stops being information and becomes a
 *  warning. It is the same threshold the design uses for the red square. */
const URGENT_MS = 12 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------
 * Phone links
 * ---------------------------------------------------------------------- */

/** `wa.me` wants bare digits; the column holds `+91…`. */
function whatsappHref(phone: string, message: string): string {
  return `https://wa.me/${phone.replace(/\D+/g, "")}?text=${encodeURIComponent(message)}`;
}

function openingMessage(item: QueueItem): string {
  const who = item.name ? `${item.name}, ` : "";
  switch (item.kind) {
    case "order":
      return `Hello ${who}this is ${site.name} about your order ${item.reference}.`;
    case "complaint":
      return `Hello ${who}this is ${site.name} about ${item.reference}.`;
    default:
      return `Hello ${who}this is ${site.name}.`;
  }
}

/* -------------------------------------------------------------------------
 * The rows
 * ---------------------------------------------------------------------- */

function QueueRow({ item, nowMs }: { item: QueueItem; nowMs: number }) {
  const torn = item.summary === TORN_ORDER_SUMMARY;
  const dueMs = item.dueAt === null ? null : Date.parse(item.dueAt);
  const urgent =
    item.overdue || (dueMs !== null && Number.isFinite(dueMs) && dueMs - nowMs < URGENT_MS);

  return (
    <li className="admin-queue__item">
      <p className="admin-queue__name">{item.name ?? "Somebody who left no name"}</p>

      {/* A DEADLINE PRINTS ONLY WHERE ONE EXISTS. `dueAt` is set for a
          complaint and for nothing else, so an order can never grow a clock
          here by accident. */}
      {item.dueAt !== null ? (
        <p className={`admin-queue__due${urgent ? " admin-wrong" : ""}`}>
          {urgent ? <span className="admin-mark" aria-hidden="true" /> : null}
          <span>
            {item.overdue ? "Reply overdue — it was due " : "Reply by "}
            <time dateTime={item.dueAt}>{formatWhen(item.dueAt, nowMs)}</time>
          </span>
        </p>
      ) : null}

      <p className={`admin-queue__summary${torn ? " admin-wrong" : ""}`}>
        {torn ? <span className="admin-mark" aria-hidden="true" /> : null}
        {item.summary}
      </p>

      <p className="admin-queue__meta">
        <time dateTime={item.receivedAt}>{formatWhen(item.receivedAt, nowMs)}</time>
        {item.reference ? ` · ${item.reference}` : ""}
      </p>

      {item.phone ? (
        <p className="admin-actions">
          <a className="admin-btn" href={`tel:${item.phone}`}>
            Call
          </a>
          <a className="admin-btn" href={whatsappHref(item.phone, openingMessage(item))}>
            WhatsApp
          </a>
          {/* A desktop `tel:` usually does nothing useful, so the number is
              also here as text that can be copied. */}
          <span className="admin-num admin-nophone">{item.phone}</span>
        </p>
      ) : (
        <p className="admin-nophone">No phone number was left for this one.</p>
      )}
    </li>
  );
}

function GapRow({ gap }: { gap: SetupGap }) {
  return (
    <li className="admin-gap">
      {/* No red square here. Sindoor means "this is late or wrong NOW"; an
          unfinished setup step is neither, and four red squares would spend the
          one signal the eye is scanning for. */}
      <p className="admin-gap__title">{gap.title}</p>
      <p className="admin-gap__detail">{gap.detail}</p>
      {gap.href ? (
        <p className="admin-actions">
          <a className="admin-btn admin-btn--primary" href={gap.href}>
            Put this right
          </a>
        </p>
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------------------
 * The rate, in its two sizes
 * ---------------------------------------------------------------------- */

function RateLine({ lookup, nowMs }: { lookup: RateLookup; nowMs: number }) {
  if (lookup.ok) {
    return (
      <p className="admin-rate">
        <span className="admin-rate__figure">
          {lookup.rate.fineness} gold · ₹{formatPaiseAsRupees(lookup.rate.ratePerTenGramsPaise)}{" "}
          per 10 g
        </span>
        <span className="admin-rate__note">
          {lookup.rate.source.toUpperCase()}, in force since{" "}
          <time dateTime={lookup.rate.effectiveFrom}>
            {formatWhen(lookup.rate.effectiveFrom, nowMs)}
          </time>
        </span>
      </p>
    );
  }

  /*
   * THE PROMINENCE RULE IN ACTION. A stale rate is not a badge — while it is out
   * of date the storefront cannot price anything and the shop is silently shut,
   * so it takes the top of the screen. The copy names the CONSEQUENCE TO THE
   * BUSINESS before it names the technical fact: "the website cannot price
   * anything" is what a person needs; "rate_stale" is what a log needs.
   *
   * A row that cannot be read at all gets its own heading, because "out of
   * date" would be a guess about what is wrong with it.
   */
  const stale = lookup.reason === "rate_stale";
  const since =
    stale && lookup.unusableRate
      ? formatWhen(lookup.unusableRate.effectiveFrom, nowMs)
      : null;

  return (
    <section className="admin-alarm" aria-labelledby="rate-alarm">
      <h2 className="admin-alarm__head" id="rate-alarm">
        <span className="admin-mark" aria-hidden="true" />
        <span>
          {stale ? "The gold rate is out of date" : "The gold rate cannot be read"}
        </span>
      </h2>
      {since ? <p className="admin-p">The last good rate is from {since}.</p> : null}
      <p className="admin-p">
        {stale ? "While it is out of date" : "Until it is put right"} the website cannot
        price anything. Every piece shows &ldquo;price on request&rdquo; and nobody can
        check out. That is deliberate — a wrong price is worse than no price.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------
 * The one sentence about today
 * ---------------------------------------------------------------------- */

function TodaySentence({ tally }: { tally: TodayTally }) {
  const orders =
    tally.orders === 1 ? "1 order was recorded" : `${tally.orders} orders were recorded`;
  const worth = tally.ordersTotalPaise > 0 ? `, ${formatPricePaise(tally.ordersTotalPaise)} worth` : "";

  return (
    <section className="admin-section" aria-labelledby="today-head">
      <h2 className="admin-section__head" id="today-head">
        Today
      </h2>
      {tally.orders > 0 ? (
        <p className="admin-p">
          {orders}
          {worth}.{" "}
          {/* The truth about money travels in the same breath as the figure, so
              the two can never be separated. */}
          {PAYMENT_CAPTURE_ENABLED
            ? null
            : "No money has been taken — card and UPI are not switched on yet."}
        </p>
      ) : null}
      {tally.tornOrders > 0 ? (
        <p className="admin-p admin-wrong">
          <span className="admin-mark" aria-hidden="true" />
          {tally.tornOrders === 1
            ? "1 order did not save fully, so it is not counted in that figure."
            : `${tally.tornOrders} orders did not save fully, so they are not counted in that figure.`}
        </p>
      ) : null}
      {tally.enquiries > 0 ? (
        <p className="admin-p">
          {tally.enquiries === 1 ? "1 enquiry came in." : `${tally.enquiries} enquiries came in.`}
        </p>
      ) : null}
    </section>
  );
}

/* -------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------- */

export default async function AdminTodayPage() {
  const inbound = await headers();
  const current = await resolveAdmin({
    cookie: inbound.get("cookie"),
    ip: inbound.get("cf-connecting-ip"),
    userAgent: inbound.get("user-agent"),
  });

  // The layout has already refused an anonymous request. This is the second
  // gate, and it is what makes the page safe on its own terms — see
  // app/_admin/session.ts §5 on why one gate is never enough.
  if (!current) redirect(`${ADMIN_LOGIN_PATH}?notice=refused`);

  const nowMs = readClock();

  let queue: QueueItem[] = [];
  let gaps: SetupGap[] = [];
  let tally: TodayTally = { orders: 0, ordersTotalPaise: 0, tornOrders: 0, enquiries: 0 };
  let rate: RateLookup | null = null;
  let failed = false;

  try {
    const db = getAdminDb();
    [queue, gaps, tally, rate] = await Promise.all([
      readTodayQueue(db, { actor: current.actor, nowMs, limit: QUEUE_LIMIT }),
      readSetupGaps(db),
      readTodayTally(db, { nowMs }),
      readRateStanding(db, { nowMs }).then((standing) => standing.lookup),
    ]);
  } catch (error) {
    // A panel that cannot read the database says so. It never renders an empty
    // screen, because an empty screen is indistinguishable from a quiet shop.
    console.error("[admin-today] could not read the shop's records:", error);
    failed = true;
  }

  const unresolved = gaps.filter((gap) => !gap.resolved);

  return (
    <>
      <h1 className="admin-title">Today</h1>

      {failed ? (
        <section className="admin-alarm" aria-labelledby="read-failed">
          <h2 className="admin-alarm__head" id="read-failed">
            <span className="admin-mark" aria-hidden="true" />
            <span>Could not read the shop&rsquo;s records just now</span>
          </h2>
          <p className="admin-p">
            Nothing is lost and nothing has been changed. Try again in a moment.
          </p>
          <p className="admin-actions">
            <a className="admin-btn admin-btn--primary" href="/admin">
              Try again
            </a>
          </p>
        </section>
      ) : null}

      {/* One quiet line, or the whole top of the screen. Nothing is rendered at
          all when no rate has ever been recorded, because that is a setup gap
          below and saying it twice is noise. */}
      {rate ? <RateLine lookup={rate} nowMs={nowMs} /> : null}

      <section className="admin-section" aria-labelledby="needs-you">
        <h2 className="admin-section__head" id="needs-you">
          Needs you
        </h2>

        {queue.length === 0 ? (
          <p className="admin-p">Nothing is waiting.</p>
        ) : (
          <ol className="admin-queue">
            {queue.map((item) => (
              <QueueRow key={`${item.kind}:${item.id}`} item={item} nowMs={nowMs} />
            ))}
          </ol>
        )}
      </section>

      {unresolved.length > 0 ? (
        <section className="admin-section" aria-labelledby="before-open">
          <h2 className="admin-section__head" id="before-open">
            Before the shop can take orders
          </h2>
          <ul className="admin-gaps">
            {unresolved.map((gap) => (
              <GapRow key={gap.id} gap={gap} />
            ))}
          </ul>
        </section>
      ) : null}

      {tally.orders > 0 || tally.enquiries > 0 ? <TodaySentence tally={tally} /> : null}

      {/* So a render can never masquerade as more recent than it is. */}
      <p className="admin-note">Read at {formatIstClock(nowMs)}.</p>
    </>
  );
}
