/**
 * Provider selection.
 *
 * `LLM_PROVIDER` chooses the implementation. The stub is the default when no
 * key is configured, so a fresh clone runs the whole loop rather than failing
 * at the first agent call.
 *
 * Registering the fixtures here (rather than inside stub.ts) keeps the stub
 * mechanism separate from the content it serves, and means importing the
 * provider is enough to have a working stub.
 */

import "./fixtures";

import { log } from "@/lib/log";
import { createGeminiProvider } from "./gemini";
import { createStubProvider } from "./stub";
import type { LlmProvider } from "./provider";

export type * from "./provider";
export { registerStubFixture, registeredStubTasks, resetStubFixtures } from "./stub";

let cached: LlmProvider | null = null;

function select(): LlmProvider {
  const configured = (process.env.LLM_PROVIDER ?? "").trim().toLowerCase();

  if (configured === "stub") return createStubProvider();

  if (configured === "gemini") {
    const gemini = createGeminiProvider();
    if (gemini.isConfigured) return gemini;

    // Falling back rather than throwing: a missing key should degrade the demo
    // to deterministic output, not take the application down. It is logged as
    // a warning because silently running on fixtures while believing you are
    // running on a model would be its own kind of bug.
    log.warn("llm.fallback_to_stub", {
      reason: "LLM_PROVIDER=gemini but GEMINI_API_KEY is empty",
    });
    return createStubProvider();
  }

  if (configured === "") {
    const gemini = createGeminiProvider();
    return gemini.isConfigured ? gemini : createStubProvider();
  }

  log.warn("llm.unknown_provider", { configured, using: "stub" });
  return createStubProvider();
}

/** The process-wide provider. */
export function llm(): LlmProvider {
  cached ??= select();
  return cached;
}

/** Force re-selection. Test helper, and used after changing env in dev. */
export function resetLlmProvider(): void {
  cached = null;
}
