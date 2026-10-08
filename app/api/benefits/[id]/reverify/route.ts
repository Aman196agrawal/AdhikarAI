/**
 * POST /api/benefits/[id]/reverify
 *
 * Did the corrective action work? Re-reads the government record rather than
 * trusting that a completed action means a resolved benefit.
 */

import { handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { serialize } from "@/lib/engine/money";
import { currentClock } from "@/lib/services/clock";
import { reverifyBenefit } from "@/lib/services/recovery";

const Body = z.object({ citizenId: z.string().min(1) });

export const POST = handler(
  "POST /api/benefits/[id]/reverify",
  async (request, ctx) => {
    const body = await parseBody(request, Body);
    const citizen = await requireCitizen(body.citizenId);
    const entitlementId = await routeParam(ctx, "id");
    const clock = await currentClock();

    const result = await reverifyBenefit({
      citizenId: citizen.citizenId,
      entitlementId,
      clock,
    });

    return ok({
      resolved: result.resolved,
      decision: result.decision,
      recoveredAmountPaise: serialize(result.recoveredAmount),
      summary: result.summary,
      nextStep: result.nextStep ?? null,
    });
  },
);
