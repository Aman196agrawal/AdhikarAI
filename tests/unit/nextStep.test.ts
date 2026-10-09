import { describe, expect, it } from "vitest";

import { nextStep, type NextStepInput } from "@/lib/ui/nextStep";

function input(overrides: Partial<NextStepInput> = {}): NextStepInput {
  return {
    gapKind: "PAYMENT_MISSED",
    actionPlanId: null,
    actionPlanStatus: null,
    pendingApprovalId: null,
    lifecycleState: "GAP_DETECTED",
    ...overrides,
  };
}

describe("the loop advances one honest step at a time", () => {
  it("offers diagnosis for a fresh problem", () => {
    expect(nextStep(input()).kind).toBe("diagnose");
  });

  it("offers review while a plan awaits the citizen", () => {
    expect(
      nextStep(
        input({
          actionPlanId: "p",
          actionPlanStatus: "AWAITING_APPROVAL",
          pendingApprovalId: "a",
          lifecycleState: "AWAITING_ACTION_APPROVAL",
        }),
      ).kind,
    ).toBe("approve");
  });

  it("offers execution only once approved", () => {
    expect(
      nextStep(
        input({
          actionPlanId: "p",
          actionPlanStatus: "APPROVED",
          lifecycleState: "AWAITING_ACTION_APPROVAL",
        }),
      ).kind,
    ).toBe("execute");
  });

  it("offers re-verification after the action ran", () => {
    expect(
      nextStep(
        input({
          actionPlanId: "p",
          actionPlanStatus: "EXECUTED",
          lifecycleState: "ACTION_EXECUTED",
        }),
      ).kind,
    ).toBe("reverify");
  });

  it("offers diagnosing AGAIN after a re-verification failed", () => {
    // The demo-breaking bug. The plan still reads EXECUTED after a failed
    // check, and the old ordering tested that first - offering "check whether
    // it worked" a second time, which attempted an illegal transition.
    const step = nextStep(
      input({
        actionPlanId: "p",
        actionPlanStatus: "EXECUTED",
        lifecycleState: "RE_AUDIT_REQUIRED",
      }),
    );
    expect(step.kind).toBe("diagnose");
    if (step.kind === "diagnose") expect(step.label).toMatch(/again/i);
  });

  it("never offers re-verification from anywhere but ACTION_EXECUTED", () => {
    for (const lifecycleState of ["RE_AUDIT_REQUIRED", "RECOVERED", "GAP_DETECTED"]) {
      const step = nextStep(
        input({ actionPlanId: "p", actionPlanStatus: "EXECUTED", lifecycleState }),
      );
      expect(step.kind, lifecycleState).not.toBe("reverify");
    }
  });
});

describe("not every problem is a corrective case", () => {
  it("offers no corrective action for an unclaimed benefit", () => {
    // The answer to "you never applied" is to apply, not to file a grievance.
    expect(nextStep(input({ gapKind: "NEVER_APPLIED" })).kind).toBe("none");
    expect(nextStep(input({ gapKind: "UNCLAIMED" })).kind).toBe("none");
  });

  it("offers no corrective action for an unconfirmed receipt", () => {
    // The answer is to ask the citizen, not to act on their behalf.
    expect(nextStep(input({ gapKind: "RECEIPT_UNVERIFIED" })).kind).toBe("none");
  });
});
