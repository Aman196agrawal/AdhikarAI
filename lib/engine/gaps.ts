/**
 * Benefit gap detection and the audit decision.
 *
 * This is where the audit's separate strands - entitlement, application
 * status, payment, receipt, continuity - are turned into a single list of
 * concrete gaps and one of three decisions: HEALTHY, NEEDS_VERIFICATION, or
 * ACTION_REQUIRED.
 *
 * The distinction that carries the product: an unverified receipt produces a
 * RECEIPT_UNVERIFIED gap with a NULL amount and a NEEDS_VERIFICATION decision.
 * It is never a PAYMENT_MISSED gap, and its rupees are never added to a total
 * described as missing. "We cannot confirm this reached you" and "this did not
 * reach you" are different statements, and only one of them is true.
 */

import { add, ZERO, type Paise } from "./money";
import type { ContinuityGap } from "./continuity";
import type { ReconcileResult } from "./reconciler";
import type {
  ApplicationStatus,
  AuditDecision,
  EligibilityVerdict,
  GapKind,
} from "@/lib/generated/prisma/enums";

/** A detected gap, ready to persist and to diagnose. */
export interface DetectedGap {
  kind: GapKind;
  periodLabel: string | null;
  /**
   * Proven missing. NULL whenever the amount is genuinely unknown.
   *
   * Never a guess and never a placeholder zero: a null here renders as
   * "amount unknown", while a zero would render as "nothing missing".
   */
  amount: Paise | null;
  /** Evidence references and plain-language detail for the Why? drawer. */
  evidence: string[];
  /** Whether this gap needs a corrective action or only verification. */
  needsAction: boolean;
}

export interface GapDetectionInput {
  verdict: EligibilityVerdict;
  /** Null when the citizen has never applied. */
  applicationStatus: ApplicationStatus | null;
  /** Days since submission, for detecting a stalled application. */
  daysSinceSubmission?: number | null;
  rejectionReason?: string | null;
  missingDocuments?: string[];
  /** Result of reconciling the most recent payment, if any. */
  reconciliation?: ReconcileResult | null;
  continuityGaps?: readonly ContinuityGap[];
  /** Threshold past which a pending application counts as stalled. */
  pendingTooLongDays?: number;
}

export interface GapDetectionResult {
  gaps: DetectedGap[];
  decision: AuditDecision;
  /** Total proven missing. Excludes anything merely unverified. */
  totalProvenMissing: Paise;
  /** Total reported as paid but unconfirmed. Reported separately, always. */
  totalUnverified: Paise;
  summary: string;
}

/** Default: a government application sitting this long is stalled. */
const DEFAULT_PENDING_TOO_LONG_DAYS = 60;

export function detectGaps(input: GapDetectionInput): GapDetectionResult {
  const {
    verdict,
    applicationStatus,
    daysSinceSubmission = null,
    rejectionReason = null,
    missingDocuments = [],
    reconciliation = null,
    continuityGaps = [],
    pendingTooLongDays = DEFAULT_PENDING_TOO_LONG_DAYS,
  } = input;

  const gaps: DetectedGap[] = [];

  // -------------------------------------------------------------------------
  // Entitlement exists but was never claimed
  // -------------------------------------------------------------------------
  if (applicationStatus === null) {
    if (verdict === "GREEN") {
      gaps.push({
        kind: "NEVER_APPLIED",
        periodLabel: null,
        // The citizen is eligible but has claimed nothing. The foregone value
        // is a projection, not money owed, so no amount is asserted here; the
        // dashboard presents it as "potential" from the entitlement instead.
        amount: null,
        evidence: [
          "The citizen meets every mandatory condition for this scheme but no application has been recorded.",
        ],
        needsAction: true,
      });
    } else if (verdict === "YELLOW") {
      gaps.push({
        kind: "UNCLAIMED",
        periodLabel: null,
        amount: null,
        evidence: [
          "This scheme may apply, but required information is missing before an application can be prepared.",
        ],
        needsAction: false,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Application status problems
  // -------------------------------------------------------------------------
  switch (applicationStatus) {
    case "REJECTED":
      gaps.push({
        kind: "REJECTED",
        periodLabel: null,
        amount: null,
        evidence: [
          rejectionReason
            ? `The application was rejected: ${rejectionReason}`
            : "The application was rejected and no reason has been recorded.",
        ],
        needsAction: true,
      });
      break;

    case "RETURNED":
      gaps.push({
        kind: "MISSING_DOCUMENT",
        periodLabel: null,
        amount: null,
        evidence: [
          missingDocuments.length > 0
            ? `The application was returned pending: ${missingDocuments.join(", ")}.`
            : "The application was returned for further information.",
        ],
        needsAction: true,
      });
      break;

    case "SUBMISSION_FAILED":
      gaps.push({
        kind: "BLOCKED",
        periodLabel: null,
        amount: null,
        evidence: [
          "Submission to the government portal did not complete, so the application has not been lodged.",
        ],
        needsAction: true,
      });
      break;

    case "PENDING":
    case "SUBMITTED":
      if (
        daysSinceSubmission !== null &&
        daysSinceSubmission > pendingTooLongDays
      ) {
        gaps.push({
          kind: "APPLICATION_PENDING_TOO_LONG",
          periodLabel: null,
          amount: null,
          evidence: [
            `The application has been pending for ${Math.round(daysSinceSubmission)} days, beyond the ${pendingTooLongDays}-day threshold for escalation.`,
          ],
          needsAction: true,
        });
      }
      break;

    default:
      break;
  }

  if (missingDocuments.length > 0 && applicationStatus !== "RETURNED") {
    gaps.push({
      kind: "MISSING_DOCUMENT",
      periodLabel: null,
      amount: null,
      evidence: [`Documents still required: ${missingDocuments.join(", ")}.`],
      needsAction: true,
    });
  }

  // -------------------------------------------------------------------------
  // Receipt reconciliation
  // -------------------------------------------------------------------------
  let totalProvenMissing = ZERO;
  let totalUnverified = ZERO;

  if (reconciliation) {
    totalProvenMissing = add(totalProvenMissing, reconciliation.gapAmount);
    totalUnverified = add(totalUnverified, reconciliation.unverifiedAmount);

    if (reconciliation.receiptState === "PAYMENT_DISCREPANCY") {
      gaps.push({
        kind: "PAYMENT_MISSED",
        periodLabel: null,
        amount: reconciliation.gapAmount > ZERO ? reconciliation.gapAmount : null,
        evidence: reconciliation.reasons,
        needsAction: true,
      });
    } else if (
      reconciliation.receiptState === "DISBURSED_RECEIPT_UNVERIFIED"
    ) {
      gaps.push({
        kind: "RECEIPT_UNVERIFIED",
        periodLabel: null,
        // Deliberately NULL. The amount is not missing; it is unconfirmed.
        // Putting a figure here would let it be summed into a "missing" total.
        amount: null,
        evidence: reconciliation.reasons,
        // Verification, not a corrective action. Asking the citizen a yes/no
        // question is not the same as filing a grievance on their behalf.
        needsAction: false,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Continuity
  // -------------------------------------------------------------------------
  for (const gap of continuityGaps) {
    gaps.push({
      kind: gap.kind,
      periodLabel: gap.periodLabel,
      amount: gap.amount,
      evidence: [gap.detail],
      needsAction: gap.kind !== "PAYMENT_DELAYED",
    });

    if (gap.kind === "PAYMENT_MISSED" && gap.amount !== null) {
      totalProvenMissing = add(totalProvenMissing, gap.amount);
    }
  }

  // -------------------------------------------------------------------------
  // Decision
  // -------------------------------------------------------------------------
  const decision = decide(gaps);

  return {
    gaps,
    decision,
    totalProvenMissing,
    totalUnverified,
    summary: summarise(gaps, decision),
  };
}

/**
 * Classify the audit outcome.
 *
 * Precedence is ACTION_REQUIRED, then NEEDS_VERIFICATION, then HEALTHY. A gap
 * needing verification never escalates to ACTION_REQUIRED on its own: we do
 * not file grievances about payments we have simply not confirmed yet.
 */
export function decide(gaps: readonly DetectedGap[]): AuditDecision {
  if (gaps.some((g) => g.needsAction)) return "ACTION_REQUIRED";
  if (gaps.length > 0) return "NEEDS_VERIFICATION";
  return "HEALTHY";
}

function summarise(
  gaps: readonly DetectedGap[],
  decision: AuditDecision,
): string {
  if (decision === "HEALTHY") {
    return "This benefit is active and every expected payment is accounted for.";
  }

  if (decision === "NEEDS_VERIFICATION") {
    return `This benefit needs confirmation: ${gaps.map((g) => readable(g.kind)).join(", ")}.`;
  }

  const actionable = gaps.filter((g) => g.needsAction).map((g) => readable(g.kind));
  return `This benefit requires action: ${actionable.join(", ")}.`;
}

/** Gap kinds in citizen-readable form. */
export function readable(kind: GapKind): string {
  switch (kind) {
    case "NEVER_APPLIED":
      return "eligible but never applied";
    case "APPLICATION_PENDING_TOO_LONG":
      return "application stuck with the department";
    case "REJECTED":
      return "application rejected";
    case "BLOCKED":
      return "application blocked";
    case "MISSING_DOCUMENT":
      return "a document is missing";
    case "PAYMENT_MISSED":
      return "a payment did not arrive";
    case "PAYMENT_DELAYED":
      return "a payment arrived late";
    case "PAYMENT_INTERRUPTED":
      return "payments have stopped";
    case "UNCLAIMED":
      return "possibly eligible, not yet claimed";
    case "RECEIPT_UNVERIFIED":
      return "we cannot yet confirm you received this";
    case "RENEWAL_MISSED":
      return "a renewal is overdue";
    case "STATUS_UNKNOWN":
      return "the current status is unknown";
  }
}
