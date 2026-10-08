"use client";

/**
 * The demo console.
 *
 * Visually distinct from the citizen app on purpose. This panel makes the
 * *government* act and moves the clock; mistaking it for product would be
 * mistaking the simulation for the thing being simulated.
 *
 * It is a control over the simulated portal, not over AdhikarAI. Releasing a
 * payment here writes to the government's own store; AdhikarAI then has to
 * notice, through exactly the code path it would use against a real API. So
 * the demo shows the system reaching its own conclusions rather than being
 * told what to display.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { buttonClass } from "./ui";

interface BenefitOption {
  id: string;
  schemeCode: string;
  schemeName: string;
  lifecycleState: string;
  hasApplication: boolean;
}

interface Props {
  citizenId: string;
  citizenName: string;
  benefits: BenefitOption[];
  clockNow: string;
  clockIsSimulated: boolean;
  realNow: string;
}

const GOV_ACTIONS: Array<{
  action: string;
  label: string;
  hint: string;
  needsApplication: boolean;
}> = [
  {
    action: "APPROVE",
    label: "Approve the application",
    hint: "The department decides in the citizen's favour.",
    needsApplication: true,
  },
  {
    action: "RELEASE_PAYMENT",
    label: "Release this period's payment",
    hint: "Records a disbursement. Whether it ARRIVED is a separate question.",
    needsApplication: true,
  },
  {
    action: "FAIL_PAYMENT_SEEDING",
    label: "Bank returns the credit (Aadhaar not seeded)",
    hint: "Adds the explanation the diagnosis will later cite.",
    needsApplication: true,
  },
  {
    action: "SKIP_PAYMENT",
    label: "Skip this period's payment",
    hint: "Opens a continuity gap mid-series.",
    needsApplication: true,
  },
  {
    action: "RETURN_FOR_DOCUMENT",
    label: "Return it, document missing",
    hint: "The department asks for an income certificate.",
    needsApplication: true,
  },
  {
    action: "REJECT",
    label: "Reject the application",
    hint: "With a reason the diagnosis can read.",
    needsApplication: true,
  },
  {
    action: "STALL",
    label: "Leave it pending for 94 days",
    hint: "No decision, no request for information.",
    needsApplication: true,
  },
];

export function DemoConsole({
  citizenId,
  citizenName,
  benefits,
  clockNow,
  clockIsSimulated,
  realNow,
}: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [selected, setSelected] = useState<string>(benefits[0]?.id ?? "");

  function note(line: string): void {
    setLog((previous) => [line, ...previous].slice(0, 12));
  }

  async function call(
    label: string,
    url: string,
    body: unknown,
  ): Promise<void> {
    setBusy(label);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as
        | { ok: true; data: Record<string, unknown> }
        | { ok: false; error: { message: string } };

      if (!payload.ok) {
        note(`✕ ${label}: ${payload.error.message}`);
        return;
      }

      const monitoring = payload.data.monitoring as
        | { audited?: number; actionRequired?: number; events?: unknown[] }
        | null
        | undefined;

      note(
        monitoring
          ? `✓ ${label} — monitoring then re-audited ${monitoring.audited ?? 0} benefit(s), ${monitoring.actionRequired ?? 0} needing action`
          : `✓ ${label}`,
      );
      startTransition(() => router.refresh());
    } catch {
      note(`✕ ${label}: the request failed`);
    } finally {
      setBusy(null);
    }
  }

  const benefit = benefits.find((b) => b.id === selected);

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------ clock */}
      <section className="rounded-[var(--radius-panel)] border border-[var(--demo-border)] bg-surface p-5">
        <h2 className="font-semibold">The clock</h2>
        <p className="mt-1 text-sm text-muted">
          A continuity gap is, by definition, months of missing payments.
          Advancing the clock lets the real monitor draw its own conclusions
          over a later &ldquo;now&rdquo;. Nothing about the benefits is faked —
          only the date.
        </p>

        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <div>
            <dt className="inline text-subtle">Simulated now: </dt>
            <dd className="inline font-semibold tabular">
              {clockNow.slice(0, 10)}
            </dd>
          </div>
          <div>
            <dt className="inline text-subtle">Real now: </dt>
            <dd className="inline tabular">{realNow.slice(0, 10)}</dd>
          </div>
          <div>
            <dt className="inline text-subtle">Shifted: </dt>
            <dd className="inline font-semibold">
              {clockIsSimulated ? "yes" : "no"}
            </dd>
          </div>
        </dl>

        <div className="mt-4 flex flex-wrap gap-2">
          {[
            { days: 30, label: "+1 month" },
            { days: 90, label: "+3 months" },
            { days: 365, label: "+1 year" },
          ].map((step) => (
            <button
              key={step.days}
              type="button"
              disabled={busy !== null || pending}
              onClick={() =>
                void call(`Advanced ${step.label}`, "/api/demo/clock", {
                  action: "ADVANCE",
                  days: step.days,
                  runMonitoring: true,
                  citizenId,
                })
              }
              className={buttonClass.secondary}
            >
              {busy === `Advanced ${step.label}` ? "Working…" : step.label}
            </button>
          ))}
          <button
            type="button"
            disabled={busy !== null || pending}
            onClick={() =>
              void call("Reset the clock", "/api/demo/clock", { action: "RESET" })
            }
            className={buttonClass.secondary}
          >
            Reset
          </button>
        </div>
        <p className="mt-2 text-xs text-subtle">
          Advancing also runs a monitoring pass, which is what a real
          five-minute cron would have done over that period.
        </p>
      </section>

      {/* ------------------------------------------------------- government */}
      <section className="rounded-[var(--radius-panel)] border border-[var(--demo-border)] bg-surface p-5">
        <h2 className="font-semibold">Make the government act</h2>
        <p className="mt-1 text-sm text-muted">
          These write to the simulated portal&rsquo;s own records for{" "}
          <strong className="text-foreground">{citizenName}</strong>. AdhikarAI
          then has to notice, through the same adapter it would use against a
          real API.
        </p>

        <label className="mt-4 block text-sm font-medium" htmlFor="benefit">
          Which benefit
        </label>
        <select
          id="benefit"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
          className="mt-1 w-full rounded-[var(--radius-card)] border bg-surface px-3 py-2.5 text-base"
        >
          {benefits.map((option) => (
            <option key={option.id} value={option.id}>
              {option.schemeName} — {option.lifecycleState.toLowerCase().replace(/_/g, " ")}
              {option.hasApplication ? "" : " (not applied)"}
            </option>
          ))}
        </select>

        {benefit && !benefit.hasApplication ? (
          <p className="mt-3 rounded-[var(--radius-card)] border border-[var(--warn-border)] bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn)]">
            This benefit has not been lodged with the portal, so the portal
            cannot act on it yet.
          </p>
        ) : null}

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {GOV_ACTIONS.map((item) => (
            <button
              key={item.action}
              type="button"
              disabled={
                busy !== null ||
                pending ||
                selected === "" ||
                (item.needsApplication && benefit?.hasApplication !== true)
              }
              onClick={() =>
                void call(item.label, "/api/demo/gov", {
                  citizenId,
                  entitlementId: selected,
                  action: item.action,
                })
              }
              className={`${buttonClass.secondary} h-auto flex-col items-start py-3 text-left`}
            >
              <span className="text-base font-semibold">
                {busy === item.label ? "Working…" : item.label}
              </span>
              <span className="text-xs font-normal text-subtle">{item.hint}</span>
            </button>
          ))}
        </div>
      </section>

      {/* --------------------------------------------------------- audit now */}
      <section className="rounded-[var(--radius-panel)] border border-[var(--demo-border)] bg-surface p-5">
        <h2 className="font-semibold">Make AdhikarAI look</h2>
        <p className="mt-1 text-sm text-muted">
          Normally the scheduler does this. Run it now to see what the system
          makes of the government&rsquo;s current records.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy !== null || pending || selected === ""}
            onClick={() =>
              void call(
                "Audited this benefit",
                `/api/benefits/${selected}/audit`,
                { citizenId },
              )
            }
            className={buttonClass.primary}
          >
            {busy === "Audited this benefit" ? "Working…" : "Audit this benefit"}
          </button>
          <button
            type="button"
            disabled={busy !== null || pending}
            onClick={() =>
              void call("Ran a monitoring pass", "/api/demo/clock", {
                action: "ADVANCE",
                days: 0,
                runMonitoring: true,
                citizenId,
              })
            }
            className={buttonClass.secondary}
          >
            {busy === "Ran a monitoring pass"
              ? "Working…"
              : "Run a monitoring pass"}
          </button>
        </div>
      </section>

      {log.length > 0 ? (
        <section className="rounded-[var(--radius-panel)] border bg-surface-sunken p-5">
          <h2 className="font-semibold">What just happened</h2>
          <ol className="mt-2 space-y-1 text-sm">
            {log.map((line, index) => (
              <li key={index} className="tabular">
                {line}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
