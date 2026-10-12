import { describe, expect, it } from "vitest";

import { facetCheck, usableRules } from "@/lib/catalogue/match";
import type { Profile } from "@/lib/engine/rules";

const p = (values: Record<string, string | number | boolean | null>): Profile =>
  Object.fromEntries(
    Object.entries(values).map(([k, value]) => [k, { value, provenance: "SELF_DECLARED" }]),
  ) as Profile;

describe("facetCheck", () => {
  it("matches a citizen the scheme is aimed at", () => {
    const outcome = facetCheck(
      { gender: ["Female"], maritalStatus: ["Widowed"] },
      p({ gender: "female", isWidow: true }),
    );
    expect(outcome).toEqual({ excludedBy: null, matched: ["Female", "Widowed"], unknown: [] });
  });

  it("excludes only on a clear contradiction", () => {
    expect(facetCheck({ gender: ["Female"] }, p({ gender: "male" })).excludedBy).toBe("gender: Female");
    expect(facetCheck({ caste: ["Scheduled Caste (SC)", "Scheduled Tribe (ST)"] }, p({ socialCategory: "OBC" })).excludedBy).toMatch(/caste/);
    expect(facetCheck({ isBpl: ["Yes"] }, p({ hasBplCard: false })).excludedBy).toMatch(/isBpl/);
    expect(facetCheck({ disability: ["Yes"] }, p({ disabilityPercent: 0 })).excludedBy).toMatch(/disability/);
  });

  it("asks rather than hides when the profile is silent", () => {
    const outcome = facetCheck({ gender: ["Female"], isBpl: ["Yes"], minority: ["Yes"] }, p({}));
    expect(outcome.excludedBy).toBeNull();
    expect(outcome.matched).toEqual([]);
    expect(outcome.unknown).toEqual([
      "Your gender",
      "Whether your household is below the poverty line (BPL card)",
      "Whether you belong to a notified minority community",
    ]);
  });

  it("does not decide sub-categories the profile cannot express", () => {
    // PVTG is a subset of ST: an ST citizen may or may not belong.
    const outcome = facetCheck(
      { caste: ["Particularly Vulnerable Tribal Group (PVTG)"] },
      p({ socialCategory: "ST" }),
    );
    expect(outcome.excludedBy).toBeNull();
    expect(outcome.unknown).toHaveLength(1);
  });

  it("treats an AAY ration card as below the poverty line", () => {
    expect(facetCheck({ isBpl: ["Yes"] }, p({ rationCardType: "AAY" })).matched).toEqual(["Yes"]);
  });

  it("matches occupations from the profile, and excludes only when it understands the occupation", () => {
    expect(facetCheck({ occupation: ["Farmer"] }, p({ isFarmer: true })).matched).toEqual(["Farmer"]);
    expect(facetCheck({ occupation: ["Fishermen"] }, p({ occupation: "farmer" })).excludedBy).toMatch(/occupation/);
    // "Shopkeeper" is not an occupation we can place, so it proves nothing.
    expect(facetCheck({ occupation: ["Fishermen"] }, p({ occupation: "shopkeeper" })).unknown).toEqual(["Your occupation"]);
  });

  it("ignores facets it has no rule for", () => {
    expect(facetCheck({ somethingNew: ["X"] }, p({}))).toEqual({ excludedBy: null, matched: [], unknown: [] });
  });
});

describe("usableRules", () => {
  const rule = (overrides: Record<string, unknown> = {}) => ({
    code: "AGE_60_PLUS",
    kind: "ELIGIBILITY" as const,
    field: "age",
    op: "gte",
    value: 60,
    mandatory: true,
    text: "Must be 60 or older.",
    status: "APPROVED",
    sourceHash: "h1",
    reviewedAt: new Date("2026-10-12T00:00:00Z"),
    ...overrides,
  });
  const scheme = (rules: ReturnType<typeof rule>[], overrides: Record<string, unknown> = {}) => ({
    contentHash: "h1",
    draftStatus: "DRAFTED",
    officialUrl: "https://example.gov.in/s",
    rules,
    ...overrides,
  });

  it("returns approved rules for the current text as engine clauses", () => {
    const clauses = usableRules(scheme([rule()]));
    expect(clauses).toHaveLength(1);
    expect(clauses?.[0]).toMatchObject({ code: "AGE_60_PLUS", sourceName: "myScheme", lastVerified: "2026-10-12" });
  });

  it("refuses rules drafted from older text", () => {
    expect(usableRules(scheme([rule({ sourceHash: "h0" })]))).toBeNull();
  });

  it("refuses a half-reviewed rule set", () => {
    expect(usableRules(scheme([rule(), rule({ code: "IS_WIDOW", status: "DRAFT" })]))).toBeNull();
  });

  it("refuses when drafting has not finished or nothing was approved", () => {
    expect(usableRules(scheme([rule()], { draftStatus: "PENDING" }))).toBeNull();
    expect(usableRules(scheme([rule({ status: "REJECTED" })]))).toBeNull();
  });
});
