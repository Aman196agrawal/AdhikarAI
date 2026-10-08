/**
 * GET /api/dashboard?citizenId=...
 *
 * Everything the citizen's main screen needs, in one request.
 */

import { handler, ok, parseQuery, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { buildDashboard } from "@/lib/services/dashboard";
import { currentClock } from "@/lib/services/clock";

const Query = z.object({ citizenId: z.string().min(1) });

export const GET = handler("GET /api/dashboard", async (request) => {
  const query = parseQuery(request, Query);
  const citizen = await requireCitizen(query.citizenId);
  const clock = await currentClock();

  return ok(await buildDashboard({ citizenId: citizen.citizenId, clock }));
});
