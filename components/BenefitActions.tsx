"use client";

/**
 * The loop's controls, as the citizen sees them.
 *
 * Only one button is ever offered at a time, matching where the benefit
 * actually is. That is not just tidiness: offering "carry this out" before a
 * plan has been approved would imply the system could act without consent,
 * and offering "check if it worked" before anything was done would invite the
 * reader to believe something had been.
 *
 * Note what is NOT here: no button executes an approved plan silently, and
 * nothing here can approve on the citizen's behalf. Approval happens on its
 * own screen, where the evidence is shown.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { buttonClass } from "./ui";

interface Props {
  citizenId: string;
  entitlementId: string;
  gapId: string;
  actionPlanId: string | null;
  actionPlanStatus: string | null;
  /** The pending approval for the current plan, when there is one. */
  pendingApprovalId: string | null;
  lifecycleState: string;
}

type Step =
  | { kind: "diagnose"; label: string; hint: string }
  | { kind: "approve"; label: string; hint: string }
  | { kind: "execute"; label: string; hint: string }
  | { kind: "reverify"; label: string; hint: string }
  | { kind: "none" };

function nextStep(props: Props): Step {
  if (props.actionPlanId === null) {
    return {
      kind: "diagnose",
      label: "Work out what went wrong",
      hint: "We will look at the evidence and propose what to do. Nothing is sent yet.",
    };
  }

  if (props.actionPlanStatus === "AWAITING_APPROVAL") {
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

  if (
    props.actionPlanStatus === "EXECUTED" ||
    props.actionPlanStatus === "FAILED" ||
    props.lifecycleState === "ACTION_EXECUTED"
  ) {
    return {
      kind: "reverify",
      label: "Check whether it actually worked",
      hint: "We do not assume it did. We re-read the government record and compare.",
    };
  }

  if (props.lifecycleState === "RE_AUDIT_REQUIRED") {
    return {
      kind: "diagnose",
      label: "Work it out again",
      hint: "That did not fix it. We will diagnose again, knowing what has already been tried.",
    };
  }

  return { kind: "none" };
}

export function BenefitActions(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const step = nextStep(props);
  if (step.kind === "none") return null;

  async function run(): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);

    const endpoint =
      step.kind === "diagnose"
        ? `/api/benefits/${props.entitlementId}/diagnose`
        : step.kind === "execute"
          ? `/api/action-plans/${props.actionPlanId}/execute`
          : `/api/benefits/${props.entitlementId}/reverify`;

    const body =
      step.kind === "diagnose"
        ? { citizenId: props.citizenId, gapId: props.gapId }
        : { citizenId: props.citizenId };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as
        | { ok: true; data: Record<string, unknown> }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        setError(payload.error.message);
        return;
      }

      if (step.kind === "reverify") {
        const resolved = payload.data.resolved === true;
        setMessage(
          resolved
            ? "It worked. This benefit has been recovered."
            : "It did not work. We will diagnose it again, taking into account that this action failed.",
        );
      } else if (step.kind === "diagnose") {
        setMessage(
          "We have worked out a likely cause and prepared a plan for you to review.",
        );
      } else {
        setMessage(
          "Done. The outcome is not known yet — the next step is to check whether it actually worked.",
        );
      }

      startTransition(() => router.refresh());
    } catch {
      setError("We could not do that just now. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  if (step.kind === "approve") {
    return (
      <div className="mt-4 border-t pt-4">
        <a href={`/approve/${props.pendingApprovalId}`} className={buttonClass.primary}>
          {step.label}
          <span aria-hidden="true">→</span>
        </a>
        <p className="mt-2 text-sm text-subtle">{step.hint}</p>
      </div>
    );
  }

  return (
    <div className="mt-4 border-t pt-4">
      <button
        type="button"
        onClick={() => void run()}
        disabled={busy || pending}
        className={buttonClass.primary}
      >
        {busy ? "Working…" : step.label}
      </button>
      <p className="mt-2 text-sm text-subtle">{step.hint}</p>

      {message ? (
        <p className="mt-3 rounded-[var(--radius-card)] border bg-surface-sunken px-3 py-2 text-sm">
          {message}
        </p>
      ) : null}
      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-[var(--radius-card)] border border-[var(--bad-border)] bg-[var(--bad-soft)] px-3 py-2 text-sm text-[var(--bad)]"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}
