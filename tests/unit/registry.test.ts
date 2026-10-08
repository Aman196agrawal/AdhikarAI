import { describe, expect, it } from "vitest";

import {
  SCHEMES,
  getScheme,
  referencedProfileFields,
  requireScheme,
  schemesForState,
  validateRegistry,
} from "@/lib/registry";

describe("registry integrity", () => {
  it("has no structural problems", () => {
    // Reported as a list so a failure names every problem at once rather than
    // making someone fix them one test run at a time.
    expect(validateRegistry()).toEqual([]);
  });

  it("carries the ten curated schemes", () => {
    expect(SCHEMES).toHaveLength(10);
  });

  it("gives every scheme a source URL and a verification status", () => {
    for (const scheme of SCHEMES) {
      expect(scheme.sourceUrl, scheme.code).toMatch(/^https:\/\//);
      expect(
        ["SOURCE_CHECKED", "COMPILED_UNVERIFIED"],
        scheme.code,
      ).toContain(scheme.verificationStatus);
    }
  });

  it("gives every clause its own citable source, not just the scheme's", () => {
    for (const scheme of SCHEMES) {
      for (const clause of scheme.clauses) {
        expect(clause.sourceUrl, `${scheme.code}/${clause.code}`).toMatch(
          /^https:\/\//,
        );
        expect(clause.text.length, `${scheme.code}/${clause.code}`).toBeGreaterThan(
          20,
        );
      }
    }
  });

  it("does not claim a rupee value for in-kind benefits", () => {
    // NFSA is foodgrain and MGNREGA is a work guarantee. Representing either as
    // a cash amount - or worse, as zero - would corrupt every dashboard total.
    const nfsa = requireScheme("NFSA-PHH");
    expect(nfsa.benefitAmountRupees).toBeNull();
    expect(nfsa.benefitNote).toBeTruthy();

    const mgnrega = requireScheme("MGNREGA");
    expect(mgnrega.benefitAmountRupees).toBeNull();
    expect(mgnrega.benefitNote).toBeTruthy();
  });

  it("states that NSAP cash figures are central assistance only", () => {
    // State top-ups are not modelled, and the registry must say so rather than
    // letting a citizen read 200 as the total they should receive.
    for (const code of ["NSAP-IGNOAPS", "NSAP-IGNWPS", "NSAP-IGNDPS"]) {
      expect(requireScheme(code).benefitNote, code).toMatch(/central/i);
    }
  });
});

describe("registry lookup", () => {
  it("finds a scheme by code", () => {
    expect(getScheme("PM-KISAN")?.name).toBe("Pradhan Mantri Kisan Samman Nidhi");
  });

  it("returns undefined for an unknown code", () => {
    expect(getScheme("NOT-A-SCHEME")).toBeUndefined();
  });

  it("throws a helpful error when a scheme is required but missing", () => {
    expect(() => requireScheme("NOT-A-SCHEME")).toThrow(/Unknown scheme code/);
  });

  it("treats an empty state list as all-India", () => {
    // All ten are central, so any state sees all of them.
    expect(schemesForState("Bihar")).toHaveLength(10);
    expect(schemesForState("Kerala")).toHaveLength(10);
  });
});

describe("profile fields the registry depends on", () => {
  it("reports the fields the profile agent must populate", () => {
    const fields = referencedProfileFields();
    expect(fields).toContain("age");
    expect(fields).toContain("hasBplCard");
    expect(fields).toContain("landHoldingHectares");
    expect(fields).toContain("isAadhaarLinkedToBank");
  });

  it("is sorted and free of duplicates", () => {
    const fields = referencedProfileFields();
    expect([...new Set(fields)]).toEqual(fields);
    expect([...fields].sort()).toEqual(fields);
  });
});

describe("eligibility rules that drive the demo", () => {
  it("excludes a 67-year-old from PMMVY on age", () => {
    // Kamala Devi is 67. PMMVY requires under 55 at childbirth, so her card
    // must come out RED with a citable reason. A discovery engine that offered
    // her a maternity benefit would be obviously broken.
    const clause = requireScheme("PMMVY").clauses.find(
      (c) => c.code === "AGE_UNDER_55",
    );
    expect(clause).toBeDefined();
    expect(clause?.op).toBe("lt");
    expect(clause?.value).toBe(55);
    expect(clause?.mandatory).toBe(true);
  });

  it("admits a 67-year-old widow to IGNWPS", () => {
    const clause = requireScheme("NSAP-IGNWPS").clauses.find(
      (c) => c.code === "AGE_40_TO_79",
    );
    expect(clause?.op).toBe("between");
    expect(clause?.value).toEqual([40, 79]);
  });

  it("models the Aadhaar-to-bank seeding dependency that causes the demo gap", () => {
    // The hero scenario's root cause is an Aadhaar/bank seeding failure, so the
    // dependency has to exist as a citable clause rather than being invented by
    // the diagnosis agent.
    const clause = requireScheme("NSAP-IGNOAPS").clauses.find(
      (c) => c.code === "AADHAAR_BANK_SEEDED",
    );
    expect(clause).toBeDefined();
    expect(clause?.kind).toBe("DEPENDENCY");
  });

  it("keeps PM-KISAN exclusions positively stated", () => {
    const exclusions = requireScheme("PM-KISAN").clauses.filter(
      (c) => c.kind === "EXCLUSION",
    );
    expect(exclusions.length).toBeGreaterThanOrEqual(4);
    for (const clause of exclusions) {
      expect(["is_true", "gte", "in", "eq"], clause.code).toContain(clause.op);
    }
  });
});
