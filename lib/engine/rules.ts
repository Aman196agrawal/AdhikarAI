/**
 * The eligibility rule engine.
 *
 * This module decides GREEN / YELLOW / RED. The LLM does not, and must not:
 * a benefit verdict has to be reproducible, citable and testable, and a model
 * that returns a different answer on a retry is none of those things. The
 * model's job is to *explain* what this code decided.
 *
 * Three invariants hold throughout:
 *
 *   1. UNKNOWN is never guessed. A missing field yields UNKNOWN, never a
 *      default. We do not assert a citizen is not disabled because nobody
 *      asked, and we do not assert they are landless because the field is
 *      blank.
 *   2. UNKNOWN never disqualifies. Only a definite violation does. A false RED
 *      denies someone a benefit they are owed, which is the worst outcome this
 *      system can produce.
 *   3. Every evaluation carries its clause text, source URL and verification
 *      date, so any verdict can be traced to an official rule.
 */

import type {
  ClauseKind,
  ClauseResult,
  DocumentKind,
  EligibilityVerdict,
  ProvenanceLevel,
} from "@/lib/generated/prisma/enums";
import type { ClauseSpec, ProfileFieldKey, SchemeSpec } from "@/lib/registry/types";

/** A scalar profile value. */
export type ProfileValue = string | number | boolean | null;

/** One profile attribute together with how well it is substantiated. */
export interface ProfileFieldValue {
  value: ProfileValue;
  provenance: ProvenanceLevel;
}

/**
 * A citizen profile as the rule engine sees it.
 *
 * A key being absent means "we never established this", which is materially
 * different from a key present with a `null` value ("we asked; there is none").
 * The engine honours that distinction.
 */
export type Profile = Partial<Record<ProfileFieldKey, ProfileFieldValue>>;

/** The outcome of testing one clause against one profile. */
export interface ClauseEvaluation {
  clauseCode: string;
  kind: ClauseKind;
  field: ProfileFieldKey;
  mandatory: boolean;

  /** Whether the clause's stated condition holds. */
  result: ClauseResult;

  /**
   * Whether this outcome rules the citizen out.
   *
   * For an ELIGIBILITY or DEPENDENCY clause, a VIOLATED condition disqualifies.
   * For an EXCLUSION clause the sense is inverted: the clause states the
   * disqualifying condition, so SATISFIED disqualifies. UNKNOWN never does.
   */
  disqualifies: boolean;

  provenance: ProvenanceLevel;
  observedValue: ProfileValue;

  text: string;
  textHi?: string;
  evidenceDocs: DocumentKind[];
  sourceName: string;
  sourceUrl: string;
  lastVerified: string;
}

/** The outcome of testing a whole scheme. */
export interface SchemeEvaluation {
  schemeCode: string;
  verdict: EligibilityVerdict;
  clauses: ClauseEvaluation[];
  /** Mandatory clause codes that are definitely violated (or exclusions that hold). */
  blockingClauses: string[];
  /**
   * Mandatory POSITIVE requirements we could not decide. These hold the
   * verdict at YELLOW, because eligibility genuinely is not established.
   */
  unknownClauses: string[];
  /**
   * Undecided EXCLUSION clauses, which become self-declarations on the
   * application form rather than blocking the verdict.
   *
   * Exclusions are framed negatively ("is an income tax payer", "is a
   * government employee"). Holding a verdict at YELLOW until a citizen has
   * pre-emptively denied every one of them would make almost nothing ever
   * read as eligible, and would ask an elderly claimant eight suspicious
   * questions before telling them anything useful.
   *
   * Real application forms resolve this the same way: the exclusions appear as
   * declarations the applicant signs at submission. So discovery reports
   * eligibility on the positive evidence and carries the exclusions forward to
   * approval gate 1, where the citizen affirms them. Nothing is asserted on
   * their behalf in the meantime.
   */
  pendingDeclarations: string[];
  /**
   * Human-readable descriptions of what would resolve the unknowns, e.g.
   * "BPL / ration card for: applicant must belong to a BPL family".
   */
  missingEvidence: string[];
}

// ---------------------------------------------------------------------------
// Value coercion
// ---------------------------------------------------------------------------

/** Case-insensitive, whitespace-trimmed comparison key for string values. */
function normalise(value: ProfileValue): ProfileValue {
  return typeof value === "string" ? value.trim().toLowerCase() : value;
}

function asNumber(value: ProfileValue): number | null {
  // Deliberately strict: a string that happens to look numeric is not accepted
  // here, because silently coercing free-text intake into a number is how a
  // benefit gets decided on a misread value.
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: ProfileValue): boolean | null {
  return typeof value === "boolean" ? value : null;
}

// ---------------------------------------------------------------------------
// Clause evaluation
// ---------------------------------------------------------------------------

/**
 * Test whether a clause's stated condition holds.
 *
 * Returns UNKNOWN rather than a verdict whenever the profile cannot answer the
 * question, including when the value is of an unusable type.
 */
function testCondition(clause: ClauseSpec, observed: ProfileValue): ClauseResult {
  const held = (value: boolean): ClauseResult => (value ? "SATISFIED" : "VIOLATED");

  switch (clause.op) {
    case "exists": {
      // Reached only when the key is present. An explicit null is handled by
      // the caller as UNKNOWN; an empty string is a definite absence.
      return held(observed !== null && observed !== "");
    }

    case "is_true":
    case "is_false": {
      const actual = asBoolean(observed);
      if (actual === null) return "UNKNOWN";
      return held(clause.op === "is_true" ? actual : !actual);
    }

    case "gte":
    case "lte":
    case "gt":
    case "lt": {
      const actual = asNumber(observed);
      const expected = asNumber(clause.value as ProfileValue);
      if (actual === null || expected === null) return "UNKNOWN";

      if (clause.op === "gte") return held(actual >= expected);
      if (clause.op === "lte") return held(actual <= expected);
      if (clause.op === "gt") return held(actual > expected);
      return held(actual < expected);
    }

    case "between": {
      const actual = asNumber(observed);
      const range = clause.value;
      if (actual === null || !Array.isArray(range) || range.length !== 2) {
        return "UNKNOWN";
      }
      const [min, max] = range as [number, number];
      return held(actual >= min && actual <= max);
    }

    case "eq":
      return held(normalise(observed) === normalise(clause.value as ProfileValue));

    case "neq":
      return held(normalise(observed) !== normalise(clause.value as ProfileValue));

    case "in":
    case "not_in": {
      if (!Array.isArray(clause.value)) return "UNKNOWN";
      const needle = normalise(observed);
      const haystack = (clause.value as ProfileValue[]).map(normalise);
      const present = haystack.includes(needle);
      return held(clause.op === "in" ? present : !present);
    }

    default: {
      // An unrecognised operator must not silently pass a clause.
      const exhaustive: never = clause.op;
      throw new Error(`Unsupported clause operator: ${String(exhaustive)}`);
    }
  }
}

/** Evaluate a single clause against a profile. */
export function evaluateClause(
  clause: ClauseSpec,
  profile: Profile,
): ClauseEvaluation {
  const field = profile[clause.field];

  let result: ClauseResult;
  let provenance: ProvenanceLevel;
  let observedValue: ProfileValue;

  if (field === undefined) {
    // The attribute was never established.
    result = "UNKNOWN";
    provenance = "MISSING";
    observedValue = null;
  } else {
    provenance = field.provenance;
    observedValue = field.value;

    if (field.provenance === "MISSING" || field.value === null) {
      result = "UNKNOWN";
    } else {
      result = testCondition(clause, field.value);
    }
  }

  const disqualifies =
    clause.kind === "EXCLUSION"
      ? result === "SATISFIED"
      : result === "VIOLATED";

  return {
    clauseCode: clause.code,
    kind: clause.kind,
    field: clause.field,
    mandatory: clause.mandatory,
    result,
    disqualifies,
    provenance,
    observedValue,
    text: clause.text,
    textHi: clause.textHi,
    evidenceDocs: clause.evidenceDocs,
    sourceName: clause.sourceName,
    sourceUrl: clause.sourceUrl,
    lastVerified: clause.lastVerified,
  };
}

/** Describe what would resolve an undecided clause, for the citizen. */
function describeMissingEvidence(evaluation: ClauseEvaluation): string {
  const docs = evaluation.evidenceDocs;
  const requirement = evaluation.text;

  if (docs.length === 0) {
    return `Information needed: ${requirement}`;
  }

  const readable = docs
    .map((d) => d.toLowerCase().replace(/_/g, " "))
    .join(" or ");

  return `${readable} needed to confirm: ${requirement}`;
}

/**
 * Evaluate a whole scheme.
 *
 * Verdict precedence is RED, then YELLOW, then GREEN. A definite
 * disqualification is never softened by missing information elsewhere, because
 * telling a citizen they are "potentially eligible" for something they are
 * plainly excluded from wastes their time and their trust.
 */
export function evaluateScheme(
  scheme: SchemeSpec,
  profile: Profile,
): SchemeEvaluation {
  const clauses = scheme.clauses.map((c) => evaluateClause(c, profile));

  const blockingClauses = clauses
    .filter((c) => c.mandatory && c.disqualifies)
    .map((c) => c.clauseCode);

  const undecidedMandatory = clauses.filter(
    (c) => c.mandatory && c.result === "UNKNOWN",
  );

  // An undecided POSITIVE requirement means eligibility is not established.
  // An undecided EXCLUSION becomes a declaration at application time.
  const unknownClauses = undecidedMandatory
    .filter((c) => c.kind !== "EXCLUSION")
    .map((c) => c.clauseCode);

  const pendingDeclarations = undecidedMandatory
    .filter((c) => c.kind === "EXCLUSION")
    .map((c) => c.clauseCode);

  const missingEvidence = undecidedMandatory
    .filter((c) => c.kind !== "EXCLUSION")
    .map(describeMissingEvidence);

  let verdict: EligibilityVerdict;
  if (blockingClauses.length > 0) {
    verdict = "RED";
  } else if (unknownClauses.length > 0) {
    verdict = "YELLOW";
  } else {
    verdict = "GREEN";
  }

  return {
    schemeCode: scheme.code,
    verdict,
    clauses,
    blockingClauses,
    unknownClauses,
    pendingDeclarations,
    missingEvidence,
  };
}
