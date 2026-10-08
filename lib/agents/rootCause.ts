/**
 * Root cause analysis.
 *
 * Answers "why is this blocked?" for a detected gap.
 *
 * This is the one place a language model is genuinely the right tool: the
 * evidence is unstructured prose written by a government system ("credit
 * returned by the bank: Aadhaar is not seeded to the beneficiary account"),
 * and mapping that onto a cause is interpretation, not computation.
 *
 * It is also the place a model is most dangerous, because a fluent wrong
 * answer is indistinguishable from a right one and leads to a real action
 * being taken on a citizen's behalf. So the guard is in CODE, not in the
 * prompt:
 *
 *   - the model is handed a numbered evidence list and may only cite from it,
 *   - every citation is checked against that list; invented ones are dropped,
 *   - a diagnosis left with no surviving citation is FORCED to UNKNOWN,
 *     whatever the model claimed.
 *
 * UNKNOWN is a perfectly good answer. "We cannot tell you why, and here is a
 * human who can look" beats a confident fabrication that sends someone to the
 * wrong office.
 */

import { llm } from "@/lib/llm";
import { log } from "@/lib/log";
import { RootCauseSchema } from "./schemas";
import type { ActionKind, RootCauseKind } from "@/lib/generated/prisma/enums";

export interface EvidenceItem {
  /** Where it came from, e.g. "government status event", "audit finding". */
  source: string;
  detail: string;
}

export interface DiagnoseInput {
  schemeCode: string;
  schemeName: string;
  gapKind: string;
  gapDetail: string;
  /** Everything the diagnosis may rely on. The model sees only this. */
  evidence: EvidenceItem[];
  /** Incremented on re-diagnosis after a failed corrective action. */
  attempt: number;
  /** What was tried before and did not work, so it is not proposed again. */
  previousAttempts?: Array<{ cause: string; action: string; outcome: string }>;
}

export interface DiagnosisResult {
  kind: RootCauseKind;
  confidence: number;
  citedEvidence: string[];
  reasoning: string;
  recommendedAction: ActionKind;
  /** Set when a claimed cause was downgraded for lack of evidence. */
  downgradedFrom?: RootCauseKind;
  llm: { ok: boolean; provider: string; attempts: number; reason?: string };
}

const SYSTEM_PROMPT = `You explain why an Indian government benefit has not reached a citizen.

You are given a numbered list of evidence. Rules you must follow:

1. Cite evidence by quoting the relevant text from the numbered list. Never cite anything that is not in the list.
2. If the evidence does not identify a cause, answer UNKNOWN with an empty citation list. This is a correct and useful answer; do not guess.
3. Do not infer a cause from what is typical. A missing document is only the cause if the evidence says a document is missing.
4. Never restate an amount, date or reference that is not in the evidence.
5. If a previous corrective action is listed as having failed, do not recommend the same action again.

Return only JSON.`;

/**
 * Keep only citations that correspond to supplied evidence.
 *
 * Matching is loose on purpose - a model may quote a fragment or re-wrap
 * whitespace - but it must be grounded in real text. An unmatched citation is
 * a fabrication and is discarded.
 */
function keepGroundedCitations(
  claimed: string[],
  evidence: EvidenceItem[],
): string[] {
  const corpus = evidence
    .map((item) => `${item.source} ${item.detail}`.toLowerCase())
    .join("\n");

  return claimed.filter((citation) => {
    const needle = citation.toLowerCase().replace(/\s+/g, " ").trim();
    if (needle.length < 12) return false;

    if (corpus.includes(needle)) return true;

    // Fall back to distinctive-word overlap, so a lightly paraphrased quote of
    // real evidence survives while an invented sentence does not.
    const words = needle
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 4);
    if (words.length === 0) return false;

    const present = words.filter((w) => corpus.includes(w)).length;
    return present / words.length >= 0.7;
  });
}

/**
 * Confidence in a diagnosis.
 *
 * Derived, like every other confidence in this system, rather than asked of
 * the model. It reflects how much of the supplied evidence the conclusion
 * actually rests on, capped so an interpretation of prose never presents as
 * certainty.
 */
function confidenceFor(
  kind: RootCauseKind,
  citations: number,
  evidenceCount: number,
): number {
  if (kind === "UNKNOWN" || citations === 0) return 0;
  if (evidenceCount === 0) return 0;

  const coverage = Math.min(1, citations / Math.min(evidenceCount, 3));
  // 0.85 ceiling: this is an interpretation of unstructured text, and nothing
  // here should ever read as a settled fact.
  return Math.round(Math.min(0.85, 0.45 + coverage * 0.4) * 100) / 100;
}

export async function diagnoseGap(
  input: DiagnoseInput,
): Promise<DiagnosisResult> {
  const numbered = input.evidence
    .map((item, index) => `${index + 1}. [${item.source}] ${item.detail}`)
    .join("\n");

  const previous =
    input.previousAttempts && input.previousAttempts.length > 0
      ? `\nPrevious attempts that did NOT resolve this:\n${input.previousAttempts
          .map(
            (a, i) =>
              `${i + 1}. Diagnosed as ${a.cause}, tried ${a.action}, outcome: ${a.outcome}`,
          )
          .join("\n")}`
      : "";

  const prompt = [
    `Scheme: ${input.schemeName} (${input.schemeCode})`,
    `Problem detected: ${input.gapKind} - ${input.gapDetail}`,
    `Diagnosis attempt: ${input.attempt}`,
    previous,
    "",
    input.evidence.length > 0
      ? `Evidence:\n${numbered}`
      : "Evidence: none available.",
  ]
    .filter(Boolean)
    .join("\n");

  const outcome = await llm().complete({
    task: "diagnose.rootCause",
    system: SYSTEM_PROMPT,
    prompt,
    schema: RootCauseSchema,
  });

  if (!outcome.ok) {
    // A model failure must not produce a cause. It produces UNKNOWN and a
    // request for human review.
    log.warn("rootCause.llm_failed", {
      schemeCode: input.schemeCode,
      reason: outcome.reason,
    });
    return {
      kind: "UNKNOWN",
      confidence: 0,
      citedEvidence: [],
      reasoning:
        "The cause could not be established automatically, so this needs human review.",
      recommendedAction: "REQUEST_CLARIFICATION",
      llm: {
        ok: false,
        provider: outcome.provider,
        attempts: outcome.attempts,
        reason: outcome.reason,
      },
    };
  }

  const grounded = keepGroundedCitations(
    outcome.value.citedEvidence,
    input.evidence,
  );

  let kind = outcome.value.kind;
  let reasoning = outcome.value.reasoning;
  let recommendedAction = outcome.value.recommendedAction;
  let downgradedFrom: RootCauseKind | undefined;

  // The enforcement. A claimed cause with nothing real behind it is not a
  // cause, however plausible the wording.
  if (kind !== "UNKNOWN" && grounded.length === 0) {
    downgradedFrom = kind;
    kind = "UNKNOWN";
    recommendedAction = "REQUEST_CLARIFICATION";
    reasoning =
      `A cause of ${downgradedFrom} was proposed but could not be tied to any supplied evidence, ` +
      `so it has been recorded as unknown and referred for human review.`;

    log.warn("rootCause.downgraded_to_unknown", {
      schemeCode: input.schemeCode,
      claimedKind: downgradedFrom,
      claimedCitations: outcome.value.citedEvidence.length,
    });
  }

  if (grounded.length < outcome.value.citedEvidence.length) {
    log.warn("rootCause.dropped_ungrounded_citations", {
      schemeCode: input.schemeCode,
      claimed: outcome.value.citedEvidence.length,
      kept: grounded.length,
    });
  }

  return {
    kind,
    confidence: confidenceFor(kind, grounded.length, input.evidence.length),
    citedEvidence: grounded,
    reasoning,
    recommendedAction,
    downgradedFrom,
    llm: {
      ok: true,
      provider: outcome.provider,
      attempts: outcome.attempts,
    },
  };
}
