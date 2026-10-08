/**
 * POST /api/action-plans/[id]/execute
 *
 * Refuses without an APPROVED approval. Execution leads only to
 * re-verification; it never concludes that the benefit is fixed.
 */

import { handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { currentClock } from "@/lib/services/clock";
import { executeActionPlan } from "@/lib/services/recovery";

const Body = z.object({ citizenId: z.string().min(1) });

export const POST = handler(
  "POST /api/action-plans/[id]/execute",
  async (request, ctx) => {
    const body = await parseBody(request, Body);
    const citizen = await requireCitizen(body.citizenId);
    const actionPlanId = await routeParam(ctx, "id");
    const clock = await currentClock();

    const outcome = await executeActionPlan({
      citizenId: citizen.citizenId,
      actionPlanId,
      clock,
    });

    return ok({
      ...outcome,
      nextStep:
        "The outcome is not yet known. Re-verification will check whether this actually worked.",
    });
  },
);
