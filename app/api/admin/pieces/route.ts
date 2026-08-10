/**
 * THE CATALOGUE ACTION ENDPOINT — /api/admin/pieces.
 *
 * ===========================================================================
 * ONE ENDPOINT, EIGHT INTENTS, AND NO NINTH
 * ===========================================================================
 *   create          a name and a craft; the piece exists as a draft
 *   save_weight     net weight, gross weight, purity — THROUGH THE ECHO
 *   save_pricing    the mode, the making charge, stones, stock, how it sells
 *   save_hallmark   the hallmark answer, and only what the owner typed
 *   publish / unpublish / put_away / bring_back
 *
 * There is deliberately no `delete`. `products` and `variants` are referenced by
 * `order_items` only weakly, so a delete would not break an order — but it would
 * silently retire the row an admin needs in order to understand a past sale, and
 * `put_away` (archived) does everything a shop actually wants from one. The
 * screens say so rather than leaving the absence to be discovered.
 *
 * ===========================================================================
 * THE ECHO IS TWO POSTS, AND THAT IS THE POINT
 * ===========================================================================
 * A factor-of-ten weight error is the most expensive mistake this panel can
 * make. So `save_weight` without `confirm=yes` DOES NOT WRITE. It parses, and
 * redirects to the confirmation, which states the figure in words and in rupees
 * — 18.400 g becomes "eighteen grams and four hundred milligrams" and
 * "₹1,34,762 of gold", while 184.00 g becomes "one hundred and eighty-four
 * grams" and "₹13,47,620". The two share not one word.
 *
 * That confirmation is a PAGE and not a dialog, because there is no JavaScript
 * in this panel and a dialog would need some. The cost is one tap, and
 * research/05 §9 says plainly that this is the one place in the admin worth
 * spending it.
 *
 * ===========================================================================
 * NOTHING FROM A REQUEST IS EVER REFLECTED INTO A `Location`
 * ===========================================================================
 * `app/api/admin/orders/route.ts` sets this rule and it holds here, with one
 * extension that is worth stating precisely.
 *
 * A rejected section must not lose what was typed into it — research/05 asks for
 * exactly that, and notes it is safe here because none of these fields is
 * personal data. But putting typed text into a `Location` is how a header gets
 * split and how a redirect becomes someone else's.
 *
 * So what travels back is NEVER THE TYPED STRING. Every value is parsed to an
 * INTEGER or narrowed to a member of a closed enum first, and the redirect is
 * built by re-serialising those. `18.400` comes back because the milligram
 * integer 18400 was formatted again, not because the string survived. Anything
 * that cannot be reduced to an integer or an enum — a hallmark number, a
 * certificate number, a title — does not travel at all, and the refusals that
 * involve those fields are the ones where there was nothing to preserve.
 *
 * ===========================================================================
 * EVERY WRITE IS AUDITED IN THE SAME BATCH
 * ===========================================================================
 * `app/_admin/pieces-data.ts` puts an `auditStatement()` inside each write's own
 * `db.batch()` — the only atomicity primitive D1 offers. An audit row written in
 * a second batch either records a change that did not commit or misses one that
 * did. The diff is allowlist-driven, so a weight, a making charge, a stone
 * value, a fixed price, a HUID and a certificate number all record as the
 * indicator "changed" and never as a value.
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
import { actorFrom } from "../../../_admin/data";
import {
  createPiece,
  isHallmarkAnswer,
  isMakingChargeType,
  isPricingMode,
  isSaleMode,
  isStatusIntent,
  isUsableSku,
  noticeCopy,
  parseCount,
  parseGrams,
  parsePercent,
  parseRupees,
  readPiece,
  recordedText,
  saveHallmark,
  savePricing,
  saveWeight,
  setPieceStatus,
  type AdminPiece,
  type MakingChargeType,
  type PieceNotice,
  type PricingMode,
  type SaleMode,
} from "../../../_admin/pieces-data";

/* =========================================================================
 * Where a browser is sent back to
 * ====================================================================== */

/**
 * Every destination this endpoint can produce, built from validated parts only.
 *
 * The SKU is checked against `isUsableSku()` before it is interpolated, the
 * section is one of three literals, and every query value is a number or a
 * member of a closed set. There is no path by which a string from the request
 * body reaches a `Location` header.
 */
function pieceHref(
  sku: string | null,
  options: {
    readonly section?: "weight" | "price" | "hallmark";
    readonly notice?: PieceNotice;
    readonly params?: Readonly<Record<string, string | number | null>>;
  } = {}
): string {
  if (sku === null || !isUsableSku(sku)) return "/admin/pieces";

  const query = new URLSearchParams();
  if (options.section) query.set("section", options.section);
  if (options.notice) query.set("notice", options.notice);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    if (value !== null && value !== "") query.set(key, String(value));
  }

  const suffix = query.toString();
  return `/admin/pieces/${encodeURIComponent(sku)}${suffix ? `?${suffix}` : ""}`;
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
  readonly notice: PieceNotice;
  readonly location: string;
  readonly ok?: boolean;
};

function respond(request: Request, answer: Answer): Response {
  const result = headers();

  if (isFormPost(request)) {
    // Even a refusal is a 303: a 4xx carrying a Location is a blank page the
    // browser will not follow, and a blank page tells the owner nothing. The
    // failure travels as the notice code and the page says it in words.
    result.set("Location", answer.location);
    return new Response(null, { status: 303, headers: result });
  }

  result.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      ok: answer.ok ?? false,
      notice: answer.notice,
      // The JSON caller gets the SAME sentence the page would print, out of the
      // one table in `pieces-data.ts`. Two copies of a refusal is two answers.
      message: noticeCopy(answer.notice),
    }),
    { status: answer.status, headers: result }
  );
}

/** A refusal that stays on the section the owner was working in. */
function reject(
  request: Request,
  sku: string | null,
  notice: PieceNotice,
  status: number,
  section?: "weight" | "price" | "hallmark",
  params?: Readonly<Record<string, string | number | null>>
): Response {
  return respond(request, {
    status,
    notice,
    location: pieceHref(sku, { section, notice, params }),
  });
}

type Submission = Readonly<Record<string, string>>;

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

const FIELDS = [
  "intent",
  "sku",
  "csrf",
  "title",
  "craft",
  "net",
  "gross",
  "fineness",
  "confirm",
  "pricingMode",
  "makingChargeType",
  "makingCharge",
  "stones",
  "other",
  "fixed",
  "unique",
  "stock",
  "saleMode",
  "answer",
  "charge",
  "huid",
  "purityMark",
  "certificateNumber",
  "certificateLab",
] as const;

async function readSubmission(request: Request): Promise<Submission> {
  const empty: Record<string, string> = {};
  for (const field of FIELDS) empty[field] = "";

  if (isFormPost(request)) {
    const form = await request.formData();
    for (const field of FIELDS) empty[field] = asText(form.get(field));
    return empty;
  }

  try {
    const payload = (await request.json()) as Record<string, unknown> | null;
    if (payload === null || typeof payload !== "object") return empty;
    for (const field of FIELDS) empty[field] = asText(payload[field]);
    return empty;
  } catch {
    return empty;
  }
}

/** `18.400` — milligrams back to the string a gram field takes. */
function gramsInput(mg: number | null): string | null {
  if (mg === null) return null;
  return `${Math.floor(mg / 1000)}.${String(mg % 1000).padStart(3, "0")}`;
}

/* =========================================================================
 * POST
 * ====================================================================== */

export async function POST(request: Request): Promise<Response> {
  // A missing Origin is refused on this side of the door: there is no
  // legitimate non-browser admin client, so the header a browser always sends is
  // one an admin request must always carry.
  if (refuseCrossSite(request)) {
    return respond(request, {
      status: 403,
      notice: "refused",
      location: "/admin/pieces?notice=refused",
    });
  }

  const submission = await readSubmission(request);
  const sku = isUsableSku(submission.sku) ? submission.sku : null;

  let db;
  try {
    db = getAdminDb();
  } catch (error) {
    console.error("[admin-pieces] no database, so no piece can be changed:", error);
    return respond(request, {
      status: 503,
      notice: "unavailable",
      location: pieceHref(sku, { notice: "unavailable" }),
    });
  }

  // `proxy.ts` is defence; this is the defence. It is the only check that sees a
  // revoked, expired, idled-out or deactivated session, none of which a signed
  // cookie can express on its own.
  const session = await requireAdmin(request, { db });
  if (!session.ok) {
    return respond(request, {
      status: 401,
      notice: "refused",
      location: "/admin/pieces?notice=refused",
    });
  }

  const token = await tokenFromCookieValue(readAdminCookieValue(request.headers.get("cookie")));
  if (!token || !(await verifyCsrfToken(token, submission.csrf))) {
    return respond(request, {
      status: 403,
      notice: "refused",
      location: pieceHref(sku, { notice: "refused" }),
    });
  }

  const actor = actorFrom(session.identity, {
    ip: request.headers.get("cf-connecting-ip"),
    userAgent: request.headers.get("user-agent"),
  });

  try {
    if (submission.intent === "create") {
      const outcome = await createPiece(db, {
        title: submission.title,
        craft: submission.craft,
        actor,
      });
      if (!outcome.ok) {
        return respond(request, {
          status: outcome.notice === "unavailable" ? 503 : 400,
          notice: outcome.notice,
          // Back to the form, not to the list: the owner is mid-task and the
          // two fields they typed are the two the message is about.
          location: `/admin/pieces?add=1&notice=${outcome.notice}`,
        });
      }
      return respond(request, {
        status: 200,
        ok: true,
        notice: outcome.notice,
        location: pieceHref(outcome.value.sku, { notice: outcome.notice }),
      });
    }

    // Everything below acts on an existing piece, so it has to exist first.
    if (sku === null) {
      return respond(request, {
        status: 400,
        notice: "not-found",
        location: "/admin/pieces?notice=not-found",
      });
    }

    const piece = await readPiece(db, sku);
    if (piece === null) {
      return respond(request, {
        status: 404,
        notice: "not-found",
        location: "/admin/pieces?notice=not-found",
      });
    }

    switch (submission.intent) {
      case "save_weight":
        return await handleWeight(request, db, piece, submission, actor);
      case "save_pricing":
        return await handlePricing(request, db, piece, submission, actor);
      case "save_hallmark":
        return await handleHallmark(request, db, piece, submission, actor);
      default:
        break;
    }

    if (isStatusIntent(submission.intent)) {
      const outcome = await setPieceStatus(db, {
        piece,
        intent: submission.intent,
        actor,
      });
      return respond(request, {
        status: outcome.ok ? 200 : outcome.notice === "unavailable" ? 503 : 409,
        ok: outcome.ok,
        notice: outcome.notice,
        location: pieceHref(piece.sku, { notice: outcome.notice }),
      });
    }
  } catch (error) {
    console.error(`[admin-pieces] ${submission.intent} on ${sku ?? "a new piece"} failed:`, error);
    return respond(request, {
      status: 503,
      notice: "unavailable",
      location: pieceHref(sku, { notice: "unavailable" }),
    });
  }

  // An intent nobody publishes. There is no `delete` here and no `status`
  // either: a status is not an intent, and the four that exist are named.
  return respond(request, {
    status: 400,
    notice: "not-found",
    location: pieceHref(sku, { notice: "not-found" }),
  });
}

/* -------------------------------------------------------------------------
 * save_weight — the echo
 * ---------------------------------------------------------------------- */

async function handleWeight(
  request: Request,
  db: ReturnType<typeof getAdminDb>,
  piece: AdminPiece,
  submission: Submission,
  actor: ReturnType<typeof actorFrom>
): Promise<Response> {
  const net = parseGrams(submission.net);
  if (!net.ok) return reject(request, piece.sku, net.notice, 400, "weight");

  const gross = parseGrams(submission.gross);
  if (!gross.ok) {
    return reject(request, piece.sku, gross.notice, 400, "weight", {
      net: gramsInput(net.value),
    });
  }

  const finenessRaw = submission.fineness.trim();
  const fineness = finenessRaw === "" ? null : Number(finenessRaw);
  if (fineness !== null && !Number.isInteger(fineness)) {
    return reject(request, piece.sku, "bad-purity", 400, "weight", {
      net: gramsInput(net.value),
      gross: gramsInput(gross.value),
    });
  }

  const params = {
    net: gramsInput(net.value),
    gross: gramsInput(gross.value),
    fineness,
  };

  /* THE ECHO. Nothing has been written yet and nothing will be until the owner
     has read the figure back in words and in rupees. The values in this
     redirect are re-serialised from the milligram integers above, so what the
     confirmation shows is exactly what would be stored — not a copy of what was
     typed, which could differ from it. */
  if (submission.confirm !== "yes") {
    return respond(request, {
      status: 200,
      ok: true,
      notice: "confirm-weight",
      location: pieceHref(piece.sku, {
        section: "weight",
        params: { ...params, confirm: 1 },
      }),
    });
  }

  const outcome = await saveWeight(db, {
    piece,
    netMetalWeightMg: net.value,
    grossWeightMg: gross.value,
    fineness,
    actor,
  });

  if (!outcome.ok) {
    return reject(
      request,
      piece.sku,
      outcome.notice,
      outcome.notice === "unavailable" ? 503 : 400,
      "weight",
      params
    );
  }

  return respond(request, {
    status: 200,
    ok: true,
    notice: outcome.notice,
    location: pieceHref(piece.sku, { notice: outcome.notice }),
  });
}

/* -------------------------------------------------------------------------
 * save_pricing
 * ---------------------------------------------------------------------- */

async function handlePricing(
  request: Request,
  db: ReturnType<typeof getAdminDb>,
  piece: AdminPiece,
  submission: Submission,
  actor: ReturnType<typeof actorFrom>
): Promise<Response> {
  const pricingMode: PricingMode = isPricingMode(submission.pricingMode)
    ? submission.pricingMode
    : "on_request";

  const makingChargeType: MakingChargeType | null = isMakingChargeType(
    submission.makingChargeType
  )
    ? submission.makingChargeType
    : null;

  // A percentage and an amount are different units against the same box, so the
  // parser is chosen by the mode rather than by what the digits look like.
  const making =
    makingChargeType === "percent"
      ? parsePercent(submission.makingCharge)
      : parseRupees(submission.makingCharge);
  if (!making.ok) return reject(request, piece.sku, making.notice, 400, "price");

  const stones = parseRupees(submission.stones);
  if (!stones.ok) return reject(request, piece.sku, stones.notice, 400, "price");

  const other = parseRupees(submission.other);
  if (!other.ok) return reject(request, piece.sku, other.notice, 400, "price");

  const fixed = parseRupees(submission.fixed);
  if (!fixed.ok) return reject(request, piece.sku, fixed.notice, 400, "price");

  const stock = parseCount(submission.stock);
  if (!stock.ok) return reject(request, piece.sku, stock.notice, 400, "price");

  const isUniquePiece = submission.unique !== "no";
  const saleMode: SaleMode = isSaleMode(submission.saleMode) ? submission.saleMode : "enquire_only";

  /* Everything typed into this section, re-serialised from integers and enums so
     a rejection puts it all back in the form. Not one of these is a string that
     arrived from the request. */
  const params = {
    pricingMode,
    makingChargeType,
    making: making.value,
    stones: stones.value,
    other: other.value,
    fixed: fixed.value,
    unique: isUniquePiece ? "yes" : "no",
    stock: stock.value,
    saleMode,
  };

  const outcome = await savePricing(db, {
    piece,
    pricingMode,
    makingChargeType,
    makingChargeValue: making.value,
    stoneValuePaise: stones.value ?? 0,
    otherChargesPaise: other.value ?? 0,
    fixedPricePaise: fixed.value,
    isUniquePiece,
    stockQuantity: stock.value ?? piece.stockQuantity,
    saleMode,
    actor,
  });

  if (!outcome.ok) {
    return reject(
      request,
      piece.sku,
      outcome.notice,
      outcome.notice === "unavailable" ? 503 : 400,
      "price",
      params
    );
  }

  return respond(request, {
    status: 200,
    ok: true,
    notice: outcome.notice,
    location: pieceHref(piece.sku, { notice: outcome.notice }),
  });
}

/* -------------------------------------------------------------------------
 * save_hallmark — where nothing is ever invented
 * ---------------------------------------------------------------------- */

async function handleHallmark(
  request: Request,
  db: ReturnType<typeof getAdminDb>,
  piece: AdminPiece,
  submission: Submission,
  actor: ReturnType<typeof actorFrom>
): Promise<Response> {
  if (!isHallmarkAnswer(submission.answer)) {
    return reject(request, piece.sku, "not-publishable", 400, "hallmark");
  }

  const charge = parseRupees(submission.charge);
  if (!charge.ok) return reject(request, piece.sku, charge.notice, 400, "hallmark");

  /* `recordedText()` returns NULL for an empty box, never "". A HUID, a purity
     mark, a certificate number and a lab are recorded EXACTLY as typed or not at
     all — nothing here derives one from the craft, from the fineness, from the
     SKU or from anything else, and the absence is explained on every screen that
     shows it rather than left blank. */
  const outcome = await saveHallmark(db, {
    piece,
    answer: submission.answer,
    huid: recordedText(submission.huid, 32),
    hallmarkPurityMark: recordedText(submission.purityMark, 32),
    certificateNumber: recordedText(submission.certificateNumber, 64),
    certificateLab: recordedText(submission.certificateLab, 32),
    hallmarkingPaise: charge.value,
    actor,
  });

  if (!outcome.ok) {
    return reject(
      request,
      piece.sku,
      outcome.notice,
      outcome.notice === "unavailable" ? 503 : 400,
      "hallmark",
      // Only the ANSWER travels back. The identifiers do not: they are free text
      // rather than integers or enum members, and the one refusal that involves
      // them is the one where the box was empty.
      { answer: submission.answer }
    );
  }

  return respond(request, {
    status: 200,
    ok: true,
    notice: outcome.notice,
    location: pieceHref(piece.sku, { notice: outcome.notice }),
  });
}

/**
 * There is no GET, and there is no DELETE.
 *
 * No GET because `SameSite=Lax` sends the session cookie on a top-level
 * navigation, so a GET that changed anything would be a CSRF payload delivered
 * by a link in a message. No DELETE because a piece that has been sold is part
 * of how a past order is understood, and `put_away` gives a shop everything it
 * actually wants from a delete while leaving the record intact.
 */
export function GET(): Response {
  const result = headers();
  result.set("Allow", "POST");
  result.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      ok: false,
      error: "Use POST. Pieces cannot be read or deleted through this endpoint.",
    }),
    { status: 405, headers: result }
  );
}
