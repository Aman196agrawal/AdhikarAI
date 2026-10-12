/**
 * Rule drafting for catalogue schemes.
 *
 * Answers "what would this scheme's eligibility text look like as rules our
 * engine can check?" - and nothing more. Every rule it produces is a DRAFT;
 * only a human reviewer can approve one (lib/catalogue/review.ts).
 *
 * The model reads prose, so the guards are in CODE:
 *
 *   - field and operator must come from the fixed lists the engine supports,
 *   - the operand must suit the field (a number for a numeric field, a value
 *     from the field's domain for an enumerated one),
 *   - the clause shape must pass the same check as a hand-written registry
 *     clause (`clauseShapeProblems`),
 *   - the quoted source sentence must actually appear in the scheme's text.
 *
 * A rule that fails any check is not silently dropped: its text is recorded
 * as an UNMAPPED criterion, which caps the scheme's best verdict at YELLOW.
 * Losing a condition must make the system less sure, never more.
 */

import * as z from "zod";

import { llm } from "@/lib/llm";
import { log } from "@/lib/log";
import {
  coerceProfileValue,
  isProfileFieldKey,
  PROFILE_FIELD_KEYS,
  PROFILE_FIELD_SPECS,
} from "@/lib/profile/fields";
import { clauseShapeProblems } from "@/lib/registry";
import type { ClauseOperator, ProfileFieldKey } from "@/lib/registry/types";

export const DRAFTABLE_OPERATORS = [
  "gte",
  "lte",
  "gt",
  "lt",
  "eq",
  "neq",
  "in",
  "not_in",
  "between",
  "exists",
  "is_true",
  "is_false",
] as const satisfies readonly ClauseOperator[];

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const RuleDraftSchema = z.object({
  rules: z.array(
    z.object({
      code: z.string().regex(/^[A-Z0-9_]{3,40}$/),
      kind: z.enum(["ELIGIBILITY", "EXCLUSION"]),
      field: z.string(),
      op: z.enum(DRAFTABLE_OPERATORS),
      value: z.union([Scalar, z.array(Scalar)]),
      mandatory: z.boolean(),
      text: z.string().min(5).max(300),
      sourceQuote: z.string().min(8).max(600),
    }),
  ).max(25),
  unmapped: z.array(z.string().min(3).max(400)).max(25),
});

export type RuleDraft = z.infer<typeof RuleDraftSchema>;

export interface DraftedRule {
  code: string;
  kind: "ELIGIBILITY" | "EXCLUSION";
  field: ProfileFieldKey;
  op: ClauseOperator;
  value: unknown;
  mandatory: boolean;
  text: string;
  sourceQuote: string;
}

export interface DraftRulesInput {
  schemeName: string;
  eligibilityText: string;
  exclusionsText?: string | null;
}

export interface DraftRulesResult {
  ok: boolean;
  rules: DraftedRule[];
  /** Conditions not expressed as a usable rule, in plain words. */
  unmapped: string[];
  /** Why each discarded rule was discarded, for the reviewer and the logs. */
  rejected: Array<{ code: string; reason: string }>;
  llm: { provider: string; attempts: number; reason?: string };
}

function fieldCatalogue(): string {
  return PROFILE_FIELD_KEYS.map((key) => {
    const spec = PROFILE_FIELD_SPECS[key];
    const domain = spec.domain ? ` one of: ${spec.domain.join(" | ")}` : "";
    return `- ${key} (${spec.type}${domain}) - ${spec.label}`;
  }).join("\n");
}

const SYSTEM_PROMPT = `You convert the eligibility conditions of an Indian government scheme into structured rules that a rule engine can check against a citizen's profile.

Rules you must follow:

1. Use ONLY the scheme text you are given. Never add a condition from general knowledge of the scheme, and never assume a typical value.
2. Every rule must quote, in sourceQuote, the exact sentence or phrase of the scheme text it comes from.
3. Use only the profile fields and operators listed. If a condition cannot be expressed with them, put it in "unmapped" in plain words instead of forcing it into a rule.
4. ELIGIBILITY states a requirement ("must be 60 or older": age gte 60). EXCLUSION states the disqualifying condition positively ("income tax payers are not eligible": isIncomeTaxPayer is_true). Never express an exclusion with neq or not_in.
5. Convert units to the field's unit (land in hectares: 1 acre = 0.4047 hectares; income in rupees per year).
6. Set mandatory to false only when the text says the condition is optional or preferred.
7. Do not include state or residence-in-state conditions; those are checked separately.

Return only JSON.`;

const normalise = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Problems with one rule, beyond what the schema already enforced.
 *
 * Exported for the review service, so a reviewer's edit meets the same
 * standard as a draft. `corpus` is the normalised source text; pass null to
 * skip the quotation check (a reviewer may rephrase the quote).
 */
export function ruleProblems(
  rule: Pick<RuleDraft["rules"][number], "kind" | "field" | "op" | "value" | "sourceQuote">,
  corpus: string | null,
): string[] {
  const problems: string[] = [];

  if (!isProfileFieldKey(rule.field)) {
    return [`"${rule.field}" is not a profile field`];
  }
  const spec = PROFILE_FIELD_SPECS[rule.field];

  problems.push(...clauseShapeProblems(rule));

  const numericOps = new Set(["gte", "lte", "gt", "lt", "between"]);
  const booleanOps = new Set(["is_true", "is_false"]);
  if (numericOps.has(rule.op) && spec.type !== "number") {
    problems.push(`"${rule.op}" needs a numeric field; ${rule.field} is ${spec.type}`);
  }
  if (booleanOps.has(rule.op) && spec.type !== "boolean") {
    problems.push(`"${rule.op}" needs a yes/no field; ${rule.field} is ${spec.type}`);
  }

  // Each operand must be a value the field can actually hold.
  if (["eq", "neq", "in", "not_in", "gte", "lte", "gt", "lt", "between"].includes(rule.op)) {
    const operands = Array.isArray(rule.value) ? rule.value : [rule.value];
    for (const operand of operands) {
      const coerced = coerceProfileValue(rule.field, operand);
      if (!coerced.ok) problems.push(`operand ${JSON.stringify(operand)}: ${coerced.reason}`);
    }
  }

  const quote = normalise(rule.sourceQuote);
  if (corpus !== null && (quote.length < 8 || !corpus.includes(quote))) {
    problems.push("its quoted source text does not appear in the scheme's eligibility text");
  }

  return problems;
}

/** Canonicalise operands through the profile coercion, e.g. "sc" -> "SC". */
export function canonicalValue(field: ProfileFieldKey, value: unknown): unknown {
  const one = (v: unknown) => {
    const coerced = coerceProfileValue(field, v);
    return coerced.ok ? coerced.value : v;
  };
  return Array.isArray(value) ? value.map(one) : value === null ? null : one(value);
}

export async function draftRules(input: DraftRulesInput): Promise<DraftRulesResult> {
  const sourceText = [input.eligibilityText, input.exclusionsText ?? ""].join("\n\n");

  const outcome = await llm().complete({
    task: "catalogue.draftRules",
    system: SYSTEM_PROMPT,
    prompt: [
      `Scheme: ${input.schemeName}`,
      "",
      "Profile fields you may use:",
      fieldCatalogue(),
      "",
      `Operators: ${DRAFTABLE_OPERATORS.join(", ")} (between takes [min, max]; in / not_in take a list; exists, is_true, is_false take null).`,
      "",
      "<<<SCHEME_TEXT",
      sourceText,
      "SCHEME_TEXT>>>",
    ].join("\n"),
    schema: RuleDraftSchema,
  });

  if (!outcome.ok) {
    log.warn("ruleDrafter.llm_failed", { scheme: input.schemeName, reason: outcome.reason });
    return {
      ok: false,
      rules: [],
      unmapped: [],
      rejected: [],
      llm: { provider: outcome.provider, attempts: outcome.attempts, reason: outcome.reason },
    };
  }

  const corpus = normalise(sourceText);
  const rules: DraftedRule[] = [];
  const unmapped = [...outcome.value.unmapped];
  const rejected: DraftRulesResult["rejected"] = [];
  const seenCodes = new Set<string>();

  for (const rule of outcome.value.rules) {
    const problems = ruleProblems(rule, corpus);
    if (seenCodes.has(rule.code)) problems.push("duplicate rule code");

    if (problems.length > 0) {
      rejected.push({ code: rule.code, reason: problems.join("; ") });
      // The condition still exists even though this rule cannot express it.
      unmapped.push(rule.text);
      continue;
    }

    seenCodes.add(rule.code);
    const field = rule.field as ProfileFieldKey;
    rules.push({
      code: rule.code,
      kind: rule.kind,
      field,
      op: rule.op,
      value: canonicalValue(field, rule.value),
      mandatory: rule.mandatory,
      text: rule.text,
      sourceQuote: rule.sourceQuote,
    });
  }

  if (rejected.length > 0) {
    log.warn("ruleDrafter.rejected_rules", { scheme: input.schemeName, rejected });
  }

  return {
    ok: true,
    rules,
    unmapped,
    rejected,
    llm: { provider: outcome.provider, attempts: outcome.attempts },
  };
}
