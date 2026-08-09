/**
 * ISSUE AN ADMIN PASSPHRASE — LOCAL ONLY.
 *
 * ===========================================================================
 * HOW TO RUN IT
 * ===========================================================================
 *
 *   ADMIN_PASSWORD_PEPPER=<the pepper> \
 *     node scripts/create-admin.mjs --email=owner@alankarjewellers.com \
 *                                   --name="Shop owner" --role=owner
 *
 *   …--sql        print the SQL and write nothing (review it, or hand it to a
 *                 reviewed deployment)
 *   …--rotate     the seat already exists; replace its passphrase and revoke
 *                 every session it has open
 *   …--db-file=…  point at a specific .sqlite
 *
 * ===========================================================================
 * IT GENERATES THE PASSPHRASE. IT WILL NOT ACCEPT ONE.
 * ===========================================================================
 * There is no `--password` flag and passing one is refused rather than
 * ignored, because the entire security argument for a password on this
 * platform is that the owner did not choose it.
 *
 * Cloudflare Workers has no Argon2id and no bcrypt, and caps PBKDF2 at 100,000
 * iterations against OWASP's 600,000 — so the KDF is roughly one twenty-fourth
 * of the recommended work factor and there is no path to the recommended
 * algorithm. What makes that survivable is ~100 bits of CSPRNG entropy in the
 * secret itself and a pepper that never enters the database. A human-chosen
 * passphrase has perhaps 40 bits, sits in a breach corpus, and turns a design
 * that works into one that does not. So: 20 Crockford-base32 symbols, drawn
 * here, printed once, and never seen by this script again.
 *
 * ===========================================================================
 * WHY IT CANNOT TOUCH PRODUCTION, STRUCTURALLY
 * ===========================================================================
 * THIS SITE IS LIVE. Exactly as `scripts/seed-catalogue.mjs`, this script has
 * no network path at all: it opens the Miniflare SQLite file under
 * `.wrangler/state/v3/d1/` with `node:sqlite` and writes to it directly. There
 * is no Cloudflare API client here, no `wrangler` invocation, and `--remote` is
 * refused outright rather than unsupported. The resolved absolute path is
 * printed before anything is written.
 *
 * To create the production seat, run with `--sql`, read what it prints, and
 * apply it through a reviewed deployment. The generated passphrase is printed
 * on stderr in both modes and appears in the SQL nowhere — only the derived
 * bits, the salt, the algorithm name and the iteration count do.
 *
 * ===========================================================================
 * THE THREE WORKER SECRETS
 * ===========================================================================
 * None of these belongs in a committed file. Set them in the hosting control
 * plane (or, for a self-managed Worker, `npx wrangler secret put <NAME>`):
 *
 *   ADMIN_PASSWORD_PEPPER   openssl rand -hex 32
 *       HMAC'd over the passphrase before the KDF sees it, and never stored.
 *       It is why a D1-only leak yields nothing crackable. IT MUST BE THE SAME
 *       VALUE HERE AND IN PRODUCTION, or the hash this script writes will not
 *       verify against the passphrase it printed. Changing it invalidates every
 *       stored hash — which is also the out-of-band unlock for a locked-out
 *       owner: set a new pepper, re-run this script, hand over the new slip.
 *
 *   ADMIN_SESSION_SECRET    openssl rand -hex 32
 *       Signs the session cookie and derives each session's CSRF token.
 *       Rotating it signs everyone out; that is the kill switch that needs no
 *       database access.
 *
 *   ADMIN_KDF_ITERATIONS    optional; default 25000, clamped to [10000, 100000]
 *       Raise it to 100000 once the Workers plan tier is confirmed as paid.
 *       Existing rows keep verifying at the count stored against them.
 *
 * ===========================================================================
 * ONE CREDENTIAL PER PERSON
 * ===========================================================================
 * Run this once per human, not once per shop. `admin_audit_log.actor_email`
 * asserts who read a customer's PAN, and a shared passphrase makes that
 * assertion untrue — a false audit trail is worse than none, because it is
 * produced in evidence. Adding the second person is one more run of this
 * script.
 */

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// Imported for the module hooks it registers (which let plain Node resolve the
// TypeScript module graph and the `cloudflare:workers` specifier) as much as
// for the two helpers. Importing it runs no seeding: its `main` is guarded.
import { resolveLocalD1Path, sqlLiteral } from "./seed-catalogue.mjs";

const {
  ADMIN_KDF_ALGO,
  PASSPHRASE_ENTROPY_BITS,
  derivePasswordHash,
  generatePassphrase,
  kdfIterations,
  newSalt,
  normalisePassphrase,
} = await import("../app/_admin/auth.ts");

const ROLES = new Set(["owner", "manager", "staff"]);

function flag(argv, name) {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : "";
}

async function openSqlite(file) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error(
      "node:sqlite is unavailable in this Node build. Re-run with --sql and apply the\n" +
        "output with your own local SQLite client instead."
    );
  }
  return new sqlite.DatabaseSync(file);
}

/**
 * The statements. Every value is rendered by `sqlLiteral`, which refuses
 * anything it does not recognise, so the output is readable, diffable and
 * hand-runnable — and cannot smuggle an unescaped string into a statement.
 *
 * `--rotate` revokes the seat's open sessions in the same run. A rotated
 * passphrase that leaves live sessions behind has not actually revoked
 * anything, which is the whole reason someone rotates one.
 */
function buildStatements({ id, email, displayName, role, credential, now, rotate }) {
  const statements = [];

  if (rotate) {
    statements.push(
      `UPDATE admin_users SET
  password_hash = ${sqlLiteral(credential.hash)},
  password_salt = ${sqlLiteral(credential.salt)},
  password_algo = ${sqlLiteral(credential.algo)},
  password_iterations = ${sqlLiteral(credential.iterations)},
  password_updated_at = ${sqlLiteral(now)},
  failed_login_count = 0,
  locked_until = NULL,
  is_active = 1
WHERE email = ${sqlLiteral(email)};`
    );
    statements.push(
      `UPDATE admin_sessions SET revoked_at = ${sqlLiteral(now)}, revoked_reason = 'password_changed'
WHERE revoked_at IS NULL
  AND admin_user_id IN (SELECT id FROM admin_users WHERE email = ${sqlLiteral(email)});`
    );
    return statements;
  }

  statements.push(
    `INSERT INTO admin_users (
  id, email, display_name, role, is_active, created_at,
  password_hash, password_salt, password_algo, password_iterations, password_updated_at,
  failed_login_count
) VALUES (
  ${sqlLiteral(id)}, ${sqlLiteral(email)}, ${sqlLiteral(displayName)}, ${sqlLiteral(role)}, 1, ${sqlLiteral(now)},
  ${sqlLiteral(credential.hash)}, ${sqlLiteral(credential.salt)}, ${sqlLiteral(credential.algo)}, ${sqlLiteral(credential.iterations)}, ${sqlLiteral(now)},
  0
);`
  );

  // The audit log records that a credential was issued. It records no part of
  // the credential: no hash, no salt, no passphrase.
  statements.push(
    `INSERT INTO admin_audit_log (
  id, actor_email, actor_admin_user_id, action, entity_type, entity_id, diff_json, result, created_at
) VALUES (
  ${sqlLiteral(randomUUID())}, ${sqlLiteral(email)}, ${sqlLiteral(id)}, 'admin.password_issued',
  'admin_user', ${sqlLiteral(id)}, ${sqlLiteral(JSON.stringify({ role: { from: null, to: role } }))}, 'ok', ${sqlLiteral(now)}
);`
  );

  return statements;
}

function printPassphrase(email, passphrase) {
  // stderr, so `--sql > seat.sql` captures the SQL and the secret stays on the
  // terminal. Printed exactly once; nothing here can recover it afterwards.
  process.stderr.write(
    `\n${"=".repeat(70)}\n` +
      `PASSPHRASE for ${email} — shown ONCE, and stored nowhere.\n` +
      `${"=".repeat(70)}\n\n` +
      `    ${passphrase}\n\n` +
      `About ${PASSPHRASE_ENTROPY_BITS} bits of entropy, generated here. It is not a word and it is\n` +
      `not memorable; put it straight into a password manager, or write it on a\n` +
      `slip and keep the slip where the shop keeps its keys. It is case-insensitive\n` +
      `and the hyphens are decoration.\n\n` +
      `If it is lost there is no reset link. Re-run this script with --rotate,\n` +
      `which issues a new one and ends every open session.\n` +
      `${"=".repeat(70)}\n\n`
  );
}

async function main(argv) {
  // A remote flag is not "unsupported" here, it is refused. The site is live.
  const forbidden = argv.find(
    (arg) => /^--remote\b/.test(arg) || arg === "--env=production" || arg === "--production"
  );
  if (forbidden) {
    console.error(
      `Refusing to run: ${forbidden}. This script writes to the LOCAL D1 database only and has\n` +
        "no network path to Cloudflare at all. The production seat is created by applying the\n" +
        "output of `--sql` through a reviewed deployment."
    );
    process.exitCode = 1;
    return;
  }

  const supplied = argv.find(
    (arg) => arg.startsWith("--password") || arg.startsWith("--passphrase")
  );
  if (supplied) {
    console.error(
      "Refusing to run: this script GENERATES the passphrase and will not accept one.\n\n" +
        "Workers caps PBKDF2 at 100,000 iterations and offers no Argon2 or bcrypt, so the key\n" +
        "derivation cannot carry a weak secret. The design only holds because the passphrase is\n" +
        "~100 bits of CSPRNG output that nobody chose. A typed one would be worth about 40 bits\n" +
        "and would quietly undo it."
    );
    process.exitCode = 1;
    return;
  }

  const pepper = (process.env.ADMIN_PASSWORD_PEPPER ?? "").trim();
  if (!pepper) {
    console.error(
      "ADMIN_PASSWORD_PEPPER is not set, so no passphrase can be derived.\n\n" +
        "  Generate one:  openssl rand -hex 32\n" +
        "  Then run:      ADMIN_PASSWORD_PEPPER=<value> node scripts/create-admin.mjs …\n\n" +
        "It must be the SAME value that is set as a Worker secret in the hosting control plane,\n" +
        "or the hash written here will not verify against the passphrase printed here."
    );
    process.exitCode = 1;
    return;
  }

  const email = flag(argv, "email").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("Pass --email=<address>. It is stored lower-cased; a CHECK enforces that.");
    process.exitCode = 1;
    return;
  }

  const role = (flag(argv, "role") || "staff").trim();
  if (!ROLES.has(role)) {
    console.error(`--role must be one of: ${[...ROLES].join(", ")}`);
    process.exitCode = 1;
    return;
  }

  const displayName = flag(argv, "name").trim() || null;
  const rotate = argv.includes("--rotate");

  const passphrase = generatePassphrase();
  const salt = newSalt();
  const iterations = kdfIterations();
  const startedAt = Date.now();
  const hash = await derivePasswordHash({
    // Exactly what the sign-in path will do to what the owner types, so the
    // hyphens and the case of the printed slip cannot make it un-verifiable.
    password: normalisePassphrase(passphrase),
    salt,
    iterations,
    pepper,
  });
  const elapsedMs = Date.now() - startedAt;

  const statements = buildStatements({
    id: `adm_${randomUUID()}`,
    email,
    displayName,
    role,
    credential: { hash, salt, algo: ADMIN_KDF_ALGO, iterations },
    now: new Date().toISOString(),
    rotate,
  });

  if (argv.includes("--sql")) {
    printPassphrase(email, passphrase);
    process.stdout.write(`${statements.join("\n\n")}\n`);
    return;
  }

  const file = resolveLocalD1Path(flag(argv, "db-file") || undefined);
  const db = await openSqlite(file);

  try {
    db.exec("PRAGMA foreign_keys = ON;");
    console.log(`local D1: ${file}`);
    console.log(`${ADMIN_KDF_ALGO}, ${iterations} iterations, derived in ${elapsedMs} ms`);

    db.exec("BEGIN");
    try {
      for (const statement of statements) db.exec(statement);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const seats = db.prepare("SELECT email, role, is_active FROM admin_users").all();
    console.log("seats:", seats);
  } finally {
    db.close();
  }

  printPassphrase(email, passphrase);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
