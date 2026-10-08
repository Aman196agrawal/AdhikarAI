"use client";

/**
 * Bank statement upload.
 *
 * Offered only after the citizen has said "no" or "not sure", because that is
 * the only point at which it helps. Asking for a bank statement up front would
 * be asking everyone to hand over their finances to claim a pension.
 *
 * The privacy promise is stated before the file picker, not buried in a
 * policy: we look for one payment, we keep four facts, we do not keep the
 * file. Someone being asked to hand over a bank statement deserves to read
 * that first and decide.
 */

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { buttonClass } from "./ui";

interface Props {
  citizenId: string;
  paymentId: string;
}

interface Outcome {
  ok: boolean;
  explanation: string;
  privacyNote?: string;
  refLast4?: string | null;
}

export function BankEvidenceUpload({ citizenId, paymentId }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setOutcome(null);

    const form = new FormData();
    form.set("citizenId", citizenId);
    form.set("paymentId", paymentId);
    form.set("file", file);

    try {
      const response = await fetch("/api/verify/bank-evidence", {
        method: "POST",
        body: form,
      });
      const payload = (await response.json()) as
        | {
            ok: true;
            data: { explanation: string; privacyNote: string; refLast4: string | null };
          }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        setOutcome({ ok: false, explanation: payload.error.message });
        return;
      }

      setOutcome({
        ok: true,
        explanation: payload.data.explanation,
        privacyNote: payload.data.privacyNote,
        refLast4: payload.data.refLast4,
      });
      startTransition(() => router.refresh());
    } catch {
      setOutcome({
        ok: false,
        explanation:
          "We could not check the document just now. Nothing from the file has been kept. Please try again in a moment.",
      });
    } finally {
      setBusy(false);
      // Clear the picker so the same file can be retried.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="mt-4 rounded-[var(--radius-card)] border bg-surface p-4">
      <h3 className="font-semibold">Shall we check your bank record?</h3>

      <p className="mt-1 text-sm text-muted">
        If you have a photo of your passbook page, or a bank statement, we can
        look for this one payment.
      </p>

      {/* Stated before the file picker, not after. */}
      <ul className="mt-3 space-y-1 text-sm text-muted">
        <li className="flex gap-2">
          <span aria-hidden="true" className="text-[var(--ok)]">
            ✓
          </span>
          We look for one payment, of the amount due, around the date it was
          sent.
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="text-[var(--ok)]">
            ✓
          </span>
          We keep four things: the amount found, its date, the last four
          characters of its reference, and a fingerprint of the file.
        </li>
        <li className="flex gap-2">
          <span aria-hidden="true" className="text-[var(--bad)]">
            ✕
          </span>
          We do not keep the document, your balance, your account number, or any
          other transaction on the page.
        </li>
      </ul>

      <div className="mt-4">
        <label className={`${buttonClass.secondary} cursor-pointer`}>
          {busy ? "Checking…" : "Choose a file"}
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp,image/heic"
            className="sr-only"
            disabled={busy || pending}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
        <p className="mt-2 text-xs text-subtle">
          PDF or photo, up to 12 MB. One page showing the payment is enough.
        </p>
      </div>

      {outcome ? (
        <div
          role="status"
          className={`mt-4 rounded-[var(--radius-card)] border px-3 py-2.5 text-sm ${
            outcome.ok
              ? "border-[var(--ok-border)] bg-[var(--ok-soft)] text-[var(--ok)]"
              : "border-[var(--warn-border)] bg-[var(--warn-soft)] text-[var(--warn)]"
          }`}
        >
          <p className="font-medium">{outcome.explanation}</p>
          {outcome.privacyNote ? (
            <p className="mt-1.5 text-xs opacity-90">{outcome.privacyNote}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
