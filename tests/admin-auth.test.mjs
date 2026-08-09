/**
 * THE ADMIN AUTH FOUNDATION — the KDF, the session, the gate, the audit log.
 *
 * ===========================================================================
 * WHAT IS NOT MOCKED
 * ===========================================================================
 * Everything that decides whether a stranger gets in.
 *
 *   - The KDF runs for real. `derivePasswordHash()` is the production
 *     function, and the fixture admin's stored hash is DERIVED by it rather
 *     than written as a literal — a literal would still pass if the derivation
 *     changed underneath it.
 *   - The session table is real SQLite, built from this project's own
 *     `drizzle/*.sql`, with the real CHECK constraints and the real cascade,
 *     driven through the same `d1CartDb()` adapter production uses.
 *   - The gate is exercised through the BUILT Worker (`npm test` builds first),
 *     so `proxy.ts` is tested as bundled rather than as source.
 *
 * The iteration count is the one thing turned down: `ADMIN_KDF_ITERATIONS` is
 * set to the floor here. The ALGORITHM is what is under test, not the work
 * factor, and twenty sign-ins at the production count would add seconds of pure
 * CPU to a suite that currently runs in under two.
 *
 * ===========================================================================
 * THE SECTIONS
 * ===========================================================================
 *  1. The KDF and the passphrase — pure.
 *  2. The audit diff — pure, and the part that must never leak.
 *  3. The cookie, the signature, the CSRF token and the origin rule — pure.
 *  4. Sessions against real SQLite: fixation, revocation, both clocks,
 *     deactivation, and the throttle.
 *  5. The endpoint through the built Worker.
 *  6. THE GATE, ENUMERATED. Every route under app/admin/** and
 *     app/api/admin/** is discovered off the filesystem and asserted refused
 *     when anonymous. A route added next year is protected by this, not by
 *     someone remembering.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";

import { env } from "cloudflare:workers";

import { buildSeedSql } from "../scripts/seed-catalogue.mjs";
import { fetchWorker } from "./helpers.mjs";

const {
  ADMIN_KDF_ALGO,
  DEFAULT_KDF_ITERATIONS,
  KDF_ITERATIONS_CEILING,
  KDF_ITERATIONS_FLOOR,
  LOCKOUT_FREE_ATTEMPTS,
  LOCKOUT_MAX_SECONDS,
  PASSPHRASE_ENTROPY_BITS,
  SIGN_IN_FAILED,
  base64UrlDecode,
  base64UrlEncode,
  constantTimeEquals,
  credentialNeedsUpgrade,
  derivePasswordHash,
  generatePassphrase,
  isLockedOut,
  kdfIterations,
  lockoutUntilMs,
  newSalt,
  normalisePassphrase,
  sha256Text,
  verifyPassword,
} = await import("../app/_admin/auth.ts");

const {
  AUDIT_VALUE_ALLOWLIST,
  buildDiff,
  isNeverValued,
  mirrorAuditRow,
  mirrorPayload,
  resetMirrorWarning,
  searchDiff,
  toAuditRow,
} = await import("../app/_admin/audit.ts");

const {
  ADMIN_ABSOLUTE_SECONDS,
  ADMIN_IDLE_SECONDS,
  ADMIN_LOGIN_PATH,
  ADMIN_SESSION_COOKIE,
  PUBLIC_ADMIN_PATHS,
  adminSessionCookieHeader,
  clearedAdminSessionCookieHeader,
  csrfTokenFor,
  isAdminPath,
  newSessionToken,
  readAdminCookieValue,
  readSession,
  refuseCrossSite,
  signIn,
  signOut,
  toCookieValue,
  tokenFromCookieValue,
  verifyCsrfToken,
} = await import("../app/_admin/session.ts");

const { d1CartDb } = await import("../app/_data/cart.ts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* =========================================================================
 * Fixtures
 * ====================================================================== */

const PEPPER = "test-pepper-0123456789abcdef0123456789abcdef";
const SESSION_SECRET = "test-session-secret-fedcba9876543210";
const ADMIN_EMAIL = "owner@alankar.test";
const OTHER_EMAIL = "manager@alankar.test";
const ORIGIN = "http://localhost";

/** T0 for every clock in this file. Nothing here reads the wall clock. */
const T0 = Date.parse("2026-08-09T09:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function toBindable(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  return value;
}

const READS = /^\s*(?:select|pragma|with)\b/i;

function makeStatement(sqlite, sql, params) {
  const execute = () => {
    const bound = params.map(toBindable);
    const prepared = sqlite.prepare(sql);

    if (READS.test(sql) || /\breturning\b/i.test(sql)) {
      const results = prepared.all(...bound);
      return { results, success: true, meta: { changes: 0, rows_read: results.length } };
    }

    const info = prepared.run(...bound);
    return {
      results: [],
      success: true,
      meta: {
        changes: Number(info.changes),
        last_row_id: Number(info.lastInsertRowid),
        rows_written: Number(info.changes),
      },
    };
  };

  return {
    execute,
    bind: (...next) => makeStatement(sqlite, sql, next),
    run: async () => execute(),
    all: async () => execute(),
    raw: async () => execute().results.map((row) => Object.values(row)),
    first: async (column) => {
      const [row] = execute().results;
      if (row === undefined) return null;
      return column === undefined ? row : (row[column] ?? null);
    },
  };
}

/** The same D1-shaped client over node:sqlite that tests/cart.test.mjs uses. */
function d1Over(sqlite) {
  return {
    prepare: (sql) => makeStatement(sqlite, sql, []),
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function migratedDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const dir = path.join(ROOT, "drizzle");
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  assert.ok(files.length > 0, "no migration to test the admin against");

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }

  sqlite.exec("BEGIN");
  for (const statement of buildSeedSql({ now: "2026-08-09T00:00:00.000Z" })) {
    sqlite.exec(statement);
  }
  sqlite.exec("COMMIT");

  return sqlite;
}

let sqlite;
let db;
/** The generated passphrase for the fixture admin, drawn once per run. */
let passphrase;

/**
 * Seat an admin whose stored credential is DERIVED by the production function.
 * A literal hash here would keep passing after the derivation changed.
 */
async function seatAdmin({ id, email, role = "owner", active = true, secret }) {
  const salt = newSalt();
  const iterations = kdfIterations();
  const hash = await derivePasswordHash({
    password: normalisePassphrase(secret),
    salt,
    iterations,
    pepper: PEPPER,
  });

  sqlite
    .prepare(
      `INSERT INTO admin_users
         (id, email, display_name, role, is_active, created_at,
          password_hash, password_salt, password_algo, password_iterations,
          password_updated_at, failed_login_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    )
    .run(
      id,
      email,
      "Shop owner",
      role,
      active ? 1 : 0,
      new Date(T0 - DAY).toISOString(),
      hash,
      salt,
      ADMIN_KDF_ALGO,
      iterations,
      new Date(T0 - DAY).toISOString()
    );
}

function rows(sql, ...params) {
  return sqlite.prepare(sql).all(...params);
}

function one(sql, ...params) {
  return sqlite.prepare(sql).get(...params);
}

/** `Set-Cookie` values, with the fallback for runtimes without getSetCookie. */
function setCookies(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie();
  }
  const single = response.headers.get("set-cookie");
  return single ? [single] : [];
}

function cookieHeaderFrom(response) {
  const [cookie] = setCookies(response);
  assert.ok(cookie, "expected a Set-Cookie");
  return cookie.split(";")[0];
}

before(async () => {
  env.DB = d1Over((sqlite = migratedDatabase()));
  env.ADMIN_PASSWORD_PEPPER = PEPPER;
  env.ADMIN_SESSION_SECRET = SESSION_SECRET;
  // The algorithm is under test, not the work factor. See the header comment.
  env.ADMIN_KDF_ITERATIONS = String(KDF_ITERATIONS_FLOOR);
  delete env.ADMIN_AUDIT_MIRROR_URL;

  db = d1CartDb(env.DB);
  passphrase = generatePassphrase();
});

beforeEach(async () => {
  sqlite.exec("DELETE FROM admin_sessions;");
  sqlite.exec("DELETE FROM admin_users;");
  sqlite.exec("DELETE FROM admin_audit_log;");
  await seatAdmin({ id: "adm_owner", email: ADMIN_EMAIL, secret: passphrase });
});

after(() => {
  delete env.DB;
  delete env.ADMIN_PASSWORD_PEPPER;
  delete env.ADMIN_SESSION_SECRET;
  delete env.ADMIN_KDF_ITERATIONS;
  sqlite?.close();
});

/* =========================================================================
 * 1. The KDF and the passphrase
 * ====================================================================== */

test("base64url survives a round trip and emits no padding or unsafe characters", () => {
  for (const length of [1, 15, 16, 31, 32, 43]) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    const encoded = base64UrlEncode(bytes);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/, "a cookie value must be URL-safe");
    assert.deepEqual([...base64UrlDecode(encoded)], [...bytes]);
  }
});

test("the constant-time comparison is length-independent and correct", () => {
  const a = new Uint8Array([1, 2, 3, 4]);
  assert.equal(constantTimeEquals(a, new Uint8Array([1, 2, 3, 4])), true);
  assert.equal(constantTimeEquals(a, new Uint8Array([1, 2, 3, 5])), false);
  assert.equal(constantTimeEquals(a, new Uint8Array([1, 2, 3])), false);
  assert.equal(constantTimeEquals(a, new Uint8Array([])), false);
  assert.equal(constantTimeEquals(new Uint8Array([]), new Uint8Array([])), true);
});

test("a passphrase is generated, ~100 bits, and from an alphabet nobody misreads", () => {
  const drawn = new Set();
  for (let i = 0; i < 200; i += 1) drawn.add(generatePassphrase());
  assert.equal(drawn.size, 200, "two draws collided, so this is not a CSPRNG");

  const sample = generatePassphrase();
  assert.match(sample, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){3}$/);
  // Crockford: no I, L, O or U, so nothing is misread off a printed slip.
  assert.equal(/[ILOU]/.test(sample), false);
  assert.equal(PASSPHRASE_ENTROPY_BITS, 100);
});

test("a passphrase is normalised the same way however it is typed", () => {
  const sample = "4KX9P-2M7TB-J0WQZ-5HRVN";
  const expected = "4KX9P2M7TBJ0WQZ5HRVN";
  assert.equal(normalisePassphrase(sample), expected);
  assert.equal(normalisePassphrase(sample.toLowerCase()), expected);
  assert.equal(normalisePassphrase(" 4KX9P 2M7TB J0WQZ 5HRVN "), expected);
});

test("the iteration count is clamped at both ends and defaults sanely", () => {
  const restore = env.ADMIN_KDF_ITERATIONS;
  try {
    delete env.ADMIN_KDF_ITERATIONS;
    assert.equal(kdfIterations(), DEFAULT_KDF_ITERATIONS);

    env.ADMIN_KDF_ITERATIONS = "1";
    assert.equal(kdfIterations(), KDF_ITERATIONS_FLOOR, "a typo must not disable the KDF");

    env.ADMIN_KDF_ITERATIONS = "5000000";
    assert.equal(kdfIterations(), KDF_ITERATIONS_CEILING, "the platform caps PBKDF2 at 100k");

    env.ADMIN_KDF_ITERATIONS = "not-a-number";
    assert.equal(kdfIterations(), DEFAULT_KDF_ITERATIONS);
  } finally {
    env.ADMIN_KDF_ITERATIONS = restore;
  }
});

test("the derivation is deterministic, and salt and pepper both change it", async () => {
  const salt = newSalt();
  const base = { password: "SECRET", salt, iterations: KDF_ITERATIONS_FLOOR, pepper: PEPPER };

  const first = await derivePasswordHash(base);
  assert.equal(first, await derivePasswordHash(base), "same inputs, same hash");

  assert.notEqual(first, await derivePasswordHash({ ...base, salt: newSalt() }));
  assert.notEqual(first, await derivePasswordHash({ ...base, pepper: `${PEPPER}x` }));
  assert.notEqual(first, await derivePasswordHash({ ...base, password: "SECRE7" }));
  // 256 bits.
  assert.equal(base64UrlDecode(first).length, 32);
});

test("no pepper means no derivation at all — never a hash peppered with nothing", async () => {
  await assert.rejects(
    () =>
      derivePasswordHash({
        password: "SECRET",
        salt: newSalt(),
        iterations: KDF_ITERATIONS_FLOOR,
        pepper: "",
      }),
    /ADMIN_PASSWORD_PEPPER/
  );
});

test("an iteration count below the floor is refused rather than honoured", async () => {
  await assert.rejects(
    () =>
      derivePasswordHash({
        password: "SECRET",
        salt: newSalt(),
        iterations: 10,
        pepper: PEPPER,
      }),
    /floor/
  );
});

test("verification accepts the passphrase and rejects everything near it", async () => {
  const salt = newSalt();
  const iterations = KDF_ITERATIONS_FLOOR;
  const hash = await derivePasswordHash({ password: "SECRET", salt, iterations, pepper: PEPPER });
  const credential = { hash, salt, algo: ADMIN_KDF_ALGO, iterations };

  assert.equal(await verifyPassword("SECRET", credential, PEPPER), true);
  assert.equal(await verifyPassword("SECRE", credential, PEPPER), false);
  assert.equal(await verifyPassword("", credential, PEPPER), false);
  assert.equal(await verifyPassword("SECRET", credential, `${PEPPER}x`), false);
  assert.equal(
    await verifyPassword("SECRET", { ...credential, algo: "pbkdf2-sha1" }, PEPPER),
    false,
    "an unknown algorithm must refuse, not fall back to the current one"
  );
  assert.equal(
    await verifyPassword("SECRET", { ...credential, hash: "" }, PEPPER),
    false,
    "an empty stored hash must never match"
  );
  assert.equal(
    await verifyPassword("SECRET", { ...credential, salt: "!!! not base64 !!!" }, PEPPER),
    false,
    "a malformed salt refuses rather than throwing"
  );
});

test("a credential written at a weaker setting is flagged for rehash", () => {
  const strong = { hash: "x", salt: "y", algo: ADMIN_KDF_ALGO, iterations: kdfIterations() };
  assert.equal(credentialNeedsUpgrade(strong), false);
  assert.equal(credentialNeedsUpgrade({ ...strong, iterations: 1 }), true);
  assert.equal(credentialNeedsUpgrade({ ...strong, algo: "pbkdf2-sha1" }), true);
});

test("the throttle is an increasing delay with a ceiling, not a lockout", () => {
  for (let attempt = 1; attempt <= LOCKOUT_FREE_ATTEMPTS; attempt += 1) {
    assert.equal(lockoutUntilMs(attempt, T0), null, "fat fingers are not an attack");
  }

  const first = lockoutUntilMs(LOCKOUT_FREE_ATTEMPTS + 1, T0);
  const second = lockoutUntilMs(LOCKOUT_FREE_ATTEMPTS + 2, T0);
  assert.ok(first !== null && second !== null);
  assert.ok(second > first, "the delay must grow");

  // It must never become permanent: with one account, a hard lockout is an
  // attacker-triggerable denial of the shop's own order book.
  const far = lockoutUntilMs(500, T0);
  assert.equal(far, T0 + LOCKOUT_MAX_SECONDS * 1000);
});

test("a lock that has passed is not a lock", () => {
  assert.equal(isLockedOut(null, T0), false);
  assert.equal(isLockedOut("not a date", T0), false);
  assert.equal(isLockedOut(new Date(T0 - MINUTE).toISOString(), T0), false);
  assert.equal(isLockedOut(new Date(T0 + MINUTE).toISOString(), T0), true);
});

/* =========================================================================
 * 2. The audit diff — what must never reach the table
 * ====================================================================== */

test("an allowlisted column records its value; everything else records only that it changed", () => {
  const diff = buildDiff(
    "order",
    { status: "pending_payment", contact_name: "A", total_paise: 100 },
    { status: "cancelled", contact_name: "B", total_paise: 200 }
  );

  assert.deepEqual(diff.status, { from: "pending_payment", to: "cancelled" });
  assert.equal(diff.contact_name, "changed", "a customer name is not a loggable value");
  assert.equal(diff.total_paise, "changed");
});

test("a PAN, a phone, an email and an address are never written as values", () => {
  const diff = buildDiff(
    "order",
    {},
    {
      customer_pan: "ABCDE1234F",
      contact_phone: "+919876543210",
      contact_email: "someone@example.com",
      shipping_address_line1: "12 Mall Road",
      gstin: "27AAAAA0000A1Z5",
    }
  );

  for (const [column, entry] of Object.entries(diff)) {
    assert.equal(entry, "changed", `${column} must never carry a value`);
  }

  const serialised = JSON.stringify(diff);
  assert.equal(serialised.includes("ABCDE1234F"), false);
  assert.equal(serialised.includes("9876543210"), false);
  assert.equal(serialised.includes("example.com"), false);
  assert.equal(serialised.includes("Mall Road"), false);
});

test("the never-valued gate catches a secret even if the allowlist is widened by mistake", () => {
  for (const column of [
    "customer_pan",
    "pan",
    "password_hash",
    "password_salt",
    "admin_pepper",
    "session_id",
    "token_hash",
    "csrf",
    "gateway_signature",
    "raw_payload_json",
    "contact_phone",
    "contact_email",
    "shipping_address_line1",
    "ip",
  ]) {
    assert.equal(isNeverValued(column), true, `${column} must be stripped`);
  }

  for (const column of ["status", "role", "order_number", "ticket_number", "slug"]) {
    assert.equal(isNeverValued(column), false, `${column} is a workflow value`);
  }
});

test("every column on the allowlist survives the never-valued gate", () => {
  // If these two ever disagree, the allowlist is a lie: a column would be
  // listed as loggable and silently stripped anyway.
  for (const [entityType, columns] of Object.entries(AUDIT_VALUE_ALLOWLIST)) {
    for (const column of columns) {
      assert.equal(
        isNeverValued(column),
        false,
        `${entityType}.${column} is allowlisted but would be stripped`
      );
    }
  }
});

test("a diff is of what changed, and carries nothing structured or oversized", () => {
  assert.deepEqual(buildDiff("order", { status: "confirmed" }, { status: "confirmed" }), {});

  const long = "x".repeat(500);
  const diff = buildDiff("appointment", { status: "new" }, { status: long });
  assert.ok(diff.status !== "changed");
  assert.ok(diff.status.to.length <= 121, "a free-text value is capped");

  // A whole-row dump arrives as objects. It is refused as a value.
  assert.equal(buildDiff("order", {}, { status: { deep: true } }).status, "changed");
  assert.equal(buildDiff("order", {}, { status: ["a"] }).status, "changed");
});

test("a search records its shape and its count, never the term that was typed", () => {
  const diff = searchDiff(["phone", "name"], 11);
  assert.deepEqual(diff.fields, { from: null, to: "name,phone" });
  assert.deepEqual(diff.results, { from: null, to: 11 });
  assert.equal(JSON.stringify(diff).includes("9876"), false);
});

test("an audit row lower-cases the actor and carries no credential", () => {
  const row = toAuditRow({
    actorEmail: "Owner@Alankar.TEST",
    action: "admin.sign_in_succeeded",
    entityType: "admin_session",
    entityId: "sess-1",
    result: "ok",
    nowMs: T0,
  });

  assert.equal(row.actorEmail, "owner@alankar.test");
  assert.equal(row.createdAt, new Date(T0).toISOString());
  assert.equal(row.result, "ok");
  assert.equal(row.diffJson, null, "an empty diff is NULL, not '{}'");
});

test("an unconfigured mirror warns once and reports failure, rather than passing silently", async () => {
  delete env.ADMIN_AUDIT_MIRROR_URL;
  resetMirrorWarning();

  const warnings = [];
  const original = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));

  try {
    const row = toAuditRow({
      actorEmail: ADMIN_EMAIL,
      action: "customer_data.record_opened",
      entityType: "customer",
      nowMs: T0,
    });

    assert.equal(await mirrorAuditRow(row), false, "unconfigured is not success");
    assert.equal(await mirrorAuditRow(row), false);
    assert.equal(warnings.length, 1, "once per isolate, not once per row");
    assert.match(warnings[0], /ADMIN_AUDIT_MIRROR_URL/);
    assert.match(warnings[0], /CERT-In/);
  } finally {
    console.warn = original;
  }
});

test("the mirror payload is the row and nothing more", () => {
  const row = toAuditRow({
    actorEmail: ADMIN_EMAIL,
    action: "customer_data.field_revealed",
    entityType: "order",
    entityId: "AJ-2608-ABCDEF",
    diff: { status: { from: "a", to: "b" } },
    nowMs: T0,
  });

  const payload = mirrorPayload(row);
  assert.equal(payload.site, "alankar-jewellers");
  assert.equal(payload.source, "admin_audit_log");
  assert.equal(payload.entityId, "AJ-2608-ABCDEF");
  assert.deepEqual(
    Object.keys(payload).filter((key) => /token|cookie|password|pepper/i.test(key)),
    []
  );
});

/* =========================================================================
 * 3. The cookie, the signature, the CSRF token, the origin rule
 * ====================================================================== */

test("the cookie is __Host-prefixed, HttpOnly, Secure, Lax, and carries no Domain", () => {
  const header = adminSessionCookieHeader("value", 3600);

  assert.match(header, /^__Host-aj_admin=value;/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  // __Host- is refused by the browser without Path=/ and without these; and a
  // Domain attribute would void the prefix, which is the whole control.
  assert.match(header, /Path=\//);
  assert.equal(/Domain=/i.test(header), false);
  // Path=/admin would not match /api/admin at all. See app/_admin/session.ts.
  assert.equal(/Path=\/admin/.test(header), false);

  const cleared = clearedAdminSessionCookieHeader();
  assert.match(cleared, /Max-Age=0/);
  assert.match(cleared, /Path=\//);
});

test("a cookie value round-trips, and one flipped character in the MAC refuses it", async () => {
  const token = newSessionToken();
  const value = await toCookieValue(token);

  assert.equal(await tokenFromCookieValue(value), token);

  const [, mac] = value.split(".");
  // Flip a character at several positions. The replacement must change the
  // DECODED bytes, not merely the string: a 32-byte MAC is 256 bits but 43
  // base64url characters carry 258, so the FINAL character has two bits of
  // slack and A/B/C/D all decode alike. Swapping the last "C" for an "A" left
  // the MAC valid and failed this assertion roughly 6% of runs. Stepping the
  // alphabet by 16 moves a high bit at every position, including the last.
  const ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  for (let i = 0; i < mac.length; i += 7) {
    const at = ALPHABET.indexOf(mac[i]);
    const replacement = ALPHABET[(at + 16) % 64];
    const flipped = `${mac.slice(0, i)}${replacement}${mac.slice(i + 1)}`;
    assert.notEqual(flipped, mac, `tampering at ${i} must change the MAC`);
    assert.equal(
      await tokenFromCookieValue(`${token}.${flipped}`),
      null,
      `a MAC altered at ${i} was accepted`
    );
  }

  assert.equal(await tokenFromCookieValue(`${token}.${mac.slice(0, -1)}`), null, "truncated");
  assert.equal(await tokenFromCookieValue(token), null, "unsigned");
  assert.equal(await tokenFromCookieValue("not-a-token.not-a-mac"), null);
  assert.equal(await tokenFromCookieValue(null), null);
});

test("a garbage cookie is refused WITHOUT a database read", async () => {
  const throwing = {
    all() {
      throw new Error("the database must not be reached for a forged cookie");
    },
    batch() {
      throw new Error("the database must not be reached for a forged cookie");
    },
  };

  for (const value of ["not-a-token", "a.b", `${newSessionToken()}.short`, ""]) {
    const outcome = await readSession(
      throwing,
      new Request("https://shop.test/admin", { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${value}` } }),
      { nowMs: T0 }
    );
    assert.equal(outcome.ok, false);
    assert.ok(["no-cookie", "bad-signature"].includes(outcome.reason));
  }
});

test("the cookie is read by name and nothing else in the header confuses it", () => {
  assert.equal(readAdminCookieValue(null), null);
  assert.equal(readAdminCookieValue("aj_cart=abc"), null, "the cart cookie is not this one");
  assert.equal(
    readAdminCookieValue(`aj_cart=abc; ${ADMIN_SESSION_COOKIE}=xyz; other=1`),
    "xyz"
  );
});

test("the CSRF token is derived, bound to one session, and verified in constant time", async () => {
  const token = newSessionToken();
  const other = newSessionToken();

  const csrf = await csrfTokenFor(token);
  assert.equal(csrf, await csrfTokenFor(token), "derived, so it is stable");
  assert.notEqual(csrf, await csrfTokenFor(other), "one session's token is useless in another");
  assert.notEqual(csrf, token, "the CSRF token is not the session token");

  assert.equal(await verifyCsrfToken(token, csrf), true);
  assert.equal(await verifyCsrfToken(token, await csrfTokenFor(other)), false);
  assert.equal(await verifyCsrfToken(token, null), false);
  assert.equal(await verifyCsrfToken(token, ""), false);
  // Tamper with a character that actually carries data. A 32-byte token is 256
  // bits, but 43 base64url characters carry 258, so the FINAL character has two
  // bits of slack: replacing it with "A" decodes identically whenever the
  // original was A, B, C or D. That made this assertion fail spuriously about
  // 6% of runs — on a security property, which is the worst place to train
  // people to ignore a red build. The first character has no such slack.
  const flipped = csrf[0] === "A" ? "B" : "A";
  const tampered = `${flipped}${csrf.slice(1)}`;
  assert.notEqual(tampered, csrf, "the tampered token must actually differ");
  assert.equal(await verifyCsrfToken(token, tampered), false);
});

test("a MISSING Origin is refused — the inverse of the storefront's rule", () => {
  const make = (headers) => new Request("http://localhost/api/admin/session", { headers });

  assert.equal(refuseCrossSite(make({ host: "localhost" })), "missing-origin");
  assert.equal(refuseCrossSite(make({ host: "localhost", origin: "null" })), "missing-origin");

  assert.equal(refuseCrossSite(make({ host: "localhost", origin: ORIGIN })), null);
  assert.equal(
    refuseCrossSite(make({ host: "localhost", origin: "http://evil.test" })),
    "cross-site"
  );
  assert.equal(
    refuseCrossSite(make({ host: "localhost", origin: "not a url" })),
    "cross-site"
  );

  // Sec-Fetch-Site is an independent second signal: absent is tolerated,
  // anything other than same-origin is not.
  assert.equal(
    refuseCrossSite(make({ host: "localhost", origin: ORIGIN, "sec-fetch-site": "same-origin" })),
    null
  );
  assert.equal(
    refuseCrossSite(make({ host: "localhost", origin: ORIGIN, "sec-fetch-site": "cross-site" })),
    "cross-site"
  );
});

test("the admin path predicate does not gate the storefront", () => {
  for (const pathname of ["/admin", "/admin/", "/admin/orders", "/api/admin", "/api/admin/x"]) {
    assert.equal(isAdminPath(pathname), true, pathname);
  }
  for (const pathname of ["/", "/shop", "/cart", "/administrivia", "/api/cart", "/founders"]) {
    assert.equal(isAdminPath(pathname), false, pathname);
  }
});

/* =========================================================================
 * 4. Sessions, against real SQLite
 * ====================================================================== */

function requestWithCookie(cookieValue) {
  return new Request("https://shop.test/admin", {
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${cookieValue}` },
  });
}

async function signInFixture(overrides = {}) {
  return signIn({
    db,
    email: ADMIN_EMAIL,
    password: passphrase,
    nowMs: T0,
    userAgent: "test-agent",
    ip: "203.0.113.9",
    ...overrides,
  });
}

test("a sign-in mints a session and stores a HASH, never the token", async () => {
  const outcome = await signInFixture();
  assert.equal(outcome.ok, true);

  const [token] = outcome.cookieValue.split(".");
  const session = one("SELECT * FROM admin_sessions");

  assert.equal(session.token_hash, await sha256Text(token));
  assert.notEqual(session.token_hash, token);
  assert.equal(session.admin_user_id, "adm_owner");
  assert.equal(session.revoked_at, null);
  assert.equal(session.user_agent, "test-agent");

  // Both clocks, and the CHECK that keeps them in order.
  assert.equal(session.expires_at, new Date(T0 + ADMIN_ABSOLUTE_SECONDS * 1000).toISOString());
  assert.equal(session.idle_expires_at, new Date(T0 + ADMIN_IDLE_SECONDS * 1000).toISOString());
  assert.ok(session.idle_expires_at <= session.expires_at);

  // The counter is cleared and the sign-in is dated.
  const admin = one("SELECT * FROM admin_users WHERE id = 'adm_owner'");
  assert.equal(admin.failed_login_count, 0);
  assert.equal(admin.locked_until, null);
  assert.equal(admin.last_login_at, new Date(T0).toISOString());
});

test("the whole cookie, the token and its hash appear nowhere in the audit log", async () => {
  const outcome = await signInFixture();
  const [token] = outcome.cookieValue.split(".");
  const hash = await sha256Text(token);

  const dump = JSON.stringify(rows("SELECT * FROM admin_audit_log"));
  assert.equal(dump.includes(token), false, "the session token reached the audit log");
  assert.equal(dump.includes(outcome.cookieValue), false, "the cookie value reached the log");
  assert.equal(dump.includes(hash), false, "the token hash reached the log");
  assert.equal(dump.includes(normalisePassphrase(passphrase)), false, "the passphrase did");
  assert.equal(dump.includes(PEPPER), false, "the pepper did");

  const [entry] = rows("SELECT * FROM admin_audit_log WHERE action = 'admin.sign_in_succeeded'");
  assert.ok(entry, "a successful sign-in must be recorded");
  assert.equal(entry.result, "ok");
  assert.equal(entry.actor_email, ADMIN_EMAIL);
  assert.equal(entry.actor_admin_user_id, "adm_owner");
  assert.equal(entry.entity_id, outcome.identity.sessionId);
  assert.equal(entry.ip, "203.0.113.9");
});

test("the session id is regenerated on sign-in and a planted one is revoked, never adopted", async () => {
  const first = await signInFixture();
  assert.equal(first.ok, true);

  // The attacker's session, presented on the victim's sign-in.
  const second = await signInFixture({
    nowMs: T0 + MINUTE,
    presentedCookieValue: first.cookieValue,
  });
  assert.equal(second.ok, true);

  assert.notEqual(second.cookieValue, first.cookieValue, "the token was reused");
  assert.notEqual(second.identity.sessionId, first.identity.sessionId);

  const [oldToken] = first.cookieValue.split(".");
  const old = one("SELECT * FROM admin_sessions WHERE token_hash = ?", await sha256Text(oldToken));
  assert.equal(old.revoked_at, new Date(T0 + MINUTE).toISOString());
  assert.equal(old.revoked_reason, "superseded");

  // And the planted session no longer authenticates anything.
  const outcome = await readSession(db, requestWithCookie(first.cookieValue), {
    nowMs: T0 + 2 * MINUTE,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "revoked");
});

test("a session authenticates, and reports the identity read live from admin_users", async () => {
  const { cookieValue } = await signInFixture();

  const outcome = await readSession(db, requestWithCookie(cookieValue), { nowMs: T0 + MINUTE });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.identity.email, ADMIN_EMAIL);
  assert.equal(outcome.identity.role, "owner");
  assert.equal(outcome.identity.adminUserId, "adm_owner");
  assert.ok(outcome.identity.csrfToken.length > 20);
});

test("deactivating an admin ends their session on the next request", async () => {
  const { cookieValue } = await signInFixture();

  sqlite.exec("UPDATE admin_users SET is_active = 0 WHERE id = 'adm_owner'");

  const outcome = await readSession(db, requestWithCookie(cookieValue), { nowMs: T0 + MINUTE });
  assert.equal(outcome.ok, false);
  assert.equal(
    outcome.reason,
    "deactivated",
    "this is the test a self-contained signed cookie cannot pass"
  );
});

test("a role change is picked up immediately, because nothing about it is in the cookie", async () => {
  const { cookieValue } = await signInFixture();
  sqlite.exec("UPDATE admin_users SET role = 'staff' WHERE id = 'adm_owner'");

  const outcome = await readSession(db, requestWithCookie(cookieValue), { nowMs: T0 + MINUTE });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.identity.role, "staff");
});

test("the absolute lifetime and the idle timeout are separate refusals", async () => {
  const { cookieValue } = await signInFixture();

  const idled = await readSession(db, requestWithCookie(cookieValue), {
    nowMs: T0 + ADMIN_IDLE_SECONDS * 1000 + MINUTE,
  });
  assert.equal(idled.ok, false);
  assert.equal(idled.reason, "idle");

  const expired = await readSession(db, requestWithCookie(cookieValue), {
    nowMs: T0 + ADMIN_ABSOLUTE_SECONDS * 1000 + MINUTE,
  });
  assert.equal(expired.ok, false);
  // Absolute expiry is reported before the idle window, so a support call
  // about "it logged me out" has a distinguishable answer in the log.
  assert.equal(expired.reason, "expired");
});

test("using a session slides the idle window forward without moving the absolute one", async () => {
  const { cookieValue } = await signInFixture();
  const before = one("SELECT * FROM admin_sessions");

  const later = T0 + 4 * HOUR;
  await readSession(db, requestWithCookie(cookieValue), { nowMs: later });

  const after = one("SELECT * FROM admin_sessions");
  assert.equal(after.expires_at, before.expires_at, "the absolute clock never moves");
  assert.ok(after.idle_expires_at > before.idle_expires_at);
  assert.ok(after.idle_expires_at <= after.expires_at, "the CHECK would abort otherwise");
  assert.equal(after.last_seen_at, new Date(later).toISOString());
});

test("the idle slide is rate-limited, so a page view is not a database write", async () => {
  const { cookieValue } = await signInFixture();
  const before = one("SELECT last_seen_at FROM admin_sessions");

  await readSession(db, requestWithCookie(cookieValue), { nowMs: T0 + 5_000 });

  const after = one("SELECT last_seen_at FROM admin_sessions");
  assert.equal(after.last_seen_at, before.last_seen_at);
});

test("signing out revokes the row, not just the cookie", async () => {
  const { cookieValue, identity } = await signInFixture();

  await signOut(db, identity, { nowMs: T0 + MINUTE });

  const session = one("SELECT * FROM admin_sessions");
  assert.equal(session.revoked_at, new Date(T0 + MINUTE).toISOString());
  assert.equal(session.revoked_reason, "signed_out");

  const outcome = await readSession(db, requestWithCookie(cookieValue), { nowMs: T0 + 2 * MINUTE });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "revoked");

  const [entry] = rows("SELECT * FROM admin_audit_log WHERE action = 'admin.signed_out'");
  assert.ok(entry);
  assert.equal(entry.entity_id, identity.sessionId);
});

test("a session belonging to a deleted admin dies with them, by cascade", async () => {
  const { cookieValue } = await signInFixture();
  sqlite.exec("DELETE FROM admin_users WHERE id = 'adm_owner'");

  assert.equal(one("SELECT count(*) AS c FROM admin_sessions").c, 0);

  const outcome = await readSession(db, requestWithCookie(cookieValue), { nowMs: T0 + MINUTE });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "unknown-session");
});

test("every failing sign-in path is refused, recorded, and creates no session", async () => {
  await seatAdmin({ id: "adm_nopass", email: OTHER_EMAIL, secret: passphrase });
  sqlite.exec(
    `UPDATE admin_users
        SET password_hash = NULL, password_salt = NULL,
            password_algo = NULL, password_iterations = NULL
      WHERE id = 'adm_nopass'`
  );

  const cases = [
    ["empty", { email: "", password: "" }],
    ["empty", { email: ADMIN_EMAIL, password: "" }],
    ["no-such-admin", { email: "nobody@alankar.test", password: passphrase }],
    ["no-credential", { email: OTHER_EMAIL, password: passphrase }],
    ["wrong-password", { email: ADMIN_EMAIL, password: "4KX9P-2M7TB-J0WQZ-5HRVN" }],
    ["wrong-password", { email: ADMIN_EMAIL.toUpperCase(), password: "WRONG" }],
  ];

  for (const [expected, overrides] of cases) {
    const outcome = await signIn({ db, nowMs: T0, ...overrides });
    assert.equal(outcome.ok, false, `${expected} should not sign in`);
    assert.equal(outcome.reason, expected);
  }

  assert.equal(one("SELECT count(*) AS c FROM admin_sessions").c, 0);

  const refusals = rows("SELECT * FROM admin_audit_log WHERE action = 'admin.sign_in_refused'");
  assert.equal(refusals.length, cases.length, "every refusal is on the record");
  for (const refusal of refusals) {
    assert.equal(refusal.result, "refused");
  }
});

test("an email is matched case-insensitively, because a case mismatch is a silent lockout", async () => {
  const outcome = await signIn({
    db,
    email: "  OWNER@Alankar.TEST  ",
    password: passphrase,
    nowMs: T0,
  });
  assert.equal(outcome.ok, true);
});

test("repeated failures back off, and a correct passphrase clears the counter", async () => {
  for (let attempt = 0; attempt < LOCKOUT_FREE_ATTEMPTS; attempt += 1) {
    const outcome = await signIn({ db, email: ADMIN_EMAIL, password: "WRONG", nowMs: T0 });
    assert.equal(outcome.reason, "wrong-password");
    assert.equal(one("SELECT locked_until AS l FROM admin_users").l, null, "not yet");
  }

  await signIn({ db, email: ADMIN_EMAIL, password: "WRONG", nowMs: T0 });
  const locked = one("SELECT * FROM admin_users");
  assert.equal(locked.failed_login_count, LOCKOUT_FREE_ATTEMPTS + 1);
  assert.ok(locked.locked_until, "the backoff has started");

  // Even the RIGHT passphrase is refused while the backoff is running, and it
  // is refused with the same single message.
  const during = await signIn({ db, email: ADMIN_EMAIL, password: passphrase, nowMs: T0 });
  assert.equal(during.ok, false);
  assert.equal(during.reason, "throttled");

  // And it clears itself rather than needing an unlock.
  const after = await signIn({
    db,
    email: ADMIN_EMAIL,
    password: passphrase,
    nowMs: T0 + LOCKOUT_MAX_SECONDS * 1000 + MINUTE,
  });
  assert.equal(after.ok, true);
  assert.equal(one("SELECT failed_login_count AS c FROM admin_users").c, 0);
});

test("an unset pepper or session secret refuses every sign-in — it never opens the door", async () => {
  const pepper = env.ADMIN_PASSWORD_PEPPER;
  const secret = env.ADMIN_SESSION_SECRET;
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));

  try {
    delete env.ADMIN_PASSWORD_PEPPER;
    let outcome = await signIn({ db, email: ADMIN_EMAIL, password: passphrase, nowMs: T0 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "misconfigured");

    env.ADMIN_PASSWORD_PEPPER = pepper;
    delete env.ADMIN_SESSION_SECRET;
    outcome = await signIn({ db, email: ADMIN_EMAIL, password: passphrase, nowMs: T0 });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "misconfigured");

    assert.equal(one("SELECT count(*) AS c FROM admin_sessions").c, 0);
  } finally {
    console.error = original;
    env.ADMIN_PASSWORD_PEPPER = pepper;
    env.ADMIN_SESSION_SECRET = secret;
  }
});

/* =========================================================================
 * 5. The endpoint, through the built Worker
 * ====================================================================== */

function adminPost(body, { headers = {}, cookie, json: asJson = true } = {}) {
  const init = {
    method: "POST",
    redirect: "manual",
    headers: {
      host: "localhost",
      origin: ORIGIN,
      "content-type": asJson ? "application/json" : "application/x-www-form-urlencoded",
      ...headers,
    },
    body: asJson ? JSON.stringify(body) : new URLSearchParams(body).toString(),
  };
  if (cookie) init.headers.cookie = cookie;
  return fetchWorker("/api/admin/session", init);
}

test("the endpoint signs in, and the cookie it sets is not the row it stored", async () => {
  const response = await adminPost({ email: ADMIN_EMAIL, password: passphrase });
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.admin.email, ADMIN_EMAIL);
  assert.equal(body.admin.role, "owner");
  assert.ok(body.csrf);

  const [cookie] = setCookies(response);
  assert.match(cookie, /^__Host-aj_admin=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Path=\//);
  assert.equal(/Domain=/i.test(cookie), false);

  const value = cookie.split(";")[0].split("=").slice(1).join("=");
  assert.equal(value.includes(ADMIN_EMAIL), false);
  assert.equal(value.includes(normalisePassphrase(passphrase)), false);

  const stored = one("SELECT token_hash FROM admin_sessions").token_hash;
  assert.notEqual(stored, value, "the stored value must not be the bearer token");
  assert.equal(value.includes(stored), false);

  assert.equal(response.headers.get("cache-control"), "no-store, max-age=0");
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
});

test("a form sign-in redirects to the panel and never re-posts the passphrase", async () => {
  const response = await adminPost(
    { email: ADMIN_EMAIL, password: passphrase },
    { json: false }
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/admin");
  assert.equal((await response.text()).length, 0);
  assert.equal(setCookies(response).length, 1);
});

test("every sign-in failure answers with exactly the same string and the same redirect", async () => {
  const attempts = [
    { email: "", password: "" },
    { email: ADMIN_EMAIL, password: "" },
    { email: "nobody@alankar.test", password: passphrase },
    { email: ADMIN_EMAIL, password: "WRONG-WRONG-WRONG-WRONG" },
  ];

  const bodies = new Set();
  const statuses = new Set();

  for (const attempt of attempts) {
    const response = await adminPost(attempt);
    statuses.add(response.status);
    const body = await response.json();
    bodies.add(body.error);
    assert.equal(body.ok, false);
    assert.equal(setCookies(response).length, 0, "a refusal must set no cookie");

    const form = await adminPost(attempt, { json: false });
    assert.equal(form.status, 303);
    assert.equal(form.headers.get("location"), `${ADMIN_LOGIN_PATH}?notice=refused`);
  }

  assert.deepEqual([...bodies], [SIGN_IN_FAILED], "more than one message is an oracle");
  assert.deepEqual([...statuses], [401]);

  // And nothing in it hints at which path was taken.
  assert.equal(/lock|attempt|minute|character|found|exists|unknown/i.test(SIGN_IN_FAILED), false);
});

test("a POST with no Origin is refused — there is no legitimate non-browser admin client", async () => {
  const response = await fetchWorker("/api/admin/session", {
    method: "POST",
    redirect: "manual",
    headers: { host: "localhost", "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: passphrase }),
  });

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error, SIGN_IN_FAILED);
  assert.equal(setCookies(response).length, 0);
  assert.equal(one("SELECT count(*) AS c FROM admin_sessions").c, 0);
});

test("a cross-origin POST cannot plant a session", async () => {
  for (const origin of ["http://evil.test", "null"]) {
    const response = await adminPost(
      { email: ADMIN_EMAIL, password: passphrase },
      { headers: { origin } }
    );
    assert.equal(response.status, 403);
    assert.equal(setCookies(response).length, 0, "no Set-Cookie may come back");
  }
  assert.equal(one("SELECT count(*) AS c FROM admin_sessions").c, 0);
});

test("the session endpoint refuses GET, because a GET must never change state", async () => {
  const response = await fetchWorker("/api/admin/session", { redirect: "manual" });
  assert.equal(response.status, 405);
  assert.match(response.headers.get("allow") ?? "", /POST/);
});

test("signing out through the endpoint needs the session's own CSRF token", async () => {
  const signedIn = await adminPost({ email: ADMIN_EMAIL, password: passphrase });
  const { csrf } = await signedIn.json();
  const cookie = cookieHeaderFrom(signedIn);

  const forged = await adminPost({ intent: "sign-out", csrf: "wrong" }, { cookie });
  assert.equal(forged.status, 403);
  assert.equal(one("SELECT revoked_at AS r FROM admin_sessions").r, null, "still live");

  const real = await adminPost({ intent: "sign-out", csrf }, { cookie });
  assert.equal(real.status, 200);
  assert.ok(one("SELECT revoked_at AS r FROM admin_sessions").r, "revoked at the row");
  assert.match(setCookies(real)[0] ?? "", /Max-Age=0/);
});

/* =========================================================================
 * 6. THE GATE, ENUMERATED
 * ====================================================================== */

/**
 * Every route under app/admin/** and app/api/admin/**, discovered off the
 * filesystem rather than typed out. This is the test that protects the route
 * somebody adds next year and forgets to gate — the failure mode
 * `research/06-admin-compliance.md` names as "the one that actually happens".
 */
function discoverAdminRoutes() {
  const found = [];

  const walk = (dir, urlPath) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, `${urlPath}/${entry}`);
        continue;
      }
      if (entry === "page.tsx" || entry === "page.jsx") {
        found.push({ path: urlPath || "/", kind: "page" });
      }
      if (entry === "route.ts" || entry === "route.tsx" || entry === "route.js") {
        found.push({ path: urlPath || "/", kind: "route" });
      }
    }
  };

  walk(path.join(ROOT, "app", "admin"), "/admin");
  walk(path.join(ROOT, "app", "api", "admin"), "/api/admin");
  return found;
}

/**
 * How to request a route that has a dynamic segment. The VALUE is a
 * well-formed handle of the kind that route takes, so the refusal is tested on
 * a URL the router will actually match — a nonsense segment could be refused
 * by routing rather than by the gate, which would prove nothing.
 */
const DYNAMIC_SAMPLES = {
  "/admin/orders/[id]": "/admin/orders/AJ-2608-7QW2XF",
};

test("the enumeration finds the routes that exist, and every dynamic one is requestable", () => {
  const routes = discoverAdminRoutes();
  assert.ok(routes.length >= 2, "the walker found nothing, so the checks below prove nothing");

  // Every path declared public must actually EXIST. A stale entry here would
  // be a hole punched in the gate for a route that is no longer there — and,
  // worse, one that a future file at that path would inherit silently.
  const discovered = new Set(routes.map((route) => route.path));
  for (const pathname of PUBLIC_ADMIN_PATHS) {
    assert.ok(discovered.has(pathname), `${pathname} is declared public but does not exist`);
  }

  for (const route of routes) {
    // A dynamic segment cannot be requested without a value, which would make
    // the refusal checks below silently skip it. So each one declares a sample
    // in DYNAMIC_SAMPLES, and adding a dynamic route without one fails here —
    // on purpose, and loudly.
    if (!/\[|\]/.test(route.path)) continue;
    assert.ok(
      DYNAMIC_SAMPLES[route.path],
      `${route.path} is dynamic; add it to DYNAMIC_SAMPLES so it can be requested`
    );
  }
});

test("EVERY admin route refuses an anonymous request, and leaks nothing while doing it", async () => {
  const publicPaths = new Set(PUBLIC_ADMIN_PATHS);
  const gated = discoverAdminRoutes().filter((route) => !publicPaths.has(route.path));

  /**
   * Two sources, deliberately merged.
   *
   * The DISCOVERED routes are the forward guarantee: the first
   * `app/admin/orders/page.tsx` anyone adds is checked here without them
   * having to remember, which is the failure mode research/06 §1.6 calls "the
   * one that actually happens". Today that list is empty — the only two admin
   * routes are the sign-in page and the sign-in endpoint, and both have to be
   * anonymous — so on its own this loop would prove nothing.
   *
   * The PROBE paths are what make it prove something today. The gate runs
   * before route dispatch, so an admin URL with no file behind it travels
   * exactly the same code path as one with a file; and an unmapped admin URL
   * must be refused rather than 404, which would otherwise confirm the routing
   * table to anyone probing it.
   */
  const probes = [
    { path: "/admin", kind: "page" },
    { path: "/admin/orders", kind: "page" },
    { path: "/admin/settings", kind: "page" },
    { path: "/api/admin/orders", kind: "route" },
    { path: "/api/admin/media", kind: "route" },
  ];

  const targets = [...gated, ...probes];
  assert.ok(targets.length >= probes.length);

  for (const route of targets) {
    // A dynamic route is requested at its declared sample; everything else is
    // requested at itself.
    const target = DYNAMIC_SAMPLES[route.path] ?? route.path;

    const response = await fetchWorker(target, {
      redirect: "manual",
      headers: { accept: route.kind === "page" ? "text/html" : "application/json" },
    });

    const body = await response.text();

    if (target.startsWith("/api/admin")) {
      assert.equal(response.status, 401, `${target} must refuse with 401`);
    } else {
      assert.equal(response.status, 303, `${target} must redirect`);
      assert.match(
        response.headers.get("location") ?? "",
        /\/admin\/login$/,
        `${target} must redirect to the sign-in page`
      );
      // A redirect with the protected page still rendered underneath is a real
      // framework bug class, and the redirect hides it perfectly.
      assert.equal(body.trim().length, 0, `${target} rendered a body while refusing`);
    }

    assert.equal(setCookies(response).length, 0, `${target} set a cookie for a stranger`);
  }
});

test("a cookie with a valid shape but a forged signature does not pass the gate", async () => {
  const token = newSessionToken();
  const forged = `${token}.${"A".repeat(43)}`;

  const response = await fetchWorker("/admin/orders", {
    redirect: "manual",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${forged}` },
  });
  assert.equal(response.status, 303);
  assert.match(response.headers.get("location") ?? "", /\/admin\/login$/);
});

test("the sign-in page is reachable anonymously, and is not indexable", async () => {
  const response = await fetchWorker(ADMIN_LOGIN_PATH, {
    redirect: "manual",
    headers: { accept: "text/html" },
  });

  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Sign in/);
  assert.match(html, /name="email"/);
  assert.match(html, /name="password"/);
  assert.match(html, /action="\/api\/admin\/session"/);
  assert.match(html, /method="post"/i);

  // Both signals: a crawler that reads only headers, and one that reads only
  // markup, must each see the refusal.
  assert.match(response.headers.get("x-robots-tag") ?? "", /noindex/);
  assert.match(html, /noindex/);

  // No credential and no CSRF token is minted for an anonymous visitor.
  assert.equal(/name="csrf"/.test(html), false);
});

test("the sign-in page renders the one failure message and nothing more specific", async () => {
  const response = await fetchWorker(`${ADMIN_LOGIN_PATH}?notice=refused`, {
    headers: { accept: "text/html" },
  });
  const html = await response.text();
  assert.ok(html.includes(SIGN_IN_FAILED.slice(0, 40)));
  assert.equal(/forgot/i.test(html), false, "a reset link is an oracle and does not exist");
});

test("a signed-in visitor sees who they are, which is what makes a shared credential visible", async () => {
  const signedIn = await adminPost({ email: ADMIN_EMAIL, password: passphrase });
  const cookie = cookieHeaderFrom(signedIn);

  const response = await fetchWorker(ADMIN_LOGIN_PATH, {
    headers: { accept: "text/html", cookie },
  });
  const html = await response.text();

  assert.match(html, /Already signed in/);
  assert.ok(html.includes(ADMIN_EMAIL));
  assert.match(html, /name="csrf"/, "the sign-out form carries the session's token");
  assert.equal(html.includes(cookie.split("=").slice(1).join("=")), false, "cookie in the markup");
});

test("a revoked session passes the cheap gate and is still refused by the real one", async () => {
  const signedIn = await adminPost({ email: ADMIN_EMAIL, password: passphrase });
  const cookie = cookieHeaderFrom(signedIn);

  // proxy.ts checks only the signature, so this cookie will still get through
  // it. That is by design and is exactly why requireAdmin() exists.
  sqlite.exec("UPDATE admin_sessions SET revoked_at = '2026-08-09T09:30:00.000Z'");

  const response = await fetchWorker(ADMIN_LOGIN_PATH, {
    headers: { accept: "text/html", cookie },
  });
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(/Already signed in/.test(html), false, "a revoked session rendered as signed in");
  assert.match(html, /name="password"/, "it must fall back to the sign-in form");
  assert.equal(html.includes(ADMIN_EMAIL), false);
});

test("a deactivated admin is refused by the real gate too, through the built Worker", async () => {
  const signedIn = await adminPost({ email: ADMIN_EMAIL, password: passphrase });
  const cookie = cookieHeaderFrom(signedIn);

  sqlite.exec("UPDATE admin_users SET is_active = 0");

  const html = await (
    await fetchWorker(ADMIN_LOGIN_PATH, { headers: { accept: "text/html", cookie } })
  ).text();

  assert.equal(/Already signed in/.test(html), false);
});

test("the storefront is completely unaffected by the gate", async () => {
  for (const pathname of ["/", "/shop", "/cart", "/founders", "/robots.txt"]) {
    const response = await fetchWorker(pathname, {
      redirect: "manual",
      headers: { accept: "text/html" },
    });
    assert.equal(response.status, 200, `${pathname} answered ${response.status}`);
  }

  // A matcher typo of /admin* instead of /admin/:path* would gate this.
  const response = await fetchWorker("/administrivia", { redirect: "manual" });
  assert.notEqual(response.status, 303, "a near-miss path must not be redirected to sign-in");
});
