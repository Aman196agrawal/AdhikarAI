/**
 * The dashboard: the screen the whole product is judged on.
 *
 * Layout order is a deliberate argument. What is waiting on the citizen comes
 * first, because an alert nobody acts on is worthless. The four money totals
 * come next, each labelled with what it actually means. The benefit cards come
 * last, grouped so problems are not buried among healthy benefits.
 *
 * The four totals are never summed. "Received", "not yet confirmed", "did not
 * arrive" and "you may be entitled to" are four different claims with four
 * different strengths of evidence, and a single headline number would be a
 * lie about at least three of them.
 */

import Link from "next/link";

import { deserialize, formatINR } from "@/lib/engine/money";
import { translator } from "@/lib/i18n";
import { resolveLocale } from "@/lib/locale";
import { buildDashboard, type BenefitCard } from "@/lib/services/dashboard";
import { currentClock } from "@/lib/services/clock";
import { requireSelectedCitizen } from "@/lib/session";
import { LocaleToggle } from "@/components/LocaleToggle";
import { ReceiptAnswer } from "@/components/ReceiptAnswer";
import {
  Card,
  DecisionBadge,
  DemoBadge,
  EmptyState,
  Money,
  ReceiptBadge,
  SectionHeading,
  StatTile,
  StatusPill,
  VerdictBadge,
  buttonClass,
} from "@/components/ui";

export const dynamic = "force-dynamic";

/** Problems first, then things that need an answer, then the rest. */
function groupBenefits(benefits: BenefitCard[]) {
  return {
    actionRequired: benefits.filter((b) => b.decision === "ACTION_REQUIRED"),
    needsVerification: benefits.filter(
      (b) => b.decision === "NEEDS_VERIFICATION",
    ),
    healthy: benefits.filter((b) => b.decision === "HEALTHY"),
    other: benefits.filter(
      (b) => b.decision === null && b.verdict !== "RED",
    ),
    excluded: benefits.filter((b) => b.verdict === "RED"),
  };
}

function BenefitRow({ benefit }: { benefit: BenefitCard }) {
  const hasMissing = benefit.provenMissingPaise !== "0";
  const hasUnverified = benefit.unverifiedAmountPaise !== "0";

  return (
    <Card as="li">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-lg font-semibold leading-snug">
            <Link href={`/benefit/${benefit.id}`} className="hover:underline">
              {benefit.schemeName}
            </Link>
          </h3>
          {benefit.schemeNameHi ? (
            <p className="text-sm text-subtle">{benefit.schemeNameHi}</p>
          ) : null}
          <p className="mt-0.5 text-sm text-muted">{benefit.category}</p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {benefit.decision ? (
            <DecisionBadge decision={benefit.decision} />
          ) : (
            <VerdictBadge verdict={benefit.verdict} />
          )}
        </div>
      </div>

      {/* Expected amount, hedged correctly for in-kind benefits. */}
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-subtle">Expected</dt>
          <dd className="font-semibold">
            <Money
              paise={benefit.expectedAmountPaise}
              nullLabel={benefit.benefitType === "IN_KIND" ? "In kind" : "Varies"}
            />
            {benefit.expectedAmountPaise !== null ? (
              <span className="ml-1 font-normal text-subtle">
                {benefit.frequency === "MONTHLY"
                  ? "/month"
                  : benefit.frequency === "TRIANNUAL"
                    ? "/instalment"
                    : ""}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt className="text-subtle">Received</dt>
          <dd className="font-semibold tabular text-[var(--ok)]">
            <Money paise={benefit.receivedAmountPaise} />
          </dd>
        </div>
        <div>
          <dt className="text-subtle">Not yet confirmed</dt>
          <dd
            className={`font-semibold tabular ${hasUnverified ? "text-[var(--warn)]" : "text-subtle"}`}
          >
            <Money paise={benefit.unverifiedAmountPaise} />
          </dd>
        </div>
        <div>
          <dt className="text-subtle">Did not arrive</dt>
          <dd
            className={`font-semibold tabular ${hasMissing ? "text-[var(--bad)]" : "text-subtle"}`}
          >
            <Money paise={benefit.provenMissingPaise} />
          </dd>
        </div>
      </dl>

      {benefit.receiptState ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <ReceiptBadge state={benefit.receiptState} />
          {benefit.isDemoData ? <DemoBadge>Simulated government data</DemoBadge> : null}
        </div>
      ) : null}

      {benefit.decisionSummary ? (
        <p className="mt-3 text-sm text-muted">{benefit.decisionSummary}</p>
      ) : null}

      {benefit.openGaps.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {benefit.openGaps.map((gap) => (
            <li key={gap.id} className="flex flex-wrap items-center gap-2 text-sm">
              <StatusPill tone="bad" icon="!">
                {gap.readable}
              </StatusPill>
              {gap.periodLabel ? (
                <span className="text-subtle">{gap.periodLabel}</span>
              ) : null}
              {gap.amountPaise !== null ? (
                <span className="font-semibold tabular text-[var(--bad)]">
                  <Money paise={gap.amountPaise} />
                </span>
              ) : (
                <span className="text-xs text-subtle">amount not established</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {benefit.verdict === "YELLOW" && benefit.missingEvidence.length > 0 ? (
        <p className="mt-3 rounded-[var(--radius-card)] border border-[var(--warn-border)] bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn)]">
          To be sure, we still need: {benefit.missingEvidence[0]}
        </p>
      ) : null}

      <div className="mt-4">
        <Link
          href={`/benefit/${benefit.id}`}
          className="text-sm font-medium text-accent hover:underline"
        >
          See everything about this benefit →
        </Link>
      </div>
    </Card>
  );
}

export default async function DashboardPage() {
  const citizen = await requireSelectedCitizen();
  const locale = await resolveLocale(citizen.locale);
  const t = translator(locale);
  const clock = await currentClock();
  const data = await buildDashboard({ citizenId: citizen.citizenId, clock });

  const groups = groupBenefits(data.benefits);
  const receiptActions = data.pendingActions.filter(
    (a) => a.kind === "CONFIRM_RECEIPT",
  );
  const approvalActions = data.pendingActions.filter(
    (a) => a.kind === "APPROVE_ACTION" || a.kind === "APPROVE_APPLICATION",
  );
  const otherActions = data.pendingActions.filter(
    (a) => a.kind === "START_APPLICATION" || a.kind === "ANSWER_QUESTION",
  );

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-accent">
            AdhikarAI
          </p>
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
            {data.citizen.name}
            {data.citizen.nameHi ? (
              <span className="ml-2 text-lg font-normal text-subtle">
                {data.citizen.nameHi}
              </span>
            ) : null}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {data.clock.isSimulated ? (
            <StatusPill tone="demo" icon="◷">
              Demo clock: {data.clock.now.slice(0, 10)}
            </StatusPill>
          ) : null}
          <LocaleToggle locale={locale} />
          <Link href="/onboard" className={buttonClass.secondary}>
            {locale === "hi" ? "मेरी जानकारी" : "My details"}
          </Link>
          <Link href="/" className={buttonClass.secondary}>
            {t("app.switchPerson")}
          </Link>
        </div>
      </header>

      {/* ------------------------------------------------- waiting on you */}
      {receiptActions.length > 0 ? (
        <section className="mt-8">
          <SectionHeading hint={t("actions.askHint")}>
            {t("actions.askHeading")}
          </SectionHeading>
          <ul className="space-y-3">
            {receiptActions.map((action) => (
              <Card as="li" key={action.paymentId} className="border-[var(--warn-border)]">
                <ReceiptAnswer
                  citizenId={citizen.citizenId}
                  paymentId={action.paymentId ?? ""}
                  schemeName={action.schemeName ?? "this scheme"}
                  periodLabel={action.periodLabel ?? "this period"}
                  amountLabel={
                    action.amountPaise
                      ? formatINR(deserialize(action.amountPaise))
                      : "a payment"
                  }
                  locale={locale}
                />
              </Card>
            ))}
          </ul>
        </section>
      ) : null}

      {approvalActions.length > 0 ? (
        <section className="mt-8">
          <SectionHeading hint={t("actions.approvalHint")}>
            {t("actions.approvalHeading")}
          </SectionHeading>
          <ul className="space-y-3">
            {approvalActions.map((action) => (
              <Card as="li" key={action.approvalId} className="border-[var(--accent-ring)]">
                <p className="font-medium">{action.prompt}</p>
                <Link
                  href={`/approve/${action.approvalId}`}
                  className={`${buttonClass.primary} mt-3`}
                >
                  {t("actions.review")}
                  <span aria-hidden="true">→</span>
                </Link>
              </Card>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ----------------------------------------------------- the totals */}
      <section className="mt-8">
        <SectionHeading hint={t("money.headingHint")}>
          {t("money.heading")}
        </SectionHeading>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            label={t("money.received")}
            paise={data.totals.receivedPaise}
            hedge={t("money.receivedHedge")}
            tone="ok"
          />
          <StatTile
            label={t("money.unverified")}
            paise={data.totals.unverifiedPaise}
            hedge={t("money.unverifiedHedge")}
            tone="warn"
          />
          <StatTile
            label={t("money.missing")}
            paise={data.totals.provenMissingPaise}
            hedge={t("money.missingHedge")}
            tone="bad"
          />
          <StatTile
            label={t("money.potential")}
            paise={data.totals.potentialAnnualPaise}
            hedge={t("money.potentialHedge")}
          />
        </div>

        {data.totals.recoveredPaise !== "0" ? (
          <p className="mt-3 rounded-[var(--radius-card)] border border-[var(--ok-border)] bg-[var(--ok-soft)] px-4 py-3 text-[var(--ok)]">
            <strong className="font-semibold">
              <Money paise={data.totals.recoveredPaise} /> recovered
            </strong>{" "}
            — money that had not reached you and now has.
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------ benefit groups */}
      <section className="mt-10 space-y-8">
        {groups.actionRequired.length > 0 ? (
          <div>
            <SectionHeading hint={t("group.needsActionHint")}>
              {t("group.needsAction")} ({groups.actionRequired.length})
            </SectionHeading>
            <ul className="space-y-3">
              {groups.actionRequired.map((b) => (
                <BenefitRow key={b.id} benefit={b} />
              ))}
            </ul>
          </div>
        ) : null}

        {groups.needsVerification.length > 0 ? (
          <div>
            <SectionHeading hint={t("group.needsCheckingHint")}>
              {t("group.needsChecking")} ({groups.needsVerification.length})
            </SectionHeading>
            <ul className="space-y-3">
              {groups.needsVerification.map((b) => (
                <BenefitRow key={b.id} benefit={b} />
              ))}
            </ul>
          </div>
        ) : null}

        {otherActions.length > 0 ? (
          <div>
            <SectionHeading hint={t("group.notClaimedHint")}>
              {t("group.notClaimed")} ({otherActions.length})
            </SectionHeading>
            <ul className="space-y-3">
              {otherActions.map((action) => (
                <Card as="li" key={`${action.kind}-${action.benefitId}`}>
                  <p className="font-medium">{action.prompt}</p>
                  {action.amountPaise ? (
                    <p className="mt-1 text-sm text-muted">
                      Worth about{" "}
                      <strong className="font-semibold text-foreground">
                        <Money paise={action.amountPaise} />
                      </strong>{" "}
                      a year, if you qualify.
                    </p>
                  ) : null}
                  {action.benefitId ? (
                    <Link
                      href={`/benefit/${action.benefitId}`}
                      className={`${buttonClass.secondary} mt-3`}
                    >
                      Look into it
                    </Link>
                  ) : null}
                </Card>
              ))}
            </ul>
          </div>
        ) : null}

        {groups.healthy.length > 0 ? (
          <div>
            <SectionHeading hint={t("group.allInOrderHint")}>
              {t("group.allInOrder")} ({groups.healthy.length})
            </SectionHeading>
            <ul className="space-y-3">
              {groups.healthy.map((b) => (
                <BenefitRow key={b.id} benefit={b} />
              ))}
            </ul>
          </div>
        ) : null}

        {groups.other.length > 0 ? (
          <div>
            <SectionHeading hint="Checked, but not yet applied for.">
              Other benefits we checked ({groups.other.length})
            </SectionHeading>
            <ul className="space-y-3">
              {groups.other.map((b) => (
                <BenefitRow key={b.id} benefit={b} />
              ))}
            </ul>
          </div>
        ) : null}

        {groups.excluded.length > 0 ? (
          <div>
            {/*
              Excluded schemes are shown, not hidden. A citizen is entitled to
              know a scheme was considered and why it does not apply - that is
              how they can tell the system looked properly, and how they can
              correct it if it is wrong about them.
            */}
            <SectionHeading hint={t("group.doesNotApplyHint")}>
              {t("group.doesNotApply")} ({groups.excluded.length})
            </SectionHeading>
            <ul className="space-y-2">
              {groups.excluded.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-card)] border bg-surface px-4 py-3"
                >
                  <Link href={`/benefit/${b.id}`} className="font-medium hover:underline">
                    {b.schemeName}
                  </Link>
                  <StatusPill tone="neutral" icon="–">
                    Does not apply
                  </StatusPill>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {data.benefits.length === 0 ? (
          <EmptyState>
            No benefits have been worked out yet for this person.
          </EmptyState>
        ) : null}
      </section>
    </main>
  );
}
