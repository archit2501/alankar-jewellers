/* eslint-disable @next/next/no-html-link-for-pages --
 * Plain anchors. `next/link` prefetches, and a prefetch in an admin is a fully
 * authenticated render of a page nobody opened. See app/admin/layout.tsx.
 */

/**
 * ONE PIECE — /admin/pieces/[sku], AS A CHECKLIST RATHER THAN A FORM.
 *
 * ===========================================================================
 * FOUR VIEWS, ONE ROUTE, AND EACH IS ITS OWN SMALL FORM
 * ===========================================================================
 *   (none)            the checklist, the sections as they stand, and what may
 *                     be done to the piece
 *   ?section=weight   net weight, gross weight, purity — and the ECHO
 *   ?section=price    how it is priced, what it is made of, how it sells
 *   ?section=hallmark the hallmark answer and the certificate
 *
 * Sections are separate views and not accordions, because there is no
 * JavaScript in this panel and because a rejected save then loses only its own
 * section. research/05 §9 is explicit that this is the difference between a
 * form the owner finishes and one they abandon on the first mistake.
 *
 * ===========================================================================
 * THE ECHO IS THE POINT OF THE WEIGHT SECTION
 * ===========================================================================
 * Saving a weight passes through one confirmation that states the figure IN
 * WORDS and IN MONEY, because a factor-of-ten error is invisible in a number
 * field and catastrophic downstream:
 *
 *      18.400 g -> "eighteen grams and four hundred milligrams" -> ₹1,34,762
 *     184.000 g -> "one hundred and eighty-four grams"          -> ₹13,47,620
 *
 * The two share not one word and not one digit group. If no rate is in force
 * the money line is REPLACED by a sentence saying so — never a zero, never
 * yesterday's figure, never a guess.
 *
 * ===========================================================================
 * THE DISABLED CONTROL IS NEVER BARE
 * ===========================================================================
 * research/05 §9: a disabled control with no explanation is the second-most-
 * common reason a non-technical user gives up, after an error message naming a
 * field they cannot see. So the publish control is not rendered disabled at all
 * — when the piece is not ready it is replaced by the sentence that says what
 * to answer and a link to the place to answer it.
 *
 * ===========================================================================
 * NOTHING FROM THE QUERY STRING IS PRINTED VERBATIM
 * ===========================================================================
 * Every value that comes back into a form has been through the same parser the
 * endpoint uses and is re-rendered from the integer it produced. The notice code
 * is looked up in `PIECE_NOTICES`; an unknown code renders nothing.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";

import { formatWhen, readClock, resolveAdmin } from "../../../_admin/data";
import {
  FINENESS_CHOICES,
  PHOTOGRAPHS_BLOCKED,
  PIECE_NOTICES,
  canPublish,
  craftIsHallmarkExempt,
  craftLabel,
  finenessDisplay,
  formatGrams,
  gapsFor,
  goldValuePaise,
  hallmarkAnswered,
  isHallmarkAnswer,
  isMakingChargeType,
  isPieceNotice,
  isPricingMode,
  isSaleMode,
  parseGrams,
  previewPrice,
  readPiece,
  readUsableRatePaise,
  weightInWords,
  type AdminPiece,
  type HallmarkAnswer,
  type MakingChargeType,
  type PieceGap,
  type PricePreview,
  type PricingMode,
  type SaleMode,
} from "../../../_admin/pieces-data";
import { getAdminDb } from "../../../_admin/session";
import { formatPaiseAsRupees } from "../../../_pricing/rates";
import { site } from "../../../site-config";
import "../pieces.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `A piece | ${site.name}`,
  robots: { index: false, follow: false, nocache: true },
};

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function money(paise: number): string {
  return `₹${formatPaiseAsRupees(paise)}`;
}

/** `18.400` — the string a gram field takes, rebuilt from the integer. */
function gramsInput(mg: number | null): string {
  if (mg === null) return "";
  return `${Math.floor(mg / 1000)}.${String(mg % 1000).padStart(3, "0")}`;
}

/** Whole rupees, for a field. Never a float, and never a fraction of a paisa. */
function rupeesInput(paise: number | null): string {
  if (paise === null) return "";
  return paise % 100 === 0
    ? String(paise / 100)
    : `${Math.floor(paise / 100)}.${String(paise % 100).padStart(2, "0")}`;
}

function percentInput(bps: number | null): string {
  return bps === null ? "" : String(bps / 100);
}

/**
 * An integer that this application put into the query string on the way back
 * from a refused save — a paise figure, a basis-point figure, a count.
 *
 * It is re-validated rather than trusted, because a URL can be edited: anything
 * that is not a plain non-negative integer within range is dropped and the row's
 * own value is used instead. Nothing here is ever printed as a string; it is
 * printed as the number it parsed to.
 */
function queryInt(raw: string, max: number): number | null {
  if (raw === "" || !/^\d{1,12}$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function pieceName(piece: AdminPiece): string {
  const name = piece.title.trim();
  return name === "" ? "Untitled" : name;
}

function pieceHref(piece: AdminPiece, section?: string): string {
  const base = `/admin/pieces/${encodeURIComponent(piece.sku)}`;
  return section ? `${base}?section=${section}` : base;
}

/* =========================================================================
 * Chrome
 * ====================================================================== */

function Notice({ code }: { code: string }) {
  if (!isPieceNotice(code)) return null;
  const notice = PIECE_NOTICES[code];
  return (
    <p className={`pcs__notice${notice.problem ? " pcs__notice--problem" : ""}`} role="status">
      {notice.copy}
    </p>
  );
}

function Shell({
  title,
  back,
  backLabel,
  notice,
  children,
}: {
  title: string;
  back: string;
  backLabel: string;
  notice?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="pcs">
      <p>
        <a className="pcs__back" href={back}>
          &larr; {backLabel}
        </a>
      </p>
      <h1 className="pcs__title">{title}</h1>
      {notice === undefined ? null : <Notice code={notice} />}
      {children}
    </div>
  );
}

/** Every section form carries these two, and nothing works without both. */
function FormKeys({ intent, piece, csrf }: { intent: string; piece: AdminPiece; csrf: string }) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="sku" value={piece.sku} />
      {/* Bound to this session and to no other. An origin check alone rests on a
          header the shop does not control. */}
      <input type="hidden" name="csrf" value={csrf} />
    </>
  );
}

/* =========================================================================
 * The price preview
 * ====================================================================== */

/**
 * The consequence, itemised. A wrong weight, a wrong making mode and a wrong
 * purity each become obvious here and nowhere else, which is why this appears on
 * the piece page rather than only on the pricing form.
 */
function Preview({ preview }: { preview: PricePreview }) {
  if (!preview.ok) {
    const copy =
      preview.reason === "on_request"
        ? "The website shows “price on request” for this piece and invites an enquiry. That is a real answer, not a gap. A piece that has not been weighed or has no rate card belongs here."
        : preview.reason === "no_rate"
          ? "There is no gold rate in force just now, so what this piece would cost cannot be worked out. It is not being guessed at, and the website shows “price on request” until there is one."
          : "This piece cannot be priced as it stands. Nothing is being shown rather than a figure that would be wrong.";
    return <p className="pcs__hint">{copy}</p>;
  }

  return (
    <table className="pcs__preview">
      <caption>
        At today&rsquo;s rate this piece would show on the website as {money(preview.totalPaise)},
        including GST.
      </caption>
      {/* The engine's own rows, GST line included. Adding one here would print
          the tax twice and show a total that does not foot. */}
      <tbody>
        {preview.rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{money(row.amountPaise)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row">What the customer pays</th>
          <td>{money(preview.totalPaise)}</td>
        </tr>
      </tfoot>
    </table>
  );
}

/* =========================================================================
 * VIEW — weight and purity
 * ====================================================================== */

function WeightForm({
  piece,
  csrf,
  notice,
  net,
  gross,
  fineness,
}: {
  piece: AdminPiece;
  csrf: string;
  notice: string;
  net: string;
  gross: string;
  fineness: number | null;
}) {
  return (
    <Shell
      title="Weight and purity"
      back={pieceHref(piece)}
      backLabel={pieceName(piece)}
      notice={notice}
    >
      <form method="post" action="/api/admin/pieces">
        <FormKeys intent="save_weight" piece={piece} csrf={csrf} />

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="net-weight">
            Net metal weight
          </label>
          {/* inputmode=decimal, because the wrong keyboard on a weight field is
              how a decimal point goes missing. */}
          <input
            className="pcs__input"
            id="net-weight"
            name="net"
            type="text"
            inputMode="decimal"
            defaultValue={net}
            autoComplete="off"
          />
          <span className="pcs__unit">grams</span>
          <p className="pcs__hint">
            Just the gold, without the stones. Type it the way you weigh it &mdash; 18.4 and
            18.400 both work. Leave it empty if the piece has not been weighed yet.
          </p>
        </div>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="gross-weight">
            Gross weight
          </label>
          <input
            className="pcs__input"
            id="gross-weight"
            name="gross"
            type="text"
            inputMode="decimal"
            defaultValue={gross}
            autoComplete="off"
          />
          <span className="pcs__unit">grams</span>
          <p className="pcs__hint">
            The whole piece, stones included. It is shown to the customer, and it is never used to
            work out the price.
          </p>
        </div>

        <fieldset className="pcs__fieldset">
          <legend>Purity</legend>
          {/* BOTH labels on every pill: Reg. 5(11) requires purity in carat AND
              fineness, and 995 has no carat name at all — which is exactly the
              case a carat-only control gets wrong, by 0.4%, forever. */}
          <div className="pcs__pills">
            {FINENESS_CHOICES.map((value) => (
              <label className="pcs__pill" key={value} htmlFor={`fineness-${value}`}>
                <input
                  type="radio"
                  id={`fineness-${value}`}
                  name="fineness"
                  value={value}
                  defaultChecked={fineness === value}
                />
                <span>{finenessDisplay(value)}</span>
              </label>
            ))}
          </div>
          <p className="pcs__hint">
            Every piece entered here is gold. Silver and platinum need a change to the website
            &mdash; tell whoever looks after it rather than putting one in as gold.
          </p>
        </fieldset>

        <p className="pcs__acts">
          <button className="pcs__btn pcs__btn--primary" type="submit">
            Save the weight
          </button>
        </p>
        <p className="pcs__hint">
          Nothing is saved yet. The next screen reads the weight back to you in words and in
          rupees, so a misplaced decimal point cannot get past.
        </p>
      </form>
    </Shell>
  );
}

/**
 * THE ECHO — the ten-times guard, and the one extra tap in the whole panel.
 *
 * The figure is stated three ways: as a number, as words, and as money. A
 * ten-times error survives none of them.
 */
function WeightEcho({
  piece,
  csrf,
  net,
  gross,
  fineness,
  ratePerTenGramsPaise,
}: {
  piece: AdminPiece;
  csrf: string;
  net: number | null;
  gross: number | null;
  fineness: number | null;
  ratePerTenGramsPaise: number | null;
}) {
  const goldPaise =
    net === null || fineness === null || ratePerTenGramsPaise === null
      ? null
      : goldValuePaise(net, fineness, ratePerTenGramsPaise);

  const backToForm = `${pieceHref(piece, "weight")}&net=${encodeURIComponent(
    gramsInput(net)
  )}&gross=${encodeURIComponent(gramsInput(gross))}${
    fineness === null ? "" : `&fineness=${fineness}`
  }`;

  return (
    <Shell
      title={net === null ? "Remove the weight?" : `Save ${formatGrams(net)}?`}
      back={pieceHref(piece)}
      backLabel={pieceName(piece)}
    >
      <div className="pcs__echo">
        {net === null ? (
          <p className="pcs__echowords">
            This takes the net metal weight off the piece. It goes back to being one the website
            shows at &ldquo;price on request&rdquo;.
          </p>
        ) : (
          <>
            {/* IN WORDS. 18.400 and 184.00 look alike in a box and share not one
                word here. */}
            <p className="pcs__echowords">That is {weightInWords(net)}.</p>

            {goldPaise === null ? (
              /* NEVER A ZERO AND NEVER A GUESS. */
              <p className="pcs__echomoney">
                {fineness === null
                  ? "No purity has been chosen, so this cannot be shown in rupees."
                  : "There is no gold rate in force just now, so this cannot be shown in rupees."}
              </p>
            ) : (
              <p className="pcs__echomoney">
                At today&rsquo;s {fineness} rate that is {money(goldPaise)} of gold in this piece.
              </p>
            )}
          </>
        )}

        {gross === null ? null : (
          <p className="pcs__hint">Gross weight, stones included: {formatGrams(gross)}.</p>
        )}
      </div>

      <form method="post" action="/api/admin/pieces">
        <FormKeys intent="save_weight" piece={piece} csrf={csrf} />
        <input type="hidden" name="confirm" value="yes" />
        <input type="hidden" name="net" value={gramsInput(net)} />
        <input type="hidden" name="gross" value={gramsInput(gross)} />
        <input type="hidden" name="fineness" value={fineness === null ? "" : String(fineness)} />
        <p className="pcs__acts">
          <button className="pcs__btn pcs__btn--primary" type="submit">
            Yes, save it
          </button>
        </p>
      </form>

      <p>
        <a className="pcs__link" href={backToForm}>
          Go back and change it
        </a>
      </p>
    </Shell>
  );
}

/* =========================================================================
 * VIEW — price
 * ====================================================================== */

function PriceForm({
  piece,
  csrf,
  notice,
  preview,
  values,
}: {
  piece: AdminPiece;
  csrf: string;
  notice: string;
  preview: PricePreview;
  values: {
    pricingMode: PricingMode;
    makingChargeType: MakingChargeType | null;
    making: string;
    stones: string;
    other: string;
    fixed: string;
    unique: boolean;
    stock: string;
    saleMode: SaleMode;
  };
}) {
  const weighed = piece.netMetalWeightMg !== null && piece.fineness !== null;

  return (
    <Shell
      title="How it is priced"
      back={pieceHref(piece)}
      backLabel={pieceName(piece)}
      notice={notice}
    >
      {weighed ? null : (
        /* Said BEFORE the choice rather than after a refusal. This is what turns
           `variants_pricing_inputs_ck` from a wall into a sequence: the owner is
           told which option needs what, in advance, and the safe option has no
           precondition at all. */
        <p className="pcs__hint">
          This piece has no weight and no purity yet, so it cannot be priced by weight.{" "}
          <a className="pcs__link" href={pieceHref(piece, "weight")}>
            Add its weight and purity
          </a>{" "}
          first, or leave it at price on request &mdash; which is a real answer and the website
          says so plainly.
        </p>
      )}

      <form method="post" action="/api/admin/pieces">
        <FormKeys intent="save_pricing" piece={piece} csrf={csrf} />

        <fieldset className="pcs__fieldset">
          <legend>How is this piece priced?</legend>

          <label className="pcs__choice" htmlFor="mode-dynamic">
            <input
              type="radio"
              id="mode-dynamic"
              name="pricingMode"
              value="dynamic_metal"
              defaultChecked={values.pricingMode === "dynamic_metal"}
            />
            <span className="pcs__choicebody">
              By weight, at the day&rsquo;s gold rate
              <span className="pcs__choicewhy">
                Needs a net metal weight and a purity. The price moves with the rate, which is
                what a customer expects of gold.
              </span>
            </span>
          </label>

          <label className="pcs__choice" htmlFor="mode-fixed">
            <input
              type="radio"
              id="mode-fixed"
              name="pricingMode"
              value="fixed"
              defaultChecked={values.pricingMode === "fixed"}
            />
            <span className="pcs__choicebody">
              A fixed price
              <span className="pcs__choicewhy">
                For an antique or a Polki set quoted flat. It does not move with the rate.
              </span>
            </span>
          </label>

          <label className="pcs__choice" htmlFor="mode-request">
            <input
              type="radio"
              id="mode-request"
              name="pricingMode"
              value="on_request"
              defaultChecked={values.pricingMode === "on_request"}
            />
            <span className="pcs__choicebody">
              Price on request
              <span className="pcs__choicewhy">
                The website shows no figure and invites an enquiry. This one always works,
                whatever else is missing.
              </span>
            </span>
          </label>
        </fieldset>

        {/* Every input below is enabled, because without JavaScript nothing can
            disable one when the mode changes — and a field that only LOOKS
            disabled is worse than one that plainly is not. The guarantee is kept
            on the server instead: `savePricing()` reads only the fields the
            chosen mode uses and drops the rest, which no edit to this markup can
            defeat. */}
        <fieldset className="pcs__fieldset">
          <legend>If it is priced by weight</legend>

          <label className="pcs__choice" htmlFor="making-percent">
            <input
              type="radio"
              id="making-percent"
              name="makingChargeType"
              value="percent"
              defaultChecked={values.makingChargeType === "percent"}
            />
            <span className="pcs__choicebody">A percentage of the gold value</span>
          </label>
          <label className="pcs__choice" htmlFor="making-per-gram">
            <input
              type="radio"
              id="making-per-gram"
              name="makingChargeType"
              value="per_gram"
              defaultChecked={values.makingChargeType === "per_gram"}
            />
            <span className="pcs__choicebody">So much for each gram</span>
          </label>
          <label className="pcs__choice" htmlFor="making-flat">
            <input
              type="radio"
              id="making-flat"
              name="makingChargeType"
              value="flat"
              defaultChecked={values.makingChargeType === "flat"}
            />
            <span className="pcs__choicebody">One flat amount</span>
          </label>

          <div className="pcs__field">
            <label className="pcs__label" htmlFor="making-value">
              The making charge
            </label>
            <input
              className="pcs__input"
              id="making-value"
              name="makingCharge"
              type="text"
              inputMode="decimal"
              defaultValue={values.making}
              autoComplete="off"
            />
            <span className="pcs__unit">
              {values.makingChargeType === "percent"
                ? "per cent of the gold value"
                : values.makingChargeType === "per_gram"
                  ? "rupees for each gram"
                  : "rupees"}
            </span>
            <p className="pcs__hint">
              One box, and what it means is decided by the choice above it. There is no field here
              called &ldquo;value&rdquo;, because the same number means three different things in
              the three modes.
            </p>
          </div>
        </fieldset>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="fixed-price">
            If it is a fixed price
          </label>
          <input
            className="pcs__input"
            id="fixed-price"
            name="fixed"
            type="text"
            inputMode="decimal"
            defaultValue={values.fixed}
            autoComplete="off"
          />
          <span className="pcs__unit">rupees, before GST</span>
        </div>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="stones">
            Stones
          </label>
          <input
            className="pcs__input"
            id="stones"
            name="stones"
            type="text"
            inputMode="decimal"
            defaultValue={values.stones}
            autoComplete="off"
          />
          <span className="pcs__unit">rupees</span>
        </div>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="other">
            Anything else charged for
          </label>
          <input
            className="pcs__input"
            id="other"
            name="other"
            type="text"
            inputMode="decimal"
            defaultValue={values.other}
            autoComplete="off"
          />
          <span className="pcs__unit">rupees</span>
          <p className="pcs__hint">
            The hallmarking charge is not here. It is set by the answer under &ldquo;Hallmark and
            certificate&rdquo;, because it follows from whether the piece has to be hallmarked at
            all.
          </p>
        </div>

        <fieldset className="pcs__fieldset">
          <legend>How many are there?</legend>
          <label className="pcs__choice" htmlFor="unique-yes">
            <input
              type="radio"
              id="unique-yes"
              name="unique"
              value="yes"
              defaultChecked={values.unique}
            />
            <span className="pcs__choicebody">
              Just the one. It is one of a kind
              <span className="pcs__choicewhy">
                The website will not let it be bought twice, and the database refuses a stock of
                two on a one-of-a-kind piece.
              </span>
            </span>
          </label>
          <label className="pcs__choice" htmlFor="unique-no">
            <input
              type="radio"
              id="unique-no"
              name="unique"
              value="no"
              defaultChecked={!values.unique}
            />
            <span className="pcs__choicebody">There is more than one</span>
          </label>

          <div className="pcs__field">
            <label className="pcs__label" htmlFor="stock">
              How many in stock
            </label>
            <input
              className="pcs__input"
              id="stock"
              name="stock"
              type="text"
              inputMode="numeric"
              defaultValue={values.stock}
              autoComplete="off"
            />
          </div>
        </fieldset>

        <fieldset className="pcs__fieldset">
          <legend>How is it sold?</legend>
          <label className="pcs__choice" htmlFor="sale-enquire">
            <input
              type="radio"
              id="sale-enquire"
              name="saleMode"
              value="enquire_only"
              defaultChecked={values.saleMode === "enquire_only"}
            />
            <span className="pcs__choicebody">They ask about it first</span>
          </label>
          <label className="pcs__choice" htmlFor="sale-appointment">
            <input
              type="radio"
              id="sale-appointment"
              name="saleMode"
              value="appointment_only"
              defaultChecked={values.saleMode === "appointment_only"}
            />
            <span className="pcs__choicebody">Only through a private viewing</span>
          </label>
          <label className="pcs__choice" htmlFor="sale-online">
            <input
              type="radio"
              id="sale-online"
              name="saleMode"
              value="buy_online"
              defaultChecked={values.saleMode === "buy_online"}
            />
            <span className="pcs__choicebody">
              They can buy it on the website
              <span className="pcs__choicewhy">
                Needs a price. Card and UPI are switched off, so an order is a reservation and the
                money is settled at the counter &mdash; every screen says so.
              </span>
            </span>
          </label>
        </fieldset>

        <p className="pcs__acts">
          <button className="pcs__btn pcs__btn--primary" type="submit">
            Save
          </button>
        </p>
      </form>

      <section className="pcs__section" aria-labelledby="price-now">
        <h2 className="pcs__label" id="price-now">
          As it stands
        </h2>
        <Preview preview={preview} />
      </section>
    </Shell>
  );
}

/* =========================================================================
 * VIEW — hallmark and certificate
 * ====================================================================== */

function HallmarkForm({
  piece,
  csrf,
  notice,
  answer,
}: {
  piece: AdminPiece;
  csrf: string;
  notice: string;
  answer: HallmarkAnswer | null;
}) {
  const exemptCraft = craftIsHallmarkExempt(piece.craft);

  return (
    <Shell
      title="Hallmark and certificate"
      back={pieceHref(piece)}
      backLabel={pieceName(piece)}
      notice={notice}
    >
      {/* The rule, stated once, before anything is asked. */}
      <p className="pcs__lede">
        Nothing on this screen is filled in for you and nothing is worked out from anything else.
        A hallmark number is issued by BIS against a physical piece, so the only way it can be
        right is if it is read off the piece and typed in.
      </p>

      <form method="post" action="/api/admin/pieces">
        <FormKeys intent="save_hallmark" piece={piece} csrf={csrf} />

        <fieldset className="pcs__fieldset">
          <legend>Does this piece carry a hallmark?</legend>

          {/* NOT PRE-SELECTED, even for a craft that is exempt as a category.
              Whether a particular article was hallmarked is a fact about that
              article, and the shop may well have had a Polki set hallmarked
              voluntarily. The law is printed beside the choice; it does not make
              the choice. */}
          <label className="pcs__choice" htmlFor="answer-exempt">
            <input
              type="radio"
              id="answer-exempt"
              name="answer"
              value="exempt"
              defaultChecked={answer === "exempt"}
            />
            <span className="pcs__choicebody">
              No, it does not have to be
              <span className="pcs__choicewhy">
                Kundan, Polki and Jadau are outside mandatory hallmarking (QCO cl. 2(3)).
                {exemptCraft
                  ? ` This piece is entered as ${craftLabel(piece.craft)}, so that exemption covers it, but only you can say whether it was hallmarked anyway.`
                  : ` This piece is entered as ${craftLabel(piece.craft)}, which is not one of those, so choose this only if you know it applies.`}{" "}
                No hallmarking charge is raised, and the website says the piece is exempt rather
                than leaving a blank.
              </span>
            </span>
          </label>

          <label className="pcs__choice" htmlFor="answer-recorded">
            <input
              type="radio"
              id="answer-recorded"
              name="answer"
              value="recorded"
              defaultChecked={answer === "recorded"}
            />
            <span className="pcs__choicebody">
              Yes, and the number is below
              <span className="pcs__choicewhy">
                Type it exactly as it reads on the piece.
              </span>
            </span>
          </label>

          <label className="pcs__choice" htmlFor="answer-later">
            <input
              type="radio"
              id="answer-later"
              name="answer"
              value="not_to_hand"
              defaultChecked={answer === "not_to_hand"}
            />
            <span className="pcs__choicebody">
              Yes, but the number is not to hand
              <span className="pcs__choicewhy">
                Perfectly normal, and the honest answer. The piece stays off the website until the
                number turns up, because a hallmarking charge with no number against it is the one
                thing a bill must never carry.
              </span>
            </span>
          </label>
        </fieldset>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="huid">
            Hallmark number (HUID)
          </label>
          {/* No placeholder that looks like a number, no autocomplete, no
              pattern that would let a browser offer one. An empty box is stored
              as nothing at all, never as an empty number. */}
          <input
            className="pcs__input"
            id="huid"
            name="huid"
            type="text"
            maxLength={32}
            defaultValue=""
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
          />
          <p className="pcs__hint">
            Six characters, stamped on the piece beside the BIS mark. Leave it empty if it is not
            in front of you &mdash; it will be recorded as not on file, which is the truth.
          </p>
        </div>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="purity-mark">
            The purity mark on the piece
          </label>
          <input
            className="pcs__input"
            id="purity-mark"
            name="purityMark"
            type="text"
            maxLength={32}
            defaultValue=""
            autoComplete="off"
            spellCheck={false}
          />
          <p className="pcs__hint">
            What is actually stamped, such as 22K916. It is not worked out from the purity you
            chose earlier, because the stamp is a fact about the piece and the purity is what the
            shop recorded.
          </p>
        </div>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="certificate">
            Certificate number
          </label>
          <input
            className="pcs__input"
            id="certificate"
            name="certificateNumber"
            type="text"
            maxLength={64}
            defaultValue=""
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="lab">
            Who certified it
          </label>
          <input
            className="pcs__input"
            id="lab"
            name="certificateLab"
            type="text"
            maxLength={32}
            defaultValue=""
            autoComplete="off"
            placeholder=""
          />
          <p className="pcs__hint">IGI, GIA, SGL &mdash; whichever is on the certificate.</p>
        </div>

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="hallmark-charge">
            Hallmarking charge
          </label>
          <input
            className="pcs__input"
            id="hallmark-charge"
            name="charge"
            type="text"
            inputMode="decimal"
            defaultValue={
              piece.hallmarkingPaise === 0 ? "" : rupeesInput(piece.hallmarkingPaise)
            }
            autoComplete="off"
          />
          <span className="pcs__unit">rupees</span>
          <p className="pcs__hint">
            ₹45 is the BIS charge for a gold article. It appears on the bill as its own line
            because the hallmarking regulations require it separately, and it is set to nothing
            automatically if you say the piece is exempt.
          </p>
        </div>

        <p className="pcs__acts">
          <button className="pcs__btn pcs__btn--primary" type="submit">
            Save
          </button>
        </p>
      </form>

      <p className="pcs__hint">
        What is on record now:{" "}
        {piece.huid === null
          ? "no hallmark number."
          : `hallmark number ${piece.huid}.`}{" "}
        {piece.certificateNumber === null
          ? "No certificate."
          : `Certificate ${piece.certificateNumber}${
              piece.certificateLab === null ? "" : `, ${piece.certificateLab}`
            }.`}
      </p>
    </Shell>
  );
}

/* =========================================================================
 * VIEW — the piece itself
 * ====================================================================== */

function Checklist({ piece, gaps }: { piece: AdminPiece; gaps: readonly PieceGap[] }) {
  return (
    <div className="pcs__check">
      <h2 className="pcs__label">Before it can go on the website</h2>
      <ul className="pcs__checklist">
        <li className="pcs__checkrow">
          <span className="pcs__tick" aria-hidden="true">
            &#10003;
          </span>
          <span className="pcs__checkword">A name and a kind</span>
          <span className="pcs__mono">done</span>
        </li>
        {gaps.map((gap) => (
          <li className="pcs__checkrow" key={gap.id}>
            <span className={gap.done ? "pcs__tick" : "pcs__dot"} aria-hidden="true">
              {gap.done ? "✓" : "·"}
            </span>
            <span className="pcs__checkword">{gap.label}</span>
            {gap.done ? (
              <span className="pcs__mono">done</span>
            ) : gap.section === null ? (
              <span className="pcs__mono">not possible yet</span>
            ) : (
              <a className="pcs__link" href={pieceHref(piece, gap.section)}>
                Add
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StatusForm({
  piece,
  csrf,
  intent,
  label,
  primary,
}: {
  piece: AdminPiece;
  csrf: string;
  intent: string;
  label: string;
  primary?: boolean;
}) {
  return (
    <form method="post" action="/api/admin/pieces">
      <FormKeys intent={intent} piece={piece} csrf={csrf} />
      <button className={`pcs__btn${primary ? " pcs__btn--primary" : ""}`} type="submit">
        {label}
      </button>
    </form>
  );
}

function PiecePage({
  piece,
  csrf,
  notice,
  nowMs,
  preview,
}: {
  piece: AdminPiece;
  csrf: string;
  notice: string;
  nowMs: number;
  preview: PricePreview;
}) {
  const gaps = gapsFor(piece);
  const ready = canPublish(piece);
  const weighed = piece.netMetalWeightMg !== null && piece.fineness !== null;

  const statusWord =
    piece.status === "active"
      ? "On the website"
      : piece.status === "archived"
        ? "Put away"
        : "Draft";

  return (
    <div className="pcs">
      <p>
        <a className="pcs__back" href="/admin/pieces">
          &larr; Pieces
        </a>
      </p>

      <Notice code={notice} />

      <h1 className="pcs__title">{pieceName(piece)}</h1>
      <p className="pcs__what">
        {statusWord}
        {piece.status === "active"
          ? ", and it will not actually appear there until it has a photograph."
          : piece.status === "archived"
            ? ", off the website and out of the working list."
            : ". This is not on the website."}
      </p>
      <p className="pcs__mono">
        {piece.sku} · {craftLabel(piece.craft)} · Started{" "}
        <time dateTime={piece.createdAt}>{formatWhen(piece.createdAt, nowMs)}</time>
      </p>

      <div className="pcs__columns">
        <div>
          {/* --- Photographs ------------------------------------------------ */}
          <section className="pcs__section" aria-labelledby="photographs">
            <h2 className="pcs__label" id="photographs">
              Photographs
            </h2>
            {/* Where the upload control would be. A sentence rather than a
                broken button, because a control that can never succeed teaches
                the owner that the panel is broken. */}
            <p className="pcs__blocked">{PHOTOGRAPHS_BLOCKED}</p>
          </section>

          {/* --- Weight ----------------------------------------------------- */}
          <section className="pcs__section" aria-labelledby="weight">
            <div className="pcs__sectionhead">
              <h2 className="pcs__label" id="weight">
                Weight and purity
              </h2>
              <a className="pcs__link" href={pieceHref(piece, "weight")}>
                {weighed ? "Change" : "Add"}
              </a>
            </div>
            {weighed ? (
              <>
                <p className="pcs__what">
                  Net metal {formatGrams(piece.netMetalWeightMg ?? 0)} ·{" "}
                  {finenessDisplay(piece.fineness ?? 0)}
                </p>
                {piece.grossWeightMg === null ? (
                  <p className="pcs__hint">No gross weight recorded.</p>
                ) : (
                  <p className="pcs__hint">
                    Gross, stones included: {formatGrams(piece.grossWeightMg)}.
                  </p>
                )}
              </>
            ) : (
              <p className="pcs__what">Not entered yet.</p>
            )}
          </section>

          {/* --- Price ------------------------------------------------------ */}
          <section className="pcs__section" aria-labelledby="price">
            <div className="pcs__sectionhead">
              <h2 className="pcs__label" id="price">
                Price
              </h2>
              <a className="pcs__link" href={pieceHref(piece, "price")}>
                {piece.pricingMode === "on_request" ? "Add" : "Change"}
              </a>
            </div>
            <Preview preview={preview} />
          </section>

          {/* --- Hallmark --------------------------------------------------- */}
          <section className="pcs__section" aria-labelledby="hallmark">
            <div className="pcs__sectionhead">
              <h2 className="pcs__label" id="hallmark">
                Hallmark and certificate
              </h2>
              <a className="pcs__link" href={pieceHref(piece, "hallmark")}>
                {hallmarkAnswered(piece) ? "Change" : "Add"}
              </a>
            </div>
            {/* THE ABSENCE IS EXPLAINED, NEVER BLANK — the same three sentences
                the bill on the order page uses, so the two screens cannot come
                to describe one piece two different ways. */}
            {piece.huid !== null ? (
              <p className="pcs__what">Hallmark number {piece.huid}.</p>
            ) : piece.hallmarkingPaise === 0 ? (
              <p className="pcs__what">
                Not hallmarked, and it does not have to be &mdash; Kundan, Polki and Jadau are
                exempt under QCO cl. 2(3). No hallmarking charge is raised on it.
              </p>
            ) : (
              <p className="pcs__what pcs__alert">
                A hallmarking charge is set on this piece and no number is on record against it.
                Say which is true before it goes on the website.
              </p>
            )}
            {piece.certificateNumber === null ? (
              <p className="pcs__hint">No certificate is on record.</p>
            ) : (
              <p className="pcs__hint">
                Certificate {piece.certificateNumber}
                {piece.certificateLab === null ? "" : `, ${piece.certificateLab}`}.
              </p>
            )}
          </section>
        </div>

        <Checklist piece={piece} gaps={gaps} />
      </div>

      {/* --- What may be done to it ---------------------------------------- */}
      <section className="pcs__section" aria-labelledby="do-now">
        <h2 className="pcs__label" id="do-now">
          What to do now
        </h2>

        <div className="pcs__acts">
          {piece.status !== "active" && ready ? (
            <StatusForm
              piece={piece}
              csrf={csrf}
              intent="publish"
              label="Put this piece on the website"
              primary
            />
          ) : null}
          {piece.status === "active" ? (
            <StatusForm
              piece={piece}
              csrf={csrf}
              intent="unpublish"
              label="Take it off the website"
            />
          ) : null}
          {piece.status === "archived" ? (
            <StatusForm piece={piece} csrf={csrf} intent="bring_back" label="Bring it back" />
          ) : (
            <StatusForm piece={piece} csrf={csrf} intent="put_away" label="Put this piece away" />
          )}
        </div>

        {/* THE MISSING CONTROL IS EXPLAINED RATHER THAN DISABLED. */}
        {piece.status !== "active" && !ready ? (
          <p className="pcs__blocked">
            This piece cannot go on the website yet. The hallmark question has not been answered
            &mdash; say either the piece&rsquo;s hallmark number or that it is exempt, and the
            control appears here.{" "}
            <a className="pcs__link" href={pieceHref(piece, "hallmark")}>
              Answer it now
            </a>
            .
          </p>
        ) : null}

        {piece.status !== "active" && ready ? (
          <p className="pcs__hint">
            Putting it on the website marks it as one the shop wants listed. It will not appear
            until it has a photograph, and photographs cannot be added yet &mdash; that is stated
            above rather than discovered later.
          </p>
        ) : null}
      </section>

      <p className="pcs__hint">
        Putting a piece away never deletes it. There is no delete anywhere on this screen: a piece
        that has been sold is part of how that order is read back years later, so it is kept and
        taken out of the working list instead.
      </p>
    </div>
  );
}

/* =========================================================================
 * The route
 * ====================================================================== */

export default async function AdminPiecePage({
  params,
  searchParams,
}: {
  params: Promise<{ sku: string }>;
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
      <Shell title="Sign in to see this piece" back="/admin/pieces" backLabel="Pieces">
        <p className="pcs__lede">
          This session has ended, so nothing is shown. Signing in again brings the piece back
          exactly as it was.
        </p>
      </Shell>
    );
  }

  const { sku } = await params;
  const query = await searchParams;
  const notice = first(query.notice);
  const csrf = current.identity.csrfToken;

  let piece: AdminPiece | null;
  let db;
  try {
    db = getAdminDb();
    // The router has already decoded the segment. Decoding again would let a
    // doubly-encoded handle become a different one, and `isUsableSku()` inside
    // the reader is what decides whether it is queried at all.
    piece = await readPiece(db, sku);
  } catch (error) {
    console.error("[admin-piece] the catalogue could not be read:", error);
    return (
      <Shell title="Pieces" back="/admin/pieces" backLabel="Pieces">
        <p className="pcs__notice pcs__notice--problem">
          The catalogue could not be read just now, so nothing is shown. This is the
          website&rsquo;s own problem and not a sign that the piece is missing.
        </p>
      </Shell>
    );
  }

  if (piece === null) {
    return (
      <Shell title="No piece with that number" back="/admin/pieces" backLabel="Pieces">
        <p className="pcs__lede">
          Nothing in the catalogue has that number. Go back to the list and open it from there
          &mdash; the number is printed under every piece&rsquo;s name.
        </p>
      </Shell>
    );
  }

  const section = first(query.section);

  /* --- Weight, and the echo -------------------------------------------- */
  if (section === "weight") {
    // Everything below is re-parsed through the SAME parser the endpoint uses,
    // so what is rendered is what would be stored — and nothing typed reaches
    // the page as a string.
    const netParsed = parseGrams(first(query.net));
    const grossParsed = parseGrams(first(query.gross));
    const finenessRaw = Number(first(query.fineness));
    const queriedFineness = Number.isInteger(finenessRaw) ? finenessRaw : null;

    const net = netParsed.ok ? netParsed.value : null;
    const gross = grossParsed.ok ? grossParsed.value : null;

    if (first(query.confirm) === "1") {
      const rate = await readUsableRatePaise(db, queriedFineness, nowMs);
      return (
        <WeightEcho
          piece={piece}
          csrf={csrf}
          net={net}
          gross={gross}
          fineness={queriedFineness}
          ratePerTenGramsPaise={rate}
        />
      );
    }

    return (
      <WeightForm
        piece={piece}
        csrf={csrf}
        notice={notice}
        net={first(query.net) === "" ? gramsInput(piece.netMetalWeightMg) : gramsInput(net)}
        gross={first(query.gross) === "" ? gramsInput(piece.grossWeightMg) : gramsInput(gross)}
        fineness={queriedFineness ?? piece.fineness}
      />
    );
  }

  /* --- Price ------------------------------------------------------------ */
  if (section === "price") {
    const queriedMode = first(query.pricingMode);
    const pricingMode: PricingMode = isPricingMode(queriedMode) ? queriedMode : piece.pricingMode;

    const queriedMaking = first(query.makingChargeType);
    const makingChargeType: MakingChargeType | null = isMakingChargeType(queriedMaking)
      ? queriedMaking
      : queriedMode === ""
        ? piece.makingChargeType
        : null;

    const queriedSale = first(query.saleMode);
    const saleMode: SaleMode = isSaleMode(queriedSale) ? queriedSale : piece.saleMode;

    /* A refused save comes back with everything that was typed, re-serialised
       from integers by the endpoint. Each one is re-validated here and falls
       back to the row's own value, so an edited URL can put nothing into this
       form that the row could not already hold. */
    const making = queryInt(first(query.making), 1_000_000_000) ?? piece.makingChargeValue;
    const stones = queryInt(first(query.stones), 1_000_000_000) ?? piece.stoneValuePaise;
    const other = queryInt(first(query.other), 1_000_000_000) ?? piece.otherChargesPaise;
    const fixed = queryInt(first(query.fixed), 1_000_000_000) ?? piece.fixedPricePaise;
    const stock = queryInt(first(query.stock), 9999) ?? piece.stockQuantity;
    const unique = first(query.unique) === "" ? piece.isUniquePiece : first(query.unique) !== "no";

    const rate = await readUsableRatePaise(db, piece.fineness, nowMs);

    return (
      <PriceForm
        piece={piece}
        csrf={csrf}
        notice={notice}
        preview={previewPrice(piece, rate)}
        values={{
          pricingMode,
          makingChargeType,
          making:
            makingChargeType === "percent" ? percentInput(making) : rupeesInput(making),
          stones: rupeesInput(stones),
          other: rupeesInput(other),
          fixed: rupeesInput(fixed),
          unique,
          stock: String(stock),
          saleMode,
        }}
      />
    );
  }

  /* --- Hallmark --------------------------------------------------------- */
  if (section === "hallmark") {
    const queried = first(query.answer);
    return (
      <HallmarkForm
        piece={piece}
        csrf={csrf}
        notice={notice}
        answer={isHallmarkAnswer(queried) ? queried : null}
      />
    );
  }

  /* --- The piece -------------------------------------------------------- */
  const rate = await readUsableRatePaise(db, piece.fineness, nowMs);
  return (
    <PiecePage
      piece={piece}
      csrf={csrf}
      notice={notice}
      nowMs={nowMs}
      preview={previewPrice(piece, rate)}
    />
  );
}
