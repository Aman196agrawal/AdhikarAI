import { describe, expect, it } from "vitest";

import {
  aggregateDashboard,
  projectLedger,
  type DashboardRow,
} from "@/lib/engine/ledger";
import { rupees, ZERO } from "@/lib/engine/money";
import { reconcile } from "@/lib/engine/reconciler";

const PENSION = rupees(200);

const verified = reconcile({
  expectedAmount: PENSION,
  governmentReportedAmount: PENSION,
  citizenReport: "YES",
  evidence: { result: "MATCHED", matchedAmount: PENSION },
});

const unverified = reconcile({
  expectedAmount: PENSION,
  governmentReportedAmount: PENSION,
  citizenReport: null,
  evidence: null,
});

const discrepancy = reconcile({
  expectedAmount: PENSION,
  governmentReportedAmount: PENSION,
  citizenReport: "NO",
  evidence: null,
});

describe("ledger projection", () => {
  it("sums a run of verified payments", () => {
    const ledger = projectLedger({
      expectedAmount: PENSION,
      applicationStatus: "APPROVED",
      payments: [verified, verified, verified],
    });
    expect(ledger.receivedAmount).toBe(rupees(600));
    expect(ledger.disbursedAmount).toBe(rupees(600));
    expect(ledger.gapAmount).toBe(ZERO);
    expect(ledger.unverifiedAmount).toBe(ZERO);
    expect(ledger.receiptState).toBe("VERIFIED_RECEIVED");
  });

  it("keeps unverified and missing in separate buckets", () => {
    const ledger = projectLedger({
      expectedAmount: PENSION,
      applicationStatus: "APPROVED",
      payments: [verified, unverified, discrepancy],
    });
    expect(ledger.receivedAmount).toBe(PENSION);
    expect(ledger.unverifiedAmount).toBe(PENSION);
    expect(ledger.gapAmount).toBe(PENSION);
    // All three left the treasury, so all three are "disbursed".
    expect(ledger.disbursedAmount).toBe(rupees(600));
  });

  it("surfaces the most pressing receipt state, not the latest", () => {
    // Two confirmed receipts must not bury one discrepancy.
    const ledger = projectLedger({
      expectedAmount: PENSION,
      applicationStatus: "APPROVED",
      payments: [discrepancy, verified, verified],
    });
    expect(ledger.receiptState).toBe("PAYMENT_DISCREPANCY");
  });

  it("ranks unverified above confirmed when nothing is missing", () => {
    const ledger = projectLedger({
      expectedAmount: PENSION,
      applicationStatus: "APPROVED",
      payments: [verified, unverified],
    });
    expect(ledger.receiptState).toBe("DISBURSED_RECEIPT_UNVERIFIED");
  });

  it("reports NOT_DISBURSED when nothing has been paid", () => {
    const ledger = projectLedger({
      expectedAmount: PENSION,
      applicationStatus: "APPROVED",
      payments: [],
    });
    expect(ledger.receiptState).toBe("NOT_DISBURSED");
    expect(ledger.disbursedAmount).toBe(ZERO);
  });

  it("derives recovery status from the outstanding gap", () => {
    expect(
      projectLedger({
        expectedAmount: PENSION,
        applicationStatus: "APPROVED",
        payments: [verified],
      }).recoveryStatus,
    ).toBe("NOT_APPLICABLE");

    expect(
      projectLedger({
        expectedAmount: PENSION,
        applicationStatus: "APPROVED",
        payments: [discrepancy],
      }).recoveryStatus,
    ).toBe("OPEN");

    expect(
      projectLedger({
        expectedAmount: PENSION,
        applicationStatus: "APPROVED",
        payments: [verified],
        recoveredAmount: PENSION,
      }).recoveryStatus,
    ).toBe("RESOLVED");
  });

  it("preserves a null expected amount for in-kind benefits", () => {
    const ledger = projectLedger({
      expectedAmount: null,
      applicationStatus: "APPROVED",
      payments: [],
    });
    expect(ledger.expectedAmount).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Dashboard aggregation
// ---------------------------------------------------------------------------

function row(overrides: Partial<DashboardRow> = {}): DashboardRow {
  return {
    verdict: "GREEN",
    annualValue: rupees(2400),
    hasApplication: true,
    ledger: projectLedger({
      expectedAmount: PENSION,
      applicationStatus: "APPROVED",
      payments: [verified],
    }),
    ...overrides,
  };
}

describe("dashboard aggregation keeps the buckets apart", () => {
  it("never folds unverified amounts into the missing total", () => {
    const totals = aggregateDashboard([
      row({
        ledger: projectLedger({
          expectedAmount: PENSION,
          applicationStatus: "APPROVED",
          payments: [unverified, unverified],
        }),
      }),
    ]);
    expect(totals.unverifiedAmount).toBe(rupees(400));
    expect(totals.provenMissingAmount).toBe(ZERO);
  });

  it("reports proven-missing separately from unverified", () => {
    const totals = aggregateDashboard([
      row({
        ledger: projectLedger({
          expectedAmount: PENSION,
          applicationStatus: "APPROVED",
          payments: [unverified, discrepancy, verified],
        }),
      }),
    ]);
    expect(totals.receivedAmount).toBe(PENSION);
    expect(totals.unverifiedAmount).toBe(PENSION);
    expect(totals.provenMissingAmount).toBe(PENSION);
  });

  it("counts potential value only for eligible, unclaimed benefits", () => {
    const totals = aggregateDashboard([
      row({ verdict: "GREEN", hasApplication: false, annualValue: rupees(2400) }),
      // A merely potential eligibility must not project money.
      row({ verdict: "YELLOW", hasApplication: false, annualValue: rupees(5000) }),
    ]);
    expect(totals.potentialAnnualValue).toBe(rupees(2400));
    expect(totals.counts.notApplied).toBe(2);
  });

  it("excludes RED schemes from every total", () => {
    // Not applicable is not a missed opportunity.
    const totals = aggregateDashboard([
      row({ verdict: "RED", hasApplication: false, annualValue: rupees(5000) }),
    ]);
    expect(totals.potentialAnnualValue).toBe(ZERO);
    expect(totals.counts.excluded).toBe(1);
    expect(totals.counts.notApplied).toBe(0);
  });

  it("counts in-kind benefits without giving them a rupee value", () => {
    const totals = aggregateDashboard([
      row({ verdict: "GREEN", hasApplication: false, annualValue: null }),
    ]);
    expect(totals.counts.nonCashBenefits).toBe(1);
    expect(totals.potentialAnnualValue).toBe(ZERO);
  });

  it("classifies benefits into healthy, needs-verification and action-required", () => {
    const totals = aggregateDashboard([
      row({
        ledger: projectLedger({
          expectedAmount: PENSION,
          applicationStatus: "APPROVED",
          payments: [verified],
        }),
      }),
      row({
        ledger: projectLedger({
          expectedAmount: PENSION,
          applicationStatus: "APPROVED",
          payments: [unverified],
        }),
      }),
      row({
        ledger: projectLedger({
          expectedAmount: PENSION,
          applicationStatus: "APPROVED",
          payments: [discrepancy],
        }),
      }),
    ]);
    expect(totals.counts.healthy).toBe(1);
    expect(totals.counts.needsVerification).toBe(1);
    expect(totals.counts.actionRequired).toBe(1);
  });

  it("totals recovered amounts", () => {
    const totals = aggregateDashboard([
      row({
        ledger: projectLedger({
          expectedAmount: PENSION,
          applicationStatus: "APPROVED",
          payments: [verified],
          recoveredAmount: rupees(600),
        }),
      }),
    ]);
    expect(totals.recoveredAmount).toBe(rupees(600));
    expect(totals.counts.recovered).toBe(1);
  });

  it("handles an empty dashboard", () => {
    const totals = aggregateDashboard([]);
    expect(totals.receivedAmount).toBe(ZERO);
    expect(totals.counts.eligible).toBe(0);
  });
});

describe("the dashboard figures in the design document", () => {
  it("reproduces potential vs active vs unverified without conflating them", () => {
    // Kamala's shape: one healthy, one unverified, one discrepancy, one
    // eligible-but-unclaimed. Four distinct numbers, four distinct meanings.
    const totals = aggregateDashboard([
      row({
        annualValue: rupees(6000),
        ledger: projectLedger({
          expectedAmount: rupees(2000),
          applicationStatus: "APPROVED",
          payments: [
            reconcile({
              expectedAmount: rupees(2000),
              governmentReportedAmount: rupees(2000),
              citizenReport: "YES",
              evidence: { result: "MATCHED", matchedAmount: rupees(2000) },
            }),
          ],
        }),
      }),
      row({
        annualValue: rupees(2400),
        ledger: projectLedger({
          expectedAmount: PENSION,
          applicationStatus: "APPROVED",
          payments: [unverified],
        }),
      }),
      row({
        annualValue: rupees(2400),
        ledger: projectLedger({
          expectedAmount: PENSION,
          applicationStatus: "APPROVED",
          payments: [discrepancy],
        }),
      }),
      row({ hasApplication: false, annualValue: rupees(3600), ledger: null }),
    ]);

    expect(totals.receivedAmount).toBe(rupees(2000));
    expect(totals.unverifiedAmount).toBe(rupees(200));
    expect(totals.provenMissingAmount).toBe(rupees(200));
    expect(totals.potentialAnnualValue).toBe(rupees(3600));

    // The four buckets are independent; there is deliberately no API that
    // returns their sum, because that sum would not mean anything.
    expect(totals).not.toHaveProperty("totalValue");
  });
});
