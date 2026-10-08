import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "@/lib/clock";
import {
  isAcceptedMimeType,
  verifyBankEvidence,
} from "@/lib/documents/bankEvidence";
import { formatINR, rupees } from "@/lib/engine/money";
import { registerStubFixture, resetLlmProvider } from "@/lib/llm";

const CLOCK = fixedClock(new Date("2026-06-20T10:00:00.000Z"));
const EXPECTED_ON = new Date("2026-06-10T00:00:00.000Z");
const EXPECTED = rupees(2000);

/** A tiny fake document. Its contents are irrelevant; it is never parsed here. */
const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);

interface Match {
  amountRupees: number;
  date: string;
  referenceLast4: string;
  descriptionHint: string;
}

/** Make the stub return a given extraction for this task. */
function stubExtraction(value: {
  matches: Match[];
  legible?: boolean;
  notABankStatement?: boolean;
}): void {
  registerStubFixture("bank.extractMatchingTransactions", () => ({
    matches: value.matches,
    legible: value.legible ?? true,
    notABankStatement: value.notABankStatement ?? false,
  }));
}

async function run(overrides?: { tolerance?: ReturnType<typeof rupees> }) {
  return verifyBankEvidence({
    bytes: BYTES,
    mimeType: "application/pdf",
    expectedAmount: EXPECTED,
    expectedOn: EXPECTED_ON,
    schemeName: "Test Pension",
    clock: CLOCK,
    tolerance: overrides?.tolerance,
  });
}

beforeEach(() => {
  process.env.LLM_PROVIDER = "stub";
  resetLlmProvider();
});

afterEach(() => {
  // Leave the shared fixture registry as the rest of the suite expects it.
  stubExtraction({ matches: [], legible: false });
});

describe("accepted uploads", () => {
  it("accepts PDFs and common photo formats", () => {
    for (const type of ["application/pdf", "image/jpeg", "image/png", "image/webp"]) {
      expect(isAcceptedMimeType(type), type).toBe(true);
    }
  });

  it("rejects anything else", () => {
    for (const type of ["text/csv", "application/zip", "application/msword"]) {
      expect(isAcceptedMimeType(type), type).toBe(false);
    }
  });
});

describe("matching a credit", () => {
  it("confirms an exact match", async () => {
    stubExtraction({
      matches: [
        {
          amountRupees: 2000,
          date: "2026-06-11",
          referenceLast4: "8821",
          descriptionHint: "PENSION DBT",
        },
      ],
    });

    const result = await run();

    expect(result.result).toBe("MATCHED");
    expect(result.matchedAmount).toBe(EXPECTED);
    expect(result.matchedOn?.toISOString().slice(0, 10)).toBe("2026-06-11");
    expect(result.refLast4).toBe("8821");
    expect(result.explanation).toMatch(/confirmed as received/i);
  });

  it("reports a short credit as a partial match with the shortfall", async () => {
    stubExtraction({
      matches: [
        {
          amountRupees: 1200,
          date: "2026-06-11",
          referenceLast4: "8821",
          descriptionHint: "",
        },
      ],
    });

    const result = await run();

    expect(result.result).toBe("PARTIAL_MATCH");
    expect(result.matchedAmount).toBe(rupees(1200));
    expect(result.explanation).toMatch(/800/);
  });

  it("treats an overpayment as settling the amount due", async () => {
    stubExtraction({
      matches: [
        { amountRupees: 2500, date: "2026-06-11", referenceLast4: "8821", descriptionHint: "" },
      ],
    });
    expect((await run()).result).toBe("MATCHED");
  });

  it("accepts a near miss within an explicit tolerance", async () => {
    stubExtraction({
      matches: [
        { amountRupees: 1999, date: "2026-06-11", referenceLast4: "8821", descriptionHint: "" },
      ],
    });

    expect((await run()).result).toBe("PARTIAL_MATCH");
    expect((await run({ tolerance: rupees(5) })).result).toBe("MATCHED");
  });

  it("picks the credit closest to the amount due", async () => {
    stubExtraction({
      matches: [
        { amountRupees: 500, date: "2026-06-11", referenceLast4: "1111", descriptionHint: "" },
        { amountRupees: 2000, date: "2026-06-12", referenceLast4: "2222", descriptionHint: "" },
        { amountRupees: 9000, date: "2026-06-13", referenceLast4: "3333", descriptionHint: "" },
      ],
    });

    const result = await run();
    expect(result.matchedAmount).toBe(EXPECTED);
    expect(result.refLast4).toBe("2222");
  });
});

describe("the date window is enforced in code, not just asked for", () => {
  it("ignores a credit before the window", async () => {
    // Expected 10 June; the window opens 15 days earlier.
    stubExtraction({
      matches: [
        { amountRupees: 2000, date: "2026-05-01", referenceLast4: "8821", descriptionHint: "" },
      ],
    });
    expect((await run()).result).toBe("NO_MATCH");
  });

  it("ignores a credit after the window", async () => {
    stubExtraction({
      matches: [
        { amountRupees: 2000, date: "2026-08-20", referenceLast4: "8821", descriptionHint: "" },
      ],
    });
    expect((await run()).result).toBe("NO_MATCH");
  });

  it("accepts a credit at the edge of the window", async () => {
    stubExtraction({
      matches: [
        { amountRupees: 2000, date: "2026-07-05", referenceLast4: "8821", descriptionHint: "" },
      ],
    });
    expect((await run()).result).toBe("MATCHED");
  });
});

describe("a failed search does not accuse anyone", () => {
  it("says NO_MATCH without claiming the money never arrived", async () => {
    stubExtraction({ matches: [] });
    const result = await run();

    expect(result.result).toBe("NO_MATCH");
    // A statement for the wrong account, or the wrong page, is at least as
    // likely as a missing payment. The wording must not overstate.
    expect(result.explanation).toMatch(/does not prove/i);
    expect(result.explanation).toMatch(/different account|outside the dates/i);
  });

  it("reports an unreadable document as a failure, not as absence", async () => {
    stubExtraction({ matches: [], legible: false });
    const result = await run();

    expect(result.failure).toBe("UNREADABLE");
    expect(result.result).toBe("NOT_PROVIDED");
    expect(result.matchedAmount).toBeNull();
  });

  it("recognises a document that is not a bank statement", async () => {
    stubExtraction({ matches: [], notABankStatement: true });
    const result = await run();

    expect(result.failure).toBe("NOT_A_STATEMENT");
    expect(result.result).toBe("NOT_PROVIDED");
  });
});

describe("what survives the document", () => {
  it("keeps only the matched amount, date, reference suffix and a hash", async () => {
    stubExtraction({
      matches: [
        {
          amountRupees: 2000,
          date: "2026-06-11",
          referenceLast4: "8821",
          descriptionHint: "PENSION DBT CREDIT",
        },
      ],
    });

    const result = await run();

    // The exhaustive list of fields that leave this module.
    expect(Object.keys(result).sort()).toEqual(
      [
        "docSha256",
        "explanation",
        "failure",
        "matchedAmount",
        "matchedOn",
        "refLast4",
        "result",
      ].sort(),
    );
  });

  it("truncates the reference to four characters", async () => {
    stubExtraction({
      matches: [
        {
          amountRupees: 2000,
          date: "2026-06-11",
          referenceLast4: "9988",
          descriptionHint: "",
        },
      ],
    });
    const result = await run();
    expect(result.refLast4).toHaveLength(4);
  });

  it("fingerprints the document so it can be cited without being kept", async () => {
    stubExtraction({
      matches: [
        { amountRupees: 2000, date: "2026-06-11", referenceLast4: "8821", descriptionHint: "" },
      ],
    });

    const first = await run();
    const second = await run();

    expect(first.docSha256).toMatch(/^[0-9a-f]{64}$/);
    // Same bytes, same fingerprint.
    expect(second.docSha256).toBe(first.docSha256);
  });

  it("produces a different fingerprint for different bytes", async () => {
    stubExtraction({
      matches: [
        { amountRupees: 2000, date: "2026-06-11", referenceLast4: "8821", descriptionHint: "" },
      ],
    });

    const a = await run();
    const b = await verifyBankEvidence({
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "application/pdf",
      expectedAmount: EXPECTED,
      expectedOn: EXPECTED_ON,
      schemeName: "Test Pension",
      clock: CLOCK,
    });

    expect(b.docSha256).not.toBe(a.docSha256);
  });

  it("never carries the narration text through", async () => {
    stubExtraction({
      matches: [
        {
          amountRupees: 2000,
          date: "2026-06-11",
          referenceLast4: "8821",
          descriptionHint: "SALARY FROM ACME LTD ACCOUNT 30124578821",
        },
      ],
    });

    const result = await run();
    // Amounts are BigInt paise, which JSON.stringify refuses outright, so the
    // replacer is required here rather than optional.
    const serialised = JSON.stringify(result, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );

    // The narration can contain an employer, a counterparty, or the account
    // number itself. None of it is needed to confirm one payment, so none of
    // it leaves this module.
    expect(serialised).not.toMatch(/ACME/);
    expect(serialised).not.toMatch(/30124578821/);
    expect(serialised).not.toMatch(/SALARY/i);
  });
});

describe("the explanation is written for the citizen", () => {
  it("states the amount and date plainly on a match", async () => {
    stubExtraction({
      matches: [
        { amountRupees: 2000, date: "2026-06-11", referenceLast4: "8821", descriptionHint: "" },
      ],
    });
    const result = await run();

    expect(result.explanation).toContain("2026-06-11");
    expect(result.explanation).toContain("2,000");
    expect(formatINR(result.matchedAmount!)).toBe("₹2,000");
  });
});
