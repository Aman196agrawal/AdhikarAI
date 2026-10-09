"use client";

/**
 * Applying for a benefit: the road to approval gate 1.
 *
 * Added after review found there was no way to do this from the interface at
 * all. The dashboard's "Look into it" led to a page whose only action, for an
 * unclaimed benefit, was to diagnose it as a fault.
 *
 * The flow is deliberately short: prepare (prefilled from what the citizen
 * already told us), fill in only what is missing, then go to the approval
 * screen where everything is shown before anything is sent. Nothing here
 * submits; submission only happens after the citizen says yes on that screen.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { buttonClass } from "./ui";

interface PreparedField {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "boolean";
  required: boolean;
  value: unknown;
  valid: boolean;
  validationError?: string;
  options?: string[];
  validation?: string;
}

interface Prepared {
  applicationId: string;
  fields: PreparedField[];
  missingFields: string[];
  missingDocuments: string[];
  readyForApproval: boolean;
}

interface Props {
  citizenId: string;
  entitlementId: string;
  /** Current application status, or null when never started. */
  applicationStatus: string | null;
  /** An approval already waiting, which we should send the citizen to. */
  pendingApprovalId: string | null;
  /** Whether a previous submission failed after the citizen approved. */
  canRetrySubmission: boolean;
  applicationId: string | null;
}

type ApiBody<T> =
  | { ok: true; data: T }
  | { ok: false; error: { message: string; details?: unknown } };

async function call<T>(url: string, body: unknown): Promise<ApiBody<T>> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return (await response.json()) as ApiBody<T>;
}

export function ApplyPanel(props: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});

  // An approval is already waiting: the only useful thing is to go to it.
  if (props.pendingApprovalId) {
    return (
      <div className="mt-4">
        <a href={`/approve/${props.pendingApprovalId}`} className={buttonClass.primary}>
          Review your application
          <span aria-hidden="true">→</span>
        </a>
        <p className="mt-2 text-sm text-subtle">
          It is ready. Nothing has been sent yet.
        </p>
      </div>
    );
  }

  async function prepare(provided?: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await call<Prepared>("/api/applications", {
        citizenId: props.citizenId,
        entitlementId: props.entitlementId,
        ...(provided ? { providedFields: provided } : {}),
      });
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      setPrepared(result.data);

      if (result.data.readyForApproval && provided) {
        const approval = await call<{ approvalId: string }>(
          `/api/applications/${result.data.applicationId}/request-approval`,
          { citizenId: props.citizenId },
        );
        if (!approval.ok) {
          setError(approval.error.message);
          return;
        }
        startTransition(() => router.push(`/approve/${approval.data.approvalId}`));
      }
    } catch {
      setError("We could not prepare the application just now. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function retrySubmission(): Promise<void> {
    if (!props.applicationId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ applicationRef: string }>(
        `/api/applications/${props.applicationId}/submit`,
        { citizenId: props.citizenId },
      );
      if (!result.ok) {
        setError(result.error.message);
        return;
      }
      startTransition(() => router.refresh());
    } catch {
      setError("We could not send it just now. Please try again in a moment.");
    } finally {
      setBusy(false);
    }
  }

  /** Coerce typed text into the field's type before sending. */
  function collect(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const field of prepared?.fields ?? []) {
      const raw = values[field.key];
      if (raw === undefined || raw.trim() === "") continue;
      out[field.key] =
        field.type === "number"
          ? Number(raw)
          : field.type === "boolean"
            ? raw === "true"
            : raw.trim();
    }
    return out;
  }

  if (props.canRetrySubmission) {
    return (
      <div className="mt-4">
        <p className="text-sm text-[var(--bad)]">
          You approved this application but it could not be sent.
        </p>
        <button
          type="button"
          onClick={() => void retrySubmission()}
          disabled={busy || pending}
          className={`${buttonClass.primary} mt-3`}
        >
          {busy ? "Sending…" : "Try sending again"}
        </button>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-[var(--bad)]">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  if (!prepared) {
    return (
      <div className="mt-4">
        <button
          type="button"
          onClick={() => void prepare()}
          disabled={busy || pending}
          className={buttonClass.primary}
        >
          {busy ? "Preparing…" : "Prepare my application"}
        </button>
        <p className="mt-2 text-sm text-subtle">
          We fill in what you have already told us. Nothing is sent until you
          approve it.
        </p>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-[var(--bad)]">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  // Only ask for what is missing or wrong; prefilled, valid fields are left alone.
  const toAsk = prepared.fields.filter(
    (f) =>
      prepared.missingFields.includes(f.key) || (!f.valid && f.value !== null),
  );

  return (
    <div className="mt-4 rounded-[var(--radius-card)] border bg-surface-sunken p-4">
      {toAsk.length > 0 ? (
        <>
          <p className="font-medium">We need a few more details</p>
          <p className="mt-0.5 text-sm text-muted">
            Your Aadhaar and bank details are never taken from conversation. You
            type them here yourself.
          </p>
          <div className="mt-3 space-y-3">
            {toAsk.map((field) => (
              <label key={field.key} className="block">
                <span className="text-sm font-medium">
                  {field.label}
                  {field.validation ? (
                    <span className="ml-1 font-normal text-subtle">
                      ({field.validation})
                    </span>
                  ) : null}
                </span>
                {field.type === "select" && field.options ? (
                  <select
                    value={values[field.key] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [field.key]: e.target.value }))
                    }
                    className="mt-1 w-full rounded-[var(--radius-card)] border bg-surface px-3 py-2.5"
                  >
                    <option value="">Choose…</option>
                    {field.options.map((option) => (
                      <option key={option} value={option}>
                        {option.toLowerCase().replace(/_/g, " ")}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={
                      field.type === "number"
                        ? "number"
                        : field.type === "date"
                          ? "date"
                          : "text"
                    }
                    inputMode={field.type === "number" ? "numeric" : undefined}
                    autoComplete="off"
                    value={values[field.key] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [field.key]: e.target.value }))
                    }
                    className="mt-1 w-full rounded-[var(--radius-card)] border bg-surface px-3 py-2.5"
                  />
                )}
                {field.validationError && !prepared.missingFields.includes(field.key) ? (
                  <span className="mt-1 block text-xs text-[var(--bad)]">
                    {field.validationError}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
        </>
      ) : (
        <p className="font-medium">Everything we need is filled in.</p>
      )}

      {prepared.missingDocuments.length > 0 ? (
        <p className="mt-3 text-sm text-muted">
          Documents the department will ask for:{" "}
          {prepared.missingDocuments
            .map((d) => d.toLowerCase().replace(/_/g, " "))
            .join(", ")}
          .
        </p>
      ) : null}

      <button
        type="button"
        onClick={() => void prepare(collect())}
        disabled={busy || pending}
        className={`${buttonClass.primary} mt-4`}
      >
        {busy ? "Checking…" : "Review before sending"}
        <span aria-hidden="true">→</span>
      </button>

      {error ? (
        <p role="alert" className="mt-3 text-sm text-[var(--bad)]">
          {error}
        </p>
      ) : null}
    </div>
  );
}
