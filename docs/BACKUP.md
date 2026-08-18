# Backups and restore

Everything the shop cannot rebuild by hand lives in one Cloudflare D1 database:
orders, customers (including PAN), the gold-rate history and the admin seats.

## What protects it

| | |
|---|---|
| **Nightly encrypted export** | `.github/workflows/backup.yml`, 00:40 IST, kept 90 days |
| **Cloudflare Time Travel** | always on, 7 days on the free plan, 30 on paid |

Time Travel is a rewind button, not a copy. It cannot be exported, and **it is
deleted along with the database it belongs to** — so it does not help if the D1
is dropped or the Cloudflare account is lost. The nightly export is the actual
backup; Time Travel is for undoing a bad `UPDATE` an hour ago.

## Setup (once)

Three repository secrets, under Settings → Secrets and variables → Actions:

| secret | what it is |
|---|---|
| `CLOUDFLARE_API_TOKEN` | scoped to **D1 read** on this account. The workflow never writes to D1, so do not give it write. |
| `CLOUDFLARE_ACCOUNT_ID` | the account the database lives in |
| `BACKUP_PASSPHRASE` | a long random string: `openssl rand -base64 32` |

**Losing `BACKUP_PASSPHRASE` makes every backup unreadable.** Keep it wherever
`ADMIN_PASSWORD_PEPPER` is kept. It is not in this repository and cannot be
recovered from it.

## Why the dump is encrypted

**This repository is public.** GitHub Actions artifacts on a public repository
can be downloaded by anyone who can see the repo. A plaintext dump would publish
customers' names, phone numbers, addresses and PAN on a nightly schedule — a
reportable personal-data breach under the DPDP Act rather than an inconvenience,
and worse than having no backup at all.

So `scripts/backup-d1.sh` encrypts with AES-256-CBC (PBKDF2, 600k iterations)
before anything leaves the runner, proves the ciphertext decrypts back to the
original, and only then destroys the plaintext.

## Running one by hand

```bash
export BACKUP_PASSPHRASE='…'
./scripts/backup-d1.sh              # export, verify, encrypt into ./backup
./scripts/backup-d1.sh --plaintext  # unencrypted, LOCAL ONLY, contains PAN
```

The script fails rather than producing a file if the dump is implausibly small
or is missing any of `orders`, `order_items`, `customers`, `variants`,
`products`, `gold_rates`, `admin_users`. A backup job that quietly writes an
empty file every night is worse than no job, because it also removes the worry
that would have made someone check.

## Restoring

**The drill.** Run this monthly, and after any change to either script. It
decrypts, applies to a throwaway SQLite file, reads the row counts back, and
touches nothing real:

```bash
export BACKUP_PASSPHRASE='…'
./scripts/restore-d1.sh --drill backup/alankar-jewellers-….sql.enc
```

The nightly workflow runs this drill against the archive it has just made, so a
backup that cannot be restored fails the job on the night it breaks rather than
on the day it is needed.

**The real thing.** Restoring is destructive: the dump recreates its tables, so
everything written since the export is discarded.

```bash
# 1. Take a fresh backup of whatever is there now, however broken.
./scripts/backup-d1.sh

# 2. Drill the archive you intend to restore. Do not skip this.
./scripts/restore-d1.sh --drill backup/<archive>.sql.enc

# 3. Apply it.
./scripts/restore-d1.sh --to alankar-jewellers \
    --yes-overwrite-production backup/<archive>.sql.enc

# 4. Verify before telling anyone it is done.
npx wrangler d1 execute alankar-jewellers --remote -y \
  --command "SELECT (SELECT count(*) FROM orders) AS orders,
                    (SELECT count(*) FROM products) AS products,
                    (SELECT count(*) FROM gold_rates) AS rates;"
```

The script refuses the production database unless `--yes-overwrite-production`
is also given, because the destructive case is occasionally what you want and
never what you want by accident.

## What this does not cover

- **R2 media** is not enabled on the account, so there is nothing to back up yet.
  When it is, images need their own copy; this workflow only touches D1.
- **Worker secrets** (`ADMIN_PASSWORD_PEPPER`, `ADMIN_SESSION_SECRET`,
  `GOLD_RATE_INGEST_TOKEN`) are write-only in Cloudflare and are **not** in any
  backup. Restoring the database does not restore the ability to sign in. Keep
  them in a password manager.
- **Point-in-time between nightly runs.** Up to 24 hours of orders can be lost
  in the worst case. Time Travel covers that gap while it lasts.
