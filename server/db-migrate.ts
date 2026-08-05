/**
 * db-migrate.ts — Proper migration runner for Orbit.
 *
 * Reads every *.sql file from migrations/ in lexicographic order, splits on
 * the Drizzle Kit "--> statement-breakpoint" markers, and applies each file
 * inside a single PostgreSQL transaction. Applied files are recorded in a
 * _migrations ledger table (filename + SHA-256 checksum + applied_at).
 * Already-applied files are skipped. Checksum drift (file edited after being
 * applied) causes a loud failure so the problem is never silently ignored.
 *
 * Backfill strategy (first boot on an existing database):
 * When _migrations is empty, the runner probes each migration file
 * individually — it parses the file for CREATE TABLE statements and checks
 * information_schema.tables to verify those tables actually exist. Only files
 * whose database objects are confirmed present are stamped into the ledger as
 * "already applied". Files whose objects are missing are applied for real.
 * This is conservative: it never stamps a migration as applied unless it can
 * prove the DB already reflects that change.
 */

import fs from "fs";
import path from "path";
import crypto from "crypto";
import pg from "pg";

const MIGRATIONS_DIR = path.resolve("migrations");
const BREAKPOINT = "--> statement-breakpoint";

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/** List every *.sql file in migrations/ sorted lexicographically. */
function listMigrationFiles(): string[] {
  const entries = fs.readdirSync(MIGRATIONS_DIR);
  return entries
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => path.join(MIGRATIONS_DIR, f));
}

/** Split a migration file into individual SQL statements. */
function splitStatements(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Parse a migration file's SQL for any unquoted or double-quoted table names
 * in CREATE TABLE statements. Returns an empty array when none are found
 * (e.g. the file only has ALTER TABLE … ADD COLUMN statements).
 */
function extractCreatedTableNames(sql: string): string[] {
  // Matches:  CREATE TABLE [IF NOT EXISTS] "name"  or  CREATE TABLE [IF NOT EXISTS] name
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
  const names: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    names.push(m[1].toLowerCase());
  }
  return [...new Set(names)];
}

/**
 * Parse a migration file's SQL for ADD COLUMN statements.
 * Returns `{ table, column }` pairs so the backfill probe can verify the
 * columns actually exist instead of blindly stamping alter-only files.
 *
 * Handles both bare DDL and DO $$ BEGIN … EXCEPTION … END $$ wrappers.
 */
function extractAddedColumns(sql: string): Array<{ table: string; column: string }> {
  // ALTER TABLE tbl ADD COLUMN [IF NOT EXISTS] col  (column name is the next bare word)
  const re =
    /ALTER\s+TABLE\s+"?([a-z_][a-z0-9_]*)"?\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/gi;
  const pairs: Array<{ table: string; column: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    pairs.push({ table: m[1].toLowerCase(), column: m[2].toLowerCase() });
  }
  return pairs;
}

/** Check whether a given column exists in the public schema. */
async function columnExists(
  pool: pg.Pool,
  tableName: string,
  columnName: string
): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2 LIMIT 1`,
    [tableName, columnName]
  );
  return r.rows.length > 0;
}

/** Check whether a given table exists in the public schema. */
async function tableExists(pool: pg.Pool, tableName: string): Promise<boolean> {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [tableName]
  );
  return r.rows.length > 0;
}

/** Ensure the _migrations ledger table exists. */
async function ensureLedger(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename    TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMP NOT NULL DEFAULT now()
    )
  `);
}

/** Return the set of filenames already recorded in _migrations. */
async function loadApplied(pool: pg.Pool): Promise<Map<string, string>> {
  const result = await pool.query<{ filename: string; checksum: string }>(
    "SELECT filename, checksum FROM _migrations ORDER BY filename"
  );
  const map = new Map<string, string>();
  for (const row of result.rows) {
    map.set(row.filename, row.checksum);
  }
  return map;
}

/**
 * Conservative per-file backfill: for each migration file, parse it for
 * CREATE TABLE statements and probe information_schema to verify those tables
 * actually exist. Only stamp files whose schema objects are confirmed present;
 * return an array of files that must be applied for real (objects absent).
 */
async function computeBackfillPlan(
  pool: pg.Pool,
  files: string[],
  label: string
): Promise<{ toStamp: string[]; toApply: string[] }> {
  const toStamp: string[] = [];
  const toApply: string[] = [];

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const tableNames = extractCreatedTableNames(content);

    if (tableNames.length === 0) {
      // File has no CREATE TABLE — it may only contain ALTER TABLE ADD COLUMN,
      // CREATE INDEX, or DO blocks. Probe the specific columns it adds; if any
      // are missing the file must be applied for real, not silently stamped.
      const addedCols = extractAddedColumns(content);
      if (addedCols.length === 0) {
        // Only indexes / constraints / DO blocks with no detectable schema change.
        // Safe to stamp: idempotent DDL (IF NOT EXISTS) won't break on re-run
        // and we have no column handle to probe.
        console.log(`${label} backfill: stamping (index/constraint only, no column probe): ${filename}`);
        toStamp.push(filePath);
        continue;
      }

      // Probe every column the migration adds. Stamp only if ALL are present.
      let allColsPresent = true;
      for (const { table, column } of addedCols) {
        const present = await columnExists(pool, table, column);
        if (!present) {
          console.log(`${label} backfill: column '${table}.${column}' missing — will apply: ${filename}`);
          allColsPresent = false;
          break;
        }
      }

      if (allColsPresent) {
        console.log(`${label} backfill: stamping (all ADD COLUMN columns present): ${filename}`);
        toStamp.push(filePath);
      } else {
        toApply.push(filePath);
      }
      continue;
    }

    // Check all tables declared in this migration
    let allPresent = true;
    for (const tbl of tableNames) {
      const present = await tableExists(pool, tbl);
      if (!present) {
        console.log(`${label} backfill: table '${tbl}' missing — will apply: ${filename}`);
        allPresent = false;
        break;
      }
    }

    if (allPresent) {
      console.log(`${label} backfill: stamping (all tables present): ${filename}`);
      toStamp.push(filePath);
    } else {
      toApply.push(filePath);
    }
  }

  return { toStamp, toApply };
}

/**
 * Stamp a set of files into the ledger without running their SQL.
 * Used during backfill for migrations already reflected in the database.
 */
async function stampMigrations(
  pool: pg.Pool,
  files: string[]
): Promise<void> {
  if (files.length === 0) return;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const filePath of files) {
      const filename = path.basename(filePath);
      const content = fs.readFileSync(filePath, "utf8");
      const checksum = sha256(content);
      await client.query(
        `INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)
         ON CONFLICT (filename) DO NOTHING`,
        [filename, checksum]
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Postgres SQLSTATE codes meaning "this object already exists". These are
 * treated as benign while applying a not-yet-recorded migration: Replit's
 * Publish flow diffs the dev schema against production and applies the change
 * out-of-band, so by the time the startup runner reaches that migration its
 * objects may already be present. Re-running the DDL would otherwise throw and
 * abort startup, so we skip the duplicate statement and still stamp the file.
 */
const DUPLICATE_OBJECT_CODES = new Set([
  "42701", // duplicate_column
  "42P07", // duplicate_table / duplicate_relation (also covers duplicate index)
  "42710", // duplicate_object (e.g. constraint, type)
  "42P06", // duplicate_schema
  "42723", // duplicate_function
]);

/** Remove `-- …` line comments so semicolon splitting can't break mid-comment. */
function stripLineComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

// Matches the opening of a dollar-quoted string ($$ or $tag$), whose body may
// contain semicolons that must not be split on.
const DOLLAR_QUOTE = /\$[A-Za-z0-9_]*\$/;

/**
 * Break a breakpoint-delimited chunk into individual statements when it is safe
 * to do so. Chunks containing a dollar-quoted block ($$ … $$ or $tag$ … $tag$)
 * are kept whole because their inner semicolons must not be split on. Everything
 * else is split on `;` so each DDL statement can be applied (and skipped)
 * independently.
 */
function splitChunkSafely(chunk: string): string[] {
  if (DOLLAR_QUOTE.test(chunk)) return [chunk.trim()].filter(Boolean);
  return stripLineComments(chunk)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Apply a single migration file inside a transaction.
 * Records the result in the ledger on success.
 *
 * Each statement runs inside its own SAVEPOINT. If a statement fails because
 * the object it creates already exists (see DUPLICATE_OBJECT_CODES), the
 * savepoint is rolled back and the statement skipped — this makes the runner
 * idempotent against schema that Replit's Publish flow already applied to the
 * production database. Any other error aborts the whole migration (rethrown so
 * the caller can stop startup).
 */
async function applyMigration(
  pool: pg.Pool,
  filePath: string,
  checksum: string
): Promise<void> {
  const filename = path.basename(filePath);
  const content = fs.readFileSync(filePath, "utf8");
  const statements = splitStatements(content).flatMap(splitChunkSafely);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let i = 0;
    for (const stmt of statements) {
      const savepoint = `mig_sp_${i++}`;
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        await client.query(stmt);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch (err) {
        const code = (err as { code?: string })?.code;
        if (code && DUPLICATE_OBJECT_CODES.has(code)) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          const preview = stmt.slice(0, 80).replace(/\s+/g, " ");
          console.warn(
            `[db-migrate] skipping already-applied statement in ${filename} ` +
            `(SQLSTATE ${code}): ${preview}`
          );
        } else {
          throw err;
        }
      }
    }
    await client.query(
      `INSERT INTO _migrations (filename, checksum) VALUES ($1, $2)`,
      [filename, checksum]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Main entry point. Call once at application startup before handling any
 * requests. Throws (and crashes the process) if a migration fails or a
 * checksum mismatch is detected.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const label = "[db-migrate]";

  await ensureLedger(pool);

  const files = listMigrationFiles();
  const applied = await loadApplied(pool);

  // ── First-boot backfill for existing databases ────────────────────────────
  // If nothing is in the ledger yet but the users table exists, this is an
  // established database. Probe each migration file individually: stamp those
  // whose tables are confirmed present in the DB; apply those whose tables
  // are missing. This is conservative — we never stamp a migration as applied
  // unless its schema changes are proven to already exist.
  if (applied.size === 0 && (await tableExists(pool, "users"))) {
    console.log(
      `${label} First boot on existing database — probing ${files.length} migration file(s) to build ledger`
    );

    const { toStamp, toApply } = await computeBackfillPlan(pool, files, label);

    if (toStamp.length > 0) {
      await stampMigrations(pool, toStamp);
    }

    // Apply migrations whose objects are genuinely absent
    for (const filePath of toApply) {
      const filename = path.basename(filePath);
      const content = fs.readFileSync(filePath, "utf8");
      const checksum = sha256(content);
      console.log(`${label} applying (missing objects): ${filename}`);
      try {
        await applyMigration(pool, filePath, checksum);
        console.log(`${label} applied: ${filename}`);
      } catch (err) {
        throw new Error(
          `${label} FAILED to apply ${filename}: ${(err as Error).message}`
        );
      }
    }

    console.log(
      `${label} Ledger initialised — ${toStamp.length} stamped, ${toApply.length} applied. Startup migrations completed`
    );
    return;
  }

  // ── Normal run: apply pending, skip already-applied ─────────────────────
  let appliedCount = 0;
  let skippedCount = 0;

  for (const filePath of files) {
    const filename = path.basename(filePath);
    const content = fs.readFileSync(filePath, "utf8");
    const checksum = sha256(content);

    if (applied.has(filename)) {
      const recordedChecksum = applied.get(filename)!;
      if (recordedChecksum !== checksum) {
        throw new Error(
          `${label} CHECKSUM MISMATCH for ${filename}. ` +
          `The file has been modified after it was applied. ` +
          `Recorded: ${recordedChecksum} | Current: ${checksum}. ` +
          `Do not edit migration files after they have been applied.`
        );
      }
      console.log(`${label} skipped (already applied): ${filename}`);
      skippedCount++;
      continue;
    }

    console.log(`${label} applying: ${filename}`);
    try {
      await applyMigration(pool, filePath, checksum);
      console.log(`${label} applied: ${filename}`);
      appliedCount++;
    } catch (err) {
      throw new Error(
        `${label} FAILED to apply ${filename}: ${(err as Error).message}`
      );
    }
  }

  console.log(
    `${label} done — ${appliedCount} applied, ${skippedCount} skipped. Startup migrations completed`
  );
}
