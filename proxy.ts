/**
 * THE ADMIN GATE. Runs before rewrites, before metadata routes, before
 * public-file resolution and before route dispatch — so anything it refuses is
 * refused before the page or the handler exists.
 *
 * ===========================================================================
 * THIS IS THE COARSE GATE. IT IS NOT THE GATE.
 * ===========================================================================
 * All this does is the CHEAP check: is there a well-formed, correctly-signed
 * admin cookie. It deliberately does NOT read D1, so it says nothing about
 * whether the session is revoked, expired, idled out, or belongs to a
 * deactivated admin. `requireAdmin()` in `app/_admin/session.ts` answers those,
 * and EVERY admin page and route handler owes that call.
 *
 * Both, always, for two reasons that are each sufficient on their own:
 *
 *   1. A matcher typo is a silent total bypass. `/admin*` matches
 *      `/administrivia`; a missing `/api/admin/:path*` leaves every admin
 *      endpoint open while every admin PAGE looks correctly protected. Nothing
 *      about the site's behaviour would look wrong.
 *
 *   2. A Server Action is invoked by POST to the URL of the page that imported
 *      it. An action defined in an admin module but rendered by a PUBLIC page
 *      is reachable without ever passing this matcher, and no matcher
 *      expression can express that. Only the check inside the action body can.
 *
 * The durable guarantee is neither of these, it is a test:
 * `tests/admin-auth.test.mjs` enumerates every route under `app/admin/**` and
 * `app/api/admin/**` off the filesystem and asserts each one is refused with no
 * cookie. A route added next year is protected by CI rather than by memory.
 *
 * ===========================================================================
 * PAGES REDIRECT, THE API DOES NOT
 * ===========================================================================
 * An anonymous page request gets a 303 to the sign-in page, because a human
 * asked for a page and should be given one. An anonymous `/api/admin/**`
 * request gets a 401 with a JSON body, because a 303 to an HTML sign-in form is
 * an unreadable answer to a fetch and, worse, a 200-shaped one after the
 * redirect is followed. Both are refusals; only the shape differs.
 *
 * ===========================================================================
 * WHAT THIS CANNOT PROTECT
 * ===========================================================================
 * Static assets. `wrangler.jsonc` binds `dist/client` with
 * `not_found_handling: "none"`, and on Workers an asset request is served by
 * the platform BEFORE the Worker script runs. Nothing under `public/` is
 * behind this gate, ever, at any URL. Admin-only material must never be put
 * there — which matters most if uploaded photographs are ever committed
 * because R2 is unavailable.
 */

import { NextResponse, type NextRequest } from "next/server";

import {
  ADMIN_LOGIN_PATH,
  ADMIN_RESPONSE_HEADERS,
  isAdminPath,
  isPublicAdminPath,
  readAdminCookieValue,
  tokenFromCookieValue,
} from "./app/_admin/session";

/**
 * `/admin` and `/api/admin` are listed as well as their subtrees: a bare
 * `/admin/:path*` is the kind of pattern that is assumed to cover the root and
 * sometimes does not, and the cost of being explicit is one line.
 */
export const config = {
  matcher: ["/admin", "/admin/:path*", "/api/admin", "/api/admin/:path*"],
};

function isApiPath(pathname: string): boolean {
  return pathname === "/api/admin" || pathname.startsWith("/api/admin/");
}

export async function proxy(request: NextRequest) {
  const { pathname } = new URL(request.url);

  // Belt to the matcher's braces. If the matcher ever drifts and hands us
  // something outside the admin tree, do nothing to it rather than gating the
  // storefront by accident.
  if (!isAdminPath(pathname)) return NextResponse.next();

  const allow = () => {
    const response = NextResponse.next();
    for (const [name, value] of Object.entries(ADMIN_RESPONSE_HEADERS)) {
      response.headers.set(name, value);
    }
    return response;
  };

  // The sign-in page and the sign-in endpoint have to be reachable without a
  // session. This list lives in app/_admin/session.ts so the gate and the test
  // that enumerates the routes cannot disagree about it.
  if (isPublicAdminPath(pathname)) return allow();

  const token = await tokenFromCookieValue(
    readAdminCookieValue(request.headers.get("cookie"))
  );

  if (token) return allow();

  if (isApiPath(pathname)) {
    return NextResponse.json(
      { ok: false, error: "Sign in to use the admin panel." },
      { status: 401, headers: ADMIN_RESPONSE_HEADERS }
    );
  }

  // Absolute URL required: NextResponse.redirect validates it and throws
  // otherwise. Nothing from the request is reflected into the Location, so
  // there is no open redirect here — the destination is a constant.
  return NextResponse.redirect(new URL(ADMIN_LOGIN_PATH, request.url), {
    status: 303,
    headers: ADMIN_RESPONSE_HEADERS,
  });
}
