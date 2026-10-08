/**
 * POST /api/benefits/[id]/diagnose
 *
 * Diagnose the benefit's open gap and prepare a corrective plan for approval.
 * Nothing is executed here; that needs approval gate 2.
 */

import { prisma } from "@/lib/db";
import { ApiError, handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { currentClock } from "@/lib/services/clock";
import { diagnoseAndPlan } from "@/lib/services/recovery";

const Body = z.object({
  citizenId: z.string().min(1),
  /** Which gap to diagnose. Defaults to the most recent unresolved one. */
  gapId: z.string().min(1).optional(),
});

export const POST = handler(
  "POST /api/benefits/[id]/diagnose",
  async (request, ctx) => {
    const body = await parseBody(request, Body);
    const citizen = await requireCitizen(body.citizenId);
    const entitlementId = await routeParam(ctx, "id");

    const gap =
      body.gapId
        ? await prisma.benefitGap.findFirst({
            where: { id: body.gapId, entitlementId },
          })
        : await prisma.benefitGap.findFirst({
            where: { entitlementId, resolvedAt: null },
            orderBy: { detectedAt: "desc" },
          });

    if (!gap) {
      throw new ApiError(
        "NOT_FOUND",
        "There is no unresolved problem to diagnose for this benefit.",
      );
    }

    const clock = await currentClock();
    return ok(
      await diagnoseAndPlan({
        citizenId: citizen.citizenId,
        gapId: gap.id,
        clock,
      }),
    );
  },
);
