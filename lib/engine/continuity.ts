/**
 * The continuity audit.
 *
 * A benefit that arrived once is not a benefit secured. Monthly pensions stop
 * silently: a bank mandate lapses, an Aadhaar re-verification is missed, a
 * state treasury defers a month. Nobody tells the citizen, and the next thing
 * they know is that the money stopped.
 *
 * This compares the materialised expected schedule against actual payments and
 * reports the periods that are genuinely missing.
 *
 * Two rules keep it honest:
 *
 *   1. A period that is not yet due, or still inside its grace window, is NOT
 *      a gap. Flagging it would train the citizen to ignore alerts.
 *   2. A payment that was made but whose receipt is unconfirmed is NOT a
 *      continuity gap. The money was released; whether it arrived is the
 *      reconciler's question, and conflating the two would double-count it.
 */

import { add, ZERO, type Paise } from "./money";
import type { ExpectedPaymentSpec } from "./period";
import type { GapKind, ReceiptState } from "@/lib/generated/prisma/enums";

/** An actual payment, as recorded against a period. */
export interface ActualPaymentRecord {
  periodLabel: string;
  receiptState: ReceiptState;
  /** What the government reported releasing for this period. */
  reportedAmount: Paise;
  /** When it was reported as released. */
  reportedOn: Date;
}

/** A continuity problem found for one period. */
export interface ContinuityGap {
  kind: Extract<
    GapKind,
    "PAYMENT_MISSED" | "PAYMENT_DELAYED" | "PAYMENT_INTERRUPTED"
  >;
  periodLabel: string;
  dueOn: Date;
  /** Null when the amount genuinely is not known. Never a guess. */
  amount: Paise | null;
  detail: string;
}

export interface ContinuityOptions {
  expected: readonly ExpectedPaymentSpec[];
  actual: readonly ActualPaymentRecord[];
  /** Evaluation time, supplied explicitly; this module never reads the clock. */
  now: Date;
  /**
   * Days after the due date before a payment counts as missed. Government
   * disbursement cycles routinely run a few weeks late without anything
   * being wrong.
   */
  graceDays?: number;
}

export interface ContinuityResult {
  gaps: ContinuityGap[];
  /** Periods satisfied by a payment, however its receipt is classified. */
  paidPeriods: string[];
  /** Due, past grace, and with no payment at all. */
  missedPeriods: string[];
  /** Not yet due or still within grace. Reported, never flagged. */
  pendingPeriods: string[];
  /** Longest run of consecutive missed periods. */
  longestMissStreak: number;
  /** True when two or more consecutive periods are missing. */
  isInterrupted: boolean;
  /** Total proven missing across missed periods. */
  totalMissingAmount: Paise;
}

const MS_PER_DAY = 86_400_000;

function daysBetween(later: Date, earlier: Date): number {
  return (later.getTime() - earlier.getTime()) / MS_PER_DAY;
}

/**
 * Audit a schedule against actual payments.
 *
 * The expected schedule is treated as the source of truth for what periods
 * exist; a payment for a period not in the schedule is ignored rather than
 * invented into the timeline.
 */
export function auditContinuity(
  options: ContinuityOptions,
): ContinuityResult {
  const { expected, actual, now, graceDays = 15 } = options;

  const byPeriod = new Map<string, ActualPaymentRecord>();
  for (const payment of actual) byPeriod.set(payment.periodLabel, payment);

  const gaps: ContinuityGap[] = [];
  const paidPeriods: string[] = [];
  const missedPeriods: string[] = [];
  const pendingPeriods: string[] = [];

  // Chronological order, so a run of misses can be detected.
  const ordered = [...expected].sort(
    (a, b) => a.dueOn.getTime() - b.dueOn.getTime(),
  );

  let currentStreak = 0;
  let longestMissStreak = 0;
  let totalMissingAmount = ZERO;

  for (const period of ordered) {
    const payment = byPeriod.get(period.periodLabel);
    const overdueBy = daysBetween(now, period.dueOn);

    if (payment) {
      paidPeriods.push(period.periodLabel);
      currentStreak = 0;

      // A payment that arrived well after it was due is worth surfacing even
      // though nothing is missing: a consistent lag is itself a problem.
      const lateBy = daysBetween(payment.reportedOn, period.dueOn);
      if (lateBy > graceDays) {
        gaps.push({
          kind: "PAYMENT_DELAYED",
          periodLabel: period.periodLabel,
          dueOn: period.dueOn,
          amount: null,
          detail: `Payment for ${period.periodLabel} was released ${Math.round(lateBy)} days after it was due.`,
        });
      }

      // A short payment is a reconciliation matter, surfaced there, not here.
      continue;
    }

    if (overdueBy <= graceDays) {
      // Not yet due, or inside the grace window.
      pendingPeriods.push(period.periodLabel);
      currentStreak = 0;
      continue;
    }

    missedPeriods.push(period.periodLabel);
    currentStreak += 1;
    longestMissStreak = Math.max(longestMissStreak, currentStreak);
    totalMissingAmount = add(totalMissingAmount, period.expectedAmount);

    gaps.push({
      kind: "PAYMENT_MISSED",
      periodLabel: period.periodLabel,
      dueOn: period.dueOn,
      // Proven missing: the period was due, grace has passed, and no
      // disbursement exists at all for it.
      amount: period.expectedAmount,
      detail: `No payment has been recorded for ${period.periodLabel}, which was due on ${period.dueOn.toISOString().slice(0, 10)} and is now ${Math.round(overdueBy)} days overdue.`,
    });
  }

  const isInterrupted = longestMissStreak >= 2;

  if (isInterrupted) {
    gaps.push({
      kind: "PAYMENT_INTERRUPTED",
      periodLabel: missedPeriods.join(", "),
      dueOn: ordered.find((p) => p.periodLabel === missedPeriods[0])?.dueOn ?? now,
      amount: totalMissingAmount,
      detail: `Payments have been interrupted for ${longestMissStreak} consecutive periods, which suggests a blocking cause rather than a one-off delay.`,
    });
  }

  return {
    gaps,
    paidPeriods,
    missedPeriods,
    pendingPeriods,
    longestMissStreak,
    isInterrupted,
    totalMissingAmount,
  };
}
