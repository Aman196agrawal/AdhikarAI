/**
 * Lifecycle transitions, with their audit trail.
 *
 * The only place an entitlement's `lifecycleState` is written. Pairing the
 * state change with its AuditLog row in one transaction is what makes the
 * trail trustworthy: there is no code path that moves a benefit forward
 * without recording who moved it and why.
 *
 * `assertTransition` runs first, so an orchestration bug surfaces as a loud
 * failure rather than a benefit silently teleporting between states.
 */

import { ApiError } from "@/lib/api/http";
import { canTransition, nextStates } from "@/lib/engine/stateMachine";
import type { LifecycleState } from "@/lib/generated/prisma/enums";
import type { Prisma } from "@/lib/generated/prisma/client";
import { log } from "@/lib/log";

/**
 * Who initiated a change.
 *
 * Deliberately explicit rather than defaulted: "the system did it" is not an
 * acceptable entry in a trail that may have to explain why a citizen's
 * benefit changed.
 */
export type Actor =
  | { kind: "citizen"; citizenId: string }
  | { kind: "agent"; name: string }
  | { kind: "cron" }
  | { kind: "demo-console" };

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case "citizen":
      return `citizen:${actor.citizenId}`;
    case "agent":
      return `agent:${actor.name}`;
    case "cron":
      return "cron";
    case "demo-console":
      return "demo-console";
  }
}

/** A Prisma client or an interactive transaction. */
export type Db = Prisma.TransactionClient;

export interface TransitionInput {
  entitlementId: string;
  citizenId: string;
  to: LifecycleState;
  actor: Actor;
  /** Why this happened, in terms a reviewer can follow. */
  reason: string;
  /** Id of the audit, gap, verification or execution that justifies it. */
  evidenceRef?: string;
  /** Pass when already known, to avoid a re-read inside a transaction. */
  from?: LifecycleState;
}

/**
 * Move an entitlement to a new state and record it.
 *
 * Returns the previous state. A no-op transition (already in `to`) is skipped
 * rather than logged, so the trail does not fill with entries that record
 * nothing.
 */
export async function transitionEntitlement(
  db: Db,
  input: TransitionInput,
): Promise<{ from: LifecycleState; changed: boolean }> {
  const from =
    input.from ??
    (
      await db.entitlement.findUniqueOrThrow({
        where: { id: input.entitlementId },
        select: { lifecycleState: true },
      })
    ).lifecycleState;

  if (from === input.to) {
    return { from, changed: false };
  }

  if (!canTransition(from, input.to)) {
    // A request that arrives when the benefit has moved on - a stale screen,
    // a second tab, a double tap - is a conflict the caller should be told
    // about, not a server crash. It previously surfaced as a bare 500.
    throw new ApiError(
      "CONFLICT",
      `This benefit is currently "${from.toLowerCase().replace(/_/g, " ")}", so it cannot move to "${input.to.toLowerCase().replace(/_/g, " ")}". Refresh and try again.`,
      { from, to: input.to, permitted: nextStates(from) },
    );
  }

  const write = async (tx: Db): Promise<void> => {
    // Conditional on the state we read. If another request moved the benefit
    // in between, nothing is written and the caller gets a conflict rather
    // than two competing transitions both landing.
    const moved = await tx.entitlement.updateMany({
      where: { id: input.entitlementId, lifecycleState: from },
      data: { lifecycleState: input.to },
    });

    if (moved.count === 0) {
      throw new ApiError(
        "CONFLICT",
        "This benefit was updated by someone else just now. Refresh and try again.",
      );
    }

    await tx.auditLog.create({
      data: {
        citizenId: input.citizenId,
        actor: actorLabel(input.actor),
        entity: "Entitlement",
        entityId: input.entitlementId,
        fromState: from,
        toState: input.to,
        reason: input.reason,
        evidenceRef: input.evidenceRef,
      },
    });
  };

  // The state change and its audit row land together or not at all. A state
  // change with no record of who made it would defeat the point of the trail.
  // (The doc comment always claimed this; the code did not do it.)
  if ("$transaction" in db && typeof db.$transaction === "function") {
    await (db as unknown as {
      $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
    }).$transaction((tx) => write(tx));
  } else {
    await write(db);
  }

  log.info("lifecycle.transition", {
    entitlementId: input.entitlementId,
    from,
    to: input.to,
    actor: actorLabel(input.actor),
  });

  return { from, changed: true };
}

/**
 * Record a consequential action that is not a lifecycle transition, such as
 * an approval, a submission, or a verification.
 */
export async function recordAudit(
  db: Db,
  input: {
    citizenId?: string;
    actor: Actor;
    entity: string;
    entityId: string;
    reason: string;
    evidenceRef?: string;
    fromState?: string;
    toState?: string;
  },
): Promise<void> {
  await db.auditLog.create({
    data: {
      citizenId: input.citizenId,
      actor: actorLabel(input.actor),
      entity: input.entity,
      entityId: input.entityId,
      fromState: input.fromState,
      toState: input.toState,
      reason: input.reason,
      evidenceRef: input.evidenceRef,
    },
  });
}
