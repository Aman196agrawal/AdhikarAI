/**
 * GET /api/catalogue/matches?citizenId=...&limit=...
 *
 * Schemes from the synced catalogue (myScheme) this citizen may qualify for,
 * beyond the curated, payment-tracked ones that /api/entitlements covers.
 *
 * Read-only and deterministic: no model call, nothing persisted. These are
 * not entitlements - they carry no payment model and never enter the
 * continuity audit - so each one links to its official page, says when it
 * was last synced, and credits the source.
 */

import { handler, ok, parseQuery, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { matchCatalogue } from "@/lib/catalogue/match";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { loadProfile } from "@/lib/services/profile";

const Query = z.object({
  citizenId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export const GET = handler("GET /api/catalogue/matches", async (request) => {
  const query = parseQuery(request, Query);
  const citizen = await requireCitizen(query.citizenId);
  const profile = await loadProfile(citizen.citizenId);

  // Real time, not the demo clock: a closing date is a fact about the world.
  const result = await matchCatalogue({ profile, clock: systemClock(), limit: query.limit });

  const lastRun = await prisma.schemeSyncRun.findFirst({
    where: { status: { in: ["SUCCEEDED", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
    select: { finishedAt: true, status: true, source: true },
  });

  return ok({
    citizenId: citizen.citizenId,
    ...result,
    attribution: "Scheme information from myScheme (www.myscheme.gov.in), Government of India.",
    lastSyncedAt: lastRun?.finishedAt?.toISOString() ?? null,
  });
});
