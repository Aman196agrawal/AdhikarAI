/**
 * Create and migrate the TEST database.
 *
 * The scenario tests clear citizen data between cases, which would otherwise
 * destroy the demo personas on every suite run - a bad thing to discover on a
 * demo day. So tests use a separate database.
 *
 * It has to be a separate DATABASE, not a separate schema. Prisma 7 requires a
 * driver adapter, and the adapter is plain `pg`, which ignores the
 * Prisma-specific `?schema=` connection parameter. The CLI still honours it,
 * so migrations land in the named schema while the running client quietly
 * keeps writing to `public` - which looks exactly like working isolation until
 * your demo data disappears.
 */

import { spawnSync } from "node:child_process";

import { config } from "dotenv";
import pg from "pg";

config();

const url = process.env.TEST_DATABASE_URL;

if (!url) {
  console.error(
    "TEST_DATABASE_URL is not set. Copy it from .env.example into .env.",
  );
  process.exit(1);
}

if (url === process.env.DATABASE_URL) {
  console.error(
    "TEST_DATABASE_URL must differ from DATABASE_URL, or the suite will wipe your demo data.",
  );
  process.exit(1);
}

const parsed = new URL(url);
const database = parsed.pathname.replace(/^\//, "");

if (database === "" || parsed.searchParams.has("schema")) {
  console.error(
    `TEST_DATABASE_URL must name a separate DATABASE, not a schema. ` +
      `A "?schema=" parameter is ignored by the driver adapter at runtime.`,
  );
  process.exit(1);
}

// Connect to the maintenance database to create the test one if needed.
const admin = new URL(url);
admin.pathname = "/postgres";

const client = new pg.Client({ connectionString: admin.toString() });

try {
  await client.connect();
  const existing = await client.query(
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [database],
  );

  if (existing.rowCount === 0) {
    // Identifier cannot be parameterised; it comes from our own .env and is
    // quoted defensively.
    await client.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
    console.log(`Created test database "${database}".`);
  } else {
    console.log(`Test database "${database}" already exists.`);
  }
} catch (error) {
  console.error(
    `Could not reach Postgres to create the test database: ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  console.error("Is it running? Try: npm run db:up");
  process.exit(1);
} finally {
  await client.end().catch(() => undefined);
}

console.log("Applying migrations...");

// `shell: true` rather than resolving npx/npx.cmd by hand: picking the
// executable manually silently did nothing under Git Bash on Windows, which
// looked like a successful migration that had created no tables.
const result = spawnSync("npx prisma migrate deploy", {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, DATABASE_URL: url },
});

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
