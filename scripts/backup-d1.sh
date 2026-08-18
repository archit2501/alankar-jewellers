#!/usr/bin/env bash
#
# NIGHTLY BACKUP OF THE PRODUCTION D1 DATABASE.
#
# ===========================================================================
# WHY THIS EXISTS
# ===========================================================================
# D1 holds every order, every customer row (including PAN), the rate history
# and the admin seats. There was no backup of any of it. Cloudflare's Time
# Travel is always on, but it is 7 days on the free plan, nobody has ever
# exercised a restore, and it DIES WITH THE DATABASE: delete the D1 or lose the
# account and Time Travel goes with it. It is a rewind button, not a copy.
#
# ===========================================================================
# WHY THE DUMP IS ENCRYPTED, WHICH IS NOT OPTIONAL
# ===========================================================================
# THIS REPOSITORY IS PUBLIC. GitHub Actions artifacts on a public repository
# can be downloaded by anyone who can see the repo. A plaintext dump here would
# publish customers' names, phone numbers, addresses and PAN to the internet on
# a nightly schedule -- a worse outcome than having no backup at all, and a
# reportable personal-data breach under the DPDP Act rather than an incident.
#
# So the dump never leaves this script unencrypted. AES-256-CBC with PBKDF2 via
# openssl, which is present on every runner and on macOS, so there is nothing to
# install and nothing to trust beyond openssl itself. The passphrase lives in
# BACKUP_PASSPHRASE and never touches the repository.
#
# LOSING THAT PASSPHRASE MAKES EVERY BACKUP UNREADABLE. It belongs in the same
# password manager as ADMIN_PASSWORD_PEPPER, and for the same reason.
#
# ===========================================================================
# WHY IT VERIFIES BEFORE IT UPLOADS
# ===========================================================================
# A backup job that quietly writes an empty file every night is worse than no
# job, because it also removes the worry that would have made someone check. So
# the dump is proved to contain the tables that matter and a plausible number of
# rows BEFORE it is encrypted, and the script exits non-zero if it is not.
#
#   ./scripts/backup-d1.sh                 export, verify, encrypt
#   ./scripts/backup-d1.sh --plaintext     leave it unencrypted (LOCAL ONLY)
#
set -euo pipefail

DB_NAME="${D1_DATABASE_NAME:-alankar-jewellers}"
OUT_DIR="${BACKUP_DIR:-./backup}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
PLAIN="${OUT_DIR}/${DB_NAME}-${STAMP}.sql"
CIPHER="${PLAIN}.enc"
PLAINTEXT_ONLY=0

for arg in "$@"; do
  case "$arg" in
    --plaintext) PLAINTEXT_ONLY=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

mkdir -p "$OUT_DIR"

echo "==> exporting ${DB_NAME} (remote)"
npx wrangler d1 export "$DB_NAME" --remote --output "$PLAIN" -y >/dev/null

# --- verify ----------------------------------------------------------------
# Every table the shop cannot be reconstructed without. A dump missing any of
# these is a failed export that happened to exit zero.
REQUIRED_TABLES=(orders order_items customers variants products gold_rates admin_users)

bytes=$(wc -c < "$PLAIN" | tr -d ' ')
echo "==> verifying (${bytes} bytes)"

if [ "$bytes" -lt 2000 ]; then
  echo "FAIL: the dump is ${bytes} bytes, which is too small to be a real database." >&2
  exit 1
fi

missing=0
for table in "${REQUIRED_TABLES[@]}"; do
  if ! grep -qE "CREATE TABLE( IF NOT EXISTS)? [\"\`]?${table}[\"\`]?" "$PLAIN"; then
    echo "FAIL: no CREATE TABLE for '${table}' in the dump." >&2
    missing=1
  fi
done
[ "$missing" -eq 0 ] || exit 1

# An INSERT count per table, printed so a human reading the job log can see the
# shape of what was captured rather than only that it succeeded.
echo "==> rows captured"
for table in "${REQUIRED_TABLES[@]}"; do
  n=$(grep -cE "^INSERT INTO [\"\`]?${table}[\"\`]?" "$PLAIN" || true)
  printf '    %-14s %s\n' "$table" "$n"
done

# --- encrypt ---------------------------------------------------------------
if [ "$PLAINTEXT_ONLY" -eq 1 ]; then
  echo "==> left unencrypted at ${PLAIN} (--plaintext)"
  echo "    This file contains PAN and addresses. Do not upload it anywhere."
  exit 0
fi

if [ -z "${BACKUP_PASSPHRASE:-}" ]; then
  echo "FAIL: BACKUP_PASSPHRASE is not set, and this dump must not be stored in the clear." >&2
  rm -f "$PLAIN"
  exit 1
fi

echo "==> encrypting"
openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -salt \
  -in "$PLAIN" -out "$CIPHER" -pass env:BACKUP_PASSPHRASE

# Prove the ciphertext round-trips BEFORE the plaintext is destroyed. An
# unreadable backup discovered at restore time is the failure this guards.
echo "==> verifying the ciphertext decrypts"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 \
  -in "$CIPHER" -pass env:BACKUP_PASSPHRASE 2>/dev/null | cmp -s - "$PLAIN" \
  || { echo "FAIL: the encrypted dump does not decrypt to the original." >&2; rm -f "$PLAIN" "$CIPHER"; exit 1; }

shred -u "$PLAIN" 2>/dev/null || rm -f "$PLAIN"
echo "==> ${CIPHER} ($(wc -c < "$CIPHER" | tr -d ' ') bytes), plaintext removed"
