#!/usr/bin/env bash
#
# RESTORE A D1 BACKUP, AND THE DRILL THAT PROVES ONE WOULD WORK.
#
# ===========================================================================
# A BACKUP NOBODY HAS RESTORED IS A HOPE, NOT A BACKUP
# ===========================================================================
# The failure this guards against is not "we had no copy". It is "we had a
# copy, and on the day we needed it we discovered the passphrase was wrong, or
# the dump was schema-only, or nobody knew the command". So the drill is a first
# class mode here, it runs against a scratch database, and it checks the
# restored contents rather than trusting an exit code.
#
#   ./scripts/restore-d1.sh --drill backup/xyz.sql.enc
#       Decrypt into a throwaway local SQLite file, apply it, count what came
#       back, delete it. Touches nothing real. THIS IS THE ONE TO RUN MONTHLY.
#
#   ./scripts/restore-d1.sh --to <database-name> backup/xyz.sql.enc
#       Apply to a named D1 database.
#
# ===========================================================================
# WHY IT WILL NOT LET YOU RESTORE OVER PRODUCTION BY ACCIDENT
# ===========================================================================
# Restoring is destructive: the dump recreates tables, so applying it to a live
# database discards everything written since the export. That is occasionally
# exactly what you want and never what you want by accident, so the production
# name has to be typed AND confirmed with a second flag that cannot be reached
# by tab-completion or a stale shell-history line.
#
set -euo pipefail

PROD_DB="${D1_DATABASE_NAME:-alankar-jewellers}"
MODE=""
TARGET=""
CONFIRMED=0
ARCHIVE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --drill) MODE="drill" ;;
    --to) MODE="apply"; TARGET="${2:-}"; shift ;;
    --yes-overwrite-production) CONFIRMED=1 ;;
    -*) echo "unknown flag: $1" >&2; exit 2 ;;
    *) ARCHIVE="$1" ;;
  esac
  shift
done

[ -n "$ARCHIVE" ] || { echo "usage: restore-d1.sh (--drill | --to <db>) <archive.sql.enc>" >&2; exit 2; }
[ -f "$ARCHIVE" ] || { echo "no such archive: $ARCHIVE" >&2; exit 2; }
[ -n "$MODE" ] || { echo "choose --drill or --to <db>" >&2; exit 2; }

if [ "$MODE" = "apply" ] && [ "$TARGET" = "$PROD_DB" ] && [ "$CONFIRMED" -ne 1 ]; then
  cat >&2 <<MSG
REFUSING: "$TARGET" is the production database.

Applying a dump recreates its tables, so every order, customer and rate written
since this backup was taken would be discarded. If that is genuinely what you
want, run it again with --yes-overwrite-production.
MSG
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
SQL="${WORK}/restore.sql"

echo "==> decrypting"
if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "FAIL: BACKUP_PASSPHRASE is not set." >&2; exit 1
fi
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in "$ARCHIVE" -out "$SQL" -pass env:BACKUP_PASSPHRASE 2>/dev/null \
  || { echo "FAIL: could not decrypt. Wrong passphrase, or the archive is damaged." >&2; exit 1; }

echo "==> the dump contains"
for table in orders order_items customers variants products gold_rates admin_users; do
  n=$(grep -cE "^INSERT INTO [\"\`]?${table}[\"\`]?" "$SQL" || true)
  printf '    %-14s %s\n' "$table" "$n"
done

if [ "$MODE" = "drill" ]; then
  echo "==> DRILL: applying to a throwaway SQLite database"
  DRILL_DB="${WORK}/drill.sqlite"
  # node:sqlite is already a project dependency of the test suite, so the drill
  # needs nothing that is not already here.
  node -e '
    const { DatabaseSync } = require("node:sqlite");
    const fs = require("fs");
    const db = new DatabaseSync(process.argv[1]);
    const sql = fs.readFileSync(process.argv[2], "utf8");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(sql);
    const tables = ["orders","order_items","customers","variants","products","gold_rates","admin_users"];
    let total = 0;
    console.log("==> restored, and read back");
    for (const t of tables) {
      const { c } = db.prepare(`SELECT count(*) AS c FROM ${t}`).get();
      total += c;
      console.log(`    ${t.padEnd(14)} ${c}`);
    }
    if (total === 0) {
      console.error("FAIL: the restored database is empty.");
      process.exit(1);
    }
  ' "$DRILL_DB" "$SQL"
  echo "==> drill passed. The throwaway database has been discarded."
  exit 0
fi

echo "==> applying to D1 database: ${TARGET}"
npx wrangler d1 execute "$TARGET" --remote --file "$SQL" -y
echo "==> applied. Verify with a SELECT before telling anyone it is done."
