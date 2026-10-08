/**
 * Loading the clock for a request.
 *
 * Bridges the database-backed demo offset to the pure `Clock` the engine
 * consumes. Services take a `Clock` as an argument rather than calling this
 * themselves, which keeps them synchronously testable with `fixedClock`.
 */

import { resolveClock, systemClock, type Clock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { isDemoMode } from "@/lib/authz";

/**
 * The clock for this request.
 *
 * Outside demo mode this short-circuits to the system clock without reading
 * the database: the stored offset is not consulted at all, so a leftover demo
 * row cannot shift time in an environment holding real citizen data.
 */
export async function currentClock(): Promise<Clock> {
  if (!isDemoMode()) return systemClock();

  const stored = await prisma.demoClock.findUnique({
    where: { id: "singleton" },
    select: { offsetDays: true, offsetMinutes: true },
  });

  return resolveClock(stored, { demoMode: true });
}

/** Advance the simulated clock. Demo only; the caller must authorise. */
export async function advanceClock(input: {
  days?: number;
  minutes?: number;
}): Promise<{ offsetDays: number; offsetMinutes: number }> {
  const existing = await prisma.demoClock.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", offsetDays: 0, offsetMinutes: 0 },
    update: {},
  });

  const updated = await prisma.demoClock.update({
    where: { id: "singleton" },
    data: {
      offsetDays: existing.offsetDays + (input.days ?? 0),
      offsetMinutes: existing.offsetMinutes + (input.minutes ?? 0),
    },
    select: { offsetDays: true, offsetMinutes: true },
  });

  return updated;
}

/** Reset the simulated clock to real time. */
export async function resetClock(): Promise<void> {
  await prisma.demoClock.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", offsetDays: 0, offsetMinutes: 0 },
    update: { offsetDays: 0, offsetMinutes: 0 },
  });
}
