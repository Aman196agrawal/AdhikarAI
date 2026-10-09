/**
 * Which single action the benefit page offers for a problem.
 *
 * Pure, and kept out of the component so it can be tested. It decides what a
 * citizen is invited to do next, and getting it wrong is not cosmetic: offering
 * "check whether it worked" after a check had already failed would attempt an
 * illegal transition at the exact step the demo turns on.
 */

export interface NextStepInput {
  gapKind: string;
  actionPlanId: string | null;
  actionPlanStatus: string | null;
  pendingApprovalId: string | null;
  lifecycleState: string;
}

export type Step =
  | { kind: "diagnose"; label: string; hint: string }
  | { kind: "approve"; label: string; hint: string }
  | { kind: "execute"; label: string; hint: string }
  | { kind: "reverify"; label: string; hint: string }
  | { kind: "none" };

/**
 * Gaps the corrective-action loop does not handle.
 *
 * An unclaimed benefit is fixed by APPLYING (approval gate 1), an unconfirmed
 * receipt by ANSWERING the question, and a late payment needs nothing. Offering
 * "work out what went wrong" for these would have diagnosed "you never
 * applied" and proposed filing a grievance about it.
 */
const NOT_A_CORRECTIVE_CASE = new Set([
  "NEVER_APPLIED",
  "UNCLAIMED",
  "RECEIPT_UNVERIFIED",
  "PAYMENT_DELAYED",
]);

export function nextStep(props: NextStepInput): Step {
  if (NOT_A_CORRECTIVE_CASE.has(props.gapKind)) return { kind: "none" };

  // Checked FIRST. After a re-verification fails, the plan still reads
  // EXECUTED; testing the plan status first offered "check whether it
  // worked" a second time instead of "work it out again", and clicking it
  // attempted an illegal transition. That is the exact step the demo turns on.
  if (props.lifecycleState === "RE_AUDIT_REQUIRED") {
    return {
      kind: "diagnose",
      label: "Work it out again",
      hint: "That did not fix it. We will diagnose again, knowing what has already been tried.",
    };
  }

  if (props.actionPlanId === null) {
    return {
      kind: "diagnose",
      label: "Work out what went wrong",
      hint: "We will look at the evidence and propose what to do. Nothing is sent yet.",
    };
  }

  if (props.actionPlanStatus === "AWAITING_APPROVAL" && props.pendingApprovalId) {
    return {
      kind: "approve",
      label: "Review what we propose",
      hint: "You decide whether we go ahead.",
    };
  }

  if (props.actionPlanStatus === "APPROVED") {
    return {
      kind: "execute",
      label: "Carry out the approved steps",
      hint: "You approved this. We will do it now and then check whether it worked.",
    };
  }

  // Only from ACTION_EXECUTED - re-verifying from anywhere else is illegal.
  if (props.lifecycleState === "ACTION_EXECUTED") {
    return {
      kind: "reverify",
      label: "Check whether it actually worked",
      hint: "We do not assume it did. We re-read the government record and compare.",
    };
  }

  return { kind: "none" };
}

