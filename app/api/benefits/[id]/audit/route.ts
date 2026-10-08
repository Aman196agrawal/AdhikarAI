/**
 * POST /api/benefits/[id]/audit
 *
 * Re-run the full audit for one benefit, on demand.
 */

import { handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { serialize } from "@/lib/engine/money";
import { auditBenefit } from "@/lib/services/audit";
import { currentClock } from "@/lib/services/clock";

const Body = z.object({ citizenId: z.string().min(1) });

export const POST = handler("POST /api/benefits/[id]/audit", async (request, ctx) => {
  const body = await parseBody(request, Body);
  const citizen = await requireCitizen(body.citizenId);
  const entitlementId = await routeParam(ctx, "id");
  const clock = await currentClock();

  const result = await auditBenefit({
    citizenId: citizen.citizenId,
    entitlementId,
    clock,
  });

  return ok({
    auditId: result.auditId,
    schemeCode: result.schemeCode,
    decision: result.decision,
    summary: result.summary,
    // Three distinct totals, three distinct meanings, three distinct fields.
    receivedPaise: serialize(result.receivedAmount),
    unverifiedPaise: serialize(result.unverifiedAmount),
    provenMissingPaise: serialize(result.provenMissingAmount),
    gaps: result.gaps.map((gap) => ({
      kind: gap.kind,
      periodLabel: gap.periodLabel,
      amountPaise: gap.amount === null ? null : serialize(gap.amount),
      evidence: gap.evidence,
      needsAction: gap.needsAction,
    })),
    findings: result.findings,
    isMockData: result.isMockData,
  });
});
