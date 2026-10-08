/**
 * Demo control over the simulated government portal.
 *
 * DEMO ONLY. These functions make the *government* do things: approve an
 * application, reject it, return it for a document, release a payment, or fail
 * one. They exist so the closed loop can be demonstrated in minutes rather
 * than over the months a real benefit cycle takes.
 *
 * This lives beside the mock gateway rather than in `lib/services` on purpose.
 * Control over the simulation is part of the simulation, and the boundary test
 * permits `gov_*` access only from `lib/adapters` - so putting it here keeps
 * that boundary honest instead of carving an exception into it.
 *
 * What makes the demo defensible: these write to the government's own store,
 * which the citizen-side code can only read through the gateway. A discrepancy
 * produced this way is a genuine disagreement between two separate stores,
 * reached by the same code path a real one would take. The only thing being
 * faked is the government's behaviour, and the UI says so.
 */

import { prisma } from "@/lib/db";
import type { Clock } from "@/lib/clock";
import { log } from "@/lib/log";
import type { Paise } from "@/lib/engine/money";
import type { GovDisbursementStatus } from "@/lib/generated/prisma/enums";

function disbursementRef(applicationRef: string, periodLabel: string): string {
  return `DBT${applicationRef.replace(/[^A-Z0-9]/g, "").slice(-8)}${periodLabel.replace(/[^0-9A-Z]/gi, "")}`;
}

/** The portal approves an application. */
export async function govApproveApplication(input: {
  applicationRef: string;
  clock: Clock;
  note?: string;
}): Promise<void> {
  const now = input.clock.now();

  const application = await prisma.govApplication.update({
    where: { applicationRef: input.applicationRef },
    data: { status: "APPROVED", decidedOn: now, pendingDocument: null },
  });

  await prisma.govStatusEvent.create({
    data: {
      applicationRef: input.applicationRef,
      schemeCode: application.schemeCode,
      status: "APPROVED",
      note: input.note ?? "Application approved after verification.",
      occurredOn: now,
    },
  });

  log.info("demo.gov.approved", { applicationRef: input.applicationRef });
}

/** The portal rejects an application, with a reason the diagnosis can cite. */
export async function govRejectApplication(input: {
  applicationRef: string;
  reason: string;
  clock: Clock;
}): Promise<void> {
  const now = input.clock.now();

  const application = await prisma.govApplication.update({
    where: { applicationRef: input.applicationRef },
    data: { status: "REJECTED", decidedOn: now, rejectionReason: input.reason },
  });

  await prisma.govStatusEvent.create({
    data: {
      applicationRef: input.applicationRef,
      schemeCode: application.schemeCode,
      status: "REJECTED",
      note: input.reason,
      occurredOn: now,
    },
  });

  log.info("demo.gov.rejected", { applicationRef: input.applicationRef });
}

/** The portal returns an application pending a document. */
export async function govReturnForDocument(input: {
  applicationRef: string;
  documentKind: string;
  clock: Clock;
}): Promise<void> {
  const now = input.clock.now();

  const application = await prisma.govApplication.update({
    where: { applicationRef: input.applicationRef },
    data: { status: "PENDING_DOCUMENT", pendingDocument: input.documentKind },
  });

  await prisma.govStatusEvent.create({
    data: {
      applicationRef: input.applicationRef,
      schemeCode: application.schemeCode,
      status: "PENDING_DOCUMENT",
      note: `Returned to the applicant: ${input.documentKind} was not attached.`,
      occurredOn: now,
    },
  });
}

/**
 * Make an application look stalled, by backdating when the portal received it.
 *
 * Backdating receipt rather than advancing the global clock lets one benefit
 * appear stuck while the rest of the dashboard stays current, which is how a
 * real caseload looks.
 */
export async function govStallApplication(input: {
  applicationRef: string;
  daysPending: number;
  clock: Clock;
}): Promise<void> {
  const now = input.clock.now();
  const receivedOn = new Date(now.getTime() - input.daysPending * 86_400_000);

  const application = await prisma.govApplication.update({
    where: { applicationRef: input.applicationRef },
    data: { status: "UNDER_REVIEW", receivedOn, decidedOn: null },
  });

  await prisma.govStatusEvent.create({
    data: {
      applicationRef: input.applicationRef,
      schemeCode: application.schemeCode,
      status: "UNDER_REVIEW",
      note: "Application under review. No further information requested.",
      occurredOn: receivedOn,
    },
  });
}

/**
 * The portal releases a payment.
 *
 * `status` is the key control. RELEASED with the citizen later reporting
 * non-receipt is the discrepancy the whole product exists to catch: the
 * government's record is accurate about what it did, and the money still did
 * not arrive.
 */
export async function govReleasePayment(input: {
  applicationRef: string;
  schemeCode: string;
  aadhaarLast4: string;
  periodLabel: string;
  amountPaise: Paise;
  clock: Clock;
  releasedOn?: Date;
  status?: GovDisbursementStatus;
  failureReason?: string;
  bankAccountLast4?: string;
  channel?: string;
}): Promise<{ disbursementRef: string }> {
  const releasedOn = input.releasedOn ?? input.clock.now();
  const ref = disbursementRef(input.applicationRef, input.periodLabel);

  await prisma.govDisbursement.upsert({
    where: { disbursementRef: ref },
    create: {
      disbursementRef: ref,
      applicationRef: input.applicationRef,
      schemeCode: input.schemeCode,
      aadhaarLast4: input.aadhaarLast4,
      amountPaise: input.amountPaise,
      periodLabel: input.periodLabel,
      releasedOn,
      channel: input.channel ?? "DBT",
      bankAccountLast4: input.bankAccountLast4,
      status: input.status ?? "RELEASED",
      failureReason: input.failureReason,
    },
    update: {
      amountPaise: input.amountPaise,
      releasedOn,
      status: input.status ?? "RELEASED",
      failureReason: input.failureReason,
    },
  });

  await prisma.govStatusEvent.create({
    data: {
      applicationRef: input.applicationRef,
      schemeCode: input.schemeCode,
      status: `DISBURSEMENT_${input.status ?? "RELEASED"}`,
      note:
        input.status === "FAILED"
          ? `Disbursement for ${input.periodLabel} failed${input.failureReason ? `: ${input.failureReason}` : "."}`
          : `Amount released for ${input.periodLabel} by ${input.channel ?? "DBT"}.`,
      occurredOn: releasedOn,
    },
  });

  log.info("demo.gov.payment_released", {
    applicationRef: input.applicationRef,
    periodLabel: input.periodLabel,
    status: input.status ?? "RELEASED",
  });

  return { disbursementRef: ref };
}

/**
 * Remove a disbursement for one period, to simulate a payment that never
 * happened. Used to open a continuity gap mid-series.
 */
export async function govSkipPayment(input: {
  applicationRef: string;
  periodLabel: string;
}): Promise<void> {
  await prisma.govDisbursement.deleteMany({
    where: {
      applicationRef: input.applicationRef,
      periodLabel: input.periodLabel,
    },
  });
}

/** Record an Aadhaar-seeding failure against a disbursement. */
export async function govFailPaymentOnSeeding(input: {
  applicationRef: string;
  periodLabel: string;
  clock: Clock;
}): Promise<void> {
  const disbursement = await prisma.govDisbursement.findFirst({
    where: {
      applicationRef: input.applicationRef,
      periodLabel: input.periodLabel,
    },
  });
  if (!disbursement) return;

  await prisma.govStatusEvent.create({
    data: {
      applicationRef: input.applicationRef,
      schemeCode: disbursement.schemeCode,
      status: "DISBURSEMENT_RETURNED",
      // Wording the root-cause agent can cite. It is required to quote
      // evidence like this rather than guess at a cause.
      note: "Credit returned by the bank: Aadhaar is not seeded to the beneficiary account, so the transfer could not be completed.",
      occurredOn: input.clock.now(),
    },
  });
}
