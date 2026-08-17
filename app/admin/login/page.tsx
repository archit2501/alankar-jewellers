/**
 * THE ADMIN SIGN-IN PAGE — /admin/login.
 *
 * ===========================================================================
 * ONE MESSAGE, WHATEVER WENT WRONG
 * ===========================================================================
 * Every failing sign-in path lands back here with `?notice=refused` and this
 * page renders `SIGN_IN_FAILED` verbatim. There is no countdown, no "forgot
 * your passphrase" link, no "that email is not registered", no length hint and
 * no per-field error, because each of those is a different answer on a
 * different path, and a different answer tells an attacker which of the seven
 * failure modes they hit. The real reason is in `admin_audit_log`, where only
 * the shop can read it.
 *
 * ===========================================================================
 * NO JAVASCRIPT, LIKE THE REST OF THE SITE
 * ===========================================================================
 * A `<form method="post">` to `/api/admin/session`, which answers a form with
 * a 303 — the same idiom `/cart` and `/shop` use. That is not a stylistic
 * choice here: the sign-in is the one page that has to work on a shop terminal
 * with a locked-down browser, and a form that needs a bundle to submit is a
 * form that can fail to submit.
 *
 * ===========================================================================
 * THE PASSPHRASE IS ISSUED, NOT CHOSEN
 * ===========================================================================
 * The copy says so, and it matters that it does. The whole security argument
 * for a password on a platform with no Argon2, no bcrypt and a 100,000-iteration
 * PBKDF2 ceiling is that the secret carries ~100 bits of entropy the owner
 * never picked. A page that invited someone to type a memorable word would
 * quietly undo that, so it invites them to paste the slip instead.
 *
 * The field is `type="password"` with `autoComplete="current-password"` so a
 * password manager stores it — which is the intended way to hold a 24-character
 * random string, and better than the paper alternative.
 *
 * ===========================================================================
 * WHEN ALREADY SIGNED IN
 * ===========================================================================
 * This page also renders the signed-in state, with the identity printed and a
 * working sign-out. `research/06-admin-compliance.md` asks for the logged-in
 * identity to be visible in the admin chrome precisely because a shared
 * credential is otherwise invisible to the person using it — if the counter
 * assistant sees the owner's name at the top of the screen, at least the
 * mis-attribution is happening in front of someone.
 */

import type { Metadata } from "next";
import { headers } from "next/headers";

import {
  ADMIN_HOME_PATH,
  SIGN_IN_FAILED,
  getAdminDb,
  requireAdmin,
  type AdminIdentity,
} from "../../_admin/session";
import { site } from "../../site-config";

/**
 * Reading the cookie makes this dynamic anyway; saying so is cheaper than
 * discovering it. A prerendered sign-in page would be a cached page keyed on
 * one admin's cookie.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: `Sign in | ${site.name}`,
  description: "Staff sign-in for the Alankar Jewellers shop panel.",
  // app/layout.tsx sets robots index:true for the storefront, and
  // app/robots.ts only disallows /api/. Without this the sign-in page is
  // indexable. proxy.ts sets X-Robots-Tag on the response as well; both,
  // because a meta tag is invisible to a crawler that only reads headers and a
  // header is invisible to one that only reads markup.
  robots: { index: false, follow: false, nocache: true },
};

const NOTICE_COPY: Record<string, string> = {
  refused: SIGN_IN_FAILED,
  "signed-out": "Signed out. The session on this device has been ended.",
  "cross-site":
    "That request did not come from this site, so it was not carried out. Sign in from this page.",
};

/* -------------------------------------------------------------------------
 * Styles
 *
 * Scoped to this page and inline, because the shared stylesheets belong to the
 * storefront and the admin has no business widening them for one form. Every
 * value is a token from app/tokens.css; nothing new is invented here.
 * ---------------------------------------------------------------------- */

const STYLES = `
.admin-auth {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: var(--s-6) var(--s-5);
  background: var(--meena-deep);
  color: var(--ivory);
  font-family: var(--font-body);
}
.admin-auth__card {
  width: 100%;
  max-width: 26rem;
  background: var(--meena);
  border: var(--rule-hair) solid var(--gold-deep);
  padding: var(--m-1) var(--s-6) var(--s-7);
}
.admin-auth__eyebrow {
  font-family: var(--font-data);
  font-size: var(--t-2xs);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--gold-leaf);
  margin: 0 0 var(--s-3);
}
.admin-auth__title {
  font-family: var(--font-display);
  font-size: var(--d-m);
  line-height: var(--leading-tight);
  margin: 0 0 var(--s-4);
  color: var(--ivory);
}
.admin-auth__lede {
  font-size: var(--t-sm);
  line-height: var(--leading-body);
  color: var(--ivory);
  opacity: 0.82;
  margin: 0 0 var(--s-6);
}
.admin-auth__notice {
  border-left: var(--rule-heavy) solid var(--gold);
  background: var(--meena-lift);
  padding: var(--s-4);
  margin: 0 0 var(--s-5);
  font-size: var(--t-sm);
  line-height: var(--leading-body);
}
.admin-auth__field { display: block; margin: 0 0 var(--s-5); }
.admin-auth__label {
  display: block;
  font-family: var(--font-data);
  font-size: var(--t-2xs);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--gold-leaf);
  margin: 0 0 var(--s-2);
}
.admin-auth__input {
  width: 100%;
  box-sizing: border-box;
  padding: var(--s-3) var(--s-4);
  font-family: var(--font-data);
  font-size: var(--t-md);
  color: var(--ink);
  background: var(--plaster-lift);
  border: var(--rule-hair) solid var(--gold-deep);
  border-radius: 0;
}
.admin-auth__input:focus-visible {
  outline: 2px solid var(--gold-leaf);
  outline-offset: 2px;
}
.admin-auth__button {
  width: 100%;
  padding: var(--s-4);
  font-family: var(--font-data);
  font-size: var(--t-xs);
  letter-spacing: var(--tracking-label);
  text-transform: uppercase;
  color: var(--meena-deep);
  background: var(--gold);
  border: none;
  cursor: pointer;
}
.admin-auth__button:focus-visible {
  outline: 2px solid var(--gold-leaf);
  outline-offset: 2px;
}
.admin-auth__foot {
  margin: var(--s-6) 0 0;
  font-size: var(--t-2xs);
  line-height: var(--leading-body);
  color: var(--ivory);
  opacity: 0.6;
}
.admin-auth__who {
  font-family: var(--font-data);
  font-size: var(--t-sm);
  line-height: var(--leading-body);
  margin: 0 0 var(--s-5);
}
.admin-auth__link { color: var(--gold-leaf); }
`;

/* -------------------------------------------------------------------------
 * The page
 * ---------------------------------------------------------------------- */

/**
 * `readSession()` takes a `Request` because that is what a route handler and
 * the proxy both have. A server component has `headers()` instead, so one is
 * assembled from them. Only the cookie header is read, and the URL is never
 * used for anything but constructing a valid object.
 */
async function currentIdentity(): Promise<AdminIdentity | null> {
  const inbound = await headers();
  const cookie = inbound.get("cookie");
  if (!cookie) return null;

  try {
    const outcome = await requireAdmin(
      new Request("https://admin.invalid/", { headers: { cookie } }),
      { db: getAdminDb() }
    );
    return outcome.ok ? outcome.identity : null;
  } catch (error) {
    // A database that cannot be read is not an authenticated admin. Never a
    // fabricated one.
    console.error("[admin-login] could not read the session:", error);
    return null;
  }
}

export default async function AdminLoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.notice;
  const code = Array.isArray(raw) ? raw[0] : raw;
  const notice = typeof code === "string" ? NOTICE_COPY[code] : undefined;

  const identity = await currentIdentity();

  return (
    <main className="admin-auth">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div className="admin-auth__card">
        <p className="admin-auth__eyebrow">{site.name} · shop panel</p>

        {identity ? (
          <>
            <h1 className="admin-auth__title">Already signed in</h1>
            <p className="admin-auth__who">
              {identity.displayName ?? identity.email}
              <br />
              {identity.email} · {identity.role}
            </p>
            <p className="admin-auth__lede">
              <a className="admin-auth__link" href={ADMIN_HOME_PATH}>
                Go to the panel
              </a>
            </p>
            <form method="post" action="/api/admin/session">
              <input type="hidden" name="intent" value="sign-out" />
              {/* Bound to this session and to no other. An origin check alone
                  rests on a header the shop does not control. */}
              <input type="hidden" name="csrf" value={identity.csrfToken} />
              <button className="admin-auth__button" type="submit">
                Sign out
              </button>
            </form>
          </>
        ) : (
          <>
            <h1 className="admin-auth__title">Sign in</h1>
            <p className="admin-auth__lede">
              Use the passphrase the shop was issued. It is a long string of
              letters and numbers, not a word anyone chose, and it is the same
              one every time.
            </p>

            {notice ? (
              <p className="admin-auth__notice" role="alert">
                {notice}
              </p>
            ) : null}

            <form method="post" action="/api/admin/session">
              <label className="admin-auth__field">
                <span className="admin-auth__label">Email</span>
                <input
                  className="admin-auth__input"
                  type="email"
                  name="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>

              <label className="admin-auth__field">
                <span className="admin-auth__label">Passphrase</span>
                <input
                  className="admin-auth__input"
                  type="password"
                  name="password"
                  autoComplete="current-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  required
                />
              </label>

              <button className="admin-auth__button" type="submit">
                Sign in
              </button>
            </form>

            <p className="admin-auth__foot">
              There is no self-service reset. If the passphrase is lost, a new
              one is issued from the shop&rsquo;s own machine and the old one stops
              working the moment it is.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
