/**
 * PUT /api/admin/catalogue/schemes/:id/unmapped
 *
 * Replace a scheme's unmapped criteria - the eligibility conditions no rule
 * expresses. Any entry left caps the scheme's best verdict at YELLOW.
 */

import { handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireAdmin } from "@/lib/authz";
import { setUnmappedCriteria } from "@/lib/catalogue/review";

const Body = z.object({ unmapped: z.array(z.string().max(400)).max(50) });

export const PUT = handler("PUT /api/admin/catalogue/schemes/:id/unmapped", async (request, ctx) => {
  requireAdmin(request);
  const schemeId = await routeParam(ctx, "id");
  const body = await parseBody(request, Body);
  return ok(await setUnmappedCriteria({ schemeId, unmapped: body.unmapped }));
});
