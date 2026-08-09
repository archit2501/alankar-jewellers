/**
 * THE SHOP PANEL SHELL — the chrome every admin screen renders inside.
 *
 * ===========================================================================
 * THE CHROME IS GATED, AND WHY THAT IS NOT THE SAME AS REDIRECTING FROM HERE
 * ===========================================================================
 * This layout calls `requireAdmin()` — through `resolveAdmin()` — before it
 * renders anything, and WITHOUT AN IDENTITY IT RENDERS NO PANEL AT ALL: no
 * strip, no navigation, no sign-out, no `<main>`. It cannot: the sign-out form
 * needs that session's own CSRF token, and there is nobody to name in the bar.
 *
 * What it does NOT do is redirect, and that is forced by the route layout
 * rather than chosen. THE SIGN-IN PAGE IS A CHILD OF THIS LAYOUT
 * (`/admin/login`, `PUBLIC_ADMIN_PATHS`). A layout that redirected every
 * sessionless request to the sign-in page would redirect the sign-in page to
 * itself, forever, and lock the shop out of its own panel — the failure would
 * be total and it would look like a gate working.
 *
 * The refusal therefore lives where it can tell the two apart:
 *
 *   `proxy.ts`   refuses an anonymous request to every admin path that is not
 *                on the public list, before the page exists at all;
 *   every PAGE   owes its own `requireAdmin()`, which is what catches the case
 *                the proxy cannot see — a correctly-signed cookie whose session
 *                was revoked, expired, idled out or belongs to a deactivated
 *                admin. `app/admin/page.tsx` does exactly that and redirects.
 *
 * That is the rule `app/_admin/session.ts` §5 already states — both gates,
 * always, and no matcher expression can stand in for the call in the body.
 * `tests/admin-auth.test.mjs` enumerates every route off the filesystem and
 * asserts each is refused when anonymous, so a screen added next year is held
 * to it by CI rather than by memory.
 *
 * ===========================================================================
 * WHAT THIS SHELL OWNS, AND WHAT IT LEAVES TO A SCREEN
 * ===========================================================================
 * It owns the teak strip, the identity, sign-out, the bottom bar and the
 * `<main>` landmark. A screen renders its own content and EXACTLY ONE `<h1>`;
 * it must not open a second `<main>`. Nothing here is an `<h1>`, so the count
 * per screen is always one.
 *
 * The one exception is the sign-in page, which opens its own `<main>` because
 * it is designed to be reachable with no panel around it. Signed out — the only
 * state it is normally seen in — this layout renders nothing around it and the
 * count is right. Signed in, it is shown inside the chrome and there are two;
 * the fix is a route group that lifts `/admin/login` out of this layout, and it
 * belongs to whoever owns that page.
 *
 * ===========================================================================
 * PLAIN ANCHORS, NOT next/link
 * ===========================================================================
 * `next/link` prefetches. In here a prefetch is a fully authenticated render of
 * a page nobody opened — which, because reads of customer data are audited,
 * would write `customer_data.*` rows for records that were never looked at. An
 * audit log that reports reads which did not happen is worse than one that is
 * merely slow, so every link in the admin is an ordinary `<a>`.
 *
 * ===========================================================================
 * WHY THE BOTTOM BAR CARRIES NO `aria-current`
 * ===========================================================================
 * A server layout is not given the pathname, and this stack strips
 * `x-matched-path` from inbound requests as a forgery surface
 * (`vinext/dist/server/headers.js`, INTERNAL_HEADERS), so there is no honest
 * way to work out which destination is the current one from in here. The two
 * ways to get it are a `"use client"` nav using `usePathname()`, which puts a
 * JavaScript dependency into a panel designed not to need one, or a nav
 * rendered separately by every screen, which duplicates the markup and leaves a
 * screen that forgets it with no navigation at all.
 *
 * Neither trade is worth it for two destinations, and `aria-current` on a fixed
 * guess would be WORSE than its absence — it would announce the wrong page. The
 * orientation cue is the screen's own `<h1>`, which is always present and
 * always right. This comment is the note to revisit when the panel has its
 * four destinations and a reason to ship a byte of script.
 */

import { headers } from "next/headers";

import { resolveAdmin } from "../_admin/data";
import "./admin.css";

/** Keyed on one admin's cookie. There is nothing here that may be cached. */
export const dynamic = "force-dynamic";

/**
 * The destinations that EXIST. `Enquiries` and `Pieces` are named in the design
 * and are not built yet; a tab that 404s teaches the owner that the panel is
 * broken, so each one appears here on the day its screen lands.
 */
const DESTINATIONS: readonly { href: string; label: string }[] = [
  { href: "/admin", label: "Today" },
  { href: "/admin/orders", label: "Orders" },
];

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const inbound = await headers();
  // The page below calls this again, so a signed-in view costs two session
  // reads. That is the price of the rule that a page may not depend on its
  // layout having checked, and it is small: one indexed read, and the idle
  // window it slides is rate-limited to one write a minute per session.
  const current = await resolveAdmin({ cookie: inbound.get("cookie") });

  // No identity, no panel. The child is rendered bare — which is what makes the
  // sign-in page reachable — and it is the child's own `requireAdmin()` that
  // refuses it if it is not a public one.
  if (!current) return <>{children}</>;

  const { identity } = current;

  return (
    <div className="admin grained">
      <header className="admin-bar">
        <p className="admin-bar__mark">
          <span className="admin-bar__deva" lang="hi">
            अलंकार
          </span>
          <span className="admin-bar__name">Alankar</span>
        </p>
        <p className="admin-bar__who">{identity.displayName ?? identity.email}</p>
        <form method="post" action="/api/admin/session">
          <input type="hidden" name="intent" value="sign-out" />
          {/* Bound to this session and to no other. An origin check alone rests
              on a header the shop does not control. */}
          <input type="hidden" name="csrf" value={identity.csrfToken} />
          <button className="admin-bar__out" type="submit">
            Sign out
          </button>
        </form>
      </header>

      <main className="admin-main">{children}</main>

      <nav className="admin-nav" aria-label="Shop panel">
        {DESTINATIONS.map((destination) => (
          <a key={destination.href} className="admin-nav__link" href={destination.href}>
            {destination.label}
          </a>
        ))}
      </nav>
    </div>
  );
}
