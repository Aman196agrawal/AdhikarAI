/**
 * GET /api/benefits/[id]?citizenId=...
 *
 * The full lifecycle of one benefit: every audit, finding, gap, diagnosis,
 * plan, execution, payment and state change, in order. This backs the detail
 * screen and the Why? drawer, and it is the view that makes a decision
 * defensible rather than merely stated.
 *
 * Note what is NOT returned: application field values. The screen shows which
 * fields were filled and where each value came from, not the Aadhaar or
 * account number itself. Nothing needs to read those back.
 */

import { handler, ok, parseQuery, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { readable } from "@/lib/engine/gaps";
import { serialize } from "@/lib/engine/money";

const Query = z.object({ citizenId: z.string().min(1) });

export const GET = handler("GET /api/benefits/[id]", async (request, ctx) => {
  const query = parseQuery(request, Query);
  const citizen = await requireCitizen(query.citizenId);
  const id = await routeParam(ctx, "id");

  const entitlement = await prisma.entitlement.findFirstOrThrow({
    where: { id, citizenId: citizen.citizenId },
    include: {
      scheme: true,
      application: { include: { fields: true, documents: true, approvals: true } },
      expectedPayments: { orderBy: { dueOn: "asc" } },
      payments: {
        orderBy: { reportedOn: "asc" },
        include: {
          verifications: { orderBy: [{ verifiedAt: "desc" }, { id: "desc" }] },
        },
      },
      ledger: true,
      audits: { orderBy: { runAt: "desc" }, include: { findings: true } },
      gaps: {
        orderBy: { detectedAt: "desc" },
        include: {
          rootCauses: { orderBy: { attempt: "desc" } },
          actionPlans: {
            orderBy: { attempt: "desc" },
            include: {
              steps: { orderBy: { position: "asc" } },
              executions: true,
              approvals: true,
            },
          },
        },
      },
    },
  });

  const trail = await prisma.auditLog.findMany({
    where: { entity: "Entitlement", entityId: entitlement.id },
    orderBy: { createdAt: "asc" },
  });

  return ok({
    id: entitlement.id,
    scheme: {
      code: entitlement.scheme.code,
      name: entitlement.scheme.name,
      nameHi: entitlement.scheme.nameHi,
      category: entitlement.scheme.category,
      description: entitlement.scheme.description,
      descriptionHi: entitlement.scheme.descriptionHi,
      benefitType: entitlement.scheme.benefitType,
      benefitNote: entitlement.scheme.benefitNote,
      applicationMethod: entitlement.scheme.applicationMethod,
      applicationUrl: entitlement.scheme.applicationUrl,
      benefitAmountPaise:
        entitlement.scheme.benefitAmountPaise === null
          ? null
          : serialize(entitlement.scheme.benefitAmountPaise),
      sourceName: entitlement.scheme.sourceName,
      sourceUrl: entitlement.scheme.sourceUrl,
      lastVerified: entitlement.scheme.lastVerified.toISOString().slice(0, 10),
      verificationStatus: entitlement.scheme.verificationStatus,
    },

    verdict: entitlement.verdict,
    confidence: entitlement.confidence,
    lifecycleState: entitlement.lifecycleState,
    expectedAmountPaise:
      entitlement.expectedAmountPaise === null
        ? null
        : serialize(entitlement.expectedAmountPaise),
    frequency: entitlement.frequency,
    missingEvidence: entitlement.missingEvidence,
    pendingDeclarations: entitlement.pendingDeclarations,
    clauseResults: entitlement.clauseResults,

    application: entitlement.application
      ? {
          id: entitlement.application.id,
          status: entitlement.application.status,
          govApplicationRef: entitlement.application.govApplicationRef,
          submittedAt: entitlement.application.submittedAt?.toISOString() ?? null,
          rejectionReason: entitlement.application.rejectionReason,
          submissionError: entitlement.application.submissionError,
          fields: entitlement.application.fields.map((f) => ({
            key: f.key,
            source: f.source,
            valid: f.valid,
            validationError: f.validationError,
          })),
          documents: entitlement.application.documents.map((d) => ({
            kind: d.kind,
            provided: d.provided,
          })),
          approvals: entitlement.application.approvals.map((a) => ({
            id: a.id,
            decision: a.decision,
            decidedAt: a.decidedAt?.toISOString() ?? null,
            shownEvidence: a.shownEvidence,
          })),
        }
      : null,

    expectedSchedule: entitlement.expectedPayments.map((p) => ({
      periodLabel: p.periodLabel,
      dueOn: p.dueOn.toISOString(),
      expectedAmountPaise: serialize(p.expectedAmountPaise),
    })),

    payments: entitlement.payments.map((p) => ({
      id: p.id,
      periodLabel: p.periodLabel,
      reportedAmountPaise: serialize(p.reportedAmountPaise),
      reportedOn: p.reportedOn.toISOString(),
      receiptState: p.receiptState,
      gapAmountPaise: serialize(p.gapAmountPaise),
      verifications: p.verifications.map((v) => ({
        citizenReport: v.citizenReport,
        evidenceResult: v.evidenceResult,
        method: v.method,
        matchedAmountPaise:
          v.matchedAmountPaise === null ? null : serialize(v.matchedAmountPaise),
        matchedOn: v.matchedOn?.toISOString() ?? null,
        refLast4: v.refLast4,
        resultState: v.resultState,
        verifiedAt: v.verifiedAt.toISOString(),
      })),
    })),

    ledger: entitlement.ledger
      ? {
          receiptState: entitlement.ledger.receiptState,
          recoveryStatus: entitlement.ledger.recoveryStatus,
          receivedPaise: serialize(entitlement.ledger.receivedAmountPaise),
          unverifiedPaise: serialize(entitlement.ledger.unverifiedAmountPaise),
          provenMissingPaise: serialize(entitlement.ledger.gapAmountPaise),
          recoveredPaise: serialize(entitlement.ledger.recoveredAmountPaise),
          lastVerifiedAt: entitlement.ledger.lastVerifiedAt?.toISOString() ?? null,
          lastAuditAt: entitlement.ledger.lastAuditAt?.toISOString() ?? null,
        }
      : null,

    audits: entitlement.audits.map((audit) => ({
      id: audit.id,
      decision: audit.decision,
      summary: audit.summary,
      runAt: audit.runAt.toISOString(),
      findings: audit.findings.map((f) => ({
        area: f.area,
        summary: f.summary,
        evidence: f.evidence,
      })),
    })),

    gaps: entitlement.gaps.map((gap) => ({
      id: gap.id,
      kind: gap.kind,
      readable: readable(gap.kind),
      periodLabel: gap.periodLabel,
      amountPaise: gap.amountPaise === null ? null : serialize(gap.amountPaise),
      evidence: gap.evidence,
      detectedAt: gap.detectedAt.toISOString(),
      resolvedAt: gap.resolvedAt?.toISOString() ?? null,
      rootCauses: gap.rootCauses.map((rc) => ({
        attempt: rc.attempt,
        kind: rc.kind,
        confidence: rc.confidence,
        evidence: rc.evidence,
        reasoning: rc.reasoning,
        recommendedAction: rc.recommendedAction,
      })),
      actionPlans: gap.actionPlans.map((plan) => ({
        id: plan.id,
        attempt: plan.attempt,
        status: plan.status,
        summary: plan.summary,
        expectedOutcome: plan.expectedOutcome,
        steps: plan.steps.map((s) => ({
          position: s.position,
          kind: s.kind,
          description: s.description,
          reason: s.reason,
          channel: s.channel,
        })),
        executions: plan.executions.map((e) => ({
          status: e.status,
          adapter: e.adapter,
          error: e.error,
          finishedAt: e.finishedAt?.toISOString() ?? null,
        })),
        approvals: plan.approvals.map((a) => ({
          id: a.id,
          decision: a.decision,
          decidedAt: a.decidedAt?.toISOString() ?? null,
          shownEvidence: a.shownEvidence,
        })),
      })),
    })),

    trail: trail.map((entry) => ({
      actor: entry.actor,
      fromState: entry.fromState,
      toState: entry.toState,
      reason: entry.reason,
      createdAt: entry.createdAt.toISOString(),
    })),
  });
});
