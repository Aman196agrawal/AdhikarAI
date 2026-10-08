/**
 * The payment reconciler: the heart of AdhikarAI.
 *
 * It takes four INDEPENDENT facts and produces one honest receipt state:
 *
 *   1. what the citizen is EXPECTED to receive,
 *   2. what the government REPORTS it disbursed,
 *   3. what the citizen SAYS happened,
 *   4. what the available EVIDENCE proves.
 *
 * Collapsing these four into a single `received` boolean is the mistake that
 * makes most benefit systems useless at the final mile, because it forces
 * "unknown" to be recorded as either "received" or "missing" - and both are
 * false. Here `UNKNOWN` is a first-class outcome with its own bucket.
 *
 * The governing rule, enforced by an exhaustive test over every input
 * combination: `gapAmount` is non-zero ONLY with positive evidence of absence.
 * An amount nobody has confirmed is UNVERIFIED, never MISSING.
 */

import {
  abs,
  nonNegative,
  sub,
  withinTolerance,
  ZERO,
  formatINR,
  type Paise,
} from "./money";
import type {
  CitizenReport,
  EvidenceResult,
  ReceiptState,
  VerificationMethod,
} from "@/lib/generated/prisma/enums";

/** What a document search found, if one was run. */
export interface EvidenceInput {
  result: EvidenceResult;
  /** The amount actually located, when the search found something. */
  matchedAmount: Paise | null;
}

export interface ReconcileInput {
  /**
   * The amount due. `null` for in-kind or variable benefits such as NFSA
   * foodgrain or an MGNREGA work guarantee, where no rupee figure applies and
   * a cash gap must never be fabricated.
   */
  expectedAmount: Paise | null;
  /** What the government says it released. `null` means nothing reported yet. */
  governmentReportedAmount: Paise | null;
  /** The citizen's answer. `null` means unanswered, which differs from NOT_SURE. */
  citizenReport: CitizenReport | null;
  evidence: EvidenceInput | null;
  /** Permitted difference when matching a credit. Defaults to exact. */
  tolerance?: Paise;
}

export interface ReconcileResult {
  receiptState: ReceiptState;
  /** Proven absent. Non-zero only with positive evidence of absence. */
  gapAmount: Paise;
  /** Reported as disbursed but unconfirmed. The honest home for unknown. */
  unverifiedAmount: Paise;
  /** Confirmed or proven to have arrived. */
  receivedAmount: Paise;
  /** The strongest source that settled this outcome. */
  method: VerificationMethod;
  /** True when the citizen's account and the evidence disagree. */
  hasConflict: boolean;
  /** Plain-language evidence trail, suitable for the Why? drawer. */
  reasons: string[];
}

/** Whether a credit of `matched` settles a due amount of `due`. */
function creditSettles(matched: Paise, due: Paise, tolerance: Paise): boolean {
  // An overpayment settles the amount due; only a shortfall is a problem.
  return matched >= due || withinTolerance(matched, due, tolerance);
}

export function reconcile(inputs: ReconcileInput): ReconcileResult {
  const {
    expectedAmount,
    governmentReportedAmount,
    citizenReport,
    evidence,
    tolerance = ZERO,
  } = inputs;

  const reasons: string[] = [];

  /** Cash reconciliation applies only when a rupee amount is expected. */
  const isCash = expectedAmount !== null;
  const expected = expectedAmount ?? ZERO;

  const evidenceResult: EvidenceResult | null = evidence?.result ?? null;
  const matched = evidence?.matchedAmount ?? null;

  const searchFound =
    evidenceResult === "MATCHED" || evidenceResult === "PARTIAL_MATCH";
  const searchFoundNothing = evidenceResult === "NO_MATCH";

  // -------------------------------------------------------------------------
  // Nothing reported yet
  // -------------------------------------------------------------------------
  if (governmentReportedAmount === null && !searchFound) {
    if (citizenReport === "NO") {
      // The citizen reports a non-arrival for something the government has not
      // recorded as released: a real gap, but its cause is upstream.
      reasons.push(
        "The citizen reports that this benefit has not arrived, and no disbursement has been recorded against it.",
      );
      return {
        receiptState: "PAYMENT_DISCREPANCY",
        // No disbursement was reported, so there is no disbursed amount to
        // call missing. The shortfall here is an entitlement gap, which the
        // gap detector classifies separately.
        gapAmount: ZERO,
        unverifiedAmount: ZERO,
        receivedAmount: ZERO,
        method: "CITIZEN_CONFIRMATION",
        hasConflict: false,
        reasons,
      };
    }

    reasons.push("No disbursement has been reported for this period yet.");
    return {
      receiptState: "NOT_DISBURSED",
      gapAmount: ZERO,
      unverifiedAmount: ZERO,
      receivedAmount: ZERO,
      method: "GOVERNMENT_RECORD",
      hasConflict: false,
      reasons,
    };
  }

  const reported = governmentReportedAmount ?? ZERO;

  if (governmentReportedAmount !== null && isCash) {
    reasons.push(
      `The government records ${formatINR(reported)} as released against an expected ${formatINR(expected)}.`,
    );
  } else if (governmentReportedAmount !== null) {
    reasons.push("The government records this benefit as released.");
  }

  // A shortfall in what the government itself reports is proven by its own
  // record, independently of anything the citizen says.
  const reportedShortfall = isCash ? nonNegative(sub(expected, reported)) : ZERO;

  // -------------------------------------------------------------------------
  // Evidence located a credit
  // -------------------------------------------------------------------------
  if (searchFound && matched !== null) {
    const conflict = citizenReport === "NO";
    if (conflict) {
      reasons.push(
        `Conflict: the citizen reported not receiving this, but bank evidence shows a credit of ${formatINR(matched)}. Citizens often cannot tell that a transfer has arrived, so the evidence is taken as authoritative and the conflict recorded.`,
      );
    }

    // Measure the credit against what was actually due.
    const due = isCash ? expected : matched;

    if (creditSettles(matched, due, tolerance)) {
      reasons.push(
        `Bank evidence matches the expected amount${isCash ? ` of ${formatINR(expected)}` : ""}.`,
      );
      return {
        receiptState: "VERIFIED_RECEIVED",
        gapAmount: ZERO,
        unverifiedAmount: ZERO,
        receivedAmount: isCash ? matched : ZERO,
        method: "BANK_EVIDENCE",
        hasConflict: conflict,
        reasons,
      };
    }

    const shortfall = nonNegative(sub(due, matched));
    reasons.push(
      `Bank evidence shows only ${formatINR(matched)} against ${formatINR(due)} due, a shortfall of ${formatINR(shortfall)}.`,
    );
    return {
      receiptState: "PAYMENT_DISCREPANCY",
      gapAmount: isCash ? shortfall : ZERO,
      unverifiedAmount: ZERO,
      receivedAmount: isCash ? matched : ZERO,
      method: "BANK_EVIDENCE",
      hasConflict: conflict,
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // Citizen says the money did not arrive
  // -------------------------------------------------------------------------
  if (citizenReport === "NO") {
    reasons.push(
      "The citizen states they did not receive this payment, so the disbursed amount is treated as not having reached them.",
    );
    if (searchFoundNothing) {
      reasons.push(
        "A search of the supplied bank evidence found no matching credit, which corroborates this.",
      );
    }
    return {
      receiptState: "PAYMENT_DISCREPANCY",
      // The whole reported amount is proven absent: the government says it
      // left, and the citizen says it never arrived.
      gapAmount: isCash ? reported : ZERO,
      unverifiedAmount: ZERO,
      receivedAmount: ZERO,
      method: searchFoundNothing ? "BANK_EVIDENCE" : "CITIZEN_CONFIRMATION",
      hasConflict: false,
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // A search found nothing, but the citizen says it arrived
  // -------------------------------------------------------------------------
  if (searchFoundNothing && citizenReport === "YES") {
    // A failed search can mean the wrong account or the wrong date window.
    // With the citizen reporting receipt, asserting a discrepancy would be
    // overreach; unverified is the honest state.
    reasons.push(
      "Conflict: the citizen reports receiving this payment, but no matching credit was found in the evidence provided. This may indicate a different account or a date outside the window searched, so the receipt is left unverified rather than recorded as missing.",
    );
    return {
      receiptState: "DISBURSED_RECEIPT_UNVERIFIED",
      gapAmount: ZERO,
      unverifiedAmount: isCash ? reported : ZERO,
      receivedAmount: ZERO,
      method: "BANK_EVIDENCE",
      hasConflict: true,
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // The government itself reports less than was due
  // -------------------------------------------------------------------------
  if (reportedShortfall > ZERO) {
    reasons.push(
      `The amount released is ${formatINR(reportedShortfall)} short of the expected entitlement.`,
    );
    return {
      receiptState: "PAYMENT_DISCREPANCY",
      gapAmount: reportedShortfall,
      unverifiedAmount: ZERO,
      receivedAmount: citizenReport === "YES" ? reported : ZERO,
      method: citizenReport === "YES" ? "CITIZEN_CONFIRMATION" : "GOVERNMENT_RECORD",
      hasConflict: false,
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // Citizen confirms, without documentary evidence
  // -------------------------------------------------------------------------
  if (citizenReport === "YES") {
    reasons.push(
      "The citizen confirms receiving this payment. This is their own account rather than independent verification.",
    );
    return {
      receiptState: "CITIZEN_CONFIRMED",
      gapAmount: ZERO,
      unverifiedAmount: ZERO,
      receivedAmount: isCash ? reported : ZERO,
      method: "CITIZEN_CONFIRMATION",
      hasConflict: false,
      reasons,
    };
  }

  // -------------------------------------------------------------------------
  // Default: reported as released, nothing confirms receipt
  // -------------------------------------------------------------------------
  reasons.push(
    citizenReport === "NOT_SURE"
      ? "The citizen is not sure whether this payment arrived, so receipt has not been confirmed."
      : "Receipt has not been confirmed by the citizen and no evidence has been provided, so this amount is unverified rather than missing.",
  );

  return {
    receiptState: "DISBURSED_RECEIPT_UNVERIFIED",
    gapAmount: ZERO,
    unverifiedAmount: isCash ? reported : ZERO,
    receivedAmount: ZERO,
    method: "GOVERNMENT_RECORD",
    hasConflict: false,
    reasons,
  };
}

/** Re-exported for callers assembling evidence summaries. */
export { abs };
