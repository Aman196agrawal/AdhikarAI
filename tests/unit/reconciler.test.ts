import { describe, expect, it } from "vitest";

import { rupees, ZERO } from "@/lib/engine/money";
import { reconcile, type ReconcileInput } from "@/lib/engine/reconciler";
import type { CitizenReport, EvidenceResult } from "@/lib/generated/prisma/enums";

const EXPECTED = rupees(2000);

function input(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    expectedAmount: EXPECTED,
    governmentReportedAmount: null,
    citizenReport: null,
    evidence: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The canonical truth table from the design document
// ---------------------------------------------------------------------------

describe("the reconciler truth table", () => {
  it("government has not disbursed: NOT_DISBURSED, no gap", () => {
    const r = reconcile(input());
    expect(r.receiptState).toBe("NOT_DISBURSED");
    expect(r.gapAmount).toBe(ZERO);
    expect(r.unverifiedAmount).toBe(ZERO);
  });

  it("disbursed, citizen silent, no evidence: UNVERIFIED and NO gap", () => {
    const r = reconcile(input({ governmentReportedAmount: EXPECTED }));
    expect(r.receiptState).toBe("DISBURSED_RECEIPT_UNVERIFIED");
    // The single most important assertion in this suite.
    expect(r.gapAmount).toBe(ZERO);
    expect(r.unverifiedAmount).toBe(EXPECTED);
    expect(r.receivedAmount).toBe(ZERO);
  });

  it('disbursed, citizen "not sure", no evidence: UNVERIFIED and NO gap', () => {
    const r = reconcile(
      input({ governmentReportedAmount: EXPECTED, citizenReport: "NOT_SURE" }),
    );
    expect(r.receiptState).toBe("DISBURSED_RECEIPT_UNVERIFIED");
    expect(r.gapAmount).toBe(ZERO);
    expect(r.unverifiedAmount).toBe(EXPECTED);
  });

  it('disbursed, citizen "yes", no evidence: CITIZEN_CONFIRMED', () => {
    const r = reconcile(
      input({ governmentReportedAmount: EXPECTED, citizenReport: "YES" }),
    );
    expect(r.receiptState).toBe("CITIZEN_CONFIRMED");
    expect(r.gapAmount).toBe(ZERO);
    expect(r.receivedAmount).toBe(EXPECTED);
    // Confirmed by recollection is not the same as proven by evidence.
    expect(r.unverifiedAmount).toBe(ZERO);
  });

  it("disbursed, evidence matches in full: VERIFIED_RECEIVED", () => {
    const r = reconcile(
      input({
        governmentReportedAmount: EXPECTED,
        citizenReport: "YES",
        evidence: { result: "MATCHED", matchedAmount: EXPECTED },
      }),
    );
    expect(r.receiptState).toBe("VERIFIED_RECEIVED");
    expect(r.gapAmount).toBe(ZERO);
    expect(r.receivedAmount).toBe(EXPECTED);
  });

  it('disbursed, citizen "no", no evidence: PAYMENT_DISCREPANCY with full gap', () => {
    const r = reconcile(
      input({ governmentReportedAmount: EXPECTED, citizenReport: "NO" }),
    );
    expect(r.receiptState).toBe("PAYMENT_DISCREPANCY");
    expect(r.gapAmount).toBe(EXPECTED);
    expect(r.receivedAmount).toBe(ZERO);
  });

  it('disbursed, citizen "no", evidence finds nothing: PAYMENT_DISCREPANCY', () => {
    const r = reconcile(
      input({
        governmentReportedAmount: EXPECTED,
        citizenReport: "NO",
        evidence: { result: "NO_MATCH", matchedAmount: null },
      }),
    );
    expect(r.receiptState).toBe("PAYMENT_DISCREPANCY");
    expect(r.gapAmount).toBe(EXPECTED);
  });

  it("disbursed in full but evidence shows a short credit: discrepancy for the shortfall only", () => {
    const r = reconcile(
      input({
        governmentReportedAmount: EXPECTED,
        citizenReport: "YES",
        evidence: { result: "PARTIAL_MATCH", matchedAmount: rupees(1200) },
      }),
    );
    expect(r.receiptState).toBe("PAYMENT_DISCREPANCY");
    expect(r.gapAmount).toBe(rupees(800));
    expect(r.receivedAmount).toBe(rupees(1200));
  });

  it("government disbursed less than expected: discrepancy for the shortfall", () => {
    const r = reconcile(
      input({
        governmentReportedAmount: rupees(1200),
        citizenReport: "YES",
        evidence: { result: "MATCHED", matchedAmount: rupees(1200) },
      }),
    );
    expect(r.receiptState).toBe("PAYMENT_DISCREPANCY");
    expect(r.gapAmount).toBe(rupees(800));
    expect(r.receivedAmount).toBe(rupees(1200));
  });
});

// ---------------------------------------------------------------------------
// The load-bearing invariant
// ---------------------------------------------------------------------------

describe("INVARIANT: no gap without positive evidence of absence", () => {
  const reports: (CitizenReport | null)[] = [null, "YES", "NO", "NOT_SURE"];
  const evidenceResults: (EvidenceResult | null)[] = [
    null,
    "NOT_PROVIDED",
    "MATCHED",
    "PARTIAL_MATCH",
    "NO_MATCH",
  ];

  it("holds across every combination of citizen answer and evidence", () => {
    const offenders: string[] = [];

    for (const citizenReport of reports) {
      for (const evidenceResult of evidenceResults) {
        for (const reported of [null, EXPECTED]) {
          const matchedAmount =
            evidenceResult === "MATCHED"
              ? EXPECTED
              : evidenceResult === "PARTIAL_MATCH"
                ? rupees(1200)
                : null;

          const r = reconcile(
            input({
              governmentReportedAmount: reported,
              citizenReport,
              evidence: evidenceResult
                ? { result: evidenceResult, matchedAmount }
                : null,
            }),
          );

          // Positive evidence of absence means exactly one of:
          //  - the citizen said the money did not arrive, or
          //  - a document search found nothing, or
          //  - a document search found less than was due.
          const provenAbsent =
            citizenReport === "NO" ||
            evidenceResult === "NO_MATCH" ||
            evidenceResult === "PARTIAL_MATCH" ||
            (reported !== null && reported < EXPECTED);

          if (r.gapAmount !== ZERO && !provenAbsent) {
            offenders.push(
              `citizen=${citizenReport} evidence=${evidenceResult} reported=${reported} -> gap=${r.gapAmount}`,
            );
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("never reports a gap larger than the amount expected", () => {
    const r = reconcile(
      input({ governmentReportedAmount: EXPECTED, citizenReport: "NO" }),
    );
    expect(r.gapAmount <= EXPECTED).toBe(true);
  });

  it("never reports a negative gap when more was paid than expected", () => {
    // An overpayment is not a shortfall, and must not surface as a negative.
    const r = reconcile(
      input({
        governmentReportedAmount: rupees(2500),
        citizenReport: "YES",
        evidence: { result: "MATCHED", matchedAmount: rupees(2500) },
      }),
    );
    expect(r.gapAmount).toBe(ZERO);
    expect(r.receiptState).toBe("VERIFIED_RECEIVED");
  });

  it("keeps unverified amounts out of the gap total entirely", () => {
    const r = reconcile(input({ governmentReportedAmount: EXPECTED }));
    expect(r.gapAmount).toBe(ZERO);
    expect(r.unverifiedAmount).toBe(EXPECTED);
    // The two buckets are mutually exclusive: an amount is either proven
    // missing or merely unconfirmed, never counted as both.
    expect(r.gapAmount + r.unverifiedAmount).toBe(EXPECTED);
  });
});

// ---------------------------------------------------------------------------
// Conflicting evidence
// ---------------------------------------------------------------------------

describe("conflicting evidence", () => {
  it("trusts bank evidence over a citizen who did not notice the credit", () => {
    // This is the product's actual use case: an elderly citizen often cannot
    // tell whether a credit arrived. Evidence that the money is in the account
    // resolves it, and the conflict is recorded rather than hidden.
    const r = reconcile(
      input({
        governmentReportedAmount: EXPECTED,
        citizenReport: "NO",
        evidence: { result: "MATCHED", matchedAmount: EXPECTED },
      }),
    );
    expect(r.receiptState).toBe("VERIFIED_RECEIVED");
    expect(r.gapAmount).toBe(ZERO);
    expect(r.hasConflict).toBe(true);
    expect(r.reasons.join(" ")).toMatch(/conflict/i);
  });

  it("does not assert a discrepancy when the citizen says the money arrived but the search found nothing", () => {
    // A failed search may mean the wrong account or the wrong window. With the
    // citizen reporting receipt, the honest state is unverified, not missing.
    const r = reconcile(
      input({
        governmentReportedAmount: EXPECTED,
        citizenReport: "YES",
        evidence: { result: "NO_MATCH", matchedAmount: null },
      }),
    );
    expect(r.receiptState).toBe("DISBURSED_RECEIPT_UNVERIFIED");
    expect(r.gapAmount).toBe(ZERO);
    expect(r.hasConflict).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In-kind benefits
// ---------------------------------------------------------------------------

describe("in-kind benefits have no rupee reconciliation", () => {
  it("never fabricates a cash gap for a foodgrain entitlement", () => {
    // NFSA is 5 kg of grain, not a rupee amount. Reporting a cash shortfall
    // for it would corrupt every dashboard total.
    const r = reconcile({
      expectedAmount: null,
      governmentReportedAmount: null,
      citizenReport: "NO",
      evidence: null,
    });
    expect(r.gapAmount).toBe(ZERO);
    expect(r.unverifiedAmount).toBe(ZERO);
    expect(r.receivedAmount).toBe(ZERO);
    expect(r.receiptState).toBe("PAYMENT_DISCREPANCY");
  });

  it("still tracks receipt state for an in-kind entitlement", () => {
    const r = reconcile({
      expectedAmount: null,
      governmentReportedAmount: null,
      citizenReport: null,
      evidence: null,
    });
    expect(r.receiptState).toBe("NOT_DISBURSED");
  });
});

// ---------------------------------------------------------------------------
// Tolerance
// ---------------------------------------------------------------------------

describe("matching tolerance", () => {
  it("matches exactly by default", () => {
    const r = reconcile(
      input({
        governmentReportedAmount: EXPECTED,
        evidence: { result: "MATCHED", matchedAmount: rupees(1999) },
      }),
    );
    expect(r.receiptState).toBe("PAYMENT_DISCREPANCY");
    expect(r.gapAmount).toBe(rupees(1));
  });

  it("accepts a credit within an explicit tolerance, e.g. a bank charge", () => {
    const r = reconcile(
      input({
        governmentReportedAmount: EXPECTED,
        evidence: { result: "MATCHED", matchedAmount: rupees(1999) },
        tolerance: rupees(5),
      }),
    );
    expect(r.receiptState).toBe("VERIFIED_RECEIVED");
    expect(r.gapAmount).toBe(ZERO);
  });
});

// ---------------------------------------------------------------------------
// Explainability
// ---------------------------------------------------------------------------

describe("every outcome explains itself", () => {
  it("gives reasons for an unverified receipt", () => {
    const r = reconcile(input({ governmentReportedAmount: EXPECTED }));
    expect(r.reasons.length).toBeGreaterThan(0);
    expect(r.reasons.join(" ")).toMatch(/not been confirmed|unverified/i);
  });

  it("gives reasons for a discrepancy", () => {
    const r = reconcile(
      input({ governmentReportedAmount: EXPECTED, citizenReport: "NO" }),
    );
    expect(r.reasons.join(" ")).toMatch(/did not receive/i);
  });

  it("names the verification method that settled the outcome", () => {
    expect(
      reconcile(
        input({
          governmentReportedAmount: EXPECTED,
          evidence: { result: "MATCHED", matchedAmount: EXPECTED },
        }),
      ).method,
    ).toBe("BANK_EVIDENCE");

    expect(
      reconcile(
        input({ governmentReportedAmount: EXPECTED, citizenReport: "YES" }),
      ).method,
    ).toBe("CITIZEN_CONFIRMATION");

    expect(
      reconcile(input({ governmentReportedAmount: EXPECTED })).method,
    ).toBe("GOVERNMENT_RECORD");
  });
});
