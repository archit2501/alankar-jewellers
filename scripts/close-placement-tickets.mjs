/**
 * CLOSE THE GRIEVANCE TICKETS THAT PLACEMENT USED TO OPEN — a one-off.
 *
 * ===========================================================================
 * WHAT WENT WRONG, AND WHAT THIS PUTS RIGHT
 * ===========================================================================
 * Until `app/_data/orders.ts` section (10), `placeOrder()` wrote a
 * `support_tickets` row for EVERY order: `kind = 'query'`, `status = 'open'`,
 * `subject = "Order AJ-…"`, `acknowledge_due_at = placed_at + 48h`,
 * `redress_due_at = placed_at + 30d`, and its number copied into
 * `orders.complaint_ticket_number`.
 *
 * Consumer Protection (E-Commerce) Rule 4(5)'s clocks run from the receipt of a
 * CONSUMER COMPLAINT, and Rule 7(1)(f)'s ticket number is issued per COMPLAINT
 * LODGED. A purchase is neither. Every such row therefore asserts, in the
 * shop's own database, a grievance that was never lodged and an acknowledgement
 * deadline that was breached two days later — and it occupies the single
 * `orders.complaint_ticket_number` slot, under a UNIQUE index, that a real
 * complaint needs.
 *
 * This script REINTERPRETS those rows rather than orphaning or deleting them:
 *
 *   1. The ticket is closed, with a note saying in plain words what it actually
 *      was. `resolved_at` is deliberately left NULL — nothing was ever owed, so
 *      claiming a redressal happened would be a second untruth on top of the
 *      first. A closed ticket is out of the overdue queue
 *      (`support_tickets_status_due_idx`), which is the queue's whole purpose.
 *
 *   2. `orders.complaint_ticket_number` is set back to NULL, so the Rule 7(1)(f)
 *      slot is free for the first real complaint against that order.
 *
 * The order itself is not touched in any other way: no status changes, no money
 * columns, no line items. Orders are append-only.
 *
 * ===========================================================================
 * HOW TO RUN IT
 * ===========================================================================
 *
 *   node scripts/close-placement-tickets.mjs            apply to LOCAL D1
 *   node scripts/close-placement-tickets.mjs --check    report, write nothing
 *   node scripts/close-placement-tickets.mjs --sql      print the SQL
 *   node scripts/close-placement-tickets.mjs --db-file=…  a specific .sqlite
 *
 * It is idempotent: after one run the predicates match nothing, because the
 * tickets are closed and the slots are NULL. Running it ten times leaves what
 * running it once left.
 *
 * ===========================================================================
 * IT HAS NO PATH TO PRODUCTION, STRUCTURALLY
 * ===========================================================================
 * THIS SITE IS LIVE. Exactly as `scripts/seed-catalogue.mjs`, this script opens
 * the Miniflare SQLite file under `.wrangler/state/v3/d1/` with `node:sqlite`
 * and writes to it directly. There is no Cloudflare client here, no `wrangler`
 * invocation, and `--remote` is refused rather than unsupported. Production is
 * changed by a human applying the reviewed output of `--sql`, having read it.
 *
 * ===========================================================================
 * THE PREDICATE IS DELIBERATELY NARROW
 * ===========================================================================
 * It matches only a row that carries EVERY fingerprint of the automatic
 * placement ticket at once: `kind = 'query'`, still open, never acknowledged,
 * never resolved, attached to an order, holding that order's
 * `complaint_ticket_number`, subject exactly `Order <number>`, and a ticket
 * number that is the order's own number with the marker the old
 * `ticketNumberFor()` inserted. A ticket a human typed cannot satisfy all of
 * those, so a real complaint cannot be closed by this script.
 */

import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveLocalD1Path } from "./seed-catalogue.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The fingerprint of a ticket the old placement batch wrote, as a SQL fragment
 * correlated to the outer table. `substr(order_number, 4)` drops the `AJ-`,
 * which `ticketNumberFor()` replaced with `AJ-C-`.
 */
function placementTicketPredicate(ticketAlias, orderAlias) {
  return `${ticketAlias}.kind = 'query'
      AND ${ticketAlias}.order_id = ${orderAlias}.id
      AND ${ticketAlias}.ticket_number = ${orderAlias}.complaint_ticket_number
      AND ${ticketAlias}.subject = 'Order ' || ${orderAlias}.order_number
      AND ${ticketAlias}.ticket_number = 'AJ-C-' || substr(${orderAlias}.order_number, 4)`;
}

const RESOLUTION_NOTE =
  "Opened automatically when the order was placed, before it was understood " +
  "that E-Commerce Rule 4(5) runs from the receipt of a consumer complaint " +
  "rather than from a purchase. No complaint was ever lodged and no redressal " +
  "was owed, so this is closed rather than resolved. The order number remains " +
  "the customer's reference; a real complaint is issued its own Rule 7(1)(f) " +
  "number.";

/** How many rows the two statements below would change, as SQL. */
export const COUNT_PLACEMENT_TICKETS = `
  SELECT count(*) AS "tickets"
  FROM support_tickets t
  JOIN orders o ON o.id = t.order_id
  WHERE t.status = 'open'
    AND t.acknowledged_at IS NULL
    AND t.resolved_at IS NULL
    AND ${placementTicketPredicate("t", "o")}`;

export const COUNT_OCCUPIED_SLOTS = `
  SELECT count(*) AS "orders"
  FROM orders o
  WHERE o.complaint_ticket_number IS NOT NULL
    AND EXISTS (SELECT 1 FROM support_tickets t WHERE ${placementTicketPredicate("t", "o")})`;

/**
 * The two statements, in the order they must run: the second one erases the
 * `complaint_ticket_number` the first one matches on.
 */
export function buildBackfillSql({ now = new Date().toISOString() } = {}) {
  const note = RESOLUTION_NOTE.replaceAll("'", "''");

  return [
    `UPDATE support_tickets
     SET status = 'closed',
         resolution_note = coalesce(resolution_note, '${note}'),
         updated_at = '${now}'
     WHERE status = 'open'
       AND acknowledged_at IS NULL
       AND resolved_at IS NULL
       AND EXISTS (
         SELECT 1 FROM orders o
         WHERE ${placementTicketPredicate("support_tickets", "o")}
       )`,
    `UPDATE orders
     SET complaint_ticket_number = NULL,
         updated_at = '${now}'
     WHERE complaint_ticket_number IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM support_tickets t
         WHERE ${placementTicketPredicate("t", "orders")}
       )`,
  ];
}

async function openSqlite(file) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error(
      "node:sqlite is unavailable in this Node build. Run this script with --sql\n" +
        "and apply the output with your own local SQLite client instead."
    );
  }
  return new sqlite.DatabaseSync(file);
}

function report(db) {
  return {
    ticketsToClose: db.prepare(COUNT_PLACEMENT_TICKETS).get().tickets,
    ordersHoldingASlot: db.prepare(COUNT_OCCUPIED_SLOTS).get().orders,
  };
}

async function main(argv) {
  const forbidden = argv.find((arg) => /^--remote\b/.test(arg) || arg === "--env=production");
  if (forbidden) {
    console.error(
      `Refusing to run: ${forbidden}. This script writes to the LOCAL D1 database only and has\n` +
        "no network path to Cloudflare. Production is changed by a human applying the reviewed\n" +
        "output of --sql, having read it first."
    );
    process.exitCode = 1;
    return;
  }

  if (argv.includes("--sql")) {
    process.stdout.write(`${buildBackfillSql().join(";\n\n")};\n`);
    return;
  }

  const dbFileArg = argv.find((arg) => arg.startsWith("--db-file="));
  const file = resolveLocalD1Path(dbFileArg?.slice("--db-file=".length));
  if (!existsSync(file)) throw new Error(`No such database file: ${file}`);

  const db = await openSqlite(file);
  try {
    db.exec("PRAGMA foreign_keys = ON;");
    console.log(`local D1: ${path.relative(ROOT, file)}`);
    console.log("before:", report(db));

    if (argv.includes("--check")) return;

    // One transaction: the tickets and the slots move together or not at all.
    db.exec("BEGIN");
    try {
      for (const statement of buildBackfillSql()) db.exec(statement);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    console.log("after: ", report(db));
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
