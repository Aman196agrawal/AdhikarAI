/**
 * Draft -> review -> match, end to end, and the admin guard.
 *
 * Walks one widow pension from the moment the sync first sees it, through AI
 * drafting and human review, to what a citizen is told - and then changes the
 * source text to prove the approval stops counting immediately.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getMatches } from "@/app/api/catalogue/matches/route";
import { GET as getQueue } from "@/app/api/admin/catalogue/queue/route";
import { POST as postRule } from "@/app/api/admin/catalogue/rules/[id]/route";
import { PUT as putUnmapped } from "@/app/api/admin/catalogue/schemes/[id]/unmapped/route";
import { GET as getRuns } from "@/app/api/admin/catalogue/runs/route";
import { draftPendingRules } from "@/lib/catalogue/drafting";
import { syncCatalogue } from "@/lib/catalogue/sync";
import { fixedClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { resetLlmProvider } from "@/lib/llm";
import { saveProfileFields } from "@/lib/services/profile";

import { createCitizen, resetCatalogue, resetCitizenData } from "../helpers/db";
import { FakeSchemeSource, listing } from "../helpers/fakeSchemeSource";

const CLOCK = fixedClock(new Date("2026-10-12T21:00:00Z"));
const TOKEN = "test-admin-token";

const WIDOW_TEXT = [
  "The applicant should be a widow.",
  "The applicant should be 40 years and above.",
  "The applicant should belong to a Below Poverty Line household.",
].join("\n");

function source(): FakeSchemeSource {
  const s = new FakeSchemeSource();
  s.add({ listing: listing("widow-pension", { name: "Widow Pension", level: "State", states: ["Bihar"] }), english: { eligibilityMd: WIDOW_TEXT } });
  s.add({ listing: listing("farmer-support", { name: "Farmer Support" }), english: { eligibilityMd: "The applicant must cultivate land." } });
  s.add({ listing: listing("men-only", { name: "Men Only Scheme" }), english: { eligibilityMd: "Open to men." } });
  s.add({ listing: listing("goa-only", { name: "Goa Scheme", level: "State", states: ["Goa"] }), english: { eligibilityMd: "Residents of Goa." } });
  s.add({
    listing: listing("closed", { name: "Closed Scheme", closesOn: "2026-01-31" }),
    english: { eligibilityMd: "Anyone." },
  });
  s.facets.set("widow-pension", { gender: ["Female"], maritalStatus: ["Widowed"] });
  s.facets.set("men-only", { gender: ["Male"] });
  return s;
}

const adminHeaders = (extra: Record<string, string> = {}) => ({
  authorization: `Bearer ${TOKEN}`,
  "x-reviewer": "Reviewer One",
  "content-type": "application/json",
  ...extra,
});

async function matchesFor(citizenId: string) {
  const response = await getMatches(new Request(`http://test/api/catalogue/matches?citizenId=${citizenId}`));
  expect(response.status).toBe(200);
  return (await response.json()).data as {
    total: number;
    counts: Record<string, number>;
    matches: Array<{ externalId: string; verdict: string; matchedOn: string[]; toConfirm: string[]; officialUrl: string }>;
    attribution: string;
  };
}

async function decide(ruleId: string, body: unknown) {
  return postRule(
    new Request(`http://test/api/admin/catalogue/rules/${ruleId}`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: ruleId }) },
  );
}

let citizenId: string;

beforeAll(() => {
  process.env.DEMO_MODE = "true";
  process.env.LLM_PROVIDER = "stub";
  resetLlmProvider();
});

afterAll(() => {
  process.env.DEMO_MODE = "false";
  delete process.env.ADMIN_TOKEN;
});

beforeEach(async () => {
  process.env.ADMIN_TOKEN = TOKEN;
  await resetCitizenData();
  await resetCatalogue();
  citizenId = (await createCitizen()).id;
  await saveProfileFields(citizenId, [
    { key: "gender", value: "female", provenance: "SELF_DECLARED", note: "" },
    { key: "isWidow", value: true, provenance: "SELF_DECLARED", note: "" },
    { key: "age", value: 52, provenance: "SELF_DECLARED", note: "" },
    { key: "state", value: "Bihar", provenance: "SELF_DECLARED", note: "" },
    { key: "hasBplCard", value: true, provenance: "SELF_DECLARED", note: "" },
  ]);
});

describe("from sync to what a citizen is told", () => {
  it("shows unreviewed schemes as POSSIBLE, and hides what clearly does not apply", async () => {
    await syncCatalogue({ source: source(), clock: CLOCK });

    const result = await matchesFor(citizenId);
    const ids = result.matches.map((m) => m.externalId);

    expect(ids).toEqual(["widow-pension", "farmer-support"]);
    expect(result.matches.every((m) => m.verdict === "POSSIBLE")).toBe(true);
    // Aimed squarely at her, so it ranks first.
    expect(result.matches[0].matchedOn).toEqual(["Female", "Widowed"]);
    expect(result.matches[0].officialUrl).toBe("https://example.gov.in/schemes/widow-pension");
    expect(result.attribution).toMatch(/myScheme/);
    // men-only (gender), goa-only (state) and closed (past closing date) are not shown.
  });

  it("becomes GREEN only once a human has approved every drafted rule for the current text", async () => {
    const src = source();
    await syncCatalogue({ source: src, clock: CLOCK });
    const drafting = await draftPendingRules({ clock: CLOCK });
    expect(drafting.drafted).toBe(5);

    // Drafted but unreviewed: still only POSSIBLE.
    expect((await matchesFor(citizenId)).matches[0].verdict).toBe("POSSIBLE");

    const queueResponse = await getQueue(new Request("http://test/api/admin/catalogue/queue", { headers: adminHeaders() }));
    const queue = (await queueResponse.json()).data.schemes as Array<{ externalId: string; rules: Array<{ id: string; code: string }> }>;
    const widow = queue.find((s) => s.externalId === "widow-pension")!;
    expect(widow.rules.map((r) => r.code).sort()).toEqual(["AGE_40_PLUS", "HAS_BPL_CARD", "IS_WIDOW"]);

    // Approve two of three: a half-reviewed set is not used.
    await decide(widow.rules[0].id, { decision: "APPROVED" });
    await decide(widow.rules[1].id, { decision: "APPROVED" });
    expect((await matchesFor(citizenId)).matches[0].verdict).toBe("POSSIBLE");

    const last = await decide(widow.rules[2].id, { decision: "APPROVED" });
    expect(last.status).toBe(200);
    expect((await last.json()).data).toMatchObject({ status: "APPROVED", reviewedBy: "Reviewer One" });

    const after = await matchesFor(citizenId);
    expect(after.matches[0]).toMatchObject({ externalId: "widow-pension", verdict: "GREEN", toConfirm: [] });
  });

  it("drops a scheme whose approved rules the citizen fails", async () => {
    await syncCatalogue({ source: source(), clock: CLOCK });
    await draftPendingRules({ clock: CLOCK });
    const rules = await prisma.catalogRule.findMany({ where: { scheme: { externalId: "widow-pension" } } });
    for (const rule of rules) await decide(rule.id, { decision: "APPROVED" });

    await saveProfileFields(citizenId, [{ key: "age", value: 35, provenance: "SELF_DECLARED", note: "" }]);
    // saveProfileFields keeps the stronger of two equal-provenance values, so set it directly.
    await prisma.profileField.updateMany({ where: { key: "age", profile: { citizenId } }, data: { value: 35 } });

    const ids = (await matchesFor(citizenId)).matches.map((m) => m.externalId);
    expect(ids).not.toContain("widow-pension");
  });

  it("holds at YELLOW while an unmapped condition remains, until a reviewer clears it", async () => {
    const src = source();
    src.schemes.get("widow-pension")!.english.eligibilityMd = `${WIDOW_TEXT}\nThe applicant should not be remarried.`;
    await syncCatalogue({ source: src, clock: CLOCK });
    await draftPendingRules({ clock: CLOCK });

    const scheme = await prisma.catalogScheme.findFirstOrThrow({ where: { externalId: "widow-pension" }, include: { rules: true } });
    expect(scheme.unmappedCriteria).toEqual(["The applicant should not be remarried."]);
    for (const rule of scheme.rules) await decide(rule.id, { decision: "APPROVED" });

    const held = (await matchesFor(citizenId)).matches[0];
    expect(held).toMatchObject({ verdict: "YELLOW", toConfirm: ["The applicant should not be remarried."] });

    const cleared = await putUnmapped(
      new Request(`http://test/api/admin/catalogue/schemes/${scheme.id}/unmapped`, {
        method: "PUT",
        headers: adminHeaders(),
        body: JSON.stringify({ unmapped: [] }),
      }),
      { params: Promise.resolve({ id: scheme.id }) },
    );
    expect(cleared.status).toBe(200);
    expect((await matchesFor(citizenId)).matches[0].verdict).toBe("GREEN");
  });

  it("stops counting an approval the moment the source text changes, and refuses to approve the stale rule", async () => {
    const src = source();
    await syncCatalogue({ source: src, clock: CLOCK });
    await draftPendingRules({ clock: CLOCK });
    const rules = await prisma.catalogRule.findMany({ where: { scheme: { externalId: "widow-pension" } } });
    for (const rule of rules) await decide(rule.id, { decision: "APPROVED" });
    expect((await matchesFor(citizenId)).matches[0].verdict).toBe("GREEN");

    src.schemes.get("widow-pension")!.english.eligibilityMd = WIDOW_TEXT.replace("40 years", "45 years");
    await syncCatalogue({ source: src, clock: fixedClock(new Date("2026-10-13T21:00:00Z")) });

    expect((await matchesFor(citizenId)).matches[0].verdict).toBe("POSSIBLE");
    const stale = await decide(rules[0].id, { decision: "APPROVED" });
    expect(stale.status).toBe(409);

    // Re-drafting produces fresh drafts from the new text.
    await draftPendingRules({ clock: CLOCK });
    const fresh = await prisma.catalogRule.findMany({ where: { scheme: { externalId: "widow-pension" }, status: "DRAFT" } });
    expect(fresh.map((r) => r.code)).toContain("AGE_45_PLUS");
  });

  it("validates a reviewer's edit as strictly as an AI draft", async () => {
    await syncCatalogue({ source: source(), clock: CLOCK });
    await draftPendingRules({ clock: CLOCK });
    const rule = await prisma.catalogRule.findFirstOrThrow({ where: { code: "AGE_40_PLUS" } });

    const bad = await decide(rule.id, {
      decision: "APPROVED",
      edit: { kind: "ELIGIBILITY", field: "gender", op: "gte", value: 40, mandatory: true, text: "Bad rule", sourceQuote: "x" },
    });
    expect(bad.status).toBe(422);

    const good = await decide(rule.id, {
      decision: "APPROVED",
      edit: { kind: "ELIGIBILITY", field: "age", op: "gte", value: 41, mandatory: true, text: "Must be over 40.", sourceQuote: "40 years and above" },
    });
    expect(good.status).toBe(200);
    expect(await prisma.catalogRule.findUniqueOrThrow({ where: { id: rule.id } })).toMatchObject({ value: 41, draftedBy: "human", reviewedBy: "Reviewer One" });
  });
});

describe("admin guard", () => {
  it("does not exist at all when ADMIN_TOKEN is not configured", async () => {
    delete process.env.ADMIN_TOKEN;
    const response = await getRuns(new Request("http://test/api/admin/catalogue/runs", { headers: adminHeaders() }));
    expect(response.status).toBe(404);
  });

  it("refuses a wrong token, and a request that does not say who is reviewing", async () => {
    const wrong = await getRuns(new Request("http://test/api/admin/catalogue/runs", { headers: adminHeaders({ authorization: "Bearer nope" }) }));
    expect(wrong.status).toBe(401);

    const anonymous = await getRuns(
      new Request("http://test/api/admin/catalogue/runs", { headers: { authorization: `Bearer ${TOKEN}` } }),
    );
    expect(anonymous.status).toBe(400);
  });

  it("reports catalogue health to an authorised admin", async () => {
    await syncCatalogue({ source: source(), clock: CLOCK });
    const response = await getRuns(new Request("http://test/api/admin/catalogue/runs", { headers: adminHeaders() }));
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.catalogue.active).toBe(5);
    expect(data.runs[0]).toMatchObject({ status: "SUCCEEDED", created: 5 });
  });
});
