/**
 * Scenario: continuous monitoring.
 *
 * The claim being tested is that this system keeps watching. A pension that
 * arrives in January and stops in March is the failure the product exists to
 * catch, and nobody is going to notice it by logging in.
 *
 * Time is supplied explicitly here, exactly as the simulated clock supplies it
 * on stage. Advancing the clock changes nothing about the benefit data; the
 * real monitor simply runs over a later "now" and draws its own conclusions.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractProfile } from "@/lib/agents/profileAgent";
import {
  govApproveApplication,
  govReleasePayment,
} from "@/lib/adapters/mockGovControl";
import { setGovGateway } from "@/lib/adapters/mockGovGateway";
import { fixedClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { rupees } from "@/lib/engine/money";
import {
  decideApplicationApproval,
  prepareApplication,
  requestApplicationApproval,
  submitApplication,
} from "@/lib/services/application";
import { auditBenefit } from "@/lib/services/audit";
import { discoverAndPersist } from "@/lib/services/discovery";
import { findCandidates, runMonitoringTick } from "@/lib/services/monitoring";
import { loadProfile, saveProfileFields } from "@/lib/services/profile";
import {
  createCitizen,
  disconnect,
  ensureRegistry,
  resetCitizenData,
} from "../helpers/db";

const INTAKE = `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`;

const IDENTITY = {
  aadhaarNumber: "999988887777",
  fullName: "Kamala Devi",
  dateOfBirth: "1959-04-12",
  district: "Gaya",
  bplCardNumber: "BR-PHH-00241",
  bankAccountNumber: "30124578821",
  ifscCode: "SBIN0001234",
};

/** Approved in January; the first payment arrives and then nothing does. */
const APPROVED_ON = fixedClock(new Date("2026-01-10T00:00:00.000Z"));
const JANUARY = fixedClock(new Date("2026-01-20T00:00:00.000Z"));
/** Three months later, which is the demo's clock advance. */
const APRIL = fixedClock(new Date("2026-04-20T00:00:00.000Z"));

let citizenId: string;
let aadhaarLast4: string;
let entitlementId: string;

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  await ensureRegistry();
});

beforeEach(async () => {
  setGovGateway(null);
  await resetCitizenData();

  const citizen = await createCitizen();
  citizenId = citizen.id;
  aadhaarLast4 = citizen.aadhaarLast4;

  const extraction = await extractProfile({ intake: INTAKE });
  await saveProfileFields(citizenId, extraction.accepted);
  await discoverAndPersist({ citizenId, profile: await loadProfile(citizenId) });

  entitlementId = (
    await prisma.entitlement.findFirstOrThrow({
      where: { citizenId, scheme: { code: "NSAP-IGNOAPS" } },
      select: { id: true },
    })
  ).id;

  // Lodge, approve, and pay January only.
  await prepareApplication({ citizenId, entitlementId, providedFields: IDENTITY });
  const application = await prisma.application.findFirstOrThrow({
    where: { entitlementId },
  });
  const { approvalId } = await requestApplicationApproval({
    citizenId,
    applicationId: application.id,
  });
  await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED" });
  const submission = await submitApplication({
    citizenId,
    applicationId: application.id,
    clock: APPROVED_ON,
  });
  if (!submission.ok) throw new Error("setup: submission failed");

  await govApproveApplication({
    applicationRef: submission.applicationRef,
    clock: APPROVED_ON,
  });
  await govReleasePayment({
    applicationRef: submission.applicationRef,
    schemeCode: "NSAP-IGNOAPS",
    aadhaarLast4,
    periodLabel: "2026-01",
    amountPaise: rupees(200),
    clock: JANUARY,
    releasedOn: new Date("2026-01-12T00:00:00.000Z"),
  });

  // Audit in January: the schedule is materialised and everything is in order.
  await auditBenefit({ citizenId, entitlementId, clock: JANUARY });
});

afterAll(async () => {
  process.env.DEMO_MODE = "false";
  setGovGateway(null);
  await disconnect();
});

describe("in January, nothing is wrong", () => {
  it("raises no missed-payment candidate", async () => {
    const candidates = await findCandidates({
      clock: JANUARY,
      citizenId,
      limit: 25,
    });
    expect(candidates.filter((c) => c.kind === "PAYMENT_MISSED")).toEqual([]);
  });

  it("has materialised an expected schedule to reconcile against", async () => {
    const expected = await prisma.expectedPayment.count({
      where: { entitlementId },
    });
    expect(expected).toBeGreaterThan(0);
  });
});

describe("three months later, the monitor notices by itself", () => {
  it("selects the benefit for a fresh look", async () => {
    // The schedule only reached January when last audited, so the February
    // and March instalments do not exist yet to be "overdue". The benefit is
    // picked up because its audit has gone stale; that audit then extends the
    // schedule and finds the missing months (asserted below).
    //
    // This test used to assert a PAYMENT_MISSED candidate and passed - for the
    // wrong reason. The overdue query filtered on a relation nothing
    // populated, so it reported JANUARY, which had been paid.
    const candidates = await findCandidates({ clock: APRIL, citizenId, limit: 25 });

    const selected = candidates.find((c) => c.entitlementId === entitlementId);
    expect(selected).toBeDefined();
    // It records WHY, not merely that it looked.
    expect(selected?.reason.length).toBeGreaterThan(10);
  });

  it("never reports a PAID instalment as overdue", async () => {
    const candidates = await findCandidates({ clock: APRIL, citizenId, limit: 25 });
    const claims = candidates
      .filter((c) => c.kind === "PAYMENT_MISSED")
      .map((c) => c.payload.periodLabel);
    expect(claims).not.toContain("2026-01");
  });

  it("records a monitoring event and re-audits without being asked", async () => {
    const result = await runMonitoringTick({ clock: APRIL, citizenId });

    expect(result.audited).toBeGreaterThan(0);
    expect(result.actionRequired).toBeGreaterThan(0);

    const events = await prisma.monitoringEvent.findMany({ where: { citizenId } });
    expect(events.length).toBeGreaterThan(0);

    // Each event is linked to the audit it caused, so "why was this
    // re-checked?" has an answer.
    const processed = events.filter((e) => e.processedAt !== null);
    expect(processed.length).toBeGreaterThan(0);
    expect(processed[0].triggeredAuditId).not.toBeNull();
  });

  it("finds the missing months as a continuity gap", async () => {
    await runMonitoringTick({ clock: APRIL, citizenId });

    const gaps = await prisma.benefitGap.findMany({
      where: { entitlementId, resolvedAt: null },
    });

    const missed = gaps.filter((g) => g.kind === "PAYMENT_MISSED");
    expect(missed.length).toBeGreaterThan(0);
    // February and March were due and unpaid.
    const periods = missed.map((g) => g.periodLabel);
    expect(periods).toContain("2026-02");
    expect(periods).toContain("2026-03");
  });

  it("reports the interruption separately from a single miss", async () => {
    await runMonitoringTick({ clock: APRIL, citizenId });
    const gaps = await prisma.benefitGap.findMany({
      where: { entitlementId, resolvedAt: null },
    });
    expect(gaps.some((g) => g.kind === "PAYMENT_INTERRUPTED")).toBe(true);
  });

  it("does NOT count the January payment as missing", async () => {
    await runMonitoringTick({ clock: APRIL, citizenId });
    const gaps = await prisma.benefitGap.findMany({
      where: { entitlementId, resolvedAt: null, kind: "PAYMENT_MISSED" },
    });
    expect(gaps.map((g) => g.periodLabel)).not.toContain("2026-01");
  });
});

describe("the monitor is bounded and resumable", () => {
  it("processes at most the batch size and reports more remaining", async () => {
    // One citizen cannot fill a batch, so force a batch of one.
    const result = await runMonitoringTick({
      clock: APRIL,
      citizenId,
      batchSize: 1,
    });

    expect(result.audited).toBeLessThanOrEqual(1);
    expect(typeof result.moreRemaining).toBe("boolean");
  });

  it("is safe to run repeatedly without duplicating gaps", async () => {
    await runMonitoringTick({ clock: APRIL, citizenId });
    const first = await prisma.benefitGap.count({
      where: { entitlementId, resolvedAt: null },
    });

    await runMonitoringTick({ clock: APRIL, citizenId });
    await runMonitoringTick({ clock: APRIL, citizenId });

    const after = await prisma.benefitGap.count({
      where: { entitlementId, resolvedAt: null },
    });
    // Gaps are reconciled by identity, not re-inserted on every pass.
    expect(after).toBe(first);
  });

  it("keeps the diagnosis history across repeated passes", async () => {
    // This is what the earlier delete-and-recreate bug destroyed: the loop
    // needs to remember what has already been tried.
    await runMonitoringTick({ clock: APRIL, citizenId });

    const gap = await prisma.benefitGap.findFirstOrThrow({
      where: { entitlementId, resolvedAt: null },
    });
    await prisma.rootCause.create({
      data: {
        gapId: gap.id,
        attempt: 1,
        kind: "BANK_ISSUE",
        confidence: 0.6,
        evidence: ["test"],
        recommendedAction: "CORRECT_INFORMATION",
        reasoning: "test",
      },
    });

    await runMonitoringTick({ clock: APRIL, citizenId });

    const survived = await prisma.rootCause.count({ where: { gapId: gap.id } });
    expect(survived).toBe(1);
  });
});

describe("a resolved gap stops being reported", () => {
  it("marks it resolved once the payments appear, rather than deleting it", async () => {
    await runMonitoringTick({ clock: APRIL, citizenId });
    expect(
      await prisma.benefitGap.count({ where: { entitlementId, resolvedAt: null } }),
    ).toBeGreaterThan(0);

    // The department pays the arrears.
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId },
    });
    for (const [period, day] of [
      ["2026-02", "2026-04-18"],
      ["2026-03", "2026-04-18"],
      ["2026-04", "2026-04-18"],
    ] as const) {
      await govReleasePayment({
        applicationRef: application.govApplicationRef ?? "",
        schemeCode: "NSAP-IGNOAPS",
        aadhaarLast4,
        periodLabel: period,
        amountPaise: rupees(200),
        clock: APRIL,
        releasedOn: new Date(`${day}T00:00:00.000Z`),
      });
    }

    // Forced, as the demo console's manual pass is: the benefit was audited
    // moments ago, so a routine pass would rightly skip it.
    await runMonitoringTick({ clock: APRIL, citizenId, force: true });

    const stillMissing = await prisma.benefitGap.count({
      where: { entitlementId, resolvedAt: null, kind: "PAYMENT_MISSED" },
    });
    expect(stillMissing).toBe(0);

    // Kept on the record with a timestamp, not erased. What went wrong matters
    // even once it is fixed.
    const resolved = await prisma.benefitGap.count({
      where: { entitlementId, kind: "PAYMENT_MISSED", resolvedAt: { not: null } },
    });
    expect(resolved).toBeGreaterThan(0);
  });
});
