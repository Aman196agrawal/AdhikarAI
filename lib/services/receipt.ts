/**
 * Receipt confirmation.
 *
 * The signature interaction of the whole product, and the simplest screen in
 * it: "₹200 was reported as released for your pension. Did you receive it?"
 * with three buttons.
 *
 * All three answers are first-class:
 *
 *   YES      the citizen's own account. Recorded as CITIZEN_CONFIRMED, not as
 *            verified - their recollection is evidence, not proof.
 *   NO       a payment discrepancy, with the amount proven absent.
 *   NOT SURE an entirely legitimate answer, and the common one. It records
 *            DISBURSED_RECEIPT_UNVERIFIED and offers to check a bank
 *            statement. It must never be coerced into a yes or a no.
 *
 * The reason NOT SURE matters so much: the people this product is for often
 * genuinely cannot tell whether a transfer arrived. A system that forced a
 * binary answer would manufacture false data from the users it most needs to
 * serve.
 */

import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/http";
import type { Clock } from "@/lib/clock";
import { paise, type Paise } from "@/lib/engine/money";
import { reconcile } from "@/lib/engine/reconciler";
import { stateForReceipt } from "@/lib/engine/stateMachine";
import { log } from "@/lib/log";
import type { CitizenReport } from "@/lib/generated/prisma/enums";
import { recordAudit, transitionEntitlement, type Actor } from "./transitions";

export interface ConfirmReceiptResult {
  paymentId: string;
  receiptState: string;
  /** Proven absent. Zero unless there is evidence of absence. */
  gapAmount: Paise;
  /** Released but unconfirmed. */
  unverifiedAmount: Paise;
  reasons: string[];
  /** Offered when the answer leaves the receipt unverified. */
  offerBankVerification: boolean;
  nextStep: string;
}

/**
 * Record the citizen's answer about a payment.
 *
 * Reconciliation is done by the engine; this service gathers the facts,
 * persists the verification, and moves the lifecycle. It never decides the
 * receipt state itself.
 */
export async function confirmReceipt(input: {
  citizenId: string;
  paymentId: string;
  answer: CitizenReport;
  clock: Clock;
  note?: string;
}): Promise<ConfirmReceiptResult> {
  const actor: Actor = { kind: "citizen", citizenId: input.citizenId };
  const now = input.clock.now();

  const payment = await prisma.payment.findFirstOrThrow({
    where: {
      id: input.paymentId,
      entitlement: { citizenId: input.citizenId },
    },
    include: {
      entitlement: { include: { scheme: true } },
      verifications: { orderBy: [{ verifiedAt: "desc" }, { id: "desc" }], take: 1 },
    },
  });

  const expected =
    payment.entitlement.expectedAmountPaise === null
      ? null
      : paise(payment.entitlement.expectedAmountPaise);

  // Any existing evidence stands; the citizen's answer is added to it rather
  // than replacing it. Bank evidence that already matched is not overturned
  // by a later "not sure".
  const existing = payment.verifications[0] ?? null;
  const evidence =
    existing && existing.evidenceResult !== "NOT_PROVIDED"
      ? {
          result: existing.evidenceResult,
          matchedAmount:
            existing.matchedAmountPaise === null
              ? null
              : paise(existing.matchedAmountPaise),
        }
      : null;

  const result = reconcile({
    expectedAmount: expected,
    governmentReportedAmount: paise(payment.reportedAmountPaise),
    citizenReport: input.answer,
    evidence,
  });

  await prisma.receiptVerification.create({
    data: {
      paymentId: payment.id,
      citizenReport: input.answer,
      evidenceResult: existing?.evidenceResult ?? "NOT_PROVIDED",
      method: evidence ? "BANK_EVIDENCE" : "CITIZEN_CONFIRMATION",
      expectedAmountPaise: expected ?? payment.reportedAmountPaise,
      matchedAmountPaise: existing?.matchedAmountPaise ?? null,
      matchedOn: existing?.matchedOn ?? null,
      refLast4: existing?.refLast4 ?? null,
      docSha256: existing?.docSha256 ?? null,
      resultState: result.receiptState,
      note: input.note,
      verifiedAt: now,
    },
  });

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      receiptState: result.receiptState,
      gapAmountPaise: result.gapAmount,
    },
  });

  await prisma.benefitLedger.updateMany({
    where: { entitlementId: payment.entitlementId },
    data: {
      receiptState: result.receiptState,
      gapAmountPaise: result.gapAmount,
      unverifiedAmountPaise: result.unverifiedAmount,
      receivedAmountPaise: result.receivedAmount,
      lastVerifiedAt: now,
    },
  });

  await recordAudit(prisma, {
    citizenId: input.citizenId,
    actor,
    entity: "Payment",
    entityId: payment.id,
    toState: result.receiptState,
    reason: `The citizen answered "${input.answer}" about the ${payment.periodLabel} payment. ${result.reasons[0] ?? ""}`.trim(),
  });

  // Move the benefit to match the new receipt state, where that is a legal
  // move. A discrepancy will be picked up as a gap by the next audit.
  const target = stateForReceipt(result.receiptState);
  try {
    await transitionEntitlement(prisma, {
      entitlementId: payment.entitlementId,
      citizenId: input.citizenId,
      to: target,
      actor,
      reason: result.reasons.join(" "),
      evidenceRef: payment.id,
    });
  } catch {
    // The benefit is somewhere the receipt state cannot be expressed from,
    // such as mid-recovery. The verification is still recorded, and the next
    // audit will reconcile the lifecycle. Swallowed deliberately: the
    // citizen's answer must never be lost to a workflow technicality.
    log.info("receipt.transition_skipped", {
      paymentId: payment.id,
      to: target,
    });
  }

  log.info("receipt.confirmed", {
    paymentId: payment.id,
    answer: input.answer,
    receiptState: result.receiptState,
  });

  const offerBankVerification =
    result.receiptState === "DISBURSED_RECEIPT_UNVERIFIED" ||
    result.receiptState === "PAYMENT_DISCREPANCY";

  return {
    paymentId: payment.id,
    receiptState: result.receiptState,
    gapAmount: result.gapAmount,
    unverifiedAmount: result.unverifiedAmount,
    reasons: result.reasons,
    offerBankVerification,
    nextStep: nextStepFor(input.answer, result.receiptState),
  };
}

function nextStepFor(answer: CitizenReport, state: string): string {
  if (answer === "NO") {
    return "We will find out why this payment did not reach you, and show you what we propose to do before doing anything.";
  }
  if (answer === "NOT_SURE") {
    return "That is a perfectly normal answer. If you have a bank statement or passbook photo, we can check it for this one payment and nothing else.";
  }
  if (state === "VERIFIED_RECEIVED") {
    return "This payment is confirmed. We will keep watching for the next one.";
  }
  return "Thank you. We have recorded that you received this, and we will keep watching for the next payment.";
}

/** Payments awaiting an answer, for the dashboard and the verify screen. */
export async function paymentsAwaitingConfirmation(
  citizenId: string,
): Promise<
  Array<{
    paymentId: string;
    schemeName: string;
    periodLabel: string;
    reportedAmountPaise: bigint;
    reportedOn: Date;
  }>
> {
  const payments = await prisma.payment.findMany({
    where: {
      entitlement: { citizenId },
      receiptState: "DISBURSED_RECEIPT_UNVERIFIED",
    },
    include: {
      entitlement: { include: { scheme: { select: { name: true } } } },
      verifications: { select: { citizenReport: true } },
    },
    orderBy: { reportedOn: "desc" },
  });

  return payments
    .filter((p) => p.verifications.every((v) => v.citizenReport === null))
    .map((p) => ({
      paymentId: p.id,
      schemeName: p.entitlement.scheme.name,
      periodLabel: p.periodLabel,
      reportedAmountPaise: p.reportedAmountPaise,
      reportedOn: p.reportedOn,
    }));
}
