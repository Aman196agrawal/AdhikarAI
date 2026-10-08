/**
 * The approval screen. Both gates, one page.
 *
 * This is where consent actually happens, so the standard is that nothing
 * consequential is hidden behind a summary. For a corrective action that means
 * the problem, the evidence cited, the diagnosed cause, how confident we are
 * in it, every step we propose, and what we expect to change if it works.
 *
 * The page renders from the approval's stored `shownEvidence` snapshot rather
 * than re-deriving it. That matters: the snapshot is what the citizen is
 * agreeing to, and it is the same record kept afterwards — so what they saw
 * and what we can later prove they saw cannot drift apart.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { deserialize, formatINR } from "@/lib/engine/money";
import { requireSelectedCitizen } from "@/lib/session";
import { ApprovalDecision } from "@/components/ApprovalDecision";
import {
  Card,
  SectionHeading,
  StatusPill,
  WhyDrawer,
  buttonClass,
} from "@/components/ui";

export const dynamic = "force-dynamic";

interface ActionEvidence {
  schemeName?: string;
  schemeCode?: string;
  problem?: string;
  problemDetail?: string[];
  rootCause?: string;
  rootCauseConfidence?: number;
  rootCauseReasoning?: string;
  citedEvidence?: string[];
  attempt?: number;
  planSummary?: string;
  expectedOutcome?: string;
  steps?: Array<{
    position: number;
    kind: string;
    description: string;
    reason: string;
    channel: string;
  }>;
  isMockExecution?: boolean;
}

interface ApplicationEvidence {
  schemeName?: string;
  schemeCode?: string;
  benefitNote?: string | null;
  expectedAmountPaise?: string | null;
  frequency?: string;
  applicationMethod?: string;
  fields?: Array<{ key: string; source: string }>;
  documents?: Array<{ kind: string; provided: boolean }>;
  declarations?: string[];
  governmentTarget?: string;
  isMockSubmission?: boolean;
}

export default async function ApprovalPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const citizen = await requireSelectedCitizen();

  const approval = await prisma.approval.findFirst({
    where: {
      id,
      OR: [
        { application: { entitlement: { citizenId: citizen.citizenId } } },
        { actionPlan: { gap: { entitlement: { citizenId: citizen.citizenId } } } },
      ],
    },
    include: {
      application: { include: { entitlement: { include: { scheme: true } } } },
      actionPlan: {
        include: { gap: { include: { entitlement: { include: { scheme: true } } } } },
      },
    },
  });

  if (!approval) notFound();

  const isAction = approval.kind === "CORRECTIVE_ACTION";
  const benefitId = isAction
    ? approval.actionPlan?.gap.entitlementId
    : approval.application?.entitlementId;

  if (approval.decision !== "PENDING") {
    return (
      <main className="mx-auto max-w-2xl px-4 py-10">
        <Card>
          <StatusPill
            tone={approval.decision === "APPROVED" ? "ok" : "neutral"}
            icon={approval.decision === "APPROVED" ? "✓" : "–"}
          >
            Already {approval.decision.toLowerCase()}
          </StatusPill>
          <p className="mt-3 text-muted">
            You decided this on{" "}
            {approval.decidedAt?.toISOString().slice(0, 16).replace("T", " ") ??
              "an earlier date"}
            .
          </p>
          <Link
            href={benefitId ? `/benefit/${benefitId}` : "/dashboard"}
            className={`${buttonClass.secondary} mt-4`}
          >
            Back to the benefit
          </Link>
        </Card>
      </main>
    );
  }

  /* ---------------------------------------------------- corrective action */
  if (isAction) {
    const evidence = approval.shownEvidence as ActionEvidence;
    const confidence = evidence.rootCauseConfidence ?? 0;

    return (
      <main className="mx-auto max-w-2xl px-4 py-8">
        <Link
          href={benefitId ? `/benefit/${benefitId}` : "/dashboard"}
          className="text-sm font-medium text-accent hover:underline"
        >
          ← Back
        </Link>

        <h1 className="mt-4 text-2xl font-bold sm:text-3xl">
          Shall we do this for you?
        </h1>
        <p className="mt-2 text-muted">
          Nothing below has been done yet. We will only act if you say yes.
        </p>

        <Card className="mt-6">
          <SectionHeading>The problem</SectionHeading>
          <p className="font-medium">
            {evidence.schemeName} —{" "}
            {evidence.problem?.toLowerCase().replace(/_/g, " ")}
          </p>
          {evidence.problemDetail && evidence.problemDetail.length > 0 ? (
            <ul className="mt-2 list-inside list-disc text-sm text-muted">
              {evidence.problemDetail.map((line, index) => (
                <li key={index}>{line}</li>
              ))}
            </ul>
          ) : null}
        </Card>

        <Card className="mt-4">
          <SectionHeading>What we think caused it</SectionHeading>
          <div className="flex flex-wrap items-center gap-2">
            <StatusPill tone="accent" icon="◆">
              {evidence.rootCause?.toLowerCase().replace(/_/g, " ")}
            </StatusPill>
            {/*
              Confidence is shown as a word, not a percentage. This is an
              interpretation of what a government system wrote, and dressing it
              as a precise figure would overstate it.
            */}
            <StatusPill
              tone={confidence >= 0.7 ? "ok" : confidence >= 0.4 ? "warn" : "neutral"}
              icon="◷"
            >
              {confidence >= 0.7
                ? "well supported"
                : confidence >= 0.4
                  ? "reasonably supported"
                  : "weakly supported"}
            </StatusPill>
            {(evidence.attempt ?? 1) > 1 ? (
              <StatusPill tone="warn" icon="↻">
                Attempt {evidence.attempt}
              </StatusPill>
            ) : null}
          </div>

          <p className="mt-3 text-muted">{evidence.rootCauseReasoning}</p>

          {evidence.citedEvidence && evidence.citedEvidence.length > 0 ? (
            <WhyDrawer summary="What are we basing that on?">
              <ul className="list-inside list-disc space-y-1">
                {evidence.citedEvidence.map((line, index) => (
                  <li key={index}>{line}</li>
                ))}
              </ul>
            </WhyDrawer>
          ) : (
            <p className="mt-2 text-sm text-subtle">
              We could not tie this to specific evidence, so it is recorded as
              unknown rather than guessed at.
            </p>
          )}
        </Card>

        <Card className="mt-4">
          <SectionHeading>What we propose to do</SectionHeading>
          <p className="font-medium">{evidence.planSummary}</p>

          <ol className="mt-3 space-y-3">
            {(evidence.steps ?? []).map((step) => (
              <li key={step.position} className="flex gap-3 border-t pt-3 first:border-t-0 first:pt-0">
                <span className="font-semibold tabular text-subtle">
                  {step.position}.
                </span>
                <div>
                  <p className="font-medium">{step.description}</p>
                  <p className="text-sm text-muted">{step.reason}</p>
                  <p className="mt-0.5 text-xs text-subtle">Via {step.channel}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-4 rounded-[var(--radius-card)] border bg-surface-sunken px-3 py-2 text-sm">
            <strong className="font-semibold">If this works:</strong>{" "}
            {evidence.expectedOutcome}
          </p>

          {evidence.isMockExecution ? (
            <p className="mt-3 text-xs text-[var(--demo)]">
              ▲ In this prototype these steps run against a simulated portal and
              grievance channel. Nothing is sent to a real government system.
            </p>
          ) : null}
        </Card>

        <div className="mt-6">
          <ApprovalDecision
            citizenId={citizen.citizenId}
            approvalId={approval.id}
            benefitId={benefitId ?? null}
            approveLabel="Yes, go ahead"
            rejectLabel="No, not now"
            rejectHint="We will leave this alone. The problem stays on your list."
          />
        </div>
      </main>
    );
  }

  /* -------------------------------------------------------- application */
  const evidence = approval.shownEvidence as ApplicationEvidence;

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <Link
        href={benefitId ? `/benefit/${benefitId}` : "/dashboard"}
        className="text-sm font-medium text-accent hover:underline"
      >
        ← Back
      </Link>

      <h1 className="mt-4 text-2xl font-bold sm:text-3xl">
        Shall we send this application?
      </h1>
      <p className="mt-2 text-muted">
        Check it over. Nothing is sent until you say yes.
      </p>

      <Card className="mt-6">
        <SectionHeading>What you would be applying for</SectionHeading>
        <p className="text-lg font-semibold">{evidence.schemeName}</p>
        {evidence.expectedAmountPaise ? (
          <p className="mt-1">
            <span className="text-2xl font-bold tabular">
              {formatINR(deserialize(evidence.expectedAmountPaise))}
            </span>
            <span className="ml-1 text-muted">
              {evidence.frequency === "MONTHLY"
                ? "each month"
                : evidence.frequency === "TRIANNUAL"
                  ? "per instalment, three times a year"
                  : evidence.frequency === "ONE_TIME"
                    ? "once"
                    : ""}
            </span>
          </p>
        ) : null}
        {evidence.benefitNote ? (
          <p className="mt-2 text-sm text-muted">{evidence.benefitNote}</p>
        ) : null}
      </Card>

      <Card className="mt-4">
        <SectionHeading hint="We filled these in from what you told us. You can see where each came from.">
          What is on the form
        </SectionHeading>
        <ul className="divide-y text-sm">
          {(evidence.fields ?? []).map((field) => (
            <li key={field.key} className="flex items-center justify-between gap-3 py-2">
              <span className="font-medium">
                {field.key.replace(/([A-Z])/g, " $1").toLowerCase()}
              </span>
              <span className="text-xs text-subtle">
                {field.source === "PREFILLED_FROM_PROFILE"
                  ? "from what you told us"
                  : field.source === "CITIZEN_EDITED"
                    ? "you entered this"
                    : "scheme default"}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-subtle">
          Your Aadhaar and account numbers are on the form but are not repeated
          here, and are not copied into our record of this approval.
        </p>
      </Card>

      {evidence.documents && evidence.documents.length > 0 ? (
        <Card className="mt-4">
          <SectionHeading>Documents</SectionHeading>
          <ul className="space-y-1.5 text-sm">
            {evidence.documents.map((doc) => (
              <li key={doc.kind} className="flex items-center gap-2">
                <StatusPill tone={doc.provided ? "ok" : "warn"} icon={doc.provided ? "✓" : "?"}>
                  {doc.provided ? "Attached" : "Not attached"}
                </StatusPill>
                <span>{doc.kind.toLowerCase().replace(/_/g, " ")}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {evidence.declarations && evidence.declarations.length > 0 ? (
        <Card className="mt-4 border-[var(--warn-border)]">
          <SectionHeading hint="This scheme requires you to confirm these. Please read them.">
            What you are declaring
          </SectionHeading>
          <ul className="list-inside list-disc space-y-1 text-sm">
            {evidence.declarations.map((code) => (
              <li key={code}>
                That the exclusion &ldquo;{code.toLowerCase().replace(/^excl_/, "").replace(/_/g, " ")}
                &rdquo; does not apply to you.
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card className="mt-4">
        <SectionHeading>Where it goes</SectionHeading>
        <p className="text-sm">{evidence.applicationMethod}</p>
        {evidence.isMockSubmission ? (
          <p className="mt-2 text-xs text-[var(--demo)]">
            ▲ In this prototype the application goes to a simulated portal, not a
            real government system.
          </p>
        ) : null}
      </Card>

      <div className="mt-6">
        <ApprovalDecision
          citizenId={citizen.citizenId}
          approvalId={approval.id}
          benefitId={benefitId ?? null}
          approveLabel="Yes, send it"
          rejectLabel="No, not yet"
          rejectHint="We will keep it as a draft so you can come back to it."
          submitAfterApproval
        />
      </div>
    </main>
  );
}
