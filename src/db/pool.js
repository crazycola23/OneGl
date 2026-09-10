import pg from "pg";

/**
 * PostgreSQL is optional: the collector still works artifact-only when
 * DATABASE_URL is absent, which keeps local runs usable without a server.
 */
export function databaseUrl() {
  const raw = process.env.DATABASE_URL;
  return raw && raw.trim() ? raw.trim() : null;
}

export function isDatabaseConfigured() {
  return databaseUrl() !== null;
}

export function createPool(overrides = {}) {
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set, so PostgreSQL persistence is disabled.");
  }
  return new pg.Pool({
    connectionString,
    max: 4,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ...overrides,
  });
}
