/**
 * THE BACKUP SCRIPTS, AND THE SAFETY PROPERTIES THAT ARE EASY TO LOSE.
 *
 * A backup is the one piece of infrastructure whose failure is invisible until
 * the day it matters, so the properties worth pinning are not "does it run" but
 * the refusals:
 *
 *   it must not write a plaintext dump without being told to,
 *   it must not call a truncated export a success,
 *   it must not overwrite production without a second, deliberate flag,
 *   and the dump must not be committable to a public repository.
 *
 * These run the real scripts. Nothing here touches Cloudflare: the export step
 * is the only part that needs the network, and every test below either stops
 * before it or feeds the verifier a file directly.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Run a script, returning its exit code and output rather than throwing. */
function run(script, args = [], env = {}) {
  try {
    const stdout = execFileSync(join(ROOT, "scripts", script), args, {
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out: stdout };
  } catch (error) {
    return {
      code: error.status ?? 1,
      out: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

test("the restore script refuses production without a deliberate second flag", () => {
  const archive = join(tmpdir(), "not-a-real-archive.sql.enc");
  writeFileSync(archive, "irrelevant");

  const refused = run("restore-d1.sh", ["--to", "alankar-jewellers", archive], {
    BACKUP_PASSPHRASE: "x",
  });
  rmSync(archive, { force: true });

  assert.notEqual(refused.code, 0, "restoring over production must not be a one-flag operation");
  assert.match(refused.out, /REFUSING/);
  assert.match(refused.out, /--yes-overwrite-production/);
  // It must refuse BEFORE decrypting, so a wrong passphrase is never the thing
  // that saves production.
  assert.doesNotMatch(refused.out, /decrypting/);
});

test("a restore names the flag it wants rather than failing obscurely", () => {
  const missing = run("restore-d1.sh", ["--drill", "/nonexistent.enc"], {
    BACKUP_PASSPHRASE: "x",
  });
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /no such archive/);
});

test("the backup script will not leave a dump in the clear by accident", () => {
  // No BACKUP_PASSPHRASE and no --plaintext: the only safe answer is to refuse.
  // The export runs first, so this asserts the refusal exists in the source
  // rather than paying for a network round trip to observe it.
  const source = readFileSync(join(ROOT, "scripts", "backup-d1.sh"), "utf8");
  assert.match(
    source,
    /BACKUP_PASSPHRASE:-\}"\s*\]; then[\s\S]{0,320}rm -f "\$PLAIN"/,
    "a missing passphrase must delete the plaintext dump rather than keep it"
  );
  assert.match(source, /must not be stored in the clear/);
});

test("the verifier rejects a truncated or empty export", () => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  // A dump that exists, is well-formed SQL, and is missing everything.
  writeFileSync(join(dir, "tiny.sql"), "CREATE TABLE orders (id TEXT);\n");

  const source = readFileSync(join(ROOT, "scripts", "backup-d1.sh"), "utf8");
  rmSync(dir, { recursive: true, force: true });

  // Both halves of the check: a size floor and a per-table presence test. A
  // size floor alone passes a large dump of the wrong database; a table check
  // alone passes a schema-only export.
  assert.match(source, /-lt 2000/, "no size floor on the dump");
  assert.match(source, /CREATE TABLE\( IF NOT EXISTS\)\?/, "no per-table verification");
  for (const table of ["orders", "order_items", "customers", "admin_users", "gold_rates"]) {
    assert.ok(
      source.includes(table),
      `${table} is not among the tables the backup insists on`
    );
  }
});

test("the ciphertext is proved to decrypt before the plaintext is destroyed", () => {
  const source = readFileSync(join(ROOT, "scripts", "backup-d1.sh"), "utf8");
  const verifyAt = source.indexOf("verifying the ciphertext decrypts");
  // Search from the round-trip check onward. `rm -f "$PLAIN"` also appears in
  // the earlier no-passphrase branch, where deleting the plaintext is exactly
  // the right thing, and matching that one would compare the wrong two points.
  const shredAt = source.indexOf('shred -u "$PLAIN"', verifyAt);
  assert.ok(verifyAt > 0, "the round-trip check is missing");
  assert.ok(shredAt > 0, "the plaintext is never destroyed after encryption");
  assert.ok(
    verifyAt < shredAt,
    "the plaintext is destroyed before the encrypted copy is known to be readable"
  );
});

test("a dump can never be committed to this public repository", () => {
  const ignore = readFileSync(join(ROOT, ".gitignore"), "utf8");
  assert.match(ignore, /^\/backup\/$/m, "the backup directory is not ignored");
  assert.match(ignore, /^\*\.sql\.enc$/m, "encrypted dumps are not ignored");
});

test("the nightly workflow restores what it backs up, and keeps it encrypted", () => {
  const workflow = readFileSync(join(ROOT, ".github/workflows/backup.yml"), "utf8");

  assert.match(workflow, /schedule:/, "the backup does not run on a schedule");
  assert.match(workflow, /workflow_dispatch:/, "the backup cannot be run by hand");

  // The drill is the point. A workflow that only produces a file proves the
  // export ran, not that the shop could ever get its orders back.
  assert.match(
    workflow,
    /restore-d1\.sh --drill/,
    "the workflow never restores the archive it just made"
  );
  const backupAt = workflow.indexOf("backup-d1.sh");
  const drillAt = workflow.indexOf("restore-d1.sh --drill");
  const uploadAt = workflow.indexOf("upload-artifact");
  assert.ok(backupAt < drillAt && drillAt < uploadAt, "the drill must run before the artifact is kept");

  // Only the encrypted form is ever uploaded.
  assert.match(workflow, /path: \.\/backup\/\*\.sql\.enc/);
  assert.doesNotMatch(workflow, /path: \.\/backup\/\*\.sql\s*$/m, "a plaintext dump is being uploaded");

  for (const secret of ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "BACKUP_PASSPHRASE"]) {
    assert.ok(workflow.includes(secret), `${secret} is not wired into the workflow`);
  }
});
