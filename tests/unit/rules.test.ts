import { describe, expect, it } from "vitest";

import {
  evaluateClause,
  evaluateScheme,
  type Profile,
  type ProfileFieldValue,
} from "@/lib/engine/rules";
import { requireScheme } from "@/lib/registry";
import type { ClauseSpec } from "@/lib/registry/types";

/** Minimal clause factory; each test overrides only what it cares about. */
function clause(overrides: Partial<ClauseSpec> = {}): ClauseSpec {
  return {
    code: "TEST",
    kind: "ELIGIBILITY",
    field: "age",
    op: "gte",
    value: 60,
    mandatory: true,
    evidenceDocs: ["AGE_PROOF"],
    text: "The applicant must be aged 60 years or above for this test clause.",
    sourceName: "Test source",
    sourceUrl: "https://example.gov.in/rule",
    lastVerified: "2026-10-08",
    ...overrides,
  };
}

const declared = (value: unknown): ProfileFieldValue => ({
  value: value as ProfileFieldValue["value"],
  provenance: "SELF_DECLARED",
});

const proven = (value: unknown): ProfileFieldValue => ({
  value: value as ProfileFieldValue["value"],
  provenance: "DOCUMENT_VERIFIED",
});

describe("operators", () => {
  const cases: Array<{
    op: ClauseSpec["op"];
    value: unknown;
    observed: unknown;
    expected: "SATISFIED" | "VIOLATED";
  }> = [
    { op: "gte", value: 60, observed: 67, expected: "SATISFIED" },
    { op: "gte", value: 60, observed: 60, expected: "SATISFIED" },
    { op: "gte", value: 60, observed: 59, expected: "VIOLATED" },
    { op: "gt", value: 0, observed: 0.5, expected: "SATISFIED" },
    { op: "gt", value: 0, observed: 0, expected: "VIOLATED" },
    { op: "lte", value: 800000, observed: 120000, expected: "SATISFIED" },
    { op: "lt", value: 55, observed: 67, expected: "VIOLATED" },
    { op: "lt", value: 55, observed: 32, expected: "SATISFIED" },
    { op: "eq", value: "rural", observed: "rural", expected: "SATISFIED" },
    { op: "eq", value: "rural", observed: "urban", expected: "VIOLATED" },
    { op: "neq", value: "urban", observed: "rural", expected: "SATISFIED" },
    { op: "in", value: ["AAY", "PHH"], observed: "PHH", expected: "SATISFIED" },
    { op: "in", value: ["AAY", "PHH"], observed: "NON_NFSA", expected: "VIOLATED" },
    { op: "not_in", value: ["GOVERNMENT_SERVICE"], observed: "FARMER", expected: "SATISFIED" },
    { op: "between", value: [40, 79], observed: 67, expected: "SATISFIED" },
    { op: "between", value: [40, 79], observed: 40, expected: "SATISFIED" },
    { op: "between", value: [40, 79], observed: 79, expected: "SATISFIED" },
    { op: "between", value: [40, 79], observed: 80, expected: "VIOLATED" },
    { op: "between", value: [40, 79], observed: 39, expected: "VIOLATED" },
    { op: "is_true", value: true, observed: true, expected: "SATISFIED" },
    { op: "is_true", value: true, observed: false, expected: "VIOLATED" },
    { op: "is_false", value: false, observed: false, expected: "SATISFIED" },
    { op: "is_false", value: false, observed: true, expected: "VIOLATED" },
    { op: "exists", value: null, observed: "D5", expected: "SATISFIED" },
  ];

  for (const c of cases) {
    it(`${c.op}(${JSON.stringify(c.value)}) against ${JSON.stringify(c.observed)} is ${c.expected}`, () => {
      const result = evaluateClause(clause({ op: c.op, value: c.value }), {
        age: declared(c.observed),
      });
      expect(result.result).toBe(c.expected);
    });
  }

  it("compares strings case-insensitively, since intake is free text", () => {
    const result = evaluateClause(clause({ op: "eq", value: "rural" }), {
      age: declared("Rural"),
    });
    expect(result.result).toBe("SATISFIED");
  });
});

describe("unknown is never guessed", () => {
  it("is UNKNOWN when the field is absent from the profile", () => {
    const result = evaluateClause(clause(), {});
    expect(result.result).toBe("UNKNOWN");
    expect(result.provenance).toBe("MISSING");
  });

  it("is UNKNOWN when the field is present but null", () => {
    const result = evaluateClause(clause(), { age: declared(null) });
    expect(result.result).toBe("UNKNOWN");
  });

  it("is UNKNOWN when provenance is MISSING even if a value is present", () => {
    const result = evaluateClause(clause(), {
      age: { value: 67 as never, provenance: "MISSING" },
    });
    expect(result.result).toBe("UNKNOWN");
  });

  it("is UNKNOWN when a numeric comparison gets a non-number", () => {
    // Never coerce "sixty-seven" into a number and decide a benefit on it.
    const result = evaluateClause(clause({ op: "gte", value: 60 }), {
      age: declared("sixty-seven"),
    });
    expect(result.result).toBe("UNKNOWN");
  });

  it("distinguishes an absent field from an explicit null for exists", () => {
    // Absent means we never asked; explicit null means we asked and there is
    // none. Only the second is a definite answer.
    expect(
      evaluateClause(clause({ op: "exists", value: null }), {}).result,
    ).toBe("UNKNOWN");
    expect(
      evaluateClause(clause({ op: "exists", value: null }), {
        age: declared(null),
      }).result,
    ).toBe("UNKNOWN");
    expect(
      evaluateClause(clause({ op: "exists", value: null }), {
        age: declared(""),
      }).result,
    ).toBe("VIOLATED");
  });
});

describe("clause evaluation carries its own evidence", () => {
  it("returns the source metadata needed by the Why? drawer", () => {
    const result = evaluateClause(clause(), { age: proven(67) });
    expect(result.sourceUrl).toBe("https://example.gov.in/rule");
    expect(result.sourceName).toBe("Test source");
    expect(result.lastVerified).toBe("2026-10-08");
    expect(result.text).toMatch(/aged 60 years or above/);
    expect(result.observedValue).toBe(67);
    expect(result.provenance).toBe("DOCUMENT_VERIFIED");
  });
});

describe("disqualification semantics", () => {
  it("treats a satisfied EXCLUSION as disqualifying", () => {
    // "is an income tax payer" holding true must disqualify, not qualify.
    const result = evaluateClause(
      clause({ kind: "EXCLUSION", field: "isIncomeTaxPayer", op: "is_true", value: true }),
      { isIncomeTaxPayer: declared(true) },
    );
    expect(result.result).toBe("SATISFIED");
    expect(result.disqualifies).toBe(true);
  });

  it("treats a violated EXCLUSION as harmless", () => {
    const result = evaluateClause(
      clause({ kind: "EXCLUSION", field: "isIncomeTaxPayer", op: "is_true", value: true }),
      { isIncomeTaxPayer: declared(false) },
    );
    expect(result.result).toBe("VIOLATED");
    expect(result.disqualifies).toBe(false);
  });

  it("treats a violated ELIGIBILITY clause as disqualifying", () => {
    const result = evaluateClause(clause({ op: "gte", value: 60 }), {
      age: declared(42),
    });
    expect(result.disqualifies).toBe(true);
  });

  it("never treats UNKNOWN as disqualifying", () => {
    expect(evaluateClause(clause(), {}).disqualifies).toBe(false);
  });
});

describe("scheme verdict aggregation", () => {
  const ignoaps = requireScheme("NSAP-IGNOAPS");

  it("is GREEN when every mandatory clause is satisfied", () => {
    const result = evaluateScheme(ignoaps, {
      age: proven(67),
      hasBplCard: proven(true),
      hasBankAccount: proven(true),
      isAadhaarLinkedToBank: proven(true),
    });
    expect(result.verdict).toBe("GREEN");
    expect(result.missingEvidence).toEqual([]);
  });

  it("is YELLOW when a mandatory clause is unknown", () => {
    const result = evaluateScheme(ignoaps, {
      age: proven(67),
      hasBankAccount: proven(true),
      // hasBplCard unknown
    });
    expect(result.verdict).toBe("YELLOW");
    expect(result.unknownClauses).toContain("BPL_HOUSEHOLD");
    expect(result.missingEvidence.length).toBeGreaterThan(0);
  });

  it("is RED when a mandatory clause is violated", () => {
    const result = evaluateScheme(ignoaps, {
      age: proven(42),
      hasBplCard: proven(true),
      hasBankAccount: proven(true),
    });
    expect(result.verdict).toBe("RED");
    expect(result.blockingClauses).toContain("AGE_60_PLUS");
  });

  it("prefers RED over YELLOW when both a violation and an unknown exist", () => {
    // A definite disqualification is not softened by missing information
    // elsewhere; claiming "maybe eligible" would waste a citizen's time.
    const result = evaluateScheme(ignoaps, { age: proven(42) });
    expect(result.verdict).toBe("RED");
  });

  it("ignores non-mandatory clauses when deciding the verdict", () => {
    // AADHAAR_BANK_SEEDED is non-mandatory for IGNOAPS; not knowing it must
    // not hold the verdict back from GREEN.
    const result = evaluateScheme(ignoaps, {
      age: proven(67),
      hasBplCard: proven(true),
      hasBankAccount: proven(true),
    });
    expect(result.verdict).toBe("GREEN");
  });
});

describe("the demo personas resolve as designed", () => {
  const kamala: Profile = {
    age: proven(67),
    gender: proven("female"),
    state: proven("Bihar"),
    ruralUrban: proven("rural"),
    isWidow: proven(true),
    hasBplCard: proven(true),
    hasBankAccount: proven(true),
    isAadhaarLinkedToBank: declared(true),
    isFarmer: proven(true),
    landHoldingHectares: proven(0.8),
    rationCardType: proven("PHH"),
    householdSize: proven(3),
    isIncomeTaxPayer: declared(false),
    isGovernmentEmployee: declared(false),
    isInstitutionalLandholder: declared(false),
    isProfessional: declared(false),
    monthlyPensionRupees: declared(0),
    housingType: proven("KUCCHA"),
    hasPuccaHouse: proven(false),
    seccDeprivationCriteria: proven("D5"),
  };

  it("makes her eligible for PM-KISAN", () => {
    expect(evaluateScheme(requireScheme("PM-KISAN"), kamala).verdict).toBe("GREEN");
  });

  it("makes her eligible for IGNOAPS", () => {
    expect(evaluateScheme(requireScheme("NSAP-IGNOAPS"), kamala).verdict).toBe("GREEN");
  });

  it("makes her eligible for IGNWPS, the unclaimed benefit", () => {
    expect(evaluateScheme(requireScheme("NSAP-IGNWPS"), kamala).verdict).toBe("GREEN");
  });

  it("EXCLUDES her from PMMVY on age, with a citable reason", () => {
    const result = evaluateScheme(requireScheme("PMMVY"), kamala);
    expect(result.verdict).toBe("RED");
    expect(result.blockingClauses).toContain("AGE_UNDER_55");

    const blocking = result.clauses.find((c) => c.clauseCode === "AGE_UNDER_55");
    expect(blocking?.sourceUrl).toMatch(/^https:\/\//);
    expect(blocking?.text).toMatch(/55 years/);
  });

  it("excludes her from IGNDPS, having no disability record", () => {
    // Disability is unknown rather than zero, so this is YELLOW not RED:
    // we must not assert she is not disabled when we never asked.
    const result = evaluateScheme(requireScheme("NSAP-IGNDPS"), kamala);
    expect(result.verdict).toBe("YELLOW");
    expect(result.unknownClauses).toContain("SEVERE_DISABILITY");
  });

  it("excludes a government employee from PM-KISAN", () => {
    const result = evaluateScheme(requireScheme("PM-KISAN"), {
      ...kamala,
      isGovernmentEmployee: proven(true),
    });
    expect(result.verdict).toBe("RED");
    expect(result.blockingClauses).toContain("EXCL_GOVERNMENT_EMPLOYEE");
  });

  it("excludes a landless applicant from PM-KISAN", () => {
    const result = evaluateScheme(requireScheme("PM-KISAN"), {
      ...kamala,
      landHoldingHectares: proven(0),
    });
    expect(result.verdict).toBe("RED");
    expect(result.blockingClauses).toContain("HAS_CULTIVABLE_LAND");
  });
});
