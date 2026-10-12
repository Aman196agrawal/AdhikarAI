import { beforeEach, describe, expect, it } from "vitest";

import { draftRules } from "@/lib/agents/ruleDrafter";
import { registerStubFixture, resetLlmProvider } from "@/lib/llm";

beforeEach(() => {
  process.env.LLM_PROVIDER = "stub";
  resetLlmProvider();
});

const ELIGIBILITY = [
  "The applicant should be a widow.",
  "The applicant should be 40 years and above.",
  "The applicant should belong to a Below Poverty Line household.",
  "The applicant should be a permanent resident of the district for 10 years.",
].join("\n");

// The default stub runs first; later tests replace the fixture for this task.
describe("drafting with the default stub", () => {
  it("drafts checkable rules that quote their source, and reports the rest as unmapped", async () => {
    const result = await draftRules({ schemeName: "Widow Pension", eligibilityText: ELIGIBILITY });

    expect(result.ok).toBe(true);
    expect(result.rules.map((r) => [r.code, r.field, r.op, r.value])).toEqual([
      ["IS_WIDOW", "isWidow", "is_true", null],
      ["AGE_40_PLUS", "age", "gte", 40],
      ["HAS_BPL_CARD", "hasBplCard", "is_true", null],
    ]);
    expect(result.rules[1].sourceQuote).toBe("The applicant should be 40 years and above.");
    expect(result.unmapped).toEqual([
      "The applicant should be a permanent resident of the district for 10 years.",
    ]);
    expect(result.rejected).toEqual([]);
  });
});

function stubDraft(rules: Array<Record<string, unknown>>, unmapped: string[] = []) {
  registerStubFixture("catalogue.draftRules", () => ({ rules, unmapped }));
}

const good = {
  code: "AGE_60_PLUS",
  kind: "ELIGIBILITY",
  field: "age",
  op: "gte",
  value: 60,
  mandatory: true,
  text: "Applicant must be 60 or older.",
  sourceQuote: "aged 60 years or above",
};

const TEXT = "The applicant must be aged 60 years or above. Income tax payers are not eligible.";

describe("guards on what the model returns", () => {
  it("keeps a valid rule", async () => {
    stubDraft([good]);
    const result = await draftRules({ schemeName: "S", eligibilityText: TEXT });
    expect(result.rules).toHaveLength(1);
    expect(result.unmapped).toEqual([]);
  });

  it("turns a rule with an invented quote into an unmapped condition", async () => {
    stubDraft([{ ...good, sourceQuote: "applicants must own a tractor" }]);
    const result = await draftRules({ schemeName: "S", eligibilityText: TEXT });
    expect(result.rules).toEqual([]);
    expect(result.unmapped).toEqual(["Applicant must be 60 or older."]);
    expect(result.rejected[0].reason).toMatch(/does not appear/);
  });

  it("rejects a field the profile does not have", async () => {
    stubDraft([{ ...good, code: "OWNS_TRACTOR", field: "ownsTractor", op: "is_true", value: null }]);
    const result = await draftRules({ schemeName: "S", eligibilityText: TEXT });
    expect(result.rules).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/not a profile field/);
  });

  it("rejects a numeric comparison on a non-numeric field, and an operand outside the field's domain", async () => {
    stubDraft([
      { ...good, code: "BAD_NUMERIC", field: "gender", op: "gte", value: 3 },
      { ...good, code: "BAD_DOMAIN", field: "socialCategory", op: "eq", value: "Brahmin" },
    ]);
    const result = await draftRules({ schemeName: "S", eligibilityText: TEXT });
    expect(result.rules).toEqual([]);
    expect(result.rejected.map((r) => r.code)).toEqual(["BAD_NUMERIC", "BAD_DOMAIN"]);
  });

  it("rejects an exclusion stated negatively, which would invert its meaning", async () => {
    stubDraft([
      {
        code: "NOT_TAXPAYER",
        kind: "EXCLUSION",
        field: "isIncomeTaxPayer",
        op: "neq",
        value: true,
        mandatory: true,
        text: "Income tax payers are excluded.",
        sourceQuote: "Income tax payers are not eligible",
      },
    ]);
    const result = await draftRules({ schemeName: "S", eligibilityText: TEXT });
    expect(result.rules).toEqual([]);
    expect(result.rejected[0].reason).toMatch(/positively/);
  });

  it("canonicalises operands to the profile's own values", async () => {
    stubDraft([
      {
        code: "SC_ST",
        kind: "ELIGIBILITY",
        field: "socialCategory",
        op: "in",
        value: ["sc", "st"],
        mandatory: true,
        text: "Applicant must be SC or ST.",
        sourceQuote: "aged 60 years or above",
      },
    ]);
    const result = await draftRules({ schemeName: "S", eligibilityText: TEXT });
    expect(result.rules[0].value).toEqual(["SC", "ST"]);
  });

  it("drops a duplicate rule code rather than letting one overwrite the other", async () => {
    stubDraft([good, { ...good, value: 65 }]);
    const result = await draftRules({ schemeName: "S", eligibilityText: TEXT });
    expect(result.rules).toHaveLength(1);
    expect(result.rejected[0].reason).toMatch(/duplicate/);
  });

  it("reports a model failure as not ok, with no rules at all", async () => {
    registerStubFixture("catalogue.draftRules", () => ({ nonsense: true }));
    const result = await draftRules({ schemeName: "S", eligibilityText: TEXT });
    expect(result.ok).toBe(false);
    expect(result.rules).toEqual([]);
    expect(result.llm.reason).toBe("SCHEMA_VALIDATION");
  });
});
