/**
 * Action planning.
 *
 * Answers "what should we do next?" for a diagnosed gap. Distinct from the
 * Application Agent, which answers "how do we obtain this benefit?" - the two
 * are deliberately not merged, because repairing a blocked benefit and
 * claiming a new one have different inputs, failure modes and consent
 * contexts.
 *
 * The planner proposes; it never executes, and it never decides that
 * execution may proceed. That requires approval gate 2.
 *
 * Code-enforced constraints, again rather than prompt-enforced:
 *
 *   - A plan for an UNKNOWN cause is replaced with the only honest plan:
 *     escalate for human review. A model asked to plan against an unknown
 *     cause will happily invent confident steps.
 *   - Any step repeating an action that already failed for this gap is
 *     dropped, so a loop cannot retry the same thing forever.
 *   - `expectedOutcome` is mandatory, because re-verification needs something
 *     specific to check. A plan whose success cannot be defined cannot be
 *     verified, which would let the loop declare victory by default.
 */

import { llm } from "@/lib/llm";
import { log } from "@/lib/log";
import { ActionPlanSchema } from "./schemas";
import type { ActionKind, RootCauseKind } from "@/lib/generated/prisma/enums";

export interface PlanStep {
  kind: ActionKind;
  description: string;
  reason: string;
  documentsRequired: string[];
  informationRequired: string[];
  channel: string;
}

export interface PlanInput {
  schemeCode: string;
  schemeName: string;
  gapKind: string;
  gapDetail: string;
  rootCause: RootCauseKind;
  rootCauseReasoning: string;
  citedEvidence: string[];
  recommendedAction: ActionKind;
  attempt: number;
  /** Actions already tried for this gap, so they are not proposed again. */
  failedActions?: ActionKind[];
  applicationUrl?: string;
}

export interface PlanResult {
  summary: string;
  expectedOutcome: string;
  steps: PlanStep[];
  evidenceNeeded: string[];
  /** Set when the model's plan was replaced or filtered. */
  adjusted?: string;
  llm: { ok: boolean; provider: string; attempts: number; reason?: string };
}

const SYSTEM_PROMPT = `You plan the steps to recover a government benefit that has not reached an Indian citizen.

Rules you must follow:

1. Propose the fewest steps that could actually resolve the stated cause. Do not add steps that merely look thorough.
2. Every step must have a reason tied to the diagnosed cause.
3. State expectedOutcome as something that can be checked later, such as "the next monthly payment is released and confirmed received". Do not write "the issue is resolved".
4. Do not propose an action listed as already failed.
5. Use plain language. The citizen will read this.
6. Never propose paying a fee, contacting an intermediary, or anything requiring money from the citizen.

Return only JSON.`;

/** The only honest plan when the cause is unknown. */
function escalationPlan(input: PlanInput, reason: string): PlanResult {
  return {
    summary: "Refer this case for human review.",
    expectedOutcome:
      "A caseworker establishes why this benefit has not arrived and records the next step.",
    steps: [
      {
        kind: "ESCALATE_GRIEVANCE",
        description: `Raise a grievance with the department administering ${input.schemeName}, setting out what is known.`,
        reason,
        documentsRequired: [],
        informationRequired: [],
        channel: "Grievance portal",
      },
    ],
    evidenceNeeded: ["A response from the department"],
    adjusted: reason,
    llm: { ok: true, provider: "engine", attempts: 0 },
  };
}

export async function planCorrectiveAction(
  input: PlanInput,
): Promise<PlanResult> {
  // An unknown cause gets the escalation plan without consulting a model. A
  // model asked to plan against "UNKNOWN" produces confident steps toward a
  // problem nobody has identified.
  if (input.rootCause === "UNKNOWN") {
    return escalationPlan(
      input,
      "The cause of this gap could not be established from the available evidence, so it is escalated for human review rather than acted on speculatively.",
    );
  }

  const failed = input.failedActions ?? [];

  const prompt = [
    `Scheme: ${input.schemeName} (${input.schemeCode})`,
    input.applicationUrl ? `Official portal: ${input.applicationUrl}` : "",
    `Problem: ${input.gapKind} - ${input.gapDetail}`,
    `Diagnosed cause: ${input.rootCause}`,
    `Why: ${input.rootCauseReasoning}`,
    input.citedEvidence.length > 0
      ? `Evidence behind the diagnosis:\n${input.citedEvidence.map((e, i) => `${i + 1}. ${e}`).join("\n")}`
      : "",
    `Recommended action from diagnosis: ${input.recommendedAction}`,
    `Planning attempt: ${input.attempt}`,
    failed.length > 0
      ? `Actions already tried and FAILED for this gap: ${failed.join(", ")}. Do not propose these.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  const outcome = await llm().complete({
    task: "plan.correctiveAction",
    system: SYSTEM_PROMPT,
    prompt,
    schema: ActionPlanSchema,
  });

  if (!outcome.ok) {
    log.warn("actionPlanner.llm_failed", {
      schemeCode: input.schemeCode,
      reason: outcome.reason,
    });
    return {
      ...escalationPlan(
        input,
        "An action plan could not be generated automatically, so this is escalated for human review.",
      ),
      llm: {
        ok: false,
        provider: outcome.provider,
        attempts: outcome.attempts,
        reason: outcome.reason,
      },
    };
  }

  // Drop any step repeating an action that already failed, so the loop cannot
  // retry the same thing indefinitely.
  const kept = outcome.value.steps.filter((step) => !failed.includes(step.kind));
  const dropped = outcome.value.steps.length - kept.length;

  if (kept.length === 0) {
    return {
      ...escalationPlan(
        input,
        failed.length > 0
          ? `Every action proposed for this gap has already been tried without success (${failed.join(", ")}), so it is escalated for human review.`
          : "No actionable step could be planned, so this is escalated for human review.",
      ),
      llm: {
        ok: true,
        provider: outcome.provider,
        attempts: outcome.attempts,
      },
    };
  }

  if (dropped > 0) {
    log.info("actionPlanner.dropped_repeated_steps", {
      schemeCode: input.schemeCode,
      dropped,
    });
  }

  return {
    summary: outcome.value.summary,
    expectedOutcome: outcome.value.expectedOutcome,
    steps: kept,
    evidenceNeeded: outcome.value.evidenceNeeded,
    adjusted:
      dropped > 0
        ? `${dropped} proposed step(s) repeated an action that already failed and were removed.`
        : undefined,
    llm: {
      ok: true,
      provider: outcome.provider,
      attempts: outcome.attempts,
    },
  };
}
