/**
 * ADMIN CREDENTIALS — the KDF, the pepper, the passphrase, and the throttle.
 *
 * ===========================================================================
 * REQUIRED ENVIRONMENT
 * ===========================================================================
 * Documented here because this module owns these variables and `.env.example`
 * is not this task's file to edit. All three are Worker SECRETS: set them in
 * the hosting control plane, never in a committed file.
 *
 *   # ADMIN_PASSWORD_PEPPER — REQUIRED. A 256-bit key that is HMAC'd over the
 *   # passphrase BEFORE the KDF sees it, and that never touches the database.
 *   # It is the reason a D1-only leak yields nothing crackable: the attacker
 *   # holds the salt, the iteration count and the derived key, and is still
 *   # missing a key they cannot brute force.
 *   #
 *   # Generate:  openssl rand -hex 32
 *   # Rotate:    every stored hash becomes unverifiable, so rotation means
 *   #            re-issuing every passphrase with scripts/create-admin.mjs.
 *   #            That is also the out-of-band unlock for a locked-out owner.
 *   ADMIN_PASSWORD_PEPPER=
 *
 *   # ADMIN_SESSION_SECRET — REQUIRED. See app/_admin/session.ts.
 *   ADMIN_SESSION_SECRET=
 *
 *   # ADMIN_KDF_ITERATIONS — OPTIONAL. PBKDF2 iteration count for passwords
 *   # set from now on. Clamped to [10000, 100000]; default 25000. Raise it the
 *   # moment the Workers plan tier is confirmed as paid — see below. Existing
 *   # rows keep verifying at the count stored against them, so raising this
 *   # never locks anyone out.
 *   ADMIN_KDF_ITERATIONS=
 *
 * ===========================================================================
 * THE WORK FACTOR, MEASURED RATHER THAN INHERITED
 * ===========================================================================
 * Cloudflare Workers offers PBKDF2 and nothing else: no Argon2id, no bcrypt,
 * no scrypt through WebCrypto, and a documented 100,000-iteration ceiling.
 * OWASP wants Argon2id, or PBKDF2-HMAC-SHA-256 at >= 600,000 where FIPS forces
 * PBKDF2. So the KDF here is roughly one twenty-fourth of the recommended work
 * factor and there is no path to the recommended algorithm.
 *
 * Measured on this machine's real `workerd` (v1.20260515.1, `nodejs_compat`,
 * best of five after a warm-up, 16-byte salt, 256-bit output):
 *
 *     10,000    1 ms          100,000    7-8 ms
 *     25,000    2-3 ms        200,000   16 ms
 *     50,000    4-5 ms        600,000   46 ms
 *     75,000    5-6 ms
 *
 * (The local binary accepted counts above 100,000 and scaled linearly, so it
 * does not enforce the documented cap. Production may; nothing here goes near
 * it either way. HMAC-SHA-256, which runs on EVERY admin request, measured 100
 * signatures in 1 ms — it is free by comparison, which is why the expensive
 * primitive runs only at sign-in.)
 *
 * The Workers FREE plan allows 10 ms of CPU per invocation and WHICH PLAN THIS
 * ACCOUNT IS ON IS UNVERIFIED. 100,000 iterations spends 7-8 ms of that budget
 * on an Apple-silicon laptop core; Cloudflare's edge cores are slower, so on
 * the free plan a 100,000-iteration sign-in would very likely be killed — and
 * killed in production only, because tests run at a reduced count and a laptop
 * has no CPU ceiling at all. That is the single most likely way this feature
 * ships broken, so it is not being risked.
 *
 * DEFAULT: 25,000. It measured 2-3 ms, which leaves the rest of a free-plan
 * request its budget even if the edge core is three times slower than this one.
 *
 * The honest justification for a number OWASP would reject is that the KDF is
 * deliberately not load-bearing here. Two things carry this design instead:
 *
 *   (a) the passphrase is GENERATED at ~100 bits and never chosen by a human,
 *       so there is no dictionary, no reuse and no breach-corpus hit to make
 *       an offline attack cheaper than exhausting a 100-bit space; and
 *   (b) the pepper is not in the database, so a D1-only leak — which is by far
 *       the realistic compromise — yields nothing to attack at all.
 *
 * At 100 bits behind a 256-bit pepper, the difference between 25,000 and
 * 600,000 iterations is the difference between two unreachable numbers. What
 * the iteration count must actually do is not break the login, and 25,000 does
 * that with margin. `password_iterations` is stored per row precisely so this
 * can be raised to 100,000 by setting one variable once the plan is known to
 * be paid; rows written before then keep verifying at their own count.
 */

import { env } from "cloudflare:workers";

/* =========================================================================
 * The single sign-in failure string
 * ====================================================================== */

/**
 * ONE STRING FOR EVERY FAILING PATH, and there are seven of them: no such
 * email, no password ever issued for that seat, the seat is deactivated, the
 * wrong passphrase, an empty submission, a throttled attempt, and a
 * misconfigured server with no pepper or no session secret.
 *
 * A message that appears on only one of those paths is an oracle. "No such
 * user" tells an attacker which addresses have seats; "try again in 4 minutes"
 * tells them the throttle is real and how to pace around it; "at least 20
 * characters" tells them the shape of what they are guessing. So there is no
 * lockout countdown, no forgot-password link, no length hint and no field-level
 * error — the form says one thing, and what actually happened is in the audit
 * log where only the shop can read it.
 *
 * The one thing it must NOT be is a lie of omission: the recovery path for a
 * genuinely locked-out owner is out of band (re-issue with
 * scripts/create-admin.mjs), and the copy says so without saying why they are
 * locked out.
 */
export const SIGN_IN_FAILED =
  "Those sign-in details were not accepted. If you are sure they are right, the shop's own copy of the passphrase may need to be re-issued.";

/* =========================================================================
 * Encoding helpers
 *
 * base64url everywhere: `+` and `/` are not safe in a cookie value and `=`
 * padding is noise. These are the only two places bytes and text meet.
 * ====================================================================== */

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** CSPRNG bytes. `crypto.getRandomValues` is CSPRNG-backed on Workers. */
export function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

/* =========================================================================
 * Constant-time comparison
 * ====================================================================== */

/**
 * Length-independent, byte-wise, no early return. Character-for-character the
 * rule `secretsMatch()` applies in `app/api/gold-rate/route.ts`, which is not
 * imported because it is module-private there and that file is not this task's
 * to edit.
 *
 * NOTE, correcting the comment above that implementation: `timingSafeEqual`
 * IS available on this runtime — both as `crypto.subtle.timingSafeEqual` and
 * from `node:crypto` under `nodejs_compat` (verified against workerd
 * v1.20260515.1). It is not used here for two reasons. It throws on a length
 * mismatch, so every caller would need a length branch that is itself a timing
 * signal; and `crypto.subtle.timingSafeEqual` is a Workers extension that the
 * plain-Node test harness does not have, so the code under test would not be
 * the code that ships.
 */
export function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

/** The same comparison over two base64url strings, decoded first. */
export function constantTimeEqualsEncoded(a: string, b: string): boolean {
  // A malformed encoding must not throw and reveal which side was malformed.
  let left: Uint8Array;
  let right: Uint8Array;
  try {
    left = base64UrlDecode(a);
  } catch {
    left = new Uint8Array(0);
  }
  try {
    right = base64UrlDecode(b);
  } catch {
    right = new Uint8Array(1);
  }
  return left.length > 0 && constantTimeEquals(left, right);
}

/* =========================================================================
 * Primitives
 * ====================================================================== */

const encoder = new TextEncoder();

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

/** SHA-256 of a string, base64url. Used for `admin_sessions.token_hash`. */
export async function sha256Text(value: string): Promise<string> {
  return base64UrlEncode(await sha256(encoder.encode(value)));
}

export async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message))
  );
}

/* =========================================================================
 * Environment
 * ====================================================================== */

function readSecret(name: string): string {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

/**
 * The pepper, or "". Callers FAIL CLOSED on the empty string, exactly as
 * `refuseUnauthorised()` does for the rate ingest token: an unset secret must
 * never mean "anyone may sign in", and it must not silently mean "peppered
 * with nothing" either, because that would make every stored hash crackable
 * from a D1 dump the moment someone forgot to set a variable.
 */
export function adminPepper(): string {
  return readSecret("ADMIN_PASSWORD_PEPPER");
}

export const ADMIN_KDF_ALGO = "pbkdf2-sha256-pepper-v1";
export const KDF_ITERATIONS_FLOOR = 10_000;
export const KDF_ITERATIONS_CEILING = 100_000;
export const DEFAULT_KDF_ITERATIONS = 25_000;

/**
 * The iteration count for passwords set FROM NOW ON. Clamped at both ends: the
 * ceiling is the platform's documented cap, and the floor exists so a typo or
 * a hostile environment cannot quietly turn the KDF into a single hash.
 */
export function kdfIterations(): number {
  const raw = Number(readSecret("ADMIN_KDF_ITERATIONS"));
  if (!Number.isInteger(raw) || raw <= 0) return DEFAULT_KDF_ITERATIONS;
  return Math.min(KDF_ITERATIONS_CEILING, Math.max(KDF_ITERATIONS_FLOOR, raw));
}

/* =========================================================================
 * The KDF
 * ====================================================================== */

/** Exactly what `admin_users` stores for one seat. */
export type StoredCredential = {
  readonly hash: string;
  readonly salt: string;
  readonly algo: string;
  readonly iterations: number;
};

export type DeriveInput = {
  readonly password: string;
  /** base64url, from `admin_users.password_salt`. */
  readonly salt: string;
  readonly iterations: number;
  readonly pepper: string;
};

/**
 * Pepper, then stretch.
 *
 *   peppered = HMAC-SHA-256(pepper, passphrase)      32 bytes, ~0.01 ms
 *   derived  = PBKDF2-SHA-256(peppered, salt, n)     32 bytes
 *
 * The pepper is applied FIRST and as an HMAC rather than by concatenation:
 * concatenation is length-extendable and makes the boundary between the two
 * inputs ambiguous, and HMAC costs nothing measurable next to the PBKDF2 that
 * follows it.
 *
 * The PBKDF2 input is therefore always exactly 32 high-entropy bytes, which
 * also means a pathological passphrase — empty, or a megabyte long — cannot
 * change the cost of this function.
 */
export async function derivePasswordHash(input: DeriveInput): Promise<string> {
  if (!input.pepper) {
    throw new Error(
      "ADMIN_PASSWORD_PEPPER is not set, so no admin password can be derived or verified. Set it as a Worker secret in the hosting control plane."
    );
  }
  if (!Number.isInteger(input.iterations) || input.iterations < KDF_ITERATIONS_FLOOR) {
    throw new Error(
      `Refusing to derive an admin password at ${String(input.iterations)} iterations; the floor is ${KDF_ITERATIONS_FLOOR}.`
    );
  }

  const peppered = await hmacSha256(encoder.encode(input.pepper), input.password);

  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    peppered as BufferSource,
    "PBKDF2",
    false,
    ["deriveBits"]
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: base64UrlDecode(input.salt) as BufferSource,
      iterations: input.iterations,
    },
    keyMaterial,
    256
  );

  return base64UrlEncode(new Uint8Array(derived));
}

/** A fresh 16-byte salt, base64url. NIST's floor is 32 bits; take the larger. */
export function newSalt(): string {
  return base64UrlEncode(randomBytes(16));
}

/**
 * Verify a presented passphrase against a stored credential.
 *
 * Returns `false` rather than throwing for anything that is a CREDENTIAL
 * problem, so the caller has one code path and one message. It throws only for
 * a SERVER problem (no pepper), which the caller turns into the same message
 * anyway — the distinction exists for the log, not for the visitor.
 */
export async function verifyPassword(
  password: string,
  credential: StoredCredential,
  pepper: string
): Promise<boolean> {
  if (credential.algo !== ADMIN_KDF_ALGO) return false;
  if (!credential.hash || !credential.salt) return false;
  if (!Number.isInteger(credential.iterations) || credential.iterations <= 0) return false;

  let derived: string;
  try {
    derived = await derivePasswordHash({
      password,
      salt: credential.salt,
      iterations: credential.iterations,
      pepper,
    });
  } catch {
    // A malformed salt, or a stored iteration count below the floor. Neither
    // is the visitor's business and neither may be distinguishable from a
    // wrong passphrase.
    return false;
  }

  return constantTimeEqualsEncoded(derived, credential.hash);
}

/**
 * True when a verified credential was written at a weaker setting than the
 * current one and should be rehashed on this successful sign-in. This is the
 * migration path the per-row columns exist for; nothing calls it yet, and the
 * rehash belongs with the sign-in write when it does.
 */
export function credentialNeedsUpgrade(credential: StoredCredential): boolean {
  return (
    credential.algo !== ADMIN_KDF_ALGO || credential.iterations < kdfIterations()
  );
}

/* =========================================================================
 * The passphrase — generated, never chosen
 * ====================================================================== */

/**
 * Crockford's base32: no I, L, O or U, so nothing is misread off a slip of
 * paper and no accidental word is produced. Same alphabet and the same reason
 * as `newOrderNumber()` in `app/_data/orders.ts`. 256 is an exact multiple of
 * 32, so `byte % 32` is unbiased.
 */
const PASSPHRASE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
/** 20 symbols x 5 bits. */
export const PASSPHRASE_SYMBOLS = 20;
export const PASSPHRASE_ENTROPY_BITS = 100;

/** `4KX9P-2M7TB-J0WQZ-5HRVN`. Grouped so it can be read aloud down a phone. */
export function generatePassphrase(): string {
  const bytes = randomBytes(PASSPHRASE_SYMBOLS);
  let symbols = "";
  for (const byte of bytes) symbols += PASSPHRASE_ALPHABET[byte % PASSPHRASE_ALPHABET.length];
  return (symbols.match(/.{1,5}/g) ?? []).join("-");
}

/**
 * Accepted forms of a generated passphrase: the grouped form, and the same
 * symbols with the hyphens or spaces stripped. Case is normalised UP, because
 * the alphabet is upper-case and a passphrase typed in lower case on a phone
 * keyboard is the same secret.
 *
 * This is normalisation, NOT validation. It deliberately does not reject a
 * string of the wrong length or shape: doing so would refuse before the KDF
 * runs and turn response time into an oracle for "that was not even the right
 * shape". Everything reaches `verifyPassword()` and fails there, at the same
 * cost.
 */
export function normalisePassphrase(raw: string): string {
  return raw.replace(/[\s-]/g, "").toUpperCase();
}

/* =========================================================================
 * Throttling
 * ====================================================================== */

/** Failures tolerated before any delay at all — fat fingers are not attacks. */
export const LOCKOUT_FREE_ATTEMPTS = 5;
/** The first delay, doubling per failure. */
export const LOCKOUT_BASE_SECONDS = 30;
/** The ceiling. Fifteen minutes, and it never grows past it. */
export const LOCKOUT_MAX_SECONDS = 15 * 60;

/**
 * When the next attempt on this seat may be made, or null for "now".
 *
 * INCREASING DELAY WITH A CEILING, NOT A LOCKOUT. There are very few accounts
 * here — often one — so a hard lockout is an attacker-triggerable denial of the
 * shop's own order book: anyone who knows the owner's email address can shut
 * the panel by guessing wrong ten times. A capped backoff costs an online
 * attacker everything (at the ceiling, four guesses an hour against a 100-bit
 * secret) and costs the owner fifteen minutes at absolute worst.
 *
 * The counter is keyed on the ACCOUNT only, not on `(account, source IP)`.
 * Keying on IP would mean storing the addresses of failed attempts — an
 * unbounded table of mostly-attacker IPs, on a platform with no cron to sweep
 * it, in a database that is not in India. The account-only key is weaker
 * against a distributed attacker and is the right trade at this size; a
 * Cloudflare WAF rate-limiting rule in front of `/admin/login` would be
 * strictly better than either and is the real answer if the control plane ever
 * exposes one.
 */
export function lockoutUntilMs(failedCount: number, nowMs: number): number | null {
  if (failedCount <= LOCKOUT_FREE_ATTEMPTS) return null;
  const step = failedCount - LOCKOUT_FREE_ATTEMPTS - 1;
  const seconds = Math.min(LOCKOUT_MAX_SECONDS, LOCKOUT_BASE_SECONDS * 2 ** step);
  return nowMs + seconds * 1000;
}

/** True while `locked_until` is in the future. A null or unparseable value is not a lock. */
export function isLockedOut(lockedUntil: string | null, nowMs: number): boolean {
  if (!lockedUntil) return false;
  const at = Date.parse(lockedUntil);
  return Number.isFinite(at) && at > nowMs;
}
