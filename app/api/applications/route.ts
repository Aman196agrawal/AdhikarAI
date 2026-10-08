/**
 * POST /api/applications
 *
 * Prepare (or refresh) a draft application for an entitlement. Idempotent.
 */

import { handler, ok, parseBody, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { prepareApplication } from "@/lib/services/application";

const Body = z.object({
  citizenId: z.string().min(1),
  entitlementId: z.string().min(1),
  providedFields: z.record(z.string(), z.unknown()).optional(),
});

export const POST = handler("POST /api/applications", async (request) => {
  const body = await parseBody(request, Body);
  const citizen = await requireCitizen(body.citizenId);

  return ok(
    await prepareApplication({
      citizenId: citizen.citizenId,
      entitlementId: body.entitlementId,
      providedFields: body.providedFields,
    }),
  );
});
