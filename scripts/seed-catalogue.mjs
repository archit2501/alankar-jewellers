/**
 * SEED THE CATALOGUE — LOCAL D1 ONLY.
 *
 * ===========================================================================
 * HOW TO RUN IT
 * ===========================================================================
 *
 *   node scripts/seed-catalogue.mjs             apply to the LOCAL D1 database
 *   node scripts/seed-catalogue.mjs --sql       print the SQL, write nothing
 *   node scripts/seed-catalogue.mjs --check     report what is in local D1
 *   node scripts/seed-catalogue.mjs --db-file=… point at a specific .sqlite
 *
 * It is idempotent. Every statement is an upsert keyed on a DETERMINISTIC id
 * (`prd_<slug>`, `var_<slug>`, `col_<slug>`), and the membership rows a piece no
 * longer belongs to are deleted, so running it ten times leaves the same rows as
 * running it once — including after the seed itself has been edited.
 *
 * ===========================================================================
 * WHY IT CANNOT TOUCH PRODUCTION, STRUCTURALLY
 * ===========================================================================
 * THIS SITE IS LIVE. This script therefore has no network path at all: it opens
 * the Miniflare SQLite file under `.wrangler/state/v3/d1/` with `node:sqlite`
 * and writes to it directly. There is no Cloudflare API client here, no
 * `wrangler` invocation, and no code path that could be pointed at `--remote` by
 * a stray flag — a remote flag is refused outright, and the resolved absolute
 * file path is printed before anything is written so it is obvious what was hit.
 *
 * If the local database does not exist yet, run `npm run dev` once (which lets
 * Miniflare create and migrate it) and then re-run this script.
 *
 * `--sql` exists so the same statements can be reviewed, or handed to
 * `wrangler d1 execute … --local --file=…` by a human who wants to. Note that
 * `wrangler.jsonc` does NOT declare a `d1_databases` binding — the binding is
 * injected by `vite.config.ts` for dev — so a bare `wrangler d1 execute` will
 * not find the database without a `--config` of its own. The direct path above
 * is the supported one.
 *
 * ===========================================================================
 * WHAT IS SEEDED, AND WHAT IS DELIBERATELY NULL
 * ===========================================================================
 * The rows come from `CATALOGUE_SEED_ROWS` in `app/_data/catalogue.ts`, which is
 * also what the storefront falls back to when D1 is unreachable — one definition,
 * so the database and the fallback cannot disagree.
 *
 * These are PLACEHOLDER pieces for a shop whose real catalogue has not been
 * photographed or weighed. So:
 *
 *   pricing_mode           'on_request' for all five. No figure is invented.
 *   net_metal_weight_mg    NULL — nothing has been weighed.
 *   gross_weight_mg        NULL — same.
 *   fineness               NULL — nothing has been assayed.
 *   hallmark_purity_mark   NULL — there is no hallmark to transcribe.
 *   making_charge_*        NULL — no rate card has been given to us.
 *   huid                   NULL — a HUID is a government-issued identifier.
 *                          Inventing one is not a placeholder, it is a fake
 *                          credential.
 *   certificate_number     NULL — same argument.
 *   certificate_lab        NULL — same argument.
 *
 *   hallmarking_paise      0, and this is NOT a placeholder. QCO cl. 2(3)
 *                          exempts Kundan, Polki and Jadau from mandatory
 *                          hallmarking, and app/_pricing/price.ts emits no
 *                          component at all for a zero, so no invoice can imply
 *                          a hallmark that does not exist.
 *   is_unique_piece        1 and stock_quantity 1 — one-of-a-kind is the norm
 *                          here, and `variants_unique_piece_stock_ck` enforces
 *                          the pairing.
 *   diamond_origin         'none', the schema default. Polki IS uncut diamond,
 *                          but no stone in these placeholder rows has been
 *                          examined, so neither 'natural' nor 'lab_grown' can be
 *                          asserted and the enum has no "unknown" member. No UI
 *                          reads this column; it must be set properly by the
 *                          admin when a real piece is entered.
 *   status/sale_mode       'active'. The five heirloom pieces are
 *                          'enquire_only'; the demonstration stock is
 *                          'buy_online'. Read off the piece, not the row, so
 *                          there is one literal per piece. Online ordering is not
 *                          open, which is what the homepage already says.
 */

import { existsSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/* -------------------------------------------------------------------------
 * Importing a TypeScript module from a plain script.
 *
 * Node strips types in `.ts` (>= 22.18, unflagged) but does NOT do extension or
 * directory resolution, and `app/_data/catalogue.ts` reaches `../../db`, which
 * reaches `cloudflare:workers`. These hooks add exactly that resolution, so the
 * seed data has ONE definition instead of being copied into this file where it
 * would drift.
 * ---------------------------------------------------------------------- */

const WORKERS_STUB = "data:text/javascript,export const env = {};export default { env };";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      // Delegate first: under `node --import ./tests/setup.mjs` the real stub is
      // already registered and mutating `env` has to keep working. Only when
      // nothing else has redirected the specifier — it comes back still on the
      // `cloudflare:` scheme, which no ESM loader can fetch — is the inert stub
      // below substituted, so this script runs standalone too.
      let resolved;
      try {
        resolved = nextResolve(specifier, context);
      } catch {
        return { url: WORKERS_STUB, shortCircuit: true };
      }
      return resolved?.url?.startsWith("cloudflare:")
        ? { url: WORKERS_STUB, shortCircuit: true }
        : resolved;
    }

    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const base = context.parentURL ?? pathToFileURL(path.join(ROOT, "index.mjs")).href;
      const target = new URL(specifier, base);
      if (target.protocol === "file:") {
        const filePath = fileURLToPath(target);
        if (!path.extname(filePath)) {
          for (const candidate of [`${filePath}.ts`, path.join(filePath, "index.ts")]) {
            if (existsSync(candidate)) {
              return { url: pathToFileURL(candidate).href, shortCircuit: true };
            }
          }
        }
      }
    }

    return nextResolve(specifier, context);
  },
});

const { CATALOGUE_COLLECTIONS, CATALOGUE_SEED_ROWS } = await import(
  "../app/_data/catalogue.ts"
);

/* -------------------------------------------------------------------------
 * SQL generation. No parameters and no driver: the output has to be readable,
 * diffable and hand-runnable, so every value is rendered as a literal — and
 * rendered by one function that refuses anything it does not recognise.
 * ---------------------------------------------------------------------- */

export function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`Refusing to emit a non-integer number: ${String(value)}`);
    }
    return String(value);
  }
  if (typeof value !== "string") {
    throw new Error(`Refusing to emit a ${typeof value} as SQL.`);
  }
  return `'${value.replace(/'/g, "''")}'`;
}

function upsert(table, columns, row, updateColumns) {
  const names = columns.join(", ");
  const values = columns.map((column) => sqlLiteral(row[column])).join(", ");
  const updates = updateColumns
    .map((column) => `  ${column} = excluded.${column}`)
    .join(",\n");
  const conflict = table === "product_collections" ? "product_id, collection_id" : "id";
  return `INSERT INTO ${table} (${names})\nVALUES (${values})\nON CONFLICT(${conflict}) DO UPDATE SET\n${updates};`;
}

const COLLECTION_COLUMNS = [
  "id",
  "slug",
  "title",
  "description",
  "kind",
  "parent_id",
  "position",
  "is_visible",
  "created_at",
  "updated_at",
];

const PRODUCT_COLUMNS = [
  "id",
  "slug",
  "title",
  "subtitle",
  "description",
  "craft",
  "status",
  "sale_mode",
  "seo_title",
  "seo_description",
  "created_at",
  "updated_at",
];

const VARIANT_COLUMNS = [
  "id",
  "product_id",
  "sku",
  "metal",
  "fineness",
  "size",
  "colour",
  "pricing_mode",
  "net_metal_weight_mg",
  "gross_weight_mg",
  "making_charge_type",
  "making_charge_value",
  "stone_value_paise",
  "hallmarking_paise",
  "other_charges_paise",
  "fixed_price_paise",
  "huid",
  "hallmark_purity_mark",
  "certificate_number",
  "certificate_lab",
  "diamond_origin",
  "country_of_origin",
  "hsn_code",
  "is_unique_piece",
  "stock_quantity",
  "is_made_to_order",
  "lead_time_days",
  "position",
  "created_at",
  "updated_at",
];

/**
 * The columns an upsert may overwrite. `id` is the conflict key and `created_at`
 * records when the row first appeared — re-running the seed must not rewrite
 * either of them.
 */
const updatable = (columns) =>
  columns.filter((column) => column !== "created_at" && column !== "id");

const COLLECTION_ID_BY_SLUG = new Map(
  CATALOGUE_COLLECTIONS.map((collection) => [collection.slug, collection.id])
);

/**
 * Every statement, in dependency order: collections, then products, then
 * variants, then membership. No BEGIN/COMMIT — the caller owns the transaction,
 * because D1 rejects an explicit transaction inside a batch.
 */
export function buildSeedSql({ now = new Date().toISOString() } = {}) {
  const statements = [];

  for (const collection of CATALOGUE_COLLECTIONS) {
    statements.push(
      upsert(
        "collections",
        COLLECTION_COLUMNS,
        {
          id: collection.id,
          slug: collection.slug,
          title: collection.title,
          description: collection.description,
          kind: collection.kind,
          parent_id: null,
          position: collection.position,
          is_visible: true,
          created_at: now,
          updated_at: now,
        },
        updatable(COLLECTION_COLUMNS)
      )
    );
  }

  for (const row of CATALOGUE_SEED_ROWS) {
    const { piece } = row;

    statements.push(
      upsert(
        "products",
        PRODUCT_COLUMNS,
        {
          id: piece.id,
          slug: piece.slug,
          title: piece.title,
          subtitle: piece.subtitle,
          description: piece.description,
          craft: row.piece.craft,
          status: row.status,
          sale_mode: row.piece.saleMode,
          // No invented marketing copy in the SEO columns: the page falls back
          // to its own title and description, which are real.
          seo_title: null,
          seo_description: null,
          created_at: now,
          updated_at: now,
        },
        updatable(PRODUCT_COLUMNS)
      )
    );
  }

  for (const row of CATALOGUE_SEED_ROWS) {
    const { piece } = row;

    statements.push(
      upsert(
        "variants",
        VARIANT_COLUMNS,
        {
          id: row.variantId,
          product_id: piece.id,
          sku: row.sku,
          metal: piece.metal,
          fineness: piece.fineness,
          size: null,
          colour: null,
          pricing_mode: piece.pricingMode,
          net_metal_weight_mg: piece.netMetalWeightMg,
          gross_weight_mg: piece.grossWeightMg,
          making_charge_type: piece.makingChargeType,
          making_charge_value: piece.makingChargeValue,
          stone_value_paise: piece.stoneValuePaise,
          hallmarking_paise: piece.hallmarkingPaise,
          other_charges_paise: piece.otherChargesPaise,
          fixed_price_paise: piece.fixedPricePaise,
          huid: piece.huid,
          hallmark_purity_mark: piece.hallmarkPurityMark,
          certificate_number: piece.certificateNumber,
          certificate_lab: piece.certificateLab,
          diamond_origin: "none",
          country_of_origin: "India",
          hsn_code: "7113",
          is_unique_piece: piece.isUniquePiece,
          stock_quantity: piece.stockQuantity,
          is_made_to_order: false,
          lead_time_days: null,
          position: row.position,
          created_at: now,
          updated_at: now,
        },
        updatable(VARIANT_COLUMNS)
      )
    );
  }

  for (const row of CATALOGUE_SEED_ROWS) {
    const { piece } = row;
    const ids = [];

    piece.collections.forEach((slug, index) => {
      const collectionId = COLLECTION_ID_BY_SLUG.get(slug);
      if (collectionId === undefined) {
        throw new Error(
          `"${piece.slug}" belongs to collection "${slug}", which is not in CATALOGUE_COLLECTIONS.`
        );
      }
      ids.push(collectionId);
      statements.push(
        upsert(
          "product_collections",
          ["product_id", "collection_id", "position"],
          { product_id: piece.id, collection_id: collectionId, position: index * 10 },
          ["position"]
        )
      );
    });

    // Idempotency in the other direction: a membership removed from the seed
    // has to be removed from the database too, or re-running after an edit
    // leaves the old row behind and the filter keeps matching.
    statements.push(
      `DELETE FROM product_collections\nWHERE product_id = ${sqlLiteral(piece.id)}\n  AND collection_id NOT IN (${ids
        .map(sqlLiteral)
        .join(", ")});`
    );
  }

  return statements;
}

/** The statements as one reviewable file. */
export function buildSeedSqlText(options) {
  return [
    "-- Generated by scripts/seed-catalogue.mjs. Idempotent: safe to re-run.",
    "-- LOCAL D1 ONLY. Never apply this to the production database by hand.",
    "",
    ...buildSeedSql(options).map((statement) => `${statement}\n`),
  ].join("\n");
}

/* -------------------------------------------------------------------------
 * Applying it, to the local file and nowhere else
 * ---------------------------------------------------------------------- */

const LOCAL_D1_DIR = path.join(ROOT, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");

export function resolveLocalD1Path(explicit) {
  if (explicit) {
    const resolved = path.resolve(ROOT, explicit);
    if (!existsSync(resolved)) throw new Error(`No such database file: ${resolved}`);
    return resolved;
  }

  if (!existsSync(LOCAL_D1_DIR)) {
    throw new Error(
      `No local D1 database yet (${LOCAL_D1_DIR} does not exist).\n` +
        "Run `npm run dev` once so Miniflare creates it, then re-run this script."
    );
  }

  const candidates = readdirSync(LOCAL_D1_DIR).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite"
  );

  if (candidates.length === 0) {
    throw new Error(
      `No local D1 database file in ${LOCAL_D1_DIR}.\n` +
        "Run `npm run dev` once so Miniflare creates it, then re-run this script."
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `More than one local D1 database in ${LOCAL_D1_DIR}:\n  ${candidates.join("\n  ")}\n` +
        "Pass --db-file=<path> to say which one."
    );
  }

  return path.join(LOCAL_D1_DIR, candidates[0]);
}

async function openSqlite(file) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    throw new Error(
      "node:sqlite is unavailable in this Node build. Run `node scripts/seed-catalogue.mjs --sql`\n" +
        "and apply the output with your own local SQLite client instead."
    );
  }
  return new sqlite.DatabaseSync(file);
}

function counts(db) {
  const read = (table) => db.prepare(`SELECT count(*) AS c FROM ${table}`).get().c;
  return {
    collections: read("collections"),
    products: read("products"),
    variants: read("variants"),
    memberships: read("product_collections"),
  };
}

async function main(argv) {
  // A remote flag is not "unsupported" here, it is refused. The site is live.
  const forbidden = argv.find((arg) => /^--remote\b/.test(arg) || arg === "--env=production");
  if (forbidden) {
    console.error(
      `Refusing to run: ${forbidden}. This script seeds the LOCAL D1 database only, and has no\n` +
        "network path to Cloudflare at all. The production catalogue is seeded through a\n" +
        "reviewed deployment, never from a developer's machine."
    );
    process.exitCode = 1;
    return;
  }

  if (argv.includes("--sql")) {
    process.stdout.write(buildSeedSqlText());
    return;
  }

  const dbFileArg = argv.find((arg) => arg.startsWith("--db-file="));
  const file = resolveLocalD1Path(dbFileArg?.slice("--db-file=".length));
  const db = await openSqlite(file);

  try {
    db.exec("PRAGMA foreign_keys = ON;");

    if (argv.includes("--check")) {
      console.log(`local D1: ${file}`);
      console.log(counts(db));
      return;
    }

    const statements = buildSeedSql();
    console.log(`local D1: ${file}`);
    console.log(`applying ${statements.length} statements…`);

    // One transaction, so a constraint failure halfway through leaves the
    // catalogue exactly as it was rather than half-seeded.
    db.exec("BEGIN");
    try {
      for (const statement of statements) db.exec(statement);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    console.log("seeded:", counts(db));
  } finally {
    db.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
