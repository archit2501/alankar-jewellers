/**
 * THE ADMIN AUDIT LOG — one writer, an allowlisted diff, and the mirror seam.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL: IT IS REQUIRED, NOT WISE
 * ===========================================================================
 * DPDP Rule 6(1)(c) obliges "visibility on the accessing of such personal data,
 * through appropriate logs, monitoring and review, for enabling detection of
 * unauthorised access". CERT-In direction (iv), in force TODAY, obliges "logs
 * of all their ICT systems" kept for a rolling 180 days. Neither is satisfied
 * by logging only writes, and neither is satisfied by `console.log`.
 *
 * The commercial argument is the same argument. DPDP Rule 7(1) requires each
 * AFFECTED data principal to be notified of a breach, with no materiality
 * threshold. A system that cannot say which records a compromised session
 * actually opened has one honest answer — every customer in the database. A
 * read log turns that into "the eleven customers whose records were opened
 * between 02:14 and 02:41". That difference is the whole reason reads are
 * logged here and not just writes.
 *
 * ===========================================================================
 * THE DIFF IS ALLOWLIST-DRIVEN, AND THIS IS THE ONLY WRITER
 * ===========================================================================
 * A whole-row diff of an `orders` or `customers` update would write a name, a
 * phone number, a full address and a PAN into `admin_audit_log` — a second,
 * unmanaged copy of exactly the data this log exists to protect, sitting
 * outside the erasure job's reach and outliving the customer row it describes.
 *
 * So `buildDiff()` records a VALUE only for a column named in
 * `AUDIT_VALUE_ALLOWLIST` for that entity type. Every other changed column is
 * recorded as the indicator `"changed"` — enough to prove something moved,
 * carrying nothing. `entity_id` is in the row; a reader who is authorised to
 * see the record can go and look at it.
 *
 * On top of that there is `NEVER_VALUED`, which strips a value even from a
 * column that someone later adds to the allowlist by mistake. Two independent
 * gates, because this is the failure that quietly creates the breach it was
 * meant to bound.
 *
 * ===========================================================================
 * APPEND-ONLY
 * ===========================================================================
 * There is no UPDATE and no DELETE against `admin_audit_log` in this module,
 * and there must not be one anywhere else. Note honestly what that does and
 * does not buy: it stops accidents and it stops a compromised session. It does
 * not constrain whoever holds the D1 credentials, who is realistically the same
 * person the log describes. The only control that does is the off-box mirror
 * below.
 *
 * ===========================================================================
 * RETENTION
 * ===========================================================================
 * Floors: DPDP Rule 6(1)(e) one year; CERT-In (iv) 180 days rolling. Ceiling:
 * the log itself contains personal data (which customer was read), so keeping
 * it forever is a permanent record of every customer the shop ever looked at,
 * outliving the customer row. The policy is 24 months, and because there is no
 * cron trigger on this control plane the sweep has to be lazy and bounded —
 * the shape `app/_data/cart.ts` uses for expired holds. NOT IMPLEMENTED HERE:
 * there is nothing to sweep until the panel has been running for two years,
 * and a sweep written now would be untested for that entire time. It belongs
 * with the first admin screen that runs on sign-in.
 */

import { env } from "cloudflare:workers";

import type { CartDb, CartStatement, SqlValue } from "../_data/cart";

/* =========================================================================
 * Actions
 * ====================================================================== */

/**
 * Dotted action names, extending the convention `db/schema.ts` sets
 * (`order.status_changed`, `rate.updated`). Authentication events are here
 * because nothing owned them before and the CERT-In six-hour clock has nothing
 * to start from without them: a log with no "someone got in" signal cannot
 * detect the incident it is supposed to report.
 */
export const ADMIN_ACTIONS = {
  signInSucceeded: "admin.sign_in_succeeded",
  signInRefused: "admin.sign_in_refused",
  signedOut: "admin.signed_out",
  sessionExpired: "admin.session_expired",
  sessionRefused: "admin.session_refused",
  passwordIssued: "admin.password_issued",
  /** Reads of personal data — Rule 6(1)(c). */
  recordOpened: "customer_data.record_opened",
  fieldRevealed: "customer_data.field_revealed",
  searchRun: "customer_data.search_run",
  exported: "customer_data.exported",
} as const;

export type AuditResult = "ok" | "refused";

/* =========================================================================
 * The allowlist
 * ====================================================================== */

/**
 * Columns whose VALUES may be written into `diff_json`, by entity type.
 *
 * The test for membership is: could this value, on its own or joined to the
 * entity id, identify or harm a customer? Workflow states cannot. Names,
 * numbers, addresses and identifiers can. Money is deliberately absent — not
 * because a price is dangerous, but because no admin path may edit a price
 * snapshot at all (a correction is cancel-and-re-place), so a money value in a
 * diff would be evidence of a bug rather than of a legitimate change, and
 * `"changed"` reports that just as well.
 *
 * Entity types the admin panel does not reach yet are listed anyway, so the
 * first screen that touches one inherits a reviewed allowlist instead of
 * inventing one under deadline.
 */
export const AUDIT_VALUE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  admin_session: ["revoked_reason", "result", "reason"],
  admin_user: ["role", "is_active", "display_name"],
  order: [
    "status",
    "payment_status",
    "fulfilment_status",
    "cancellation_reason_code",
    "cancelled_at",
    "acknowledged_at",
  ],
  order_item: ["fulfilment_status"],
  customer: ["marketing_opt_in", "deletion_requested_at", "purge_not_before_at", "redacted_at"],
  support_ticket: ["kind", "status", "assigned_to", "acknowledged_at", "resolved_at"],
  appointment: ["status", "source"],
  product: ["slug", "status", "sale_mode", "position"],
  variant: ["sku", "status", "stock_quantity", "is_unique_piece", "fineness"],
  gold_rate: ["metal", "fineness", "source", "source_ref", "effective_from", "effective_to"],
  payment: ["provider", "method", "kind", "status"],
} as const;

/**
 * A value is stripped when its column name matches ANY of these, whatever the
 * allowlist says. This is the second gate, and it is the one that survives a
 * future edit made in a hurry.
 *
 * `pan` is anchored so it cannot be defeated by, or accidentally fire on, a
 * column that merely contains those three letters.
 */
const NEVER_VALUED: readonly RegExp[] = [
  /(^|_)pan(_|$)/i,
  /password/i,
  /pepper/i,
  /secret/i,
  /(^|_)token(_|$)/i,
  /cookie/i,
  /session/i,
  /csrf/i,
  /signature/i,
  /raw_payload/i,
  /(^|_)hash(_|$)/i,
  /(^|_)salt(_|$)/i,
  /(^|_)ip(_|$)/i,
  /phone/i,
  /email/i,
  /address/i,
  /gstin/i,
];

export function isNeverValued(column: string): boolean {
  return NEVER_VALUED.some((pattern) => pattern.test(column));
}

/** What a single column's entry in a diff may look like. */
export type DiffEntry = "changed" | { readonly from: SqlValue | boolean; readonly to: SqlValue | boolean };

export type AuditDiff = Readonly<Record<string, DiffEntry>>;

/** Cap on a recorded string, so a free-text note cannot smuggle a payload in. */
const MAX_VALUE_LENGTH = 120;

function loggableValue(value: unknown): SqlValue | boolean | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
  }
  // An object, an array, a Date. Nothing structured belongs in a diff: it is
  // the shape a whole-row dump arrives in.
  return undefined;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  return false;
}

/**
 * Build the diff for a change to one entity.
 *
 * Only columns present in `after` are considered — this is a diff of what the
 * writer intended to change, not of the whole row, so a caller cannot widen it
 * by passing a fuller `before`.
 */
export function buildDiff(
  entityType: string,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>
): AuditDiff {
  const allowed = new Set(AUDIT_VALUE_ALLOWLIST[entityType] ?? []);
  const diff: Record<string, DiffEntry> = {};

  for (const column of Object.keys(after)) {
    if (same(before[column], after[column])) continue;

    if (!allowed.has(column) || isNeverValued(column)) {
      diff[column] = "changed";
      continue;
    }

    const from = loggableValue(before[column]);
    const to = loggableValue(after[column]);
    diff[column] = from === undefined || to === undefined ? "changed" : { from, to };
  }

  return diff;
}

/**
 * The diff for a SEARCH over customer data: which FIELDS were searched and how
 * many rows came back. Never the search term — a phone number typed into a
 * search box is the same personal datum whether it is stored in a customer row
 * or in a log line about a customer row.
 */
export function searchDiff(fields: readonly string[], resultCount: number): AuditDiff {
  return {
    fields: { from: null, to: [...fields].sort().join(",") },
    results: { from: null, to: Math.max(0, Math.trunc(resultCount)) },
  };
}

/* =========================================================================
 * Writing
 * ====================================================================== */

export type AuditEntry = {
  readonly actorEmail: string;
  readonly actorAdminUserId?: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly diff?: AuditDiff | null;
  readonly result?: AuditResult;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly nowMs?: number;
};

/** What actually goes into the row, and into the mirror payload. */
export type AuditRow = {
  readonly id: string;
  readonly actorEmail: string;
  readonly actorAdminUserId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly diffJson: string | null;
  readonly result: AuditResult;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
};

/** A user agent is attacker-controlled free text; cap it like any other. */
function trimmed(value: string | null | undefined, max = 200): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  return clean.length > max ? clean.slice(0, max) : clean;
}

export function toAuditRow(entry: AuditEntry): AuditRow {
  const nowMs = entry.nowMs ?? Date.now();
  const diff = entry.diff && Object.keys(entry.diff).length > 0 ? entry.diff : null;

  return {
    id: crypto.randomUUID(),
    // The email is lower-cased everywhere else; keep the log consistent so a
    // "what did this person do" query is one predicate.
    actorEmail: entry.actorEmail.trim().toLowerCase(),
    actorAdminUserId: entry.actorAdminUserId ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    diffJson: diff ? JSON.stringify(diff) : null,
    result: entry.result ?? "ok",
    ip: trimmed(entry.ip, 64),
    userAgent: trimmed(entry.userAgent),
    createdAt: new Date(nowMs).toISOString(),
  };
}

const INSERT_AUDIT = `
  INSERT INTO admin_audit_log (
    id, actor_email, actor_admin_user_id, action, entity_type, entity_id,
    diff_json, result, ip, user_agent, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

/**
 * The audit row as a STATEMENT, so it can travel inside the caller's own
 * `db.batch()`.
 *
 * This is the shape callers should reach for. `db.batch()` is the only
 * atomicity primitive D1 offers, and an audit row written in a second batch
 * either records a change that did not commit or misses one that did —
 * `app/_data/orders.ts` makes the identical argument about `support_tickets`
 * being inside the placement batch.
 */
export function auditStatement(row: AuditRow): CartStatement {
  return {
    sql: INSERT_AUDIT,
    params: [
      row.id,
      row.actorEmail,
      row.actorAdminUserId,
      row.action,
      row.entityType,
      row.entityId,
      row.diffJson,
      row.result,
      row.ip,
      row.userAgent,
      row.createdAt,
    ],
  };
}

/**
 * Write one audit row on its own, and mirror it.
 *
 * For events that ARE the whole action — a sign-in, a record being opened —
 * there is nothing to be atomic with, so a standalone write is correct. For an
 * event that describes a change to something else, use `auditStatement()` and
 * put it in that change's batch.
 *
 * Never throws. An audit write that fails must be loud, but it must not be the
 * reason a shop owner cannot cancel an order; the caller has already decided
 * the action is authorised.
 */
export async function writeAudit(db: CartDb, entry: AuditEntry): Promise<AuditRow> {
  const row = toAuditRow(entry);
  try {
    await db.batch([auditStatement(row)]);
  } catch (error) {
    console.error(
      `[admin-audit] FAILED to record ${row.action} (${row.entityType}): the action itself was not affected:`,
      error
    );
  }
  await mirrorAuditRow(row);
  return row;
}

/* =========================================================================
 * The CERT-In mirror seam
 * ====================================================================== */

/**
 * CERT-In direction (iv) requires ICT-system logs to be kept for 180 rolling
 * days "within the Indian jurisdiction". D1 has no India region — its location
 * hints are wnam, enam, weur, eeur, apac and oc — so this log, as stored, does
 * not satisfy it. The recorded decision
 * (`.claude-protocol/decisions.json` -> `certInLogging`) is to mirror every
 * audit row to an India-hosted endpoint, reusing the `LEAD_WEBHOOK_URL`
 * pattern that is already proven in `app/api/appointments/route.ts`.
 *
 * It also closes the tamper-proofing gap honestly: an off-box copy is the only
 * part of this record that the person holding the D1 credentials cannot
 * quietly edit.
 *
 *   # ADMIN_AUDIT_MIRROR_URL — OPTIONAL TODAY, and the exposure stands while
 *   # it is unset. An https endpoint hosted in India that accepts a JSON POST.
 *   # The payload is the audit ROW: no session token, no cookie, no passphrase,
 *   # and a diff that has already been through the allowlist.
 *   ADMIN_AUDIT_MIRROR_URL=
 *
 * Unconfigured is a WARNING, not a silent no-op and not a failure. Silence
 * would let the shop believe an obligation is being met that is not being met;
 * a failure would mean an unset variable stops the owner cancelling an order,
 * which is a worse outcome than a logging gap. The warning is emitted once per
 * isolate — enough to be noticed in `wrangler tail`, not so much that it
 * drowns the log it is complaining about.
 */
export function auditMirrorUrl(): string {
  const value = (env as unknown as Record<string, unknown>).ADMIN_AUDIT_MIRROR_URL;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

let warnedAboutMissingMirror = false;

/** Reset between tests. Not called by production code. */
export function resetMirrorWarning(): void {
  warnedAboutMissingMirror = false;
}

/** The exact JSON the mirror receives. Exported so a test can assert on it. */
export function mirrorPayload(row: AuditRow) {
  return {
    site: "alankar-jewellers",
    source: "admin_audit_log",
    ...row,
  };
}

/** Two seconds. An audit mirror may not become the reason a page is slow. */
const MIRROR_TIMEOUT_MS = 2000;

/**
 * Best-effort, non-blocking in intent and never throwing.
 *
 * It is awaited rather than fired and forgotten because an un-awaited `fetch`
 * in a Worker can be cancelled the moment the response is returned, which
 * would make the mirror silently unreliable — the one property an audit mirror
 * may not have. If the latency ever matters, the upgrade is `ctx.waitUntil()`
 * from the route handler's execution context, not removing the await.
 */
export async function mirrorAuditRow(row: AuditRow): Promise<boolean> {
  const url = auditMirrorUrl();

  if (!url) {
    if (!warnedAboutMissingMirror) {
      warnedAboutMissingMirror = true;
      console.warn(
        "[admin-audit] ADMIN_AUDIT_MIRROR_URL is not set, so admin audit rows exist only in D1. " +
          "D1 has no India region, so CERT-In direction (iv), 180 days of logs within Indian " +
          "jurisdiction, is not being met, and this log has no copy outside the reach of whoever " +
          "holds the database credentials. Set the secret to close both. " +
          "(Warned once per isolate; further rows are mirrored nowhere, silently.)"
      );
    }
    return false;
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mirrorPayload(row)),
      signal: AbortSignal.timeout(MIRROR_TIMEOUT_MS),
    });

    if (!response.ok) {
      console.warn(
        `[admin-audit] mirror responded ${response.status} for ${row.action}; the row is in D1 only.`
      );
      return false;
    }

    return true;
  } catch (error) {
    console.warn(
      `[admin-audit] mirror unreachable for ${row.action}; the row is in D1 only:`,
      error instanceof Error ? error.message : error
    );
    return false;
  }
}
