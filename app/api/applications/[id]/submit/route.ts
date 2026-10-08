/**
 * POST /api/applications/[id]/submit
 *
 * Refuses without an APPROVED approval. A failure is returned as a failure,
 * with `retryable` saying whether retrying unchanged could possibly help.
 */

import { fail, handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { submitApplication } from "@/lib/services/application";
import { currentClock } from "@/lib/services/clock";

const Body = z.object({ citizenId: z.string().min(1) });

export const POST = handler(
  "POST /api/applications/[id]/submit",
  async (request, ctx) => {
    const body = await parseBody(request, Body);
    const citizen = await requireCitizen(body.citizenId);
    const applicationId = await routeParam(ctx, "id");
    const clock = await currentClock();

    const outcome = await submitApplication({
      citizenId: citizen.citizenId,
      applicationId,
      clock,
    });

    if (!outcome.ok) {
      return fail("UNPROCESSABLE", outcome.message, {
        reason: outcome.reason,
        retryable: outcome.retryable,
        fieldErrors: outcome.fieldErrors ?? [],
      });
    }

    return ok(outcome);
  },
);
