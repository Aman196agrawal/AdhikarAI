import { describe, expect, it } from "vitest";

import { decide, detectGaps, readable, type GapDetectionInput } from "@/lib/engine/gaps";
import { rupees, ZERO } from "@/lib/engine/money";
import { reconcile } from "@/lib/engine/reconciler";
import type { GapKind } from "@/lib/generated/prisma/enums";

const EXPECTED = rupees(2000);

function input(overrides: Partial<GapDetectionInput> = {}): GapDetectionInput {
  return {
    verdict: "GREEN",
    applicationStatus: "APPROVED",
    ...overrides,
  };
}

const kinds = (gaps: { kind: GapKind }[]) => gaps.map((g) => g.kind);

describe("healthy benefits", () => {
  it("reports no gaps and a HEALTHY decision", () => {
    const result = detectGaps(
      input({
        reconciliation: reconcile({
          expectedAmount: EXPECTED,
          governmentReportedAmount: EXPECTED,
          citizenReport: "YES",
          evidence: { result: "MATCHED", matchedAmount: EXPECTED },
        }),
      }),
    );
    expect(result.gaps).toEqual([]);
    expect(result.decision).toBe("HEALTHY");
    expect(result.totalProvenMissing).toBe(ZERO);
    expect(result.totalUnverified).toBe(ZERO);
  });
});

describe("THE core distinction: unverified is not missing", () => {
  const unverified = detectGaps(
    input({
      reconciliation: reconcile({
        expectedAmount: EXPECTED,
        governmentReportedAmount: EXPECTED,
        citizenReport: null,
        evidence: null,
      }),
    }),
  );

  it("classifies it as RECEIPT_UNVERIFIED, not PAYMENT_MISSED", () => {
    expect(kinds(unverified.gaps)).toEqual(["RECEIPT_UNVERIFIED"]);
    expect(kinds(unverified.gaps)).not.toContain("PAYMENT_MISSED");
  });

  it("records NO amount against it", () => {
    // A number here could be summed into a total labelled "missing".
    expect(unverified.gaps[0].amount).toBeNull();
  });

  it("keeps it out of the proven-missing total", () => {
    expect(unverified.totalProvenMissing).toBe(ZERO);
    expect(unverified.totalUnverified).toBe(EXPECTED);
  });

  it("decides NEEDS_VERIFICATION, not ACTION_REQUIRED", () => {
    // We ask the citizen a question; we do not file a grievance about a
    // payment we have merely failed to confirm.
    expect(unverified.decision).toBe("NEEDS_VERIFICATION");
    expect(unverified.gaps[0].needsAction).toBe(false);
  });

  it("phrases it as an inability to confirm, not an absence", () => {
    expect(readable("RECEIPT_UNVERIFIED")).toMatch(/cannot yet confirm/i);
  });
});

describe("a genuine payment discrepancy", () => {
  const discrepancy = detectGaps(
    input({
      reconciliation: reconcile({
        expectedAmount: EXPECTED,
        governmentReportedAmount: EXPECTED,
        citizenReport: "NO",
        evidence: null,
      }),
    }),
  );

  it("is PAYMENT_MISSED with the amount attached", () => {
    expect(kinds(discrepancy.gaps)).toContain("PAYMENT_MISSED");
    expect(discrepancy.gaps[0].amount).toBe(EXPECTED);
  });

  it("counts towards proven missing and requires action", () => {
    expect(discrepancy.totalProvenMissing).toBe(EXPECTED);
    expect(discrepancy.decision).toBe("ACTION_REQUIRED");
  });

  it("carries the reconciler's evidence trail", () => {
    expect(discrepancy.gaps[0].evidence.join(" ")).toMatch(/did not receive/i);
  });
});

describe("application-stage gaps", () => {
  it("detects an eligible citizen who never applied", () => {
    const result = detectGaps(input({ verdict: "GREEN", applicationStatus: null }));
    expect(kinds(result.gaps)).toEqual(["NEVER_APPLIED"]);
    expect(result.decision).toBe("ACTION_REQUIRED");
    // Foregone value is a projection, not money owed.
    expect(result.gaps[0].amount).toBeNull();
  });

  it("treats a potentially eligible unclaimed scheme as verification, not action", () => {
    const result = detectGaps(input({ verdict: "YELLOW", applicationStatus: null }));
    expect(kinds(result.gaps)).toEqual(["UNCLAIMED"]);
    expect(result.decision).toBe("NEEDS_VERIFICATION");
  });

  it("raises nothing for an excluded scheme that was never applied for", () => {
    // A RED scheme is not a gap. Telling a citizen they are "missing out" on
    // something they are plainly not entitled to is noise.
    const result = detectGaps(input({ verdict: "RED", applicationStatus: null }));
    expect(result.gaps).toEqual([]);
    expect(result.decision).toBe("HEALTHY");
  });

  it("detects a rejection and carries its reason", () => {
    const result = detectGaps(
      input({
        applicationStatus: "REJECTED",
        rejectionReason: "Land record not attached",
      }),
    );
    expect(kinds(result.gaps)).toContain("REJECTED");
    expect(result.gaps[0].evidence.join(" ")).toMatch(/Land record/);
    expect(result.decision).toBe("ACTION_REQUIRED");
  });

  it("detects a returned application as a missing document", () => {
    const result = detectGaps(
      input({
        applicationStatus: "RETURNED",
        missingDocuments: ["INCOME_CERTIFICATE"],
      }),
    );
    expect(kinds(result.gaps)).toContain("MISSING_DOCUMENT");
    expect(result.gaps[0].evidence.join(" ")).toMatch(/INCOME_CERTIFICATE/);
  });

  it("detects a stalled application past the threshold", () => {
    const result = detectGaps(
      input({ applicationStatus: "PENDING", daysSinceSubmission: 94 }),
    );
    expect(kinds(result.gaps)).toContain("APPLICATION_PENDING_TOO_LONG");
    expect(result.gaps[0].evidence.join(" ")).toMatch(/94 days/);
  });

  it("does NOT flag an application still within the threshold", () => {
    const result = detectGaps(
      input({ applicationStatus: "PENDING", daysSinceSubmission: 21 }),
    );
    expect(result.gaps).toEqual([]);
    expect(result.decision).toBe("HEALTHY");
  });

  it("flags a failed submission as blocked", () => {
    const result = detectGaps(input({ applicationStatus: "SUBMISSION_FAILED" }));
    expect(kinds(result.gaps)).toContain("BLOCKED");
  });
});

describe("continuity gaps feed through", () => {
  it("adds a missed period and its amount to the proven-missing total", () => {
    const result = detectGaps(
      input({
        continuityGaps: [
          {
            kind: "PAYMENT_MISSED",
            periodLabel: "2026-03",
            dueOn: new Date("2026-03-10T00:00:00Z"),
            amount: rupees(200),
            detail: "No payment recorded for 2026-03.",
          },
        ],
      }),
    );
    expect(kinds(result.gaps)).toContain("PAYMENT_MISSED");
    expect(result.totalProvenMissing).toBe(rupees(200));
    expect(result.decision).toBe("ACTION_REQUIRED");
  });

  it("treats a delayed payment as informational, not actionable", () => {
    const result = detectGaps(
      input({
        continuityGaps: [
          {
            kind: "PAYMENT_DELAYED",
            periodLabel: "2026-01",
            dueOn: new Date("2026-01-10T00:00:00Z"),
            amount: null,
            detail: "Released 40 days late.",
          },
        ],
      }),
    );
    expect(result.decision).toBe("NEEDS_VERIFICATION");
    expect(result.totalProvenMissing).toBe(ZERO);
  });

  it("never adds a null-amount continuity gap to the total", () => {
    const result = detectGaps(
      input({
        continuityGaps: [
          {
            kind: "PAYMENT_INTERRUPTED",
            periodLabel: "2026-02, 2026-03",
            dueOn: new Date("2026-02-10T00:00:00Z"),
            amount: null,
            detail: "Interrupted for 2 periods.",
          },
        ],
      }),
    );
    expect(result.totalProvenMissing).toBe(ZERO);
  });
});

describe("decision precedence", () => {
  it("prefers ACTION_REQUIRED when actionable and verification gaps coexist", () => {
    expect(
      decide([
        { kind: "RECEIPT_UNVERIFIED", periodLabel: null, amount: null, evidence: [], needsAction: false },
        { kind: "REJECTED", periodLabel: null, amount: null, evidence: [], needsAction: true },
      ]),
    ).toBe("ACTION_REQUIRED");
  });

  it("is HEALTHY only with no gaps at all", () => {
    expect(decide([])).toBe("HEALTHY");
  });

  it("is NEEDS_VERIFICATION when gaps exist but none need action", () => {
    expect(
      decide([
        { kind: "RECEIPT_UNVERIFIED", periodLabel: null, amount: null, evidence: [], needsAction: false },
      ]),
    ).toBe("NEEDS_VERIFICATION");
  });
});

describe("every gap kind is explainable to a citizen", () => {
  const all: GapKind[] = [
    "NEVER_APPLIED",
    "APPLICATION_PENDING_TOO_LONG",
    "REJECTED",
    "BLOCKED",
    "MISSING_DOCUMENT",
    "PAYMENT_MISSED",
    "PAYMENT_DELAYED",
    "PAYMENT_INTERRUPTED",
    "UNCLAIMED",
    "RECEIPT_UNVERIFIED",
    "RENEWAL_MISSED",
    "STATUS_UNKNOWN",
  ];

  it("has plain-language wording with no enum leaking through", () => {
    for (const kind of all) {
      const text = readable(kind);
      expect(text.length, kind).toBeGreaterThan(5);
      expect(text, kind).not.toMatch(/_/);
      expect(text, kind).toBe(text.toLowerCase());
    }
  });
});
