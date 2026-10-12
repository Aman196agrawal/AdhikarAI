/**
 * The catalogue sync's freshness guarantees, against a real database and an
 * in-memory source that changes between runs.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { syncCatalogue } from "@/lib/catalogue/sync";

import { resetCatalogue } from "../helpers/db";
import { FakeSchemeSource, listing } from "../helpers/fakeSchemeSource";

const DAY1 = fixedClock(new Date("2026-10-12T21:00:00Z"));
const DAY2 = fixedClock(new Date("2026-10-13T21:00:00Z"));
const DAY3 = fixedClock(new Date("2026-10-14T21:00:00Z"));

function sourceWith(...ids: string[]): FakeSchemeSource {
  const source = new FakeSchemeSource();
  for (const id of ids) {
    source.add({
      listing: listing(id),
      english: { eligibilityMd: `Eligibility for ${id}.`, benefitsMd: `Benefits of ${id}.` },
      hindi: { name: `योजना ${id}`, eligibilityMd: `${id} के लिए पात्रता।` },
    });
  }
  return source;
}

const row = (externalId: string) =>
  prisma.catalogScheme.findUniqueOrThrow({
    where: { source_externalId: { source: "fake", externalId } },
    include: { snapshots: true, rules: true },
  });

async function addRule(externalId: string, status: "DRAFT" | "APPROVED", code = "R1") {
  const scheme = await row(externalId);
  return prisma.catalogRule.create({
    data: {
      catalogSchemeId: scheme.id,
      code,
      kind: "ELIGIBILITY",
      field: "isWidow",
      op: "is_true",
      value: true,
      text: "Applicant must be a widow.",
      sourceQuote: "Eligibility",
      sourceHash: scheme.contentHash,
      status,
      draftedBy: "ai",
    },
  });
}

describe("catalogue sync", () => {
  beforeEach(async () => {
    await resetCatalogue();
  });

  it("creates every listed scheme with texts, Hindi, a snapshot and a run record", async () => {
    const source = sourceWith("a", "b");
    source.facets.set("a", { gender: ["Female"] });

    const summary = await syncCatalogue({ source, clock: DAY1 });

    expect(summary).toMatchObject({ status: "SUCCEEDED", listed: 2, created: 2, changed: 0, unchanged: 0 });
    const a = await row("a");
    expect(a).toMatchObject({
      name: "Scheme a",
      nameHi: "योजना a",
      eligibilityMd: "Eligibility for a.",
      officialUrl: "https://example.gov.in/schemes/a",
      status: "ACTIVE",
      draftStatus: "PENDING",
      facets: { gender: ["Female"] },
    });
    expect(a.firstSeenAt.toISOString()).toBe("2026-10-12T21:00:00.000Z");
    expect(a.snapshots).toHaveLength(1);
    expect(a.snapshots[0].contentHash).toBe(a.contentHash);

    const run = await prisma.schemeSyncRun.findUniqueOrThrow({ where: { id: summary.runId } });
    expect(run).toMatchObject({ status: "SUCCEEDED", listed: 2, created: 2 });
    expect(run.finishedAt?.toISOString()).toBe("2026-10-12T21:00:00.000Z");
  });

  it("treats an unchanged scheme as unchanged: no snapshot, no re-fetch of Hindi", async () => {
    const source = sourceWith("a");
    await syncCatalogue({ source, clock: DAY1 });
    source.detailCalls = [];

    const summary = await syncCatalogue({ source, clock: DAY2 });

    expect(summary).toMatchObject({ unchanged: 1, changed: 0, created: 0 });
    expect(source.detailCalls).toEqual([{ externalId: "a", lang: "en" }]);
    const a = await row("a");
    expect(a.snapshots).toHaveLength(1);
    expect(a.lastFetchedAt.toISOString()).toBe("2026-10-13T21:00:00.000Z");
    expect(a.lastChangedAt.toISOString()).toBe("2026-10-12T21:00:00.000Z");
  });

  it("detects a changed eligibility text, snapshots it, and makes every old rule STALE", async () => {
    const source = sourceWith("a");
    await syncCatalogue({ source, clock: DAY1 });
    await addRule("a", "APPROVED", "APPROVED_RULE");
    await addRule("a", "DRAFT", "DRAFT_RULE");
    const before = await row("a");

    source.schemes.get("a")!.english.eligibilityMd = "Eligibility for a, now aged 40 and over.";
    const summary = await syncCatalogue({ source, clock: DAY2 });

    expect(summary).toMatchObject({ changed: 1, unchanged: 0 });
    const after = await row("a");
    expect(after.contentHash).not.toBe(before.contentHash);
    expect(after.eligibilityMd).toBe("Eligibility for a, now aged 40 and over.");
    expect(after.lastChangedAt.toISOString()).toBe("2026-10-13T21:00:00.000Z");
    expect(after.draftStatus).toBe("PENDING");
    expect(after.snapshots).toHaveLength(2);
    expect(after.rules.map((r) => r.status).sort()).toEqual(["STALE", "STALE"]);
  });

  it("detects a change in who a scheme is for, even when the texts are identical", async () => {
    const source = sourceWith("a");
    await syncCatalogue({ source, clock: DAY1 });

    source.facets.set("a", { caste: ["Scheduled Caste (SC)"] });
    const summary = await syncCatalogue({ source, clock: DAY2 });

    expect(summary.changed).toBe(1);
    expect((await row("a")).facets).toEqual({ caste: ["Scheduled Caste (SC)"] });
  });

  it("keeps what it knew when one scheme's detail fails, and reports the run as PARTIAL", async () => {
    const source = sourceWith("a", "b");
    await syncCatalogue({ source, clock: DAY1 });
    await addRule("a", "APPROVED");

    source.failDetailFor.add("a");
    const summary = await syncCatalogue({ source, clock: DAY2 });

    expect(summary).toMatchObject({ status: "PARTIAL", failed: 1, unchanged: 2, changed: 0 });
    const a = await row("a");
    expect(a.eligibilityMd).toBe("Eligibility for a.");
    // A fetch failure is not a change, so the approved rule stays usable.
    expect(a.rules[0].status).toBe("APPROVED");

    const run = await prisma.schemeSyncRun.findUniqueOrThrow({ where: { id: summary.runId } });
    expect(JSON.stringify(run.errors)).toContain("detail unavailable for a");
  });

  it("keeps stored facets for a filter the source could not read this time", async () => {
    const source = sourceWith("a");
    source.facets.set("a", { gender: ["Female"], isBpl: ["Yes"] });
    await syncCatalogue({ source, clock: DAY1 });

    // Tonight the BPL filter failed, so the source returns nothing for it.
    source.facets.set("a", { gender: ["Female"] });
    source.incompleteFacets = ["isBpl"];
    const summary = await syncCatalogue({ source, clock: DAY2 });

    expect(summary.unchanged).toBe(1);
    expect((await row("a")).facets).toEqual({ gender: ["Female"], isBpl: ["Yes"] });
  });

  it("keeps every stored facet when the facet step fails entirely", async () => {
    const source = sourceWith("a");
    source.facets.set("a", { gender: ["Female"] });
    await syncCatalogue({ source, clock: DAY1 });

    source.failFacets = true;
    const summary = await syncCatalogue({ source, clock: DAY2 });

    expect(summary).toMatchObject({ unchanged: 1, changed: 0 });
    expect((await row("a")).facets).toEqual({ gender: ["Female"] });
  });

  it("withdraws a scheme only after it is missing from two full syncs, and restores it if it returns", async () => {
    const source = sourceWith("a", "b", "c");
    await syncCatalogue({ source, clock: DAY1 });

    source.remove("c");
    const first = await syncCatalogue({ source, clock: DAY2 });
    expect(first.withdrawn).toBe(0);
    expect(await row("c")).toMatchObject({ status: "ACTIVE", missingSyncCount: 1 });

    const second = await syncCatalogue({ source, clock: DAY3 });
    expect(second.withdrawn).toBe(1);
    const withdrawn = await row("c");
    expect(withdrawn.status).toBe("WITHDRAWN");
    expect(withdrawn.withdrawnAt?.toISOString()).toBe("2026-10-14T21:00:00.000Z");

    // Withdrawn is marked, never deleted - citizens may still be receiving it.
    source.add({ listing: listing("c"), english: { eligibilityMd: "Eligibility for c.", benefitsMd: "Benefits of c." }, hindi: { name: "योजना c", eligibilityMd: "c के लिए पात्रता।" } });
    await syncCatalogue({ source, clock: DAY3 });
    expect(await row("c")).toMatchObject({ status: "ACTIVE", missingSyncCount: 0, withdrawnAt: null });
  });

  it("does not count a single absence when the scheme comes back the next night", async () => {
    const source = sourceWith("a", "b", "c");
    await syncCatalogue({ source, clock: DAY1 });

    const c = source.schemes.get("c")!;
    source.remove("c");
    await syncCatalogue({ source, clock: DAY2 });
    source.add(c);
    await syncCatalogue({ source, clock: DAY3 });

    expect(await row("c")).toMatchObject({ status: "ACTIVE", missingSyncCount: 0 });
  });

  it("treats a listing that shrinks by more than half as a source failure and changes nothing", async () => {
    const source = sourceWith("a", "b", "c", "d", "e");
    await syncCatalogue({ source, clock: DAY1 });

    for (const id of ["b", "c", "d", "e"]) source.remove(id);
    const summary = await syncCatalogue({ source, clock: DAY2 });
    await syncCatalogue({ source, clock: DAY3 });

    expect(summary.status).toBe("FAILED");
    expect(summary.note).toMatch(/shrank by more than half/);
    const statuses = await prisma.catalogScheme.findMany({ select: { status: true, missingSyncCount: true } });
    expect(statuses.every((s) => s.status === "ACTIVE" && s.missingSyncCount === 0)).toBe(true);
  });

  it("records a FAILED run and touches nothing when the listing cannot be read", async () => {
    const source = sourceWith("a");
    await syncCatalogue({ source, clock: DAY1 });

    source.failListing = true;
    const summary = await syncCatalogue({ source, clock: DAY2 });

    expect(summary.status).toBe("FAILED");
    expect((await row("a")).lastFetchedAt.toISOString()).toBe("2026-10-12T21:00:00.000Z");
  });

  it("never withdraws anything during a limited run", async () => {
    const source = sourceWith("a", "b", "c");
    await syncCatalogue({ source, clock: DAY1 });

    await syncCatalogue({ source, clock: DAY2, limit: 1 });
    await syncCatalogue({ source, clock: DAY3, limit: 1 });

    expect(await row("c")).toMatchObject({ status: "ACTIVE", missingSyncCount: 0 });
  });

  it("flags a change to a scheme linked to a tracked registry scheme", async () => {
    const source = sourceWith("a");
    await syncCatalogue({ source, clock: DAY1 });
    await prisma.catalogScheme.update({
      where: { source_externalId: { source: "fake", externalId: "a" } },
      data: { trackedSchemeCode: "NSAP-IGNDPS" },
    });

    source.schemes.get("a")!.english.benefitsMd = "Benefits of a, revised.";
    const summary = await syncCatalogue({ source, clock: DAY2 });

    const run = await prisma.schemeSyncRun.findUniqueOrThrow({ where: { id: summary.runId } });
    expect(JSON.stringify(run.errors)).toContain("tracked scheme NSAP-IGNDPS");
  });
});
