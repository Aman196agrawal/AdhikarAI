/**
 * One benefit, in full.
 *
 * The screen that makes a decision defensible rather than merely stated:
 * every rule and whether it was met, every payment and what became of it,
 * every diagnosis with the evidence it cited, and the whole state history.
 *
 * It is organised for the citizen's questions, in the order they ask them:
 * what should I be getting, what happened, why, and what now. The official
 * language is present but folded away behind "Why?", because burying someone
 * in clause text is its own kind of exclusion.
 */

import Link from "next/link";
import { notFound } from "next/navigation";

import { prisma } from "@/lib/db";
import { readable } from "@/lib/engine/gaps";
import { serialize } from "@/lib/engine/money";
import { requireSelectedCitizen } from "@/lib/session";
import { BenefitActions } from "@/components/BenefitActions";
import {
  Card,
  ClauseLine,
  DecisionBadge,
  DemoBadge,
  Money,
  ReceiptBadge,
  SectionHeading,
  StatusPill,
  VerdictBadge,
  WhyDrawer,
  buttonClass,
} from "@/components/ui";

export const dynamic = "force-dynamic";

interface StoredClause {
  code: string;
  kind: string;
  mandatory: boolean;
  result: string;
  disqualifies: boolean;
  provenance: string;
  text: string;
  sourceUrl: string;
  lastVerified: string;
}

interface StoredClauseResults {
  verdict?: string;
  confidence?: number;
  confidenceLabel?: string;
  clauses?: StoredClause[];
}

/** Receipt states in order of how much they should worry the reader. */
function paymentTone(state: string): "ok" | "info" | "warn" | "bad" | "neutral" {
  if (state === "VERIFIED_RECEIVED") return "ok";
  if (state === "CITIZEN_CONFIRMED") return "info";
  if (state === "DISBURSED_RECEIPT_UNVERIFIED") return "warn";
  if (state === "PAYMENT_DISCREPANCY") return "bad";
  return "neutral";
}

export default async function BenefitPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const citizen = await requireSelectedCitizen();

  const entitlement = await prisma.entitlement.findFirst({
    where: { id, citizenId: citizen.citizenId },
    include: {
      scheme: true,
      application: true,
      ledger: true,
      expectedPayments: { orderBy: { dueOn: "asc" } },
      payments: {
        orderBy: { reportedOn: "asc" },
        include: {
          verifications: { orderBy: [{ verifiedAt: "desc" }, { id: "desc" }] },
        },
      },
      audits: { orderBy: { runAt: "desc" }, take: 1, include: { findings: true } },
      gaps: {
        orderBy: { detectedAt: "desc" },
        include: {
          rootCauses: { orderBy: { attempt: "desc" } },
          actionPlans: {
            orderBy: { attempt: "desc" },
            include: {
              steps: { orderBy: { position: "asc" } },
              executions: true,
              approvals: true,
            },
          },
        },
      },
    },
  });

  if (!entitlement) notFound();

  const trail = await prisma.auditLog.findMany({
    where: { entity: "Entitlement", entityId: entitlement.id },
    orderBy: { createdAt: "asc" },
  });

  const stored = (entitlement.clauseResults ?? {}) as StoredClauseResults;
  const clauses = stored.clauses ?? [];
  const latestAudit = entitlement.audits[0] ?? null;
  const openGaps = entitlement.gaps.filter((g) => g.resolvedAt === null);
  const resolvedGaps = entitlement.gaps.filter((g) => g.resolvedAt !== null);

  const paidPeriods = new Set(entitlement.payments.map((p) => p.periodLabel));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/dashboard" className="text-sm font-medium text-accent hover:underline">
        ← Back to all benefits
      </Link>

      <header className="mt-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-bold leading-tight sm:text-3xl">
              {entitlement.scheme.name}
            </h1>
            {entitlement.scheme.nameHi ? (
              <p className="text-lg text-subtle">{entitlement.scheme.nameHi}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {latestAudit ? (
              <DecisionBadge decision={latestAudit.decision} />
            ) : (
              <VerdictBadge verdict={entitlement.verdict} />
            )}
            {citizen.isDemo ? <DemoBadge>Simulated</DemoBadge> : null}
          </div>
        </div>

        <p className="mt-3 text-muted">{entitlement.scheme.description}</p>

        {entitlement.scheme.benefitNote ? (
          <p className="mt-2 rounded-[var(--radius-card)] border bg-surface-sunken px-3 py-2 text-sm text-muted">
            {entitlement.scheme.benefitNote}
          </p>
        ) : null}
      </header>

      {/* ------------------------------------------------- what and where */}
      <Card className="mt-6">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-4">
          <div>
            <dt className="text-subtle">You should get</dt>
            <dd className="mt-0.5 text-base font-semibold">
              <Money
                paise={
                  entitlement.expectedAmountPaise === null
                    ? null
                    : serialize(entitlement.expectedAmountPaise)
                }
                nullLabel={
                  entitlement.scheme.benefitType === "IN_KIND" ? "In kind" : "Varies"
                }
              />
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Received</dt>
            <dd className="mt-0.5 text-base font-semibold tabular text-[var(--ok)]">
              <Money paise={serialize(entitlement.ledger?.receivedAmountPaise ?? 0n)} />
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Not yet confirmed</dt>
            <dd className="mt-0.5 text-base font-semibold tabular text-[var(--warn)]">
              <Money
                paise={serialize(entitlement.ledger?.unverifiedAmountPaise ?? 0n)}
              />
            </dd>
          </div>
          <div>
            <dt className="text-subtle">Did not arrive</dt>
            <dd className="mt-0.5 text-base font-semibold tabular text-[var(--bad)]">
              <Money paise={serialize(entitlement.ledger?.gapAmountPaise ?? 0n)} />
            </dd>
          </div>
        </dl>

        {entitlement.ledger && entitlement.ledger.recoveredAmountPaise > 0n ? (
          <p className="mt-4 rounded-[var(--radius-card)] border border-[var(--ok-border)] bg-[var(--ok-soft)] px-3 py-2 text-sm text-[var(--ok)]">
            <strong className="font-semibold">
              <Money paise={serialize(entitlement.ledger.recoveredAmountPaise)} />{" "}
              recovered
            </strong>{" "}
            after this was chased up.
          </p>
        ) : null}
      </Card>

      {/* ------------------------------------------------------ do you qualify */}
      <section className="mt-8">
        <SectionHeading
          hint={
            stored.confidenceLabel
              ? `Based on what we know, this reads as ${stored.confidenceLabel}.`
              : undefined
          }
        >
          Do you qualify?
        </SectionHeading>

        <Card>
          <VerdictBadge verdict={entitlement.verdict} />

          {entitlement.missingEvidence.length > 0 ? (
            <div className="mt-3">
              <p className="text-sm font-medium">We still need:</p>
              <ul className="mt-1 list-inside list-disc text-sm text-muted">
                {entitlement.missingEvidence.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {entitlement.pendingDeclarations.length > 0 ? (
            <p className="mt-3 text-sm text-muted">
              When you apply, you will be asked to confirm{" "}
              {entitlement.pendingDeclarations.length} declaration
              {entitlement.pendingDeclarations.length === 1 ? "" : "s"} — the
              things this scheme requires you <em>not</em> to be.
            </p>
          ) : null}

          {clauses.length > 0 ? (
            <WhyDrawer summary="Why? Show every rule and its official source">
              <ul>
                {clauses.map((clause) => (
                  <ClauseLine
                    key={clause.code}
                    text={clause.text}
                    result={clause.result}
                    provenance={clause.provenance}
                    sourceUrl={clause.sourceUrl}
                    lastVerified={clause.lastVerified}
                  />
                ))}
              </ul>
              <p className="mt-3 border-t pt-3 text-xs text-subtle">
                Scheme information from {entitlement.scheme.sourceName}, recorded{" "}
                {entitlement.scheme.lastVerified.toISOString().slice(0, 10)}.{" "}
                {entitlement.scheme.verificationStatus === "SOURCE_CHECKED"
                  ? "Checked against the official source on that date."
                  : "Compiled from official documentation; not re-checked at the source on that date."}
              </p>
            </WhyDrawer>
          ) : null}
        </Card>
      </section>

      {/* ----------------------------------------------------- what happened */}
      <section className="mt-8">
        <SectionHeading hint="What the government did, and whether it reached you.">
          What happened
        </SectionHeading>

        {entitlement.application ? (
          <Card className="mb-3">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone="accent" icon="▦">
                Application {entitlement.application.status.toLowerCase().replace(/_/g, " ")}
              </StatusPill>
              {entitlement.application.govApplicationRef ? (
                <span className="text-sm text-subtle">
                  Reference {entitlement.application.govApplicationRef}
                </span>
              ) : null}
            </div>
            {entitlement.application.rejectionReason ? (
              <p className="mt-2 text-sm text-[var(--bad)]">
                {entitlement.application.rejectionReason}
              </p>
            ) : null}
            {entitlement.application.submissionError ? (
              <p className="mt-2 text-sm text-[var(--bad)]">
                Could not be lodged: {entitlement.application.submissionError}
              </p>
            ) : null}
          </Card>
        ) : (
          <Card className="mb-3">
            <p className="text-muted">
              No application has been made for this benefit yet.
            </p>
          </Card>
        )}

        {entitlement.expectedPayments.length > 0 ? (
          <Card className="mb-3">
            <h3 className="font-semibold">Expected payments</h3>
            <ul className="mt-2 divide-y">
              {entitlement.expectedPayments.map((expected) => {
                const paid = paidPeriods.has(expected.periodLabel);
                return (
                  <li
                    key={expected.periodLabel}
                    className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                  >
                    <span className="font-medium">{expected.periodLabel}</span>
                    <span className="text-subtle">
                      due {expected.dueOn.toISOString().slice(0, 10)}
                    </span>
                    <span className="font-semibold tabular">
                      <Money paise={serialize(expected.expectedAmountPaise)} />
                    </span>
                    {paid ? (
                      <StatusPill tone="ok" icon="✓">
                        Released
                      </StatusPill>
                    ) : (
                      <StatusPill tone="bad" icon="✕">
                        Nothing recorded
                      </StatusPill>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        ) : null}

        {entitlement.payments.length > 0 ? (
          <ul className="space-y-3">
            {entitlement.payments.map((payment) => {
              const latest = payment.verifications[0] ?? null;
              return (
                <Card as="li" key={payment.id}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-semibold">{payment.periodLabel}</p>
                      <p className="text-sm text-subtle">
                        Government recorded a release on{" "}
                        {payment.reportedOn.toISOString().slice(0, 10)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-semibold tabular">
                        <Money paise={serialize(payment.reportedAmountPaise)} />
                      </p>
                      <ReceiptBadge state={payment.receiptState} />
                    </div>
                  </div>

                  {payment.gapAmountPaise > 0n ? (
                    <p className="mt-2 text-sm font-medium text-[var(--bad)]">
                      <Money paise={serialize(payment.gapAmountPaise)} /> of this did
                      not reach you.
                    </p>
                  ) : null}

                  {latest ? (
                    <WhyDrawer summary="How do we know?">
                      <ul className="space-y-2">
                        {payment.verifications.map((verification, index) => (
                          <li key={index} className="border-t pt-2 first:border-t-0 first:pt-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <StatusPill
                                tone={paymentTone(verification.resultState)}
                                icon="•"
                              >
                                {verification.resultState
                                  .toLowerCase()
                                  .replace(/_/g, " ")}
                              </StatusPill>
                              <span className="text-xs text-subtle">
                                {verification.verifiedAt.toISOString().slice(0, 10)}
                              </span>
                            </div>
                            <p className="mt-1">
                              {verification.citizenReport === "YES"
                                ? "You said you received it."
                                : verification.citizenReport === "NO"
                                  ? "You said it never arrived."
                                  : verification.citizenReport === "NOT_SURE"
                                    ? "You were not sure."
                                    : "No answer from you yet."}
                              {verification.method === "BANK_EVIDENCE" &&
                              verification.matchedAmountPaise !== null ? (
                                <>
                                  {" "}
                                  Bank evidence showed{" "}
                                  <Money
                                    paise={serialize(verification.matchedAmountPaise)}
                                  />
                                  {verification.refLast4
                                    ? ` (reference ending ${verification.refLast4})`
                                    : null}
                                  .
                                </>
                              ) : null}
                            </p>
                            {verification.note ? (
                              <p className="mt-1 text-xs text-subtle">
                                {verification.note}
                              </p>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                      {payment.verifications.some(
                        (v) => v.docSha256 !== null,
                      ) ? (
                        <p className="mt-3 border-t pt-3 text-xs text-subtle">
                          A document was checked for this payment and then
                          discarded. Only the matching amount, its date and a
                          fingerprint of the file were kept.
                        </p>
                      ) : null}
                    </WhyDrawer>
                  ) : null}
                </Card>
              );
            })}
          </ul>
        ) : null}
      </section>

      {/* -------------------------------------------------------- problems */}
      {openGaps.length > 0 ? (
        <section className="mt-8">
          <SectionHeading hint="What we think is wrong, why we think it, and what we propose to do.">
            Problems we found
          </SectionHeading>

          <ul className="space-y-3">
            {openGaps.map((gap) => {
              const cause = gap.rootCauses[0] ?? null;
              const plan = gap.actionPlans[0] ?? null;
              const citedEvidence = (cause?.evidence ?? []) as string[];

              return (
                <Card as="li" key={gap.id} className="border-[var(--bad-border)]">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusPill tone="bad" icon="!">
                      {readable(gap.kind)}
                    </StatusPill>
                    {gap.periodLabel ? (
                      <span className="text-sm text-subtle">{gap.periodLabel}</span>
                    ) : null}
                    {gap.amountPaise !== null ? (
                      <span className="font-semibold tabular text-[var(--bad)]">
                        <Money paise={serialize(gap.amountPaise)} />
                      </span>
                    ) : (
                      <span className="text-xs text-subtle">
                        amount not established
                      </span>
                    )}
                  </div>

                  {cause ? (
                    <div className="mt-3">
                      <p className="text-sm font-medium">
                        Likely cause:{" "}
                        <span className="font-semibold">
                          {cause.kind.toLowerCase().replace(/_/g, " ")}
                        </span>
                        {cause.attempt > 1 ? (
                          <span className="ml-1 text-subtle">
                            (attempt {cause.attempt})
                          </span>
                        ) : null}
                      </p>
                      <p className="mt-1 text-sm text-muted">{cause.reasoning}</p>

                      {citedEvidence.length > 0 ? (
                        <WhyDrawer summary="What makes us think that?">
                          <ul className="list-inside list-disc space-y-1">
                            {citedEvidence.map((line, index) => (
                              <li key={index}>{line}</li>
                            ))}
                          </ul>
                          <p className="mt-3 border-t pt-3 text-xs text-subtle">
                            A cause is only recorded when it can be tied to
                            evidence like this. Where it cannot, we record it as
                            unknown and ask a person to look.
                          </p>
                        </WhyDrawer>
                      ) : (
                        <p className="mt-2 text-xs text-subtle">
                          No supporting evidence was found, so this is recorded as
                          unknown rather than guessed at.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-3 text-sm text-muted">
                      Not yet diagnosed.
                    </p>
                  )}

                  {plan ? (
                    <div className="mt-4 rounded-[var(--radius-card)] border bg-surface-sunken p-4">
                      <p className="font-medium">{plan.summary}</p>
                      <p className="mt-1 text-sm text-muted">
                        If this works: {plan.expectedOutcome}
                      </p>
                      <ol className="mt-3 space-y-2 text-sm">
                        {plan.steps.map((step) => (
                          <li key={step.id} className="flex gap-2">
                            <span className="font-semibold tabular text-subtle">
                              {step.position}.
                            </span>
                            <span>
                              {step.description}
                              <span className="block text-xs text-subtle">
                                {step.reason} · via {step.channel}
                              </span>
                            </span>
                          </li>
                        ))}
                      </ol>

                      {plan.executions.length > 0 ? (
                        <p className="mt-3 border-t pt-3 text-xs text-subtle">
                          {plan.executions.filter((e) => e.status === "SUCCEEDED").length}{" "}
                          of {plan.executions.length} step(s) completed.{" "}
                          {plan.status === "EXECUTED"
                            ? "Carried out — we are now checking whether it actually worked."
                            : plan.status === "FAILED"
                              ? "Something went wrong carrying this out."
                              : null}
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <BenefitActions
                    citizenId={citizen.citizenId}
                    entitlementId={entitlement.id}
                    gapId={gap.id}
                    actionPlanId={plan?.id ?? null}
                    actionPlanStatus={plan?.status ?? null}
                    pendingApprovalId={
                      plan?.approvals.find((a) => a.decision === "PENDING")?.id ??
                      null
                    }
                    lifecycleState={entitlement.lifecycleState}
                  />
                </Card>
              );
            })}
          </ul>
        </section>
      ) : null}

      {resolvedGaps.length > 0 ? (
        <section className="mt-8">
          <SectionHeading hint="Kept on the record, because what went wrong matters even once it is fixed.">
            Problems since resolved ({resolvedGaps.length})
          </SectionHeading>
          <ul className="space-y-2">
            {resolvedGaps.map((gap) => (
              <li
                key={gap.id}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border bg-surface px-4 py-3 text-sm"
              >
                <StatusPill tone="ok" icon="✓">
                  Resolved
                </StatusPill>
                <span>{readable(gap.kind)}</span>
                {gap.periodLabel ? (
                  <span className="text-subtle">{gap.periodLabel}</span>
                ) : null}
                <span className="ml-auto text-xs text-subtle">
                  {gap.resolvedAt?.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ------------------------------------------------- audit findings */}
      {latestAudit ? (
        <section className="mt-8">
          <SectionHeading
            hint={`Last checked ${latestAudit.runAt.toISOString().slice(0, 16).replace("T", " ")}`}
          >
            Our last check
          </SectionHeading>
          <Card>
            <p>{latestAudit.summary}</p>
            <WhyDrawer summary="Show everything we looked at">
              <ul className="space-y-3">
                {latestAudit.findings.map((finding) => (
                  <li key={finding.id} className="border-t pt-3 first:border-t-0 first:pt-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
                      {finding.area.toLowerCase().replace(/_/g, " ")}
                    </p>
                    <p className="mt-0.5">{finding.summary}</p>
                  </li>
                ))}
              </ul>
            </WhyDrawer>
          </Card>
        </section>
      ) : null}

      {/* -------------------------------------------------------- history */}
      <section className="mt-8">
        <SectionHeading hint="Everything that has happened to this benefit, and who did it.">
          Full history
        </SectionHeading>
        <Card>
          <ol className="space-y-3">
            {trail.map((entry) => (
              <li key={entry.id} className="flex gap-3 border-t pt-3 first:border-t-0 first:pt-0">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-[var(--accent)]" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {entry.toState
                      ? entry.toState.toLowerCase().replace(/_/g, " ")
                      : entry.reason}
                  </p>
                  <p className="text-sm text-muted">{entry.reason}</p>
                  <p className="mt-0.5 text-xs text-subtle">
                    {entry.createdAt.toISOString().slice(0, 16).replace("T", " ")} ·{" "}
                    {entry.actor.startsWith("citizen:")
                      ? "you"
                      : entry.actor.startsWith("agent:")
                        ? `${entry.actor.slice(6)} step`
                        : entry.actor}
                  </p>
                </div>
              </li>
            ))}
            {trail.length === 0 ? (
              <li className="text-muted">Nothing has happened yet.</li>
            ) : null}
          </ol>
        </Card>
      </section>

      <div className="mt-8">
        <Link href="/dashboard" className={buttonClass.secondary}>
          ← Back to all benefits
        </Link>
      </div>
    </main>
  );
}
