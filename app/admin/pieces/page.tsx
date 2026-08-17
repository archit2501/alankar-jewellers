/* eslint-disable @next/next/no-html-link-for-pages --
 * Plain anchors, for the reason app/admin/layout.tsx gives at length:
 * `next/link` prefetches, and in here a prefetch is a fully authenticated
 * render of a page nobody opened. On this screen that is cheap; the rule is
 * kept anyway, because one prefetching link in an admin is how the habit comes
 * back to the screens where it is not cheap.
 */

/**
 * THE PIECES LIST, AND THE TWO FIELDS THAT START ONE — /admin/pieces.
 *
 * ===========================================================================
 * THE LIST IS GROUPED BY WHAT THE OWNER CAN DO ABOUT IT
 * ===========================================================================
 * Not finished · On the website · Put away. Drafts come first because a draft
 * is the only group with work in it, and every draft row carries "Still needs:"
 * — research/05 §9 calls that "the whole safety mechanism made visible from the
 * list", and it is: the owner never has to open a piece to find out what is
 * missing from it.
 *
 * ===========================================================================
 * "ADD A PIECE" IS A VIEW OF THIS PAGE, NOT A ROUTE OF ITS OWN
 * ===========================================================================
 * `/admin/pieces/new` would be matched by `[sku]` and would have to be special-
 * cased inside the piece page, where a real SKU that happened to read "new"
 * would then be unreachable. `?add=1` cannot collide with anything, and it
 * renders its own single `<h1>` — so the one-h1 rule holds on both views.
 *
 * ===========================================================================
 * NOTHING FROM THE QUERY STRING IS PRINTED
 * ===========================================================================
 * The notice code is looked up in `PIECE_NOTICES` and the COPY comes from
 * there, exactly as `CHECKOUT_NOTICES` does it on the storefront. An unknown
 * code renders nothing at all.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";

import { formatWhen, readClock, resolveAdmin } from "../../_admin/data";
import {
  CRAFTS,
  PHOTOGRAPHS_BLOCKED,
  PIECE_NOTICES,
  isPieceNotice,
  listPieces,
  stillNeeds,
  type AdminPiece,
} from "../../_admin/pieces-data";
import { getAdminDb } from "../../_admin/session";
import { site } from "../../site-config";
import "./pieces.css";

/** Keyed on one admin's cookie. There is nothing here that may be cached. */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Pieces | ${site.name}`,
  robots: { index: false, follow: false, nocache: true },
};

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/* =========================================================================
 * Chrome
 * ====================================================================== */

function Notice({ code }: { code: string }) {
  if (!isPieceNotice(code)) return null;
  const notice = PIECE_NOTICES[code];
  return (
    <p
      className={`pcs__notice${notice.problem ? " pcs__notice--problem" : ""}`}
      role="status"
    >
      {notice.copy}
    </p>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pcs">
      <h1 className="pcs__title">{title}</h1>
      {children}
    </div>
  );
}

/* =========================================================================
 * A row
 * ====================================================================== */

function Row({ piece, nowMs }: { piece: AdminPiece; nowMs: number }) {
  const needs = stillNeeds(piece);
  const name = piece.title.trim();

  return (
    <li className="pcs__row">
      <h3 className="pcs__name">
        <a href={`/admin/pieces/${encodeURIComponent(piece.sku)}`}>
          {name === "" ? <span className="pcs__name--none">Untitled</span> : name}
        </a>
      </h3>
      <p className="pcs__what">
        Started <time dateTime={piece.createdAt}>{formatWhen(piece.createdAt, nowMs)}</time>
      </p>
      <p className="pcs__mono">{piece.sku}</p>
      {needs.length === 0 ? null : (
        /* The sentence that means the owner never has to open a draft to find
           out what is left. It names the things, in the order the sections sit
           on the piece's own page. */
        <p className="pcs__needs">Still needs: {needs.join(", ")}.</p>
      )}
    </li>
  );
}

function Group({
  heading,
  empty,
  pieces,
  nowMs,
}: {
  heading: string;
  empty: string;
  pieces: readonly AdminPiece[];
  nowMs: number;
}) {
  return (
    <section className="pcs__group">
      {/* One interpolation, not three: React splits adjacent text nodes with
          comment markers in server-rendered HTML, and a heading that reads
          `Put away<!-- --> (<!-- -->1<!-- -->)` is one nothing can match. */}
      <h2 className="pcs__grouphead">{`${heading} (${pieces.length})`}</h2>
      {pieces.length === 0 ? (
        <p className="pcs__lede">{empty}</p>
      ) : (
        <ol className="pcs__list">
          {pieces.map((piece) => (
            <Row key={piece.variantId} piece={piece} nowMs={nowMs} />
          ))}
        </ol>
      )}
    </section>
  );
}

/* =========================================================================
 * Add a piece — step one, and there is no step two on this screen
 * ====================================================================== */

function AddPiece({ csrf, notice }: { csrf: string; notice: string }) {
  return (
    <div className="pcs">
      <p>
        <a className="pcs__back" href="/admin/pieces">
          &larr; Pieces
        </a>
      </p>

      <h1 className="pcs__title">Add a piece</h1>
      <Notice code={notice} />

      <form method="post" action="/api/admin/pieces">
        <input type="hidden" name="intent" value="create" />
        {/* Bound to this session and to no other. An origin check alone rests on
            a header the shop does not control. */}
        <input type="hidden" name="csrf" value={csrf} />

        <div className="pcs__field">
          <label className="pcs__label" htmlFor="piece-title">
            What is it?
          </label>
          <input
            className="pcs__input pcs__input--text"
            id="piece-title"
            name="title"
            type="text"
            maxLength={120}
            required
            autoComplete="off"
            autoCapitalize="words"
          />
          <p className="pcs__hint">The name a customer will see. It can be changed later.</p>
        </div>

        <fieldset className="pcs__fieldset">
          <legend>What kind?</legend>
          <div className="pcs__pills">
            {CRAFTS.map((craft, index) => (
              <label className="pcs__pill" key={craft.value} htmlFor={`craft-${craft.value}`}>
                <input
                  type="radio"
                  id={`craft-${craft.value}`}
                  name="craft"
                  value={craft.value}
                  defaultChecked={index === 0}
                  required
                />
                <span>{craft.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <p className="pcs__acts">
          <button className="pcs__btn pcs__btn--primary" type="submit">
            Start this piece
          </button>
        </p>
      </form>

      {/* Said before it is needed, because the thing that stops people starting
          is not knowing whether they have to finish. */}
      <p className="pcs__hint">
        It saves straight away as a draft. Nothing goes on the website until you put it there,
        and you can leave it and come back to it whenever you like, the weight, the price
        and the hallmark are each their own small step afterwards.
      </p>
    </div>
  );
}

/* =========================================================================
 * The page
 * ====================================================================== */

export default async function AdminPiecesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const nowMs = readClock();
  const inbound = await headers();

  // The layout has already refused an anonymous request, and this asks again.
  // Both, always: a page that trusts its layout is trusting a file it does not
  // import.
  const current = await resolveAdmin({
    cookie: inbound.get("cookie"),
    ip: inbound.get("cf-connecting-ip"),
    userAgent: inbound.get("user-agent"),
  });

  if (current === null) {
    return (
      <Shell title="Sign in to see the pieces">
        <p className="pcs__lede">
          This session has ended, so nothing is shown. Signing in again brings the catalogue back
          exactly as it was.
        </p>
      </Shell>
    );
  }

  const params = await searchParams;
  const notice = first(params.notice);

  if (first(params.add) === "1") {
    return <AddPiece csrf={current.identity.csrfToken} notice={notice} />;
  }

  let pieces: AdminPiece[];
  try {
    pieces = await listPieces(getAdminDb());
  } catch (error) {
    // An admin panel that cannot read the database says so. It never renders an
    // empty list, which reads as "you have no stock".
    console.error("[admin-pieces] the catalogue could not be read:", error);
    return (
      <Shell title="Pieces">
        <p className="pcs__notice pcs__notice--problem">
          The catalogue could not be read just now, so nothing is shown. This is the
          website&rsquo;s own problem and not a sign that a piece is missing. Try again in a
          moment.
        </p>
      </Shell>
    );
  }

  const drafts = pieces.filter((piece) => piece.status === "draft");
  const live = pieces.filter((piece) => piece.status === "active");
  const away = pieces.filter((piece) => piece.status === "archived");

  return (
    <div className="pcs">
      <h1 className="pcs__title">Pieces</h1>

      <Notice code={notice} />

      <p className="pcs__acts">
        <a className="pcs__btn pcs__btn--primary" href="/admin/pieces?add=1">
          Add a piece
        </a>
      </p>

      {pieces.length === 0 ? (
        /* The empty screen says what the website is currently doing about it,
           which is the fact the owner needs before they decide whether this is
           urgent. It does not scold and it does not promise. */
        <>
          <p className="pcs__lede">No pieces yet.</p>
          <p className="pcs__lede">
            The catalogue is empty, and the website says so rather than showing pictures that are
            not of anything. Two things start a piece, a name and what kind it is,
            and everything else can wait.
          </p>
          <p className="pcs__blocked">{PHOTOGRAPHS_BLOCKED}</p>
        </>
      ) : (
        <>
          <Group
            heading="Not finished, not on the website"
            empty="Nothing is half-done."
            pieces={drafts}
            nowMs={nowMs}
          />
          <Group
            heading="On the website"
            empty="Nothing is on the website yet."
            pieces={live}
            nowMs={nowMs}
          />
          <Group
            heading="Put away"
            empty="Nothing has been put away."
            pieces={away}
            nowMs={nowMs}
          />

          <p className="pcs__blocked">{PHOTOGRAPHS_BLOCKED}</p>
        </>
      )}
    </div>
  );
}
