/**
 * Human review of drafted catalogue rules.
 *
 * The only path by which a rule becomes APPROVED, and therefore the only path
 * by which a catalogue scheme can ever tell a citizen they are eligible
 * (GREEN). Each decision is attributed and timestamped.
 *
 * Two refusals matter most:
 *   - a rule drafted from text that has since changed cannot be approved; it
 *     describes a scheme that no longer exists in that form,
 *   - an edited rule must pass exactly the checks an AI draft does.
 */

import { canonicalValue, ruleProblems } from "@/lib/agents/ruleDrafter";
import { ApiError } from "@/lib/api/http";
import type { Clock } from "@/lib/clock";
import { prisma as defaultDb } from "@/lib/db";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import type { ProfileFieldKey } from "@/lib/registry/types";

export interface RuleEdit {
  kind: "ELIGIBILITY" | "EXCLUSION";
  field: string;
  op: string;
  value: unknown;
  mandatory: boolean;
  text: string;
  sourceQuote: string;
}

async function loadCurrent(db: PrismaClient, ruleId: string) {
  const rule = await db.catalogRule.findUnique({
    where: { id: ruleId },
    include: { scheme: { select: { contentHash: true, status: true } } },
  });
  if (!rule) throw new ApiError("NOT_FOUND", "That rule does not exist.");
  if (rule.sourceHash !== rule.scheme.contentHash || rule.status === "STALE") {
    throw new ApiError(
      "CONFLICT",
      "This rule was drafted from an older version of the scheme's text. It has been superseded; review the current draft instead.",
    );
  }
  return rule;
}

export async function decideRule(input: {
  ruleId: string;
  decision: "APPROVED" | "REJECTED";
  reviewer: string;
  clock: Clock;
  edit?: RuleEdit;
  db?: PrismaClient;
}) {
  const db = input.db ?? defaultDb;
  const rule = await loadCurrent(db, input.ruleId);

  let changes = {};
  if (input.edit) {
    if (input.decision !== "APPROVED") {
      throw new ApiError("BAD_REQUEST", "An edit can only accompany an approval.");
    }
    const problems = ruleProblems(
      {
        kind: input.edit.kind,
        field: input.edit.field,
        op: input.edit.op as never,
        value: input.edit.value as never,
        sourceQuote: input.edit.sourceQuote,
      },
      null,
    );
    if (input.edit.text.trim().length < 5) problems.push("the rule needs a plain-language description");
    if (problems.length > 0) {
      throw new ApiError("UNPROCESSABLE", "The edited rule is not valid.", problems);
    }
    const field = input.edit.field as ProfileFieldKey;
    const value = canonicalValue(field, input.edit.value);
    changes = {
      kind: input.edit.kind,
      field,
      op: input.edit.op,
      value: value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue),
      mandatory: input.edit.mandatory,
      text: input.edit.text.trim(),
      sourceQuote: input.edit.sourceQuote.trim(),
      draftedBy: "human",
    };
  }

  return db.catalogRule.update({
    where: { id: rule.id },
    data: {
      ...changes,
      status: input.decision,
      reviewedBy: input.reviewer,
      reviewedAt: input.clock.now(),
    },
  });
}

/**
 * Replace a scheme's unmapped criteria.
 *
 * A reviewer clears an entry once it is covered by a rule, or once they have
 * confirmed it is not a real condition. Any entry left keeps the scheme's
 * best verdict at YELLOW.
 */
export async function setUnmappedCriteria(input: {
  schemeId: string;
  unmapped: string[];
  db?: PrismaClient;
}) {
  const db = input.db ?? defaultDb;
  const cleaned = input.unmapped.map((s) => s.trim()).filter(Boolean);
  return db.catalogScheme.update({
    where: { id: input.schemeId },
    data: { unmappedCriteria: cleaned },
    select: { id: true, unmappedCriteria: true },
  });
}

/** Schemes with rules waiting for review, most recently changed first. */
export async function reviewQueue(options: { db?: PrismaClient; limit?: number } = {}) {
  const db = options.db ?? defaultDb;
  const schemes = await db.catalogScheme.findMany({
    where: { status: "ACTIVE", draftStatus: "DRAFTED", rules: { some: { status: "DRAFT" } } },
    orderBy: { lastChangedAt: "desc" },
    take: options.limit ?? 50,
    select: {
      id: true,
      externalId: true,
      name: true,
      level: true,
      states: true,
      officialUrl: true,
      lastChangedAt: true,
      eligibilityMd: true,
      exclusionsMd: true,
      unmappedCriteria: true,
      contentHash: true,
      rules: {
        orderBy: { code: "asc" },
        select: {
          id: true,
          code: true,
          kind: true,
          field: true,
          op: true,
          value: true,
          mandatory: true,
          text: true,
          sourceQuote: true,
          status: true,
          sourceHash: true,
          draftedBy: true,
          reviewedBy: true,
        },
      },
    },
  });

  return schemes.map(({ contentHash, rules, ...scheme }) => ({
    ...scheme,
    lastChangedAt: scheme.lastChangedAt.toISOString(),
    // Only rules drafted from the current text are reviewable.
    rules: rules
      .filter((r) => r.sourceHash === contentHash)
      .map((r) => ({ ...r, sourceHash: undefined })),
  }));
}
