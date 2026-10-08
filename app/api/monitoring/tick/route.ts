/**
 * POST /api/monitoring/tick
 *
 * The scheduler's entry point. Authenticated with CRON_SECRET, because an
 * open endpoint that advances benefit state would be a real problem.
 *
 * Vercel Hobby has no long-lived process and its own cron is daily-only, so
 * the primary trigger is an external pinger (GitHub Actions on a 5-minute
 * schedule) calling this with `Authorization: Bearer $CRON_SECRET`. Each call
 * processes a bounded batch and reports whether more work remains, so it
 * always completes well inside the function time limit.
 */

import { handler, ok, z } from "@/lib/api/http";
import { requireCronSecret } from "@/lib/authz";
import { currentClock } from "@/lib/services/clock";
import { runMonitoringTick } from "@/lib/services/monitoring";

const Query = z.object({
  batchSize: z.coerce.number().int().min(1).max(100).optional(),
});

export const POST = handler("POST /api/monitoring/tick", async (request) => {
  requireCronSecret(request);

  const params = Object.fromEntries(new URL(request.url).searchParams);
  const query = Query.parse(params);
  const clock = await currentClock();

  return ok(await runMonitoringTick({ clock, batchSize: query.batchSize ?? 25 }));
});

/**
 * GET is deliberately refused. A monitoring pass changes benefit state, and a
 * state-changing GET would be triggerable by a link prefetch or a crawler.
 */
export const GET = handler("GET /api/monitoring/tick", async () =>
  Response.json(
    {
      ok: false,
      error: {
        code: "BAD_REQUEST",
        message: "Use POST. A monitoring pass changes state.",
      },
    },
    { status: 405 },
  ),
);
