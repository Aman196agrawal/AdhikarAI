/**
 * POST /api/applications/[id]/request-approval
 *
 * Opens approval gate 1 and returns exactly what the citizen will be shown.
 */

import { handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { requestApplicationApproval } from "@/lib/services/application";

const Body = z.object({ citizenId: z.string().min(1) });

export const POST = handler(
  "POST /api/applications/[id]/request-approval",
  async (request, ctx) => {
    const body = await parseBody(request, Body);
    const citizen = await requireCitizen(body.citizenId);
    const applicationId = await routeParam(ctx, "id");

    return ok(
      await requestApplicationApproval({
        citizenId: citizen.citizenId,
        applicationId,
      }),
    );
  },
);
