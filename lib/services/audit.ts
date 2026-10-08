/**
 * The Benefit Audit.
 *
 * Answers "what actually happened?" by comparing the expected entitlement
 * against the government's record, the citizen's account and whatever evidence
 * exists. Composed of the five audits the specification calls for - status,
 * approval, payment, receipt and continuity - feeding one gap list and one
 * decision.
 *
 * All the reasoning is the deterministic engine's. This service's job is to
 * GATHER the four kinds of fact, hand them to the engine, and persist what
 * comes back. No model call happens anywhere in this path, which is why an
 * audit is reproducible and why its conclusion can be defended line by line.
 *
 * The audit is also the one place that must resist a tempting simplification:
 * reading `gov_disbursement.status = RELEASED` and recording the money as
 * received. It is released. Whether it arrived is a separate question with a
 * separate answer, and frequently a different one.
 */

import { prisma } from "@/lib/db";
import type { Clock } from "@/lib/clock";
import { govGateway } from "@/lib/adapters/mockGovGateway";
import { add, paise, ZERO, type Paise } from "@/lib/engine/money";
import { auditContinuity, type ActualPaymentRecord } from "@/lib/engine/continuity";
import { detectGaps, type DetectedGap } from "@/lib/engine/gaps";
import { reconcile, type ReconcileResult } from "@/lib/engine/reconciler";
import { projectLedger } from "@/lib/engine/ledger";
import { stateForReceipt } from "@/lib/engine/stateMachine";
import { generateSchedule, periodLabel } from "@/lib/engine/period";
import { log } from "@/lib/log";
import type {
  AuditDecision,
  ApplicationStatus,
  GovApplicationStatus,
} from "@/lib/generated/prisma/enums";
import type { Prisma } from "@/lib/generated/prisma/client";
import { transitionEntitlement, type Actor } from "./transitions";

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

const MS_PER_DAY = 86_400_000;

/** Map a portal status onto our application status vocabulary. */
function mapGovStatus(status: GovApplicationStatus): ApplicationStatus {
  switch (status) {
    case "RECEIVED":
      return "SUBMITTED";
    case "UNDER_REVIEW":
      return "PENDING";
    case "PENDING_DOCUMENT":
      return "RETURNED";
    case "APPROVED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    case "RETURNED":
      return "RETURNED";
  }
}

export interface AuditResult {
  auditId: string;
  entitlementId: string;
  schemeCode: string;
  decision: AuditDecision;
  summary: string;
  gaps: DetectedGap[];
  /** Proven absent, with evidence. */
  provenMissingAmount: Paise;
  /** Released but unconfirmed. Reported separately, always. */
  unverifiedAmount: Paise;
  receivedAmount: Paise;
  findings: Array<{ area: string; summary: string; evidence: unknown }>;
  /** True when the government data came from the simulation. */
  isMockData: boolean;
}

/**
 * Run a full audit for one entitlement.
 *
 * Reads the government side only through the gateway, never by querying
 * `gov_*` directly, which is what keeps the two stores genuinely separate.
 */
export async function auditBenefit(input: {
  citizenId: string;
  entitlementId: string;
  clock: Clock;
  actor?: Actor;
  triggeredByEventId?: string;
}): Promise<AuditResult> {
  const actor: Actor = input.actor ?? { kind: "agent", name: "audit" };
  const now = input.clock.now();

  const entitlement = await prisma.entitlement.findFirstOrThrow({
    where: { id: input.entitlementId, citizenId: input.citizenId },
    include: {
      scheme: true,
      application: { include: { documents: true } },
      expectedPayments: true,
      payments: { include: { verifications: { orderBy: { verifiedAt: "desc" } } } },
    },
  });

  const citizen = await prisma.citizen.findUniqueOrThrow({
    where: { id: input.citizenId },
    select: { aadhaarLast4: true },
  });

  const gateway = govGateway();
  const findings: AuditResult["findings"] = [];

  // -------------------------------------------------------------------------
  // 1 & 2. Application and approval status
  // -------------------------------------------------------------------------
  const applicationRef = entitlement.application?.govApplicationRef ?? null;

  const govStatus = applicationRef
    ? await gateway.getApplicationStatus(applicationRef)
    : citizen.aadhaarLast4
      ? await gateway.findApplication({
          schemeCode: entitlement.scheme.code,
          aadhaarLast4: citizen.aadhaarLast4,
        })
      : null;

  let applicationStatus: ApplicationStatus | null =
    entitlement.application?.status ?? null;
  let rejectionReason: string | null =
    entitlement.application?.rejectionReason ?? null;
  let daysSinceSubmission: number | null = null;

  if (govStatus) {
    applicationStatus = mapGovStatus(govStatus.status);
    rejectionReason = govStatus.rejectionReason;
    daysSinceSubmission =
      (now.getTime() - govStatus.receivedOn.getTime()) / MS_PER_DAY;

    findings.push({
      area: "APPLICATION_STATUS",
      summary: `The ${gateway.isMock ? "simulated " : ""}portal reports this application as ${govStatus.status}, received ${Math.round(daysSinceSubmission)} days ago.`,
      evidence: {
        applicationRef: govStatus.applicationRef,
        status: govStatus.status,
        receivedOn: govStatus.receivedOn.toISOString(),
        events: govStatus.events.map((e) => ({
          status: e.status,
          note: e.note,
          occurredOn: e.occurredOn.toISOString(),
        })),
        isMockData: gateway.isMock,
      },
    });

    if (govStatus.status === "APPROVED") {
      findings.push({
        area: "APPROVAL_STATUS",
        summary: `Approved on ${govStatus.decidedOn?.toISOString().slice(0, 10) ?? "an unrecorded date"}.`,
        evidence: { decidedOn: govStatus.decidedOn?.toISOString() ?? null },
      });
    } else if (govStatus.status === "REJECTED") {
      findings.push({
        area: "APPROVAL_STATUS",
        summary: govStatus.rejectionReason
          ? `Rejected: ${govStatus.rejectionReason}`
          : "Rejected, with no reason recorded.",
        evidence: { rejectionReason: govStatus.rejectionReason },
      });
    }

    // Keep our copy in step with the portal.
    if (entitlement.application) {
      await prisma.application.update({
        where: { id: entitlement.application.id },
        data: {
          status: applicationStatus,
          rejectionReason,
          decidedAt: govStatus.decidedOn,
        },
      });
    }
  } else if (entitlement.application) {
    findings.push({
      area: "APPLICATION_STATUS",
      summary:
        "No record of this application could be found at the portal, so its current status is unknown.",
      evidence: { applicationRef, isMockData: gateway.isMock },
    });
  }

  // -------------------------------------------------------------------------
  // 3 & 4. Payment and receipt
  // -------------------------------------------------------------------------
  const disbursements = citizen.aadhaarLast4
    ? await gateway.listDisbursements({
        schemeCode: entitlement.scheme.code,
        aadhaarLast4: citizen.aadhaarLast4,
        ...(applicationRef ? { applicationRef } : {}),
      })
    : [];

  const expectedPerInstalment =
    entitlement.expectedAmountPaise === null
      ? null
      : paise(entitlement.expectedAmountPaise);

  const reconciliations: ReconcileResult[] = [];
  const actualPayments: ActualPaymentRecord[] = [];

  for (const disbursement of disbursements) {
    // Our own record of this period, carrying the citizen's answer and any
    // evidence already gathered.
    const existing = entitlement.payments.find(
      (p) => p.periodLabel === disbursement.periodLabel,
    );
    const latestVerification = existing?.verifications[0] ?? null;

    const reconciliation = reconcile({
      expectedAmount: expectedPerInstalment,
      // A FAILED or RETURNED disbursement never left, so it is not reported
      // as released.
      governmentReportedAmount:
        disbursement.status === "RELEASED"
          ? paise(disbursement.amountPaise)
          : null,
      citizenReport: latestVerification?.citizenReport ?? null,
      evidence: latestVerification
        ? {
            result: latestVerification.evidenceResult,
            matchedAmount:
              latestVerification.matchedAmountPaise === null
                ? null
                : paise(latestVerification.matchedAmountPaise),
          }
        : null,
    });

    reconciliations.push(reconciliation);

    // Explicit create-or-update rather than an upsert: (entitlement, period)
    // has no unique constraint, because a scheme can legitimately release more
    // than one disbursement for the same period (an arrears payment alongside
    // the regular one), and a unique index would reject the second.
    if (existing) {
      await prisma.payment.update({
        where: { id: existing.id },
        data: {
          govDisbursementRef: disbursement.disbursementRef,
          reportedAmountPaise: disbursement.amountPaise,
          reportedOn: disbursement.releasedOn,
          receiptState: reconciliation.receiptState,
          gapAmountPaise: reconciliation.gapAmount,
        },
      });
    } else {
      await prisma.payment.create({
        data: {
          entitlementId: entitlement.id,
          periodLabel: disbursement.periodLabel,
          govDisbursementRef: disbursement.disbursementRef,
          reportedAmountPaise: disbursement.amountPaise,
          reportedOn: disbursement.releasedOn,
          receiptState: reconciliation.receiptState,
          gapAmountPaise: reconciliation.gapAmount,
        },
      });
    }

    actualPayments.push({
      periodLabel: disbursement.periodLabel,
      receiptState: reconciliation.receiptState,
      reportedAmount: paise(disbursement.amountPaise),
      reportedOn: disbursement.releasedOn,
    });

    findings.push({
      area: "PAYMENT",
      summary:
        disbursement.status === "RELEASED"
          ? `The ${gateway.isMock ? "simulated " : ""}government record shows a release for ${disbursement.periodLabel}.`
          : `The disbursement for ${disbursement.periodLabel} is recorded as ${disbursement.status}${disbursement.failureReason ? `: ${disbursement.failureReason}` : ""}.`,
      evidence: {
        disbursementRef: disbursement.disbursementRef,
        periodLabel: disbursement.periodLabel,
        amountPaise: disbursement.amountPaise.toString(),
        releasedOn: disbursement.releasedOn.toISOString(),
        status: disbursement.status,
        failureReason: disbursement.failureReason,
        channel: disbursement.channel,
        isMockData: gateway.isMock,
      },
    });

    findings.push({
      area: "RECEIPT",
      summary: reconciliation.reasons.join(" "),
      evidence: {
        periodLabel: disbursement.periodLabel,
        receiptState: reconciliation.receiptState,
        method: reconciliation.method,
        hasConflict: reconciliation.hasConflict,
      },
    });
  }

  // -------------------------------------------------------------------------
  // 5. Continuity
  // -------------------------------------------------------------------------
  let expectedSchedule = entitlement.expectedPayments.map((p) => ({
    periodLabel: p.periodLabel,
    dueOn: p.dueOn,
    expectedAmount: paise(p.expectedAmountPaise),
  }));

  // Materialise the schedule the first time a benefit is actually approved.
  // Doing it at discovery would invent due dates for money never owed.
  if (
    expectedSchedule.length === 0 &&
    applicationStatus === "APPROVED" &&
    expectedPerInstalment !== null &&
    govStatus?.decidedOn
  ) {
    const generated = generateSchedule({
      frequency: entitlement.frequency,
      startDate: govStatus.decidedOn,
      until: now,
      amount: expectedPerInstalment,
    });

    if (generated.length > 0) {
      await prisma.expectedPayment.createMany({
        data: generated.map((item) => ({
          entitlementId: entitlement.id,
          periodLabel: item.periodLabel,
          dueOn: item.dueOn,
          expectedAmountPaise: item.expectedAmount,
        })),
        skipDuplicates: true,
      });
      expectedSchedule = generated;
    }
  }

  const continuity = auditContinuity({
    expected: expectedSchedule,
    actual: actualPayments,
    now,
  });

  if (expectedSchedule.length > 0) {
    findings.push({
      area: "CONTINUITY",
      summary:
        continuity.gaps.length === 0
          ? `All ${expectedSchedule.length} expected payment period(s) are accounted for.`
          : `${continuity.missedPeriods.length} expected payment period(s) have no disbursement: ${continuity.missedPeriods.join(", ")}.`,
      evidence: {
        expectedPeriods: expectedSchedule.map((p) => p.periodLabel),
        paidPeriods: continuity.paidPeriods,
        missedPeriods: continuity.missedPeriods,
        pendingPeriods: continuity.pendingPeriods,
        isInterrupted: continuity.isInterrupted,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Gap detection and decision
  // -------------------------------------------------------------------------
  const missingDocuments = (entitlement.application?.documents ?? [])
    .filter((d) => !d.provided)
    .map((d) => d.kind as string);

  const latestReconciliation =
    reconciliations.length > 0
      ? reconciliations[reconciliations.length - 1]
      : null;

  const detection = detectGaps({
    verdict: entitlement.verdict,
    applicationStatus,
    daysSinceSubmission,
    rejectionReason,
    missingDocuments,
    reconciliation: latestReconciliation,
    continuityGaps: continuity.gaps,
  });

  // Totals across every period, not only the latest.
  let unverifiedAmount = ZERO;
  let receivedAmount = ZERO;
  for (const reconciliation of reconciliations) {
    unverifiedAmount = add(unverifiedAmount, reconciliation.unverifiedAmount);
    receivedAmount = add(receivedAmount, reconciliation.receivedAmount);
  }
  // detectGaps already folds the continuity misses into this total, so adding
  // continuity.totalMissingAmount again here would double-count them.
  const provenMissingAmount = detection.totalProvenMissing;

  // -------------------------------------------------------------------------
  // Persist
  // -------------------------------------------------------------------------
  const audit = await prisma.benefitAudit.create({
    data: {
      entitlementId: entitlement.id,
      decision: detection.decision,
      summary: detection.summary,
      runAt: now,
      triggeredByEventId: input.triggeredByEventId,
      findings: {
        create: findings.map((finding) => ({
          area: finding.area as never,
          summary: finding.summary,
          evidence: asJson(finding.evidence),
        })),
      },
    },
  });

  // Replace unresolved gaps for this entitlement so a resolved one does not
  // linger and keep the benefit looking broken.
  await prisma.benefitGap.deleteMany({
    where: { entitlementId: entitlement.id, resolvedAt: null },
  });

  for (const gap of detection.gaps) {
    await prisma.benefitGap.create({
      data: {
        entitlementId: entitlement.id,
        auditId: audit.id,
        kind: gap.kind,
        periodLabel: gap.periodLabel,
        amountPaise: gap.amount,
        evidence: asJson(gap.evidence),
        detectedAt: now,
      },
    });
  }

  const ledger = projectLedger({
    expectedAmount: expectedPerInstalment,
    applicationStatus,
    payments: reconciliations,
    appliedAt: entitlement.application?.submittedAt ?? null,
    lastAuditAt: now,
  });

  await prisma.benefitLedger.upsert({
    where: { entitlementId: entitlement.id },
    create: {
      entitlementId: entitlement.id,
      expectedAmountPaise: expectedPerInstalment ?? 0n,
      disbursedAmountPaise: ledger.disbursedAmount,
      receivedAmountPaise: ledger.receivedAmount,
      unverifiedAmountPaise: ledger.unverifiedAmount,
      gapAmountPaise: ledger.gapAmount,
      receiptState: ledger.receiptState,
      recoveryStatus: ledger.recoveryStatus,
      appliedAt: ledger.appliedAt,
      lastAuditAt: now,
    },
    update: {
      expectedAmountPaise: expectedPerInstalment ?? 0n,
      disbursedAmountPaise: ledger.disbursedAmount,
      receivedAmountPaise: ledger.receivedAmount,
      unverifiedAmountPaise: ledger.unverifiedAmount,
      gapAmountPaise: ledger.gapAmount,
      receiptState: ledger.receiptState,
      recoveryStatus: ledger.recoveryStatus,
      lastAuditAt: now,
    },
  });

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------
  const target =
    detection.decision === "ACTION_REQUIRED" && detection.gaps.length > 0
      ? "GAP_DETECTED"
      : reconciliations.length > 0
        ? stateForReceipt(ledger.receiptState)
        : applicationStatus === "APPROVED"
          ? "APPROVED"
          : null;

  if (target) {
    try {
      await transitionEntitlement(prisma, {
        entitlementId: entitlement.id,
        citizenId: input.citizenId,
        to: target,
        actor,
        reason: detection.summary,
        evidenceRef: audit.id,
        from: entitlement.lifecycleState,
      });
    } catch (error) {
      // An illegal transition means the audit reached a conclusion the
      // workflow cannot express from where this benefit currently sits. That
      // is a real inconsistency, so it is recorded loudly rather than
      // swallowed - but it must not discard the audit we just computed.
      log.error("audit.illegal_transition", {
        entitlementId: entitlement.id,
        from: entitlement.lifecycleState,
        to: target,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info("audit.completed", {
    entitlementId: entitlement.id,
    schemeCode: entitlement.scheme.code,
    decision: detection.decision,
    gaps: detection.gaps.length,
    isMockData: gateway.isMock,
  });

  return {
    auditId: audit.id,
    entitlementId: entitlement.id,
    schemeCode: entitlement.scheme.code,
    decision: detection.decision,
    summary: detection.summary,
    gaps: detection.gaps,
    provenMissingAmount,
    unverifiedAmount,
    receivedAmount,
    findings,
    isMockData: gateway.isMock,
  };
}

/** Current period label for a benefit, used when recording a payment. */
export function currentPeriod(
  frequency: Parameters<typeof periodLabel>[0],
  clock: Clock,
): string {
  return periodLabel(frequency, clock.now());
}
