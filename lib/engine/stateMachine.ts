/**
 * The benefit lifecycle state machine.
 *
 * Workflow position is explicit state in the database, not something inferred
 * from LLM conversation history. Two reasons: a benefit case lives for months
 * across many sessions and schedulers, and the approval gates have to be
 * structural. "The model decided it was approved" is not an approval.
 *
 * Nothing outside this module may write a lifecycle state. Every accepted
 * transition is paired with an AuditLog row recording actor, reason, and both
 * states, which is what makes the trail reconstructable.
 *
 * The cycle that matters most is ACTION_EXECUTED -> REVERIFYING ->
 * RE_AUDIT_REQUIRED -> GAP_DETECTED -> ... A corrective action that did not
 * work must return the case to diagnosis rather than being marked done. That
 * edge is the difference between a loop and a pipeline.
 */

import type {
  EligibilityVerdict,
  LifecycleState,
  ReceiptState,
} from "@/lib/generated/prisma/enums";

/**
 * Permitted transitions, keyed by current state.
 *
 * Self-transitions are deliberately absent: a state change that changes
 * nothing would pollute the audit trail without recording anything.
 */
export const TRANSITIONS: Record<LifecycleState, readonly LifecycleState[]> = {
  // --- Discovery -----------------------------------------------------------
  DISCOVERED: ["POTENTIAL_ENTITLEMENT", "ELIGIBLE", "MONITORING"],

  // A yellow entitlement becomes eligible once the missing evidence arrives.
  POTENTIAL_ENTITLEMENT: ["ELIGIBLE", "APPLICATION_DRAFT", "MONITORING", "RE_AUDIT_REQUIRED"],

  ELIGIBLE: ["APPLICATION_DRAFT", "MONITORING", "RE_AUDIT_REQUIRED"],

  // --- Application, gated by human approval --------------------------------
  APPLICATION_DRAFT: ["AWAITING_APPLICATION_APPROVAL", "ELIGIBLE"],

  // Approval may be refused, which returns the draft for editing. There is no
  // edge from APPLICATION_DRAFT straight to SUBMITTED: the gate cannot be
  // bypassed.
  AWAITING_APPLICATION_APPROVAL: ["SUBMITTED", "APPLICATION_DRAFT"],

  SUBMITTED: ["PENDING", "APPROVED", "REJECTED", "GAP_DETECTED"],

  PENDING: ["APPROVED", "REJECTED", "GAP_DETECTED", "RE_AUDIT_REQUIRED"],

  APPROVED: ["DISBURSED", "GAP_DETECTED", "MONITORING", "RE_AUDIT_REQUIRED"],

  REJECTED: ["GAP_DETECTED", "APPLICATION_DRAFT"],

  // --- Disbursement and receipt -------------------------------------------
  DISBURSED: [
    "RECEIPT_UNVERIFIED",
    "CITIZEN_CONFIRMED",
    "VERIFIED_RECEIVED",
    "PAYMENT_DISCREPANCY",
  ],

  RECEIPT_UNVERIFIED: [
    "CITIZEN_CONFIRMED",
    "VERIFIED_RECEIVED",
    "PAYMENT_DISCREPANCY",
    "GAP_DETECTED",
    "MONITORING",
  ],

  // A citizen's word can later be upgraded by evidence, or overturned by it.
  CITIZEN_CONFIRMED: ["VERIFIED_RECEIVED", "PAYMENT_DISCREPANCY", "MONITORING", "RE_AUDIT_REQUIRED"],

  // Even a verified receipt stays reopenable: next month's payment may not
  // arrive, and continuous monitoring would be pointless otherwise.
  VERIFIED_RECEIVED: ["MONITORING", "RE_AUDIT_REQUIRED"],

  PAYMENT_DISCREPANCY: ["GAP_DETECTED"],

  // --- Diagnosis, planning, execution --------------------------------------
  GAP_DETECTED: ["ROOT_CAUSE_IDENTIFIED", "MONITORING"],

  ROOT_CAUSE_IDENTIFIED: ["ACTION_PLANNED", "MONITORING"],

  ACTION_PLANNED: ["AWAITING_ACTION_APPROVAL"],

  // The second gate. No edge from ACTION_PLANNED to ACTION_EXECUTED exists.
  AWAITING_ACTION_APPROVAL: ["ACTION_EXECUTED", "ACTION_PLANNED"],

  // Execution is never success. It leads only to re-verification.
  ACTION_EXECUTED: ["REVERIFYING"],

  REVERIFYING: ["RECOVERED", "RE_AUDIT_REQUIRED"],

  RECOVERED: ["MONITORING", "RE_AUDIT_REQUIRED"],

  // --- Monitoring ----------------------------------------------------------
  MONITORING: ["RE_AUDIT_REQUIRED", "GAP_DETECTED", "DISBURSED", "APPLICATION_DRAFT"],

  RE_AUDIT_REQUIRED: [
    "GAP_DETECTED",
    "ROOT_CAUSE_IDENTIFIED",
    "MONITORING",
    "DISBURSED",
    "VERIFIED_RECEIVED",
    "CITIZEN_CONFIRMED",
    "RECEIPT_UNVERIFIED",
    "PAYMENT_DISCREPANCY",
  ],
};

/** Whether a transition is permitted. */
export function canTransition(from: LifecycleState, to: LifecycleState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** The states reachable in one step. Returns a copy. */
export function nextStates(from: LifecycleState): LifecycleState[] {
  return [...(TRANSITIONS[from] ?? [])];
}

/**
 * Throw unless the transition is permitted.
 *
 * Callers should treat a throw as a bug in the orchestrator, not as a
 * condition to catch and ignore: an illegal transition means the workflow has
 * lost track of where a case actually is.
 */
export function assertTransition(
  from: LifecycleState,
  to: LifecycleState,
): void {
  if (!canTransition(from, to)) {
    throw new Error(
      `Illegal lifecycle transition: ${from} -> ${to}. ` +
        `Permitted from ${from}: ${nextStates(from).join(", ") || "(none)"}.`,
    );
  }
}

/** Every state reachable from `start`, by breadth-first search. */
export function reachableStates(start: LifecycleState): Set<LifecycleState> {
  const seen = new Set<LifecycleState>();
  const queue: LifecycleState[] = [start];

  while (queue.length > 0) {
    const current = queue.shift() as LifecycleState;
    for (const next of TRANSITIONS[current] ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }

  return seen;
}

/** The lifecycle state a freshly discovered entitlement starts in. */
export function initialStateFor(verdict: EligibilityVerdict): LifecycleState {
  switch (verdict) {
    case "GREEN":
      return "ELIGIBLE";
    case "YELLOW":
      return "POTENTIAL_ENTITLEMENT";
    case "RED":
      // An excluded scheme stays DISCOVERED: it is recorded, shown with its
      // reason, and left out of the application path. It is not deleted,
      // because eligibility can change and the citizen deserves to see that
      // it was considered.
      return "DISCOVERED";
  }
}

/** The lifecycle state corresponding to a reconciled receipt outcome. */
export function stateForReceipt(receipt: ReceiptState): LifecycleState {
  switch (receipt) {
    case "VERIFIED_RECEIVED":
      return "VERIFIED_RECEIVED";
    case "CITIZEN_CONFIRMED":
      return "CITIZEN_CONFIRMED";
    case "DISBURSED_RECEIPT_UNVERIFIED":
      return "RECEIPT_UNVERIFIED";
    case "PAYMENT_DISCREPANCY":
      return "PAYMENT_DISCREPANCY";
    case "NOT_DISBURSED":
      // Approved but nothing released yet.
      return "APPROVED";
  }
}
