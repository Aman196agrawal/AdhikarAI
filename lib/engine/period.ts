/**
 * Payment periods and expected schedules.
 *
 * The continuity audit works by comparing a materialised schedule of what
 * *should* arrive against what did. That requires a stable period key per
 * instalment, so the same month cannot be counted twice or missed entirely
 * when a schedule is regenerated.
 *
 * All date arithmetic takes an explicit `Date`; nothing here reads the clock.
 */

import { mulInt, type Paise } from "./money";
import type { BenefitFrequency } from "@/lib/generated/prisma/enums";

/** One instalment the citizen is entitled to expect. */
export interface ExpectedPaymentSpec {
  /** Stable key: "2026-03", "2026-Q1", "2026-T2", "2026", or "ONCE". */
  periodLabel: string
  dueOn: Date;
  expectedAmount: Paise;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** Calendar quarter, 1-4. */
function quarterOf(date: Date): number {
  return Math.floor(date.getUTCMonth() / 3) + 1;
}

/** Four-month trimester, 1-3. Used for PM-KISAN's three yearly instalments. */
function trimesterOf(date: Date): number {
  return Math.floor(date.getUTCMonth() / 4) + 1;
}

/**
 * The period key a date falls in, for a given frequency.
 *
 * `ONE_TIME` and `AS_NEEDED` have no calendar period, so both return a
 * constant key rather than a date-derived one.
 */
export function periodLabel(frequency: BenefitFrequency, date: Date): string {
  const year = date.getUTCFullYear();

  switch (frequency) {
    case "MONTHLY":
      return `${year}-${pad2(date.getUTCMonth() + 1)}`;
    case "QUARTERLY":
      return `${year}-Q${quarterOf(date)}`;
    case "TRIANNUAL":
      return `${year}-T${trimesterOf(date)}`;
    case "ANNUAL":
      return `${year}`;
    case "ONE_TIME":
      return "ONCE";
    case "AS_NEEDED":
      return "AS_NEEDED";
  }
}

/** How many months separate consecutive instalments. */
function monthStep(frequency: BenefitFrequency): number | null {
  switch (frequency) {
    case "MONTHLY":
      return 1;
    case "QUARTERLY":
      return 3;
    case "TRIANNUAL":
      return 4;
    case "ANNUAL":
      return 12;
    case "ONE_TIME":
    case "AS_NEEDED":
      return null;
  }
}

/**
 * Add whole months to a date, clamping the day to the target month's length.
 *
 * Without clamping, 31 January plus one month becomes 3 March, which would
 * silently shift an instalment into the wrong period and manufacture a
 * phantom continuity gap.
 */
export function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();

  const targetYear = year + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;

  const daysInTargetMonth = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();

  return new Date(
    Date.UTC(
      targetYear,
      targetMonth,
      Math.min(day, daysInTargetMonth),
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
}

export interface ScheduleOptions {
  frequency: BenefitFrequency;
  /** First instalment date. */
  startDate: Date;
  /** Generate instalments due on or before this date. */
  until: Date;
  /** Amount per instalment. */
  amount: Paise;
  /** Safety bound, to stop a bad date range generating an unbounded schedule. */
  maxInstalments?: number;
}

/**
 * Materialise the expected payment schedule.
 *
 * `AS_NEEDED` benefits (an MGNREGA work guarantee) produce no schedule: there
 * is nothing to miss on a calendar, so inventing due dates would generate
 * false gaps.
 */
export function generateSchedule(
  options: ScheduleOptions,
): ExpectedPaymentSpec[] {
  const { frequency, startDate, until, amount, maxInstalments = 240 } = options;

  if (frequency === "AS_NEEDED") return [];

  if (frequency === "ONE_TIME") {
    return startDate > until
      ? []
      : [{ periodLabel: "ONCE", dueOn: startDate, expectedAmount: amount }];
  }

  const step = monthStep(frequency);
  if (step === null) return [];

  const schedule: ExpectedPaymentSpec[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < maxInstalments; i += 1) {
    const dueOn = addMonths(startDate, i * step);
    if (dueOn > until) break;

    const label = periodLabel(frequency, dueOn);
    // Guard against a start date and step combination producing the same key
    // twice, which would double-count an instalment.
    if (seen.has(label)) continue;
    seen.add(label);

    schedule.push({ periodLabel: label, dueOn, expectedAmount: amount });
  }

  return schedule;
}

/** Total value of a schedule, for dashboard projections. */
export function scheduleTotal(schedule: readonly ExpectedPaymentSpec[]): Paise {
  return schedule.reduce(
    (total, item) => (total + item.expectedAmount) as Paise,
    0n as Paise,
  );
}

/** Annual value of a benefit, from its frequency and per-instalment amount. */
export function annualValue(
  frequency: BenefitFrequency,
  amount: Paise,
): Paise | null {
  switch (frequency) {
    case "MONTHLY":
      return mulInt(amount, 12);
    case "QUARTERLY":
      return mulInt(amount, 4);
    case "TRIANNUAL":
      return mulInt(amount, 3);
    case "ANNUAL":
    case "ONE_TIME":
      return amount;
    case "AS_NEEDED":
      // Genuinely unknown: it depends how much work is demanded. Null rather
      // than zero, so a dashboard cannot present it as nothing.
      return null;
  }
}
