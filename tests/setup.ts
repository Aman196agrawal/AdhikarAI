/**
 * Test setup, applied to every test file.
 *
 * Loads .env so database-backed tests find DATABASE_URL, and forces the
 * deterministic stub provider. Forcing the stub is not a convenience: a test
 * asserting a benefit verdict must never depend on a live model, and a suite
 * that silently started making paid API calls would be a problem of its own.
 */

import "dotenv/config";

process.env.LLM_PROVIDER = "stub";

// Demo-mode features are off unless a test opts in, so a test cannot
// accidentally rely on the simulated clock being active.
process.env.DEMO_MODE ??= "false";
