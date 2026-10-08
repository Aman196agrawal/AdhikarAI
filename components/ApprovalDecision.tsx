"use client";

/**
 * The approve / decline control.
 *
 * "No" is a real, unpenalised option: same size, no warning styling, and a
 * plain statement of what happens if you choose it. A consent gate where
 * declining looks like an error is not a consent gate.
 *
 * For an application approval, saying yes then submits it. The two are
 * separate server operations on purpose — approval is recorded before anything
 * leaves the system, so a submission that fails cannot erase the fact that
 * consent was given, and a retry does not need to ask again.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { buttonClass } from "./ui";

interface Props {
  citizenId: string;
  approvalId: string;
  benefitId: string | null;
  approveLabel: string;
  rejectLabel: string;
  rejectHint: string;
  /** Submit the application immediately after approval is recorded. */
  submitAfterApproval?: boolean;
}

export function ApprovalDecision({
  citizenId,
  approvalId,
  benefitId,
  approveLabel,
  rejectLabel,
  rejectHint,
  submitAfterApproval = false,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<"APPROVED" | "REJECTED" | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "APPROVED" | "REJECTED"): Promise<void> {
    setBusy(decision);
    setError(null);

    try {
      const response = await fetch(`/api/approvals/${approvalId}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ citizenId, decision }),
      });
      const payload = (await response.json()) as
        | { ok: true; data: { applicationId?: string } }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        setError(payload.error.message);
        return;
      }

      if (decision === "REJECTED") {
        setOutcome(rejectHint);
        startTransition(() => router.refresh());
        return;
      }

      if (submitAfterApproval && payload.data.applicationId) {
        const submission = await fetch(
          `/api/applications/${payload.data.applicationId}/submit`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ citizenId }),
          },
        );
        const submitted = (await submission.json()) as
          | { ok: true; data: { applicationRef: string } }
          | { ok: false; error: { message: string; details?: { retryable?: boolean } } };

        if (!submitted.ok) {
          // The approval stands; only the submission failed. Say so precisely,
          // because "it did not work" and "you did not agree" are different.
          setOutcome(
            `Your approval has been recorded, but the application could not be lodged: ${submitted.error.message}` +
              (submitted.error.details?.retryable
                ? " You can try sending it again."
                : ""),
          );
          startTransition(() => router.refresh());
          return;
        }

        setOutcome(
          `Sent. The reference is ${submitted.data.applicationRef}. We will now watch what happens to it.`,
        );
        startTransition(() => router.refresh());
        return;
      }

      setOutcome("Approved. We will carry this out and then check whether it worked.");
      startTransition(() => router.refresh());
    } catch {
      setError("We could not record your decision just now. Please try again.");
    } finally {
      setBusy(null);
    }
  }

  if (outcome) {
    return (
      <div className="rounded-[var(--radius-panel)] border bg-surface p-5">
        <p className="font-medium">{outcome}</p>
        <a
          href={benefitId ? `/benefit/${benefitId}` : "/dashboard"}
          className={`${buttonClass.primary} mt-4`}
        >
          Continue
          <span aria-hidden="true">→</span>
        </a>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-panel)] border bg-surface p-5">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void decide("APPROVED")}
          disabled={busy !== null || pending}
          className={buttonClass.primary}
        >
          {busy === "APPROVED" ? "Working…" : approveLabel}
        </button>
        <button
          type="button"
          onClick={() => void decide("REJECTED")}
          disabled={busy !== null || pending}
          className={buttonClass.secondary}
        >
          {busy === "REJECTED" ? "Saving…" : rejectLabel}
        </button>
      </div>
      <p className="mt-3 text-sm text-subtle">{rejectHint}</p>

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
