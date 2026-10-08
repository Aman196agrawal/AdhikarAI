import { describe, expect, it } from "vitest";

import {
  add,
  formatINR,
  fromRupeeString,
  isNegative,
  mulInt,
  nonNegative,
  paise,
  rupees,
  serialize,
  deserialize,
  sub,
  sumPaise,
  toRupeeNumber,
  ZERO,
} from "@/lib/engine/money";

describe("money: construction", () => {
  it("converts whole rupees to paise", () => {
    expect(rupees(2000)).toBe(200_000n);
    expect(rupees(600)).toBe(60_000n);
    expect(rupees(0)).toBe(0n);
  });

  it("accepts rupee amounts with exact paise", () => {
    expect(rupees(10.5)).toBe(1_050n);
    expect(rupees(0.01)).toBe(1n);
  });

  it("rejects rupee amounts finer than one paise", () => {
    // Silently truncating sub-paise is how rounding drift enters a ledger.
    expect(() => rupees(10.001)).toThrow(/paise/i);
  });

  it("rejects non-finite input", () => {
    expect(() => rupees(Number.NaN)).toThrow();
    expect(() => rupees(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("rejects fractional paise", () => {
    expect(() => paise(10.5)).toThrow(/integer/i);
  });

  it("accepts bigint paise unchanged", () => {
    expect(paise(200_000n)).toBe(200_000n);
  });
});

describe("money: parsing rupee strings", () => {
  it("parses plain digits", () => {
    expect(fromRupeeString("2000")).toBe(200_000n);
  });

  it("parses the rupee sign and whitespace", () => {
    expect(fromRupeeString(" ₹2000 ")).toBe(200_000n);
    expect(fromRupeeString("Rs. 2000")).toBe(200_000n);
  });

  it("parses Indian digit grouping, not just thousands", () => {
    // 1,20,000 is one lakh twenty thousand - the PMAY-G benefit amount.
    expect(fromRupeeString("1,20,000")).toBe(12_000_000n);
    expect(fromRupeeString("2,000")).toBe(200_000n);
  });

  it("parses a decimal paise component", () => {
    expect(fromRupeeString("2000.50")).toBe(200_050n);
    expect(fromRupeeString("2000.5")).toBe(200_050n);
  });

  it("rejects unparseable input rather than guessing zero", () => {
    expect(() => fromRupeeString("")).toThrow();
    expect(() => fromRupeeString("not money")).toThrow();
    // "Unknown" must never become zero.
    expect(() => fromRupeeString("unknown")).toThrow();
  });
});

describe("money: formatting", () => {
  it("formats using Indian digit grouping", () => {
    expect(formatINR(12_000_000n)).toBe("₹1,20,000");
    expect(formatINR(200_000n)).toBe("₹2,000");
    expect(formatINR(60_000n)).toBe("₹600");
  });

  it("formats large amounts in lakhs correctly", () => {
    // PM-JAY cover of 5 lakh.
    expect(formatINR(rupees(500_000))).toBe("₹5,00,000");
  });

  it("shows paise only when present", () => {
    expect(formatINR(200_050n)).toBe("₹2,000.50");
    expect(formatINR(200_000n)).toBe("₹2,000");
  });

  it("formats zero explicitly", () => {
    expect(formatINR(ZERO)).toBe("₹0");
  });
});

describe("money: arithmetic", () => {
  it("adds and subtracts exactly", () => {
    expect(add(rupees(2000), rupees(600))).toBe(rupees(2600));
    expect(sub(rupees(2000), rupees(1200))).toBe(rupees(800));
  });

  it("sums a list, treating an empty list as zero", () => {
    expect(sumPaise([])).toBe(ZERO);
    expect(sumPaise([rupees(600), rupees(600), rupees(600)])).toBe(rupees(1800));
  });

  it("multiplies by an integer count of installments", () => {
    // PM-KISAN: three installments of 2,000 a year.
    expect(mulInt(rupees(2000), 3)).toBe(rupees(6000));
  });

  it("rejects multiplying by a non-integer", () => {
    expect(() => mulInt(rupees(2000), 1.5)).toThrow(/integer/i);
  });

  it("preserves negative results instead of clamping silently", () => {
    const d = sub(rupees(1200), rupees(2000));
    expect(d).toBe(-80_000n);
    expect(isNegative(d)).toBe(true);
  });

  it("clamps to zero only when explicitly asked", () => {
    expect(nonNegative(sub(rupees(1200), rupees(2000)))).toBe(ZERO);
    expect(nonNegative(rupees(500))).toBe(rupees(500));
  });

  it("never loses precision across many monthly additions", () => {
    // 12 monthly payments of 833.33 - a float sum would drift here.
    const monthly = fromRupeeString("833.33");
    let total = ZERO;
    for (let i = 0; i < 12; i += 1) total = add(total, monthly);
    expect(total).toBe(999_996n);
    expect(formatINR(total)).toBe("₹9,999.96");
  });
});

describe("money: serialisation across the JSON boundary", () => {
  it("round-trips through a string", () => {
    const original = rupees(120_000);
    const wire = serialize(original);
    expect(typeof wire).toBe("string");
    expect(deserialize(wire)).toBe(original);
  });

  it("produces JSON-safe output, since BigInt cannot be stringified", () => {
    expect(() => JSON.stringify({ amount: rupees(2000) })).toThrow();
    expect(JSON.stringify({ amount: serialize(rupees(2000)) })).toBe(
      '{"amount":"200000"}',
    );
  });

  it("exposes a display-only rupee number", () => {
    expect(toRupeeNumber(200_050n)).toBe(2000.5);
  });
});
