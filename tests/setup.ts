/**
 * Test setup, applied to every test file.
 *
 * Loads .env so database-backed tests find DATABASE_URL, and forces the
 * deterministic stub provider. Forcing the stub is not a convenience: a test
 * asserting a benefit verdict must never depend on a live model, and a suite
 * that silently started making paid API calls would be a problem of its own.
 */

import "dotenv/config";

/**
 * Point the suite at the TEST database before anything opens a connection.
 *
 * The scenario tests clear citizen data between cases. Without this they would
 * wipe the demo personas on every run, which is a bad thing to discover on a
 * demo day. Run `npm run db:test` once to migrate this schema.
 */
const testUrl = process.env.TEST_DATABASE_URL;

// Refuse rather than fall back. The scenario tests DELETE every citizen
// between cases; silently running them against DATABASE_URL would wipe
// whatever is there - the demo personas locally, or real data anywhere else.
if (!testUrl) {
  throw new Error(
    "TEST_DATABASE_URL is not set. The tests delete data, so they will not run against DATABASE_URL. Copy it from .env.example and run `npm run db:test`.",
  );
}
if (testUrl === process.env.DATABASE_URL) {
  throw new Error(
    "TEST_DATABASE_URL is the same as DATABASE_URL. The tests delete data; point them at a separate database.",
  );
}

process.env.DATABASE_URL = testUrl;

process.env.LLM_PROVIDER = "stub";

// Demo-mode features are off unless a test opts in, so a test cannot
// accidentally rely on the simulated clock being active.
// Forced, not defaulted: .env usually sets it to "true" for local work, and
// that would otherwise leak into every test.
process.env.DEMO_MODE = "false";
