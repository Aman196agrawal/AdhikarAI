/**
 * The application workflow and approval gate 1.
 *
 * Answers "how do we obtain this benefit?" - distinct from the Action Agent,
 * which answers "how do we fix or recover it?". Keeping them separate matters:
 * obtaining and repairing have different inputs, different failure modes and
 * different approval contexts, and merging them produces an agent that does
 * neither well.
 *
 * The approval gate is enforced HERE, in code, not merely by the state
 * machine. `submitApplication` refuses to call the gateway unless an APPROVED
 * Approval row exists for that application. The state machine lacking an edge
 * from APPLICATION_DRAFT to SUBMITTED is a second, independent guard; neither
 * alone would be enough, because a bug that set the state directly would
 * otherwise bypass consent for a consequential external action.
 *
 * Identity numbers are deliberately NOT prefilled from the profile. The
 * profile agent never extracts an Aadhaar or account number, so those fields
 * are reported as required and supplied by the citizen at the approval screen.
 * That is the correct flow: the person submitting a government claim should
 * type and see their own identifiers.
 */

import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/http";
import { log } from "@/lib/log";
import { govGateway } from "@/lib/adapters/mockGovGateway";
import { systemClock, type Clock } from "@/lib/clock";
import { loadProfile } from "./profile";
import { recordAudit, transitionEntitlement, type Actor } from "./transitions";
import { requireScheme } from "@/lib/registry";
import type { FormFieldSpec } from "@/lib/registry/types";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { DocumentKind } from "@/lib/generated/prisma/enums";

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

export interface PreparedField {
  key: string;
  label: string;
  labelHi?: string;
  type: FormFieldSpec["type"];
  required: boolean;
  value: unknown;
  source: "PREFILLED_FROM_PROFILE" | "CITIZEN_EDITED" | "SCHEME_DEFAULT";
  valid: boolean;
  validationError?: string;
  options?: string[];
  validation?: string;
}

export interface PreparedApplication {
  applicationId: string;
  entitlementId: string;
  schemeCode: string;
  schemeName: string;
  fields: PreparedField[];
  /** Required fields with no value yet. The citizen must supply these. */
  missingFields: string[];
  /** Required document kinds not yet attached. */
  missingDocuments: DocumentKind[];
  /** Exclusions the citizen must affirm before submission. */
  declarations: Array<{ code: string; text: string; sourceUrl: string }>;
  readyForApproval: boolean;
}

/**
 * Deterministic idempotency key.
 *
 * Derived from the entitlement rather than randomly generated, so a retried
 * preparation reuses the same key and a network retry cannot lodge a second
 * claim for the same benefit.
 */
function idempotencyKeyFor(entitlementId: string): string {
  return `apply:${entitlementId}`;
}

function validateField(spec: FormFieldSpec, value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return spec.required ? "This is required." : null;
  }

  if (spec.type === "number" && typeof value !== "number") {
    return "Must be a number.";
  }
  if (spec.type === "boolean" && typeof value !== "boolean") {
    return "Must be yes or no.";
  }
  if (spec.type === "select" && spec.options && typeof value === "string") {
    if (!spec.options.includes(value)) {
      return `Must be one of: ${spec.options.join(", ")}.`;
    }
  }
  if (spec.key === "aadhaarNumber" && typeof value === "string") {
    if (!/^\d{12}$/.test(value.replace(/\s/g, ""))) return "Must be 12 digits.";
  }
  if (spec.key === "ifscCode" && typeof value === "string") {
    if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(value.trim())) {
      return "Not a valid IFSC code.";
    }
  }
  return null;
}

/**
 * Build or refresh a draft application for an entitlement.
 *
 * Idempotent: calling it again updates the existing draft rather than creating
 * a second one.
 */
export async function prepareApplication(input: {
  citizenId: string;
  entitlementId: string;
  /** Values the citizen supplied, which override prefilled ones. */
  providedFields?: Record<string, unknown>;
  actor?: Actor;
}): Promise<PreparedApplication> {
  const actor: Actor = input.actor ?? { kind: "agent", name: "application" };

  const entitlement = await prisma.entitlement.findFirstOrThrow({
    where: { id: input.entitlementId, citizenId: input.citizenId },
    include: { scheme: true, application: { include: { fields: true } } },
  });

  if (entitlement.verdict === "RED") {
    throw new ApiError(
      "UNPROCESSABLE",
      "This scheme does not apply to this citizen, so an application cannot be prepared.",
    );
  }

  const spec = requireScheme(entitlement.scheme.code);
  const profile = await loadProfile(input.citizenId);

  // Prefill from the profile where a form field maps to a profile attribute.
  const prepared: PreparedField[] = spec.formSchema.map((field) => {
    // Values the citizen typed earlier survive a re-preparation. Previously
    // calling this again without `providedFields` (the profile changed, or the
    // page was refreshed) rebuilt the form from the profile alone and silently
    // discarded the Aadhaar and account numbers they had entered.
    const previouslyEntered = entitlement.application?.fields.find(
      (f) => f.key === field.key && f.source === "CITIZEN_EDITED",
    )?.value;
    const provided =
      input.providedFields?.[field.key] ??
      (previouslyEntered !== undefined && previouslyEntered !== null
        ? previouslyEntered
        : undefined);
    const fromProfile =
      field.fromProfileField !== undefined
        ? profile[field.fromProfileField]?.value
        : undefined;

    const value =
      provided !== undefined
        ? provided
        : fromProfile !== undefined && fromProfile !== null
          ? fromProfile
          : null;

    const source: PreparedField["source"] =
      provided !== undefined
        ? "CITIZEN_EDITED"
        : fromProfile !== undefined && fromProfile !== null
          ? "PREFILLED_FROM_PROFILE"
          : "SCHEME_DEFAULT";

    const validationError = validateField(field, value);

    return {
      key: field.key,
      label: field.label,
      labelHi: field.labelHi,
      type: field.type,
      required: field.required,
      value,
      source,
      valid: validationError === null,
      validationError: validationError ?? undefined,
      options: field.options,
      validation: field.validation,
    };
  });

  const missingFields = prepared
    .filter((f) => f.required && (f.value === null || f.value === ""))
    .map((f) => f.key);

  // Which required documents the citizen has on file already.
  const heldDocuments = await prisma.document.findMany({
    where: { citizenId: input.citizenId },
    select: { id: true, kind: true },
  });
  const heldKinds = new Set(heldDocuments.map((d) => d.kind));
  const missingDocuments = spec.requiredDocuments.filter(
    (kind) => !heldKinds.has(kind),
  );

  const declarations = entitlement.pendingDeclarations.map((code) => {
    const clause = spec.clauses.find((c) => c.code === code);
    return {
      code,
      text: clause?.text ?? code,
      sourceUrl: clause?.sourceUrl ?? spec.sourceUrl,
    };
  });

  const application = await prisma.application.upsert({
    where: { entitlementId: entitlement.id },
    create: {
      entitlementId: entitlement.id,
      status: "DRAFT",
      idempotencyKey: idempotencyKeyFor(entitlement.id),
    },
    update: {},
  });

  // Replace fields wholesale so a form field removed from the registry does
  // not linger on the draft.
  await prisma.applicationField.deleteMany({
    where: { applicationId: application.id },
  });
  await prisma.applicationField.createMany({
    data: prepared.map((field) => ({
      applicationId: application.id,
      key: field.key,
      value: asJson(field.value),
      source: field.source,
      valid: field.valid,
      validationError: field.validationError,
    })),
  });

  for (const kind of spec.requiredDocuments) {
    const held = heldDocuments.find((d) => d.kind === kind);
    await prisma.applicationDocument.upsert({
      where: { applicationId_kind: { applicationId: application.id, kind } },
      create: {
        applicationId: application.id,
        kind,
        provided: held !== undefined,
        documentId: held?.id,
      },
      update: { provided: held !== undefined, documentId: held?.id },
    });
  }

  if (entitlement.lifecycleState !== "APPLICATION_DRAFT") {
    await transitionEntitlement(prisma, {
      entitlementId: entitlement.id,
      citizenId: input.citizenId,
      to: "APPLICATION_DRAFT",
      actor,
      reason: `Prepared a draft application for ${entitlement.scheme.code}.`,
      evidenceRef: application.id,
      from: entitlement.lifecycleState,
    });
  }

  return {
    applicationId: application.id,
    entitlementId: entitlement.id,
    schemeCode: entitlement.scheme.code,
    schemeName: entitlement.scheme.name,
    fields: prepared,
    missingFields,
    missingDocuments,
    declarations,
    readyForApproval:
      missingFields.length === 0 && prepared.every((f) => f.valid),
  };
}

// ---------------------------------------------------------------------------
// Approval gate 1
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  approvalId: string
  /** Exactly what the citizen is being asked to approve. */
  shownEvidence: Record<string, unknown>;
}

/**
 * Open approval gate 1.
 *
 * `shownEvidence` is a snapshot of precisely what the citizen saw at the
 * moment of approval - the scheme, the benefit, the filled fields, the
 * documents and the declarations. Storing it means consent can later be
 * reconstructed rather than inferred from whatever the form happens to look
 * like today.
 */
export async function requestApplicationApproval(input: {
  citizenId: string;
  applicationId: string;
  actor?: Actor;
}): Promise<ApprovalRequest> {
  const actor: Actor = input.actor ?? { kind: "agent", name: "application" };

  const application = await prisma.application.findFirstOrThrow({
    where: {
      id: input.applicationId,
      entitlement: { citizenId: input.citizenId },
    },
    include: {
      fields: true,
      documents: true,
      entitlement: { include: { scheme: true } },
    },
  });

  const invalid = application.fields.filter((f) => !f.valid);
  if (invalid.length > 0) {
    throw new ApiError(
      "UNPROCESSABLE",
      "The application still has fields that need correcting.",
      invalid.map((f) => ({ field: f.key, message: f.validationError })),
    );
  }

  const shownEvidence: Record<string, unknown> = {
    schemeCode: application.entitlement.scheme.code,
    schemeName: application.entitlement.scheme.name,
    benefitNote: application.entitlement.scheme.benefitNote,
    expectedAmountPaise:
      application.entitlement.expectedAmountPaise?.toString() ?? null,
    frequency: application.entitlement.frequency,
    applicationMethod: application.entitlement.scheme.applicationMethod,
    // Field VALUES are deliberately not snapshotted here: the snapshot is an
    // audit record, and copying an Aadhaar or account number into it would
    // duplicate sensitive data into a table that outlives the application.
    // The field keys and their provenance are enough to reconstruct consent.
    fields: application.fields.map((f) => ({ key: f.key, source: f.source })),
    documents: application.documents.map((d) => ({
      kind: d.kind,
      provided: d.provided,
    })),
    declarations: application.entitlement.pendingDeclarations,
    governmentTarget: govGateway().isMock
      ? "SIMULATED government portal (demo)"
      : govGateway().name,
    isMockSubmission: govGateway().isMock,
  };

  // Reuse an approval that is still waiting. Opening a new one on every call
  // left a trail of duplicate PENDING approvals from a double tap or a
  // refreshed page, each a separate thing the citizen appeared to be asked.
  const pendingAlready = await prisma.approval.findFirst({
    where: {
      kind: "APPLICATION_SUBMISSION",
      applicationId: application.id,
      decision: "PENDING",
    },
  });
  if (pendingAlready) {
    return {
      approvalId: pendingAlready.id,
      shownEvidence: pendingAlready.shownEvidence as Record<string, unknown>,
    };
  }

  const approval = await prisma.approval.create({
    data: {
      kind: "APPLICATION_SUBMISSION",
      applicationId: application.id,
      decision: "PENDING",
      shownEvidence: asJson(shownEvidence),
    },
  });

  await prisma.application.update({
    where: { id: application.id },
    data: { status: "AWAITING_APPROVAL" },
  });

  await transitionEntitlement(prisma, {
    entitlementId: application.entitlementId,
    citizenId: input.citizenId,
    to: "AWAITING_APPLICATION_APPROVAL",
    actor,
    reason: "Application prepared and awaiting the citizen's approval.",
    evidenceRef: approval.id,
  });

  return { approvalId: approval.id, shownEvidence };
}

/** Record the citizen's decision at approval gate 1. */
export async function decideApplicationApproval(input: {
  citizenId: string;
  approvalId: string;
  decision: "APPROVED" | "REJECTED";
  /** Fields the citizen corrected before approving. */
  edits?: Record<string, unknown>;
  note?: string;
  /** When the decision is made. Previously the application's updatedAt was
   *  recorded instead, which is when it was last edited, not when consent
   *  was given - wrong in exactly the record that proves consent. */
  clock?: Clock;
}): Promise<{ applicationId: string; decision: string }> {
  const approval = await prisma.approval.findFirstOrThrow({
    where: {
      id: input.approvalId,
      kind: "APPLICATION_SUBMISSION",
      application: { entitlement: { citizenId: input.citizenId } },
    },
    include: { application: { include: { entitlement: true } } },
  });

  if (!approval.application) {
    throw new ApiError("NOT_FOUND", "That approval has no application attached.");
  }
  if (approval.decision !== "PENDING") {
    throw new ApiError(
      "CONFLICT",
      `This approval was already ${approval.decision.toLowerCase()}.`,
    );
  }

  const actor: Actor = { kind: "citizen", citizenId: input.citizenId };
  const application = approval.application;

  if (input.edits && Object.keys(input.edits).length > 0) {
    for (const [key, value] of Object.entries(input.edits)) {
      await prisma.applicationField.updateMany({
        where: { applicationId: application.id, key },
        data: { value: asJson(value), source: "CITIZEN_EDITED" },
      });
    }
  }

  await prisma.approval.update({
    where: { id: approval.id },
    data: {
      decision: input.decision,
      decidedBy: `citizen:${input.citizenId}`,
      decidedAt: (input.clock ?? systemClock()).now(),
      edits: input.edits ? asJson(input.edits) : undefined,
      note: input.note,
    },
  });

  if (input.decision === "REJECTED") {
    await prisma.application.update({
      where: { id: application.id },
      data: { status: "DRAFT" },
    });
    await transitionEntitlement(prisma, {
      entitlementId: application.entitlementId,
      citizenId: input.citizenId,
      to: "APPLICATION_DRAFT",
      actor,
      reason: input.note
        ? `The citizen declined to submit: ${input.note}`
        : "The citizen declined to submit this application.",
      evidenceRef: approval.id,
    });
  } else {
    await recordAudit(prisma, {
      citizenId: input.citizenId,
      actor,
      entity: "Approval",
      entityId: approval.id,
      toState: "APPROVED",
      reason: "The citizen approved submission of this application.",
      evidenceRef: application.id,
    });
  }

  return { applicationId: application.id, decision: input.decision };
}

// ---------------------------------------------------------------------------
// Submission
// ---------------------------------------------------------------------------

export type SubmitOutcome =
  | { ok: true; applicationRef: string; status: string; isMock: boolean }
  | {
      ok: false;
      reason: string;
      message: string;
      fieldErrors?: Array<{ field: string; message: string }>;
      retryable: boolean;
    };

/**
 * Submit an approved application to the government gateway.
 *
 * Refuses outright without an APPROVED approval. This is the hard gate: no
 * consequential external action happens on a citizen's behalf without their
 * recorded consent, and that is checked here rather than trusted to the
 * caller or to the state machine alone.
 */
export async function submitApplication(input: {
  citizenId: string;
  applicationId: string;
  clock: Clock;
  actor?: Actor;
}): Promise<SubmitOutcome> {
  const actor: Actor = input.actor ?? { kind: "agent", name: "application" };

  const application = await prisma.application.findFirstOrThrow({
    where: {
      id: input.applicationId,
      entitlement: { citizenId: input.citizenId },
    },
    include: {
      fields: true,
      documents: true,
      approvals: true,
      entitlement: { include: { scheme: true } },
    },
  });

  const approved = application.approvals.find(
    (a) => a.kind === "APPLICATION_SUBMISSION" && a.decision === "APPROVED",
  );

  if (!approved) {
    // The gate. Not a validation nicety: without it the system could lodge a
    // government claim in a citizen's name that they never agreed to.
    throw new ApiError(
      "UNPROCESSABLE",
      "This application has not been approved by the citizen, so it cannot be submitted.",
    );
  }

  if (application.status === "SUBMITTED" || application.govApplicationRef) {
    return {
      ok: true,
      applicationRef: application.govApplicationRef ?? "",
      status: application.status,
      isMock: govGateway().isMock,
    };
  }

  const citizen = await prisma.citizen.findUniqueOrThrow({
    where: { id: input.citizenId },
    select: { aadhaarLast4: true },
  });

  if (!citizen.aadhaarLast4) {
    throw new ApiError(
      "UNPROCESSABLE",
      "The citizen record has no Aadhaar reference, which the portal requires.",
    );
  }

  const fields: Record<string, unknown> = {};
  for (const field of application.fields) fields[field.key] = field.value;

  const gateway = govGateway();
  const result = await gateway.submitApplication({
    schemeCode: application.entitlement.scheme.code,
    aadhaarLast4: citizen.aadhaarLast4,
    idempotencyKey: application.idempotencyKey,
    fields,
    documents: application.documents.filter((d) => d.provided).map((d) => d.kind),
    declarations: application.entitlement.pendingDeclarations,
    submittedAt: input.clock.now(),
  });

  if (!result.ok) {
    // A failure is recorded as a failure. It is never allowed to look like a
    // submission that went through.
    await prisma.application.update({
      where: { id: application.id },
      data: {
        status: "SUBMISSION_FAILED",
        submissionError: `${result.reason}: ${result.message}`,
        ...(result.applicationRef
          ? { govApplicationRef: result.applicationRef }
          : {}),
      },
    });

    await recordAudit(prisma, {
      citizenId: input.citizenId,
      actor,
      entity: "Application",
      entityId: application.id,
      toState: "SUBMISSION_FAILED",
      reason: `Submission failed (${result.reason}): ${result.message}`,
    });

    log.warn("application.submission_failed", {
      applicationId: application.id,
      reason: result.reason,
      isMock: gateway.isMock,
    });

    return {
      ok: false,
      reason: result.reason,
      message: result.message,
      fieldErrors: result.fieldErrors,
      // Only an outage is worth retrying unchanged; the others need the form
      // corrected or the existing application looked at.
      retryable: result.reason === "PORTAL_UNAVAILABLE",
    };
  }

  await prisma.application.update({
    where: { id: application.id },
    data: {
      status: "SUBMITTED",
      govApplicationRef: result.applicationRef,
      submittedAt: result.receivedOn,
      submissionError: null,
    },
  });

  await transitionEntitlement(prisma, {
    entitlementId: application.entitlementId,
    citizenId: input.citizenId,
    to: "SUBMITTED",
    actor,
    reason: `Application submitted to the ${gateway.isMock ? "simulated " : ""}government portal as ${result.applicationRef}.`,
    evidenceRef: application.id,
  });

  log.info("application.submitted", {
    applicationId: application.id,
    applicationRef: result.applicationRef,
    isMock: gateway.isMock,
  });

  return {
    ok: true,
    applicationRef: result.applicationRef,
    status: "SUBMITTED",
    isMock: gateway.isMock,
  };
}
