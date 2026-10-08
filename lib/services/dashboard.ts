/**
 * The dashboard projection.
 *
 * Assembles everything the citizen's single screen needs: the four
 * independent money totals, one card per benefit, and the list of things
 * actually waiting on them.
 *
 * The naming discipline from `lib/engine/ledger.ts` carries through to the
 * wire format on purpose. `unverifiedAmountPaise` and `provenMissingPaise`
 * stay separate fields all the way to the browser, so a component cannot
 * render one as the other without visibly reaching for the wrong name. There
 * is deliberately no field holding their sum.
 */

import { prisma } from "@/lib/db";
import type { Clock } from "@/lib/clock";
import { paise, serialize, type Paise } from "@/lib/engine/money";
import { annualValue } from "@/lib/engine/period";
import {
  aggregateDashboard,
  type DashboardRow,
  type LedgerProjection,
} from "@/lib/engine/ledger";
import { readable } from "@/lib/engine/gaps";
import type {
  AuditDecision,
  EligibilityVerdict,
  LifecycleState,
  ReceiptState,
} from "@/lib/generated/prisma/enums";

/** What the citizen is being asked to do, in priority order. */
export interface PendingAction {
  kind:
    | "CONFIRM_RECEIPT"
    | "APPROVE_APPLICATION"
    | "APPROVE_ACTION"
    | "ANSWER_QUESTION"
    | "START_APPLICATION";
  /** Short, plain-language prompt. */
  prompt: string;
  benefitId?: string;
  schemeName?: string;
  approvalId?: string;
  paymentId?: string;
  /** Amount in question, when there is one. Null is not zero. */
  amountPaise?: string | null;
}

export interface BenefitCard {
  id: string;
  schemeCode: string;
  schemeName: string;
  schemeNameHi: string | null;
  category: string;
  benefitType: string;
  benefitNote: string | null;

  verdict: EligibilityVerdict;
  confidence: number;
  lifecycleState: LifecycleState;

  /** Per-instalment expected amount. Null means not a fixed cash amount. */
  expectedAmountPaise: string | null;
  annualValuePaise: string | null;
  frequency: string;

  /** Receipt state, or null when nothing has been disbursed yet. */
  receiptState: ReceiptState | null;
  /** Latest audit decision, or null if never audited. */
  decision: AuditDecision | null;
  decisionSummary: string | null;

  receivedAmountPaise: string;
  unverifiedAmountPaise: string;
  provenMissingPaise: string;
  recoveredAmountPaise: string;

  applicationStatus: string | null;
  openGaps: Array<{
    id: string;
    kind: string;
    readable: string;
    periodLabel: string | null;
    amountPaise: string | null;
  }>;

  missingEvidence: string[];
  pendingDeclarations: string[];

  source: {
    name: string;
    url: string;
    lastVerified: string;
    verificationStatus: string;
  };

  /** True when the government data behind this card is simulated. */
  isDemoData: boolean;
}

export interface DashboardProjection {
  citizen: { id: string; name: string; nameHi: string | null; locale: string };
  clock: { now: string; isSimulated: boolean };
  totals: {
    /** A projection from eligibility, not money owed. */
    potentialAnnualPaise: string;
    activeAnnualPaise: string;
    receivedPaise: string;
    /** Released, receipt unconfirmed. Never to be labelled "missing". */
    unverifiedPaise: string;
    /** Proven absent, with evidence. */
    provenMissingPaise: string;
    recoveredPaise: string;
  };
  counts: {
    eligible: number;
    potentiallyEligible: number;
    excluded: number;
    notApplied: number;
    healthy: number;
    needsVerification: number;
    actionRequired: number;
    recovered: number;
    nonCashBenefits: number;
  };
  pendingActions: PendingAction[];
  benefits: BenefitCard[];
}

/** Priority order for what to put in front of the citizen first. */
const ACTION_PRIORITY: Record<PendingAction["kind"], number> = {
  CONFIRM_RECEIPT: 0,
  APPROVE_ACTION: 1,
  APPROVE_APPLICATION: 2,
  START_APPLICATION: 3,
  ANSWER_QUESTION: 4,
};

export async function buildDashboard(input: {
  citizenId: string;
  clock: Clock;
}): Promise<DashboardProjection> {
  const citizen = await prisma.citizen.findUniqueOrThrow({
    where: { id: input.citizenId },
    select: { id: true, name: true, nameHi: true, locale: true, isDemo: true },
  });

  const entitlements = await prisma.entitlement.findMany({
    where: { citizenId: input.citizenId },
    include: {
      scheme: true,
      application: true,
      ledger: true,
      gaps: { where: { resolvedAt: null }, orderBy: { detectedAt: "desc" } },
      audits: { orderBy: { runAt: "desc" }, take: 1 },
      payments: {
        orderBy: { reportedOn: "desc" },
        include: {
          verifications: { orderBy: [{ verifiedAt: "desc" }, { id: "desc" }], take: 1 },
        },
      },
    },
    orderBy: [{ verdict: "asc" }, { confidence: "desc" }],
  });

  // Approvals still waiting on the citizen.
  const pendingApprovals = await prisma.approval.findMany({
    where: {
      decision: "PENDING",
      OR: [
        { application: { entitlement: { citizenId: input.citizenId } } },
        { actionPlan: { gap: { entitlement: { citizenId: input.citizenId } } } },
      ],
    },
    include: {
      application: { include: { entitlement: { include: { scheme: true } } } },
      actionPlan: {
        include: { gap: { include: { entitlement: { include: { scheme: true } } } } },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const pendingActions: PendingAction[] = [];
  const rows: DashboardRow[] = [];
  const benefits: BenefitCard[] = [];

  for (const entitlement of entitlements) {
    const perInstalment =
      entitlement.expectedAmountPaise === null
        ? null
        : paise(entitlement.expectedAmountPaise);
    const annual =
      perInstalment === null
        ? null
        : annualValue(entitlement.frequency, perInstalment);

    const ledger = entitlement.ledger;
    const latestAudit = entitlement.audits[0] ?? null;

    rows.push({
      verdict: entitlement.verdict,
      annualValue: annual,
      hasApplication: entitlement.application !== null,
      ledger: ledger
        ? ({
            expectedAmount: perInstalment,
            approvedAmount:
              ledger.approvedAmountPaise === null
                ? null
                : paise(ledger.approvedAmountPaise),
            disbursedAmount: paise(ledger.disbursedAmountPaise),
            receivedAmount: paise(ledger.receivedAmountPaise),
            unverifiedAmount: paise(ledger.unverifiedAmountPaise),
            gapAmount: paise(ledger.gapAmountPaise),
            recoveredAmount: paise(ledger.recoveredAmountPaise),
            receiptState: ledger.receiptState,
            recoveryStatus: ledger.recoveryStatus,
            appliedAt: ledger.appliedAt,
            lastVerifiedAt: ledger.lastVerifiedAt,
            lastAuditAt: ledger.lastAuditAt,
          } satisfies LedgerProjection)
        : null,
    });

    benefits.push({
      id: entitlement.id,
      schemeCode: entitlement.scheme.code,
      schemeName: entitlement.scheme.name,
      schemeNameHi: entitlement.scheme.nameHi,
      category: entitlement.scheme.category,
      benefitType: entitlement.scheme.benefitType,
      benefitNote: entitlement.scheme.benefitNote,
      verdict: entitlement.verdict,
      confidence: entitlement.confidence,
      lifecycleState: entitlement.lifecycleState,
      expectedAmountPaise: perInstalment === null ? null : serialize(perInstalment),
      annualValuePaise: annual === null ? null : serialize(annual),
      frequency: entitlement.frequency,
      receiptState: ledger?.receiptState ?? null,
      decision: latestAudit?.decision ?? null,
      decisionSummary: latestAudit?.summary ?? null,
      receivedAmountPaise: serialize(ledger?.receivedAmountPaise ?? 0n),
      unverifiedAmountPaise: serialize(ledger?.unverifiedAmountPaise ?? 0n),
      provenMissingPaise: serialize(ledger?.gapAmountPaise ?? 0n),
      recoveredAmountPaise: serialize(ledger?.recoveredAmountPaise ?? 0n),
      applicationStatus: entitlement.application?.status ?? null,
      openGaps: entitlement.gaps.map((gap) => ({
        id: gap.id,
        kind: gap.kind,
        readable: readable(gap.kind),
        periodLabel: gap.periodLabel,
        // Null stays null: an unknown amount is not zero.
        amountPaise: gap.amountPaise === null ? null : serialize(gap.amountPaise),
      })),
      missingEvidence: entitlement.missingEvidence,
      pendingDeclarations: entitlement.pendingDeclarations,
      source: {
        name: entitlement.scheme.sourceName,
        url: entitlement.scheme.sourceUrl,
        lastVerified: entitlement.scheme.lastVerified.toISOString().slice(0, 10),
        verificationStatus: entitlement.scheme.verificationStatus,
      },
      isDemoData: citizen.isDemo,
    });

    // A payment the government reported but nobody has confirmed. This is the
    // signature interaction, so it outranks everything else.
    for (const payment of entitlement.payments) {
      const answered = payment.verifications[0]?.citizenReport ?? null;
      if (
        payment.receiptState === "DISBURSED_RECEIPT_UNVERIFIED" &&
        answered === null
      ) {
        pendingActions.push({
          kind: "CONFIRM_RECEIPT",
          prompt: `Did you receive the ${entitlement.scheme.name} payment for ${payment.periodLabel}?`,
          benefitId: entitlement.id,
          schemeName: entitlement.scheme.name,
          paymentId: payment.id,
          amountPaise: serialize(payment.reportedAmountPaise),
        });
      }
    }

    // Eligible, nothing claimed.
    if (entitlement.verdict === "GREEN" && entitlement.application === null) {
      pendingActions.push({
        kind: "START_APPLICATION",
        prompt: `You appear to qualify for ${entitlement.scheme.name} but have not applied.`,
        benefitId: entitlement.id,
        schemeName: entitlement.scheme.name,
        amountPaise: annual === null ? null : serialize(annual),
      });
    }

    // Missing information holding a verdict at YELLOW.
    if (entitlement.verdict === "YELLOW" && entitlement.missingEvidence.length > 0) {
      pendingActions.push({
        kind: "ANSWER_QUESTION",
        prompt: `Answer one question to check your eligibility for ${entitlement.scheme.name}.`,
        benefitId: entitlement.id,
        schemeName: entitlement.scheme.name,
      });
    }
  }

  for (const approval of pendingApprovals) {
    if (approval.kind === "APPLICATION_SUBMISSION" && approval.application) {
      pendingActions.push({
        kind: "APPROVE_APPLICATION",
        prompt: `Review and approve your ${approval.application.entitlement.scheme.name} application before it is submitted.`,
        benefitId: approval.application.entitlementId,
        schemeName: approval.application.entitlement.scheme.name,
        approvalId: approval.id,
      });
    }
    if (approval.kind === "CORRECTIVE_ACTION" && approval.actionPlan) {
      const entitlement = approval.actionPlan.gap.entitlement;
      pendingActions.push({
        kind: "APPROVE_ACTION",
        prompt: `Approve the steps we propose to recover your ${entitlement.scheme.name} benefit.`,
        benefitId: entitlement.id,
        schemeName: entitlement.scheme.name,
        approvalId: approval.id,
      });
    }
  }

  pendingActions.sort(
    (a, b) => ACTION_PRIORITY[a.kind] - ACTION_PRIORITY[b.kind],
  );

  const totals = aggregateDashboard(rows);

  return {
    citizen: {
      id: citizen.id,
      name: citizen.name,
      nameHi: citizen.nameHi,
      locale: citizen.locale,
    },
    clock: {
      now: input.clock.now().toISOString(),
      isSimulated: input.clock.isSimulated,
    },
    totals: {
      potentialAnnualPaise: serialize(totals.potentialAnnualValue),
      activeAnnualPaise: serialize(totals.activeAnnualValue),
      receivedPaise: serialize(totals.receivedAmount),
      unverifiedPaise: serialize(totals.unverifiedAmount),
      provenMissingPaise: serialize(totals.provenMissingAmount),
      recoveredPaise: serialize(totals.recoveredAmount),
    },
    counts: totals.counts,
    pendingActions,
    benefits,
  };
}

/** Re-exported so API routes can serialise a Paise without another import. */
export type { Paise };
