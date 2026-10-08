/**
 * Time for AdhikarAI.
 *
 * This is the ONLY module permitted to construct a `Date` from the ambient
 * system time. Engine and agent code receives time as an explicit value, which
 * keeps every reconciliation and continuity calculation a pure function of its
 * inputs and therefore synchronously testable.
 *
 * Why a simulated clock exists at all: a continuity gap is, by definition, a
 * payment that failed to arrive over months. Demonstrating that honestly needs
 * months to elapse. Rather than fake the benefit data, the demo shifts *time*
 * and lets the real engine draw the real conclusion. The clock is the only
 * thing being simulated, and `isSimulated` lets the UI say so.
 *
 * Safety property: the stored offset is honoured only when demo mode is
 * explicitly enabled. See {@link resolveClock}.
 */

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 86_400_000;

/**
 * A source of the current time.
 *
 * `isSimulated` is surfaced so any screen reading a shifted clock can render a
 * DEMO CLOCK badge. A product that silently lied about the date would be
 * indistinguishable from one with a bug.
 */
export interface Clock {
  now(): Date;
  readonly isSimulated: boolean;
}

/** A stored clock offset, as held by the `DemoClock` singleton row. */
export interface ClockOffset {
  offsetDays: number;
  offsetMinutes: number;
}

/**
 * Shift an instant by a whole number of days and minutes.
 *
 * Returns a new `Date`; the input is never mutated. Day arithmetic is done in
 * UTC milliseconds, so it crosses month and year boundaries without the
 * local-timezone surprises of `setDate`.
 */
export function applyOffset(
  base: Date,
  offsetDays: number,
  offsetMinutes: number,
): Date {
  if (!Number.isInteger(offsetDays)) {
    throw new RangeError(
      `applyOffset() requires an integer day offset, received ${offsetDays}`,
    );
  }
  if (!Number.isInteger(offsetMinutes)) {
    throw new RangeError(
      `applyOffset() requires an integer minute offset, received ${offsetMinutes}`,
    );
  }

  return new Date(
    base.getTime() + offsetDays * MS_PER_DAY + offsetMinutes * MS_PER_MINUTE,
  );
}

/** The real system clock. The only ambient-time read in the codebase. */
export function systemClock(): Clock {
  return {
    now: () => new Date(),
    isSimulated: false,
  };
}

/** A clock frozen at one instant. Used by tests and by seeding. */
export function fixedClock(at: Date): Clock {
  const ms = at.getTime();
  return {
    // A fresh Date each call, so a caller mutating the result cannot move time.
    now: () => new Date(ms),
    isSimulated: false,
  };
}

/** Wrap a clock with a fixed offset. */
export function offsetClock(
  base: Clock,
  offsetDays: number,
  offsetMinutes: number,
): Clock {
  const shifted = offsetDays !== 0 || offsetMinutes !== 0;
  return {
    now: () => applyOffset(base.now(), offsetDays, offsetMinutes),
    isSimulated: shifted,
  };
}

/**
 * Build the clock for a request from the stored offset.
 *
 * The offset is applied ONLY when `demoMode` is true. An environment holding
 * real citizen data must never have its sense of time shifted by a leftover
 * demo row, so this ignores the stored value outright rather than trusting it
 * to be zero.
 */
export function resolveClock(
  stored: ClockOffset | null,
  options: { demoMode: boolean; base?: Clock },
): Clock {
  const base = options.base ?? systemClock();

  if (!options.demoMode || stored === null) return base;

  return offsetClock(base, stored.offsetDays, stored.offsetMinutes);
}
