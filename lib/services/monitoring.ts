/**
 * Continuous monitoring.
 *
 * AdhikarAI is not a one-time assistant. A pension that arrives in January and
 * stops in March is the failure this exists to catch, and nobody is going to
 * notice it by logging in.
 *
 * The tick selects benefits that something has changed for, records WHY each
 * was selected as a MonitoringEvent, and re-audits them. The audit then
 * discovers what actually changed. That ordering matters: the monitor's job is
 * to decide what deserves a look, not to duplicate the audit's reasoning.
 *
 * Bounded by design. Each run processes at most `batchSize` benefits and
 * returns, so it completes well inside a serverless function's limit. Work
 * left over is picked up by the next tick; a monitor that times out halfway
 * through is worse than one that takes two passes.
 */

import { prisma } from "@/lib/db";
import type { Clock } from "@/lib/clock";
import { log } from "@/lib/log";
import { auditBenefit } from "./audit";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { MonitoringEventKind } from "@/lib/generated/prisma/enums";

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

const MS_PER_DAY = 86_400_000;

/** How stale an audit must be before a healthy benefit is re-checked. */
const RE_AUDIT_AFTER_DAYS = 7;

/** Grace period before an unpaid due instalment is treated as newsworthy. */
const PAYMENT_GRACE_DAYS = 15;

/**
 * Minimum gap between routine re-audits of the same benefit.
 *
 * Without it, every benefit with an open problem - including an unclaimed one
 * that will stay open until the citizen applies - was re-audited every five
 * minutes for ever, writing a MonitoringEvent each time: 288 rows a day per
 * benefit, all saying nothing new. Benefits pay monthly; checking each one a
 * few times a day loses nothing.
 */
const MIN_RECHECK_HOURS = 6;

/** Lifecycle states that are settled enough not to need routine re-auditing. */
const DORMANT_STATES = ["DISCOVERED", "POTENTIAL_ENTITLEMENT"] as const;

export interface MonitoringCandidate {
  entitlementId: string;
  citizenId: string;
  schemeCode: string;
  kind: MonitoringEventKind;
  reason: string;
  payload: Record<string, unknown>;
}

export interface TickResult {
  checkedAt: string;
  /** Benefits selected for a look this run. */
  candidates: number;
  /** Benefits actually re-audited (bounded by batchSize). */
  audited: number;
  /** Audits that found something needing action. */
  actionRequired: number;
  needsVerification: number;
  healthy: number;
  events: Array<{ kind: MonitoringEventKind; schemeCode: string; reason: string }>;
  /** True when more work remains for the next tick. */
  moreRemaining: boolean;
}

/**
 * Find benefits worth re-auditing.
 *
 * Deliberately conservative: a benefit is selected only when a concrete
 * condition holds, not merely because time passed. A monitor that re-audits
 * everything every run produces noise, and noise is how a real missed payment
 * gets ignored.
 */
export async function findCandidates(input: {
  clock: Clock;
  citizenId?: string;
  limit: number;
  /** Ignore the re-check throttle. Used by the demo console's manual pass. */
  force?: boolean;
}): Promise<MonitoringCandidate[]> {
  const now = input.clock.now();
  const candidates: MonitoringCandidate[] = [];
  const seen = new Set<string>();

  const scope = input.citizenId ? { citizenId: input.citizenId } : {};

  // Benefits audited recently enough that another look would add nothing.
  const recentlyAudited = new Set<string>();
  if (!input.force) {
    const recent = await prisma.benefitLedger.findMany({
      where: {
        entitlement: scope,
        lastAuditAt: { gt: new Date(now.getTime() - MIN_RECHECK_HOURS * 3_600_000) },
      },
      select: { entitlementId: true },
    });
    for (const row of recent) recentlyAudited.add(row.entitlementId);
  }

  const add = (candidate: MonitoringCandidate): void => {
    if (recentlyAudited.has(candidate.entitlementId)) return;
    if (seen.has(candidate.entitlementId)) return;
    seen.add(candidate.entitlementId);
    candidates.push(candidate);
  };

  // 1. An expected instalment is due, past grace, with no payment recorded.
  //    This is the continuity case and the highest-value signal.
  //
  //    Matched to payments by period. This used to filter on the
  //    ExpectedPayment -> Payment relation, which nothing ever populates, so
  //    every past instalment looked unpaid for ever: paid benefits were
  //    re-audited on every pass, and the event log claimed "nothing recorded"
  //    for months that had been paid.
  const overdueRaw = await prisma.expectedPayment.findMany({
    where: {
      dueOn: { lte: new Date(now.getTime() - PAYMENT_GRACE_DAYS * MS_PER_DAY) },
      entitlement: scope,
    },
    include: {
      entitlement: {
        include: {
          scheme: { select: { code: true } },
          payments: { select: { periodLabel: true, receiptState: true } },
        },
      },
    },
    orderBy: { dueOn: "asc" },
    // Over-fetch: most past instalments are paid and are filtered out below.
    take: input.limit * 20,
  });

  const overdue = overdueRaw.filter(
    (row) =>
      !row.entitlement.payments.some(
        // A disbursement that never left (NOT_DISBURSED) does not count.
        (p) => p.periodLabel === row.periodLabel && p.receiptState !== "NOT_DISBURSED",
      ),
  );

  for (const row of overdue) {
    const overdueDays = Math.round(
      (now.getTime() - row.dueOn.getTime()) / MS_PER_DAY,
    );
    add({
      entitlementId: row.entitlementId,
      citizenId: row.entitlement.citizenId,
      schemeCode: row.entitlement.scheme.code,
      kind: "PAYMENT_MISSED",
      reason: `The ${row.periodLabel} payment was due on ${row.dueOn.toISOString().slice(0, 10)} and is ${overdueDays} days overdue with nothing recorded.`,
      payload: {
        periodLabel: row.periodLabel,
        dueOn: row.dueOn.toISOString(),
        overdueDays,
      },
    });
  }

  // 2. An unresolved gap that is not already being worked on.
  const unresolved = await prisma.entitlement.findMany({
    where: {
      ...scope,
      gaps: { some: { resolvedAt: null } },
      lifecycleState: {
        notIn: [
          "AWAITING_ACTION_APPROVAL",
          "ACTION_EXECUTED",
          "REVERIFYING",
          ...DORMANT_STATES,
        ],
      },
    },
    include: {
      scheme: { select: { code: true } },
      gaps: { where: { resolvedAt: null }, take: 1, orderBy: { detectedAt: "desc" } },
    },
    take: input.limit,
  });

  for (const row of unresolved) {
    add({
      entitlementId: row.id,
      citizenId: row.citizenId,
      schemeCode: row.scheme.code,
      kind: "UNRESOLVED_AUDIT",
      reason: `An unresolved problem (${row.gaps[0]?.kind ?? "unknown"}) is still open on this benefit.`,
      payload: { gapKind: row.gaps[0]?.kind ?? null },
    });
  }

  // 3. A benefit whose audit has gone stale. This is what makes the
  //    monitoring continuous rather than event-driven only: a payment can
  //    stop without any event on our side to notice it.
  const stale = await prisma.entitlement.findMany({
    where: {
      ...scope,
      lifecycleState: { notIn: [...DORMANT_STATES] },
      OR: [
        { ledger: null, application: { isNot: null } },
        {
          ledger: {
            lastAuditAt: {
              lt: new Date(now.getTime() - RE_AUDIT_AFTER_DAYS * MS_PER_DAY),
            },
          },
        },
      ],
    },
    include: { scheme: { select: { code: true } }, ledger: true },
    take: input.limit,
  });

  for (const row of stale) {
    add({
      entitlementId: row.id,
      citizenId: row.citizenId,
      schemeCode: row.scheme.code,
      kind: "STATUS_CHANGED",
      reason: row.ledger?.lastAuditAt
        ? `This benefit has not been checked since ${row.ledger.lastAuditAt.toISOString().slice(0, 10)}.`
        : "This benefit has an application but has never been audited.",
      payload: {
        lastAuditAt: row.ledger?.lastAuditAt?.toISOString() ?? null,
      },
    });
  }

  return candidates;
}

/**
 * Run one monitoring pass.
 *
 * Each candidate gets a MonitoringEvent row recording why it was selected,
 * which is then linked to the audit it triggered - so "why was this
 * re-checked?" has an answer.
 */
export async function runMonitoringTick(input: {
  clock: Clock;
  citizenId?: string;
  batchSize?: number;
  /** Skip the re-check throttle (the demo console's manual pass). */
  force?: boolean;
}): Promise<TickResult> {
  const batchSize = input.batchSize ?? 25;
  const now = input.clock.now();

  // Over-fetch by one to tell whether more work remains.
  const candidates = await findCandidates({
    clock: input.clock,
    citizenId: input.citizenId,
    limit: batchSize + 1,
    force: input.force,
  });

  const batch = candidates.slice(0, batchSize);
  const moreRemaining = candidates.length > batchSize;

  let actionRequired = 0;
  let needsVerification = 0;
  let healthy = 0;
  let audited = 0;

  const events: TickResult["events"] = [];

  for (const candidate of batch) {
    const event = await prisma.monitoringEvent.create({
      data: {
        citizenId: candidate.citizenId,
        entitlementId: candidate.entitlementId,
        kind: candidate.kind,
        payload: asJson({ reason: candidate.reason, ...candidate.payload }),
        detectedAt: now,
      },
    });

    events.push({
      kind: candidate.kind,
      schemeCode: candidate.schemeCode,
      reason: candidate.reason,
    });

    try {
      const audit = await auditBenefit({
        citizenId: candidate.citizenId,
        entitlementId: candidate.entitlementId,
        clock: input.clock,
        actor: { kind: "cron" },
        triggeredByEventId: event.id,
      });

      audited += 1;
      if (audit.decision === "ACTION_REQUIRED") actionRequired += 1;
      else if (audit.decision === "NEEDS_VERIFICATION") needsVerification += 1;
      else healthy += 1;

      await prisma.monitoringEvent.update({
        where: { id: event.id },
        data: { processedAt: now, triggeredAuditId: audit.auditId },
      });
    } catch (error) {
      // One benefit failing must not abort the whole pass. The event stays
      // unprocessed so the next tick retries it.
      log.error("monitoring.audit_failed", {
        entitlementId: candidate.entitlementId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  log.info("monitoring.tick", {
    candidates: candidates.length,
    audited,
    actionRequired,
    needsVerification,
    healthy,
    moreRemaining,
  });

  return {
    checkedAt: now.toISOString(),
    candidates: candidates.length,
    audited,
    actionRequired,
    needsVerification,
    healthy,
    events,
    moreRemaining,
  };
}

/** Unprocessed monitoring events, for the dashboard's activity feed. */
export async function recentEvents(
  citizenId: string,
  limit = 20,
): Promise<
  Array<{
    id: string;
    kind: MonitoringEventKind;
    reason: string;
    detectedAt: string;
    processed: boolean;
  }>
> {
  const rows = await prisma.monitoringEvent.findMany({
    where: { citizenId },
    orderBy: { detectedAt: "desc" },
    take: limit,
  });

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    reason:
      (row.payload as { reason?: string } | null)?.reason ?? "Checked on schedule.",
    detectedAt: row.detectedAt.toISOString(),
    processed: row.processedAt !== null,
  }));
}
