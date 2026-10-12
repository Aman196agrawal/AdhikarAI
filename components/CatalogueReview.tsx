"use client";

/**
 * The catalogue review screen.
 *
 * Reviewers see each scheme's eligibility text beside the rules the AI
 * drafted from it, and approve, edit or reject each one. Until every drafted
 * rule for a scheme's current text is decided, that scheme can only ever be
 * shown to citizens as "may apply to you".
 *
 * The admin token and reviewer name are kept in sessionStorage - for this tab
 * only - and sent as headers. This is a stopgap until real authentication.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

import { buttonClass, Card, EmptyState, SectionHeading, StatusPill } from "@/components/ui";

interface Rule {
  id: string;
  code: string;
  kind: "ELIGIBILITY" | "EXCLUSION" | "DEPENDENCY";
  field: string;
  op: string;
  value: unknown;
  mandatory: boolean;
  text: string;
  sourceQuote: string;
  status: "DRAFT" | "APPROVED" | "REJECTED" | "STALE";
  draftedBy: string;
  reviewedBy: string | null;
}

interface QueueScheme {
  id: string;
  externalId: string;
  name: string;
  level: string;
  states: string[];
  officialUrl: string;
  lastChangedAt: string;
  eligibilityMd: string | null;
  exclusionsMd: string | null;
  unmappedCriteria: string[];
  rules: Rule[];
}

interface Health {
  catalogue: { active: number; withdrawn: number; awaitingReview: number; draftFailed: number };
  runs: Array<{ id: string; status: string; startedAt: string; listed: number; created: number; changed: number; withdrawn: number; failed: number; note: string | null }>;
}

const STORAGE_KEY = "adhikarai_admin";

type Credentials = { token: string; reviewer: string };

const NO_CREDENTIALS: Credentials = { token: "", reviewer: "" };

function readStored(): string {
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    // Storage blocked: the reviewer simply signs in again.
    return "";
  }
}

function parseCredentials(raw: string): Credentials {
  try {
    return raw ? (JSON.parse(raw) as Credentials) : NO_CREDENTIALS;
  } catch {
    return NO_CREDENTIALS;
  }
}

const subscribeToStorage = (onChange: () => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

function RuleRow({
  rule,
  busy,
  onDecide,
  onError,
}: {
  rule: Rule;
  busy: boolean;
  onError: (message: string) => void;
  onDecide: (rule: Rule, decision: "APPROVED" | "REJECTED", edit?: Partial<Rule>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(JSON.stringify(rule.value));
  const [text, setText] = useState(rule.text);

  const decided = rule.status !== "DRAFT";

  return (
    <li className="rounded-[var(--radius-card)] border bg-surface px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <code className="text-sm font-semibold">{rule.code}</code>
        <StatusPill tone={rule.status === "APPROVED" ? "ok" : rule.status === "REJECTED" ? "bad" : "warn"} icon="•">
          {rule.status}
        </StatusPill>
      </div>
      <p className="mt-1">{rule.text}</p>
      <p className="mt-1 font-mono text-sm text-muted">
        {rule.kind} · {rule.field} {rule.op} {JSON.stringify(rule.value)}
        {rule.mandatory ? "" : " (optional)"}
      </p>
      <blockquote className="mt-2 border-l-2 pl-3 text-sm text-subtle">“{rule.sourceQuote}”</blockquote>

      {editing ? (
        <div className="mt-3 space-y-2 text-sm">
          <label className="block">
            Value (JSON)
            <input className="mt-1 w-full rounded border px-2 py-1 font-mono" value={value} onChange={(e) => setValue(e.target.value)} />
          </label>
          <label className="block">
            Plain-language rule
            <input className="mt-1 w-full rounded border px-2 py-1" value={text} onChange={(e) => setText(e.target.value)} />
          </label>
        </div>
      ) : null}

      {!decided ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {editing ? (
            <button
              className={buttonClass.primary}
              disabled={busy}
              onClick={() => {
                let parsed: unknown;
                try {
                  parsed = JSON.parse(value);
                } catch {
                  onError("The value must be valid JSON, for example 60, \"SC\" or [\"SC\", \"ST\"].");
                  return;
                }
                onDecide(rule, "APPROVED", { value: parsed, text });
              }}
            >
              Save and approve
            </button>
          ) : (
            <button className={buttonClass.primary} disabled={busy} onClick={() => onDecide(rule, "APPROVED")}>
              Approve
            </button>
          )}
          <button className={buttonClass.secondary} disabled={busy} onClick={() => setEditing((v) => !v)}>
            {editing ? "Cancel edit" : "Edit"}
          </button>
          <button className={buttonClass.secondary} disabled={busy} onClick={() => onDecide(rule, "REJECTED")}>
            Reject
          </button>
        </div>
      ) : null}
    </li>
  );
}

function authHeaders(token: string, reviewer: string) {
  return {
    authorization: `Bearer ${token}`,
    "x-reviewer": reviewer,
    "content-type": "application/json",
  };
}

type LoadResult =
  | { ok: true; queue: QueueScheme[]; health: Health }
  | { ok: false; message: string };

/** Fetch the queue and catalogue health. Pure: returns data, sets no state. */
async function loadReviewData(token: string, reviewer: string): Promise<LoadResult> {
  try {
    const [q, h] = await Promise.all([
      fetch("/api/admin/catalogue/queue", { headers: authHeaders(token, reviewer) }),
      fetch("/api/admin/catalogue/runs", { headers: authHeaders(token, reviewer) }),
    ]);
    if (!q.ok || !h.ok) {
      const body = await (q.ok ? h : q).json().catch(() => null);
      return { ok: false, message: body?.error?.message ?? "Could not load the review queue." };
    }
    return { ok: true, queue: (await q.json()).data.schemes, health: (await h.json()).data };
  } catch {
    return { ok: false, message: "Could not reach the server." };
  }
}

export function CatalogueReview() {
  // Read from sessionStorage without a server/client mismatch: the server
  // snapshot is empty, the client reads the stored value.
  const stored = useSyncExternalStore(subscribeToStorage, readStored, () => "");
  const [signedIn, setCredentials] = useState<Credentials | null>(null);
  const credentials = signedIn ?? parseCredentials(stored);
  const [queue, setQueue] = useState<QueueScheme[] | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { token, reviewer } = credentials;
  const headers = useCallback(() => authHeaders(token, reviewer), [token, reviewer]);

  /** Apply a load result. Only ever called from a promise callback. */
  const apply = useCallback((result: LoadResult) => {
    if (result.ok) {
      setError(null);
      setQueue(result.queue);
      setHealth(result.health);
    } else {
      setError(result.message);
    }
  }, []);

  const refresh = useCallback(async () => {
    if (token && reviewer) apply(await loadReviewData(token, reviewer));
  }, [token, reviewer, apply]);

  useEffect(() => {
    if (!token || !reviewer) return;
    let cancelled = false;
    void loadReviewData(token, reviewer).then((result) => {
      if (!cancelled) apply(result);
    });
    return () => {
      cancelled = true;
    };
  }, [token, reviewer, apply]);

  async function decide(rule: Rule, decision: "APPROVED" | "REJECTED", edit?: Partial<Rule>) {
    setBusy(true);
    setError(null);
    const body = edit
      ? {
          decision,
          edit: {
            kind: rule.kind,
            field: rule.field,
            op: rule.op,
            mandatory: rule.mandatory,
            sourceQuote: rule.sourceQuote,
            value: edit.value,
            text: edit.text,
          },
        }
      : { decision };
    const response = await fetch(`/api/admin/catalogue/rules/${rule.id}`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      const details = Array.isArray(payload?.error?.details) ? ` ${payload.error.details.join("; ")}` : "";
      setError(`${payload?.error?.message ?? "That decision was not saved."}${details}`);
    }
    setBusy(false);
    await refresh();
  }

  async function saveUnmapped(scheme: QueueScheme, unmapped: string[]) {
    setBusy(true);
    const response = await fetch(`/api/admin/catalogue/schemes/${scheme.id}/unmapped`, {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify({ unmapped }),
    });
    if (!response.ok) setError("The unmapped conditions were not saved.");
    setBusy(false);
    await refresh();
  }

  if (!credentials.token || !credentials.reviewer) {
    return (
      <Card>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const next = { token: String(form.get("token") ?? ""), reviewer: String(form.get("reviewer") ?? "") };
            try {
              sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
            } catch {
              // Not persisted; works for this page load.
            }
            setCredentials(next);
          }}
        >
          <label className="block text-sm font-medium">
            Your name (recorded on every decision)
            <input name="reviewer" required className="mt-1 w-full rounded border px-3 py-2" />
          </label>
          <label className="block text-sm font-medium">
            Admin token
            <input name="token" type="password" required className="mt-1 w-full rounded border px-3 py-2" />
          </label>
          <button className={buttonClass.primary} type="submit">
            Open the review queue
          </button>
        </form>
      </Card>
    );
  }

  return (
    <div className="space-y-8">
      {error ? (
        <p role="alert" className="rounded-[var(--radius-card)] border border-[var(--bad-border)] bg-[var(--bad-soft)] px-4 py-3 text-[var(--bad)]">
          {error}
        </p>
      ) : null}

      {health ? (
        <section>
          <SectionHeading hint="The catalogue is synced nightly from myScheme.">Catalogue health</SectionHeading>
          <p className="text-sm">
            {health.catalogue.active} active · {health.catalogue.withdrawn} withdrawn ·{" "}
            {health.catalogue.awaitingReview} awaiting review · {health.catalogue.draftFailed} drafting failed
          </p>
          {health.runs[0] ? (
            <p className="mt-1 text-sm text-muted">
              Last sync {health.runs[0].startedAt.slice(0, 16).replace("T", " ")} UTC: {health.runs[0].status} —{" "}
              {health.runs[0].listed} listed, {health.runs[0].created} new, {health.runs[0].changed} changed,{" "}
              {health.runs[0].withdrawn} withdrawn, {health.runs[0].failed} failed.
              {health.runs[0].note ? ` ${health.runs[0].note}` : ""}
            </p>
          ) : (
            <p className="mt-1 text-sm text-muted">No sync has run yet.</p>
          )}
        </section>
      ) : null}

      <section>
        <SectionHeading hint={`Reviewing as ${credentials.reviewer}. Most recently changed schemes first.`}>
          Rules waiting for review
        </SectionHeading>
        {queue === null ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : queue.length === 0 ? (
          <EmptyState>Nothing is waiting for review.</EmptyState>
        ) : (
          <ul className="space-y-6">
            {queue.map((scheme) => (
              <Card as="li" key={scheme.id}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-lg font-semibold">{scheme.name}</p>
                    <p className="text-sm text-subtle">
                      {scheme.level}
                      {scheme.states.length > 0 ? ` · ${scheme.states.join(", ")}` : ""} · changed{" "}
                      {scheme.lastChangedAt.slice(0, 10)}
                    </p>
                  </div>
                  <a href={scheme.officialUrl} target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-accent hover:underline">
                    Official page ↗
                  </a>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <p className="text-sm font-semibold">Eligibility text</p>
                    <pre className="mt-1 whitespace-pre-wrap rounded border bg-[var(--surface-sunken,transparent)] p-3 text-sm">
                      {scheme.eligibilityMd ?? "No eligibility text from the source."}
                      {scheme.exclusionsMd ? `\n\nExclusions:\n${scheme.exclusionsMd}` : ""}
                    </pre>
                  </div>
                  <div>
                    <p className="text-sm font-semibold">Drafted rules</p>
                    <ul className="mt-1 space-y-2">
                      {scheme.rules.map((rule) => (
                        <RuleRow key={rule.id} rule={rule} busy={busy} onDecide={decide} onError={setError} />
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="mt-4">
                  <p className="text-sm font-semibold">Conditions no rule expresses</p>
                  <p className="text-xs text-subtle">
                    While any remain, this scheme can never show a citizen “You qualify”. Remove one once a rule covers it
                    or you have confirmed it is not a real condition.
                  </p>
                  {scheme.unmappedCriteria.length === 0 ? (
                    <p className="mt-1 text-sm text-muted">None.</p>
                  ) : (
                    <ul className="mt-1 space-y-1">
                      {scheme.unmappedCriteria.map((item, index) => (
                        <li key={`${index}-${item}`} className="flex items-start justify-between gap-3 text-sm">
                          <span>{item}</span>
                          <button
                            className="shrink-0 text-accent hover:underline"
                            disabled={busy}
                            onClick={() => saveUnmapped(scheme, scheme.unmappedCriteria.filter((_, i) => i !== index))}
                          >
                            Remove
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
