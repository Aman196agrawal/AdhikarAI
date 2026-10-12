/**
 * GET /api/admin/catalogue/runs
 *
 * Recent catalogue sync runs and the catalogue's overall state, so an admin
 * can see at a glance whether the data is fresh and what last went wrong.
 */

import { handler, ok } from "@/lib/api/http";
import { requireAdmin } from "@/lib/authz";
import { prisma } from "@/lib/db";

export const GET = handler("GET /api/admin/catalogue/runs", async (request) => {
  requireAdmin(request);

  const [runs, active, withdrawn, awaitingReview, draftFailed] = await Promise.all([
    prisma.schemeSyncRun.findMany({ orderBy: { startedAt: "desc" }, take: 20 }),
    prisma.catalogScheme.count({ where: { status: "ACTIVE" } }),
    prisma.catalogScheme.count({ where: { status: "WITHDRAWN" } }),
    prisma.catalogScheme.count({
      where: { status: "ACTIVE", rules: { some: { status: "DRAFT" } } },
    }),
    prisma.catalogScheme.count({ where: { status: "ACTIVE", draftStatus: "FAILED" } }),
  ]);

  return ok({
    catalogue: { active, withdrawn, awaitingReview, draftFailed },
    runs: runs.map((run) => ({
      ...run,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
    })),
  });
});
