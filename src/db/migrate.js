import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { databaseUrl } from "./pool.js";

const MIGRATIONS_DIR = path.resolve("migrations");

// Statements such as CREATE INDEX CONCURRENTLY cannot run inside a transaction.
// A migration file opts out by containing this marker.
const NO_TRANSACTION_MARKER = "-- onegl:no-transaction";

function fileChecksum(sql) {
  return createHash("sha256").update(sql).digest("hex");
}

async function loadMigrations() {
  let names;
  try {
    names = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith(".sql")).sort();
  } catch (error) {
    throw new Error(`Cannot read ${MIGRATIONS_DIR}: ${error.message}`);
  }

  const migrations = [];
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    migrations.push({
      version: name.replace(/\.sql$/, ""),
      sql,
      checksum: fileChecksum(sql),
    });
  }
  return migrations;
}

async function ensureLedger(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(client) {
  const { rows } = await client.query("SELECT version, checksum FROM schema_migrations");
  return new Map(rows.map((row) => [row.version, row.checksum]));
}

async function withClient(handler) {
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set. Add it to .env before running migrations.");
  }
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await handler(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function migrate({ log = console.log } = {}) {
  return withClient(async (client) => {
    await ensureLedger(client);
    const migrations = await loadMigrations();
    const applied = await appliedVersions(client);

    // Refuse to run when an already-applied migration was edited afterwards: the
    // database and the repository would silently drift apart.
    for (const migration of migrations) {
      const previous = applied.get(migration.version);
      if (previous && previous !== migration.checksum) {
        throw new Error(
          `Migration ${migration.version} changed after it was applied. ` +
            "Add a new migration file instead of editing an applied one.",
        );
      }
    }

    const pending = migrations.filter((migration) => !applied.has(migration.version));
    if (!pending.length) {
      log(`No pending migrations (${migrations.length} already applied).`);
      return { applied: [], alreadyApplied: migrations.length };
    }

    const done = [];
    for (const migration of pending) {
      const useTransaction = !migration.sql.includes(NO_TRANSACTION_MARKER);
      log(`Applying ${migration.version}${useTransaction ? "" : " (outside a transaction)"}`);
      if (useTransaction) await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        if (useTransaction) await client.query("COMMIT");
        done.push(migration.version);
      } catch (error) {
        if (useTransaction) await client.query("ROLLBACK").catch(() => undefined);
        throw new Error(`Migration ${migration.version} failed: ${error.message}`, { cause: error });
      }
    }

    log(`Applied ${done.length} migration(s): ${done.join(", ")}`);
    return { applied: done, alreadyApplied: migrations.length - done.length };
  });
}

export async function status({ log = console.log } = {}) {
  return withClient(async (client) => {
    await ensureLedger(client);
    const migrations = await loadMigrations();
    const applied = await appliedVersions(client);
    const rows = migrations.map((migration) => ({
      version: migration.version,
      state: applied.has(migration.version) ? "applied" : "pending",
    }));
    log(`Migration status (${MIGRATIONS_DIR})`);
    for (const row of rows) log(`  ${row.state.padEnd(8)} ${row.version}`);
    return rows;
  });
}

async function main() {
  const [command = "up"] = process.argv.slice(2);
  if (command === "status") {
    await status();
    return;
  }
  if (command !== "up") throw new Error(`Unknown migrate command: ${command}`);
  await migrate();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
