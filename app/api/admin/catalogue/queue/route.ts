/**
 * GET /api/admin/catalogue/queue
 *
 * Catalogue schemes with drafted rules waiting for a reviewer, most recently
 * changed first, each with its eligibility text beside the drafts.
 */

import { handler, ok, parseQuery, z } from "@/lib/api/http";
import { requireAdmin } from "@/lib/authz";
import { reviewQueue } from "@/lib/catalogue/review";

const Query = z.object({ limit: z.coerce.number().int().min(1).max(200).optional() });

export const GET = handler("GET /api/admin/catalogue/queue", async (request) => {
  requireAdmin(request);
  const query = parseQuery(request, Query);
  return ok({ schemes: await reviewQueue({ limit: query.limit }) });
});
