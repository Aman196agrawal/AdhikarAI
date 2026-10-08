/**
 * Entitlement discovery.
 *
 * Answers "what should this citizen be receiving?" and persists the answer as
 * the baseline every later audit reconciles against.
 *
 * This service is entirely DETERMINISTIC. No model call happens here. The
 * pipeline is:
 *
 *   structured pre-filter (state)  ->  rule evaluation  ->  verdict
 *                                  ->  coverage-derived confidence
 *                                  ->  expected amount and schedule
 *
 * Retrieval is a structured filter rather than semantic search, deliberately.
 * With a curated registry, an embedding ranking cannot do better than an
 * exact filter and can do considerably worse: a citizen must never miss an
 * entitlement because a vector lookup scored it low, and "the model ranked it
 * 0.42" is not an explanation anyone can act on.
 *
 * Rules are evaluated from the typed registry in `lib/registry`, which is the
 * single source of truth. The RuleClause rows in the database are a seeded
 * projection of it, kept for inspection and for a future admin view; nothing
 * in the decision path reads them. Each evaluation stores its full clause
 * results as JSON on the entitlement, so the Why? drawer needs no join and a
 * past decision stays readable even if the registry later changes.
 */

import { computeConfidence, type ConfidenceLabel } from "@/lib/engine/confidence";
import { rupees, serialize, type Paise } from "@/lib/engine/money";
import { annualValue } from "@/lib/engine/period";
import { evaluateScheme, type Profile, type SchemeEvaluation } from "@/lib/engine/rules";
import { initialStateFor } from "@/lib/engine/stateMachine";
import { prisma } from "@/lib/db";
import type { BenefitFrequency, EligibilityVerdict } from "@/lib/generated/prisma/enums";
import type { Prisma } from "@/lib/generated/prisma/client";
import { log } from "@/lib/log";
import { schemesForState, SCHEMES } from "@/lib/registry";
import type { SchemeSpec } from "@/lib/registry/types";
import { recordAudit, type Actor } from "./transitions";

export interface DiscoveredEntitlement {
  schemeCode: string;
  schemeName: string;
  schemeNameHi?: string;
  category: string;
  verdict: EligibilityVerdict;
  confidence: number;
  confidenceLabel: ConfidenceLabel;

  /** Per-instalment amount. Null for in-kind and variable benefits. */
  expectedAmountPaise: Paise | null;
  frequency: BenefitFrequency;
  /** Annualised projection. Null when not expressible in rupees. */
  annualValuePaise: Paise | null;
  benefitNote?: string;

  missingEvidence: string[];
  blockingClauses: string[];
  /**
   * Exclusions the citizen must affirm on the application form. Carried
   * forward to approval gate 1 rather than blocking the verdict here.
   */
  pendingDeclarations: string[];
  evaluation: SchemeEvaluation;

  /** Source metadata, so the UI can show how trustworthy the record is. */
  sourceName: string;
  sourceUrl: string;
  lastVerified: string;
  verificationStatus: SchemeSpec["verificationStatus"];
}

/**
 * Evaluate every applicable scheme. Pure: no database, no model.
 *
 * Results are ordered GREEN, then YELLOW, then RED, and within each group by
 * annual value descending, so the most valuable actionable entitlement is
 * first. RED results are retained rather than discarded: the citizen is
 * entitled to see that a scheme was considered and why it does not apply.
 */
export function evaluateEntitlements(
  profile: Profile,
): DiscoveredEntitlement[] {
  const state = profile.state?.value;
  const candidates =
    typeof state === "string" && state.trim() !== ""
      ? schemesForState(state)
      : [...SCHEMES];

  const results = candidates.map((scheme) => {
    const evaluation = evaluateScheme(scheme, profile);
    const confidence = computeConfidence(evaluation);

    const perInstalment =
      scheme.benefitAmountRupees === null
        ? null
        : rupees(scheme.benefitAmountRupees);

    return {
      schemeCode: scheme.code,
      schemeName: scheme.name,
      schemeNameHi: scheme.nameHi,
      category: scheme.category,
      verdict: evaluation.verdict,
      confidence: confidence.confidence,
      confidenceLabel: confidence.label,
      expectedAmountPaise: perInstalment,
      frequency: scheme.frequency,
      annualValuePaise:
        perInstalment === null ? null : annualValue(scheme.frequency, perInstalment),
      benefitNote: scheme.benefitNote,
      missingEvidence: evaluation.missingEvidence,
      blockingClauses: evaluation.blockingClauses,
      pendingDeclarations: evaluation.pendingDeclarations,
      evaluation,
      sourceName: scheme.sourceName,
      sourceUrl: scheme.sourceUrl,
      lastVerified: scheme.lastVerified,
      verificationStatus: scheme.verificationStatus,
    } satisfies DiscoveredEntitlement;
  });

  const rank: Record<EligibilityVerdict, number> = { GREEN: 0, YELLOW: 1, RED: 2 };

  return results.sort((a, b) => {
    if (rank[a.verdict] !== rank[b.verdict]) {
      return rank[a.verdict] - rank[b.verdict];
    }
    const av = a.annualValuePaise ?? 0n;
    const bv = b.annualValuePaise ?? 0n;
    if (av !== bv) return bv > av ? 1 : -1;
    return a.schemeCode.localeCompare(b.schemeCode);
  });
}

/**
 * Serialise a clause evaluation for storage and for the Why? drawer.
 *
 * Stored in full on the entitlement so an explanation never depends on
 * re-joining the registry, and a decision made today stays explainable after
 * a scheme's rules change.
 */
function serialiseEvaluation(entry: DiscoveredEntitlement): Prisma.InputJsonValue {
  return {
    verdict: entry.verdict,
    confidence: entry.confidence,
    confidenceLabel: entry.confidenceLabel,
    pendingDeclarations: entry.pendingDeclarations,
    clauses: entry.evaluation.clauses.map((clause) => ({
      code: clause.clauseCode,
      kind: clause.kind,
      field: clause.field,
      mandatory: clause.mandatory,
      result: clause.result,
      disqualifies: clause.disqualifies,
      provenance: clause.provenance,
      observedValue: clause.observedValue,
      text: clause.text,
      textHi: clause.textHi ?? null,
      sourceName: clause.sourceName,
      sourceUrl: clause.sourceUrl,
      lastVerified: clause.lastVerified,
      evidenceDocs: clause.evidenceDocs,
    })),
  } as Prisma.InputJsonValue;
}

export interface DiscoverResult {
  entitlements: DiscoveredEntitlement[];
  created: number;
  updated: number;
}

/**
 * Evaluate and persist entitlements for a citizen.
 *
 * Upserts by (citizen, scheme) so re-running after new information arrives
 * refreshes verdicts in place rather than accumulating duplicates.
 *
 * Expected payment schedules are deliberately NOT materialised here. A
 * schedule only becomes real once a benefit is approved; generating due dates
 * for a benefit nobody has applied for would make the continuity audit report
 * missed payments for money that was never owed.
 */
export async function discoverAndPersist(input: {
  citizenId: string;
  profile: Profile;
  actor?: Actor;
}): Promise<DiscoverResult> {
  const actor: Actor = input.actor ?? { kind: "agent", name: "discovery" };
  const entitlements = evaluateEntitlements(input.profile);

  const schemeRows = await prisma.scheme.findMany({
    where: { code: { in: entitlements.map((e) => e.schemeCode) } },
    select: { id: true, code: true },
  });
  const schemeIdByCode = new Map(schemeRows.map((s) => [s.code, s.id]));

  let created = 0;
  let updated = 0;

  for (const entry of entitlements) {
    const schemeId = schemeIdByCode.get(entry.schemeCode);
    if (!schemeId) {
      // The registry and the database have diverged, which means the seed was
      // not run. Fail loudly rather than silently dropping an entitlement the
      // citizen may be owed.
      throw new Error(
        `Scheme "${entry.schemeCode}" is in the registry but not in the database. Run \`npm run seed\`.`,
      );
    }

    const existing = await prisma.entitlement.findUnique({
      where: { citizenId_schemeId: { citizenId: input.citizenId, schemeId } },
      select: { id: true, lifecycleState: true, verdict: true },
    });

    const data = {
      verdict: entry.verdict,
      confidence: entry.confidence,
      expectedAmountPaise: entry.expectedAmountPaise,
      frequency: entry.frequency,
      clauseResults: serialiseEvaluation(entry),
      missingEvidence: entry.missingEvidence,
      pendingDeclarations: entry.pendingDeclarations,
    };

    if (!existing) {
      await prisma.entitlement.create({
        data: {
          ...data,
          citizenId: input.citizenId,
          schemeId,
          lifecycleState: initialStateFor(entry.verdict),
        },
      });
      created += 1;
      continue;
    }

    // Re-evaluation updates the verdict and evidence but does NOT reset the
    // lifecycle state: a benefit already submitted or being recovered must not
    // be dragged back to ELIGIBLE because discovery ran again.
    await prisma.entitlement.update({
      where: { id: existing.id },
      data,
    });
    updated += 1;

    if (existing.verdict !== entry.verdict) {
      await recordAudit(prisma, {
        citizenId: input.citizenId,
        actor,
        entity: "Entitlement",
        entityId: existing.id,
        fromState: existing.verdict,
        toState: entry.verdict,
        reason: `Re-evaluation changed the eligibility verdict for ${entry.schemeCode}.`,
      });
    }
  }

  log.info("discovery.completed", {
    citizenId: input.citizenId,
    evaluated: entitlements.length,
    green: entitlements.filter((e) => e.verdict === "GREEN").length,
    yellow: entitlements.filter((e) => e.verdict === "YELLOW").length,
    red: entitlements.filter((e) => e.verdict === "RED").length,
    created,
    updated,
  });

  return { entitlements, created, updated };
}

/**
 * Shape an entitlement for an API response.
 *
 * Paise cross the wire as decimal strings because BigInt cannot be
 * JSON-serialised, and a null amount stays null: it means "not a fixed cash
 * amount", which is not zero.
 */
export function toWire(entry: DiscoveredEntitlement) {
  return {
    schemeCode: entry.schemeCode,
    schemeName: entry.schemeName,
    schemeNameHi: entry.schemeNameHi ?? null,
    category: entry.category,
    verdict: entry.verdict,
    confidence: entry.confidence,
    confidenceLabel: entry.confidenceLabel,
    expectedAmountPaise:
      entry.expectedAmountPaise === null ? null : serialize(entry.expectedAmountPaise),
    annualValuePaise:
      entry.annualValuePaise === null ? null : serialize(entry.annualValuePaise),
    frequency: entry.frequency,
    benefitNote: entry.benefitNote ?? null,
    pendingDeclarations: entry.pendingDeclarations,
    missingEvidence: entry.missingEvidence,
    blockingClauses: entry.blockingClauses,
    source: {
      name: entry.sourceName,
      url: entry.sourceUrl,
      lastVerified: entry.lastVerified,
      verificationStatus: entry.verificationStatus,
    },
    clauses: entry.evaluation.clauses.map((clause) => ({
      code: clause.clauseCode,
      kind: clause.kind,
      mandatory: clause.mandatory,
      result: clause.result,
      disqualifies: clause.disqualifies,
      provenance: clause.provenance,
      text: clause.text,
      textHi: clause.textHi ?? null,
      sourceUrl: clause.sourceUrl,
      lastVerified: clause.lastVerified,
      evidenceDocs: clause.evidenceDocs,
    })),
  };
}
