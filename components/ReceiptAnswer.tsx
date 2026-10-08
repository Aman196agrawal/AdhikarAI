"use client";

/**
 * The YES / NO / NOT SURE answer.
 *
 * The three buttons are deliberately equal in size and visual weight. Styling
 * one as the primary action would nudge people toward it, and nudging someone
 * toward "yes" in a system that decides whether their money is treated as
 * received would manufacture false confirmations from exactly the users least
 * able to check.
 *
 * "Not sure" is presented as a normal answer rather than a failure to answer,
 * because for this audience it is frequently the only honest one.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { buttonClass } from "./ui";

type Answer = "YES" | "NO" | "NOT_SURE";

interface Props {
  citizenId: string;
  paymentId: string;
  schemeName: string;
  periodLabel: string;
  amountLabel: string;
}

export function ReceiptAnswer({
  citizenId,
  paymentId,
  schemeName,
  periodLabel,
  amountLabel,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [submitting, setSubmitting] = useState<Answer | null>(null);
  const [result, setResult] = useState<{
    nextStep: string;
    offerBankVerification: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function answer(choice: Answer): Promise<void> {
    setSubmitting(choice);
    setError(null);

    try {
      const response = await fetch(`/api/payments/${paymentId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ citizenId, answer: choice }),
      });
      const body = (await response.json()) as
        | { ok: true; data: { nextStep: string; offerBankVerification: boolean } }
        | { ok: false; error: { message: string } };

      if (!body.ok) {
        setError(body.error.message);
        return;
      }

      setResult({
        nextStep: body.data.nextStep,
        offerBankVerification: body.data.offerBankVerification,
      });
      startTransition(() => router.refresh());
    } catch {
      setError(
        "We could not record your answer just now. Please try again in a moment.",
      );
    } finally {
      setSubmitting(null);
    }
  }

  if (result) {
    return (
      <div className="rounded-[var(--radius-card)] border bg-surface-sunken p-4">
        <p className="font-medium">Thank you. We have recorded that.</p>
        <p className="mt-1 text-sm text-muted">{result.nextStep}</p>
        {result.offerBankVerification ? (
          <p className="mt-3 text-sm text-muted">
            If you have a photo of your passbook or a bank statement, we can
            check it for <strong className="text-foreground">this one payment</strong>{" "}
            and nothing else. We do not keep the file.
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div>
      <p className="text-lg font-medium">
        The government says {amountLabel} was sent to you for {schemeName} (
        {periodLabel}).
      </p>
      <p className="mt-1 text-xl font-semibold">Did you receive this money?</p>

      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void answer("YES")}
          disabled={submitting !== null || pending}
          className={`${buttonClass.answer} border-[var(--ok-border)] text-[var(--ok)]`}
        >
          {submitting === "YES" ? "Saving…" : "Yes"}
        </button>
        <button
          type="button"
          onClick={() => void answer("NO")}
          disabled={submitting !== null || pending}
          className={`${buttonClass.answer} border-[var(--bad-border)] text-[var(--bad)]`}
        >
          {submitting === "NO" ? "Saving…" : "No"}
        </button>
        <button
          type="button"
          onClick={() => void answer("NOT_SURE")}
          disabled={submitting !== null || pending}
          className={`${buttonClass.answer} border-[var(--warn-border)] text-[var(--warn)]`}
        >
          {submitting === "NOT_SURE" ? "Saving…" : "Not sure"}
        </button>
      </div>

      <p className="mt-3 text-sm text-subtle">
        &ldquo;Not sure&rdquo; is a perfectly good answer. We will help you check.
      </p>

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
