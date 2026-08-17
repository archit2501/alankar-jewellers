/**
 * THE GOLD RATE — /admin/rate.
 *
 * ===========================================================================
 * THE SCREEN HAS NO EDIT CONTROL, AND THAT IS THE DESIGN
 * ===========================================================================
 * `gold_rates` is append-only. An invoice reprinted in 2031 reconstructs to
 * the paise from the exact row it was priced from, so a rate value is never
 * overwritten — the wrong row is closed and the right figure appended after
 * it. Every screen that offers an "Edit" here would be offering to reprice the
 * past.
 *
 * So the control is "This one is wrong", and the rule is explained in one line
 * of shop English rather than in a tooltip: the old figure stays in the
 * history with the correction beside it, because the orders that were priced
 * from it still have to add up. That sentence is the difference between a rule
 * the owner works around and a rule the owner understands.
 *
 * ===========================================================================
 * THE ORDER OF THE PAGE, AND WHY
 * ===========================================================================
 *  0. THE ALARM, but only when there is one. Nothing has fixed prominence: the
 *     rate is one quiet panel while it is good and the top of the screen the
 *     moment it is not, because a stale rate means the storefront cannot
 *     price anything and the shop is silently shut.
 *  1. The rate in force, as the biggest number in the whole panel — it is the
 *     one figure the shop hangs off.
 *  2. Its provenance and its shelf life. "Good until 2:35 pm" is computed from
 *     `rateExpiryMs()`, so the owner sees staleness coming rather than
 *     discovering it.
 *  3. The other purities, quietly.
 *  4. The way in by hand.
 *  5. When the automatic check last ran and when it is next due — phrased as
 *     an event, because "last ran at 11:25, next due 2:25" is actionable and
 *     "ingest: healthy" is not. THIS is what makes staleness visible before it
 *     is a problem.
 *  6. The trail, with each correction folded into the row it corrects.
 *
 * ===========================================================================
 * THE FOUR VIEWS THIS ONE FILE SERVES
 * ===========================================================================
 * `?enter=1` the manual entry form · `?wrong=<id>` the correction, with the
 * orders already billed from that rate named on it · `?billed=<id>` those
 * orders on their own · and the board. Each is a PAGE and not a dialog: a
 * modal on a 390px screen is a full-screen sheet with worse scrolling, no
 * back-button semantics and a JavaScript dependency, and a page has all three
 * for free.
 *
 * ===========================================================================
 * WHAT IS AUDITED, AND BY WHOM
 * ===========================================================================
 * Only one view here touches a person: the orders billed from a rate row.
 * `readOrdersBilledFromRate()` writes that DPDP Rule 6(1)(c) row itself, so
 * this page writes none — a second would report one read as two. The rate
 * views touch nobody and log nothing.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";

import { PAYMENT_CAPTURE_ENABLED } from "../../_data/orders";
import {
  formatWhen,
  readClock,
  readRateStanding,
  resolveAdmin,
  type CurrentAdmin,
} from "../../_admin/data";
import {
  BILLED_LIMIT,
  CORRECTION_REASONS,
  HEADLINE_FINENESS,
  RATE_SLOTS,
  UNIT_WORDS,
  findRateSlot,
  rateStandingWord,
  readIngestHealth,
  readOrdersBilledFromRate,
  readRateBefore,
  readRateBoard,
  readRateById,
  readRateHistory,
  type BilledOrder,
  type IngestHealth,
  type RateBoardRow,
  type RateHistoryRow,
} from "../../_admin/rate-data";
import { getAdminDb } from "../../_admin/session";
import { formatPaiseAsRupees } from "../../_pricing/rates";
import { site } from "../../site-config";
import { waNumber } from "../orders/orders-data";
import "./rate.css";

/** Keyed on one admin's cookie. There is nothing here that may be cached. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Gold rate | ${site.name}`,
  robots: { index: false, follow: false, nocache: true },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/* =========================================================================
 * The notices the endpoint sends back — matched exactly, never reflected
 * ====================================================================== */

const NOTICES: Readonly<Record<string, { copy: string; problem: boolean }>> = {
  entered: {
    copy: "The rate is in. Every piece on the website is priced from it from this moment.",
    problem: false,
  },
  corrected: {
    copy: "The rate is corrected. The old figure is still in the history below, with this correction beside it.",
    problem: false,
  },
  refused: {
    copy: "That request could not be verified, so nothing was changed. Try again from this screen.",
    problem: true,
  },
  "needs-figure": {
    copy: "That was not a rupee figure, so nothing was changed. Type the digits as they are printed.",
    problem: true,
  },
  "per-gram": {
    copy: "That figure looks like a price per gram, and this box takes the price per 10 grams. Nothing was changed.",
    problem: true,
  },
  "ten-times": {
    copy: "That figure is about ten times the rate in force, which is not a move gold makes. Nothing was changed.",
    problem: true,
  },
  "big-move": {
    copy: "That is a change of more than a quarter in one step. Nothing was changed. Go in again and tick the box to confirm the figure.",
    problem: true,
  },
  "needs-reason": {
    copy: "Say why the rate was wrong. Nothing was changed.",
    problem: true,
  },
  "not-allowed": {
    copy: "That is not something this screen can do to a rate. Nothing was changed.",
    problem: true,
  },
  conflict: {
    copy: "Someone else changed this rate while you were typing, so nothing was written. What it says now is below.",
    problem: true,
  },
  unavailable: {
    copy: "Nothing was changed. Try again, and if it happens twice tell whoever runs the site.",
    problem: true,
  },
};

/* =========================================================================
 * Small pieces
 * ====================================================================== */

function Shell({
  title,
  back = { href: "/admin", label: "Today" },
  children,
}: {
  title: string;
  back?: { href: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <div className="rate">
      <p>
        <a className="rate__back" href={back.href}>
          &larr; {back.label}
        </a>
      </p>
      <h1 className="rate__title">{title}</h1>
      {children}
    </div>
  );
}

function Notice({ code }: { code: string }) {
  const notice = NOTICES[code];
  if (notice === undefined) return null;
  return (
    <p className={`rate__notice${notice.problem ? " rate__notice--problem" : ""}`} role="status">
      {notice.problem ? <span className="rate__mark" aria-hidden="true" /> : null}
      {notice.copy}
    </p>
  );
}

/** The unit words for one row, so a silver figure never reads as per 10 g. */
function unitOf(metal: string, fineness: number): "per_ten_grams" | "per_kilogram" {
  return findRateSlot(metal, fineness)?.unit ?? "per_ten_grams";
}

/**
 * How a figure is printed. Silver is STORED per ten grams — the ingest
 * converts it, per `db/schema.ts` — so the screen prints both: the figure the
 * source published and the figure the pricing engine reads. Asking the owner
 * to hold two units in their head without printing both is how the conversion
 * gets doubted.
 */
function RateFigure({
  row,
  size = "normal",
}: {
  row: { ratePerTenGramsPaise: number; metal: string; fineness: number };
  size?: "normal" | "lead";
}) {
  const perKilo = unitOf(row.metal, row.fineness) === "per_kilogram";
  return (
    <span className={size === "lead" ? "rate__lead" : "rate__figure"}>
      ₹{formatPaiseAsRupees(row.ratePerTenGramsPaise)}
      <span className="rate__unit"> per 10 g</span>
      {perKilo ? (
        <span className="rate__unit">
          {" "}
          (₹{formatPaiseAsRupees(row.ratePerTenGramsPaise * 100)} per kg)
        </span>
      ) : null}
    </span>
  );
}

/* =========================================================================
 * The alarm — only ever rendered when there is something wrong
 * ====================================================================== */

function Alarm({
  standing,
  unusable,
  health,
  nowMs,
}: {
  standing: "none" | "stale" | "broken";
  unusable: { ratePerTenGramsPaise: number; metal: string; fineness: number; effectiveFrom: string } | null;
  health: IngestHealth;
  nowMs: number;
}) {
  return (
    <section className="rate__alarm" aria-labelledby="rate-alarm">
      <h2 className="rate__alarm-head" id="rate-alarm">
        <span className="rate__mark" aria-hidden="true" />
        {standing === "none"
          ? "No gold rate has been recorded"
          : standing === "stale"
            ? "The gold rate is out of date"
            : "The gold rate cannot be read"}
      </h2>

      {standing === "stale" && unusable !== null ? (
        <p className="rate__alarm-p">
          The last good {unusable.fineness} rate is from{" "}
          <time dateTime={unusable.effectiveFrom}>
            {formatWhen(unusable.effectiveFrom, nowMs)}
          </time>
          .
        </p>
      ) : null}

      <p className="rate__alarm-p">
        {standing === "none"
          ? "Nothing on the website can show a price until one is recorded. Every piece is showing “price on request”, which is the truth rather than a placeholder, and nobody can check out."
          : standing === "stale"
            ? "While it is out of date the website cannot price anything. Every piece shows “price on request” and nobody can check out. That is deliberate. a wrong price is worse than no price."
            : "The row that should hold the rate cannot be read, so the website is refusing to quote rather than guessing. That is deliberate. a wrong price is worse than no price."}
      </p>

      {health.missedPublications > 0 ? (
        <p className="rate__alarm-p">
          The automatic check has missed{" "}
          {health.missedPublications === 1
            ? "one publication"
            : `${health.missedPublications} publications`}{" "}
          since{" "}
          {health.lastRunAt === null ? (
            "it last ran"
          ) : (
            <time dateTime={health.lastRunAt}>{formatWhen(health.lastRunAt, nowMs)}</time>
          )}
          .
        </p>
      ) : null}

      <p className="rate__acts">
        <a className="rate__btn rate__btn--primary" href="/admin/rate?enter=1">
          {standing === "none" ? "Enter the first rate" : "Enter today’s rate by hand"}
        </a>
      </p>
    </section>
  );
}

/* =========================================================================
 * The orders billed from one rate — the part most tools skip
 * ====================================================================== */

function BilledOrders({
  orders,
  nowMs,
  heading,
}: {
  orders: readonly BilledOrder[];
  nowMs: number;
  heading: string;
}) {
  if (orders.length === 0) {
    return (
      <section className="rate__billed">
        <h2 className="rate__section-head">{heading}</h2>
        <p className="rate__p">
          No order was priced from this rate. Correcting it changes nothing that has already
          been quoted to anybody.
        </p>
      </section>
    );
  }

  return (
    <section className="rate__billed">
      <h2 className="rate__section-head">
        <span className="rate__mark" aria-hidden="true" />
        {heading}
      </h2>

      <p className="rate__p">
        {orders.length === 1
          ? "One order was priced from this figure."
          : `${orders.length} orders were priced from this figure.`}{" "}
        Their bills do not change when the rate is corrected, the price they were quoted
        is the price on their record. Ring them.
        {PAYMENT_CAPTURE_ENABLED ? null : " Nothing has been charged to any of them."}
      </p>

      <ol className="rate__orders">
        {orders.map((order) => (
          <li className="rate__order" key={order.orderNumber}>
            <p className="rate__order-name">
              <a href={`/admin/orders/${order.orderNumber}`}>
                {order.customerName ?? "No name recorded"}
              </a>
            </p>
            <p className="rate__order-meta">
              {order.orderNumber} ·{" "}
              <time dateTime={order.placedAt}>{formatWhen(order.placedAt, nowMs)}</time>
            </p>
            <p className="rate__order-meta">
              {order.intact ? (
                <>Recorded at ₹{formatPaiseAsRupees(order.totalPaise ?? 0)}, not taken.</>
              ) : (
                <>
                  This order did not save fully, so no figure is shown for it. Ring the customer
                  and take the order again.
                </>
              )}
            </p>
            {order.customerPhone === null ? (
              <p className="rate__order-meta">No phone number was recorded.</p>
            ) : (
              <p className="rate__acts">
                <a className="rate__btn" href={`tel:${order.customerPhone}`}>
                  Call
                </a>
                <a
                  className="rate__btn"
                  href={`https://wa.me/${waNumber(order.customerPhone)}?text=${encodeURIComponent(
                    `${site.name}: about your order ${order.orderNumber}`
                  )}`}
                  rel="noreferrer"
                >
                  WhatsApp
                </a>
              </p>
            )}
          </li>
        ))}
      </ol>

      {orders.length >= BILLED_LIMIT ? (
        <p className="rate__p">
          The {BILLED_LIMIT} most recent are listed. There may be more, the Orders screen
          has all of them.
        </p>
      ) : null}
    </section>
  );
}

/* =========================================================================
 * Entering a rate by hand
 * ====================================================================== */

function EnterForm({
  csrf,
  board,
}: {
  csrf: string;
  board: readonly RateBoardRow[];
}) {
  const inForce = new Map(board.map((row) => [`${row.metal}:${row.fineness}`, row]));

  return (
    <Shell title="Enter a rate by hand" back={{ href: "/admin/rate", label: "Gold rate" }}>
      <p className="rate__p">
        IBJA publishes gold per 10 grams and silver per kilogram. Type the figure exactly as it
        is printed on their page. <strong>Do not work out a per-gram price</strong>, the
        box takes the published figure and nothing else.
      </p>

      <form method="post" action="/api/admin/rate">
        <input type="hidden" name="intent" value="enter" />
        {/* Bound to this session and to no other. An origin check alone rests
            on a header the shop does not control. */}
        <input type="hidden" name="csrf" value={csrf} />

        {/* ONE control, not two. A metal picker and a purity picker would let
            the owner ask for silver 585, which nobody publishes; a pill per
            (metal, purity) pair can only express a combination that exists.
            The value is matched against the same closed set on the endpoint,
            so nothing typed into a request reaches a query. Each pill also
            prints what that purity says today, because the commonest reason to
            open this form is that one figure looks wrong. */}
        <fieldset className="rate__pills">
          <legend className="rate__label">Which metal and purity?</legend>
          {RATE_SLOTS.map((slot) => {
            const id = `slot-${slot.metal}-${slot.fineness}`;
            const current = inForce.get(`${slot.metal}:${slot.fineness}`);
            return (
              <label className="rate__pill" htmlFor={id} key={id}>
                <input
                  type="radio"
                  id={id}
                  name="slot"
                  value={`${slot.metal}:${slot.fineness}`}
                  defaultChecked={slot.fineness === HEADLINE_FINENESS && slot.metal === "gold"}
                  required
                />
                <span className="rate__pill-face">
                  <span className="rate__pill-name">{slot.label}</span>
                  <span className="rate__pill-now">
                    {current
                      ? `₹${formatPaiseAsRupees(current.ratePerTenGramsPaise)}`
                      : "none yet"}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>

        <p className="rate__field">
          <label className="rate__label" htmlFor="rate-figure">
            Rate: {UNIT_WORDS.per_ten_grams} for gold, {UNIT_WORDS.per_kilogram} for silver
          </label>
          <input
            className="rate__input rate__input--figure"
            id="rate-figure"
            name="figure"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="done"
            required
          />
        </p>

        <p className="rate__field">
          <label className="rate__label" htmlFor="rate-note">
            Where did you get it from?
          </label>
          <input
            className="rate__input"
            id="rate-note"
            name="note"
            type="text"
            maxLength={160}
            defaultValue=""
            placeholder="IBJA website, 11:25 am"
            autoComplete="off"
          />
        </p>

        <p className="rate__confirm">
          <label htmlFor="rate-confirm">
            <input type="checkbox" id="rate-confirm" name="confirmed" value="yes" />
            <span>
              I have read the figure back. Tick this only if the rate has moved by more than a
              quarter since the last one, without it a jump that large is refused.
            </span>
          </label>
        </p>

        <p className="rate__acts">
          <button className="rate__btn rate__btn--primary" type="submit">
            Use this rate
          </button>
        </p>
      </form>

      <p className="rate__p">
        This closes the rate in use now and starts this one from this moment. Nothing is erased:
        the one it replaces stays in the history, because the orders priced from it still have to
        add up.
      </p>
    </Shell>
  );
}

/* =========================================================================
 * "This one is wrong" — a correction, never an edit
 * ====================================================================== */

function CorrectForm({
  csrf,
  row,
  previous,
  billed,
  nowMs,
}: {
  csrf: string;
  row: RateBoardRow;
  /** The rate this one replaced. What the new figure is measured against. */
  previous: RateBoardRow | null;
  billed: readonly BilledOrder[];
  nowMs: number;
}) {
  const perGram = Math.round(row.ratePerTenGramsPaise / 10);

  return (
    <Shell title="This rate is wrong" back={{ href: "/admin/rate", label: "Gold rate" }}>
      <p className="rate__mono">
        {row.label}, ₹{formatPaiseAsRupees(row.ratePerTenGramsPaise)} per 10 grams, that is
        ₹{formatPaiseAsRupees(perGram)} a gram,{" "}
        {row.source === "manual" ? "entered by hand" : "read from IBJA"}{" "}
        <time dateTime={row.effectiveFrom}>{formatWhen(row.effectiveFrom, nowMs)}</time>.
      </p>

      {row.sourceQuoteRaw === null ? null : (
        <p className="rate__p">
          What was recorded at the time, word for word:{" "}
          <span className="rate__mono">{row.sourceQuoteRaw}</span>
        </p>
      )}

      {/* THE TEN-TIMES GUARD, SHOWN RATHER THAN ONLY ENFORCED. The new figure
          is measured against the rate this one replaced, not against this one
          — because this one is the wrong one. Printing that comparison is what
          lets the owner see the mistake for themselves. */}
      {previous === null ? (
        <p className="rate__p">
          Nothing was recorded for this purity before it, so there is nothing to measure the new
          figure against. Read it off IBJA twice.
        </p>
      ) : (
        <p className="rate__p">
          The rate before it was ₹{formatPaiseAsRupees(previous.ratePerTenGramsPaise)} per 10
          grams, ₹{formatPaiseAsRupees(Math.round(previous.ratePerTenGramsPaise / 10))} a
          gram. The new figure is checked against that one, and a figure ten times it or a tenth
          of it is refused outright.
        </p>
      )}

      <form method="post" action="/api/admin/rate">
        <input type="hidden" name="intent" value="correct" />
        <input type="hidden" name="supersedes" value={row.id} />
        <input type="hidden" name="csrf" value={csrf} />

        <p className="rate__field">
          <label className="rate__label" htmlFor="fix-figure">
            What should it be? {UNIT_WORDS[unitOf(row.metal, row.fineness)]}
          </label>
          <input
            className="rate__input rate__input--figure"
            id="fix-figure"
            name="figure"
            type="text"
            inputMode="numeric"
            autoComplete="off"
            enterKeyHint="done"
            required
          />
        </p>

        <fieldset className="rate__reasons">
          <legend className="rate__label">Why was it wrong?</legend>
          {(Object.keys(CORRECTION_REASONS) as (keyof typeof CORRECTION_REASONS)[]).map(
            (code, index) => (
              <label className="rate__reason" htmlFor={`why-${code}`} key={code}>
                <input
                  type="radio"
                  id={`why-${code}`}
                  name="reasonCode"
                  value={code}
                  defaultChecked={index === 0}
                  required
                />
                <span>{CORRECTION_REASONS[code]}</span>
              </label>
            )
          )}
        </fieldset>

        <p className="rate__confirm">
          <label htmlFor="fix-confirm">
            <input type="checkbox" id="fix-confirm" name="confirmed" value="yes" />
            <span>
              I have read the figure back. Needed only when the correction moves the rate by more
              than a quarter.
            </span>
          </label>
        </p>

        <p className="rate__acts">
          <button className="rate__btn rate__btn--primary" type="submit">
            Correct this rate
          </button>
        </p>
      </form>

      {/* THE CONSEQUENCE DISCLOSURE. It is above the closing paragraph and
          below the button on purpose: it is not a warning to be dismissed, it
          is the list of people to ring afterwards. */}
      <BilledOrders
        orders={billed}
        nowMs={nowMs}
        heading="Orders already priced from this figure"
      />

      <p className="rate__p rate__p--rule">
        This does not erase anything. The old figure stays in the history with your correction
        beside it, because the orders that were priced from it still have to add up.
      </p>

      <p>
        <a className="rate__link" href="/admin/rate">
          Leave the rate as it is
        </a>
      </p>
    </Shell>
  );
}

/* =========================================================================
 * The trail
 * ====================================================================== */

function History({
  rows,
  metal,
  fineness,
  nowMs,
}: {
  rows: readonly RateHistoryRow[];
  metal: string;
  fineness: number;
  nowMs: number;
}) {
  return (
    <section className="rate__section">
      <h2 className="rate__section-head">
        History: {findRateSlot(metal, fineness)?.label ?? fineness}
      </h2>

      {rows.length === 0 ? (
        <p className="rate__p">Nothing has been recorded for this purity yet.</p>
      ) : (
        <ol className="rate__history">
          {rows.map((row) => (
            <li className="rate__event" key={row.id}>
              <p className="rate__event-line">
                <time className="rate__event-when" dateTime={row.effectiveFrom}>
                  {formatWhen(row.effectiveFrom, nowMs)}
                </time>
                <RateFigure row={{ ...row, metal, fineness }} />
              </p>

              <p className="rate__event-meta">
                {row.corrects
                  ? `A correction, entered by hand: ${CORRECTION_REASONS[row.corrects.reason].toLowerCase()}`
                  : row.source === "ibja"
                    ? "From IBJA, automatically"
                    : "Entered by hand"}
                {row.createdBy === null ? null : ` · ${row.createdBy}`}
                {row.sourceQuoteRaw === null ? null : (
                  <>
                    {" · as published: "}
                    <span className="rate__mono">{row.sourceQuoteRaw}</span>
                  </>
                )}
              </p>

              {row.correctedBy === null ? null : (
                <p className="rate__event-fix">
                  <span className="rate__mark" aria-hidden="true" />
                  Corrected to ₹{formatPaiseAsRupees(row.correctedBy.ratePerTenGramsPaise)}{" "}
                  <time dateTime={row.correctedBy.at}>
                    {formatWhen(row.correctedBy.at, nowMs)}
                  </time>
                  . This figure was not removed and it will not be.
                </p>
              )}

              <p className="rate__event-acts">
                {row.billedLines > 0 ? (
                  <a className="rate__link" href={`/admin/rate?billed=${row.id}`}>
                    {row.billedLines === 1
                      ? "1 order line was priced from this"
                      : `${row.billedLines} order lines were priced from this`}
                  </a>
                ) : (
                  <span className="rate__event-meta">Nothing was priced from this.</span>
                )}
                {row.inForce ? (
                  <a className="rate__link rate__link--wrong" href={`/admin/rate?wrong=${row.id}`}>
                    This one is wrong
                  </a>
                ) : null}
              </p>
            </li>
          ))}
        </ol>
      )}

      <p className="rate__filters">
        {RATE_SLOTS.map((slot, index) => (
          <span key={`${slot.metal}:${slot.fineness}`}>
            {index === 0 ? null : <span className="rate__sep"> · </span>}
            <a
              className="rate__filter"
              href={`/admin/rate?metal=${slot.metal}&fineness=${slot.fineness}`}
              aria-current={
                slot.metal === metal && slot.fineness === fineness ? "true" : undefined
              }
            >
              {slot.label}
            </a>
          </span>
        ))}
      </p>
    </section>
  );
}

/* =========================================================================
 * The page
 * ====================================================================== */

type Loaded = {
  readonly board: RateBoardRow[];
  readonly health: IngestHealth;
  readonly standing: Awaited<ReturnType<typeof readRateStanding>>;
};

export default async function AdminRatePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nowMs = readClock();
  const inbound = await headers();

  // The layout has already refused an anonymous request, and this asks again.
  // Both, always: a page that trusts its layout is trusting a file it does not
  // import.
  const current: CurrentAdmin | null = await resolveAdmin({
    cookie: inbound.get("cookie"),
    ip: inbound.get("cf-connecting-ip"),
    userAgent: inbound.get("user-agent"),
  });

  if (current === null) {
    return (
      <Shell title="Sign in to see the rate">
        <p className="rate__p">
          This session has ended, so nothing is shown. Signing in again brings the rate back
          exactly as it was.
        </p>
      </Shell>
    );
  }

  const params = await searchParams;
  const metalParam = first(params.metal).toLowerCase();
  const finenessParam = Number(first(params.fineness));
  const slot = findRateSlot(metalParam, finenessParam);
  const metal = slot?.metal ?? "gold";
  const fineness = slot?.fineness ?? HEADLINE_FINENESS;

  let loaded: Loaded;
  let db;
  try {
    db = getAdminDb();
    const [board, health, standing] = await Promise.all([
      readRateBoard(db),
      readIngestHealth(db, { nowMs }),
      readRateStanding(db, { metal: "gold", fineness: HEADLINE_FINENESS, nowMs }),
    ]);
    loaded = { board, health, standing };
  } catch (error) {
    // A panel that cannot read the rate says so. It never renders an empty
    // board, which reads as "there is no rate" — a different and much more
    // alarming statement.
    console.error("[admin-rate] the rate book could not be read:", error);
    return (
      <Shell title="Gold rate">
        <p className="rate__notice rate__notice--problem">
          The rate book could not be read just now, so nothing is shown. This is the
          website&rsquo;s own problem and not a sign that the rate is missing.
        </p>
      </Shell>
    );
  }

  const { board, health, standing } = loaded;
  const notice = first(params.notice);

  /* ---- ?billed=<id> — the orders priced from one rate row -------------- */

  const billedId = first(params.billed);
  if (UUID.test(billedId)) {
    const row = await readRateById(db, billedId);
    // The read is logged by the reader, not by this page.
    const orders = await readOrdersBilledFromRate(db, billedId, {
      actor: current.actor,
      nowMs,
    });

    return (
      <Shell title="Orders priced from this rate" back={{ href: "/admin/rate", label: "Gold rate" }}>
        <Notice code={notice} />
        {row === null ? (
          <p className="rate__p">That rate is not in the book.</p>
        ) : (
          <p className="rate__mono">
            {row.label}, ₹{formatPaiseAsRupees(row.ratePerTenGramsPaise)} per 10 grams, in force
            from <time dateTime={row.effectiveFrom}>{formatWhen(row.effectiveFrom, nowMs)}</time>.
          </p>
        )}
        <BilledOrders orders={orders} nowMs={nowMs} heading="The orders" />
      </Shell>
    );
  }

  /* ---- ?wrong=<id> — the correction ------------------------------------ */

  const wrongId = first(params.wrong);
  if (UUID.test(wrongId)) {
    const row = board.find((entry) => entry.id === wrongId) ?? null;

    if (row === null) {
      return (
        <Shell title="That rate is no longer in force" back={{ href: "/admin/rate", label: "Gold rate" }}>
          <p className="rate__p">
            It has already been closed and replaced, so it cannot be corrected. What it was is
            part of the record now, the orders billed from it were billed from it.
            Correct the rate in force instead.
          </p>
        </Shell>
      );
    }

    const [orders, previous] = await Promise.all([
      readOrdersBilledFromRate(db, row.id, { actor: current.actor, nowMs }),
      readRateBefore(db, {
        metal: row.metal,
        fineness: row.fineness,
        before: row.effectiveFrom,
      }),
    ]);

    return (
      <CorrectForm
        csrf={current.identity.csrfToken}
        row={row}
        previous={previous}
        billed={orders}
        nowMs={nowMs}
      />
    );
  }

  /* ---- ?enter=1 — the manual form -------------------------------------- */

  if (first(params.enter) !== "") {
    return <EnterForm csrf={current.identity.csrfToken} board={board} />;
  }

  /* ---- The board ------------------------------------------------------- */

  const history = await readRateHistory(db, { metal, fineness });
  const word = rateStandingWord(standing.lookup);
  const headline = board.find(
    (row) => row.metal === "gold" && row.fineness === HEADLINE_FINENESS
  );
  const others = board.filter(
    (row) => !(row.metal === "gold" && row.fineness === HEADLINE_FINENESS)
  );
  const usable = standing.lookup?.ok === true ? standing.lookup.rate : null;
  const unusable =
    standing.lookup !== null && standing.lookup.ok === false
      ? (standing.lookup.unusableRate ?? null)
      : null;

  return (
    <div className="rate">
      <p>
        <a className="rate__back" href="/admin">
          &larr; Today
        </a>
      </p>

      <h1 className="rate__title">Gold rate</h1>

      <Notice code={notice} />

      {/* NOTHING HAS FIXED PROMINENCE. This block exists only when the rate is
          missing, out of date or unreadable. */}
      {word === "good" ? null : (
        <Alarm
          standing={word}
          unusable={
            unusable === null
              ? null
              : {
                  ratePerTenGramsPaise: unusable.ratePerTenGramsPaise,
                  metal: unusable.metal,
                  fineness: unusable.fineness,
                  effectiveFrom: unusable.effectiveFrom,
                }
          }
          health={health}
          nowMs={nowMs}
        />
      )}

      {headline === undefined ? (
        <p className="rate__p">
          Nothing on the website can show a price until a rate is recorded. Every piece is
          showing &ldquo;price on request&rdquo;, which is the truth rather than a placeholder.
        </p>
      ) : (
        <section className="rate__panel" aria-labelledby="rate-in-use">
          <h2 className="rate__panel-head" id="rate-in-use">
            In use now
          </h2>
          <p className="rate__panel-figure">
            <span className="rate__purity">{headline.label}</span>{" "}
            <RateFigure row={headline} size="lead" />
          </p>
          <p className="rate__panel-note">
            {headline.source === "ibja" ? "From IBJA" : "Entered by hand"}, in force since{" "}
            <time dateTime={headline.effectiveFrom}>
              {formatWhen(headline.effectiveFrom, nowMs)}
            </time>
            .
            {usable === null ? null : (
              <>
                {" "}
                Good until{" "}
                <time dateTime={usable.expiresAt}>{formatWhen(usable.expiresAt, nowMs)}</time>.
              </>
            )}
          </p>
          {headline.sourceQuoteRaw === null ? null : (
            <p className="rate__panel-note">
              As published: <span className="rate__mono">{headline.sourceQuoteRaw}</span>
            </p>
          )}
        </section>
      )}

      {others.length === 0 ? null : (
        <section className="rate__section">
          <h2 className="rate__section-head">The other purities</h2>
          <ul className="rate__board">
            {others.map((row) => (
              <li className="rate__board-row" key={row.id}>
                <span className="rate__purity">{row.label}</span>
                <RateFigure row={row} />
                <span className="rate__board-when">
                  {row.source === "ibja" ? "IBJA" : "By hand"},{" "}
                  <time dateTime={row.effectiveFrom}>
                    {formatWhen(row.effectiveFrom, nowMs)}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="rate__acts">
        <a className="rate__btn" href="/admin/rate?enter=1">
          Enter a rate by hand
        </a>
      </p>

      {/* THE APPEND-ONLY RULE, IN ONE LINE OF SHOP ENGLISH. */}
      <p className="rate__p rate__p--rule">
        A rate is never edited. If one goes in wrong you close it and put the right one in its
        place, and the wrong one stays in the history underneath, because the orders that
        were priced from it still have to add up. That is why there is no Edit button on this
        screen, only <strong>This one is wrong</strong>.
      </p>

      <section className="rate__section">
        <h2 className="rate__section-head">The automatic check</h2>
        {health.lastRunAt === null ? (
          <p className="rate__p">
            It has never run. Every rate in the book was entered by hand.
          </p>
        ) : (
          <p className="rate__p">
            Last ran{" "}
            <time dateTime={health.lastRunAt}>{formatWhen(health.lastRunAt, nowMs)}</time> and
            took the gold rates from IBJA.
            {health.nextDueAt === null ? null : (
              <>
                {" "}
                Next due{" "}
                <time dateTime={health.nextDueAt}>{formatWhen(health.nextDueAt, nowMs)}</time>.
              </>
            )}
            {health.missedPublications > 0 ? (
              <>
                {" "}
                <span className="rate__wrong">
                  <span className="rate__mark" aria-hidden="true" />
                  It has missed{" "}
                  {health.missedPublications === 1
                    ? "one publication"
                    : `${health.missedPublications} publications`}{" "}
                  since then.
                </span>
              </>
            ) : null}
          </p>
        )}
      </section>

      <History rows={history} metal={metal} fineness={fineness} nowMs={nowMs} />
    </div>
  );
}
