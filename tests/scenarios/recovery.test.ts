/**
 * Scenario 8: the full recovery loop, including a failure.
 *
 * This is the product thesis as an executable test:
 *
 *   gap -> diagnose -> plan -> approve -> act -> re-verify -> STILL BROKEN
 *       -> re-diagnose -> escalate -> approve -> act -> re-verify -> recovered
 *
 * The deliberate first failure is the point. A loop that succeeds on the first
 * attempt is indistinguishable from a pipeline, and the claim being made here
 * is that this is a loop.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractProfile } from "@/lib/agents/profileAgent";
import {
  govApproveApplication,
  govFailPaymentOnSeeding,
  govReleasePayment,
} from "@/lib/adapters/mockGovControl";
import { setGovGateway } from "@/lib/adapters/mockGovGateway";
import {
  createMockGrievanceProvider,
  setGrievanceProvider,
} from "@/lib/adapters/grievance";
import { fixedClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { rupees, ZERO } from "@/lib/engine/money";
import {
  decideApplicationApproval,
  prepareApplication,
  requestApplicationApproval,
  submitApplication,
} from "@/lib/services/application";
import { auditBenefit } from "@/lib/services/audit";
import { discoverAndPersist } from "@/lib/services/discovery";
import { loadProfile, saveProfileFields } from "@/lib/services/profile";
import {
  decideActionApproval,
  diagnoseAndPlan,
  executeActionPlan,
  reverifyBenefit,
} from "@/lib/services/recovery";
import {
  createCitizen,
  disconnect,
  ensureRegistry,
  resetCitizenData,
} from "../helpers/db";

const KAMALA_INTAKE = `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`;

const IDENTITY_FIELDS = {
  aadhaarNumber: "999988887777",
  fullName: "Kamala Devi",
  dateOfBirth: "1959-04-12",
  district: "Gaya",
  bplCardNumber: "BR-PHH-00241",
  bankAccountNumber: "30124578821",
  ifscCode: "SBIN0001234",
};

const CLOCK = fixedClock(new Date("2026-06-15T10:00:00.000Z"));
const PENSION = rupees(200);
const PERIOD = "2026-06";

let citizenId: string;
let aadhaarLast4: string;
let entitlementId: string;
let applicationRef: string;

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  await ensureRegistry();
});

/**
 * Drive the benefit to a confirmed payment discrepancy: the government says
 * it released the pension, the bank returned it over Aadhaar seeding, and the
 * citizen confirms she never received it.
 */
async function setUpDiscrepancy(): Promise<string> {
  const extraction = await extractProfile({ intake: KAMALA_INTAKE });
  await saveProfileFields(citizenId, extraction.accepted, {
    rawIntake: KAMALA_INTAKE,
  });
  await discoverAndPersist({ citizenId, profile: await loadProfile(citizenId) });

  entitlementId = (
    await prisma.entitlement.findFirstOrThrow({
      where: { citizenId, scheme: { code: "NSAP-IGNOAPS" } },
      select: { id: true },
    })
  ).id;

  await prepareApplication({
    citizenId,
    entitlementId,
    providedFields: IDENTITY_FIELDS,
  });
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
    clock: CLOCK,
  });
  if (!submission.ok) throw new Error("setup: submission failed");
  applicationRef = submission.applicationRef;

  await govApproveApplication({ applicationRef, clock: CLOCK });
  await govReleasePayment({
    applicationRef,
    schemeCode: "NSAP-IGNOAPS",
    aadhaarLast4,
    periodLabel: PERIOD,
    amountPaise: PENSION,
    clock: CLOCK,
  });
  // The bank returned the credit: the evidence the diagnosis will cite.
  await govFailPaymentOnSeeding({ applicationRef, periodLabel: PERIOD, clock: CLOCK });

  await auditBenefit({ citizenId, entitlementId, clock: CLOCK });

  const payment = await prisma.payment.findFirstOrThrow({
    where: { entitlementId, periodLabel: PERIOD },
  });
  await prisma.receiptVerification.create({
    data: {
      paymentId: payment.id,
      citizenReport: "NO",
      method: "CITIZEN_CONFIRMATION",
      expectedAmountPaise: PENSION,
      resultState: "PAYMENT_DISCREPANCY",
      verifiedAt: CLOCK.now(),
    },
  });

  const audit = await auditBenefit({ citizenId, entitlementId, clock: CLOCK });
  expect(audit.decision).toBe("ACTION_REQUIRED");

  const gap = await prisma.benefitGap.findFirstOrThrow({
    where: { entitlementId, kind: "PAYMENT_MISSED", resolvedAt: null },
  });
  return gap.id;
}

beforeEach(async () => {
  setGovGateway(null);
  setGrievanceProvider(null);
  await resetCitizenData();
  const citizen = await createCitizen();
  citizenId = citizen.id;
  aadhaarLast4 = citizen.aadhaarLast4;
});

afterAll(async () => {
  process.env.DEMO_MODE = "false";
  setGovGateway(null);
  setGrievanceProvider(null);
  await disconnect();
});

describe("diagnosis is grounded in evidence", () => {
  it("identifies the Aadhaar seeding failure from the government's own words", async () => {
    const gapId = await setUpDiscrepancy();
    const result = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });

    expect(result.rootCauseKind).toBe("AADHAAR_ISSUE");
    expect(result.rootCauseConfidence).toBeGreaterThan(0);
    // Confidence in an interpretation of prose is capped: it never reads as
    // a settled fact.
    expect(result.rootCauseConfidence).toBeLessThanOrEqual(0.85);

    const rootCause = await prisma.rootCause.findUniqueOrThrow({
      where: { id: result.rootCauseId },
    });
    const cited = rootCause.evidence as string[];
    expect(cited.length).toBeGreaterThan(0);
  });

  it("moves the benefit through diagnosis to awaiting approval", async () => {
    const gapId = await setUpDiscrepancy();
    await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.lifecycleState).toBe("AWAITING_ACTION_APPROVAL");

    // The trail shows the real path, not a jump to the end of it.
    const states = (
      await prisma.auditLog.findMany({
        where: { entityId: entitlementId },
        orderBy: { createdAt: "asc" },
      })
    ).map((l) => l.toState);
    expect(states).toContain("ROOT_CAUSE_IDENTIFIED");
    expect(states).toContain("ACTION_PLANNED");
    expect(states).toContain("AWAITING_ACTION_APPROVAL");
  });

  it("produces a plan with a checkable expected outcome", async () => {
    const gapId = await setUpDiscrepancy();
    const result = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });

    expect(result.steps.length).toBeGreaterThan(0);
    // Re-verification needs something specific to check; "resolved" would let
    // the loop declare victory by default.
    expect(result.expectedOutcome.length).toBeGreaterThan(20);
    expect(result.expectedOutcome).not.toMatch(/^the issue is resolved\.?$/i);
  });

  it("records what the citizen is shown at approval gate 2", async () => {
    const gapId = await setUpDiscrepancy();
    const result = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });

    const approval = await prisma.approval.findUniqueOrThrow({
      where: { id: result.approvalId },
    });
    const shown = approval.shownEvidence as Record<string, unknown>;

    // The problem, the evidence, the cause, the confidence and the proposed
    // steps - all of it, before consent.
    expect(shown.problem).toBe("PAYMENT_MISSED");
    expect(shown.rootCause).toBe("AADHAAR_ISSUE");
    expect(shown.rootCauseConfidence).toBeGreaterThan(0);
    expect(Array.isArray(shown.citedEvidence)).toBe(true);
    expect(Array.isArray(shown.steps)).toBe(true);
    expect(shown.isMockExecution).toBe(true);
  });
});

describe("approval gate 2 is a hard gate", () => {
  it("REFUSES to execute without an approval", async () => {
    const gapId = await setUpDiscrepancy();
    const { actionPlanId } = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });

    await expect(
      executeActionPlan({ citizenId, actionPlanId, clock: CLOCK }),
    ).rejects.toThrow(/not been approved/i);

    expect(await prisma.actionExecution.count()).toBe(0);
  });

  it("REFUSES to execute when the citizen declined", async () => {
    const gapId = await setUpDiscrepancy();
    const { actionPlanId, approvalId } = await diagnoseAndPlan({
      citizenId,
      gapId,
      clock: CLOCK,
    });
    await decideActionApproval({
      citizenId,
      approvalId,
      decision: "REJECTED",
      note: "I do not want a grievance filed in my name.",
      clock: CLOCK,
    });

    await expect(
      executeActionPlan({ citizenId, actionPlanId, clock: CLOCK }),
    ).rejects.toThrow(/not been approved/i);
    expect(await prisma.actionExecution.count()).toBe(0);
  });

  it("keeps the gap open when the citizen declines", async () => {
    // Declining one approach does not mean the problem has gone away.
    const gapId = await setUpDiscrepancy();
    const { approvalId } = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });
    await decideActionApproval({
      citizenId,
      approvalId,
      decision: "REJECTED",
      clock: CLOCK,
    });

    const gap = await prisma.benefitGap.findUniqueOrThrow({ where: { id: gapId } });
    expect(gap.resolvedAt).toBeNull();

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.lifecycleState).toBe("ACTION_PLANNED");
  });
});

describe("execution", () => {
  it("runs the approved steps and records each one", async () => {
    const gapId = await setUpDiscrepancy();
    const { actionPlanId, approvalId } = await diagnoseAndPlan({
      citizenId,
      gapId,
      clock: CLOCK,
    });
    await decideActionApproval({ citizenId, approvalId, decision: "APPROVED", clock: CLOCK });

    const outcome = await executeActionPlan({ citizenId, actionPlanId, clock: CLOCK });

    expect(outcome.executed.length).toBeGreaterThan(0);
    const executions = await prisma.actionExecution.findMany({
      where: { planId: actionPlanId },
    });
    expect(executions.length).toBe(outcome.executed.length);
    for (const execution of executions) {
      expect(execution.idempotencyKey).toMatch(/^act:/);
      expect(execution.finishedAt).not.toBeNull();
    }
  });

  it("is idempotent: re-running does not repeat a completed step", async () => {
    const gapId = await setUpDiscrepancy();
    const { actionPlanId, approvalId } = await diagnoseAndPlan({
      citizenId,
      gapId,
      clock: CLOCK,
    });
    await decideActionApproval({ citizenId, approvalId, decision: "APPROVED", clock: CLOCK });

    await executeActionPlan({ citizenId, actionPlanId, clock: CLOCK });
    const countAfterFirst = await prisma.actionExecution.count({
      where: { planId: actionPlanId },
    });

    const second = await executeActionPlan({ citizenId, actionPlanId, clock: CLOCK });

    expect(
      await prisma.actionExecution.count({ where: { planId: actionPlanId } }),
    ).toBe(countAfterFirst);
    expect(second.executed.some((e) => e.message.match(/not run again/i))).toBe(true);
  });

  it("leads only to re-verification, never straight to recovered", async () => {
    const gapId = await setUpDiscrepancy();
    const { actionPlanId, approvalId } = await diagnoseAndPlan({
      citizenId,
      gapId,
      clock: CLOCK,
    });
    await decideActionApproval({ citizenId, approvalId, decision: "APPROVED", clock: CLOCK });
    await executeActionPlan({ citizenId, actionPlanId, clock: CLOCK });

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.lifecycleState).toBe("ACTION_EXECUTED");
    expect(entitlement.lifecycleState).not.toBe("RECOVERED");
  });
});

describe("re-verification does not trust success", () => {
  it("reports UNRESOLVED when the action ran but the money still has not arrived", async () => {
    // The whole point. Every step succeeded; nothing was fixed.
    const gapId = await setUpDiscrepancy();
    const { actionPlanId, approvalId } = await diagnoseAndPlan({
      citizenId,
      gapId,
      clock: CLOCK,
    });
    await decideActionApproval({ citizenId, approvalId, decision: "APPROVED", clock: CLOCK });
    const execution = await executeActionPlan({ citizenId, actionPlanId, clock: CLOCK });
    expect(execution.allSucceeded).toBe(true);

    const result = await reverifyBenefit({ citizenId, entitlementId, clock: CLOCK });

    expect(result.resolved).toBe(false);
    expect(result.recoveredAmount).toBe(ZERO);
    expect(result.nextStep).toMatch(/diagnosed again/i);

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.lifecycleState).toBe("RE_AUDIT_REQUIRED");

    const ledger = await prisma.benefitLedger.findUniqueOrThrow({
      where: { entitlementId },
    });
    expect(ledger.recoveryStatus).toBe("UNRESOLVED");
    expect(ledger.recoveredAmountPaise).toBe(0n);
  });
});

describe("the loop closes", () => {
  it("re-diagnoses, escalates, and does not repeat what already failed", async () => {
    const gapId = await setUpDiscrepancy();

    // Attempt 1
    const first = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });
    await decideActionApproval({
      citizenId,
      approvalId: first.approvalId,
      decision: "APPROVED",
      clock: CLOCK,
    });
    await executeActionPlan({
      citizenId,
      actionPlanId: first.actionPlanId,
      clock: CLOCK,
    });
    const firstOutcome = await reverifyBenefit({ citizenId, entitlementId, clock: CLOCK });
    expect(firstOutcome.resolved).toBe(false);

    const firstActions = first.steps.map((s) => s.kind);

    // Attempt 2, from RE_AUDIT_REQUIRED
    const second = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });

    expect(second.attempt).toBe(2);
    // Nothing that already failed is proposed again.
    for (const step of second.steps) {
      expect(firstActions, `repeated ${step.kind}`).not.toContain(step.kind);
    }
    // With every earlier approach exhausted, the honest next move is to
    // escalate to a human rather than keep trying.
    expect(second.steps.map((s) => s.kind)).toContain("ESCALATE_GRIEVANCE");
    expect(second.adjusted).toMatch(/already been tried|escalated/i);

    // The earlier plan is superseded, so only one is live.
    const plans = await prisma.actionPlan.findMany({ where: { gapId } });
    expect(plans.find((p) => p.id === first.actionPlanId)?.status).toBe("EXECUTED");
    expect(plans.find((p) => p.id === second.actionPlanId)?.status).toBe(
      "AWAITING_APPROVAL",
    );
  });

  it("recovers the benefit and records the amount once the money arrives", async () => {
    const gapId = await setUpDiscrepancy();

    // Attempt 1 fails.
    const first = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });
    await decideActionApproval({
      citizenId,
      approvalId: first.approvalId,
      decision: "APPROVED",
      clock: CLOCK,
    });
    await executeActionPlan({ citizenId, actionPlanId: first.actionPlanId, clock: CLOCK });
    await reverifyBenefit({ citizenId, entitlementId, clock: CLOCK });

    // Attempt 2: escalate.
    const second = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });
    await decideActionApproval({
      citizenId,
      approvalId: second.approvalId,
      decision: "APPROVED",
      clock: CLOCK,
    });
    const escalation = await executeActionPlan({
      citizenId,
      actionPlanId: second.actionPlanId,
      clock: CLOCK,
    });
    expect(escalation.executed.some((e) => e.kind === "ESCALATE_GRIEVANCE")).toBe(true);

    // The escalation works: the department re-issues the payment and, a few
    // days later, the citizen confirms it arrived. The later timestamp matters
    // - this answer supersedes her earlier "no".
    const LATER = fixedClock(new Date("2026-06-28T10:00:00.000Z"));

    await govReleasePayment({
      applicationRef,
      schemeCode: "NSAP-IGNOAPS",
      aadhaarLast4,
      periodLabel: PERIOD,
      amountPaise: PENSION,
      clock: LATER,
    });
    const payment = await prisma.payment.findFirstOrThrow({
      where: { entitlementId, periodLabel: PERIOD },
    });
    await prisma.receiptVerification.create({
      data: {
        paymentId: payment.id,
        citizenReport: "YES",
        method: "CITIZEN_CONFIRMATION",
        expectedAmountPaise: PENSION,
        resultState: "CITIZEN_CONFIRMED",
        verifiedAt: LATER.now(),
      },
    });

    const result = await reverifyBenefit({ citizenId, entitlementId, clock: LATER });

    expect(result.resolved).toBe(true);
    expect(result.recoveredAmount).toBe(PENSION);

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlementId },
    });
    expect(entitlement.lifecycleState).toBe("RECOVERED");

    const ledger = await prisma.benefitLedger.findUniqueOrThrow({
      where: { entitlementId },
    });
    expect(ledger.recoveryStatus).toBe("RESOLVED");
    expect(ledger.recoveredAmountPaise).toBe(PENSION);
    expect(ledger.gapAmountPaise).toBe(0n);

    // The gap is closed, not deleted: the history of it remains.
    const gap = await prisma.benefitGap.findUniqueOrThrow({ where: { id: gapId } });
    expect(gap.resolvedAt).not.toBeNull();
  });

  it("leaves a complete audit trail of the whole loop", async () => {
    const gapId = await setUpDiscrepancy();

    const first = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });
    await decideActionApproval({
      citizenId,
      approvalId: first.approvalId,
      decision: "APPROVED",
      clock: CLOCK,
    });
    await executeActionPlan({ citizenId, actionPlanId: first.actionPlanId, clock: CLOCK });
    await reverifyBenefit({ citizenId, entitlementId, clock: CLOCK });

    const trail = await prisma.auditLog.findMany({
      where: { citizenId },
      orderBy: { createdAt: "asc" },
    });

    const states = trail.map((l) => l.toState);
    for (const expected of [
      "SUBMITTED",
      "GAP_DETECTED",
      "ROOT_CAUSE_IDENTIFIED",
      "ACTION_PLANNED",
      "AWAITING_ACTION_APPROVAL",
      "ACTION_EXECUTED",
      "REVERIFYING",
      "RE_AUDIT_REQUIRED",
    ]) {
      expect(states, `missing ${expected}`).toContain(expected);
    }

    // Every entry names who acted and why.
    for (const entry of trail) {
      expect(entry.actor).toMatch(/^(citizen|agent|cron|demo-console)/);
      expect(entry.reason.length).toBeGreaterThan(5);
    }

    // Both approvals are attributable to the citizen, not to the system.
    const approvals = trail.filter((l) => l.entity === "Approval");
    expect(approvals.length).toBeGreaterThan(0);
    for (const approval of approvals) {
      expect(approval.actor).toBe(`citizen:${citizenId}`);
    }
  });
});

describe("when the cause cannot be established", () => {
  it("records UNKNOWN and escalates rather than guessing", async () => {
    const gapId = await setUpDiscrepancy();

    // Remove the evidence that named Aadhaar seeding, leaving nothing to
    // diagnose from.
    await prisma.govStatusEvent.deleteMany({ where: { applicationRef } });
    await prisma.benefitGap.update({
      where: { id: gapId },
      data: { evidence: ["A payment did not arrive."] },
    });
    await prisma.auditFinding.deleteMany({});

    const result = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });

    expect(result.rootCauseKind).toBe("UNKNOWN");
    expect(result.rootCauseConfidence).toBe(0);
    // The only honest plan for an unidentified cause.
    expect(result.steps.map((s) => s.kind)).toEqual(["ESCALATE_GRIEVANCE"]);
  });
});

describe("adapter failures are reported, not swallowed", () => {
  it("marks a step RETRY_REQUIRED when the grievance channel is down", async () => {
    setGrievanceProvider(
      createMockGrievanceProvider({ failureMode: "unavailable" }),
    );

    const gapId = await setUpDiscrepancy();
    await prisma.govStatusEvent.deleteMany({ where: { applicationRef } });
    await prisma.auditFinding.deleteMany({});
    await prisma.benefitGap.update({
      where: { id: gapId },
      data: { evidence: ["A payment did not arrive."] },
    });

    const plan = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });
    await decideActionApproval({
      citizenId,
      approvalId: plan.approvalId,
      decision: "APPROVED",
      clock: CLOCK,
    });
    const outcome = await executeActionPlan({
      citizenId,
      actionPlanId: plan.actionPlanId,
      clock: CLOCK,
    });

    expect(outcome.allSucceeded).toBe(false);
    const failed = outcome.executed.find((e) => e.status !== "SUCCEEDED");
    expect(failed?.message).toMatch(/did not respond/i);

    const stored = await prisma.actionPlan.findUniqueOrThrow({
      where: { id: plan.actionPlanId },
    });
    expect(stored.status).toBe("FAILED");
  });
});
