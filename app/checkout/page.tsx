/**
 * CHECKOUT — /checkout.
 *
 * ===========================================================================
 * A SERVER COMPONENT, AND NO CLIENT JAVASCRIPT AT ALL
 * ===========================================================================
 * The order form is a plain `<form method="post" action="/api/orders">`,
 * exactly as the cart's remove control and the shop's filters are plain forms.
 * `/api/orders` answers a form with a 303 back here, so checkout works with
 * scripting switched off, is keyboard operable for free, survives a reload
 * without re-posting, and ships zero kilobytes of client bundle.
 *
 * The one cost of that choice is stated where it is paid: a rejected form loses
 * what was typed, because the only channel back through a redirect is the query
 * string and a name, a phone number, an address and a PAN have no business in
 * browser history, in a referrer or in an access log. Every control below
 * therefore carries `required` and `pattern`, so the browser catches nearly all
 * of it before a request is made. See `CHECKOUT_NOTICES` in `_data/orders.ts`.
 *
 * ===========================================================================
 * THREE STATES, AND THE MIDDLE ONE IS THE ONE THAT MATTERS TODAY
 * ===========================================================================
 *   CONFIRMED  `?ref=` names an order this browser's cart cookie produced. The
 *              order is read back from D1 and reconciled against its own
 *              `line_item_count` before a single figure is printed.
 *   BLOCKED    the cart cannot lawfully become an order. NO FORM IS RENDERED —
 *              the refusal is not a disabled button, it is the absence of the
 *              control, plus the reason per piece and the enquiry path that
 *              does work. Today every seeded piece is `on_request`, so this is
 *              what a visitor sees, and it says exactly why.
 *   READY      an itemised quote and the form.
 *
 * ===========================================================================
 * NOTHING ON THIS PAGE SAYS A PAYMENT SUCCEEDED
 * ===========================================================================
 * `PAYMENT_CAPTURE_ENABLED` is false. Every sentence about money on this page
 * comes from `paymentStanding()` in the data layer, which is a pure function of
 * that flag — so the copy and the behaviour cannot drift apart. There is no
 * tick, no receipt, no "confirmed", and the standing is set in `--sindoor`,
 * the light field's accent, rather than in the emerald the cart uses for a
 * reservation that really is held.
 *
 * ===========================================================================
 * THE REGISTER IS HAVELI
 * ===========================================================================
 * The same room as `/cart`: plaster field, brass as ornament and never a
 * letterform, `--sindoor` as the light-field accent, gold only on the two
 * Darbar bands. No animation is declared, so there is nothing for
 * `prefers-reduced-motion` to reduce.
 *
 * ===========================================================================
 * PRIVACY AND RENDERING MODE
 * ===========================================================================
 * `force-dynamic` and `robots: noindex`. This page is per-visitor, keyed on a
 * bearer cookie, and it renders a name and an address once an order exists. It
 * must never be prerendered into a shared cache and never be indexed. The cart
 * token is HttpOnly and never appears in the markup.
 */

import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { formatPricePaise } from "../_data/catalogue";
import { CART_COOKIE } from "../_data/cart";
import {
  BOOKING_ADVANCE_BPS,
  CHECKOUT_FIELD_PROBLEMS,
  CHECKOUT_NOTICES,
  GST_STATES,
  PAN_REQUIRED_AT_PAISE,
  PAYMENT_CAPTURE_ENABLED,
  formatWeightMg,
  getOrderDb,
  gstStateName,
  isProblemNotice,
  lineBlockCopy,
  paymentLegs,
  paymentStanding,
  readOrderForCart,
  resolveCheckout,
  toCheckoutFields,
  toCheckoutNotice,
  type CheckoutResolution,
  type OrderReceipt,
  type OrderReceiptResult,
} from "../_data/orders";
import { site } from "../site-config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Checkout | ${site.name}`,
  description: "Place an order for a piece you have set aside at Alankar Jewellers.",
  robots: { index: false, follow: false },
};

/* -------------------------------------------------------------------------
 * Shared furniture
 * ---------------------------------------------------------------------- */

function TopBar() {
  return (
    <header className="checkout-topbar section--darbar-deep grained">
      <div className="checkout-topbar__inner">
        <Link className="checkout-wordmark" href="/">
          <span className="checkout-wordmark__name">{site.name}</span>
          <span className="checkout-wordmark__since">Since {site.foundedYear}</span>
        </Link>
        <nav className="checkout-nav" aria-label={site.name}>
          <Link href="/">The shop</Link>
          <Link href="/shop">The catalogue</Link>
          <Link href="/cart">Your cart</Link>
          <Link href="/checkout" aria-current="page">
            Checkout
          </Link>
        </nav>
      </div>
      <div className="rule-gold" aria-hidden="true" />
    </header>
  );
}

function Colophon() {
  return (
    <footer className="checkout-colophon section--darbar-deep grained">
      <p>
        {site.name}, since {site.foundedYear}.{" "}
        <Link href="/cart">Back to your cart</Link>
      </p>
    </footer>
  );
}

/**
 * The standing of the money, and the only place on this page that speaks about
 * it. With the flag off it says, in the shop's own words, that nothing has been
 * charged and that a person will call — never that anything was received.
 */
function PaymentStanding({
  plan,
  fulfilment,
}: {
  plan: "full_prepaid" | "booking_advance";
  fulfilment: "ship" | "store_pickup";
}) {
  const standing = paymentStanding(PAYMENT_CAPTURE_ENABLED, { plan, fulfilment });

  return (
    <div className="order-standing">
      <p className="order-standing__badge">{standing.badge}</p>
      {/* An h2, not a styled paragraph: on both states of this page it is the
          first thing under the h1, and the heading outline has no gaps in it. */}
      <h2 className="order-standing__heading">{standing.heading}</h2>
      <p className="order-standing__body">{standing.body}</p>
    </div>
  );
}

/* -------------------------------------------------------------------------
 * CONFIRMED
 * ---------------------------------------------------------------------- */

function ReceiptLines({ receipt }: { receipt: OrderReceipt }) {
  return (
    <ul className="order-lines">
      {receipt.items.map((item) => (
        <li className="order-line" key={item.sku}>
          <div className="order-line__head">
            <h3 className="order-line__title">{item.title}</h3>
            <p className="order-line__figure">{formatPricePaise(item.lineTotalPaise)}</p>
          </div>
          {item.description ? (
            <p className="order-line__spec">{item.description}</p>
          ) : null}
          {/* BIS (Hallmarking) Regulations 2018 Reg. 5(11): the invoice shall
              indicate separately the description of each article, the net
              weight of precious metal, the purity in carat AND fineness, and
              the hallmarking charges. Every one of these is a snapshot column
              on `order_items`, printed here without a join. */}
          <dl className="order-line__facts">
            <div className="order-line__fact">
              <dt>SKU</dt>
              <dd>{item.sku}</dd>
            </div>
            <div className="order-line__fact">
              <dt>Net metal weight</dt>
              <dd>
                {item.netMetalWeightMg === null
                  ? "Not applicable to this piece"
                  : formatWeightMg(item.netMetalWeightMg)}
              </dd>
            </div>
            <div className="order-line__fact">
              <dt>Purity</dt>
              <dd>{item.purity ?? "Not applicable to this piece"}</dd>
            </div>
            <div className="order-line__fact">
              <dt>Hallmarking</dt>
              <dd>
                {item.hallmarkingPaise > 0
                  ? formatPricePaise(item.hallmarkingPaise)
                  : "Exempt. Kundan, Polki and Jadau are outside mandatory hallmarking (QCO cl. 2(3))"}
              </dd>
            </div>
            {item.huid ? (
              <div className="order-line__fact">
                <dt>HUID</dt>
                <dd>{item.huid}</dd>
              </div>
            ) : null}
            <div className="order-line__fact">
              <dt>HSN</dt>
              <dd>{item.hsnCode}</dd>
            </div>
            <div className="order-line__fact">
              <dt>Quantity</dt>
              <dd>{item.quantity}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function ReceiptTotals({ receipt }: { receipt: OrderReceipt }) {
  return (
    <dl className="order-totals">
      <div className="order-totals__row">
        <dt>Taxable value</dt>
        <dd>{formatPricePaise(receipt.taxablePaise)}</dd>
      </div>
      {receipt.igstPaise > 0 ? (
        <div className="order-totals__row">
          <dt>IGST</dt>
          <dd>{formatPricePaise(receipt.igstPaise)}</dd>
        </div>
      ) : (
        <>
          <div className="order-totals__row">
            <dt>CGST</dt>
            <dd>{formatPricePaise(receipt.cgstPaise)}</dd>
          </div>
          <div className="order-totals__row">
            <dt>SGST</dt>
            <dd>{formatPricePaise(receipt.sgstPaise)}</dd>
          </div>
        </>
      )}
      <div className="order-totals__row order-totals__row--total">
        <dt>Order total</dt>
        <dd>{formatPricePaise(receipt.totalPaise)}</dd>
      </div>
      <div className="order-totals__row">
        <dt>Taken so far</dt>
        <dd>{formatPricePaise(receipt.advancePaidPaise)}</dd>
      </div>
      <div className="order-totals__row">
        <dt>{receipt.paymentPlan === "booking_advance" ? "Booking advance" : "Due"}</dt>
        <dd>{formatPricePaise(receipt.advanceDuePaise)}</dd>
      </div>
      {receipt.balanceDuePaise > 0 ? (
        <div className="order-totals__row">
          <dt>Balance, at the counter</dt>
          <dd>{formatPricePaise(receipt.balanceDuePaise)}</dd>
        </div>
      ) : null}
    </dl>
  );
}

function Confirmation({ receipt }: { receipt: OrderReceipt }) {
  return (
    <>
      <div className="checkout-head">
        <p className="label">Order {receipt.orderNumber}</p>
          <h1 id="checkout-title">Your order is recorded.</h1>
        <p className="lede checkout-head__lede">
          The piece is off the wall and held in your name. It has not been paid
          for, and this page is not a receipt.
        </p>
        <div className="rule-brass checkout-head__rule" aria-hidden="true" />
      </div>

      <div className="checkout-wall grained">
        <div className="checkout-layout">
          <div className="checkout-main">
            <PaymentStanding
              plan={receipt.paymentPlan}
              fulfilment={receipt.fulfilmentMode}
            />

            <section className="order-block" aria-labelledby="order-what-title">
              <h2 className="order-block__title" id="order-what-title">
                What you have ordered
              </h2>
              <ReceiptLines receipt={receipt} />
            </section>

            <section className="order-block" aria-labelledby="order-where-title">
              <h2 className="order-block__title" id="order-where-title">
                Where it goes, and who we call
              </h2>
              <dl className="order-line__facts">
                <div className="order-line__fact">
                  <dt>For</dt>
                  <dd>{receipt.contactName}</dd>
                </div>
                <div className="order-line__fact">
                  <dt>We will call</dt>
                  <dd>{receipt.contactPhone}</dd>
                </div>
                {receipt.contactEmail ? (
                  <div className="order-line__fact">
                    <dt>Email</dt>
                    <dd>{receipt.contactEmail}</dd>
                  </div>
                ) : null}
                <div className="order-line__fact">
                  <dt>Collection</dt>
                  <dd>
                    {receipt.fulfilmentMode === "store_pickup"
                      ? "Collected from the shop."
                      : "Sent to you, by insured carriage arranged by hand."}
                  </dd>
                </div>
                {receipt.ship ? (
                  <div className="order-line__fact">
                    <dt>Address</dt>
                    <dd>
                      {[
                        receipt.ship.name,
                        receipt.ship.line1,
                        receipt.ship.line2,
                        receipt.ship.city,
                        gstStateName(receipt.ship.stateCode),
                        receipt.ship.pincode,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </dd>
                  </div>
                ) : null}
                <div className="order-line__fact">
                  <dt>Place of supply</dt>
                  <dd>
                    {receipt.placeOfSupplyStateCode === null
                      ? "Not recorded"
                      : `${gstStateName(receipt.placeOfSupplyStateCode)} (${receipt.placeOfSupplyStateCode})`}
                  </dd>
                </div>
              </dl>
            </section>

            {/* Consumer Protection (E-Commerce) Rule 7(1)(f) gives a ticket
                number for each COMPLAINT, through which the consumer can track
                its status. This block used to say the two Rule 4(5) clocks were
                "already running", because placement opened a grievance ticket on
                every order. That was wrong twice over: the rule's clocks start
                on a complaint, not on a purchase, and the promise was made to
                customers on the confirmation page. Placement no longer opens a
                ticket, so this now offers the order number as the reference and
                states the clocks start when someone actually reports a problem. */}
            <section className="order-block" aria-labelledby="order-ticket-title">
              <h2 className="order-block__title" id="order-ticket-title">
                If something is wrong with this order
              </h2>
              <p className="order-block__body">
                Quote{" "}
                <strong className="order-ticket">
                  {receipt.ticketNumber ?? receipt.orderNumber}
                </strong>{" "}
                and we will find it in one step. Tell us something is wrong and
                we open a complaint against it the same day. From that point we
                answer within forty-eight hours and settle within a month.
              </p>
            </section>
          </div>

          <aside className="order-summary" aria-label="Order total">
            <p className="label">The order</p>
            <p className="order-summary__figure">
              {formatPricePaise(receipt.totalPaise)}
            </p>
            <p className="order-summary__note">
              GST included, itemised below, at a single 3% on the total
              transaction value of finished jewellery.
            </p>
            <ReceiptTotals receipt={receipt} />
            <p className="order-summary__note">
              Placed{" "}
              <time dateTime={receipt.placedAt}>{receipt.placedAt.slice(0, 10)}</time>.
              Priced against the gold rate held at that moment and frozen there;
              this figure will not move.
            </p>
          </aside>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------
 * BLOCKED — no form is rendered at all
 * ---------------------------------------------------------------------- */

function Blocked({ resolution }: { resolution: Extract<CheckoutResolution, { ok: false }> }) {
  const notice = CHECKOUT_NOTICES[
    resolution.reason === "no_cart" || resolution.reason === "empty_cart"
      ? "empty-cart"
      : resolution.reason === "too_many_lines"
        ? "too-many"
        : resolution.reason === "shop_state_unknown"
          ? "shop-state-unknown"
          : "unpriceable"
  ];

  return (
    <>
      <div className="checkout-head">
        <h1 id="checkout-title">Not something we can price.</h1>
        <p className="lede checkout-head__lede">{notice}</p>
        <div className="rule-brass checkout-head__rule" aria-hidden="true" />
      </div>

      <div className="checkout-wall grained">
        <div className="checkout-blocked">
          {resolution.blocked.length > 0 ? (
            <>
              <h2 className="checkout-blocked__title">Why, piece by piece.</h2>
              <ul className="checkout-blocked__list">
                {resolution.blocked.map((line) => (
                  <li className="checkout-blocked__item" key={line.slug}>
                    <Link className="checkout-blocked__link" href={`/shop/${line.slug}`}>
                      {line.title}
                    </Link>{" "}
                    : {lineBlockCopy(line.reason)}.
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <h2 className="checkout-blocked__title">
              {resolution.reason === "shop_state_unknown"
                ? "Our end, not yours."
                : "Nothing here to order."}
            </h2>
          )}

          {/* The honest terminus. Not a dead end and not a disabled button:
              the path that actually works at this shop, which is the one a
              ₹4 lakh bridal set converts on anyway. */}
          <p className="checkout-blocked__body">
            {resolution.reason === "shop_state_unknown"
              ? "An invoice has to name the state the supply is made from, because that is what decides whether GST is charged as CGST and SGST or as IGST. Ours is not recorded here yet, so we will not write an order we cannot invoice correctly. This is our gap to close, not yours."
              : "These pieces are quoted by hand, against the gold rate at the moment you ask, and we would rather create no order at all than one with a figure we cannot stand behind. An enquiry reaches a person, who will price the whole cart in front of you (metal, making, stones and GST, itemised the same way every piece on this site is broken up) and hold it while you decide."}
          </p>

          <div className="checkout-blocked__actions">
            <Link className="button" href="/#visit">
              Ask us to price these
            </Link>
            <Link className="text-action" href="/cart">
              Back to your cart
            </Link>
          </div>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------
 * READY — the quote and the form
 * ---------------------------------------------------------------------- */

function QuoteLines({ resolution }: { resolution: Extract<CheckoutResolution, { ok: true }> }) {
  const { checkout } = resolution;

  return (
    <ul className="order-lines">
      {checkout.lines.map((line, index) => {
        const priced = checkout.quote.lines[index];
        return (
          <li className="order-line" key={line.row.variantId}>
            <div className="order-line__head">
              <h3 className="order-line__title">
                <Link className="order-line__link" href={`/shop/${line.row.slug}`}>
                  {line.row.title}
                </Link>
              </h3>
              <p className="order-line__figure">
                {priced === undefined ? "" : formatPricePaise(priced.lineTotalPaise)}
              </p>
            </div>
            {/* Rule 7(1)(e): the total in a single figure TOGETHER WITH the
                breakup, showing every compulsory and voluntary charge. The
                components come straight off the price engine, which built the
                total from the same integers. */}
            <dl className="order-line__breakup">
              {(priced?.components ?? []).map((component) => (
                <div className="order-line__breakuprow" key={component.key}>
                  <dt>{component.label}</dt>
                  <dd>{formatPricePaise(component.amountPaise)}</dd>
                </div>
              ))}
            </dl>
            <dl className="order-line__facts">
              <div className="order-line__fact">
                <dt>Net metal weight</dt>
                <dd>
                  {line.row.netMetalWeightMg === null
                    ? "Not applicable to this piece"
                    : formatWeightMg(line.row.netMetalWeightMg)}
                </dd>
              </div>
              <div className="order-line__fact">
                <dt>Purity</dt>
                <dd>{line.purityLabel ?? "Not applicable to this piece"}</dd>
              </div>
              <div className="order-line__fact">
                <dt>Country of origin</dt>
                <dd>{line.row.countryOfOrigin ?? "India"}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}

function OrderForm({
  resolution,
  fields,
}: {
  resolution: Extract<CheckoutResolution, { ok: true }>;
  fields: readonly (keyof typeof CHECKOUT_FIELD_PROBLEMS)[];
}) {
  const total = resolution.checkout.quote.totalPaise;
  const advance = paymentLegs(total, "booking_advance");
  const panNeeded = total >= PAN_REQUIRED_AT_PAISE;

  return (
    <form className="checkout-form" method="post" action="/api/orders">
      {fields.length > 0 ? (
        <div className="checkout-problems" role="group" aria-label="What still needs fixing">
          <p className="checkout-problems__title">
            Nothing was ordered. These still need you:
          </p>
          <ul>
            {fields.map((field) => (
              <li key={field}>{CHECKOUT_FIELD_PROBLEMS[field]}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <fieldset className="checkout-fieldset">
        <legend className="checkout-legend">Who we are speaking to</legend>

        <label className="checkout-field">
          <span>Your name</span>
          <input name="name" type="text" required maxLength={120} autoComplete="name" />
        </label>

        <label className="checkout-field">
          <span>Mobile number</span>
          <input
            name="phone"
            type="tel"
            required
            inputMode="tel"
            maxLength={20}
            autoComplete="tel"
          />
        </label>

        <label className="checkout-field checkout-field--wide">
          <span>Email (optional)</span>
          <input name="email" type="email" maxLength={190} autoComplete="email" />
        </label>
      </fieldset>

      <fieldset className="checkout-fieldset">
        <legend className="checkout-legend">How the piece reaches you</legend>

        <div className="checkout-choices checkout-field--wide">
          <label className="checkout-choice">
            <input type="radio" name="fulfilment" value="store_pickup" defaultChecked />
            <span>
              <strong>Collect it from the shop.</strong> Seen in the salon, tried
              on, and handed over across the counter.
            </span>
          </label>
          <label className="checkout-choice">
            <input type="radio" name="fulfilment" value="ship" />
            <span>
              <strong>Send it to me.</strong> Ordinary couriers ban jewellery
              outright, so carriage is arranged and insured by hand. We agree it
              with you before anything leaves the shop, and nothing is charged
              for it here.
            </span>
          </label>
        </div>
      </fieldset>

      <fieldset className="checkout-fieldset">
        <legend className="checkout-legend">
          Address, needed only if the piece is being sent to you
        </legend>

        <label className="checkout-field checkout-field--wide">
          <span>Addressed to</span>
          <input name="shipname" type="text" maxLength={120} autoComplete="name" />
        </label>
        <label className="checkout-field checkout-field--wide">
          <span>Street address</span>
          <input name="line1" type="text" maxLength={190} autoComplete="address-line1" />
        </label>
        <label className="checkout-field checkout-field--wide">
          <span>Area, landmark (optional)</span>
          <input name="line2" type="text" maxLength={190} autoComplete="address-line2" />
        </label>
        <label className="checkout-field">
          <span>Town or city</span>
          <input name="city" type="text" maxLength={90} autoComplete="address-level2" />
        </label>
        <label className="checkout-field">
          <span>State</span>
          <select name="state" defaultValue="" autoComplete="address-level1">
            <option value="">Choose a state</option>
            {GST_STATES.map((state) => (
              <option key={state.code} value={state.code}>
                {state.name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkout-field">
          <span>PIN code</span>
          <input
            name="pincode"
            type="text"
            inputMode="numeric"
            pattern="[1-9][0-9]{5}"
            maxLength={6}
            autoComplete="postal-code"
          />
        </label>
        <p className="checkout-note checkout-field--wide">
          The state is not a formality: GST is charged as CGST and SGST or as
          IGST depending on where the piece is delivered, so it decides what your
          invoice says.
        </p>
      </fieldset>

      <fieldset className="checkout-fieldset">
        <legend className="checkout-legend">How you would like to settle it</legend>

        <div className="checkout-choices checkout-field--wide">
          <label className="checkout-choice">
            <input type="radio" name="plan" value="full_prepaid" defaultChecked />
            <span>
              <strong>The whole amount, {formatPricePaise(total)}.</strong> The
              only option if the piece is being sent to you.
            </span>
          </label>
          <label className="checkout-choice">
            <input type="radio" name="plan" value="booking_advance" />
            <span>
              <strong>
                Book it with {formatPricePaise(advance.advanceDuePaise)} and settle{" "}
                {formatPricePaise(advance.balanceDuePaise)} at the counter.
              </strong>{" "}
              That is {BOOKING_ADVANCE_BPS / 100}% now. Available only when you
              are collecting the piece from the shop. We do not send jewellery
              with money owing on it, and no courier here collects cash.
            </span>
          </label>
        </div>
        <p className="checkout-note checkout-field--wide">
          There is no cash on delivery at this shop, and there will not be. It is
          barred three times over: couriers ban carrying jewellery at all, UPI is
          capped at ₹2,00,000 for this category, and s.186 of the Income-tax Act
          2025 bars receiving ₹2,00,000 or more in cash with a penalty equal to
          the whole sum.
        </p>
      </fieldset>

      <fieldset className="checkout-fieldset">
        <legend className="checkout-legend">Tax details</legend>

        <label className="checkout-field">
          <span>PAN {panNeeded ? "(required for this order)" : "(optional)"}</span>
          <input
            name="pan"
            type="text"
            maxLength={10}
            pattern="[A-Za-z]{5}[0-9]{4}[A-Za-z]"
            required={panNeeded}
            autoComplete="off"
          />
        </label>
        <label className="checkout-field">
          <span>GSTIN, if you are buying for a business (optional)</span>
          <input name="gstin" type="text" maxLength={15} autoComplete="off" />
        </label>
        <p className="checkout-note checkout-field--wide">
          {panNeeded
            ? "This order is ₹2,00,000 or more, and the seller has a statutory duty to ensure PAN is quoted on a sale at or above that figure, whatever the payment method (Income-tax Act 2025 s.262(9), Rule 159). We hold it against the invoice and nothing else."
            : "Below ₹2,00,000 we do not need your PAN, so we do not ask for it. Above it we must, by law, whatever the payment method."}
        </p>
      </fieldset>

      <fieldset className="checkout-fieldset">
        <legend className="checkout-legend">Anything else</legend>

        <label className="checkout-field checkout-field--wide">
          <span>A note for the shop (optional)</span>
          <textarea name="notes" maxLength={2000} rows={3} />
        </label>

        {/* Rule 4(9): consent must be an explicit and affirmative action and may
            not be recorded automatically, including through pre-ticked boxes.
            Neither box below is checked, and neither ever will be. */}
        <label className="checkout-consent checkout-field--wide">
          <input type="checkbox" name="consent" value="yes" required />
          <span>
            I am placing this order with {site.name}, and I understand that no
            payment is being taken on this page.
          </span>
        </label>

        <label className="checkout-consent checkout-field--wide">
          <input type="checkbox" name="marketing" value="yes" />
          <span>
            You may also send me word when new pieces come in. Entirely optional,
            and it changes nothing about this order.
          </span>
        </label>
      </fieldset>

      <div className="checkout-submit">
        <button className="button" type="submit">
          Place this order
        </button>
        <p className="checkout-note">
          Placing it records the order and takes the piece off the wall. It does
          not charge you.
        </p>
      </div>
    </form>
  );
}

function Ready({
  resolution,
  fields,
}: {
  resolution: Extract<CheckoutResolution, { ok: true }>;
  fields: readonly (keyof typeof CHECKOUT_FIELD_PROBLEMS)[];
}) {
  const quote = resolution.checkout.quote;

  return (
    <>
      <div className="checkout-head">
        <h1 id="checkout-title">Tell us where it goes.</h1>
        <p className="lede checkout-head__lede">
          The figure below is the price of record for this order: quoted against
          the gold rate as it stands right now, itemised, and frozen the moment
          you place it.
        </p>
        <div className="rule-brass checkout-head__rule" aria-hidden="true" />
      </div>

      <div className="checkout-wall grained">
        <div className="checkout-layout">
          <div className="checkout-main">
            {/* The flag is off, so this is the first thing on the page, before
                a single field is asked for. It is not a footnote. */}
            <PaymentStanding plan="full_prepaid" fulfilment="store_pickup" />
            <OrderForm resolution={resolution} fields={fields} />
          </div>

          <aside className="order-summary" aria-label="Order total">
            <p className="label">What it comes to</p>
            <p className="order-summary__figure">
              {formatPricePaise(quote.totalPaise)}
            </p>
            <dl className="order-totals">
              {quote.components.map((component) => (
                <div className="order-totals__row" key={component.key}>
                  <dt>{component.label}</dt>
                  <dd>{formatPricePaise(component.amountPaise)}</dd>
                </div>
              ))}
              <div className="order-totals__row order-totals__row--total">
                <dt>Total</dt>
                <dd>{formatPricePaise(quote.totalPaise)}</dd>
              </div>
            </dl>
            <p className="order-summary__note">
              GST is a single 3% on the total transaction value of finished
              jewellery, whether or not the making charge is shown separately
              (CBIC Sectoral FAQ, Gems &amp; Jewellery, Q7). Showing you the
              breakup does not split the rate.
            </p>
            <p className="order-summary__note">
              No delivery charge is included. Carriage is arranged with you by
              hand, because ordinary couriers do not carry jewellery at all.
            </p>
            <section className="order-block" aria-labelledby="checkout-quote-title">
              <h2 className="order-block__title" id="checkout-quote-title">
                Piece by piece
              </h2>
              <QuoteLines resolution={resolution} />
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------- */

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;

  const notice = toCheckoutNotice(first(params.notice));
  const fields = toCheckoutFields(first(params.fields));
  const ref = first(params.ref);

  const jar = await cookies();
  const token = jar.get(CART_COOKIE)?.value ?? null;

  let receipt: OrderReceiptResult = { found: false };
  let resolution: CheckoutResolution | null = null;
  let unavailable = false;

  try {
    const db = getOrderDb();

    if (typeof ref === "string") {
      receipt = await readOrderForCart(db, { orderNumber: ref, cartToken: token });
    }
    if (!receipt.found) {
      resolution = await resolveCheckout(db, { token });
    }
  } catch (error) {
    // No fabricated empty checkout. A cart we cannot read is not a cart we know
    // to be empty, and an order book we cannot reach is not an order we can
    // take. Say so.
    console.error("[checkout] could not reach the order book:", error);
    unavailable = true;
  }

  return (
    <div className="checkout-page">
      <TopBar />

      <main>
        <section
          className="section section--haveli grained checkout-section"
          aria-labelledby="checkout-title"
        >
          {notice ? (
            <p
              className={`checkout-notice${
                isProblemNotice(notice) ? " checkout-notice--problem" : ""
              }`}
            >
              {CHECKOUT_NOTICES[notice]}
            </p>
          ) : null}

          {unavailable ? (
            <>
              <div className="checkout-head">
                <h1 id="checkout-title">We cannot reach our order book.</h1>
                <p className="lede checkout-head__lede">
                  This is our end, not yours. Nothing has been ordered, nothing
                  has been charged, and nothing in your cart has changed.
                </p>
                <div className="rule-brass checkout-head__rule" aria-hidden="true" />
              </div>
              <div className="checkout-wall grained">
                <div className="checkout-blocked">
                  <h2 className="checkout-blocked__title">Try again in a moment.</h2>
                  <p className="checkout-blocked__body">
                    Or call the shop and we will write the order down by hand,
                    which is how it was done here for a long time before this
                    page existed.
                  </p>
                  <div className="checkout-blocked__actions">
                    <Link className="button" href="/checkout">
                      Try again
                    </Link>
                    <Link className="text-action" href="/cart">
                      Back to your cart
                    </Link>
                  </div>
                </div>
              </div>
            </>
          ) : receipt.found && receipt.intact ? (
            <Confirmation receipt={receipt.receipt} />
          ) : receipt.found ? (
            <>
              <div className="checkout-head">
                <p className="label">Order {receipt.orderNumber}</p>
          <h1 id="checkout-title">This order does not add up.</h1>
                <p className="lede checkout-head__lede">
                  We hold an order under this number, and our own check on it did
                  not pass. The pieces recorded against it do not match the
                  count it was written with. We will not print a figure from a
                  record we cannot vouch for.
                </p>
                <div className="rule-brass checkout-head__rule" aria-hidden="true" />
              </div>
              <div className="checkout-wall grained">
                <div className="checkout-blocked">
                  <h2 className="checkout-blocked__title">Please call the shop.</h2>
                  <p className="checkout-blocked__body">
                    Quote {receipt.orderNumber}. Nothing has been charged, and we
                    will put it right by hand before anything else happens.
                  </p>
                  <div className="checkout-blocked__actions">
                    <Link className="button" href="/#visit">
                      How to reach us
                    </Link>
                  </div>
                </div>
              </div>
            </>
          ) : resolution !== null && resolution.ok ? (
            <Ready resolution={resolution} fields={fields} />
          ) : resolution !== null ? (
            <Blocked resolution={resolution} />
          ) : null}

          <div className="rule-brass checkout-sill" aria-hidden="true" />
        </section>

        <div className="jali-break" aria-hidden="true">
          <div className="jali-band" />
        </div>

        {/* DARBAR. The page closes in the room it is asking you to come to. */}
        <section
          className="section section--darbar grained checkout-close"
          aria-labelledby="checkout-close-title"
        >
          <div className="opener illuminated checkout-close__panel">
            <h2 id="checkout-close-title">A person, at the end of it.</h2>
            <div className="rule-gold rule rule--center" aria-hidden="true" />
            <p className="checkout-close__body">
              Card and UPI are not switched on here yet. Whatever you do on this
              page, someone from the shop rings you, tells you what the piece
              weighs and what it costs, and takes payment the way you would
              rather give it. That is not a stopgap. It is how a ₹4 lakh bridal
              set has always been sold here.
            </p>
            <Link className="button" href="/#visit">
              Book a viewing
            </Link>
          </div>
        </section>
      </main>

      <Colophon />
    </div>
  );
}
