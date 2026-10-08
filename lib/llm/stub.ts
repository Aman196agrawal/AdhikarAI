/**
 * The deterministic stub provider.
 *
 * Returns fixed, schema-valid output for every task. This is not a toy: it is
 * what makes the system properly testable and demonstrable.
 *
 *   - Every test runs against it, so the suite is fast, free and deterministic.
 *     A test asserting a benefit verdict must not depend on a model's mood.
 *   - `LLM_PROVIDER=stub` runs the entire closed loop with no API key, so the
 *     project can be cloned and demonstrated at zero cost.
 *   - It is the control case. If a bug appears only with Gemini selected, the
 *     fault is in the model layer, not the engine.
 *
 * Fixtures are registered per task and must satisfy the caller's Zod schema;
 * `generateValidated` validates stub output exactly as it validates Gemini's,
 * so a drifted fixture fails loudly instead of quietly returning the wrong
 * shape.
 *
 * An unregistered task fails with UNSUPPORTED_TASK rather than inventing a
 * plausible-looking object. Silently fabricating a diagnosis would be the
 * worst possible behaviour here.
 */

import { log } from "@/lib/log";
import {
  generateValidated,
  type LlmOutcome,
  type LlmProvider,
  type LlmRequest,
} from "./provider";

/**
 * A fixture receives the request so it can echo back grounded detail (the
 * scheme code it was asked about, for instance) and stay internally
 * consistent with the prompt.
 */
export type StubFixture = (request: LlmRequest<unknown>) => unknown;

const fixtures = new Map<string, StubFixture>();

/** Register a fixture for a task. Later registrations replace earlier ones. */
export function registerStubFixture(task: string, fixture: StubFixture): void {
  fixtures.set(task, fixture);
}

export function registeredStubTasks(): string[] {
  return [...fixtures.keys()].sort();
}

/** Clear all fixtures. Test helper. */
export function resetStubFixtures(): void {
  fixtures.clear();
}

export function createStubProvider(): LlmProvider {
  return {
    name: "stub",
    isConfigured: true,

    async complete<T>(request: LlmRequest<T>): Promise<LlmOutcome<T>> {
      const fixture = fixtures.get(request.task);

      if (!fixture) {
        log.warn("llm.stub.unsupported_task", {
          task: request.task,
          registered: registeredStubTasks().length,
        });
        return {
          ok: false,
          reason: "UNSUPPORTED_TASK",
          message:
            `No stub fixture is registered for task "${request.task}". ` +
            `Register one in lib/llm/fixtures.ts, or set LLM_PROVIDER=gemini. ` +
            `Registered tasks: ${registeredStubTasks().join(", ") || "(none)"}.`,
          provider: "stub",
          attempts: 0,
        };
      }

      // Routed through the same validation path as a real provider, so stub
      // output is held to the identical schema contract.
      const outcome = await generateValidated(request, "stub", async () =>
        JSON.stringify(fixture(request as LlmRequest<unknown>)),
      );

      log.debug("llm.complete", {
        task: request.task,
        provider: "stub",
        ok: outcome.ok,
        attempts: outcome.attempts,
      });

      return outcome;
    },
  };
}
