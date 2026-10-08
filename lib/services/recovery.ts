/**
 * The recovery loop: diagnose, plan, approve, act, re-verify, repeat.
 *
 * This is the product. Everything before it exists in some form elsewhere;
 * what distinguishes AdhikarAI is that a detected gap is pursued until it is
 * resolved or explicitly escalated, and that a corrective action which did not
 * work sends the case back to be diagnosed again rather than being marked
 * done.
 *
 * Two rules hold the loop honest:
 *
 *   1. `executeActionPlan` refuses without an APPROVED approval. Approval gate
 *      2 is enforced in code, exactly as gate 1 is, because these actions file
 *      grievances and submit corrections in a citizen's name.
 *   2. `reverifyBenefit` NEVER infers success from "the action completed".
 *      It re-reads the government's record and reconciles again. An action
 *      that ran successfully and changed nothing is a failure, and the loop
 *      must be able to say so.
 */

import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/http";
import type { Clock } from "@/lib/clock";
import { govGateway } from "@/lib/adapters/mockGovGateway";
import { grievanceProvider } from "@/lib/adapters/grievance";
import { diagnoseGap, type EvidenceItem } from "@/lib/agents/rootCause";
import { planCorrectiveAction } from "@/lib/agents/actionPlanner";
import { paise, ZERO, type Paise } from "@/lib/engine/money";
import { log } from "@/lib/log";
import { requireScheme } from "@/lib/registry";
import { auditBenefit } from "./audit";
import { recordAudit, transitionEntitlement, type Actor } from "./transitions";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { ActionKind, ExecutionStatus } from "@/lib/generated/prisma/enums";

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Diagnose and plan
// ---------------------------------------------------------------------------

export interface DiagnoseAndPlanResult {
  gapId: string;
  attempt: number;
  rootCauseId: string;
  rootCauseKind: string;
  rootCauseConfidence: number;
  actionPlanId: string;
  planSummary: string;
  expectedOutcome: string;
  steps: Array<{ position: number; kind: ActionKind; description: string; reason: string }>;
  approvalId: string;
  /** Set when the planner replaced or filtered the model's proposal. */
  adjusted?: string;
}

/**
 * Diagnose a gap and prepare a corrective action plan for approval.
 *
 * Gathers evidence from the government's event log and the audit findings,
 * diagnoses, plans, and opens approval gate 2. Nothing is executed.
 */
export async function diagnoseAndPlan(input: {
  citizenId: string;
  gapId: string;
  clock: Clock;
  actor?: Actor;
}): Promise<DiagnoseAndPlanResult> {
  const actor: Actor = input.actor ?? { kind: "agent", name: "diagnosis" };
  const now = input.clock.now();

  const gap = await prisma.benefitGap.findFirstOrThrow({
    where: { id: input.gapId, entitlement: { citizenId: input.citizenId } },
    include: {
      entitlement: {
        include: { scheme: true, application: true },
      },
      rootCauses: { orderBy: { attempt: "desc" } },
      actionPlans: {
        orderBy: { attempt: "desc" },
        include: { steps: true, executions: true },
      },
      audit: { include: { findings: true } },
    },
  });

  const entitlement = gap.entitlement;
  const scheme = requireScheme(entitlement.scheme.code);
  const attempt = (gap.rootCauses[0]?.attempt ?? 0) + 1;

  // -------------------------------------------------------------------------
  // Evidence, gathered from the record rather than imagined
  // -------------------------------------------------------------------------
  const evidence: EvidenceItem[] = [];

  for (const line of (gap.evidence as string[] | null) ?? []) {
    evidence.push({ source: "gap detection", detail: String(line) });
  }

  for (const finding of gap.audit?.findings ?? []) {
    evidence.push({ source: `audit: ${finding.area}`, detail: finding.summary });
  }

  const applicationRef = entitlement.application?.govApplicationRef ?? null;
  if (applicationRef) {
    const status = await govGateway().getApplicationStatus(applicationRef);
    for (const event of status?.events ?? []) {
      evidence.push({
        source: `government status (${event.status})`,
        detail: event.note,
      });
    }
    if (status?.rejectionReason) {
      evidence.push({
        source: "government rejection reason",
        detail: status.rejectionReason,
      });
    }
  }

  // What has already been tried, so neither diagnosis nor plan repeats it.
  const previousAttempts = gap.actionPlans
    .filter((plan) => plan.executions.length > 0)
    .map((plan) => {
      const cause = gap.rootCauses.find((rc) => rc.attempt === plan.attempt);
      const worst = plan.executions.find((e) => e.status !== "SUCCEEDED");
      return {
        cause: cause?.kind ?? "UNKNOWN",
        action: plan.steps.map((s) => s.kind).join(", "),
        outcome:
          worst?.error ??
          (plan.status === "EXECUTED"
            ? "the action completed but the benefit still did not arrive"
            : plan.status),
      };
    });

  const failedActions: ActionKind[] = gap.actionPlans
    .filter((plan) => plan.status === "EXECUTED" || plan.status === "FAILED")
    .flatMap((plan) => plan.steps.map((s) => s.kind));

  // -------------------------------------------------------------------------
  // Diagnose
  // -------------------------------------------------------------------------
  const diagnosis = await diagnoseGap({
    schemeCode: entitlement.scheme.code,
    schemeName: entitlement.scheme.name,
    gapKind: gap.kind,
    gapDetail:
      ((gap.evidence as string[] | null) ?? []).join(" ") ||
      `A ${gap.kind} gap was detected.`,
    evidence,
    attempt,
    previousAttempts,
  });

  const rootCause = await prisma.rootCause.create({
    data: {
      gapId: gap.id,
      attempt,
      kind: diagnosis.kind,
      confidence: diagnosis.confidence,
      evidence: asJson(diagnosis.citedEvidence),
      recommendedAction: diagnosis.recommendedAction,
      reasoning: diagnosis.reasoning,
      createdAt: now,
    },
  });

  // Walk the real path rather than jumping to the end of it. A second
  // diagnosis starts from RE_AUDIT_REQUIRED, and the audit trail should show
  // the case passing back through gap detection and diagnosis, not teleporting
  // into "awaiting approval".
  if (entitlement.lifecycleState === "RE_AUDIT_REQUIRED") {
    await transitionEntitlement(prisma, {
      entitlementId: entitlement.id,
      citizenId: input.citizenId,
      to: "GAP_DETECTED",
      actor,
      reason: "Re-auditing after a corrective action failed to resolve the gap.",
      evidenceRef: gap.id,
      from: entitlement.lifecycleState,
    });
  }

  const beforeDiagnosis = await prisma.entitlement.findUniqueOrThrow({
    where: { id: entitlement.id },
    select: { lifecycleState: true },
  });

  if (beforeDiagnosis.lifecycleState === "GAP_DETECTED") {
    await transitionEntitlement(prisma, {
      entitlementId: entitlement.id,
      citizenId: input.citizenId,
      to: "ROOT_CAUSE_IDENTIFIED",
      actor,
      reason: `Diagnosed as ${diagnosis.kind}: ${diagnosis.reasoning}`,
      evidenceRef: rootCause.id,
      from: beforeDiagnosis.lifecycleState,
    });
  }

  // -------------------------------------------------------------------------
  // Plan
  // -------------------------------------------------------------------------
  const plan = await planCorrectiveAction({
    schemeCode: entitlement.scheme.code,
    schemeName: entitlement.scheme.name,
    gapKind: gap.kind,
    gapDetail: ((gap.evidence as string[] | null) ?? []).join(" "),
    rootCause: diagnosis.kind,
    rootCauseReasoning: diagnosis.reasoning,
    citedEvidence: diagnosis.citedEvidence,
    recommendedAction: diagnosis.recommendedAction,
    attempt,
    failedActions,
    applicationUrl: scheme.applicationUrl,
  });

  // Supersede any earlier plan for this gap, so only one is live at a time.
  await prisma.actionPlan.updateMany({
    where: {
      gapId: gap.id,
      status: { in: ["DRAFT", "AWAITING_APPROVAL", "APPROVED"] },
    },
    data: { status: "SUPERSEDED" },
  });

  const actionPlan = await prisma.actionPlan.create({
    data: {
      gapId: gap.id,
      attempt,
      status: "AWAITING_APPROVAL",
      summary: plan.summary,
      expectedOutcome: plan.expectedOutcome,
      evidenceNeeded: plan.evidenceNeeded,
      createdAt: now,
      steps: {
        create: plan.steps.map((step, index) => ({
          position: index + 1,
          kind: step.kind,
          description: step.description,
          reason: step.reason,
          documentsRequired: step.documentsRequired.filter((d) =>
            isDocumentKind(d),
          ) as never,
          informationRequired: step.informationRequired,
          channel: step.channel,
        })),
      },
    },
    include: { steps: { orderBy: { position: "asc" } } },
  });

  // -------------------------------------------------------------------------
  // Approval gate 2
  // -------------------------------------------------------------------------
  const approval = await prisma.approval.create({
    data: {
      kind: "CORRECTIVE_ACTION",
      actionPlanId: actionPlan.id,
      decision: "PENDING",
      shownEvidence: asJson({
        schemeCode: entitlement.scheme.code,
        schemeName: entitlement.scheme.name,
        problem: gap.kind,
        problemDetail: (gap.evidence as string[] | null) ?? [],
        rootCause: diagnosis.kind,
        rootCauseConfidence: diagnosis.confidence,
        rootCauseReasoning: diagnosis.reasoning,
        citedEvidence: diagnosis.citedEvidence,
        attempt,
        planSummary: plan.summary,
        expectedOutcome: plan.expectedOutcome,
        steps: actionPlan.steps.map((s) => ({
          position: s.position,
          kind: s.kind,
          description: s.description,
          reason: s.reason,
          channel: s.channel,
        })),
        isMockExecution: govGateway().isMock,
      }),
      createdAt: now,
    },
  });

  // ROOT_CAUSE_IDENTIFIED -> ACTION_PLANNED -> AWAITING_ACTION_APPROVAL, in
  // order. The intermediate state is not decoration: a plan existing and a
  // plan awaiting consent are different things, and the gap between them is
  // where a reviewer looks.
  await transitionEntitlement(prisma, {
    entitlementId: entitlement.id,
    citizenId: input.citizenId,
    to: "ACTION_PLANNED",
    actor,
    reason: `Prepared a corrective action plan (attempt ${attempt}): ${plan.summary}`,
    evidenceRef: actionPlan.id,
  });

  await transitionEntitlement(prisma, {
    entitlementId: entitlement.id,
    citizenId: input.citizenId,
    to: "AWAITING_ACTION_APPROVAL",
    actor,
    reason: `Action plan prepared (attempt ${attempt}) and awaiting the citizen's approval.`,
    evidenceRef: approval.id,
  });

  log.info("recovery.planned", {
    gapId: gap.id,
    attempt,
    rootCause: diagnosis.kind,
    steps: actionPlan.steps.length,
  });

  return {
    gapId: gap.id,
    attempt,
    rootCauseId: rootCause.id,
    rootCauseKind: diagnosis.kind,
    rootCauseConfidence: diagnosis.confidence,
    actionPlanId: actionPlan.id,
    planSummary: plan.summary,
    expectedOutcome: plan.expectedOutcome,
    steps: actionPlan.steps.map((s) => ({
      position: s.position,
      kind: s.kind,
      description: s.description,
      reason: s.reason,
    })),
    approvalId: approval.id,
    adjusted: plan.adjusted,
  };
}

const DOCUMENT_KINDS = new Set([
  "AADHAAR",
  "BANK_PASSBOOK",
  "BANK_STATEMENT",
  "LAND_RECORD",
  "INCOME_CERTIFICATE",
  "AGE_PROOF",
  "DISABILITY_CERTIFICATE",
  "DEATH_CERTIFICATE",
  "RATION_CARD",
  "CASTE_CERTIFICATE",
  "RESIDENCE_PROOF",
  "JOB_CARD",
  "PHOTOGRAPH",
  "OTHER",
]);

function isDocumentKind(value: string): boolean {
  return DOCUMENT_KINDS.has(value);
}

// ---------------------------------------------------------------------------
// Approval gate 2
// ---------------------------------------------------------------------------

export async function decideActionApproval(input: {
  citizenId: string;
  approvalId: string;
  decision: "APPROVED" | "REJECTED";
  note?: string;
  clock: Clock;
}): Promise<{ actionPlanId: string; decision: string }> {
  const approval = await prisma.approval.findFirstOrThrow({
    where: {
      id: input.approvalId,
      kind: "CORRECTIVE_ACTION",
      actionPlan: { gap: { entitlement: { citizenId: input.citizenId } } },
    },
    include: { actionPlan: { include: { gap: true } } },
  });

  if (!approval.actionPlan) {
    throw new ApiError("NOT_FOUND", "That approval has no action plan attached.");
  }
  if (approval.decision !== "PENDING") {
    throw new ApiError(
      "CONFLICT",
      `This approval was already ${approval.decision.toLowerCase()}.`,
    );
  }

  const actor: Actor = { kind: "citizen", citizenId: input.citizenId };
  const plan = approval.actionPlan;
  const now = input.clock.now();

  await prisma.approval.update({
    where: { id: approval.id },
    data: {
      decision: input.decision,
      decidedBy: `citizen:${input.citizenId}`,
      decidedAt: now,
      note: input.note,
    },
  });

  await prisma.actionPlan.update({
    where: { id: plan.id },
    data: { status: input.decision === "APPROVED" ? "APPROVED" : "REJECTED" },
  });

  if (input.decision === "REJECTED") {
    // Back to planning, not abandoned: the citizen declining one approach
    // does not mean the benefit gap has gone away.
    await transitionEntitlement(prisma, {
      entitlementId: plan.gap.entitlementId,
      citizenId: input.citizenId,
      to: "ACTION_PLANNED",
      actor,
      reason: input.note
        ? `The citizen declined this action: ${input.note}`
        : "The citizen declined this corrective action.",
      evidenceRef: approval.id,
    });
  } else {
    await recordAudit(prisma, {
      citizenId: input.citizenId,
      actor,
      entity: "Approval",
      entityId: approval.id,
      toState: "APPROVED",
      reason: "The citizen approved this corrective action.",
      evidenceRef: plan.id,
    });
  }

  return { actionPlanId: plan.id, decision: input.decision };
}

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

export interface ExecutionOutcome {
  actionPlanId: string;
  executed: Array<{
    position: number;
    kind: ActionKind;
    status: ExecutionStatus;
    reference?: string;
    message: string;
  }>;
  allSucceeded: boolean;
}

/**
 * Execute an approved action plan.
 *
 * Refuses without an APPROVED approval - approval gate 2, enforced in code.
 * Each step gets its own ActionExecution row with an idempotency key derived
 * from the plan and position, so a retried execution cannot file a second
 * grievance or submit a correction twice.
 *
 * Note what this function does NOT do: conclude anything about whether the
 * benefit is fixed. Execution leads only to re-verification.
 */
export async function executeActionPlan(input: {
  citizenId: string;
  actionPlanId: string;
  clock: Clock;
  actor?: Actor;
}): Promise<ExecutionOutcome> {
  const actor: Actor = input.actor ?? { kind: "agent", name: "action" };
  const now = input.clock.now();

  const plan = await prisma.actionPlan.findFirstOrThrow({
    where: {
      id: input.actionPlanId,
      gap: { entitlement: { citizenId: input.citizenId } },
    },
    include: {
      steps: { orderBy: { position: "asc" } },
      approvals: true,
      executions: true,
      gap: {
        include: {
          entitlement: { include: { scheme: true, application: true } },
        },
      },
    },
  });

  const approved = plan.approvals.find(
    (a) => a.kind === "CORRECTIVE_ACTION" && a.decision === "APPROVED",
  );

  if (!approved) {
    throw new ApiError(
      "UNPROCESSABLE",
      "This action plan has not been approved by the citizen, so it cannot be executed.",
    );
  }

  const entitlement = plan.gap.entitlement;
  const applicationRef = entitlement.application?.govApplicationRef ?? null;

  const citizen = await prisma.citizen.findUniqueOrThrow({
    where: { id: input.citizenId },
    select: { aadhaarLast4: true },
  });
  const aadhaarLast4 = citizen.aadhaarLast4 ?? "0000";

  await prisma.actionPlan.update({
    where: { id: plan.id },
    data: { status: "EXECUTING" },
  });

  const executed: ExecutionOutcome["executed"] = [];

  for (const step of plan.steps) {
    const idempotencyKey = `act:${plan.id}:${step.position}`;

    // Already run: report the stored outcome rather than running it again.
    const existing = plan.executions.find(
      (e) => e.idempotencyKey === idempotencyKey,
    );
    if (existing && existing.status === "SUCCEEDED") {
      executed.push({
        position: step.position,
        kind: step.kind,
        status: existing.status,
        message: "Already completed; not run again.",
      });
      continue;
    }

    const execution = await prisma.actionExecution.upsert({
      where: { idempotencyKey },
      create: {
        planId: plan.id,
        stepId: step.id,
        idempotencyKey,
        status: "IN_PROGRESS",
        adapter: "pending",
        request: asJson({ kind: step.kind, channel: step.channel }),
        startedAt: now,
      },
      update: { status: "IN_PROGRESS", startedAt: now },
    });

    const result = await runStep({
      kind: step.kind,
      schemeCode: entitlement.scheme.code,
      schemeName: entitlement.scheme.name,
      applicationRef,
      aadhaarLast4,
      idempotencyKey,
      informationRequired: step.informationRequired,
      documentsRequired: step.documentsRequired.map(String),
      gapKind: plan.gap.kind,
      planSummary: plan.summary,
      clock: input.clock,
    });

    await prisma.actionExecution.update({
      where: { id: execution.id },
      data: {
        status: result.status,
        adapter: result.adapter,
        response: asJson(result.response),
        error: result.status === "SUCCEEDED" ? null : result.message,
        finishedAt: now,
      },
    });

    executed.push({
      position: step.position,
      kind: step.kind,
      status: result.status,
      reference: result.reference,
      message: result.message,
    });
  }

  const allSucceeded = executed.every((e) => e.status === "SUCCEEDED");

  await prisma.actionPlan.update({
    where: { id: plan.id },
    data: { status: allSucceeded ? "EXECUTED" : "FAILED" },
  });

  await transitionEntitlement(prisma, {
    entitlementId: entitlement.id,
    citizenId: input.citizenId,
    to: "ACTION_EXECUTED",
    actor,
    reason: allSucceeded
      ? `Executed ${executed.length} corrective step(s). The outcome is not yet verified.`
      : `Corrective action partially failed: ${executed.find((e) => e.status !== "SUCCEEDED")?.message ?? "unknown error"}.`,
    evidenceRef: plan.id,
  });

  log.info("recovery.executed", {
    actionPlanId: plan.id,
    steps: executed.length,
    allSucceeded,
  });

  return { actionPlanId: plan.id, executed, allSucceeded };
}

interface StepResult {
  status: ExecutionStatus;
  adapter: string;
  message: string;
  reference?: string;
  response: unknown;
}

/** Dispatch one step to the adapter that can carry it out. */
async function runStep(input: {
  kind: ActionKind;
  schemeCode: string;
  schemeName: string;
  applicationRef: string | null;
  aadhaarLast4: string;
  idempotencyKey: string;
  informationRequired: string[];
  documentsRequired: string[];
  gapKind: string;
  planSummary: string;
  clock: Clock;
}): Promise<StepResult> {
  const gateway = govGateway();
  const grievances = grievanceProvider();

  switch (input.kind) {
    case "CORRECT_INFORMATION": {
      if (!input.applicationRef) {
        return {
          status: "NEEDS_HUMAN_REVIEW",
          adapter: "govGateway",
          message:
            "There is no government application reference to correct, so this needs human review.",
          response: null,
        };
      }
      const result = await gateway.correctInformation({
        schemeCode: input.schemeCode,
        aadhaarLast4: input.aadhaarLast4,
        applicationRef: input.applicationRef,
        idempotencyKey: input.idempotencyKey,
        corrections: Object.fromEntries(
          input.informationRequired.map((field) => [field, "corrected"]),
        ),
        reason: input.planSummary,
      });
      return result.ok
        ? {
            status: "SUCCEEDED",
            adapter: "govGateway",
            message: result.note,
            reference: result.reference,
            response: result,
          }
        : {
            status: result.reason === "PORTAL_UNAVAILABLE" ? "RETRY_REQUIRED" : "FAILED",
            adapter: "govGateway",
            message: result.message,
            response: result,
          };
    }

    case "REQUEST_DOCUMENT":
      // Requesting a document from the citizen is not an external action: it
      // is a prompt in the app. Marked as needing the citizen, not failed.
      return {
        status: "NEEDS_HUMAN_REVIEW",
        adapter: "citizen",
        message: `Waiting for the citizen to supply: ${input.documentsRequired.join(", ") || "a document"}.`,
        response: { awaiting: input.documentsRequired },
      };

    case "RESUBMIT":
    case "REAPPLY":
    case "RETRY_OPERATION": {
      if (!input.applicationRef) {
        return {
          status: "NEEDS_HUMAN_REVIEW",
          adapter: "govGateway",
          message: "No application reference to act on.",
          response: null,
        };
      }
      const status = await gateway.getApplicationStatus(input.applicationRef);
      return {
        status: status ? "SUCCEEDED" : "FAILED",
        adapter: "govGateway",
        message: status
          ? `Re-checked the application at the ${gateway.isMock ? "simulated " : ""}portal; current status is ${status.status}.`
          : "The application could not be found at the portal.",
        reference: input.applicationRef,
        response: status,
      };
    }

    case "SUBMIT_GRIEVANCE": {
      const result = await grievances.file({
        schemeCode: input.schemeCode,
        applicationRef: input.applicationRef,
        aadhaarLast4: input.aadhaarLast4,
        idempotencyKey: input.idempotencyKey,
        subject: `${input.gapKind} for ${input.schemeName}`,
        detail: input.planSummary,
        clock: input.clock,
      });
      return result.ok
        ? {
            status: "SUCCEEDED",
            adapter: "grievance",
            message: result.acknowledgement,
            reference: result.ticket,
            response: result,
          }
        : {
            status: result.reason === "CHANNEL_UNAVAILABLE" ? "RETRY_REQUIRED" : "FAILED",
            adapter: "grievance",
            message: result.message,
            response: result,
          };
    }

    case "ESCALATE_GRIEVANCE": {
      const result = await grievances.escalate({
        schemeCode: input.schemeCode,
        applicationRef: input.applicationRef,
        aadhaarLast4: input.aadhaarLast4,
        idempotencyKey: input.idempotencyKey,
        subject: `Escalation: ${input.gapKind} for ${input.schemeName}`,
        detail: input.planSummary,
        previousTicket: "tier-1",
        clock: input.clock,
      });
      return result.ok
        ? {
            status: "SUCCEEDED",
            adapter: "grievance",
            message: result.acknowledgement,
            reference: result.ticket,
            response: result,
          }
        : {
            status: "FAILED",
            adapter: "grievance",
            message: result.message,
            response: result,
          };
    }

    case "REQUEST_ASSISTED_VERIFICATION":
      return {
        status: "SUCCEEDED",
        adapter: "notification",
        message:
          "An assisted verification request has been raised for a Common Service Centre operator. (Simulated.)",
        response: { channel: "CSC" },
      };

    case "REQUEST_CLARIFICATION":
      return {
        status: "NEEDS_HUMAN_REVIEW",
        adapter: "caseworker",
        message: "Referred to a caseworker for clarification.",
        response: null,
      };

    case "WAIT_AND_MONITOR":
      return {
        status: "SUCCEEDED",
        adapter: "monitoring",
        message:
          "No action is appropriate yet; this benefit stays under monitoring.",
        response: null,
      };
  }
}

// ---------------------------------------------------------------------------
// Re-verification
// ---------------------------------------------------------------------------

export interface ReverifyResult {
  resolved: boolean;
  entitlementId: string;
  decision: string;
  /** Amount recovered, when the gap closed. */
  recoveredAmount: Paise;
  summary: string;
  /** Set when unresolved, naming what happens next. */
  nextStep?: string;
}

/**
 * Did the action actually work?
 *
 * Re-audits from the government's record rather than trusting that a
 * successful execution means a resolved benefit. An action can complete
 * perfectly and change nothing - a grievance acknowledged and ignored is the
 * commonest case - and the loop has to be able to say so and try again.
 */
export async function reverifyBenefit(input: {
  citizenId: string;
  entitlementId: string;
  clock: Clock;
  actor?: Actor;
}): Promise<ReverifyResult> {
  const actor: Actor = input.actor ?? { kind: "agent", name: "reverification" };

  const before = await prisma.benefitLedger.findUnique({
    where: { entitlementId: input.entitlementId },
    select: { gapAmountPaise: true, receivedAmountPaise: true },
  });
  const gapBefore = before ? paise(before.gapAmountPaise) : ZERO;

  await transitionEntitlement(prisma, {
    entitlementId: input.entitlementId,
    citizenId: input.citizenId,
    to: "REVERIFYING",
    actor,
    reason: "Re-checking whether the corrective action resolved the gap.",
  });

  // The actual check: run the audit again against live government data.
  // `manageLifecycle: false` because this function owns the state from here -
  // the audit's job is to establish the facts, and the decision between
  // RECOVERED and RE_AUDIT_REQUIRED is made below.
  const audit = await auditBenefit({
    citizenId: input.citizenId,
    entitlementId: input.entitlementId,
    clock: input.clock,
    actor,
    manageLifecycle: false,
  });

  const after = await prisma.benefitLedger.findUnique({
    where: { entitlementId: input.entitlementId },
    select: { gapAmountPaise: true, receivedAmountPaise: true },
  });
  const gapAfter = after ? paise(after.gapAmountPaise) : ZERO;

  const resolved = audit.decision === "HEALTHY" || gapAfter < gapBefore;
  const recoveredAmount = gapBefore > gapAfter ? paise(gapBefore - gapAfter) : ZERO;

  if (resolved) {
    await prisma.benefitGap.updateMany({
      where: { entitlementId: input.entitlementId, resolvedAt: null },
      data: { resolvedAt: input.clock.now() },
    });

    await prisma.benefitLedger.update({
      where: { entitlementId: input.entitlementId },
      data: {
        recoveredAmountPaise: { increment: recoveredAmount },
        recoveryStatus: "RESOLVED",
        lastVerifiedAt: input.clock.now(),
      },
    });

    await transitionEntitlement(prisma, {
      entitlementId: input.entitlementId,
      citizenId: input.citizenId,
      to: "RECOVERED",
      actor,
      reason:
        recoveredAmount > ZERO
          ? `Benefit recovered. ${audit.summary}`
          : `The gap is resolved. ${audit.summary}`,
      evidenceRef: audit.auditId,
    });

    log.info("recovery.resolved", {
      entitlementId: input.entitlementId,
      recoveredAmount: recoveredAmount.toString(),
    });

    return {
      resolved: true,
      entitlementId: input.entitlementId,
      decision: audit.decision,
      recoveredAmount,
      summary: audit.summary,
    };
  }

  // Not resolved. Back to diagnosis - this edge is the loop.
  await prisma.benefitLedger.updateMany({
    where: { entitlementId: input.entitlementId },
    data: { recoveryStatus: "UNRESOLVED" },
  });

  await transitionEntitlement(prisma, {
    entitlementId: input.entitlementId,
    citizenId: input.citizenId,
    to: "RE_AUDIT_REQUIRED",
    actor,
    reason: `The corrective action did not resolve the gap. ${audit.summary}`,
    evidenceRef: audit.auditId,
  });

  log.info("recovery.unresolved", {
    entitlementId: input.entitlementId,
    decision: audit.decision,
  });

  return {
    resolved: false,
    entitlementId: input.entitlementId,
    decision: audit.decision,
    recoveredAmount: ZERO,
    summary: audit.summary,
    nextStep:
      "The gap will be diagnosed again, taking into account that this action did not work.",
  };
}
