/**
 * THE ADMIN SESSION ENDPOINT — /api/admin/session.
 *
 * ===========================================================================
 * SHAPES
 * ===========================================================================
 * POST  { email, password }                     sign in
 * POST  { intent: "sign-out", csrf }            sign out (no-JavaScript form)
 * DELETE                                        sign out (JSON client)
 * GET                                           405, always
 *
 * As with `/api/cart`, there are two callers and one code path. A browser form
 * gets a 303 and reads the outcome off the sign-in page; a JSON caller gets the
 * real status code. The admin panel has no JavaScript on it, so the form shape
 * is the one that matters and the JSON shape exists for the tests and for
 * whatever tooling comes later.
 *
 * ===========================================================================
 * ONE FAILURE STRING
 * ===========================================================================
 * Every way a sign-in can fail — no such address, no passphrase ever issued for
 * that seat, a deactivated seat, the wrong passphrase, an empty submission, a
 * throttled attempt — returns `SIGN_IN_FAILED` verbatim, and for a browser it
 * returns it via the same 303 to the same URL with the same notice code. There
 * is no countdown, no "forgot your passphrase", no length hint and no
 * field-level error, because each of those is a different answer on a different
 * path and a different answer is an oracle.
 *
 * The one status code that differs is 503 for a MISCONFIGURED SERVER (no
 * pepper, no session secret). That is not a credential answer — it is the
 * fail-closed posture `refuseUnauthorised()` takes in
 * `app/api/gold-rate/route.ts`, where an unset secret must never mean "anyone
 * may write". The body is still the same string, and the browser path is still
 * the same redirect, so nothing about a CREDENTIAL is distinguishable.
 *
 * ===========================================================================
 * WHY THE COOKIE IS SET ON THE RESPONSE, NOT THROUGH cookies()
 * ===========================================================================
 * `cookies().set()` works in a route handler, but it serialises
 * `SameSite=lax` in lower case and rebuilds the header list at the end of the
 * request. Building the string on the exact `Response` this handler returns —
 * including the 303 — is what `app/api/cart/route.ts` does and keeps one
 * spelling of every attribute across the project.
 */

import {
  ADMIN_HOME_PATH,
  ADMIN_LOGIN_PATH,
  ADMIN_RESPONSE_HEADERS,
  SIGN_IN_FAILED,
  adminSessionCookieHeader,
  clearedAdminSessionCookieHeader,
  getAdminDb,
  readAdminCookieValue,
  refuseCrossSite,
  requireAdmin,
  signIn,
  signOut,
  tokenFromCookieValue,
  verifyCsrfToken,
} from "../../../_admin/session";

/** Closed set of notice codes. Nothing from the request reaches a Location. */
export const ADMIN_NOTICES = {
  refused: "refused",
  signedOut: "signed-out",
  crossSite: "cross-site",
} as const;

export type AdminNotice = (typeof ADMIN_NOTICES)[keyof typeof ADMIN_NOTICES];

export function adminLoginHref(notice?: AdminNotice): string {
  return notice ? `${ADMIN_LOGIN_PATH}?notice=${notice}` : ADMIN_LOGIN_PATH;
}

function isFormPost(request: Request): boolean {
  const contentType = request.headers.get("content-type") ?? "";
  return (
    contentType.includes("application/x-www-form-urlencoded") ||
    contentType.includes("multipart/form-data")
  );
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function headers(setCookie?: string | null): Headers {
  const result = new Headers(ADMIN_RESPONSE_HEADERS);
  if (setCookie) result.append("Set-Cookie", setCookie);
  return result;
}

function redirect(to: string, setCookie?: string | null): Response {
  const result = headers(setCookie);
  result.set("Location", to);
  // 303 forces the follow-up to be a GET, so a reload does not re-post the
  // passphrase.
  return new Response(null, { status: 303, headers: result });
}

function json(
  status: number,
  body: Record<string, unknown>,
  setCookie?: string | null
): Response {
  const result = headers(setCookie);
  result.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: result });
}

type Submission = { email: string; password: string; intent: string; csrf: string };

async function readSubmission(request: Request): Promise<Submission> {
  if (isFormPost(request)) {
    const form = await request.formData();
    return {
      email: asTrimmedString(form.get("email")),
      password: typeof form.get("password") === "string" ? String(form.get("password")) : "",
      intent: asTrimmedString(form.get("intent")),
      csrf: asTrimmedString(form.get("csrf")),
    };
  }

  try {
    const payload = (await request.json()) as Record<string, unknown>;
    if (!payload || typeof payload !== "object") {
      return { email: "", password: "", intent: "", csrf: "" };
    }
    return {
      email: asTrimmedString(payload.email),
      password: typeof payload.password === "string" ? payload.password : "",
      intent: asTrimmedString(payload.intent),
      csrf: asTrimmedString(payload.csrf),
    };
  } catch {
    return { email: "", password: "", intent: "", csrf: "" };
  }
}

function clientIp(request: Request): string | null {
  return request.headers.get("cf-connecting-ip");
}

export async function POST(request: Request): Promise<Response> {
  const form = isFormPost(request);

  // The inverse of the storefront's rule: a MISSING Origin is refused here.
  // There is no legitimate non-browser admin client, so the header a browser
  // always sends is one an admin request must always carry.
  if (refuseCrossSite(request)) {
    return form
      ? redirect(adminLoginHref(ADMIN_NOTICES.crossSite))
      : json(403, { ok: false, error: SIGN_IN_FAILED });
  }

  const submission = await readSubmission(request);

  if (submission.intent === "sign-out") {
    return handleSignOut(request, form, submission.csrf);
  }

  let db;
  try {
    db = getAdminDb();
  } catch (error) {
    console.error("[admin-session] no database, so no sign-in is possible:", error);
    return form
      ? redirect(adminLoginHref(ADMIN_NOTICES.refused))
      : json(503, { ok: false, error: SIGN_IN_FAILED });
  }

  const outcome = await signIn({
    db,
    email: submission.email,
    password: submission.password,
    userAgent: request.headers.get("user-agent"),
    ip: clientIp(request),
    // Revoked, never adopted. See the session-fixation note in
    // app/_admin/session.ts.
    presentedCookieValue: readAdminCookieValue(request.headers.get("cookie")),
  });

  if (!outcome.ok) {
    // The real reason is in the audit log. The visitor gets one string.
    const status = outcome.reason === "misconfigured" ? 503 : 401;
    return form
      ? redirect(adminLoginHref(ADMIN_NOTICES.refused))
      : json(status, { ok: false, error: SIGN_IN_FAILED });
  }

  const cookie = adminSessionCookieHeader(outcome.cookieValue, outcome.maxAgeSeconds);

  return form
    ? redirect(ADMIN_HOME_PATH, cookie)
    : json(
        200,
        {
          ok: true,
          admin: {
            email: outcome.identity.email,
            displayName: outcome.identity.displayName,
            role: outcome.identity.role,
          },
          // Bound to this session, needed by every subsequent admin form.
          // Not a secret at rest: it is derived, never stored.
          csrf: outcome.identity.csrfToken,
        },
        cookie
      );
}

/**
 * Sign out.
 *
 * Requires a real session AND the session's own CSRF token, because a forged
 * sign-out is a nuisance an attacker can deliver with a cross-origin form.
 * The cookie is cleared either way — if the session is already gone there is
 * nothing to protect and leaving a dead cookie in the browser helps nobody.
 */
async function handleSignOut(
  request: Request,
  form: boolean,
  presentedCsrf: string
): Promise<Response> {
  const cleared = clearedAdminSessionCookieHeader();

  let db;
  try {
    db = getAdminDb();
  } catch {
    return form
      ? redirect(adminLoginHref(ADMIN_NOTICES.signedOut), cleared)
      : json(200, { ok: true }, cleared);
  }

  const outcome = await requireAdmin(request, { db });
  if (!outcome.ok) {
    return form
      ? redirect(adminLoginHref(ADMIN_NOTICES.signedOut), cleared)
      : json(200, { ok: true }, cleared);
  }

  const token = await tokenFromCookieValue(
    readAdminCookieValue(request.headers.get("cookie"))
  );

  if (!token || !(await verifyCsrfToken(token, presentedCsrf))) {
    // Refuse the REVOCATION, but still clear this browser's cookie. The
    // session stays alive for its legitimate holder.
    return form
      ? redirect(adminLoginHref(ADMIN_NOTICES.crossSite), cleared)
      : json(403, { ok: false, error: "That sign-out could not be verified." }, cleared);
  }

  await signOut(db, outcome.identity, {
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent"),
  });

  return form
    ? redirect(adminLoginHref(ADMIN_NOTICES.signedOut), cleared)
    : json(200, { ok: true }, cleared);
}

/**
 * DELETE is the JSON client's sign-out. The CSRF token travels in a header,
 * because a request with no body still has to prove it was not forged, and
 * because reading the body here would fight with `readSubmission()` having
 * already consumed it on the POST path.
 */
export async function DELETE(request: Request): Promise<Response> {
  if (refuseCrossSite(request)) {
    return json(403, { ok: false, error: "That sign-out could not be verified." });
  }
  return handleSignOut(request, false, (request.headers.get("x-admin-csrf") ?? "").trim());
}

/**
 * 405, deliberately. A session is not readable by GET: `SameSite=Lax` sends
 * the cookie on a top-level navigation, so a GET that did anything would be a
 * CSRF payload delivered by a link.
 */
export function GET(): Response {
  const result = headers();
  result.set("Allow", "POST, DELETE");
  result.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({ ok: false, error: "Use POST to sign in and DELETE to sign out." }),
    { status: 405, headers: result }
  );
}
