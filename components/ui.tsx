/**
 * Shared presentation primitives.
 *
 * Two of these carry product rules rather than just styling:
 *
 *   `Money` refuses to render a null amount as a number. Null means "not a
 *   fixed cash amount" (foodgrain, a work guarantee) and showing it as ₹0
 *   would understate a dashboard total as though zero were a fact.
 *
 *   `StatusPill` always renders an icon and a word alongside the colour. Red
 *   and amber look similar to a red-green colourblind reader and identical in
 *   a photocopy, and the difference between "we cannot confirm this" and
 *   "this did not arrive" is the whole product.
 */

import type { ReactNode } from "react";

import { deserialize, formatINR } from "@/lib/engine/money";

/* --------------------------------------------------------------------------
 * Money
 * ------------------------------------------------------------------------ */

export function Money({
  paise,
  /** Shown when the amount is null. Never a zero. */
  nullLabel = "Not a cash amount",
  className = "",
}: {
  paise: string | null;
  nullLabel?: string;
  className?: string;
}) {
  if (paise === null) {
    return (
      <span className={`text-subtle text-[0.95em] ${className}`}>{nullLabel}</span>
    );
  }
  return (
    <span className={`tabular ${className}`}>{formatINR(deserialize(paise))}</span>
  );
}

/* --------------------------------------------------------------------------
 * Status
 * ------------------------------------------------------------------------ */

export type Tone = "ok" | "info" | "warn" | "bad" | "neutral" | "accent" | "demo";

const TONE_CLASS: Record<Tone, string> = {
  ok: "bg-[var(--ok-soft)] text-[var(--ok)] border-[var(--ok-border)]",
  info: "bg-[var(--info-soft)] text-[var(--info)] border-[var(--info-border)]",
  warn: "bg-[var(--warn-soft)] text-[var(--warn)] border-[var(--warn-border)]",
  bad: "bg-[var(--bad-soft)] text-[var(--bad)] border-[var(--bad-border)]",
  neutral:
    "bg-[var(--neutral-soft)] text-[var(--neutral)] border-[var(--neutral-border)]",
  accent:
    "bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent-ring)]",
  demo: "bg-[var(--demo-soft)] text-[var(--demo)] border-[var(--demo-border)]",
};

export function StatusPill({
  tone,
  icon,
  children,
  className = "",
}: {
  tone: Tone;
  /** A glyph, always present. Colour alone is never the signal. */
  icon: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-sm font-medium ${TONE_CLASS[tone]} ${className}`}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </span>
  );
}

/** The five receipt states, in the citizen's words. */
export function ReceiptBadge({ state }: { state: string | null }) {
  switch (state) {
    case "VERIFIED_RECEIVED":
      return (
        <StatusPill tone="ok" icon="✓">
          Received, verified
        </StatusPill>
      );
    case "CITIZEN_CONFIRMED":
      return (
        <StatusPill tone="info" icon="✓">
          You confirmed receiving it
        </StatusPill>
      );
    case "DISBURSED_RECEIPT_UNVERIFIED":
      // Amber and worded as an open question. Not an error, not a loss.
      return (
        <StatusPill tone="warn" icon="?">
          Not yet confirmed
        </StatusPill>
      );
    case "PAYMENT_DISCREPANCY":
      return (
        <StatusPill tone="bad" icon="!">
          Did not reach you
        </StatusPill>
      );
    case "NOT_DISBURSED":
      return (
        <StatusPill tone="neutral" icon="–">
          No payment yet
        </StatusPill>
      );
    default:
      return null;
  }
}

export function VerdictBadge({ verdict }: { verdict: string }) {
  switch (verdict) {
    case "GREEN":
      return (
        <StatusPill tone="ok" icon="✓">
          You qualify
        </StatusPill>
      );
    case "YELLOW":
      return (
        <StatusPill tone="warn" icon="?">
          You may qualify
        </StatusPill>
      );
    default:
      return (
        <StatusPill tone="neutral" icon="–">
          Does not apply to you
        </StatusPill>
      );
  }
}

export function DecisionBadge({ decision }: { decision: string | null }) {
  switch (decision) {
    case "HEALTHY":
      return (
        <StatusPill tone="ok" icon="✓">
          All in order
        </StatusPill>
      );
    case "NEEDS_VERIFICATION":
      return (
        <StatusPill tone="warn" icon="?">
          Needs your answer
        </StatusPill>
      );
    case "ACTION_REQUIRED":
      return (
        <StatusPill tone="bad" icon="!">
          Needs action
        </StatusPill>
      );
    default:
      return null;
  }
}

/** Marks anything whose government data came from the simulation. */
export function DemoBadge({ children = "Demo data" }: { children?: ReactNode }) {
  return (
    <StatusPill tone="demo" icon="▲">
      {children}
    </StatusPill>
  );
}

/* --------------------------------------------------------------------------
 * Layout
 * ------------------------------------------------------------------------ */

export function Card({
  children,
  className = "",
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "li" | "article";
}) {
  return (
    <Tag
      className={`rounded-[var(--radius-panel)] border bg-surface p-5 sm:p-6 ${className}`}
    >
      {children}
    </Tag>
  );
}

export function SectionHeading({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-3">
      <h2 className="text-lg font-semibold tracking-tight">{children}</h2>
      {hint ? <p className="mt-0.5 text-sm text-muted">{hint}</p> : null}
    </div>
  );
}

/**
 * A single headline figure.
 *
 * `hedge` is not decoration. A total of unclaimed entitlements is a
 * projection, and a total of unconfirmed payments is an open question; both
 * must read as such beside a figure of money actually received.
 */
export function StatTile({
  label,
  paise,
  hedge,
  tone = "neutral",
}: {
  label: string;
  paise: string | null;
  hedge?: string;
  tone?: Tone;
}) {
  return (
    <div className="rounded-[var(--radius-card)] border bg-surface px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-muted">{label}</span>
      </div>
      <div
        className={`mt-1 text-2xl font-semibold tabular ${
          tone === "bad"
            ? "text-[var(--bad)]"
            : tone === "warn"
              ? "text-[var(--warn)]"
              : tone === "ok"
                ? "text-[var(--ok)]"
                : "text-foreground"
        }`}
      >
        <Money paise={paise} nullLabel="—" />
      </div>
      {hedge ? <p className="mt-0.5 text-xs text-subtle">{hedge}</p> : null}
    </div>
  );
}

/**
 * The "Why?" drawer.
 *
 * Collapsed by default so the citizen is not buried in official language, and
 * always available so no decision is unexplained. A verdict a person cannot
 * interrogate is not much better than no verdict.
 */
export function WhyDrawer({
  summary = "Why?",
  children,
}: {
  summary?: string;
  children: ReactNode;
}) {
  return (
    <details className="group mt-3">
      <summary className="inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-accent hover:underline">
        <span
          aria-hidden="true"
          className="transition-transform group-open:rotate-90"
        >
          ›
        </span>
        {summary}
      </summary>
      <div className="mt-3 rounded-[var(--radius-card)] border bg-surface-sunken p-4 text-sm leading-relaxed">
        {children}
      </div>
    </details>
  );
}

/** An official rule, with its source, exactly as the registry holds it. */
export function ClauseLine({
  text,
  result,
  provenance,
  sourceUrl,
  lastVerified,
}: {
  text: string;
  result: string;
  provenance: string;
  sourceUrl: string;
  lastVerified: string;
}) {
  const tone: Tone =
    result === "SATISFIED" ? "ok" : result === "VIOLATED" ? "bad" : "warn";
  const icon = result === "SATISFIED" ? "✓" : result === "VIOLATED" ? "✕" : "?";
  const word =
    result === "SATISFIED" ? "Met" : result === "VIOLATED" ? "Not met" : "Unknown";

  return (
    <li className="border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill tone={tone} icon={icon}>
          {word}
        </StatusPill>
        <span className="text-xs text-subtle">
          {provenance === "DOCUMENT_VERIFIED"
            ? "from a document"
            : provenance === "SELF_DECLARED"
              ? "you told us"
              : provenance === "INFERRED"
                ? "worked out from what you said"
                : "not established"}
        </span>
      </div>
      <p className="mt-1.5 text-foreground">{text}</p>
      <a
        href={sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-1 inline-block text-xs text-accent hover:underline"
      >
        Official source · checked {lastVerified} ↗
      </a>
    </li>
  );
}

/* --------------------------------------------------------------------------
 * Buttons
 * ------------------------------------------------------------------------ */

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-[var(--radius-card)] px-4 py-2.5 text-base font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55";

export const buttonClass = {
  primary: `${BUTTON_BASE} bg-accent text-white hover:bg-accent-hover`,
  secondary: `${BUTTON_BASE} border bg-surface text-foreground hover:bg-surface-sunken`,
  // Large, equally weighted answer buttons. None is visually the "right" one:
  // nudging someone toward yes would manufacture false confirmations.
  answer: `${BUTTON_BASE} min-w-28 border-2 bg-surface py-3.5 text-lg hover:bg-surface-sunken`,
  danger: `${BUTTON_BASE} border-2 border-[var(--bad-border)] bg-[var(--bad-soft)] text-[var(--bad)] hover:brightness-95`,
} as const;

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[var(--radius-card)] border border-dashed bg-surface px-4 py-6 text-center text-muted">
      {children}
    </p>
  );
}
