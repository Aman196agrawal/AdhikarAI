import { describe, expect, it } from "vitest";

import {
  applyOffset,
  fixedClock,
  offsetClock,
  resolveClock,
  systemClock,
} from "@/lib/clock";

const BASE = new Date("2026-01-15T10:00:00.000Z");

describe("applyOffset", () => {
  it("returns the same instant for a zero offset", () => {
    expect(applyOffset(BASE, 0, 0).toISOString()).toBe(BASE.toISOString());
  });

  it("does not mutate the input date", () => {
    const before = BASE.toISOString();
    applyOffset(BASE, 90, 0);
    expect(BASE.toISOString()).toBe(before);
  });

  it("adds whole days", () => {
    expect(applyOffset(BASE, 1, 0).toISOString()).toBe(
      "2026-01-16T10:00:00.000Z",
    );
  });

  it("adds minutes", () => {
    expect(applyOffset(BASE, 0, 90).toISOString()).toBe(
      "2026-01-15T11:30:00.000Z",
    );
  });

  it("crosses a month boundary", () => {
    const endOfJan = new Date("2026-01-31T12:00:00.000Z");
    expect(applyOffset(endOfJan, 1, 0).toISOString()).toBe(
      "2026-02-01T12:00:00.000Z",
    );
  });

  it("crosses a year boundary", () => {
    const endOfYear = new Date("2026-12-31T12:00:00.000Z");
    expect(applyOffset(endOfYear, 1, 0).toISOString()).toBe(
      "2027-01-01T12:00:00.000Z",
    );
  });

  it("advances three months, which is the continuity-gap demo step", () => {
    // Jan 15 + 90 days lands in April, so Feb/Mar expected payments fall due.
    const advanced = applyOffset(BASE, 90, 0);
    expect(advanced.toISOString()).toBe("2026-04-15T10:00:00.000Z");
  });

  it("accepts negative offsets to look backwards", () => {
    expect(applyOffset(BASE, -15, 0).toISOString()).toBe(
      "2025-12-31T10:00:00.000Z",
    );
  });

  it("rejects a non-integer day offset", () => {
    expect(() => applyOffset(BASE, 1.5, 0)).toThrow(/integer/i);
  });
});

describe("fixedClock", () => {
  it("always reports the same instant", () => {
    const clock = fixedClock(BASE);
    expect(clock.now().toISOString()).toBe(BASE.toISOString());
    expect(clock.now().toISOString()).toBe(BASE.toISOString());
  });

  it("is not simulated, so no demo badge is implied", () => {
    expect(fixedClock(BASE).isSimulated).toBe(false);
  });

  it("hands out copies so callers cannot mutate the clock", () => {
    const clock = fixedClock(BASE);
    const first = clock.now();
    first.setFullYear(1999);
    expect(clock.now().toISOString()).toBe(BASE.toISOString());
  });
});

describe("offsetClock", () => {
  it("shifts a base clock by the offset", () => {
    const clock = offsetClock(fixedClock(BASE), 90, 0);
    expect(clock.now().toISOString()).toBe("2026-04-15T10:00:00.000Z");
  });

  it("reports itself as simulated when the offset is non-zero", () => {
    expect(offsetClock(fixedClock(BASE), 90, 0).isSimulated).toBe(true);
    expect(offsetClock(fixedClock(BASE), 0, 30).isSimulated).toBe(true);
  });

  it("is not simulated when the offset is zero", () => {
    expect(offsetClock(fixedClock(BASE), 0, 0).isSimulated).toBe(false);
  });
});

describe("resolveClock", () => {
  const stored = { offsetDays: 90, offsetMinutes: 0 };

  it("applies a stored offset when demo mode is on", () => {
    const clock = resolveClock(stored, { demoMode: true, base: fixedClock(BASE) });
    expect(clock.now().toISOString()).toBe("2026-04-15T10:00:00.000Z");
    expect(clock.isSimulated).toBe(true);
  });

  it("IGNORES a stored offset when demo mode is off", () => {
    // Safety property: an environment holding real citizen data must never
    // have its sense of time shifted by a leftover demo row.
    const clock = resolveClock(stored, {
      demoMode: false,
      base: fixedClock(BASE),
    });
    expect(clock.now().toISOString()).toBe(BASE.toISOString());
    expect(clock.isSimulated).toBe(false);
  });

  it("treats a missing stored row as no offset", () => {
    const clock = resolveClock(null, { demoMode: true, base: fixedClock(BASE) });
    expect(clock.now().toISOString()).toBe(BASE.toISOString());
    expect(clock.isSimulated).toBe(false);
  });
});

describe("systemClock", () => {
  it("tracks real time and is not simulated", () => {
    const clock = systemClock();
    expect(clock.isSimulated).toBe(false);
    expect(Math.abs(clock.now().getTime() - Date.now())).toBeLessThan(2000);
  });
});
