import { describe, expect, it } from "vitest";

import {
  assertTransition,
  canTransition,
  initialStateFor,
  nextStates,
  reachableStates,
  stateForReceipt,
  TRANSITIONS,
} from "@/lib/engine/stateMachine";
import { LifecycleState } from "@/lib/generated/prisma/enums";

const ALL_STATES = Object.values(LifecycleState);

describe("the transition table is total", () => {
  it("declares transitions for every lifecycle state", () => {
    // A state missing from the table would make any transition out of it throw
    // at runtime, stranding a benefit mid-loop.
    for (const state of ALL_STATES) {
      expect(TRANSITIONS, state).toHaveProperty(state);
    }
  });

  it("only ever targets declared states", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const to of targets) {
        expect(ALL_STATES, `${from} -> ${to}`).toContain(to);
      }
    }
  });

  it("declares no self-transition, which would make the audit trail meaningless", () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      expect(targets, from).not.toContain(from);
    }
  });

  it("reaches every state from DISCOVERED", () => {
    // An unreachable state is dead code in a workflow, and usually a sign the
    // graph does not match the intended lifecycle.
    const reachable = reachableStates("DISCOVERED");
    const unreachable = ALL_STATES.filter((s) => s !== "DISCOVERED" && !reachable.has(s));
    expect(unreachable).toEqual([]);
  });
});

describe("legal transitions", () => {
  it("permits the application path", () => {
    expect(canTransition("DISCOVERED", "ELIGIBLE")).toBe(true);
    expect(canTransition("ELIGIBLE", "APPLICATION_DRAFT")).toBe(true);
    expect(canTransition("APPLICATION_DRAFT", "AWAITING_APPLICATION_APPROVAL")).toBe(true);
    expect(canTransition("AWAITING_APPLICATION_APPROVAL", "SUBMITTED")).toBe(true);
    expect(canTransition("SUBMITTED", "PENDING")).toBe(true);
    expect(canTransition("PENDING", "APPROVED")).toBe(true);
    expect(canTransition("APPROVED", "DISBURSED")).toBe(true);
  });

  it("permits a rejected approval to return to draft", () => {
    expect(canTransition("AWAITING_APPLICATION_APPROVAL", "APPLICATION_DRAFT")).toBe(true);
  });

  it("permits every receipt outcome from DISBURSED", () => {
    for (const to of [
      "RECEIPT_UNVERIFIED",
      "CITIZEN_CONFIRMED",
      "VERIFIED_RECEIVED",
      "PAYMENT_DISCREPANCY",
    ] as const) {
      expect(canTransition("DISBURSED", to), to).toBe(true);
    }
  });
});

describe("illegal transitions are refused", () => {
  it("cannot jump from discovery straight to recovered", () => {
    expect(canTransition("DISCOVERED", "RECOVERED")).toBe(false);
    expect(() => assertTransition("DISCOVERED", "RECOVERED")).toThrow(
      /DISCOVERED.*RECOVERED/,
    );
  });

  it("cannot submit without passing the approval gate", () => {
    // The human-in-the-loop gate is structural, not advisory.
    expect(canTransition("APPLICATION_DRAFT", "SUBMITTED")).toBe(false);
  });

  it("cannot execute an action without passing the second approval gate", () => {
    expect(canTransition("ACTION_PLANNED", "ACTION_EXECUTED")).toBe(false);
    expect(canTransition("AWAITING_ACTION_APPROVAL", "ACTION_EXECUTED")).toBe(true);
  });

  it("cannot declare recovery without re-verifying first", () => {
    expect(canTransition("ACTION_EXECUTED", "RECOVERED")).toBe(false);
    expect(canTransition("ACTION_EXECUTED", "REVERIFYING")).toBe(true);
    expect(canTransition("REVERIFYING", "RECOVERED")).toBe(true);
  });

  it("names both states in the error, for a usable audit log", () => {
    expect(() => assertTransition("VERIFIED_RECEIVED", "APPLICATION_DRAFT")).toThrow(
      /VERIFIED_RECEIVED/,
    );
  });
});

describe("the agentic loop closes", () => {
  it("walks the hero scenario end to end", () => {
    const path = [
      "DISCOVERED",
      "ELIGIBLE",
      "APPLICATION_DRAFT",
      "AWAITING_APPLICATION_APPROVAL",
      "SUBMITTED",
      "PENDING",
      "APPROVED",
      "DISBURSED",
      "RECEIPT_UNVERIFIED",
      "PAYMENT_DISCREPANCY",
      "GAP_DETECTED",
      "ROOT_CAUSE_IDENTIFIED",
      "ACTION_PLANNED",
      "AWAITING_ACTION_APPROVAL",
      "ACTION_EXECUTED",
      "REVERIFYING",
      "RECOVERED",
      "MONITORING",
    ] as const;

    for (let i = 0; i < path.length - 1; i += 1) {
      expect(
        canTransition(path[i], path[i + 1]),
        `${path[i]} -> ${path[i + 1]}`,
      ).toBe(true);
    }
  });

  it("allows a failed re-verification to re-enter diagnosis", () => {
    // This cycle is the whole product thesis: an action that did not work
    // must send the case back to be diagnosed again, not be marked done.
    const loop = [
      "REVERIFYING",
      "RE_AUDIT_REQUIRED",
      "GAP_DETECTED",
      "ROOT_CAUSE_IDENTIFIED",
      "ACTION_PLANNED",
      "AWAITING_ACTION_APPROVAL",
      "ACTION_EXECUTED",
      "REVERIFYING",
    ] as const;

    for (let i = 0; i < loop.length - 1; i += 1) {
      expect(
        canTransition(loop[i], loop[i + 1]),
        `${loop[i]} -> ${loop[i + 1]}`,
      ).toBe(true);
    }
  });

  it("allows a rejected action plan to be re-planned", () => {
    expect(canTransition("AWAITING_ACTION_APPROVAL", "ACTION_PLANNED")).toBe(true);
  });

  it("keeps monitoring able to reopen a settled benefit", () => {
    // Continuous monitoring is pointless if a verified benefit can never be
    // re-audited when a later payment goes missing.
    expect(canTransition("VERIFIED_RECEIVED", "RE_AUDIT_REQUIRED")).toBe(true);
    expect(canTransition("MONITORING", "RE_AUDIT_REQUIRED")).toBe(true);
    expect(canTransition("RECOVERED", "RE_AUDIT_REQUIRED")).toBe(true);
  });
});

describe("mapping engine outcomes onto lifecycle states", () => {
  it("maps a verdict to a starting state", () => {
    expect(initialStateFor("GREEN")).toBe("ELIGIBLE");
    expect(initialStateFor("YELLOW")).toBe("POTENTIAL_ENTITLEMENT");
    expect(initialStateFor("RED")).toBe("DISCOVERED");
  });

  it("maps every receipt state onto a lifecycle state", () => {
    expect(stateForReceipt("VERIFIED_RECEIVED")).toBe("VERIFIED_RECEIVED");
    expect(stateForReceipt("CITIZEN_CONFIRMED")).toBe("CITIZEN_CONFIRMED");
    expect(stateForReceipt("DISBURSED_RECEIPT_UNVERIFIED")).toBe("RECEIPT_UNVERIFIED");
    expect(stateForReceipt("PAYMENT_DISCREPANCY")).toBe("PAYMENT_DISCREPANCY");
    expect(stateForReceipt("NOT_DISBURSED")).toBe("APPROVED");
  });
});

describe("nextStates", () => {
  it("lists the permitted moves", () => {
    expect(nextStates("ACTION_EXECUTED")).toEqual(["REVERIFYING"]);
  });

  it("returns a copy, so a caller cannot corrupt the table", () => {
    const states = nextStates("ACTION_EXECUTED");
    states.push("RECOVERED");
    expect(nextStates("ACTION_EXECUTED")).toEqual(["REVERIFYING"]);
  });
});
