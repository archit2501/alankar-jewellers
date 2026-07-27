import { env } from "cloudflare:workers";
import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../../../db";
import { appointments } from "../../../db/schema";

/** Silently absorb a repeat submission from the same number inside this window. */
const DUPLICATE_WINDOW = "-3 minutes";
/** Max submissions one number may make in a rolling day before we stop storing them. */
const DAILY_LIMIT_PER_PHONE = 5;

/** Optional outbound webhook (Zapier / Make / n8n / email relay). */
function leadWebhookUrl() {
  const value = (env as unknown as Record<string, unknown>).LEAD_WEBHOOK_URL;
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function toRouteErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected error";
  const detail =
    error instanceof Error && error.cause instanceof Error
      ? error.cause.message
      : "";
  const combined = `${message}\n${detail}`;

  if (
    combined.includes("no such table") ||
    combined.includes('from "appointments"')
  ) {
    return "The appointments table is unavailable. Generate the migration locally with `npm run db:generate`, then deploy so the platform can apply the generated SQL to the real D1 database.";
  }

  return message;
}

function asTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Lenient Indian mobile normalisation: accepts `+91`, a leading `0`, spaces,
 * hyphens, brackets and dots. Returns "" when the input cannot plausibly be a
 * phone number so the caller can reject it.
 */
function normalisePhone(raw: string) {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return "";

  let local = digits;
  if (local.length > 10 && local.startsWith("91")) local = local.slice(2);
  if (local.length > 10 && local.startsWith("0")) local = local.replace(/^0+/, "");

  if (local.length === 10) return `+91${local}`;
  // Anything else that still carries 10+ digits is kept verbatim rather than
  // rejecting a legitimate overseas client.
  return `+${digits}`;
}

type Lead = {
  name: string;
  phone: string;
  interest: string;
  preferredTime: string;
  note: string | null;
  userAgent: string | null;
  country: string | null;
  receivedAt: string;
};

/**
 * Cheap flood guard for a public, unauthenticated write endpoint: one indexed
 * lookup keyed on the phone number. Catches the two realistic cases — an
 * impatient double-click, and a bot hammering the form to burn D1 write quota.
 *
 * Deliberately FAILS OPEN. If the guard itself errors (table missing, D1 down)
 * we would rather risk a duplicate row than drop a real customer's enquiry.
 * IP-level limiting belongs in a Cloudflare WAF rate-limiting rule, not here —
 * doing it in D1 would mean storing visitor IPs, which is PII this shop has no
 * reason to hold.
 */
async function isThrottled(phone: string) {
  try {
    const db = getDb();
    const [row] = await db
      .select({
        justNow: sql<number>`sum(case when ${appointments.createdAt} > datetime('now', ${DUPLICATE_WINDOW}) then 1 else 0 end)`,
        today: sql<number>`count(*)`,
      })
      .from(appointments)
      .where(
        and(
          eq(appointments.phone, phone),
          sql`${appointments.createdAt} > datetime('now', '-1 day')`
        )
      );

    if (!row) return false;
    return Number(row.justNow ?? 0) > 0 || Number(row.today ?? 0) >= DAILY_LIMIT_PER_PHONE;
  } catch (error) {
    console.error(
      "[appointments] throttle check unavailable, failing open:",
      error
    );
    return false;
  }
}

async function persistLead(lead: Lead) {
  const db = getDb();
  await db.insert(appointments).values({
    name: lead.name,
    phone: lead.phone,
    interest: lead.interest,
    preferredTime: lead.preferredTime,
    note: lead.note,
    userAgent: lead.userAgent,
    country: lead.country,
  });
}

/** Resolves to `true` only when a lead was actually delivered downstream. */
async function notifyLead(lead: Lead) {
  const url = leadWebhookUrl();
  if (!url) return false;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ site: "alankar-jewellers", ...lead }),
  });

  if (!response.ok) {
    throw new Error(
      `Lead webhook responded ${response.status} ${response.statusText}`
    );
  }

  return true;
}

export async function POST(request: Request) {
  let payload: Record<string, unknown>;

  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json(
      { ok: false, error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (!payload || typeof payload !== "object") {
    return Response.json(
      { ok: false, error: "Request body must be a JSON object." },
      { status: 400 }
    );
  }

  // Honeypot: real visitors never see this field, bots fill everything.
  if (asTrimmedString(payload.company)) {
    return Response.json({ ok: true }, { status: 201 });
  }

  const name = asTrimmedString(payload.name);
  const rawPhone = asTrimmedString(payload.phone);
  const interest = asTrimmedString(payload.interest);
  const preferredTime = asTrimmedString(payload.time);
  const note = asTrimmedString(payload.note);

  if (!name) {
    return Response.json(
      { ok: false, error: "Please tell us your name." },
      { status: 400 }
    );
  }
  if (name.length > 120) {
    return Response.json(
      { ok: false, error: "Name must be 120 characters or fewer." },
      { status: 400 }
    );
  }
  if (!rawPhone) {
    return Response.json(
      { ok: false, error: "Please share a mobile number we can reach you on." },
      { status: 400 }
    );
  }

  const phone = normalisePhone(rawPhone);
  if (!phone) {
    return Response.json(
      {
        ok: false,
        error: "Please enter a valid mobile number with at least 10 digits.",
      },
      { status: 400 }
    );
  }

  if (!interest || interest.length > 80) {
    return Response.json(
      {
        ok: false,
        error: "Please choose what you are interested in (80 characters max).",
      },
      { status: 400 }
    );
  }
  if (!preferredTime || preferredTime.length > 80) {
    return Response.json(
      {
        ok: false,
        error: "Please choose a preferred time (80 characters max).",
      },
      { status: 400 }
    );
  }
  if (note.length > 2000) {
    return Response.json(
      { ok: false, error: "Your note must be 2000 characters or fewer." },
      { status: 400 }
    );
  }

  // Answer exactly as we would on success: a repeat submitter should see their
  // confirmation, and a bot should learn nothing about why it was ignored.
  if (await isThrottled(phone)) {
    return Response.json({ ok: true }, { status: 201 });
  }

  const lead: Lead = {
    name,
    phone,
    interest,
    preferredTime,
    note: note || null,
    userAgent: request.headers.get("user-agent"),
    country: request.headers.get("cf-ipcountry"),
    receivedAt: new Date().toISOString(),
  };

  // Two independent sinks. A lead that reaches either one is a captured lead,
  // so only a double failure is worth surfacing to the visitor.
  const [stored, notified] = await Promise.allSettled([
    persistLead(lead),
    notifyLead(lead),
  ]);

  const storedOk = stored.status === "fulfilled";
  const notifiedOk = notified.status === "fulfilled" && notified.value === true;

  if (!storedOk) {
    console.error(
      "[appointments] D1 insert failed:",
      toRouteErrorMessage(stored.reason),
      stored.reason
    );
  }
  if (notified.status === "rejected") {
    console.error("[appointments] lead webhook failed:", notified.reason);
  }

  if (storedOk || notifiedOk) {
    return Response.json({ ok: true }, { status: 201 });
  }

  return Response.json(
    {
      ok: false,
      error:
        "We could not record your request just now. Please call or WhatsApp us and we will book your viewing right away.",
    },
    { status: 500 }
  );
}

export async function GET() {
  return Response.json(
    { ok: false, error: "Method not allowed. Use POST /api/appointments." },
    { status: 405, headers: { Allow: "POST" } }
  );
}
