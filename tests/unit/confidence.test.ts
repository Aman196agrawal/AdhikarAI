import { describe, expect, it } from "vitest";

import { computeConfidence, PROVENANCE_WEIGHT } from "@/lib/engine/confidence";
import { evaluateScheme, type ProfileFieldValue } from "@/lib/engine/rules";
import type { ProvenanceLevel } from "@/lib/generated/prisma/enums";
import { requireScheme } from "@/lib/registry";

const ignoaps = requireScheme("NSAP-IGNOAPS");

const at = (
  provenance: ProvenanceLevel,
  value: unknown,
): ProfileFieldValue => ({
  value: value as ProfileFieldValue["value"],
  provenance,
});

describe("provenance weights", () => {
  it("ranks document evidence above self-declaration above inference", () => {
    expect(PROVENANCE_WEIGHT.DOCUMENT_VERIFIED).toBe(1);
    expect(PROVENANCE_WEIGHT.SELF_DECLARED).toBeLessThan(
      PROVENANCE_WEIGHT.DOCUMENT_VERIFIED,
    );
    expect(PROVENANCE_WEIGHT.INFERRED).toBeLessThan(
      PROVENANCE_WEIGHT.SELF_DECLARED,
    );
    expect(PROVENANCE_WEIGHT.MISSING).toBe(0);
  });
});

describe("confidence is derived from rule coverage", () => {
  it("is 1.0 when every mandatory clause rests on a document", () => {
    const evaluation = evaluateScheme(ignoaps, {
      age: at("DOCUMENT_VERIFIED", 67),
      hasBplCard: at("DOCUMENT_VERIFIED", true),
      hasBankAccount: at("DOCUMENT_VERIFIED", true),
    });
    const result = computeConfidence(evaluation);
    expect(result.confidence).toBe(1);
    expect(result.verdict).toBe("GREEN");
  });

  it("is 0.7 when every mandatory clause is only self-declared", () => {
    const evaluation = evaluateScheme(ignoaps, {
      age: at("SELF_DECLARED", 67),
      hasBplCard: at("SELF_DECLARED", true),
      hasBankAccount: at("SELF_DECLARED", true),
    });
    expect(computeConfidence(evaluation).confidence).toBe(0.7);
  });

  it("averages a mixture of provenances", () => {
    // Three mandatory clauses: 1.0 + 0.7 + 0.5 = 2.2 / 3 = 0.73
    const evaluation = evaluateScheme(ignoaps, {
      age: at("DOCUMENT_VERIFIED", 67),
      hasBplCard: at("SELF_DECLARED", true),
      hasBankAccount: at("INFERRED", true),
    });
    expect(computeConfidence(evaluation).confidence).toBe(0.73);
  });

  it("is dragged down by a missing mandatory field", () => {
    const evaluation = evaluateScheme(ignoaps, {
      age: at("DOCUMENT_VERIFIED", 67),
      hasBplCard: at("DOCUMENT_VERIFIED", true),
      // hasBankAccount absent entirely
    });
    const result = computeConfidence(evaluation);
    // 1.0 + 1.0 + 0 = 2.0 / 3 = 0.67
    expect(result.confidence).toBe(0.67);
    expect(result.verdict).toBe("YELLOW");
  });

  it("ignores non-mandatory clauses, which must not dilute the score", () => {
    // IGNOAPS has a non-mandatory Aadhaar-seeding clause. Supplying it or not
    // cannot change a confidence built from mandatory coverage.
    const withoutOptional = computeConfidence(
      evaluateScheme(ignoaps, {
        age: at("DOCUMENT_VERIFIED", 67),
        hasBplCard: at("DOCUMENT_VERIFIED", true),
        hasBankAccount: at("DOCUMENT_VERIFIED", true),
      }),
    );
    const withOptional = computeConfidence(
      evaluateScheme(ignoaps, {
        age: at("DOCUMENT_VERIFIED", 67),
        hasBplCard: at("DOCUMENT_VERIFIED", true),
        hasBankAccount: at("DOCUMENT_VERIFIED", true),
        isAadhaarLinkedToBank: at("SELF_DECLARED", true),
      }),
    );
    expect(withOptional.confidence).toBe(withoutOptional.confidence);
  });
});

describe("confidence for an exclusion", () => {
  it("reflects how well the disqualifying fact is evidenced", () => {
    // A RED verdict's confidence is about the exclusion, not about overall
    // coverage: what matters is how sure we are of the fact that rules the
    // citizen out.
    const proven = computeConfidence(
      evaluateScheme(ignoaps, {
        age: at("DOCUMENT_VERIFIED", 42),
        hasBplCard: at("DOCUMENT_VERIFIED", true),
        hasBankAccount: at("DOCUMENT_VERIFIED", true),
      }),
    );
    expect(proven.verdict).toBe("RED");
    expect(proven.confidence).toBe(1);

    const hearsay = computeConfidence(
      evaluateScheme(ignoaps, {
        age: at("INFERRED", 42),
        hasBplCard: at("DOCUMENT_VERIFIED", true),
        hasBankAccount: at("DOCUMENT_VERIFIED", true),
      }),
    );
    expect(hearsay.verdict).toBe("RED");
    // An age we merely inferred is a weak basis for denying a pension.
    expect(hearsay.confidence).toBe(0.5);
  });
});

describe("confidence is reportable", () => {
  it("names what is missing, so the number is actionable", () => {
    const result = computeConfidence(
      evaluateScheme(ignoaps, { age: at("DOCUMENT_VERIFIED", 67) }),
    );
    expect(result.missingEvidence.length).toBeGreaterThan(0);
    expect(result.coverage.missing).toBeGreaterThan(0);
    expect(result.coverage.mandatoryTotal).toBe(3);
  });

  it("breaks coverage down by provenance", () => {
    const result = computeConfidence(
      evaluateScheme(ignoaps, {
        age: at("DOCUMENT_VERIFIED", 67),
        hasBplCard: at("SELF_DECLARED", true),
        hasBankAccount: at("SELF_DECLARED", true),
      }),
    );
    expect(result.coverage).toMatchObject({
      documentVerified: 1,
      selfDeclared: 2,
      inferred: 0,
      missing: 0,
      mandatoryTotal: 3,
    });
  });

  it("maps a score to language a citizen can read", () => {
    expect(computeConfidence(
      evaluateScheme(ignoaps, {
        age: at("DOCUMENT_VERIFIED", 67),
        hasBplCard: at("DOCUMENT_VERIFIED", true),
        hasBankAccount: at("DOCUMENT_VERIFIED", true),
      }),
    ).label).toBe("verified");

    expect(computeConfidence(
      evaluateScheme(ignoaps, {
        age: at("SELF_DECLARED", 67),
        hasBplCard: at("SELF_DECLARED", true),
        hasBankAccount: at("SELF_DECLARED", true),
      }),
    ).label).toBe("likely");

    expect(computeConfidence(
      evaluateScheme(ignoaps, { age: at("SELF_DECLARED", 67) }),
    ).label).toBe("unverified");
  });
});

describe("confidence stays in range", () => {
  it("never exceeds 1 or falls below 0", () => {
    for (const scheme of ["PM-KISAN", "PMMVY", "NFSA-PHH", "MGNREGA"]) {
      const empty = computeConfidence(evaluateScheme(requireScheme(scheme), {}));
      expect(empty.confidence).toBeGreaterThanOrEqual(0);
      expect(empty.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("is 0 for a profile that establishes nothing", () => {
    expect(computeConfidence(evaluateScheme(ignoaps, {})).confidence).toBe(0);
  });

  it("is never presented as a probability of legal entitlement", () => {
    // Guard against the label vocabulary drifting into false precision.
    const result = computeConfidence(evaluateScheme(ignoaps, {}));
    expect(["verified", "likely", "potential", "unverified"]).toContain(
      result.label,
    );
  });
});
