/**
 * GET  /api/demo/clock  - read the simulated clock
 * POST /api/demo/clock  - advance or reset it
 *
 * Advancing the clock is how a three-month continuity gap appears on stage in
 * ten seconds. The engine is unchanged; only its sense of "now" moves, and
 * every surface reading a shifted clock reports `isSimulated` so the UI can
 * say so.
 *
 * Gated on DEMO_MODE, and `resolveClock` ignores the stored offset entirely
 * when demo mode is off - so a leftover row cannot shift time in an
 * environment holding real citizen data.
 */

import { handler, ok, parseBody, z } from "@/lib/api/http";
import { requireDemoMode } from "@/lib/authz";
import { realNow } from "@/lib/clock";
import { advanceClock, currentClock, resetClock } from "@/lib/services/clock";
import { runMonitoringTick } from "@/lib/services/monitoring";

const Body = z.object({
  action: z.enum(["ADVANCE", "RESET"]),
  days: z.coerce.number().int().min(-3650).max(3650).optional(),
  minutes: z.coerce.number().int().min(-1440).max(1440).optional(),
  /**
   * Run a monitoring pass straight after moving the clock.
   *
   * This is what makes the demo honest: advancing time does not itself change
   * any benefit. The real monitor then runs over the new "now" and draws its
   * own conclusions, exactly as it would after three months of real time.
   */
  runMonitoring: z.boolean().optional(),
  citizenId: z.string().min(1).optional(),
});

export const GET = handler("GET /api/demo/clock", async () => {
  const clock = await currentClock();
  return ok({
    now: clock.now().toISOString(),
    isSimulated: clock.isSimulated,
    realNow: realNow().toISOString(),
  });
});

export const POST = handler("POST /api/demo/clock", async (request) => {
  requireDemoMode();
  const body = await parseBody(request, Body);

  const offset =
    body.action === "RESET"
      ? (await resetClock(), { offsetDays: 0, offsetMinutes: 0 })
      : await advanceClock({ days: body.days ?? 0, minutes: body.minutes ?? 0 });

  const clock = await currentClock();

  const monitoring = body.runMonitoring
    ? // Forced: a pass the presenter asked for should always look, rather
      // than being skipped because the benefit was checked minutes ago.
      await runMonitoringTick({ clock, citizenId: body.citizenId, force: true })
    : null;

  return ok({
    offset,
    now: clock.now().toISOString(),
    isSimulated: clock.isSimulated,
    monitoring,
  });
});
