import { beforeAll, describe, expect, it } from "vitest";

import { extractProfile, missingFieldQuestions } from "@/lib/agents/profileAgent";
import { evaluateScheme, type Profile } from "@/lib/engine/rules";
import { resetLlmProvider } from "@/lib/llm";
import { coerceProfileValue } from "@/lib/profile/fields";
import { requireScheme } from "@/lib/registry";

beforeAll(() => {
  // Every test here runs on the deterministic stub.
  process.env.LLM_PROVIDER = "stub";
  resetLlmProvider();
});

const KAMALA_INTAKE = `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`;

describe("extraction from conversation", () => {
  it("pulls the stated facts into a structured profile", async () => {
    const result = await extractProfile({ intake: KAMALA_INTAKE });

    expect(result.llm.ok).toBe(true);
    expect(result.profile.age?.value).toBe(67);
    expect(result.profile.isWidow?.value).toBe(true);
    expect(result.profile.ruralUrban?.value).toBe("rural");
    expect(result.profile.state?.value).toBe("Bihar");
    expect(result.profile.isFarmer?.value).toBe(true);
    expect(result.profile.hasBplCard?.value).toBe(true);
    expect(result.profile.hasBankAccount?.value).toBe(true);
  });

  it("converts acres to hectares and records the original figure", async () => {
    const result = await extractProfile({ intake: KAMALA_INTAKE });
    // 2 acres = 0.809 hectares. PM-KISAN's land clause is in hectares, so an
    // unconverted "2" would be wrong by a factor of 2.5.
    expect(result.profile.landHoldingHectares?.value).toBeCloseTo(0.809, 3);

    const field = result.accepted.find((f) => f.key === "landHoldingHectares");
    expect(field?.note).toMatch(/2 acre/i);
  });

  it("marks a direct statement SELF_DECLARED and a deduction INFERRED", async () => {
    const result = await extractProfile({ intake: KAMALA_INTAKE });

    expect(result.profile.isWidow?.provenance).toBe("SELF_DECLARED");
    // Marital status was never stated; it follows from being a widow.
    expect(result.profile.maritalStatus?.provenance).toBe("INFERRED");
  });

  it("NEVER claims documentary provenance from conversation", async () => {
    // Enforced by the schema: the enum for this task has no such member, so
    // no prompt or model behaviour can promote hearsay to proof.
    const result = await extractProfile({ intake: KAMALA_INTAKE });
    for (const field of result.accepted) {
      expect(field.provenance, field.key).not.toBe("DOCUMENT_VERIFIED");
    }
  });

  it("extracts nothing from an empty or irrelevant intake", async () => {
    const result = await extractProfile({ intake: "hello" });
    expect(result.accepted).toEqual([]);
    // And it does not pretend to know anything.
    expect(Object.keys(result.profile)).toEqual([]);
  });

  it("records an explicit zero rather than treating it as missing", async () => {
    const result = await extractProfile({ intake: KAMALA_INTAKE });
    // "not receiving any pension" is an answer, and it matters: PM-KISAN
    // excludes pensioners above a threshold.
    expect(result.profile.monthlyPensionRupees?.value).toBe(0);
  });

  it("adds to an existing profile instead of replacing it", async () => {
    const existing: Profile = {
      disabilityPercent: { value: 40, provenance: "DOCUMENT_VERIFIED" },
    };
    const result = await extractProfile({ intake: KAMALA_INTAKE, existing });

    expect(result.profile.disabilityPercent?.value).toBe(40);
    expect(result.profile.disabilityPercent?.provenance).toBe("DOCUMENT_VERIFIED");
    expect(result.profile.age?.value).toBe(67);
  });
});

describe("deterministic validation of model output", () => {
  it("rejects an implausible age rather than deciding a pension on it", () => {
    // A model reading "67 years 0 months" could return 670.
    expect(coerceProfileValue("age", 670)).toEqual({
      ok: false,
      reason: expect.stringMatching(/above the plausible maximum/),
    });
  });

  it("rejects a value outside an enumerated domain", () => {
    const result = coerceProfileValue("ruralUrban", "semi-rural");
    expect(result.ok).toBe(false);
  });

  it("rejects unparseable text for a numeric field", () => {
    expect(coerceProfileValue("age", "sixty-seven").ok).toBe(false);
  });

  it("accepts a number with a trailing unit", () => {
    expect(coerceProfileValue("age", "67 years")).toEqual({ ok: true, value: 67 });
  });

  it("requires a whole number where the field demands one", () => {
    expect(coerceProfileValue("householdSize", 3.5).ok).toBe(false);
    expect(coerceProfileValue("householdSize", 3)).toEqual({ ok: true, value: 3 });
  });

  it("accepts a fractional value where the field allows one", () => {
    expect(coerceProfileValue("landHoldingHectares", 0.809)).toEqual({
      ok: true,
      value: 0.809,
    });
  });

  it("understands yes/no in English and Hindi", () => {
    expect(coerceProfileValue("hasBplCard", "yes")).toEqual({ ok: true, value: true });
    expect(coerceProfileValue("hasBplCard", "nahi")).toEqual({ ok: true, value: false });
    expect(coerceProfileValue("hasBplCard", "हाँ")).toEqual({ ok: true, value: true });
  });

  it("preserves an explicit null as a real answer", () => {
    expect(coerceProfileValue("monthlyPensionRupees", null)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("normalises domain values to their canonical casing", () => {
    expect(coerceProfileValue("rationCardType", "phh")).toEqual({
      ok: true,
      value: "PHH",
    });
  });
});

describe("questions are computed from what the rules need", () => {
  it("asks only about fields that mandatory clauses depend on", () => {
    const questions = missingFieldQuestions({});
    const keys = questions.map((q) => q.key);

    // Every scheme needs these.
    expect(keys).toContain("age");
    expect(keys).toContain("hasBankAccount");
    // No clause tests district, so it is not worth asking about.
    expect(keys).not.toContain("district");
  });

  it("names the schemes each answer would unblock", () => {
    const questions = missingFieldQuestions({});
    const age = questions.find((q) => q.key === "age");
    expect(age?.blocks.length).toBeGreaterThan(3);
    expect(age?.blocks).toContain("NSAP-IGNOAPS");
  });

  it("orders questions so the first answer unblocks the most schemes", () => {
    const questions = missingFieldQuestions({});
    for (let i = 0; i < questions.length - 1; i += 1) {
      expect(questions[i].blocks.length).toBeGreaterThanOrEqual(
        questions[i + 1].blocks.length,
      );
    }
  });

  it("stops asking once a field is established", async () => {
    const { profile } = await extractProfile({ intake: KAMALA_INTAKE });
    const keys = missingFieldQuestions(profile).map((q) => q.key);

    expect(keys).not.toContain("age");
    expect(keys).not.toContain("isWidow");
    // Still unknown, and still needed by IGNDPS.
    expect(keys).toContain("disabilityPercent");
  });

  it("treats an explicit null as answered and does not re-ask", () => {
    const keys = missingFieldQuestions({
      disabilityPercent: { value: null, provenance: "SELF_DECLARED" },
    }).map((q) => q.key);
    expect(keys).not.toContain("disabilityPercent");
  });

  it("offers Hindi wording where the demo needs it", () => {
    const questions = missingFieldQuestions({});
    const age = questions.find((q) => q.key === "age");
    expect(age?.questionHi).toBeTruthy();
  });
});

describe("the extracted profile drives real verdicts", () => {
  it("produces the designed outcomes for the hero persona", async () => {
    const { profile } = await extractProfile({ intake: KAMALA_INTAKE });

    // Enough was established from one paragraph of plain speech to decide
    // these two outright.
    expect(evaluateScheme(requireScheme("NSAP-IGNOAPS"), profile).verdict).toBe("GREEN");
    expect(evaluateScheme(requireScheme("NSAP-IGNWPS"), profile).verdict).toBe("GREEN");

    // And to exclude this one, with a citable reason.
    const pmmvy = evaluateScheme(requireScheme("PMMVY"), profile);
    expect(pmmvy.verdict).toBe("RED");
    expect(pmmvy.blockingClauses).toContain("AGE_UNDER_55");
  });

  it("leaves PM-KISAN yellow until the Aadhaar seeding question is answered", async () => {
    const { profile } = await extractProfile({ intake: KAMALA_INTAKE });
    const result = evaluateScheme(requireScheme("PM-KISAN"), profile);

    // She farms 2 acres and declares no disqualifying status, but whether her
    // Aadhaar is seeded to the account is unknown - and that is exactly the
    // dependency that later causes the demo's payment failure.
    expect(result.verdict).toBe("YELLOW");
    expect(result.unknownClauses).toContain("AADHAAR_BANK_SEEDED");
  });
});

describe("failure handling", () => {
  it("reports an unsupported task instead of fabricating output", async () => {
    const { llm } = await import("@/lib/llm");
    const outcome = await llm().complete({
      task: "no.such.task",
      prompt: "anything",
      schema: (await import("zod")).object({ x: (await import("zod")).string() }),
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("UNSUPPORTED_TASK");
      expect(outcome.message).toMatch(/no stub fixture/i);
    }
  });
});
