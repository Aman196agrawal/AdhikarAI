/**
 * Scenarios: application, approval gate 1, submission and the benefit audit.
 *
 * Covers design scenarios 1 (healthy), 2 (needs verification), 3 (payment
 * discrepancy), 4 (rejected), 5 (stalled) and 6 (never applied), plus the
 * approval gate and submission failure handling.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractProfile } from "@/lib/agents/profileAgent";
import {
  govApproveApplication,
  govRejectApplication,
  govReleasePayment,
  govReturnForDocument,
  govSkipPayment,
  govStallApplication,
} from "@/lib/adapters/mockGovControl";
import { createMockGovGateway, setGovGateway } from "@/lib/adapters/mockGovGateway";
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
import { loadProfile, recordCitizenAnswer, saveProfileFields } from "@/lib/services/profile";
import {
  createCitizen,
  disconnect,
  ensureRegistry,
  resetCitizenData,
} from "../helpers/db";

const KAMALA_INTAKE = `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`;

/**
 * Values the citizen supplies at the approval screen.
 *
 * Identity numbers are deliberately never extracted from conversation, and
 * `district` is simply not something this intake mentions - so both are
 * legitimately reported as required and typed by the citizen.
 */
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

let citizenId: string;
let aadhaarLast4: string;
let ignoapsId: string;

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

  const extraction = await extractProfile({ intake: KAMALA_INTAKE });
  await saveProfileFields(citizenId, extraction.accepted, {
    rawIntake: KAMALA_INTAKE,
  });
  const profile = await loadProfile(citizenId);
  await discoverAndPersist({ citizenId, profile });

  ignoapsId = (
    await prisma.entitlement.findFirstOrThrow({
      where: { citizenId, scheme: { code: "NSAP-IGNOAPS" } },
      select: { id: true },
    })
  ).id;
});

afterAll(async () => {
  process.env.DEMO_MODE = "false";
  setGovGateway(null);
  await disconnect();
});

/** Walk an entitlement from eligible to submitted. */
async function submitFor(entitlementId: string): Promise<string> {
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
  await decideApplicationApproval({
    citizenId,
    approvalId,
    decision: "APPROVED",
  });
  const outcome = await submitApplication({
    citizenId,
    applicationId: application.id,
    clock: CLOCK,
  });
  if (!outcome.ok) throw new Error(`submission failed: ${outcome.message}`);
  return outcome.applicationRef;
}

describe("preparing an application", () => {
  it("prefills from the profile and reports what is still required", async () => {
    const prepared = await prepareApplication({ citizenId, entitlementId: ignoapsId });

    const state = prepared.fields.find((f) => f.key === "state");
    expect(state?.value).toBe("Bihar");
    expect(state?.source).toBe("PREFILLED_FROM_PROFILE");

    // Identity numbers are never extracted from conversation, so they are
    // reported as required for the citizen to type at the approval screen.
    expect(prepared.missingFields).toContain("aadhaarNumber");
    expect(prepared.missingFields).toContain("bankAccountNumber");
    expect(prepared.readyForApproval).toBe(false);
  });

  it("becomes ready once the citizen supplies the identity fields", async () => {
    const prepared = await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: IDENTITY_FIELDS,
    });
    expect(prepared.missingFields).toEqual([]);
    expect(prepared.readyForApproval).toBe(true);
  });

  it("validates field formats", async () => {
    const prepared = await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: { ...IDENTITY_FIELDS, ifscCode: "NOTANIFSC" },
    });
    const ifsc = prepared.fields.find((f) => f.key === "ifscCode");
    expect(ifsc?.valid).toBe(false);
    expect(prepared.readyForApproval).toBe(false);
  });

  it("refuses to prepare an application for an excluded scheme", async () => {
    const pmmvy = await prisma.entitlement.findFirstOrThrow({
      where: { citizenId, scheme: { code: "PMMVY" } },
    });
    await expect(
      prepareApplication({ citizenId, entitlementId: pmmvy.id }),
    ).rejects.toThrow(/does not apply/i);
  });

  it("lists required documents the citizen does not have", async () => {
    const prepared = await prepareApplication({ citizenId, entitlementId: ignoapsId });
    expect(prepared.missingDocuments).toContain("AADHAAR");
  });

  it("is idempotent, not creating a second draft", async () => {
    await prepareApplication({ citizenId, entitlementId: ignoapsId });
    await prepareApplication({ citizenId, entitlementId: ignoapsId });
    expect(
      await prisma.application.count({ where: { entitlementId: ignoapsId } }),
    ).toBe(1);
  });

  it("moves the entitlement to APPLICATION_DRAFT", async () => {
    await prepareApplication({ citizenId, entitlementId: ignoapsId });
    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: ignoapsId },
    });
    expect(entitlement.lifecycleState).toBe("APPLICATION_DRAFT");
  });
});

describe("approval gate 1 is a hard gate", () => {
  it("REFUSES to submit without an approval", async () => {
    // The single most important assertion about consent in this system.
    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: IDENTITY_FIELDS,
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });

    await expect(
      submitApplication({ citizenId, applicationId: application.id, clock: CLOCK }),
    ).rejects.toThrow(/not been approved/i);

    // And nothing reached the portal.
    expect(await prisma.govApplication.count()).toBe(0);
  });

  it("REFUSES to submit when the citizen declined", async () => {
    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: IDENTITY_FIELDS,
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    const { approvalId } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });
    await decideApplicationApproval({
      citizenId,
      approvalId,
      decision: "REJECTED",
      note: "I want to check with my son first.",
    });

    await expect(
      submitApplication({ citizenId, applicationId: application.id, clock: CLOCK }),
    ).rejects.toThrow(/not been approved/i);
    expect(await prisma.govApplication.count()).toBe(0);
  });

  it("returns a declined application to draft so it can be revisited", async () => {
    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: IDENTITY_FIELDS,
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    const { approvalId } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });
    await decideApplicationApproval({ citizenId, approvalId, decision: "REJECTED" });

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: ignoapsId },
    });
    expect(entitlement.lifecycleState).toBe("APPLICATION_DRAFT");
  });

  it("records what the citizen was shown at the moment of approval", async () => {
    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: IDENTITY_FIELDS,
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    const { shownEvidence } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });

    expect(shownEvidence.schemeCode).toBe("NSAP-IGNOAPS");
    expect(shownEvidence.isMockSubmission).toBe(true);
    expect(String(shownEvidence.governmentTarget)).toMatch(/SIMULATED/i);
  });

  it("does NOT copy identity numbers into the approval snapshot", async () => {
    // The snapshot is an audit record that outlives the application; copying
    // an Aadhaar or account number into it would duplicate sensitive data
    // with no purpose.
    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: IDENTITY_FIELDS,
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    const { shownEvidence } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });

    const serialised = JSON.stringify(shownEvidence);
    expect(serialised).not.toContain(IDENTITY_FIELDS.aadhaarNumber);
    expect(serialised).not.toContain(IDENTITY_FIELDS.bankAccountNumber);
  });

  it("refuses to open the gate while fields are invalid", async () => {
    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: { ...IDENTITY_FIELDS, ifscCode: "BAD" },
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    await expect(
      requestApplicationApproval({ citizenId, applicationId: application.id }),
    ).rejects.toThrow(/need correcting/i);
  });

  it("cannot be decided twice", async () => {
    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: IDENTITY_FIELDS,
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    const { approvalId } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });
    await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED" });

    await expect(
      decideApplicationApproval({ citizenId, approvalId, decision: "REJECTED" }),
    ).rejects.toThrow(/already approved/i);
  });
});

describe("submission", () => {
  it("lodges an approved application and records the reference", async () => {
    const ref = await submitFor(ignoapsId);
    expect(ref).toMatch(/^GOVAPP/);

    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    expect(application.status).toBe("SUBMITTED");
    expect(application.govApplicationRef).toBe(ref);

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: ignoapsId },
    });
    expect(entitlement.lifecycleState).toBe("SUBMITTED");
  });

  it("is idempotent: a repeat submission does not lodge a second claim", async () => {
    const ref = await submitFor(ignoapsId);
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });

    const again = await submitApplication({
      citizenId,
      applicationId: application.id,
      clock: CLOCK,
    });

    expect(again.ok).toBe(true);
    if (again.ok) expect(again.applicationRef).toBe(ref);
    expect(await prisma.govApplication.count()).toBe(1);
  });

  it("records a portal outage as a failure, never as a submission", async () => {
    setGovGateway(createMockGovGateway({ failureMode: "unavailable" }));

    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: IDENTITY_FIELDS,
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    const { approvalId } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });
    await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED" });

    const outcome = await submitApplication({
      citizenId,
      applicationId: application.id,
      clock: CLOCK,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("PORTAL_UNAVAILABLE");
      expect(outcome.retryable).toBe(true);
    }

    const after = await prisma.application.findUniqueOrThrow({
      where: { id: application.id },
    });
    expect(after.status).toBe("SUBMISSION_FAILED");
    expect(after.govApplicationRef).toBeNull();

    // The entitlement must NOT look submitted.
    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: ignoapsId },
    });
    expect(entitlement.lifecycleState).not.toBe("SUBMITTED");
  });

  it("reports a form rejection with the offending fields", async () => {
    await prepareApplication({
      citizenId,
      entitlementId: ignoapsId,
      providedFields: { ...IDENTITY_FIELDS, aadhaarNumber: "999988887777" },
    });
    const application = await prisma.application.findFirstOrThrow({
      where: { entitlementId: ignoapsId },
    });
    // Corrupt the stored value past our own validation to exercise the
    // portal's independent check.
    await prisma.applicationField.updateMany({
      where: { applicationId: application.id, key: "ifscCode" },
      data: { value: "BADIFSC" },
    });

    const { approvalId } = await requestApplicationApproval({
      citizenId,
      applicationId: application.id,
    });
    await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED" });

    const outcome = await submitApplication({
      citizenId,
      applicationId: application.id,
      clock: CLOCK,
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("VALIDATION_REJECTED");
      expect(outcome.retryable).toBe(false);
      expect(outcome.fieldErrors?.map((e) => e.field)).toContain("ifscCode");
    }
  });
});

describe("audit: scenario 6, eligible but never applied", () => {
  it("reports NEVER_APPLIED and requires action, with no amount asserted", async () => {
    const ignwps = await prisma.entitlement.findFirstOrThrow({
      where: { citizenId, scheme: { code: "NSAP-IGNWPS" } },
    });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignwps.id,
      clock: CLOCK,
    });

    expect(result.decision).toBe("ACTION_REQUIRED");
    expect(result.gaps.map((g) => g.kind)).toContain("NEVER_APPLIED");
    // Foregone value is a projection, not money owed.
    expect(result.gaps[0].amount).toBeNull();
    expect(result.provenMissingAmount).toBe(ZERO);
  });
});

describe("audit: scenario 5, application stalled", () => {
  it("flags an application pending beyond the threshold", async () => {
    const ref = await submitFor(ignoapsId);
    await govStallApplication({ applicationRef: ref, daysPending: 94, clock: CLOCK });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignoapsId,
      clock: CLOCK,
    });

    expect(result.decision).toBe("ACTION_REQUIRED");
    expect(result.gaps.map((g) => g.kind)).toContain(
      "APPLICATION_PENDING_TOO_LONG",
    );
    expect(JSON.stringify(result.findings)).toMatch(/94 days/);
  });
});

describe("audit: scenario 4, rejected for a missing document", () => {
  it("records the rejection reason as citable evidence", async () => {
    const ref = await submitFor(ignoapsId);
    await govRejectApplication({
      applicationRef: ref,
      reason: "Income certificate was not attached.",
      clock: CLOCK,
    });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignoapsId,
      clock: CLOCK,
    });

    expect(result.decision).toBe("ACTION_REQUIRED");
    expect(result.gaps.map((g) => g.kind)).toContain("REJECTED");
    expect(JSON.stringify(result.gaps)).toMatch(/Income certificate/);
  });

  it("detects a return pending a document", async () => {
    const ref = await submitFor(ignoapsId);
    await govReturnForDocument({
      applicationRef: ref,
      documentKind: "INCOME_CERTIFICATE",
      clock: CLOCK,
    });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignoapsId,
      clock: CLOCK,
    });
    expect(result.gaps.map((g) => g.kind)).toContain("MISSING_DOCUMENT");
  });
});

describe("audit: scenario 2, government paid but receipt unconfirmed", () => {
  it("reports UNVERIFIED with NO amount missing", async () => {
    const ref = await submitFor(ignoapsId);
    await govApproveApplication({ applicationRef: ref, clock: CLOCK });
    await govReleasePayment({
      applicationRef: ref,
      schemeCode: "NSAP-IGNOAPS",
      aadhaarLast4,
      periodLabel: "2026-06",
      amountPaise: rupees(200),
      clock: CLOCK,
    });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignoapsId,
      clock: CLOCK,
    });

    expect(result.decision).toBe("NEEDS_VERIFICATION");
    expect(result.gaps.map((g) => g.kind)).toContain("RECEIPT_UNVERIFIED");

    // The load-bearing assertion.
    expect(result.provenMissingAmount).toBe(ZERO);
    expect(result.unverifiedAmount).toBe(rupees(200));

    const ledger = await prisma.benefitLedger.findUniqueOrThrow({
      where: { entitlementId: ignoapsId },
    });
    expect(ledger.gapAmountPaise).toBe(0n);
    expect(ledger.unverifiedAmountPaise).toBe(rupees(200));
    expect(ledger.receiptState).toBe("DISBURSED_RECEIPT_UNVERIFIED");
  });
});

describe("audit: scenario 1, healthy", () => {
  it("reports HEALTHY once the citizen confirms receipt", async () => {
    const ref = await submitFor(ignoapsId);
    await govApproveApplication({ applicationRef: ref, clock: CLOCK });
    await govReleasePayment({
      applicationRef: ref,
      schemeCode: "NSAP-IGNOAPS",
      aadhaarLast4,
      periodLabel: "2026-06",
      amountPaise: rupees(200),
      clock: CLOCK,
    });

    // First audit creates the payment row.
    await auditBenefit({ citizenId, entitlementId: ignoapsId, clock: CLOCK });

    const payment = await prisma.payment.findFirstOrThrow({
      where: { entitlementId: ignoapsId, periodLabel: "2026-06" },
    });
    await prisma.receiptVerification.create({
      data: {
        paymentId: payment.id,
        citizenReport: "YES",
        method: "CITIZEN_CONFIRMATION",
        expectedAmountPaise: rupees(200),
        resultState: "CITIZEN_CONFIRMED",
        verifiedAt: CLOCK.now(),
      },
    });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignoapsId,
      clock: CLOCK,
    });

    expect(result.decision).toBe("HEALTHY");
    expect(result.gaps).toEqual([]);
    expect(result.receivedAmount).toBe(rupees(200));
    expect(result.provenMissingAmount).toBe(ZERO);
  });
});

describe("audit: scenario 3, government says paid and the citizen did not receive it", () => {
  it("reports a PAYMENT_DISCREPANCY with the amount proven missing", async () => {
    const ref = await submitFor(ignoapsId);
    await govApproveApplication({ applicationRef: ref, clock: CLOCK });
    await govReleasePayment({
      applicationRef: ref,
      schemeCode: "NSAP-IGNOAPS",
      aadhaarLast4,
      periodLabel: "2026-06",
      amountPaise: rupees(200),
      clock: CLOCK,
    });

    await auditBenefit({ citizenId, entitlementId: ignoapsId, clock: CLOCK });

    const payment = await prisma.payment.findFirstOrThrow({
      where: { entitlementId: ignoapsId, periodLabel: "2026-06" },
    });
    await prisma.receiptVerification.create({
      data: {
        paymentId: payment.id,
        citizenReport: "NO",
        method: "CITIZEN_CONFIRMATION",
        expectedAmountPaise: rupees(200),
        resultState: "PAYMENT_DISCREPANCY",
        verifiedAt: CLOCK.now(),
      },
    });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignoapsId,
      clock: CLOCK,
    });

    expect(result.decision).toBe("ACTION_REQUIRED");
    expect(result.gaps.map((g) => g.kind)).toContain("PAYMENT_MISSED");
    expect(result.provenMissingAmount).toBe(rupees(200));
    expect(result.unverifiedAmount).toBe(ZERO);

    const entitlement = await prisma.entitlement.findUniqueOrThrow({
      where: { id: ignoapsId },
    });
    expect(entitlement.lifecycleState).toBe("GAP_DETECTED");
  });
});

describe("audit: scenario 7, a continuity gap mid-series", () => {
  it("detects the missing month without touching the paid ones", async () => {
    const ref = await submitFor(ignoapsId);
    // Approved back in February, so March to June are due by mid-June.
    await govApproveApplication({
      applicationRef: ref,
      clock: fixedClock(new Date("2026-02-10T00:00:00.000Z")),
    });

    for (const period of ["2026-02", "2026-03", "2026-04", "2026-05"]) {
      await govReleasePayment({
        applicationRef: ref,
        schemeCode: "NSAP-IGNOAPS",
        aadhaarLast4,
        periodLabel: period,
        amountPaise: rupees(200),
        clock: CLOCK,
        releasedOn: new Date(`${period}-10T00:00:00.000Z`),
      });
    }
    // April never arrived.
    await govSkipPayment({ applicationRef: ref, periodLabel: "2026-04" });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignoapsId,
      clock: CLOCK,
    });

    const continuity = result.findings.find((f) => f.area === "CONTINUITY");
    expect(continuity).toBeDefined();
    expect(JSON.stringify(continuity?.evidence)).toMatch(/2026-04/);
    expect(result.gaps.map((g) => g.kind)).toContain("PAYMENT_MISSED");
  });
});

describe("the audit never queries the government store directly", () => {
  it("surfaces that its government data is simulated", async () => {
    // Every finding sourced from the portal is labelled, so the UI cannot
    // present a simulated status as a real government record.
    const ref = await submitFor(ignoapsId);
    await govApproveApplication({ applicationRef: ref, clock: CLOCK });

    const result = await auditBenefit({
      citizenId,
      entitlementId: ignoapsId,
      clock: CLOCK,
    });

    expect(result.isMockData).toBe(true);
    expect(JSON.stringify(result.findings)).toMatch(/isMockData":true/);
    expect(JSON.stringify(result.findings)).toMatch(/simulated/i);
  });
});
