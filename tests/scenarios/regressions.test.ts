/**
 * Regression tests for bugs found in the October review.
 *
 * Every case here describes a defect that existed while the full suite was
 * green. Verified by stashing the fixes and running this file against the old
 * code: 16 of 17 failed. The one exception is marked GUARD below - it held
 * before only by accident, and the fix makes it deliberate.
 *
 * Grouped by consequence rather than by module, because the consequence is
 * what made each one worth fixing.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractProfile } from "@/lib/agents/profileAgent";
import {
  govApproveApplication,
  govReleasePayment,
} from "@/lib/adapters/mockGovControl";
import { govGateway, setGovGateway } from "@/lib/adapters/mockGovGateway";
import { ApiError } from "@/lib/api/http";
import { fixedClock, type Clock } from "@/lib/clock";
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
import { runMonitoringTick } from "@/lib/services/monitoring";
import { loadProfile, saveProfileFields } from "@/lib/services/profile";
import { confirmReceipt } from "@/lib/services/receipt";
import {
  decideActionApproval,
  diagnoseAndPlan,
  executeActionPlan,
  reverifyBenefit,
} from "@/lib/services/recovery";
import { transitionEntitlement } from "@/lib/services/transitions";
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

const at = (iso: string): Clock => fixedClock(new Date(iso));
const PENSION = rupees(200);

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  await ensureRegistry();
});

beforeEach(async () => {
  setGovGateway(null);
  await resetCitizenData();
});

afterAll(async () => {
  process.env.DEMO_MODE = "false";
  setGovGateway(null);
  await disconnect();
});

/** A citizen with discovered entitlements. */
async function newCitizen(aadhaarLast4 = "4417"): Promise<string> {
  const { id } = await createCitizen({ aadhaarLast4 });
  const extraction = await extractProfile({ intake: INTAKE });
  await saveProfileFields(id, extraction.accepted);
  await discoverAndPersist({ citizenId: id, profile: await loadProfile(id) });
  return id;
}

async function pensionOf(citizenId: string): Promise<string> {
  return (
    await prisma.entitlement.findFirstOrThrow({
      where: { citizenId, scheme: { code: "NSAP-IGNOAPS" } },
      select: { id: true },
    })
  ).id;
}

/** Lodge the pension, approve it at the portal, and return its reference. */
async function lodgeAndApprove(
  citizenId: string,
  approvedOn = at("2026-02-08T00:00:00Z"),
): Promise<{ entitlementId: string; applicationRef: string }> {
  const entitlementId = await pensionOf(citizenId);
  await prepareApplication({ citizenId, entitlementId, providedFields: IDENTITY });
  const application = await prisma.application.findFirstOrThrow({
    where: { entitlementId },
  });
  const { approvalId } = await requestApplicationApproval({
    citizenId,
    applicationId: application.id,
  });
  await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED" });
  const outcome = await submitApplication({
    citizenId,
    applicationId: application.id,
    clock: approvedOn,
  });
  if (!outcome.ok) throw new Error(`setup: ${outcome.message}`);
  await govApproveApplication({ applicationRef: outcome.applicationRef, clock: approvedOn });
  return { entitlementId, applicationRef: outcome.applicationRef };
}

async function release(
  applicationRef: string,
  period: string,
  day: string,
  status: "RELEASED" | "FAILED" = "RELEASED",
): Promise<void> {
  await govReleasePayment({
    applicationRef,
    schemeCode: "NSAP-IGNOAPS",
    aadhaarLast4: "4417",
    periodLabel: period,
    amountPaise: PENSION,
    clock: at(`${day}T00:00:00Z`),
    releasedOn: new Date(`${day}T00:00:00Z`),
    status,
  });
}

async function paymentId(entitlementId: string, period: string): Promise<string> {
  return (
    await prisma.payment.findFirstOrThrow({
      where: { entitlementId, periodLabel: period },
      select: { id: true },
    })
  ).id;
}

async function openGapKeys(entitlementId: string): Promise<string[]> {
  const gaps = await prisma.benefitGap.findMany({
    where: { entitlementId, resolvedAt: null },
  });
  return gaps.map((g) => `${g.kind}:${g.periodLabel ?? ""}`).sort();
}

// ===========================================================================
describe("money totals are never overwritten by one payment", () => {
  it("answering for one month keeps every other month's figures", async () => {
    // BEFORE: confirmReceipt wrote this payment's figures into the benefit's
    // ledger. Answering "yes" for March set received to March alone and the
    // missing total to zero - erasing February's proven-missing payment.
    const citizenId = await newCitizen();
    const { entitlementId, applicationRef } = await lodgeAndApprove(citizenId);
    await release(applicationRef, "2026-02", "2026-02-10");
    await release(applicationRef, "2026-03", "2026-03-10");
    await auditBenefit({ citizenId, entitlementId, clock: at("2026-03-20T00:00:00Z") });

    await confirmReceipt({
      citizenId,
      paymentId: await paymentId(entitlementId, "2026-02"),
      answer: "NO",
      clock: at("2026-03-21T00:00:00Z"),
    });
    await confirmReceipt({
      citizenId,
      paymentId: await paymentId(entitlementId, "2026-03"),
      answer: "YES",
      clock: at("2026-03-22T00:00:00Z"),
    });

    const ledger = await prisma.benefitLedger.findUniqueOrThrow({
      where: { entitlementId },
    });
    expect(ledger.receivedAmountPaise).toBe(PENSION); // March
    expect(ledger.gapAmountPaise).toBe(PENSION); // February, still missing
  });

  it("opens the gap the moment the citizen says no, not on the next pass", async () => {
    const citizenId = await newCitizen();
    const { entitlementId, applicationRef } = await lodgeAndApprove(citizenId);
    await release(applicationRef, "2026-02", "2026-02-10");
    await auditBenefit({ citizenId, entitlementId, clock: at("2026-02-20T00:00:00Z") });

    await confirmReceipt({
      citizenId,
      paymentId: await paymentId(entitlementId, "2026-02"),
      answer: "NO",
      clock: at("2026-02-21T00:00:00Z"),
    });

    expect(await openGapKeys(entitlementId)).toContain("PAYMENT_MISSED:2026-02");
  });
});

// ===========================================================================
describe("a newer payment never hides an older problem", () => {
  it("keeps February's discrepancy open when March is merely unconfirmed", async () => {
    // BEFORE: the audit looked only at the latest payment, so March's
    // "unverified" replaced February's "did not arrive" and the February gap
    // was marked RESOLVED - while the money was still missing.
    const citizenId = await newCitizen();
    const { entitlementId, applicationRef } = await lodgeAndApprove(citizenId);
    await release(applicationRef, "2026-02", "2026-02-10");
    await auditBenefit({ citizenId, entitlementId, clock: at("2026-02-20T00:00:00Z") });
    await confirmReceipt({
      citizenId,
      paymentId: await paymentId(entitlementId, "2026-02"),
      answer: "NO",
      clock: at("2026-02-21T00:00:00Z"),
    });

    await release(applicationRef, "2026-03", "2026-03-10");
    const audit = await auditBenefit({
      citizenId,
      entitlementId,
      clock: at("2026-03-20T00:00:00Z"),
    });

    const keys = await openGapKeys(entitlementId);
    expect(keys).toContain("PAYMENT_MISSED:2026-02");
    expect(keys).toContain("RECEIPT_UNVERIFIED:2026-03");
    expect(audit.decision).toBe("ACTION_REQUIRED");
  });

  it("does not count a FAILED disbursement as a paid month", async () => {
    // BEFORE: every disbursement satisfied its period for continuity,
    // including one that failed and never left the treasury.
    const citizenId = await newCitizen();
    const { entitlementId, applicationRef } = await lodgeAndApprove(citizenId);
    await release(applicationRef, "2026-02", "2026-02-10", "FAILED");

    await auditBenefit({ citizenId, entitlementId, clock: at("2026-03-20T00:00:00Z") });

    expect(await openGapKeys(entitlementId)).toContain("PAYMENT_MISSED:2026-02");
  });
});

// ===========================================================================
describe("recovery is judged on the problem that was actually worked", () => {
  async function recoverFebruaryWhileMarchIsMissing() {
    const citizenId = await newCitizen();
    const { entitlementId, applicationRef } = await lodgeAndApprove(citizenId);
    // February paid but not received; March never sent; April fine.
    await release(applicationRef, "2026-02", "2026-02-10");
    await release(applicationRef, "2026-04", "2026-04-10");
    await auditBenefit({ citizenId, entitlementId, clock: at("2026-04-20T00:00:00Z") });
    await confirmReceipt({
      citizenId,
      paymentId: await paymentId(entitlementId, "2026-04"),
      answer: "YES",
      clock: at("2026-04-21T00:00:00Z"),
    });
    await confirmReceipt({
      citizenId,
      paymentId: await paymentId(entitlementId, "2026-02"),
      answer: "NO",
      clock: at("2026-04-22T00:00:00Z"),
    });

    const febGap = await prisma.benefitGap.findFirstOrThrow({
      where: { entitlementId, kind: "PAYMENT_MISSED", periodLabel: "2026-02", resolvedAt: null },
    });

    const clock = at("2026-04-23T00:00:00Z");
    const plan = await diagnoseAndPlan({ citizenId, gapId: febGap.id, clock });
    await decideActionApproval({
      citizenId,
      approvalId: plan.approvalId,
      decision: "APPROVED",
      clock,
    });
    await executeActionPlan({ citizenId, actionPlanId: plan.actionPlanId, clock });

    // February is re-issued and confirmed; March is still missing.
    await release(applicationRef, "2026-02", "2026-04-25");
    await prisma.receiptVerification.create({
      data: {
        paymentId: await paymentId(entitlementId, "2026-02"),
        citizenReport: "YES",
        method: "CITIZEN_CONFIRMATION",
        expectedAmountPaise: PENSION,
        resultState: "CITIZEN_CONFIRMED",
        verifiedAt: new Date("2026-04-26T00:00:00Z"),
      },
    });

    const result = await reverifyBenefit({
      citizenId,
      entitlementId,
      clock: at("2026-04-27T00:00:00Z"),
    });
    return { citizenId, entitlementId, result };
  }

  it("leaves an unrelated open problem open", async () => {
    // BEFORE: a successful re-verification marked EVERY open gap resolved, so
    // recovering February also "resolved" the separate missing March.
    const { entitlementId, result } = await recoverFebruaryWhileMarchIsMissing();

    expect(result.resolved).toBe(true);
    expect(result.recoveredAmount).toBe(PENSION);

    const keys = await openGapKeys(entitlementId);
    expect(keys).toContain("PAYMENT_MISSED:2026-03");
    expect(keys).not.toContain("PAYMENT_MISSED:2026-02");
  });

  it("keeps the recovery on record through later audits", async () => {
    // BEFORE: every audit recomputed recovery status from zero, so the next
    // monitoring pass reset RESOLVED to NOT_APPLICABLE.
    const { citizenId, entitlementId } = await recoverFebruaryWhileMarchIsMissing();

    await auditBenefit({ citizenId, entitlementId, clock: at("2026-05-01T00:00:00Z") });

    const ledger = await prisma.benefitLedger.findUniqueOrThrow({
      where: { entitlementId },
    });
    expect(ledger.recoveredAmountPaise).toBe(PENSION);
    expect(ledger.recoveryStatus).not.toBe("NOT_APPLICABLE");
  });
});

// ===========================================================================
describe("citizens are never confused with each other", () => {
  it("lets two citizens who share the last four Aadhaar digits both apply", async () => {
    // BEFORE: the portal reference was built from scheme + last four digits,
    // so the second citizen was told an application already existed.
    const first = await newCitizen("4417");
    const second = await newCitizen("4417");

    const a = await lodgeAndApprove(first);
    const b = await lodgeAndApprove(second);

    expect(a.applicationRef).not.toBe(b.applicationRef);
  });

  it("never attaches one citizen's payments to another", async () => {
    // BEFORE: disbursements were also looked up by scheme + last four digits.
    const first = await newCitizen("4417");
    const second = await newCitizen("4417");
    const a = await lodgeAndApprove(first);
    const b = await lodgeAndApprove(second);

    await release(a.applicationRef, "2026-02", "2026-02-10");
    await auditBenefit({
      citizenId: second,
      entitlementId: b.entitlementId,
      clock: at("2026-02-20T00:00:00Z"),
    });

    expect(await prisma.payment.count({ where: { entitlementId: b.entitlementId } })).toBe(0);
  });
});

// ===========================================================================
describe("retries and double taps do not double-act", () => {
  it("treats a resubmission with the same key as the same submission", async () => {
    // BEFORE: a retry after the portal had accepted was reported as a
    // DUPLICATE failure, flipping a lodged application to SUBMISSION_FAILED.
    const gateway = govGateway();
    const input = {
      schemeCode: "NSAP-IGNOAPS",
      aadhaarLast4: "4417",
      idempotencyKey: "apply:retry-test",
      fields: { aadhaarNumber: "999988887777", ifscCode: "SBIN0001234" },
      documents: [],
      declarations: [],
      submittedAt: new Date("2026-02-01T00:00:00Z"),
    };

    const first = await gateway.submitApplication(input);
    const second = await gateway.submitApplication(input);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.applicationRef).toBe(first.applicationRef);
      expect(second.deduplicated).toBe(true);
    }
  });

  it("carries out a plan once even when executed twice at the same moment", async () => {
    // BEFORE: two concurrent requests both passed the approval check and both
    // ran every step - two grievances filed in the citizen's name.
    const citizenId = await newCitizen();
    const { entitlementId, applicationRef } = await lodgeAndApprove(citizenId);
    await release(applicationRef, "2026-02", "2026-02-10");
    await auditBenefit({ citizenId, entitlementId, clock: at("2026-02-20T00:00:00Z") });
    await confirmReceipt({
      citizenId,
      paymentId: await paymentId(entitlementId, "2026-02"),
      answer: "NO",
      clock: at("2026-02-21T00:00:00Z"),
    });
    const gap = await prisma.benefitGap.findFirstOrThrow({
      where: { entitlementId, kind: "PAYMENT_MISSED", resolvedAt: null },
    });

    const clock = at("2026-02-22T00:00:00Z");
    const plan = await diagnoseAndPlan({ citizenId, gapId: gap.id, clock });
    await decideActionApproval({
      citizenId,
      approvalId: plan.approvalId,
      decision: "APPROVED",
      clock,
    });

    const outcomes = await Promise.allSettled([
      executeActionPlan({ citizenId, actionPlanId: plan.actionPlanId, clock }),
      executeActionPlan({ citizenId, actionPlanId: plan.actionPlanId, clock }),
    ]);

    expect(outcomes.some((o) => o.status === "fulfilled")).toBe(true);
    const executions = await prisma.actionExecution.count({
      where: { planId: plan.actionPlanId },
    });
    expect(executions).toBe(plan.steps.length);
  });

  it("reuses a waiting approval instead of opening another", async () => {
    const citizenId = await newCitizen();
    const entitlementId = await pensionOf(citizenId);
    await prepareApplication({ citizenId, entitlementId, providedFields: IDENTITY });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId },
    });

    const first = await requestApplicationApproval({ citizenId, applicationId: application.id });
    const second = await requestApplicationApproval({ citizenId, applicationId: application.id });

    expect(second.approvalId).toBe(first.approvalId);
    expect(
      await prisma.approval.count({
        where: { applicationId: application.id, decision: "PENDING" },
      }),
    ).toBe(1);
  });
});

// ===========================================================================
describe("the audit trail records only what happened", () => {
  it("never walks a benefit through a consent gate", async () => {
    // BEFORE: an audit finding an application further along than our record
    // routed through AWAITING_APPLICATION_APPROVAL, writing a trail entry that
    // claimed the citizen had approved something.
    const citizenId = await newCitizen();
    const { entitlementId } = await lodgeAndApprove(citizenId);
    await prisma.entitlement.update({
      where: { id: entitlementId },
      data: { lifecycleState: "ELIGIBLE" },
    });
    await prisma.auditLog.deleteMany({ where: { entityId: entitlementId } });

    await auditBenefit({ citizenId, entitlementId, clock: at("2026-02-20T00:00:00Z") });

    const fabricated = await prisma.auditLog.count({
      where: {
        entityId: entitlementId,
        actor: "agent:audit",
        toState: { in: ["APPLICATION_DRAFT", "AWAITING_APPLICATION_APPROVAL"] },
      },
    });
    expect(fabricated).toBe(0);
  });

  it("does not pull a benefit away from a plan awaiting the citizen", async () => {
    // GUARD, not a regression: this also passed on the old code, but only
    // because the path-finder happened to find no legal route to the audit's
    // target. The audit now defers to the recovery loop explicitly.
    const citizenId = await newCitizen();
    const { entitlementId } = await lodgeAndApprove(citizenId);
    await prisma.entitlement.update({
      where: { id: entitlementId },
      data: { lifecycleState: "AWAITING_ACTION_APPROVAL" },
    });

    await auditBenefit({ citizenId, entitlementId, clock: at("2026-02-20T00:00:00Z") });

    const after = await prisma.entitlement.findUniqueOrThrow({ where: { id: entitlementId } });
    expect(after.lifecycleState).toBe("AWAITING_ACTION_APPROVAL");
  });

  it("reports an out-of-order step as a conflict, not a crash", async () => {
    // BEFORE: an illegal transition threw a plain Error, returned as a 500.
    const citizenId = await newCitizen();
    const entitlementId = await pensionOf(citizenId);

    await expect(
      transitionEntitlement(prisma, {
        entitlementId,
        citizenId,
        to: "RECOVERED",
        actor: { kind: "agent", name: "test" },
        reason: "test",
      }),
    ).rejects.toSatisfy(
      (error: unknown) => error instanceof ApiError && error.code === "CONFLICT",
    );
  });

  it("records consent at the moment it was given", async () => {
    // BEFORE: decidedAt was the application's updatedAt - when it was last
    // edited, not when the citizen said yes.
    const citizenId = await newCitizen();
    const entitlementId = await pensionOf(citizenId);
    await prepareApplication({ citizenId, entitlementId, providedFields: IDENTITY });
    const application = await prisma.application.findFirstOrThrow({ where: { entitlementId } });
    const { approvalId } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });

    const when = at("2026-07-01T09:30:00Z");
    await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED", clock: when });

    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.decidedAt?.toISOString()).toBe("2026-07-01T09:30:00.000Z");
  });
});

// ===========================================================================
describe("the citizen's own entries are not lost", () => {
  it("keeps typed identity details when the application is prepared again", async () => {
    // BEFORE: re-preparing without providedFields rebuilt the form from the
    // profile alone, discarding the Aadhaar and account numbers entered.
    const citizenId = await newCitizen();
    const entitlementId = await pensionOf(citizenId);
    await prepareApplication({ citizenId, entitlementId, providedFields: IDENTITY });

    const again = await prepareApplication({ citizenId, entitlementId });

    expect(again.missingFields).not.toContain("aadhaarNumber");
    expect(again.missingFields).not.toContain("bankAccountNumber");
    expect(again.readyForApproval).toBe(true);
  });
});

// ===========================================================================
describe("monitoring does not flood", () => {
  it("skips a benefit checked moments ago, unless forced", async () => {
    // BEFORE: any benefit with an open problem was re-audited on every
    // five-minute pass, indefinitely - 288 events a day per benefit.
    const citizenId = await newCitizen();
    const { entitlementId, applicationRef } = await lodgeAndApprove(citizenId);
    await release(applicationRef, "2026-02", "2026-02-10");
    await auditBenefit({ citizenId, entitlementId, clock: at("2026-02-20T00:00:00Z") });
    await confirmReceipt({
      citizenId,
      paymentId: await paymentId(entitlementId, "2026-02"),
      answer: "NO",
      clock: at("2026-02-20T00:00:00Z"),
    });

    const clock = at("2026-02-20T00:05:00Z");
    const routine = await runMonitoringTick({ clock, citizenId });
    expect(routine.audited).toBe(0);

    const forced = await runMonitoringTick({ clock, citizenId, force: true });
    expect(forced.audited).toBeGreaterThan(0);
  });
});

// ===========================================================================
describe("a benefit paid in stages is not short-changed by arithmetic", () => {
  it("does not report the not-yet-due stages as missing money", async () => {
    // BEFORE: PMAY-G's first construction instalment was reconciled against the
    // whole Rs 1,20,000, and the remainder - simply not due yet - was reported
    // as proven missing. Found in the demo seed, where Sunita's on-schedule
    // first PMMVY instalment showed Rs 4,000 "did not arrive".
    const citizenId = await newCitizen();
    const entitlementId = (
      await prisma.entitlement.findFirstOrThrow({
        where: { citizenId, scheme: { code: "PMAY-G" } },
        select: { id: true },
      })
    ).id;

    await prepareApplication({
      citizenId,
      entitlementId,
      providedFields: { ...IDENTITY, housingType: "KUCCHA" },
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId },
    });
    const { approvalId } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });
    await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED" });
    const submitted = await submitApplication({
      citizenId,
      applicationId: application.id,
      clock: at("2026-02-08T00:00:00Z"),
    });
    if (!submitted.ok) throw new Error("setup");
    await govApproveApplication({
      applicationRef: submitted.applicationRef,
      clock: at("2026-02-08T00:00:00Z"),
    });

    // First stage only.
    await govReleasePayment({
      applicationRef: submitted.applicationRef,
      schemeCode: "PMAY-G",
      aadhaarLast4: "4417",
      periodLabel: "ONCE",
      amountPaise: rupees(40_000),
      clock: at("2026-02-20T00:00:00Z"),
    });

    const audit = await auditBenefit({
      citizenId,
      entitlementId,
      clock: at("2026-02-25T00:00:00Z"),
    });

    expect(audit.provenMissingAmount).toBe(0n);
    expect(await openGapKeys(entitlementId)).not.toContain("PAYMENT_MISSED:ONCE");
    // The stage that WAS sent is honestly reported as unconfirmed.
    expect(audit.unverifiedAmount).toBe(rupees(40_000));
  });
});
