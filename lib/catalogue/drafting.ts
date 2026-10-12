/**
 * Draft rules for catalogue schemes whose text is new or has changed.
 *
 * Runs after each sync (scripts/sync-schemes.ts). Picks up schemes marked
 * `draftStatus = PENDING`, asks the rule drafter for DRAFT rules, and stores
 * them against the scheme's current `contentHash`. Nothing here approves a
 * rule; that is a human decision (lib/catalogue/review.ts).
 */

import { draftRules } from "@/lib/agents/ruleDrafter";
import type { Clock } from "@/lib/clock";
import { prisma as defaultDb } from "@/lib/db";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { log } from "@/lib/log";

export interface DraftingSummary {
  attempted: number;
  drafted: number;
  failed: number;
  rules: number;
}

const NO_TEXT = "The source provides no eligibility text, so no rule could be drafted.";

export async function draftPendingRules(options: {
  clock: Clock;
  db?: PrismaClient;
  /** Cap per run, so one night's drafting cost stays bounded. */
  limit?: number;
  runId?: string;
}): Promise<DraftingSummary> {
  const db = options.db ?? defaultDb;
  const summary: DraftingSummary = { attempted: 0, drafted: 0, failed: 0, rules: 0 };

  const pending = await db.catalogScheme.findMany({
    where: { status: "ACTIVE", draftStatus: { in: ["PENDING", "FAILED"] } },
    // Most recently changed first: those are the ones a citizen may be acting on.
    orderBy: { lastChangedAt: "desc" },
    take: options.limit ?? 200,
    select: { id: true, name: true, contentHash: true, eligibilityMd: true, exclusionsMd: true },
  });

  for (const scheme of pending) {
    summary.attempted += 1;

    if (!scheme.eligibilityMd) {
      await replaceDrafts(db, scheme.id, scheme.contentHash, [], [NO_TEXT]);
      summary.drafted += 1;
      continue;
    }

    const result = await draftRules({
      schemeName: scheme.name,
      eligibilityText: scheme.eligibilityMd,
      exclusionsText: scheme.exclusionsMd,
    });

    if (!result.ok) {
      await db.catalogScheme.update({ where: { id: scheme.id }, data: { draftStatus: "FAILED" } });
      summary.failed += 1;
      continue;
    }

    await replaceDrafts(db, scheme.id, scheme.contentHash, result.rules, result.unmapped);
    summary.drafted += 1;
    summary.rules += result.rules.length;
  }

  if (options.runId) {
    await db.schemeSyncRun.update({ where: { id: options.runId }, data: { drafted: summary.drafted } });
  }
  log.info("catalogue.drafting.finished", { ...summary, at: options.clock.now().toISOString() });
  return summary;
}

/**
 * Swap a scheme's unreviewed rules for a fresh draft.
 *
 * APPROVED rules drafted from the current text are kept - a reviewer's work is
 * not thrown away because drafting ran again. Everything else (old drafts,
 * stale and rejected rules) is replaced; the snapshot history keeps the text
 * they came from.
 */
async function replaceDrafts(
  db: PrismaClient,
  schemeId: string,
  contentHash: string,
  rules: Awaited<ReturnType<typeof draftRules>>["rules"],
  unmapped: string[],
): Promise<void> {
  const keep = await db.catalogRule.findMany({
    where: { catalogSchemeId: schemeId, status: "APPROVED", sourceHash: contentHash },
    select: { code: true },
  });
  const keptCodes = new Set(keep.map((r) => r.code));

  await db.$transaction([
    db.catalogRule.deleteMany({
      where: { catalogSchemeId: schemeId, NOT: { status: "APPROVED", sourceHash: contentHash } },
    }),
    db.catalogRule.createMany({
      data: rules
        .filter((rule) => !keptCodes.has(rule.code))
        .map((rule) => ({
          catalogSchemeId: schemeId,
          code: rule.code,
          kind: rule.kind,
          field: rule.field,
          op: rule.op,
          // A JSON null (not SQL NULL): nullary operators carry no operand.
          value: rule.value === null || rule.value === undefined ? Prisma.JsonNull : (rule.value as Prisma.InputJsonValue),
          mandatory: rule.mandatory,
          text: rule.text,
          sourceQuote: rule.sourceQuote,
          sourceHash: contentHash,
          status: "DRAFT" as const,
          draftedBy: "ai",
        })),
    }),
    db.catalogScheme.update({
      where: { id: schemeId },
      data: { draftStatus: "DRAFTED", unmappedCriteria: unmapped },
    }),
  ]);
}
