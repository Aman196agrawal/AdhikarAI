import { describe, expect, it } from "vitest";

import { auditContinuity, type ActualPaymentRecord } from "@/lib/engine/continuity";
import { rupees, ZERO } from "@/lib/engine/money";
import {
  addMonths,
  annualValue,
  generateSchedule,
  periodLabel,
  scheduleTotal,
} from "@/lib/engine/period";

const JAN = new Date("2026-01-10T00:00:00.000Z");
const PENSION = rupees(200);

// ---------------------------------------------------------------------------
// Period keys
// ---------------------------------------------------------------------------

describe("period labels", () => {
  it("keys monthly periods by year and month", () => {
    expect(periodLabel("MONTHLY", new Date("2026-03-01T00:00:00Z"))).toBe("2026-03");
    expect(periodLabel("MONTHLY", new Date("2026-12-31T00:00:00Z"))).toBe("2026-12");
  });

  it("keys quarterly and triannual periods", () => {
    expect(periodLabel("QUARTERLY", new Date("2026-02-01T00:00:00Z"))).toBe("2026-Q1");
    expect(periodLabel("QUARTERLY", new Date("2026-11-01T00:00:00Z"))).toBe("2026-Q4");
    expect(periodLabel("TRIANNUAL", new Date("2026-01-01T00:00:00Z"))).toBe("2026-T1");
    expect(periodLabel("TRIANNUAL", new Date("2026-06-01T00:00:00Z"))).toBe("2026-T2");
    expect(periodLabel("TRIANNUAL", new Date("2026-12-01T00:00:00Z"))).toBe("2026-T3");
  });

  it("keys annual, one-time and as-needed benefits", () => {
    expect(periodLabel("ANNUAL", JAN)).toBe("2026");
    expect(periodLabel("ONE_TIME", JAN)).toBe("ONCE");
    expect(periodLabel("AS_NEEDED", JAN)).toBe("AS_NEEDED");
  });
});

describe("addMonths", () => {
  it("clamps to the end of a shorter month", () => {
    // Without clamping, 31 Jan + 1 month becomes 3 March, which would shift an
    // instalment into the wrong period and manufacture a phantom gap.
    expect(addMonths(new Date("2026-01-31T00:00:00Z"), 1).toISOString()).toBe(
      "2026-02-28T00:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    expect(addMonths(new Date("2026-11-15T00:00:00Z"), 3).toISOString()).toBe(
      "2027-02-15T00:00:00.000Z",
    );
  });
});

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

describe("expected schedules", () => {
  it("generates one monthly instalment per month up to the horizon", () => {
    const schedule = generateSchedule({
      frequency: "MONTHLY",
      startDate: JAN,
      until: new Date("2026-04-30T00:00:00Z"),
      amount: PENSION,
    });
    expect(schedule.map((s) => s.periodLabel)).toEqual([
      "2026-01",
      "2026-02",
      "2026-03",
      "2026-04",
    ]);
  });

  it("generates nothing beyond the horizon", () => {
    const schedule = generateSchedule({
      frequency: "MONTHLY",
      startDate: JAN,
      until: new Date("2026-01-05T00:00:00Z"),
      amount: PENSION,
    });
    expect(schedule).toEqual([]);
  });

  it("generates exactly one instalment for a one-time benefit", () => {
    const schedule = generateSchedule({
      frequency: "ONE_TIME",
      startDate: JAN,
      until: new Date("2030-01-01T00:00:00Z"),
      amount: rupees(120000),
    });
    expect(schedule).toHaveLength(1);
    expect(schedule[0].periodLabel).toBe("ONCE");
  });

  it("generates NO schedule for an as-needed benefit", () => {
    // MGNREGA is a work guarantee. Inventing calendar due dates for it would
    // produce a stream of false missed payments.
    expect(
      generateSchedule({
        frequency: "AS_NEEDED",
        startDate: JAN,
        until: new Date("2027-01-01T00:00:00Z"),
        amount: ZERO,
      }),
    ).toEqual([]);
  });

  it("generates three triannual instalments across a year", () => {
    const schedule = generateSchedule({
      frequency: "TRIANNUAL",
      startDate: new Date("2026-01-15T00:00:00Z"),
      until: new Date("2026-12-31T00:00:00Z"),
      amount: rupees(2000),
    });
    expect(schedule.map((s) => s.periodLabel)).toEqual(["2026-T1", "2026-T2", "2026-T3"]);
    expect(scheduleTotal(schedule)).toBe(rupees(6000));
  });
});

describe("annual value", () => {
  it("multiplies by the number of instalments", () => {
    expect(annualValue("MONTHLY", rupees(200))).toBe(rupees(2400));
    expect(annualValue("TRIANNUAL", rupees(2000))).toBe(rupees(6000));
    expect(annualValue("QUARTERLY", rupees(500))).toBe(rupees(2000));
    expect(annualValue("ONE_TIME", rupees(120000))).toBe(rupees(120000));
  });

  it("returns null, not zero, for an as-needed benefit", () => {
    // How much MGNREGA work a household demands is genuinely unknown.
    // Reporting zero would understate the dashboard total as a fact.
    expect(annualValue("AS_NEEDED", rupees(300))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The continuity audit
// ---------------------------------------------------------------------------

const schedule = generateSchedule({
  frequency: "MONTHLY",
  startDate: JAN,
  until: new Date("2026-04-30T00:00:00Z"),
  amount: PENSION,
});

function paid(period: string, on: string): ActualPaymentRecord {
  return {
    periodLabel: period,
    receiptState: "VERIFIED_RECEIVED",
    reportedAmount: PENSION,
    reportedOn: new Date(on),
  };
}

describe("continuity audit", () => {
  it("detects the single missing month in Jan/Feb/[gap]/Apr", () => {
    const result = auditContinuity({
      expected: schedule,
      actual: [
        paid("2026-01", "2026-01-10T00:00:00Z"),
        paid("2026-02", "2026-02-10T00:00:00Z"),
        paid("2026-04", "2026-04-10T00:00:00Z"),
      ],
      now: new Date("2026-05-01T00:00:00Z"),
    });

    expect(result.missedPeriods).toEqual(["2026-03"]);
    const missed = result.gaps.filter((g) => g.kind === "PAYMENT_MISSED");
    expect(missed).toHaveLength(1);
    expect(missed[0].periodLabel).toBe("2026-03");
    expect(missed[0].amount).toBe(PENSION);
    expect(result.totalMissingAmount).toBe(PENSION);
    expect(result.isInterrupted).toBe(false);
  });

  it("does NOT flag a period that is not yet due", () => {
    const result = auditContinuity({
      expected: schedule,
      actual: [paid("2026-01", "2026-01-10T00:00:00Z")],
      now: new Date("2026-02-01T00:00:00Z"),
    });
    // February is due 10 Feb; on 1 Feb nothing is overdue.
    expect(result.missedPeriods).toEqual([]);
    expect(result.pendingPeriods).toContain("2026-02");
  });

  it("respects the grace window before calling a payment missed", () => {
    const withinGrace = auditContinuity({
      expected: schedule,
      actual: [],
      now: new Date("2026-01-20T00:00:00Z"),
      graceDays: 15,
    });
    expect(withinGrace.missedPeriods).toEqual([]);

    const pastGrace = auditContinuity({
      expected: schedule,
      actual: [],
      now: new Date("2026-01-27T00:00:00Z"),
      graceDays: 15,
    });
    expect(pastGrace.missedPeriods).toEqual(["2026-01"]);
  });

  it("reports an interruption after two consecutive misses", () => {
    const result = auditContinuity({
      expected: schedule,
      actual: [paid("2026-01", "2026-01-10T00:00:00Z")],
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(result.longestMissStreak).toBe(3);
    expect(result.isInterrupted).toBe(true);
    expect(result.gaps.some((g) => g.kind === "PAYMENT_INTERRUPTED")).toBe(true);
    expect(result.totalMissingAmount).toBe(rupees(600));
  });

  it("does NOT treat an unverified receipt as a continuity gap", () => {
    // The money was released; whether it arrived is the reconciler's question.
    // Counting it here as well would double-count the same rupees.
    const result = auditContinuity({
      expected: schedule,
      actual: [
        paid("2026-01", "2026-01-10T00:00:00Z"),
        {
          periodLabel: "2026-02",
          receiptState: "DISBURSED_RECEIPT_UNVERIFIED",
          reportedAmount: PENSION,
          reportedOn: new Date("2026-02-10T00:00:00Z"),
        },
        paid("2026-03", "2026-03-10T00:00:00Z"),
        paid("2026-04", "2026-04-10T00:00:00Z"),
      ],
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(result.missedPeriods).toEqual([]);
    expect(result.totalMissingAmount).toBe(ZERO);
    expect(result.paidPeriods).toContain("2026-02");
  });

  it("flags a payment released long after it was due", () => {
    const result = auditContinuity({
      expected: schedule,
      actual: [paid("2026-01", "2026-03-15T00:00:00Z")],
      now: new Date("2026-03-20T00:00:00Z"),
      graceDays: 15,
    });
    const delayed = result.gaps.filter((g) => g.kind === "PAYMENT_DELAYED");
    expect(delayed).toHaveLength(1);
    expect(delayed[0].periodLabel).toBe("2026-01");
    // Delay is not an amount missing.
    expect(delayed[0].amount).toBeNull();
  });

  it("reports nothing wrong for a fully paid schedule", () => {
    const result = auditContinuity({
      expected: schedule,
      actual: [
        paid("2026-01", "2026-01-10T00:00:00Z"),
        paid("2026-02", "2026-02-10T00:00:00Z"),
        paid("2026-03", "2026-03-10T00:00:00Z"),
        paid("2026-04", "2026-04-10T00:00:00Z"),
      ],
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(result.gaps).toEqual([]);
    expect(result.totalMissingAmount).toBe(ZERO);
  });

  it("ignores a payment for a period outside the schedule", () => {
    const result = auditContinuity({
      expected: schedule,
      actual: [paid("2025-12", "2025-12-10T00:00:00Z")],
      now: new Date("2026-01-01T00:00:00Z"),
    });
    expect(result.paidPeriods).toEqual([]);
  });

  it("handles an empty schedule without inventing gaps", () => {
    const result = auditContinuity({
      expected: [],
      actual: [],
      now: new Date("2026-05-01T00:00:00Z"),
    });
    expect(result.gaps).toEqual([]);
    expect(result.isInterrupted).toBe(false);
  });
});

describe("the three-month demo advance", () => {
  it("surfaces the continuity gap the demo clock is meant to reveal", () => {
    // Advancing the simulated clock by 90 days from mid-January lands in
    // April, so February and March fall due and, unpaid, become a visible
    // interruption. This is the same engine path as real time passing.
    const result = auditContinuity({
      expected: schedule,
      actual: [paid("2026-01", "2026-01-10T00:00:00Z")],
      now: new Date("2026-04-10T00:00:00Z"),
    });
    expect(result.missedPeriods).toEqual(["2026-02", "2026-03"]);
    expect(result.isInterrupted).toBe(true);
    expect(result.totalMissingAmount).toBe(rupees(400));
  });
});
