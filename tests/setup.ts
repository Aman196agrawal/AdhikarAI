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
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

process.env.LLM_PROVIDER = "stub";

// Demo-mode features are off unless a test opts in, so a test cannot
// accidentally rely on the simulated clock being active.
process.env.DEMO_MODE ??= "false";
