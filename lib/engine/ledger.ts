/**
 * The benefit ledger projection and dashboard aggregation.
 *
 * The ledger is the per-benefit summary that feeds the dashboard, continuous
 * monitoring and re-audit. Aggregation is where the product's central
 * distinction is most at risk: once amounts are summed into headline figures,
 * it becomes tempting to add "unverified" into "missing" and show one big
 * number. This module keeps the buckets separate all the way to the UI.
 *
 * Four totals, four different meanings:
 *
 *   received   - confirmed or proven to have arrived
 *   unverified - reported as released, receipt not confirmed
 *   missing    - proven absent, with evidence
 *   potential  - value of entitlements not yet claimed; a projection, not a debt
 *
 * No function here returns their sum, because that sum would not mean anything.
 */

import { add, ZERO, type Paise } from "./money";
import type { ReconcileResult } from "./reconciler";
import type {
  ApplicationStatus,
  EligibilityVerdict,
  ReceiptState,
  RecoveryStatus,
} from "@/lib/generated/prisma/enums";

/**
 * Display severity of a receipt state: the ledger shows the most pressing
 * outstanding issue across all of a benefit's payments, not the latest one.
 * A single discrepancy matters more than three confirmed receipts.
 */
const RECEIPT_SEVERITY: Record<ReceiptState, number> = {
  PAYMENT_DISCREPANCY: 4,
  DISBURSED_RECEIPT_UNVERIFIED: 3,
  CITIZEN_CONFIRMED: 2,
  VERIFIED_RECEIVED: 1,
  NOT_DISBURSED: 0,
};

export interface LedgerInput {
  /** Per-instalment expected amount. Null for in-kind benefits. */
  expectedAmount: Paise | null;
  applicationStatus: ApplicationStatus | null;
  approvedAmount?: Paise | null;
  /** One reconciliation per payment period. */
  payments: readonly ReconcileResult[];
  recoveredAmount?: Paise;
  recoveryStatus?: RecoveryStatus;
  appliedAt?: Date | null;
  lastVerifiedAt?: Date | null;
  lastAuditAt?: Date | null;
}

export interface LedgerProjection {
  expectedAmount: Paise | null;
  approvedAmount: Paise | null;
  disbursedAmount: Paise;
  receivedAmount: Paise;
  /** Released but unconfirmed. Never folded into `gapAmount`. */
  unverifiedAmount: Paise;
  /** Proven absent, with evidence. */
  gapAmount: Paise;
  recoveredAmount: Paise;
  receiptState: ReceiptState;
  recoveryStatus: RecoveryStatus;
  appliedAt: Date | null;
  lastVerifiedAt: Date | null;
  lastAuditAt: Date | null;
}

/** Project a benefit's ledger row from its reconciled payments. */
export function projectLedger(input: LedgerInput): LedgerProjection {
  const {
    expectedAmount,
    applicationStatus,
    approvedAmount = null,
    payments,
    recoveredAmount = ZERO,
    recoveryStatus,
    appliedAt = null,
    lastVerifiedAt = null,
    lastAuditAt = null,
  } = input;

  let receivedAmount = ZERO;
  let unverifiedAmount = ZERO;
  let gapAmount = ZERO;
  let disbursedAmount = ZERO;

  let receiptState: ReceiptState = "NOT_DISBURSED";

  for (const payment of payments) {
    receivedAmount = add(receivedAmount, payment.receivedAmount);
    unverifiedAmount = add(unverifiedAmount, payment.unverifiedAmount);
    gapAmount = add(gapAmount, payment.gapAmount);

    // What the government released is what arrived plus what is unconfirmed
    // plus what went missing: all three came out of the treasury.
    disbursedAmount = add(
      disbursedAmount,
      add(add(payment.receivedAmount, payment.unverifiedAmount), payment.gapAmount),
    );

    if (RECEIPT_SEVERITY[payment.receiptState] > RECEIPT_SEVERITY[receiptState]) {
      receiptState = payment.receiptState;
    }
  }

  return {
    expectedAmount,
    approvedAmount,
    disbursedAmount,
    receivedAmount,
    unverifiedAmount,
    gapAmount,
    recoveredAmount,
    receiptState,
    recoveryStatus: recoveryStatus ?? deriveRecoveryStatus(gapAmount, recoveredAmount),
    appliedAt: appliedAt ?? (applicationStatus ? appliedAt : null),
    lastVerifiedAt,
    lastAuditAt,
  };
}

function deriveRecoveryStatus(
  gapAmount: Paise,
  recoveredAmount: Paise,
): RecoveryStatus {
  if (gapAmount === ZERO && recoveredAmount === ZERO) return "NOT_APPLICABLE";
  if (gapAmount === ZERO && recoveredAmount > ZERO) return "RESOLVED";
  return "OPEN";
}

// ---------------------------------------------------------------------------
// Dashboard aggregation
// ---------------------------------------------------------------------------

/** One benefit's contribution to the dashboard. */
export interface DashboardRow {
  verdict: EligibilityVerdict;
  /** Annualised value of the entitlement, or null when not a cash benefit. */
  annualValue: Paise | null;
  hasApplication: boolean;
  ledger: LedgerProjection | null;
}

/**
 * Dashboard totals.
 *
 * Field names carry the hedge deliberately. `potentialAnnualValue` is not
 * money owed, and `unverifiedAmount` is not money lost. A UI that renders
 * either as a confirmed figure is misreporting, so the names make the
 * distinction hard to ignore at the call site.
 */
export interface DashboardTotals {
  /** Annual value of GREEN entitlements with no application yet. A projection. */
  potentialAnnualValue: Paise;
  /** Annual value of entitlements currently being received. */
  activeAnnualValue: Paise;
  receivedAmount: Paise;
  /** Released, receipt unconfirmed. Must be labelled "unverified", never "missing". */
  unverifiedAmount: Paise;
  /** Proven absent, with evidence. Safe to call missing. */
  provenMissingAmount: Paise;
  recoveredAmount: Paise;

  counts: {
    eligible: number;
    potentiallyEligible: number;
    excluded: number;
    notApplied: number;
    healthy: number;
    needsVerification: number;
    actionRequired: number;
    recovered: number;
    /** Benefits whose value is genuinely not expressible in rupees. */
    nonCashBenefits: number;
  };
}

/**
 * Aggregate benefit rows into dashboard totals.
 *
 * In-kind entitlements (NFSA foodgrain, an MGNREGA work guarantee) contribute
 * to the counts but never to a rupee total, and are reported separately as
 * `nonCashBenefits`. Assigning them a notional value would inflate every
 * headline figure with numbers nobody can defend.
 */
export function aggregateDashboard(
  rows: readonly DashboardRow[],
): DashboardTotals {
  const totals: DashboardTotals = {
    potentialAnnualValue: ZERO,
    activeAnnualValue: ZERO,
    receivedAmount: ZERO,
    unverifiedAmount: ZERO,
    provenMissingAmount: ZERO,
    recoveredAmount: ZERO,
    counts: {
      eligible: 0,
      potentiallyEligible: 0,
      excluded: 0,
      notApplied: 0,
      healthy: 0,
      needsVerification: 0,
      actionRequired: 0,
      recovered: 0,
      nonCashBenefits: 0,
    },
  };

  for (const row of rows) {
    switch (row.verdict) {
      case "GREEN":
        totals.counts.eligible += 1;
        break;
      case "YELLOW":
        totals.counts.potentiallyEligible += 1;
        break;
      case "RED":
        totals.counts.excluded += 1;
        // An excluded scheme contributes nothing to any total: it is not a
        // missed opportunity, it is simply not applicable.
        continue;
    }

    if (row.annualValue === null) totals.counts.nonCashBenefits += 1;

    if (!row.hasApplication) {
      totals.counts.notApplied += 1;
      // Only a GREEN entitlement counts as potential value. A YELLOW one is
      // not yet established, and projecting money from an unverified
      // eligibility would overstate what the citizen can expect.
      if (row.verdict === "GREEN" && row.annualValue !== null) {
        totals.potentialAnnualValue = add(totals.potentialAnnualValue, row.annualValue);
      }
      continue;
    }

    const ledger = row.ledger;
    if (!ledger) continue;

    totals.receivedAmount = add(totals.receivedAmount, ledger.receivedAmount);
    totals.unverifiedAmount = add(totals.unverifiedAmount, ledger.unverifiedAmount);
    totals.provenMissingAmount = add(totals.provenMissingAmount, ledger.gapAmount);
    totals.recoveredAmount = add(totals.recoveredAmount, ledger.recoveredAmount);

    if (row.annualValue !== null && ledger.receivedAmount > ZERO) {
      totals.activeAnnualValue = add(totals.activeAnnualValue, row.annualValue);
    }

    if (ledger.recoveryStatus === "RESOLVED") totals.counts.recovered += 1;

    if (ledger.gapAmount > ZERO) {
      totals.counts.actionRequired += 1;
    } else if (ledger.receiptState === "DISBURSED_RECEIPT_UNVERIFIED") {
      totals.counts.needsVerification += 1;
    } else if (
      ledger.receiptState === "VERIFIED_RECEIVED" ||
      ledger.receiptState === "CITIZEN_CONFIRMED"
    ) {
      totals.counts.healthy += 1;
    }
  }

  return totals;
}
