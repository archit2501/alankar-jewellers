/**
 * ADMIN SESSIONS — the cookie, the CSRF token, the origin rule, sign-in and
 * sign-out. Everything that decides whether a request is an authenticated
 * admin.
 *
 * ===========================================================================
 * REQUIRED ENVIRONMENT
 * ===========================================================================
 *   # ADMIN_SESSION_SECRET — REQUIRED. A long random key used to sign the
 *   # session cookie and to derive each session's CSRF token. Unset means NO
 *   # ONE can sign in (503), never "anyone may" — the posture
 *   # `refuseUnauthorised()` takes in app/api/gold-rate/route.ts.
 *   #
 *   # Generate:  openssl rand -hex 32
 *   # Rotating it signs every admin out. That is a feature: it is the one kill
 *   # switch that needs no database access.
 *   ADMIN_SESSION_SECRET=
 *
 * See `app/_admin/auth.ts` for ADMIN_PASSWORD_PEPPER and ADMIN_KDF_ITERATIONS,
 * and `app/_admin/audit.ts` for ADMIN_AUDIT_MIRROR_URL.
 *
 * ===========================================================================
 * 1. THE COOKIE IS A BEARER CREDENTIAL, AND CARRIES NOTHING ELSE
 * ===========================================================================
 *   value  =  <token>.<mac>
 *   token  =  43 base64url characters — 32 CSPRNG bytes, 256 bits
 *   mac    =  base64url(HMAC-SHA-256(ADMIN_SESSION_SECRET, token))
 *
 * There is no email in it, no role, no expiry and no id. There is therefore
 * nothing in it to forge except an opaque token that must exist in
 * `admin_sessions`, and role and active-status are re-read from `admin_users`
 * on every request — so deactivating someone takes effect on their next click
 * rather than whenever their cookie happens to age out.
 *
 * The MAC is not the security boundary; the database row is. The MAC exists so
 * a forged, truncated or randomly-guessed cookie is refused WITHOUT a D1 round
 * trip, which is the discipline `isWellFormedCartToken()` applies to the cart
 * cookie for the same reason.
 *
 * `admin_sessions.token_hash` stores SHA-256 of the token, never the token, so
 * a database dump does not hand over live sessions.
 *
 * ---------------------------------------------------------------------------
 * WHY `__Host-` AND `Path=/`, AND NOT `Path=/admin`
 * ---------------------------------------------------------------------------
 * `Path=/admin` was the first instinct and it is not possible here: the admin
 * API lives at `/api/admin/**`, which `Path=/admin` does not match, so the
 * cookie would simply never be sent to any admin endpoint. Path scoping cannot
 * express this route layout at all.
 *
 * `__Host-` is taken instead, and it is the better control anyway. A browser
 * refuses a `__Host-` cookie unless it is `Secure`, has `Path=/` and carries NO
 * `Domain` attribute — which is precisely what stops a sibling or parent host
 * (a subdomain takeover, a shared-hosting neighbour) overwriting the admin
 * session by "cookie tossing". Path scoping is not browser-enforced against
 * anything; the prefix is. `HttpOnly` already stops script reads on any path.
 *
 * The storefront's `aj_cart` has no prefix. That is right for a cart and is
 * deliberately not copied.
 *
 * ===========================================================================
 * 2. SESSION FIXATION
 * ===========================================================================
 * `signIn()` NEVER adopts a token from the request. It mints a fresh one, and
 * any session named by the cookie that arrived with the sign-in is revoked in
 * the same batch. This is the identical rule `resolveCartId` follows in
 * `app/_data/cart.ts` (4c): "a well-formed token that matches no open cart does
 * NOT become a cart" — a caller can never choose its own id.
 *
 * It matters more here than it does for the cart. The cart's own comment notes
 * that `SameSite=Lax` does not stop a third-party page POSTing and having the
 * browser accept the `Set-Cookie` that comes back, and calls that "a nuisance
 * rather than a breach". Against a LOGIN endpoint the same mechanic is session
 * fixation: an attacker POSTs their own credentials to the shop's login, the
 * owner's browser stores the returned session, and the owner then works inside
 * a session the attacker also holds. The origin rule below is what closes it;
 * regeneration is what makes the closure complete.
 *
 * ===========================================================================
 * 3. THE ORIGIN RULE IS THE INVERSE OF THE STOREFRONT'S
 * ===========================================================================
 * `app/api/cart/route.ts` deliberately lets a request with NO `Origin` header
 * through, and gives a good reason: "curl, a server-to-server call and the test
 * harness do not send it, and refusing those would break the JSON API for no
 * security gain — the attack needs a browser, and a browser sends the header."
 *
 * That reasoning is sound for a public cart API and false here. THERE IS NO
 * LEGITIMATE NON-BROWSER ADMIN CLIENT. A missing `Origin` is free to forge from
 * anything that is not a browser, so allowing it hands a stolen cookie to
 * exactly the client type the storefront's argument assumes cannot exist.
 * Every admin mutation therefore REFUSES a missing or `null` origin, and
 * `Sec-Fetch-Site` is checked as an independent second signal.
 *
 * The cost is real and is accepted: an admin endpoint cannot be driven by curl
 * without setting a header. The tests set it, which is the point — they
 * exercise the rule instead of routing around it.
 *
 * ===========================================================================
 * 4. NO MUTATION ON GET
 * ===========================================================================
 * `SameSite=Lax` DOES send the cookie on a top-level GET navigation, so
 * `GET /admin/orders/AJ-…/cancel` would be a working CSRF payload delivered by
 * a link in a WhatsApp message. Every state change is a POST, every POST goes
 * through `refuseCrossSite()`, and every POST that is not the sign-in itself
 * additionally carries the per-session CSRF token below.
 *
 * ===========================================================================
 * 5. TWO GATES, NOT ONE
 * ===========================================================================
 * `proxy.ts` is the coarse gate and does the cheap check only — is there a
 * well-formed, correctly-signed cookie. `requireAdmin()` is the fine gate and
 * does the real one: the D1 row, revocation, both clocks, and `is_active`.
 * Both, always. A matcher typo is a silent total bypass, and the failure mode
 * of relying on either alone is complete.
 */

import { env } from "cloudflare:workers";

import {
  d1CartDb,
  type CartDb,
  type CartStatement,
  type SqlRow,
  type SqlValue,
} from "../_data/cart";
import {
  ADMIN_ACTIONS,
  auditStatement,
  mirrorAuditRow,
  toAuditRow,
  writeAudit,
  type AuditRow,
} from "./audit";
import {
  ADMIN_KDF_ALGO,
  adminPepper,
  base64UrlEncode,
  constantTimeEqualsEncoded,
  hmacSha256,
  isLockedOut,
  lockoutUntilMs,
  normalisePassphrase,
  randomBytes,
  sha256Text,
  verifyPassword,
} from "./auth";

export { SIGN_IN_FAILED } from "./auth";

/* =========================================================================
 * Constants
 * ====================================================================== */

/** See the `__Host-` note in the header comment. */
export const ADMIN_SESSION_COOKIE = "__Host-aj_admin";

/**
 * Idle timeout. A counter terminal in a jewellery shop is visible from the
 * street; eight hours is one working day and no more.
 */
export const ADMIN_IDLE_SECONDS = 8 * 60 * 60;

/** Absolute lifetime. The session dies at this however busy the shop is. */
export const ADMIN_ABSOLUTE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Do not write `last_seen_at` more often than this. Without it every admin
 * page view is a D1 write, which on a single-threaded database that already
 * SSRs every page is a cost with no reader.
 */
const SLIDE_MIN_SECONDS = 60;

/** Where a successful sign-in lands. Task 2.1 of the M3 plan builds this page. */
export const ADMIN_HOME_PATH = "/admin";
export const ADMIN_LOGIN_PATH = "/admin/login";

/**
 * Public admin paths — reachable without a session, because the sign-in has to
 * be. Everything else under `/admin` and `/api/admin` is gated. Exported so
 * `proxy.ts` and the route-enumeration test read the SAME list; a path that is
 * public in one and gated in the other is the bug this constant prevents.
 */
export const PUBLIC_ADMIN_PATHS: readonly string[] = [
  ADMIN_LOGIN_PATH,
  "/api/admin/session",
];

export function isPublicAdminPath(pathname: string): boolean {
  return PUBLIC_ADMIN_PATHS.includes(pathname);
}

export function isAdminPath(pathname: string): boolean {
  return (
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname === "/api/admin" ||
    pathname.startsWith("/api/admin/")
  );
}

/** Every admin response carries these. */
export const ADMIN_RESPONSE_HEADERS = {
  // A cached admin response is one admin's data served to another.
  "Cache-Control": "no-store, max-age=0",
  // The root layout sets `robots: { index: true }` and app/robots.ts only
  // disallows /api/, so without this the sign-in page is indexable.
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "same-origin",
} as const;

/* =========================================================================
 * The database
 * ====================================================================== */

/**
 * The admin's D1 handle. Deliberately `d1CartDb` and not a second adapter:
 * `meta.changes` is the arbitration signal for every guarded write in this
 * project, and a second adapter that reports it differently breaks the cart
 * claim and the stock decrement subtly, under concurrency only.
 *
 * A throw rather than a fallback, for the reason `getCartDb()` gives: an admin
 * panel that cannot read the database is not an admin panel, and must say so
 * rather than render an empty one.
 */
export function getAdminDb(): CartDb {
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable, so no admin can be authenticated."
    );
  }
  return d1CartDb(env.DB);
}

/* =========================================================================
 * The token and its signature
 * ====================================================================== */

const TOKEN_BYTES = 32;
/** 32 bytes, base64url, unpadded. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const COOKIE_VALUE_PATTERN = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/;

function sessionSecret(): string {
  const value = (env as unknown as Record<string, unknown>).ADMIN_SESSION_SECRET;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

const encoder = new TextEncoder();

/** 256 bits from a CSPRNG. Never derived from an email, a clock or a counter. */
export function newSessionToken(): string {
  return base64UrlEncode(randomBytes(TOKEN_BYTES));
}

export function isWellFormedSessionToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN_PATTERN.test(value);
}

async function macFor(token: string, secret: string): Promise<string> {
  return base64UrlEncode(await hmacSha256(encoder.encode(secret), `session:${token}`));
}

/** `<token>.<mac>` — what actually sits in the cookie. */
export async function toCookieValue(token: string): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error("ADMIN_SESSION_SECRET is not set.");
  return `${token}.${await macFor(token, secret)}`;
}

/**
 * The token inside a cookie value, or null — WITHOUT touching the database.
 * Shape first, then the MAC, both before any query. A forged or truncated
 * cookie must not cost a D1 round trip.
 */
export async function tokenFromCookieValue(value: string | null): Promise<string | null> {
  if (!value) return null;
  const match = COOKIE_VALUE_PATTERN.exec(value);
  if (!match) return null;

  const secret = sessionSecret();
  if (!secret) return null;

  const [, token, presented] = match;
  const expected = await macFor(token, secret);
  return constantTimeEqualsEncoded(expected, presented) ? token : null;
}

/** Read the raw admin cookie out of a `Cookie:` header. */
export function readAdminCookieValue(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== ADMIN_SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    return value || null;
  }
  return null;
}

/**
 * The `Set-Cookie` header, hand-built rather than via `cookies().set()`.
 *
 * Two reasons. It has to be attached to the exact `Response` the handler
 * returns, including a 303 — the same argument `app/api/cart/route.ts` makes.
 * And `cookies().set()` serialises `SameSite=lax` in lower case, so a test
 * asserting the house `SameSite=Lax` spelling would fail against it; building
 * the string here keeps one spelling across the project.
 */
export function adminSessionCookieHeader(value: string, maxAgeSeconds: number): string {
  return [
    `${ADMIN_SESSION_COOKIE}=${value}`,
    // __Host- REQUIRES Path=/ and forbids Domain. Do not "tighten" this to
    // /admin: it would both break the prefix and miss /api/admin entirely.
    "Path=/",
    `Max-Age=${Math.max(0, Math.trunc(maxAgeSeconds))}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

/** Expire it. Same attributes, or the browser keeps the original. */
export function clearedAdminSessionCookieHeader(): string {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

/* =========================================================================
 * CSRF
 * ====================================================================== */

/**
 * The synchroniser token, DERIVED from the session token rather than stored.
 *
 *   csrf = base64url(HMAC(ADMIN_SESSION_SECRET, "csrf:" + sessionToken))
 *
 * Deriving means there is no column to leak: a D1 dump yields neither the
 * session token nor the CSRF token. It is bound to exactly one session, so a
 * token minted for one admin is worthless in another's form, and rotating the
 * session rotates it for free.
 *
 * Origin checking alone is not enough for this — it depends on a header the
 * shop does not control and cannot audit.
 */
export async function csrfTokenFor(sessionToken: string): Promise<string> {
  const secret = sessionSecret();
  if (!secret) throw new Error("ADMIN_SESSION_SECRET is not set.");
  return base64UrlEncode(await hmacSha256(encoder.encode(secret), `csrf:${sessionToken}`));
}

export async function verifyCsrfToken(
  sessionToken: string,
  presented: string | null
): Promise<boolean> {
  if (!presented) return false;
  return constantTimeEqualsEncoded(await csrfTokenFor(sessionToken), presented);
}

/* =========================================================================
 * Origin
 * ====================================================================== */

export type OriginRefusal = "missing-origin" | "cross-site" | null;

/**
 * The inverse of `isCrossSite()` in `app/api/cart/route.ts`: a MISSING origin
 * is refused. See §3 of the header comment for why the storefront's deliberate
 * permissiveness is a hole on this side of the door.
 */
export function refuseCrossSite(request: Request): OriginRefusal {
  const origin = request.headers.get("origin");
  if (!origin || origin === "null") return "missing-origin";

  // A second, independent signal. Absent on older browsers, so absence is not
  // itself a refusal — but any value other than same-origin is.
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return "cross-site";

  let host = request.headers.get("host");
  if (!host) {
    try {
      host = new URL(request.url).host;
    } catch {
      return "cross-site";
    }
  }

  try {
    return new URL(origin).host === host ? null : "cross-site";
  } catch {
    // An Origin that is not a URL was not written by a browser.
    return "cross-site";
  }
}

/* =========================================================================
 * Reading a session
 * ====================================================================== */

export type SessionRefusal =
  | "misconfigured"
  | "no-cookie"
  | "bad-signature"
  | "unknown-session"
  | "revoked"
  | "expired"
  | "idle"
  | "deactivated";

export type AdminIdentity = {
  readonly sessionId: string;
  readonly adminUserId: string;
  readonly email: string;
  readonly displayName: string | null;
  readonly role: "owner" | "manager" | "staff";
  readonly expiresAt: string;
  readonly idleExpiresAt: string;
  /** For any form this admin is about to be shown. */
  readonly csrfToken: string;
};

export type SessionOutcome =
  | { readonly ok: true; readonly identity: AdminIdentity }
  | { readonly ok: false; readonly reason: SessionRefusal };

const SELECT_SESSION = `
  SELECT
    s.id                AS session_id,
    s.admin_user_id     AS admin_user_id,
    s.expires_at        AS expires_at,
    s.idle_expires_at   AS idle_expires_at,
    s.revoked_at        AS revoked_at,
    s.last_seen_at      AS last_seen_at,
    u.email             AS email,
    u.display_name      AS display_name,
    u.role              AS role,
    u.is_active         AS is_active
  FROM admin_sessions s
  JOIN admin_users u ON u.id = s.admin_user_id
  WHERE s.token_hash = ?
`;

function text(row: SqlRow, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function asRole(value: string | null): "owner" | "manager" | "staff" {
  return value === "owner" || value === "manager" ? value : "staff";
}

function parseMs(value: string | null): number {
  if (!value) return Number.NaN;
  return Date.parse(value);
}

/**
 * The fine gate. One indexed read, then every condition that a signed cookie
 * cannot express.
 *
 * `nowMs` is injected rather than read from the clock, following every other
 * data-layer function in this project (`app/_data/cart.ts`,
 * `app/_pricing/rates.ts`), so the expiry tests are assertions rather than
 * sleeps.
 */
export async function readSession(
  db: CartDb,
  request: Request,
  { nowMs = Date.now() }: { nowMs?: number } = {}
): Promise<SessionOutcome> {
  if (!sessionSecret()) return { ok: false, reason: "misconfigured" };

  const cookieValue = readAdminCookieValue(request.headers.get("cookie"));
  if (!cookieValue) return { ok: false, reason: "no-cookie" };

  const token = await tokenFromCookieValue(cookieValue);
  if (!token) return { ok: false, reason: "bad-signature" };

  const [row] = await db.all(SELECT_SESSION, [await sha256Text(token)]);
  if (!row) return { ok: false, reason: "unknown-session" };

  if (text(row, "revoked_at")) return { ok: false, reason: "revoked" };

  const expiresAt = text(row, "expires_at");
  const idleExpiresAt = text(row, "idle_expires_at");
  if (!(parseMs(expiresAt) > nowMs)) return { ok: false, reason: "expired" };
  if (!(parseMs(idleExpiresAt) > nowMs)) return { ok: false, reason: "idle" };

  // Re-read on every request, so a deactivation takes effect on the next
  // click. This is the single test that a stateless signed cookie fails.
  if (Number(row.is_active ?? 0) !== 1) return { ok: false, reason: "deactivated" };

  const sessionId = text(row, "session_id") ?? "";
  const adminUserId = text(row, "admin_user_id") ?? "";
  const email = text(row, "email") ?? "";

  await slideIdleWindow(db, {
    sessionId,
    adminUserId,
    lastSeenAt: text(row, "last_seen_at"),
    expiresAt: expiresAt ?? "",
    nowMs,
  });

  return {
    ok: true,
    identity: {
      sessionId,
      adminUserId,
      email,
      displayName: text(row, "display_name"),
      role: asRole(text(row, "role")),
      expiresAt: expiresAt ?? "",
      idleExpiresAt: idleExpiresAt ?? "",
      csrfToken: await csrfTokenFor(token),
    },
  };
}

const SLIDE_SESSION = `
  UPDATE admin_sessions
     SET last_seen_at = ?, idle_expires_at = ?
   WHERE id = ? AND revoked_at IS NULL
`;

const TOUCH_ADMIN_USER = `UPDATE admin_users SET last_seen_at = ? WHERE id = ?`;

/**
 * Push the idle window forward, clamped to the absolute expiry — the CHECK
 * `idle_expires_at <= expires_at` refuses anything else, so the clamp is not
 * politeness, it is what stops the batch aborting an otherwise fine request.
 *
 * Rate-limited to one write a minute per session. A failure here is swallowed:
 * an admin whose "last seen" timestamp did not update is not an admin who
 * should be thrown out.
 */
async function slideIdleWindow(
  db: CartDb,
  input: {
    sessionId: string;
    adminUserId: string;
    lastSeenAt: string | null;
    expiresAt: string;
    nowMs: number;
  }
): Promise<void> {
  const lastSeenMs = parseMs(input.lastSeenAt);
  if (Number.isFinite(lastSeenMs) && input.nowMs - lastSeenMs < SLIDE_MIN_SECONDS * 1000) {
    return;
  }

  const absoluteMs = parseMs(input.expiresAt);
  const idleMs = Math.min(
    input.nowMs + ADMIN_IDLE_SECONDS * 1000,
    Number.isFinite(absoluteMs) ? absoluteMs : input.nowMs + ADMIN_IDLE_SECONDS * 1000
  );
  const now = new Date(input.nowMs).toISOString();

  try {
    await db.batch([
      { sql: SLIDE_SESSION, params: [now, new Date(idleMs).toISOString(), input.sessionId] },
      { sql: TOUCH_ADMIN_USER, params: [now, input.adminUserId] },
    ]);
  } catch (error) {
    console.error("[admin-session] could not slide the idle window:", error);
  }
}

/* =========================================================================
 * requireAdmin — the call every admin route owes
 * ====================================================================== */

/**
 * `proxy.ts` is defence; this is the defence. A Server Action is invoked by
 * POST to the URL of the page that imported it, so an action defined in an
 * admin module but rendered by a public page is reachable without ever passing
 * the matcher. No matcher expression closes that — only this call in the body
 * does.
 */
export async function requireAdmin(
  request: Request,
  { nowMs = Date.now(), db }: { nowMs?: number; db?: CartDb } = {}
): Promise<SessionOutcome> {
  let handle: CartDb;
  try {
    handle = db ?? getAdminDb();
  } catch {
    return { ok: false, reason: "misconfigured" };
  }
  return readSession(handle, request, { nowMs });
}

/* =========================================================================
 * Sign in
 * ====================================================================== */

const SELECT_ADMIN_BY_EMAIL = `
  SELECT id, email, display_name, role, is_active,
         password_hash, password_salt, password_algo, password_iterations,
         failed_login_count, locked_until
    FROM admin_users
   WHERE email = ?
`;

const INSERT_SESSION = `
  INSERT INTO admin_sessions (
    id, admin_user_id, token_hash, created_at, expires_at, idle_expires_at,
    last_seen_at, user_agent, ip
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const REVOKE_BY_TOKEN_HASH = `
  UPDATE admin_sessions
     SET revoked_at = ?, revoked_reason = ?
   WHERE token_hash = ? AND revoked_at IS NULL
`;

const REVOKE_BY_ID = `
  UPDATE admin_sessions
     SET revoked_at = ?, revoked_reason = ?
   WHERE id = ? AND revoked_at IS NULL
`;

const CLEAR_FAILURES = `
  UPDATE admin_users
     SET failed_login_count = 0, locked_until = NULL, last_login_at = ?, last_seen_at = ?
   WHERE id = ?
`;

const RECORD_FAILURE = `
  UPDATE admin_users
     SET failed_login_count = ?, locked_until = ?
   WHERE id = ?
`;

/**
 * A fixed salt used only to spend the KDF when there is no account to check
 * against, so "that address has no seat" and "that passphrase is wrong" cost
 * the same. Sixteen zero bytes: it protects nothing and is not supposed to.
 */
const DUMMY_SALT = "AAAAAAAAAAAAAAAAAAAAAA";

export type SignInInput = {
  readonly db: CartDb;
  readonly email: string;
  readonly password: string;
  readonly nowMs?: number;
  readonly userAgent?: string | null;
  readonly ip?: string | null;
  /** The cookie that ARRIVED with the sign-in. Revoked, never adopted. */
  readonly presentedCookieValue?: string | null;
};

export type SignInOutcome =
  | {
      readonly ok: true;
      readonly cookieValue: string;
      readonly maxAgeSeconds: number;
      readonly identity: AdminIdentity;
    }
  | { readonly ok: false; readonly reason: SignInRefusal };

/**
 * Why a sign-in failed. FOR THE LOG ONLY. Every one of these is rendered to
 * the visitor as `SIGN_IN_FAILED`, one string, no exceptions — a message that
 * appears on only one path is an oracle.
 */
export type SignInRefusal =
  | "misconfigured"
  | "empty"
  | "no-such-admin"
  | "no-credential"
  | "deactivated"
  | "throttled"
  | "wrong-password"
  | "write-failed";

function credentialFrom(row: SqlRow) {
  const iterations = Number(row.password_iterations ?? 0);
  return {
    hash: text(row, "password_hash") ?? "",
    salt: text(row, "password_salt") ?? "",
    algo: text(row, "password_algo") ?? "",
    iterations: Number.isFinite(iterations) ? iterations : 0,
  };
}

/** An attacker-supplied address is capped before it goes anywhere near a row. */
function normaliseEmail(raw: string): string {
  return raw.trim().toLowerCase().slice(0, 160);
}

/**
 * Authenticate, and on success mint a session.
 *
 * Everything about the ORDER of the steps below is deliberate:
 *
 *  1. A misconfigured server (no pepper, no session secret) refuses before it
 *     touches anything. An unset secret is a 503, never an open door.
 *  2. A throttled account returns EARLY, without spending the KDF. This is the
 *     one place the cost is not equalised and it is a considered trade: making
 *     a locked-out account expensive would let anyone burn the shop's whole
 *     free-plan CPU budget by guessing at an address they already know. The
 *     residual signal — "this address has a seat and is currently backed off" —
 *     is only observable to someone who has already failed six times against
 *     it, at which point they have learned nothing new.
 *  3. Every OTHER failing path spends the same KDF, including the one where no
 *     such admin exists, so response time does not enumerate the seats.
 *  4. The successful write is ONE batch: revoke the presented session, insert
 *     the new one, clear the failure counter, and write the audit row. If any
 *     part fails, none of it happened — there is no state in which a session
 *     exists but its audit row does not.
 */
export async function signIn(input: SignInInput): Promise<SignInOutcome> {
  const nowMs = input.nowMs ?? Date.now();
  const now = new Date(nowMs).toISOString();
  const email = normaliseEmail(input.email);
  const password = normalisePassphrase(input.password);

  const pepper = adminPepper();
  const secret = sessionSecret();
  if (!pepper || !secret) {
    console.error(
      "[admin-session] refusing every sign-in: ADMIN_PASSWORD_PEPPER and/or ADMIN_SESSION_SECRET is unset. " +
        "An unset secret must never mean 'anyone may sign in'."
    );
    return { ok: false, reason: "misconfigured" };
  }

  const audit = async (
    reason: SignInRefusal,
    adminUserId: string | null
  ): Promise<void> => {
    await writeAudit(input.db, {
      actorEmail: email || "(none)",
      actorAdminUserId: adminUserId,
      action: ADMIN_ACTIONS.signInRefused,
      entityType: "admin_session",
      entityId: null,
      // `reason` is on the admin_session allowlist: it names a code path, not
      // a person, and it is the only place the real reason is ever written.
      diff: { reason: { from: null, to: reason } },
      result: "refused",
      ip: input.ip,
      userAgent: input.userAgent,
      nowMs,
    });
  };

  if (!email || !password) {
    await audit("empty", null);
    return { ok: false, reason: "empty" };
  }

  const [row] = await input.db.all(SELECT_ADMIN_BY_EMAIL, [email]);

  if (!row) {
    // Spend the KDF so a nonexistent seat costs what a real one does.
    await verifyPassword(
      password,
      { hash: "", salt: DUMMY_SALT, algo: ADMIN_KDF_ALGO, iterations: 25_000 },
      pepper
    );
    await audit("no-such-admin", null);
    return { ok: false, reason: "no-such-admin" };
  }

  const adminUserId = text(row, "id") ?? "";

  if (isLockedOut(text(row, "locked_until"), nowMs)) {
    await audit("throttled", adminUserId);
    return { ok: false, reason: "throttled" };
  }

  const credential = credentialFrom(row);
  const active = Number(row.is_active ?? 0) === 1;
  const hasCredential = Boolean(credential.hash && credential.salt && credential.algo);

  const matched = hasCredential
    ? await verifyPassword(password, credential, pepper)
    : await verifyPassword(
        password,
        { hash: "", salt: DUMMY_SALT, algo: ADMIN_KDF_ALGO, iterations: 25_000 },
        pepper
      );

  if (!hasCredential || !active || !matched) {
    const failures = Number(row.failed_login_count ?? 0) + 1;
    const lockedUntil = lockoutUntilMs(failures, nowMs);
    const reason: SignInRefusal = !hasCredential
      ? "no-credential"
      : !active
        ? "deactivated"
        : "wrong-password";

    // The counter read above and this write are not atomic, so two concurrent
    // failures can record one increment. Accepted: the backoff is a brake on a
    // sequential guessing campaign, and a parallel one still doubles within a
    // few rounds.
    const failureRow = toAuditRow({
      actorEmail: email,
      actorAdminUserId: adminUserId,
      action: ADMIN_ACTIONS.signInRefused,
      entityType: "admin_session",
      entityId: null,
      diff: { reason: { from: null, to: reason } },
      result: "refused",
      ip: input.ip,
      userAgent: input.userAgent,
      nowMs,
    });

    try {
      await input.db.batch([
        {
          sql: RECORD_FAILURE,
          params: [
            failures,
            lockedUntil === null ? null : new Date(lockedUntil).toISOString(),
            adminUserId,
          ],
        },
        auditStatement(failureRow),
      ]);
    } catch (error) {
      console.error("[admin-session] could not record a failed sign-in:", error);
    }
    await mirrorAuditRow(failureRow);

    return { ok: false, reason };
  }

  /* ---- authenticated ---------------------------------------------------- */

  const token = newSessionToken();
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(nowMs + ADMIN_ABSOLUTE_SECONDS * 1000).toISOString();
  const idleExpiresAt = new Date(nowMs + ADMIN_IDLE_SECONDS * 1000).toISOString();

  const statements: CartStatement[] = [];

  // SESSION FIXATION: whatever token arrived is revoked, never adopted. The
  // hash is computed from the presented cookie, so this closes even the case
  // where an attacker planted a session they themselves hold.
  const presentedToken = await tokenFromCookieValue(input.presentedCookieValue ?? null);
  if (presentedToken) {
    statements.push({
      sql: REVOKE_BY_TOKEN_HASH,
      params: [now, "superseded", await sha256Text(presentedToken)],
    });
  }

  statements.push({
    sql: INSERT_SESSION,
    params: [
      sessionId,
      adminUserId,
      await sha256Text(token),
      now,
      expiresAt,
      idleExpiresAt,
      now,
      input.userAgent ? input.userAgent.slice(0, 200) : null,
      input.ip ? input.ip.slice(0, 64) : null,
    ] satisfies SqlValue[],
  });

  statements.push({ sql: CLEAR_FAILURES, params: [now, now, adminUserId] });

  const successRow: AuditRow = toAuditRow({
    actorEmail: email,
    actorAdminUserId: adminUserId,
    action: ADMIN_ACTIONS.signInSucceeded,
    entityType: "admin_session",
    // The SESSION ROW id, which is a database identifier and not a credential.
    // The token, its hash and the cookie value appear nowhere in this log.
    entityId: sessionId,
    result: "ok",
    ip: input.ip,
    userAgent: input.userAgent,
    nowMs,
  });
  statements.push(auditStatement(successRow));

  try {
    await input.db.batch(statements);
  } catch (error) {
    console.error("[admin-session] could not create a session:", error);
    return { ok: false, reason: "write-failed" };
  }

  await mirrorAuditRow(successRow);

  return {
    ok: true,
    cookieValue: await toCookieValue(token),
    maxAgeSeconds: ADMIN_ABSOLUTE_SECONDS,
    identity: {
      sessionId,
      adminUserId,
      email,
      displayName: text(row, "display_name"),
      role: asRole(text(row, "role")),
      expiresAt,
      idleExpiresAt,
      csrfToken: await csrfTokenFor(token),
    },
  };
}

/* =========================================================================
 * Sign out
 * ====================================================================== */

/**
 * Revoke the row, not just the cookie. A sign-out that only clears the browser
 * leaves a live session behind for anyone who captured the cookie, which is
 * precisely the failure the session table exists to prevent.
 *
 * `revoked_at` is set; nothing is deleted, so "when did this session end" stays
 * answerable.
 */
export async function signOut(
  db: CartDb,
  identity: AdminIdentity,
  { nowMs = Date.now(), ip, userAgent }: { nowMs?: number; ip?: string | null; userAgent?: string | null } = {}
): Promise<void> {
  const now = new Date(nowMs).toISOString();

  const row = toAuditRow({
    actorEmail: identity.email,
    actorAdminUserId: identity.adminUserId,
    action: ADMIN_ACTIONS.signedOut,
    entityType: "admin_session",
    entityId: identity.sessionId,
    diff: { revoked_reason: { from: null, to: "signed_out" } },
    result: "ok",
    ip,
    userAgent,
    nowMs,
  });

  try {
    await db.batch([
      { sql: REVOKE_BY_ID, params: [now, "signed_out", identity.sessionId] },
      auditStatement(row),
    ]);
  } catch (error) {
    console.error("[admin-session] could not revoke a session on sign-out:", error);
  }

  await mirrorAuditRow(row);
}
