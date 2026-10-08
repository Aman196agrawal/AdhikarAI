/**
 * Confidence, derived rather than asked.
 *
 * The specification originally called for the LLM to report a confidence
 * number. We do not do that, deliberately. A model asked "how confident are
 * you, 0 to 1" produces a figure that looks rigorous, cannot be reproduced,
 * cannot be audited, and would be shown to a citizen next to a statement about
 * money they are owed.
 *
 * Instead confidence is a pure function of RULE COVERAGE: what fraction of the
 * scheme's mandatory conditions rest on documentary evidence, as opposed to the
 * citizen's own word, an inference, or nothing at all. That number is
 * reproducible, unit-testable, and explainable in one sentence to the person it
 * concerns.
 *
 * For a RED verdict the question changes. Overall coverage is beside the point;
 * what matters is how well-evidenced the single fact is that rules the citizen
 * out. Denying a pension on an age we merely guessed should not read as
 * certain, so a RED score reflects the provenance of the blocking clause.
 */

import type { EligibilityVerdict, ProvenanceLevel } from "@/lib/generated/prisma/enums";
import type { SchemeEvaluation } from "./rules";

/**
 * How much each provenance level contributes.
 *
 * Self-declaration is weighted well below documentary proof but far above
 * nothing: a citizen's own account of their age or widowhood is ordinary
 * evidence, not noise.
 */
export const PROVENANCE_WEIGHT: Record<ProvenanceLevel, number> = {
  DOCUMENT_VERIFIED: 1,
  SELF_DECLARED: 0.7,
  INFERRED: 0.5,
  MISSING: 0,
};

/**
 * Citizen-facing vocabulary for a score.
 *
 * Kept to four deliberately non-numeric words. A benefit decision must never
 * be communicated as "82% eligible", which implies a precision this system
 * does not have and a legal certainty it cannot offer.
 */
export type ConfidenceLabel = "verified" | "likely" | "potential" | "unverified";

export interface CoverageBreakdown {
  documentVerified: number;
  selfDeclared: number;
  inferred: number;
  missing: number;
  mandatoryTotal: number;
}

export interface ConfidenceResult {
  verdict: EligibilityVerdict;
  /** Coverage-derived score in [0, 1], rounded to two decimals. */
  confidence: number;
  label: ConfidenceLabel;
  coverage: CoverageBreakdown;
  /** What would raise the score, in plain language. */
  missingEvidence: string[];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function labelFor(confidence: number, verdict: EligibilityVerdict): ConfidenceLabel {
  if (verdict === "YELLOW") {
    // A yellow verdict is by definition not settled, so it never reads as
    // "verified" however well-covered the clauses we did answer are.
    return confidence >= 0.5 ? "potential" : "unverified";
  }
  if (confidence >= 1) return "verified";
  if (confidence >= 0.7) return "likely";
  if (confidence >= 0.5) return "potential";
  return "unverified";
}

/**
 * Compute confidence for an evaluated scheme.
 *
 * Only mandatory clauses count. Non-mandatory clauses inform ranking and
 * explanation but must not dilute the score: a scheme with many optional
 * conditions would otherwise look less certain than an identical one with
 * fewer, which is meaningless.
 */
export function computeConfidence(
  evaluation: SchemeEvaluation,
): ConfidenceResult {
  const mandatory = evaluation.clauses.filter((c) => c.mandatory);

  const coverage: CoverageBreakdown = {
    documentVerified: 0,
    selfDeclared: 0,
    inferred: 0,
    missing: 0,
    mandatoryTotal: mandatory.length,
  };

  for (const clause of mandatory) {
    switch (clause.provenance) {
      case "DOCUMENT_VERIFIED":
        coverage.documentVerified += 1;
        break;
      case "SELF_DECLARED":
        coverage.selfDeclared += 1;
        break;
      case "INFERRED":
        coverage.inferred += 1;
        break;
      case "MISSING":
        coverage.missing += 1;
        break;
    }
  }

  let confidence: number;

  if (evaluation.verdict === "RED") {
    // Confidence in the exclusion itself: the best-evidenced blocking clause.
    // "Best" rather than average because one solidly proven disqualification
    // is enough, regardless of what else is unknown.
    const blocking = evaluation.clauses.filter(
      (c) => c.mandatory && c.disqualifies,
    );
    confidence = blocking.reduce(
      (best, c) => Math.max(best, PROVENANCE_WEIGHT[c.provenance]),
      0,
    );
  } else if (mandatory.length === 0) {
    // The registry validator rejects clause-less schemes, so this is
    // unreachable in practice; returning 0 avoids a divide-by-zero producing
    // NaN and silently rendering as a blank score.
    confidence = 0;
  } else {
    const total = mandatory.reduce(
      (sum, c) => sum + PROVENANCE_WEIGHT[c.provenance],
      0,
    );
    confidence = total / mandatory.length;
  }

  const rounded = round2(Math.min(1, Math.max(0, confidence)));

  return {
    verdict: evaluation.verdict,
    confidence: rounded,
    label: labelFor(rounded, evaluation.verdict),
    coverage,
    missingEvidence: evaluation.missingEvidence,
  };
}
