/**
 * The Profile Agent.
 *
 * Turns what a citizen says (and what their documents show) into a structured,
 * provenance-tagged profile the rule engine can evaluate.
 *
 * The model's role is narrow: read free text and propose field values. It is
 * not the source of truth. Every proposed value passes through
 * `coerceProfileValue`, and anything that fails its type, domain or plausible
 * range is DROPPED and reported, never repaired by guesswork.
 *
 * Two things here are deliberately NOT the model's job:
 *
 *   - Provenance. Conversation yields SELF_DECLARED or INFERRED and nothing
 *     stronger; only document extraction can produce DOCUMENT_VERIFIED, and
 *     only for the fields that document actually evidenced.
 *   - Deciding what to ask next. The questions worth asking are exactly the
 *     ones the registry's mandatory clauses depend on, which is computable.
 *     Asking the model to improvise them would produce plausible questions
 *     that establish nothing.
 */

import { llm } from "@/lib/llm";
import type { LlmFailureReason } from "@/lib/llm/provider";
import { log } from "@/lib/log";
import type { Profile, ProfileFieldValue } from "@/lib/engine/rules";
import {
  coerceProfileValue,
  isProfileFieldKey,
  PROFILE_FIELD_SPECS,
} from "@/lib/profile/fields";
import { referencedProfileFields, SCHEMES } from "@/lib/registry";
import type { ProfileFieldKey } from "@/lib/registry/types";
import type { ProvenanceLevel } from "@/lib/generated/prisma/enums";
import {
  DocumentExtractionSchema,
  ProfileExtractionSchema,
  type DocumentExtraction,
} from "./schemas";

export interface AcceptedField {
  key: ProfileFieldKey;
  value: string | number | boolean | null;
  provenance: ProvenanceLevel;
  note: string;
}

export interface RejectedField {
  key: string;
  rawValue: unknown;
  reason: string;
}

export interface ProfileAgentResult {
  profile: Profile;
  accepted: AcceptedField[];
  /** Model output that failed deterministic validation. Surfaced, not hidden. */
  rejected: RejectedField[];
  /** Deterministic questions for the fields mandatory clauses still need. */
  questions: ProfileQuestion[];
  conflicts: Array<{ key: string; detail: string }>;
  llm: {
    ok: boolean;
    provider: string;
    attempts: number;
    reason?: LlmFailureReason;
    message?: string;
  };
}

export interface ProfileQuestion {
  key: ProfileFieldKey;
  question: string;
  questionHi?: string;
  /** Scheme codes blocked on this answer, to show why it is worth asking. */
  blocks: string[];
}

/**
 * The field catalogue given to the model.
 *
 * Generated from `PROFILE_FIELD_SPECS` so the prompt and the validator cannot
 * drift apart: adding a field or changing its domain updates both at once.
 */
function fieldCatalogue(): string {
  return referencedProfileFields()
    .map((key) => {
      const spec = PROFILE_FIELD_SPECS[key];
      const domain = spec.domain ? ` one of: ${spec.domain.join(" | ")}` : "";
      const range =
        spec.type === "number" && (spec.min !== undefined || spec.max !== undefined)
          ? ` range ${spec.min ?? "-"}..${spec.max ?? "-"}`
          : "";
      return `- ${key} (${spec.type}${domain}${range}) - ${spec.label}`;
    })
    .join("\n");
}

const SYSTEM_PROMPT = `You extract structured information from what an Indian citizen tells you about their circumstances, so that government benefit eligibility can be checked.

Rules you must follow:

1. Extract ONLY what the citizen actually said, or what follows necessarily from it. Never fill in a typical or likely value.
2. Use SELF_DECLARED when they stated something directly. Use INFERRED only for a strict deduction, and say in the note what it was deduced from. If you are unsure, omit the field entirely rather than guessing.
3. Use null as the value ONLY when the citizen explicitly said they do not have something. Omit the field if the subject never came up.
4. Convert units. Land stated in acres must be converted to hectares (1 acre = 0.4047 hectares) and the note must record the original figure.
5. Never extract an Aadhaar number, a bank account number or any other identifier. You are establishing circumstances, not identity.
6. Values must match the stated type and domain exactly.

Return only JSON.`;

/**
 * Markers fencing the citizen's own words inside the prompt.
 *
 * Without them the field catalogue - which names things like "rural" and
 * "Farmer" - sits in the same blob as the intake, and anything scanning the
 * prompt can mistake the catalogue for something the citizen said.
 */
export const INTAKE_START = "<<<CITIZEN_WORDS";
export const INTAKE_END = "CITIZEN_WORDS>>>";

export interface ExtractProfileInput {
  /** What the citizen said, in their own words. */
  intake: string;
  /** Already-established fields, so the model does not re-derive them. */
  existing?: Profile;
}

/** Extract a profile from conversational intake. */
export async function extractProfile(
  input: ExtractProfileInput,
): Promise<ProfileAgentResult> {
  const known = input.existing
    ? Object.entries(input.existing)
        .map(([key, field]) => `- ${key} = ${JSON.stringify(field?.value)}`)
        .join("\n")
    : "";

  const prompt = [
    "Profile attributes you may extract:",
    fieldCatalogue(),
    known ? `\nAlready established (do not repeat unless corrected):\n${known}` : "",
    "\nExtract only from the citizen's words between the markers below.",
    INTAKE_START,
    input.intake,
    INTAKE_END,
  ]
    .filter(Boolean)
    .join("\n");

  const outcome = await llm().complete({
    task: "profile.extract",
    system: SYSTEM_PROMPT,
    prompt,
    schema: ProfileExtractionSchema,
  });

  const accepted: AcceptedField[] = [];
  const rejected: RejectedField[] = [];
  const conflicts: Array<{ key: string; detail: string }> = [];

  if (outcome.ok) {
    for (const field of outcome.value.fields) {
      if (!isProfileFieldKey(field.key)) {
        rejected.push({
          key: field.key,
          rawValue: field.value,
          reason: "not a recognised profile attribute",
        });
        continue;
      }

      const coerced = coerceProfileValue(field.key, field.value);
      if (!coerced.ok) {
        rejected.push({
          key: field.key,
          rawValue: field.value,
          reason: coerced.reason,
        });
        continue;
      }

      accepted.push({
        key: field.key,
        value: coerced.value,
        provenance: field.provenance,
        note: field.note,
      });
    }

    conflicts.push(...outcome.value.conflicts);
  }

  // Start from what was already known so a later turn adds to the profile
  // rather than replacing it.
  const profile: Profile = { ...(input.existing ?? {}) };
  for (const field of accepted) {
    profile[field.key] = {
      value: field.value,
      provenance: field.provenance,
    } as ProfileFieldValue;
  }

  if (rejected.length > 0) {
    log.warn("profile.extraction_rejected_fields", {
      count: rejected.length,
      keys: rejected.map((r) => r.key),
    });
  }

  return {
    profile,
    accepted,
    rejected,
    questions: missingFieldQuestions(profile),
    conflicts,
    llm: {
      ok: outcome.ok,
      provider: outcome.provider,
      attempts: outcome.attempts,
      ...(outcome.ok
        ? {}
        : { reason: outcome.reason, message: outcome.message }),
    },
  };
}

/**
 * The questions worth asking, computed from the registry.
 *
 * A field is worth asking about exactly when some scheme's MANDATORY clause
 * depends on it and the profile cannot answer it. Ordered by how many schemes
 * each answer would unblock, so the citizen's first answer does the most work.
 */
export function missingFieldQuestions(profile: Profile): ProfileQuestion[] {
  const blockedBy = new Map<ProfileFieldKey, Set<string>>();

  for (const scheme of SCHEMES) {
    for (const clause of scheme.clauses) {
      if (!clause.mandatory) continue;

      const field = profile[clause.field];
      const established =
        field !== undefined &&
        field.provenance !== "MISSING" &&
        field.value !== null;

      if (established) continue;

      // An explicit null is an answer, so it does not need re-asking.
      if (field !== undefined && field.value === null) continue;

      const set = blockedBy.get(clause.field) ?? new Set<string>();
      set.add(scheme.code);
      blockedBy.set(clause.field, set);
    }
  }

  return [...blockedBy.entries()]
    .map(([key, schemes]) => ({
      key,
      question: PROFILE_FIELD_SPECS[key].question,
      questionHi: PROFILE_FIELD_SPECS[key].questionHi,
      blocks: [...schemes].sort(),
    }))
    .sort(
      (a, b) =>
        b.blocks.length - a.blocks.length || a.key.localeCompare(b.key),
    );
}

// ---------------------------------------------------------------------------
// Document extraction
// ---------------------------------------------------------------------------

const DOCUMENT_SYSTEM_PROMPT = `You read a scanned Indian government or bank document and extract only the circumstance facts needed to check benefit eligibility.

Rules you must follow:

1. Extract ONLY what is printed on the document. If a field is unclear, omit it and set legible to false.
2. NEVER extract or return an Aadhaar number, a full bank account number, or any other full identifier. These are not needed and must not leave the document.
3. Convert land area to hectares (1 acre = 0.4047 hectares) and note the printed figure.
4. If the image is not the kind of document claimed, say so in notes.

Return only JSON.`;

export interface ExtractFromDocumentInput {
  bytes: Uint8Array;
  mimeType: string;
  /** What the citizen said this document is, for cross-checking. */
  claimedKind?: string;
}

export interface DocumentAgentResult {
  extraction: DocumentExtraction | null;
  accepted: AcceptedField[];
  rejected: RejectedField[];
  llm: ProfileAgentResult["llm"];
}

/**
 * Extract profile fields from a document.
 *
 * This is the only path that may produce DOCUMENT_VERIFIED provenance, and it
 * does so in code here rather than letting the model assert it. The caller
 * must not persist `bytes`.
 */
export async function extractFromDocument(
  input: ExtractFromDocumentInput,
): Promise<DocumentAgentResult> {
  const outcome = await llm().complete({
    task: "profile.extractDocument",
    system: DOCUMENT_SYSTEM_PROMPT,
    prompt: [
      "Profile attributes you may extract:",
      fieldCatalogue(),
      input.claimedKind
        ? `\nThe citizen says this is a: ${input.claimedKind}`
        : "",
      "\nExtract the eligibility-relevant facts from the attached document.",
    ]
      .filter(Boolean)
      .join("\n"),
    schema: DocumentExtractionSchema,
    document: { bytes: input.bytes, mimeType: input.mimeType },
  });

  const accepted: AcceptedField[] = [];
  const rejected: RejectedField[] = [];

  if (outcome.ok && outcome.value.legible) {
    for (const field of outcome.value.fields) {
      if (!isProfileFieldKey(field.key)) {
        rejected.push({
          key: field.key,
          rawValue: field.value,
          reason: "not a recognised profile attribute",
        });
        continue;
      }

      const coerced = coerceProfileValue(field.key, field.value);
      if (!coerced.ok) {
        rejected.push({ key: field.key, rawValue: field.value, reason: coerced.reason });
        continue;
      }

      accepted.push({
        key: field.key,
        value: coerced.value,
        // Set here, in code. The model has no field in which to claim it.
        provenance: "DOCUMENT_VERIFIED",
        note: field.note,
      });
    }
  }

  return {
    extraction: outcome.ok ? outcome.value : null,
    accepted,
    rejected,
    llm: {
      ok: outcome.ok,
      provider: outcome.provider,
      attempts: outcome.attempts,
      ...(outcome.ok ? {} : { reason: outcome.reason, message: outcome.message }),
    },
  };
}
