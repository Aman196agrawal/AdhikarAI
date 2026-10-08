/**
 * Registry access and integrity checking.
 *
 * `validateRegistry` is run by a unit test and by the seed script. A registry
 * with a missing source URL or a malformed clause is a data-quality failure
 * that would silently degrade every eligibility verdict downstream, so it is
 * caught at build time rather than discovered in a demo.
 */

import { SCHEMES } from "./schemes";
import type { ClauseSpec, ProfileFieldKey, SchemeSpec } from "./types";

export { SCHEMES };
export type * from "./types";

/** Operators whose `value` must be a two-element numeric tuple. */
const RANGE_OPS = new Set(["between"]);

/** Operators whose `value` must be an array. */
const LIST_OPS = new Set(["in", "not_in"]);

/** Operators that ignore `value` entirely. */
const NULLARY_OPS = new Set(["exists", "is_true", "is_false"]);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function getScheme(code: string): SchemeSpec | undefined {
  return SCHEMES.find((s) => s.code === code);
}

/** Throws if the code is unknown. Use where a missing scheme is a bug. */
export function requireScheme(code: string): SchemeSpec {
  const scheme = getScheme(code);
  if (!scheme) {
    throw new Error(
      `Unknown scheme code "${code}". Known codes: ${SCHEMES.map((s) => s.code).join(", ")}`,
    );
  }
  return scheme;
}

/** Every profile field any clause in the registry depends on. */
export function referencedProfileFields(): ProfileFieldKey[] {
  const keys = new Set<ProfileFieldKey>();
  for (const scheme of SCHEMES) {
    for (const clause of scheme.clauses) keys.add(clause.field);
  }
  return [...keys].sort();
}

/**
 * Schemes whose state list is empty (all-India) or includes `state`.
 *
 * This is the cheap structured pre-filter that precedes rule evaluation. It is
 * deliberately deterministic SQL-shaped narrowing rather than semantic search:
 * a citizen must never miss an entitlement because an embedding ranked it low.
 */
export function schemesForState(state: string): SchemeSpec[] {
  return SCHEMES.filter(
    (s) => s.states.length === 0 || s.states.includes(state),
  );
}

function validateClause(
  scheme: SchemeSpec,
  clause: ClauseSpec,
  problems: string[],
): void {
  const where = `${scheme.code}/${clause.code}`;

  if (!clause.text.trim()) {
    problems.push(`${where}: clause text is empty`);
  }
  if (!clause.sourceUrl.startsWith("https://")) {
    problems.push(`${where}: sourceUrl must be https, got "${clause.sourceUrl}"`);
  }
  if (!clause.sourceName.trim()) {
    problems.push(`${where}: sourceName is empty`);
  }
  if (!ISO_DATE.test(clause.lastVerified)) {
    problems.push(
      `${where}: lastVerified must be YYYY-MM-DD, got "${clause.lastVerified}"`,
    );
  }

  if (RANGE_OPS.has(clause.op)) {
    const v = clause.value;
    const ok =
      Array.isArray(v) &&
      v.length === 2 &&
      v.every((n) => typeof n === "number") &&
      (v as number[])[0] <= (v as number[])[1];
    if (!ok) {
      problems.push(
        `${where}: "${clause.op}" needs an ascending two-number tuple, got ${JSON.stringify(v)}`,
      );
    }
  } else if (LIST_OPS.has(clause.op)) {
    if (!Array.isArray(clause.value) || clause.value.length === 0) {
      problems.push(
        `${where}: "${clause.op}" needs a non-empty array, got ${JSON.stringify(clause.value)}`,
      );
    }
  } else if (!NULLARY_OPS.has(clause.op)) {
    if (clause.value === null || clause.value === undefined) {
      problems.push(`${where}: "${clause.op}" needs a value`);
    }
  }

  // An EXCLUSION clause reads as "if this holds, the citizen is excluded".
  // Expressing one with a negative operator inverts its meaning, which would
  // silently flip a RED verdict to GREEN.
  if (clause.kind === "EXCLUSION" && (clause.op === "neq" || clause.op === "not_in")) {
    problems.push(
      `${where}: EXCLUSION clauses must state the disqualifying condition positively, not with "${clause.op}"`,
    );
  }
}

/**
 * Check the whole registry. Returns a list of problems; empty means valid.
 */
export function validateRegistry(): string[] {
  const problems: string[] = [];

  const seenSchemeCodes = new Set<string>();

  for (const scheme of SCHEMES) {
    if (seenSchemeCodes.has(scheme.code)) {
      problems.push(`Duplicate scheme code "${scheme.code}"`);
    }
    seenSchemeCodes.add(scheme.code);

    if (!scheme.sourceUrl.startsWith("https://")) {
      problems.push(`${scheme.code}: sourceUrl must be https`);
    }
    if (!ISO_DATE.test(scheme.lastVerified)) {
      problems.push(`${scheme.code}: lastVerified must be YYYY-MM-DD`);
    }
    if (scheme.clauses.length === 0) {
      problems.push(`${scheme.code}: has no clauses, so no verdict is citable`);
    }

    // A cash benefit needs an amount; an in-kind benefit must explain itself
    // rather than defaulting to a rupee value of zero.
    if (scheme.benefitType === "CASH" && scheme.benefitAmountRupees === null) {
      problems.push(`${scheme.code}: CASH benefit has no amount`);
    }
    if (scheme.benefitAmountRupees === null && !scheme.benefitNote) {
      problems.push(
        `${scheme.code}: benefit amount is null and no benefitNote explains what the citizen receives`,
      );
    }
    if (
      scheme.benefitAmountRupees !== null &&
      scheme.benefitAmountRupees <= 0
    ) {
      problems.push(
        `${scheme.code}: benefit amount must be positive, got ${scheme.benefitAmountRupees}`,
      );
    }

    const seenClauseCodes = new Set<string>();
    for (const clause of scheme.clauses) {
      if (seenClauseCodes.has(clause.code)) {
        problems.push(`${scheme.code}: duplicate clause code "${clause.code}"`);
      }
      seenClauseCodes.add(clause.code);
      validateClause(scheme, clause, problems);
    }

    // Every scheme must have at least one mandatory clause, else it would be
    // GREEN for everyone.
    if (!scheme.clauses.some((c) => c.mandatory)) {
      problems.push(
        `${scheme.code}: no mandatory clause, so every citizen would qualify`,
      );
    }

    // Form fields that claim to pre-fill from a profile field must name a real
    // one; the type system covers the key, this covers emptiness.
    for (const field of scheme.formSchema) {
      if (!field.key.trim()) {
        problems.push(`${scheme.code}: form field with empty key`);
      }
    }
  }

  return problems;
}
