import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Appointment requests captured by the private-viewing form on the homepage.
 * Every column mirrors a field the visitor actually fills in, plus the
 * lightweight request metadata Cloudflare hands us for free.
 */
export const appointments = sqliteTable(
  "appointments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    interest: text("interest").notNull(),
    preferredTime: text("preferred_time").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    /** Workflow state for the shop team: new -> contacted -> booked/closed. */
    status: text("status").notNull().default("new"),
    /** Where the lead came from, so future channels stay distinguishable. */
    source: text("source").notNull().default("website"),
    userAgent: text("user_agent"),
    /** Two-letter country from the Cloudflare `CF-IPCountry` request header. */
    country: text("country"),
  },
  (table) => [
    index("appointments_created_at_idx").on(table.createdAt),
    /**
     * Supports the duplicate/flood guard in the appointments route, which asks
     * "has this number submitted in the last few minutes?" on every POST.
     */
    index("appointments_phone_created_at_idx").on(table.phone, table.createdAt),
  ]
);
