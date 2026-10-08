/**
 * The Prisma client singleton.
 *
 * Prisma 7 removed the bundled query engine: a driver adapter is now required.
 * `PrismaPg` works against both local Postgres and Neon's pooled connection
 * string, so development and production share one code path.
 *
 * Next's dev server re-evaluates modules on every hot reload, which would
 * otherwise open a new connection pool per edit and exhaust Postgres within a
 * few saves. The instance is cached on `globalThis` in development only; in
 * production each serverless instance gets exactly one.
 */

import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "@/lib/generated/prisma/client";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env and fill it in.",
  );
}

function createClient(): PrismaClient {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    // Query text can contain citizen data, so queries are never logged
    // outside development.
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
