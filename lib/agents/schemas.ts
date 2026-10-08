/**
 * Zod schemas for every agent's output.
 *
 * These are the contract between the model and the system, and they are
 * written to make the dangerous outputs *unrepresentable* rather than merely
 * discouraged by a prompt.
 *
 * Two examples of that principle:
 *
 *   - Chat extraction cannot claim DOCUMENT_VERIFIED provenance. The enum for
 *     that task simply does not contain it, so no prompt injection or model
 *     misunderstanding can promote hearsay to documentary proof.
 *   - No agent schema contains a verdict, a lifecycle state or a rupee amount
 *     the engine did not compute. The model has no field in which to assert
 *     that someone is eligible or that money is missing.
 */

import * as z from "zod";

import { PROFILE_FIELD_KEYS } from "@/lib/profile/fields";

const profileFieldKey = z.enum(
  PROFILE_FIELD_KEYS as [string, ...string[]],
);

/** A scalar value as extracted. Coerced and range-checked afterwards. */
const extractedValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

// ---------------------------------------------------------------------------
// profile.extract - from conversation
// ---------------------------------------------------------------------------

export const ProfileExtractionSchema = z.object({
  fields: z
    .array(
      z.object({
        key: profileFieldKey.describe(
          "Which profile attribute this is. Must be one of the listed keys.",
        ),
        value: extractedValue.describe(
          "The value as stated. Use null only when the citizen explicitly said they do not have it.",
        ),
        // DOCUMENT_VERIFIED is deliberately absent: nothing said in a
        // conversation is documentary proof, whatever the model infers.
        provenance: z
          .enum(["SELF_DECLARED", "INFERRED"])
          .describe(
            "SELF_DECLARED when the citizen stated it directly. INFERRED when you deduced it from something else they said.",
          ),
        note: z
          .string()
          .min(1)
          .max(300)
          .describe("Brief justification, quoting what the citizen said."),
      }),
    )
    .max(40),
  clarifyingQuestions: z
    .array(z.string().min(1).max(200))
    .max(6)
    .describe(
      "Simple questions, at most six, that would establish the most important missing facts. Use plain language.",
    ),
  conflicts: z
    .array(
      z.object({
        key: profileFieldKey,
        detail: z.string().min(1).max(300),
      }),
    )
    .max(10)
    .describe("Contradictions in what the citizen said."),
});

export type ProfileExtraction = z.infer<typeof ProfileExtractionSchema>;

// ---------------------------------------------------------------------------
// profile.extractDocument - from an uploaded document
// ---------------------------------------------------------------------------

export const DocumentExtractionSchema = z.object({
  documentKind: z
    .enum([
      "AADHAAR",
      "BANK_PASSBOOK",
      "LAND_RECORD",
      "INCOME_CERTIFICATE",
      "AGE_PROOF",
      "DISABILITY_CERTIFICATE",
      "DEATH_CERTIFICATE",
      "RATION_CARD",
      "CASTE_CERTIFICATE",
      "RESIDENCE_PROOF",
      "JOB_CARD",
      "OTHER",
    ])
    .describe("What kind of document this appears to be."),
  /** Only here may provenance be DOCUMENT_VERIFIED, and only for this doc. */
  fields: z
    .array(
      z.object({
        key: profileFieldKey,
        value: extractedValue,
        note: z.string().min(1).max(300),
      }),
    )
    .max(20),
  legible: z
    .boolean()
    .describe("False when the document is too unclear to read reliably."),
  notes: z.string().max(500).describe("Anything a reviewer should know."),
});

export type DocumentExtraction = z.infer<typeof DocumentExtractionSchema>;

// ---------------------------------------------------------------------------
// explain.entitlement - citizen-facing wording for an engine verdict
// ---------------------------------------------------------------------------

export const EntitlementExplanationSchema = z.object({
  headline: z
    .string()
    .min(1)
    .max(140)
    .describe(
      "One short sentence a person with no official vocabulary can read.",
    ),
  detail: z
    .string()
    .min(1)
    .max(700)
    .describe(
      "Two or three plain sentences. Restate only the facts you were given; never introduce an amount or a condition that was not supplied.",
    ),
  nextStep: z
    .string()
    .max(200)
    .describe("The single most useful next action, or empty if none."),
});

export type EntitlementExplanation = z.infer<
  typeof EntitlementExplanationSchema
>;

// ---------------------------------------------------------------------------
// bank.extractMatchingTransactions - the ephemeral verification path
// ---------------------------------------------------------------------------

export const BankEvidenceSchema = z.object({
  /**
   * ONLY transactions matching the expected amount and window. The prompt
   * says so and this schema caps the array, because the privacy guarantee is
   * that unrelated transactions are never extracted, let alone stored.
   */
  matches: z
    .array(
      z.object({
        amountRupees: z.number().describe("Credit amount in rupees."),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .describe("Transaction date as YYYY-MM-DD."),
        /** Last four characters only; never the full reference. */
        referenceLast4: z
          .string()
          .max(4)
          .describe(
            "The last four characters of the transaction reference, for the citizen to recognise. Never the full reference.",
          ),
        descriptionHint: z
          .string()
          .max(80)
          .describe(
            "A short hint such as the scheme name if it appears in the narration. No account identifiers.",
          ),
      }),
    )
    .max(5),
  legible: z.boolean(),
  /** Set when the document is not a bank statement at all. */
  notABankStatement: z.boolean(),
});

export type BankEvidence = z.infer<typeof BankEvidenceSchema>;

// ---------------------------------------------------------------------------
// diagnose.rootCause
// ---------------------------------------------------------------------------

export const RootCauseSchema = z.object({
  kind: z.enum([
    "MISSING_DOCUMENT",
    "DATA_MISMATCH",
    "BANK_ISSUE",
    "AADHAAR_ISSUE",
    "ELIGIBILITY_ISSUE",
    "VERIFICATION_ISSUE",
    "TECHNICAL_FAILURE",
    "APPLICATION_ERROR",
    "REJECTION",
    "DELAYED_PROCESSING",
    "RENEWAL_ISSUE",
    "UNKNOWN",
  ]),
  /**
   * Which supplied evidence items support this. Must be non-empty for any
   * kind other than UNKNOWN; the caller enforces that in code, not in the
   * prompt, and downgrades an unsupported diagnosis to UNKNOWN.
   */
  citedEvidence: z.array(z.string().min(1).max(300)).max(10),
  reasoning: z.string().min(1).max(700),
  recommendedAction: z.enum([
    "REQUEST_DOCUMENT",
    "CORRECT_INFORMATION",
    "REQUEST_CLARIFICATION",
    "RESUBMIT",
    "REAPPLY",
    "SUBMIT_GRIEVANCE",
    "ESCALATE_GRIEVANCE",
    "RETRY_OPERATION",
    "REQUEST_ASSISTED_VERIFICATION",
    "WAIT_AND_MONITOR",
  ]),
});

export type RootCauseOutput = z.infer<typeof RootCauseSchema>;

// ---------------------------------------------------------------------------
// plan.correctiveAction
// ---------------------------------------------------------------------------

export const ActionPlanSchema = z.object({
  summary: z.string().min(1).max(300),
  expectedOutcome: z
    .string()
    .min(1)
    .max(300)
    .describe("What should be true if this works. Used by re-verification."),
  steps: z
    .array(
      z.object({
        kind: z.enum([
          "REQUEST_DOCUMENT",
          "CORRECT_INFORMATION",
          "REQUEST_CLARIFICATION",
          "RESUBMIT",
          "REAPPLY",
          "SUBMIT_GRIEVANCE",
          "ESCALATE_GRIEVANCE",
          "RETRY_OPERATION",
          "REQUEST_ASSISTED_VERIFICATION",
          "WAIT_AND_MONITOR",
        ]),
        description: z.string().min(1).max(300),
        reason: z.string().min(1).max(300),
        documentsRequired: z.array(z.string().max(60)).max(6),
        informationRequired: z.array(z.string().max(120)).max(6),
        channel: z.string().min(1).max(120),
      }),
    )
    .min(1)
    .max(6),
  evidenceNeeded: z
    .array(z.string().min(1).max(200))
    .max(6)
    .describe("What would prove the gap is resolved."),
});

export type ActionPlanOutput = z.infer<typeof ActionPlanSchema>;
