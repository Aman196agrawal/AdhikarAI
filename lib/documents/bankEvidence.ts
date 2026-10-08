/**
 * Privacy-preserving bank statement verification.
 *
 * The problem this solves: an elderly or rural citizen often genuinely cannot
 * tell whether a transfer arrived. Asking them to reconcile a bank statement
 * is asking the wrong question of the wrong person. So they can hand us the
 * statement instead — and the guarantee we make in return is that we look for
 * ONE transaction and keep nothing else.
 *
 * The pipeline, and what survives each step:
 *
 *     upload            multipart, into a memory Buffer. Never written to disk.
 *       -> sha256       a fingerprint, so we can later say a document was seen
 *       -> extract      the model is asked ONLY for credits matching the
 *                       expected amount within a date window
 *       -> discard      the buffer is dereferenced; nothing is persisted
 *       -> record       { expected, matched, date, last 4 of reference, hash }
 *
 * What is never extracted, let alone stored: the balance, any other
 * transaction, the account number, the account holder's other affairs. The
 * principle is to verify the benefit, not to inspect the person's finances.
 *
 * What this does NOT claim: that deleting a buffer guarantees erasure from
 * every cache, swap file or log in the world. It claims the narrower, true
 * thing — this application never writes the document anywhere, and retains
 * only the fields below.
 */

import { createHash } from "node:crypto";

import { BankEvidenceSchema } from "@/lib/agents/schemas";
import type { Clock } from "@/lib/clock";
import { llm } from "@/lib/llm";
import { log } from "@/lib/log";
import {
  abs,
  nonNegative,
  rupees,
  sub,
  withinTolerance,
  ZERO,
  type Paise,
} from "@/lib/engine/money";
import type { EvidenceResult } from "@/lib/generated/prisma/enums";

/** Accepted upload types. */
export const ACCEPTED_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
] as const;

/** 12 MB. Large enough for a photographed passbook, small enough to bound memory. */
export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

/** How far either side of the expected date to look. */
const WINDOW_BEFORE_DAYS = 15;
const WINDOW_AFTER_DAYS = 30;

/** Default tolerance when matching a credit: exact to the rupee. */
const DEFAULT_TOLERANCE = rupees(0);

const MS_PER_DAY = 86_400_000;

export interface BankEvidenceInput {
  bytes: Uint8Array;
  mimeType: string;
  /** The amount we are looking for. */
  expectedAmount: Paise;
  /** When the government says it was released. */
  expectedOn: Date;
  schemeName: string;
  clock: Clock;
  tolerance?: Paise;
}

/**
 * The ONLY things kept from a bank document.
 *
 * Deliberately a small, closed shape. Adding a field here is a privacy
 * decision, not a convenience, and it should be hard to do by accident.
 */
export interface BankEvidenceResult {
  result: EvidenceResult;
  matchedAmount: Paise | null;
  matchedOn: Date | null;
  /** Last four characters of the reference, for the citizen to recognise. */
  refLast4: string | null;
  /** Fingerprint proving a document was seen, without retaining it. */
  docSha256: string;
  /** Citizen-facing explanation. */
  explanation: string;
  /** Set when the document could not be read at all. */
  failure: "UNREADABLE" | "NOT_A_STATEMENT" | "MODEL_UNAVAILABLE" | null;
}

export function isAcceptedMimeType(mimeType: string): boolean {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(mimeType);
}

const SYSTEM_PROMPT = `You read a bank statement or passbook page and look for ONE specific credit.

Rules you must follow, in order of importance:

1. Return ONLY credits that plausibly match the amount and date window you are given. Ignore every other transaction on the page completely.
2. NEVER return the account number, the account holder's name, the balance, or any transaction that does not match. These are not needed and must not leave the document.
3. For the transaction reference, return ONLY its last four characters.
4. If the image is unreadable, set legible to false. If it is not a bank statement or passbook at all, set notABankStatement to true.
5. Do not guess at a smudged figure. An unreadable amount is not a match.

Return only JSON.`;

/**
 * Extract and match. The caller must not persist `input.bytes`.
 */
export async function verifyBankEvidence(
  input: BankEvidenceInput,
): Promise<BankEvidenceResult> {
  const tolerance = input.tolerance ?? DEFAULT_TOLERANCE;

  // Fingerprint first, so provenance survives even if extraction fails.
  const docSha256 = createHash("sha256").update(input.bytes).digest("hex");

  const from = new Date(input.expectedOn.getTime() - WINDOW_BEFORE_DAYS * MS_PER_DAY);
  const to = new Date(input.expectedOn.getTime() + WINDOW_AFTER_DAYS * MS_PER_DAY);

  const expectedRupees = Number(input.expectedAmount) / 100;

  const outcome = await llm().complete({
    task: "bank.extractMatchingTransactions",
    system: SYSTEM_PROMPT,
    prompt: [
      `Look for a credit of about ₹${expectedRupees.toLocaleString("en-IN")} paid for ${input.schemeName}.`,
      `It should appear between ${from.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)}.`,
      "Return only credits matching that amount and window. Ignore everything else on the page.",
    ].join("\n"),
    schema: BankEvidenceSchema,
    document: { bytes: input.bytes, mimeType: input.mimeType },
  });

  if (!outcome.ok) {
    log.warn("bankEvidence.model_unavailable", {
      reason: outcome.reason,
      // Note what is NOT logged: no document, no bytes, no extracted text.
      docSha256: docSha256.slice(0, 12),
    });
    return {
      result: "NOT_PROVIDED",
      matchedAmount: null,
      matchedOn: null,
      refLast4: null,
      docSha256,
      explanation:
        "We could not read the document automatically just now. Your answer has not been changed, and nothing from the file has been kept.",
      failure: "MODEL_UNAVAILABLE",
    };
  }

  const extraction = outcome.value;

  if (extraction.notABankStatement) {
    return {
      result: "NOT_PROVIDED",
      matchedAmount: null,
      matchedOn: null,
      refLast4: null,
      docSha256,
      explanation:
        "That does not look like a bank statement or passbook page. Nothing from the file has been kept.",
      failure: "NOT_A_STATEMENT",
    };
  }

  if (!extraction.legible) {
    return {
      result: "NOT_PROVIDED",
      matchedAmount: null,
      matchedOn: null,
      refLast4: null,
      docSha256,
      explanation:
        "The document was too unclear to read reliably. A clearer photo would help. Nothing from the file has been kept.",
      failure: "UNREADABLE",
    };
  }

  // Keep only candidates inside the window. The prompt asks for this, but a
  // prompt is not a guarantee, so it is enforced here too.
  const candidates = extraction.matches.filter((match) => {
    const date = new Date(`${match.date}T00:00:00.000Z`);
    return (
      Number.isFinite(date.getTime()) &&
      date >= from &&
      date <= to &&
      Number.isFinite(match.amountRupees) &&
      match.amountRupees > 0
    );
  });

  if (candidates.length === 0) {
    return {
      result: "NO_MATCH",
      matchedAmount: null,
      matchedOn: null,
      refLast4: null,
      docSha256,
      explanation: `We looked for a credit of about ₹${expectedRupees.toLocaleString("en-IN")} between ${from.toISOString().slice(0, 10)} and ${to.toISOString().slice(0, 10)} and did not find one. That does not prove the money never arrived — it may have gone to a different account, or fallen outside the dates we checked.`,
      failure: null,
    };
  }

  // Closest to the expected amount wins.
  const best = candidates.reduce((closest, match) => {
    const a = Math.abs(match.amountRupees - expectedRupees);
    const b = Math.abs(closest.amountRupees - expectedRupees);
    return a < b ? match : closest;
  });

  const matchedAmount = rupees(Math.round(best.amountRupees * 100) / 100);
  const matchedOn = new Date(`${best.date}T00:00:00.000Z`);
  const exact =
    matchedAmount >= input.expectedAmount ||
    withinTolerance(matchedAmount, input.expectedAmount, tolerance);

  const shortfall = nonNegative(sub(input.expectedAmount, matchedAmount));

  log.info("bankEvidence.verified", {
    result: exact ? "MATCHED" : "PARTIAL_MATCH",
    // The amounts are the point of the exercise and are safe to log; the
    // document, the account and every other transaction are not, and are not
    // present here to log.
    expectedPaise: input.expectedAmount.toString(),
    matchedPaise: matchedAmount.toString(),
    docSha256: docSha256.slice(0, 12),
  });

  return {
    result: exact ? "MATCHED" : "PARTIAL_MATCH",
    matchedAmount,
    matchedOn,
    refLast4: best.referenceLast4?.slice(-4) || null,
    docSha256,
    explanation: exact
      ? `We found a credit of ₹${(Number(matchedAmount) / 100).toLocaleString("en-IN")} on ${best.date}${best.referenceLast4 ? `, reference ending ${best.referenceLast4.slice(-4)}` : ""}. That matches what was due, so this payment is confirmed as received.`
      : `We found a credit of ₹${(Number(matchedAmount) / 100).toLocaleString("en-IN")} on ${best.date}, which is ₹${(Number(abs(shortfall)) / 100).toLocaleString("en-IN")} less than the ₹${expectedRupees.toLocaleString("en-IN")} that was due.`,
    failure: null,
  };
}

/** Human-readable size limit, for the upload screen. */
export const MAX_UPLOAD_LABEL = `${Math.round(MAX_UPLOAD_BYTES / (1024 * 1024))} MB`;

export { ZERO };
