-- CreateEnum
CREATE TYPE "ProvenanceLevel" AS ENUM ('DOCUMENT_VERIFIED', 'SELF_DECLARED', 'INFERRED', 'MISSING');

-- CreateEnum
CREATE TYPE "EligibilityVerdict" AS ENUM ('GREEN', 'YELLOW', 'RED');

-- CreateEnum
CREATE TYPE "ClauseKind" AS ENUM ('ELIGIBILITY', 'EXCLUSION', 'DEPENDENCY');

-- CreateEnum
CREATE TYPE "ClauseResult" AS ENUM ('SATISFIED', 'VIOLATED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "BenefitFrequency" AS ENUM ('MONTHLY', 'QUARTERLY', 'TRIANNUAL', 'ANNUAL', 'ONE_TIME', 'AS_NEEDED');

-- CreateEnum
CREATE TYPE "BenefitType" AS ENUM ('CASH', 'IN_KIND', 'INSURANCE', 'LOAN', 'SERVICE');

-- CreateEnum
CREATE TYPE "GovernmentLevel" AS ENUM ('CENTRAL', 'STATE');

-- CreateEnum
CREATE TYPE "DocumentKind" AS ENUM ('AADHAAR', 'BANK_PASSBOOK', 'BANK_STATEMENT', 'LAND_RECORD', 'INCOME_CERTIFICATE', 'AGE_PROOF', 'DISABILITY_CERTIFICATE', 'DEATH_CERTIFICATE', 'RATION_CARD', 'CASTE_CERTIFICATE', 'RESIDENCE_PROOF', 'JOB_CARD', 'PHOTOGRAPH', 'OTHER');

-- CreateEnum
CREATE TYPE "LifecycleState" AS ENUM ('DISCOVERED', 'POTENTIAL_ENTITLEMENT', 'ELIGIBLE', 'APPLICATION_DRAFT', 'AWAITING_APPLICATION_APPROVAL', 'SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'DISBURSED', 'RECEIPT_UNVERIFIED', 'CITIZEN_CONFIRMED', 'VERIFIED_RECEIVED', 'PAYMENT_DISCREPANCY', 'GAP_DETECTED', 'ROOT_CAUSE_IDENTIFIED', 'ACTION_PLANNED', 'AWAITING_ACTION_APPROVAL', 'ACTION_EXECUTED', 'REVERIFYING', 'RECOVERED', 'MONITORING', 'RE_AUDIT_REQUIRED');

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'SUBMITTED', 'PENDING', 'APPROVED', 'REJECTED', 'RETURNED', 'SUBMISSION_FAILED');

-- CreateEnum
CREATE TYPE "ApplicationFieldSource" AS ENUM ('PREFILLED_FROM_PROFILE', 'CITIZEN_EDITED', 'SCHEME_DEFAULT');

-- CreateEnum
CREATE TYPE "ReceiptState" AS ENUM ('NOT_DISBURSED', 'DISBURSED_RECEIPT_UNVERIFIED', 'CITIZEN_CONFIRMED', 'VERIFIED_RECEIVED', 'PAYMENT_DISCREPANCY');

-- CreateEnum
CREATE TYPE "CitizenReport" AS ENUM ('YES', 'NO', 'NOT_SURE');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('CITIZEN_CONFIRMATION', 'BANK_EVIDENCE', 'GOVERNMENT_RECORD', 'ASSISTED_VERIFICATION');

-- CreateEnum
CREATE TYPE "EvidenceResult" AS ENUM ('MATCHED', 'PARTIAL_MATCH', 'NO_MATCH', 'NOT_PROVIDED');

-- CreateEnum
CREATE TYPE "AuditArea" AS ENUM ('APPLICATION_STATUS', 'APPROVAL_STATUS', 'PAYMENT', 'RECEIPT', 'CONTINUITY');

-- CreateEnum
CREATE TYPE "AuditDecision" AS ENUM ('HEALTHY', 'NEEDS_VERIFICATION', 'ACTION_REQUIRED');

-- CreateEnum
CREATE TYPE "GapKind" AS ENUM ('NEVER_APPLIED', 'APPLICATION_PENDING_TOO_LONG', 'REJECTED', 'BLOCKED', 'MISSING_DOCUMENT', 'PAYMENT_MISSED', 'PAYMENT_DELAYED', 'PAYMENT_INTERRUPTED', 'UNCLAIMED', 'RECEIPT_UNVERIFIED', 'RENEWAL_MISSED', 'STATUS_UNKNOWN');

-- CreateEnum
CREATE TYPE "RootCauseKind" AS ENUM ('MISSING_DOCUMENT', 'DATA_MISMATCH', 'BANK_ISSUE', 'AADHAAR_ISSUE', 'ELIGIBILITY_ISSUE', 'VERIFICATION_ISSUE', 'TECHNICAL_FAILURE', 'APPLICATION_ERROR', 'REJECTION', 'DELAYED_PROCESSING', 'RENEWAL_ISSUE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ActionKind" AS ENUM ('REQUEST_DOCUMENT', 'CORRECT_INFORMATION', 'REQUEST_CLARIFICATION', 'RESUBMIT', 'REAPPLY', 'SUBMIT_GRIEVANCE', 'ESCALATE_GRIEVANCE', 'RETRY_OPERATION', 'REQUEST_ASSISTED_VERIFICATION', 'WAIT_AND_MONITOR');

-- CreateEnum
CREATE TYPE "ActionPlanStatus" AS ENUM ('DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'EXECUTED', 'FAILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'RETRY_REQUIRED', 'NEEDS_HUMAN_REVIEW');

-- CreateEnum
CREATE TYPE "ApprovalKind" AS ENUM ('APPLICATION_SUBMISSION', 'CORRECTIVE_ACTION');

-- CreateEnum
CREATE TYPE "ApprovalDecision" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MonitoringEventKind" AS ENUM ('PAYMENT_DUE', 'PAYMENT_MISSED', 'RENEWAL_DUE', 'STATUS_CHANGED', 'NEW_DISCREPANCY', 'ELIGIBILITY_CHANGED', 'EXPECTED_BENEFIT_CHANGED', 'UNRESOLVED_AUDIT', 'ACTION_COMPLETED');

-- CreateEnum
CREATE TYPE "RecoveryStatus" AS ENUM ('NOT_APPLICABLE', 'OPEN', 'IN_PROGRESS', 'RESOLVED', 'UNRESOLVED');

-- CreateEnum
CREATE TYPE "GovApplicationStatus" AS ENUM ('RECEIVED', 'UNDER_REVIEW', 'PENDING_DOCUMENT', 'APPROVED', 'REJECTED', 'RETURNED');

-- CreateEnum
CREATE TYPE "GovDisbursementStatus" AS ENUM ('RELEASED', 'FAILED', 'RETURNED');

-- CreateTable
CREATE TABLE "Citizen" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameHi" TEXT,
    "aadhaarLast4" TEXT,
    "bankAccountLast4" TEXT,
    "phone" TEXT,
    "locale" TEXT NOT NULL DEFAULT 'en',
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Citizen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CitizenProfile" (
    "id" TEXT NOT NULL,
    "citizenId" TEXT NOT NULL,
    "rawIntake" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CitizenProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileField" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "provenance" "ProvenanceLevel" NOT NULL,
    "sourceDocumentId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "citizenId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "sha256" TEXT NOT NULL,
    "sizeBytes" INTEGER,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scheme" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameHi" TEXT,
    "governmentLevel" "GovernmentLevel" NOT NULL,
    "states" TEXT[],
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "descriptionHi" TEXT,
    "benefitType" "BenefitType" NOT NULL,
    "benefitAmountPaise" BIGINT,
    "benefitNote" TEXT,
    "frequency" "BenefitFrequency" NOT NULL,
    "durationMonths" INTEGER,
    "installmentsPerYear" INTEGER,
    "applicationMethod" TEXT NOT NULL,
    "applicationUrl" TEXT,
    "formSchema" JSONB NOT NULL,
    "requiredDocuments" "DocumentKind"[],
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "lastVerified" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Scheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleClause" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "ClauseKind" NOT NULL,
    "field" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "evidenceDocs" "DocumentKind"[],
    "text" TEXT NOT NULL,
    "textHi" TEXT,
    "sourceName" TEXT NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "lastVerified" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleClause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entitlement" (
    "id" TEXT NOT NULL,
    "citizenId" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "verdict" "EligibilityVerdict" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "expectedAmountPaise" BIGINT,
    "frequency" "BenefitFrequency" NOT NULL,
    "lifecycleState" "LifecycleState" NOT NULL DEFAULT 'DISCOVERED',
    "clauseResults" JSONB NOT NULL,
    "missingEvidence" TEXT[],
    "reasoning" TEXT,
    "discoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpectedPayment" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "dueOn" TIMESTAMP(3) NOT NULL,
    "expectedAmountPaise" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpectedPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "govApplicationRef" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "decidedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "submissionError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationField" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "source" "ApplicationFieldSource" NOT NULL,
    "valid" BOOLEAN NOT NULL DEFAULT true,
    "validationError" TEXT,

    CONSTRAINT "ApplicationField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicationDocument" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" "DocumentKind" NOT NULL,
    "provided" BOOLEAN NOT NULL DEFAULT false,
    "documentId" TEXT,

    CONSTRAINT "ApplicationDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "expectedPaymentId" TEXT,
    "govDisbursementRef" TEXT,
    "periodLabel" TEXT NOT NULL,
    "reportedAmountPaise" BIGINT NOT NULL,
    "reportedOn" TIMESTAMP(3) NOT NULL,
    "receiptState" "ReceiptState" NOT NULL DEFAULT 'NOT_DISBURSED',
    "gapAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptVerification" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "citizenReport" "CitizenReport",
    "evidenceResult" "EvidenceResult" NOT NULL DEFAULT 'NOT_PROVIDED',
    "method" "VerificationMethod" NOT NULL,
    "expectedAmountPaise" BIGINT NOT NULL,
    "matchedAmountPaise" BIGINT,
    "matchedOn" TIMESTAMP(3),
    "refLast4" TEXT,
    "docSha256" TEXT,
    "resultState" "ReceiptState" NOT NULL,
    "note" TEXT,
    "verifiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitAudit" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "decision" "AuditDecision" NOT NULL,
    "summary" TEXT NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggeredByEventId" TEXT,

    CONSTRAINT "BenefitAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditFinding" (
    "id" TEXT NOT NULL,
    "auditId" TEXT NOT NULL,
    "area" "AuditArea" NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,

    CONSTRAINT "AuditFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitGap" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "auditId" TEXT,
    "kind" "GapKind" NOT NULL,
    "periodLabel" TEXT,
    "amountPaise" BIGINT,
    "evidence" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "BenefitGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RootCause" (
    "id" TEXT NOT NULL,
    "gapId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "kind" "RootCauseKind" NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "evidence" JSONB NOT NULL,
    "recommendedAction" "ActionKind" NOT NULL,
    "reasoning" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RootCause_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionPlan" (
    "id" TEXT NOT NULL,
    "gapId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" "ActionPlanStatus" NOT NULL DEFAULT 'DRAFT',
    "summary" TEXT NOT NULL,
    "expectedOutcome" TEXT NOT NULL,
    "evidenceNeeded" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ActionPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionStep" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "ActionKind" NOT NULL,
    "description" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "documentsRequired" "DocumentKind"[],
    "informationRequired" TEXT[],
    "channel" TEXT NOT NULL,

    CONSTRAINT "ActionStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActionExecution" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "stepId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "status" "ExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "adapter" TEXT NOT NULL,
    "request" JSONB NOT NULL,
    "response" JSONB,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ActionExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Approval" (
    "id" TEXT NOT NULL,
    "kind" "ApprovalKind" NOT NULL,
    "applicationId" TEXT,
    "actionPlanId" TEXT,
    "decision" "ApprovalDecision" NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "shownEvidence" JSONB NOT NULL,
    "edits" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BenefitLedger" (
    "id" TEXT NOT NULL,
    "entitlementId" TEXT NOT NULL,
    "expectedAmountPaise" BIGINT NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "approvedAmountPaise" BIGINT,
    "disbursedAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "receivedAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "unverifiedAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "gapAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "recoveredAmountPaise" BIGINT NOT NULL DEFAULT 0,
    "receiptState" "ReceiptState" NOT NULL DEFAULT 'NOT_DISBURSED',
    "recoveryStatus" "RecoveryStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
    "lastVerifiedAt" TIMESTAMP(3),
    "lastAuditAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BenefitLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringEvent" (
    "id" TEXT NOT NULL,
    "citizenId" TEXT NOT NULL,
    "entitlementId" TEXT,
    "kind" "MonitoringEventKind" NOT NULL,
    "payload" JSONB NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "triggeredAuditId" TEXT,

    CONSTRAINT "MonitoringEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "citizenId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleHi" TEXT,
    "body" TEXT NOT NULL,
    "bodyHi" TEXT,
    "actionUrl" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "citizenId" TEXT,
    "actor" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT,
    "reason" TEXT NOT NULL,
    "evidenceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gov_application" (
    "id" TEXT NOT NULL,
    "applicationRef" TEXT NOT NULL,
    "schemeCode" TEXT NOT NULL,
    "aadhaarLast4" TEXT NOT NULL,
    "status" "GovApplicationStatus" NOT NULL,
    "receivedOn" TIMESTAMP(3) NOT NULL,
    "decidedOn" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "pendingDocument" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gov_application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gov_disbursement" (
    "id" TEXT NOT NULL,
    "disbursementRef" TEXT NOT NULL,
    "applicationRef" TEXT NOT NULL,
    "schemeCode" TEXT NOT NULL,
    "aadhaarLast4" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "periodLabel" TEXT NOT NULL,
    "releasedOn" TIMESTAMP(3) NOT NULL,
    "channel" TEXT NOT NULL,
    "bankAccountLast4" TEXT,
    "status" "GovDisbursementStatus" NOT NULL DEFAULT 'RELEASED',
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gov_disbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gov_status_event" (
    "id" TEXT NOT NULL,
    "applicationRef" TEXT NOT NULL,
    "schemeCode" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gov_status_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoClock" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "offsetDays" INTEGER NOT NULL DEFAULT 0,
    "offsetMinutes" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DemoClock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DemoPersona" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "citizenId" TEXT,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "DemoPersona_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CitizenProfile_citizenId_key" ON "CitizenProfile"("citizenId");

-- CreateIndex
CREATE INDEX "ProfileField_key_idx" ON "ProfileField"("key");

-- CreateIndex
CREATE UNIQUE INDEX "ProfileField_profileId_key_key" ON "ProfileField"("profileId", "key");

-- CreateIndex
CREATE INDEX "Document_citizenId_idx" ON "Document"("citizenId");

-- CreateIndex
CREATE UNIQUE INDEX "Scheme_code_key" ON "Scheme"("code");

-- CreateIndex
CREATE INDEX "RuleClause_field_idx" ON "RuleClause"("field");

-- CreateIndex
CREATE UNIQUE INDEX "RuleClause_schemeId_code_key" ON "RuleClause"("schemeId", "code");

-- CreateIndex
CREATE INDEX "Entitlement_lifecycleState_idx" ON "Entitlement"("lifecycleState");

-- CreateIndex
CREATE UNIQUE INDEX "Entitlement_citizenId_schemeId_key" ON "Entitlement"("citizenId", "schemeId");

-- CreateIndex
CREATE INDEX "ExpectedPayment_dueOn_idx" ON "ExpectedPayment"("dueOn");

-- CreateIndex
CREATE UNIQUE INDEX "ExpectedPayment_entitlementId_periodLabel_key" ON "ExpectedPayment"("entitlementId", "periodLabel");

-- CreateIndex
CREATE UNIQUE INDEX "Application_entitlementId_key" ON "Application"("entitlementId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_idempotencyKey_key" ON "Application"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationField_applicationId_key_key" ON "ApplicationField"("applicationId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ApplicationDocument_applicationId_kind_key" ON "ApplicationDocument"("applicationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_expectedPaymentId_key" ON "Payment"("expectedPaymentId");

-- CreateIndex
CREATE INDEX "Payment_entitlementId_periodLabel_idx" ON "Payment"("entitlementId", "periodLabel");

-- CreateIndex
CREATE INDEX "ReceiptVerification_paymentId_idx" ON "ReceiptVerification"("paymentId");

-- CreateIndex
CREATE INDEX "BenefitAudit_entitlementId_runAt_idx" ON "BenefitAudit"("entitlementId", "runAt");

-- CreateIndex
CREATE INDEX "BenefitGap_entitlementId_kind_idx" ON "BenefitGap"("entitlementId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "RootCause_gapId_attempt_key" ON "RootCause"("gapId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "ActionPlan_gapId_attempt_key" ON "ActionPlan"("gapId", "attempt");

-- CreateIndex
CREATE UNIQUE INDEX "ActionStep_planId_position_key" ON "ActionStep"("planId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "ActionExecution_idempotencyKey_key" ON "ActionExecution"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Approval_decision_idx" ON "Approval"("decision");

-- CreateIndex
CREATE UNIQUE INDEX "BenefitLedger_entitlementId_key" ON "BenefitLedger"("entitlementId");

-- CreateIndex
CREATE INDEX "MonitoringEvent_processedAt_idx" ON "MonitoringEvent"("processedAt");

-- CreateIndex
CREATE INDEX "MonitoringEvent_citizenId_kind_idx" ON "MonitoringEvent"("citizenId", "kind");

-- CreateIndex
CREATE INDEX "Notification_citizenId_readAt_idx" ON "Notification"("citizenId", "readAt");

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "gov_application_applicationRef_key" ON "gov_application"("applicationRef");

-- CreateIndex
CREATE INDEX "gov_application_schemeCode_aadhaarLast4_idx" ON "gov_application"("schemeCode", "aadhaarLast4");

-- CreateIndex
CREATE UNIQUE INDEX "gov_disbursement_disbursementRef_key" ON "gov_disbursement"("disbursementRef");

-- CreateIndex
CREATE INDEX "gov_disbursement_applicationRef_idx" ON "gov_disbursement"("applicationRef");

-- CreateIndex
CREATE INDEX "gov_disbursement_schemeCode_aadhaarLast4_idx" ON "gov_disbursement"("schemeCode", "aadhaarLast4");

-- CreateIndex
CREATE INDEX "gov_status_event_applicationRef_idx" ON "gov_status_event"("applicationRef");

-- CreateIndex
CREATE UNIQUE INDEX "DemoPersona_code_key" ON "DemoPersona"("code");

-- AddForeignKey
ALTER TABLE "CitizenProfile" ADD CONSTRAINT "CitizenProfile_citizenId_fkey" FOREIGN KEY ("citizenId") REFERENCES "Citizen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileField" ADD CONSTRAINT "ProfileField_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "CitizenProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileField" ADD CONSTRAINT "ProfileField_sourceDocumentId_fkey" FOREIGN KEY ("sourceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_citizenId_fkey" FOREIGN KEY ("citizenId") REFERENCES "Citizen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleClause" ADD CONSTRAINT "RuleClause_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_citizenId_fkey" FOREIGN KEY ("citizenId") REFERENCES "Citizen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entitlement" ADD CONSTRAINT "Entitlement_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "Scheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpectedPayment" ADD CONSTRAINT "ExpectedPayment_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationField" ADD CONSTRAINT "ApplicationField_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicationDocument" ADD CONSTRAINT "ApplicationDocument_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_expectedPaymentId_fkey" FOREIGN KEY ("expectedPaymentId") REFERENCES "ExpectedPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptVerification" ADD CONSTRAINT "ReceiptVerification_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitAudit" ADD CONSTRAINT "BenefitAudit_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditFinding" ADD CONSTRAINT "AuditFinding_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "BenefitAudit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitGap" ADD CONSTRAINT "BenefitGap_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitGap" ADD CONSTRAINT "BenefitGap_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "BenefitAudit"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RootCause" ADD CONSTRAINT "RootCause_gapId_fkey" FOREIGN KEY ("gapId") REFERENCES "BenefitGap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionPlan" ADD CONSTRAINT "ActionPlan_gapId_fkey" FOREIGN KEY ("gapId") REFERENCES "BenefitGap"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionStep" ADD CONSTRAINT "ActionStep_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionExecution" ADD CONSTRAINT "ActionExecution_planId_fkey" FOREIGN KEY ("planId") REFERENCES "ActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionExecution" ADD CONSTRAINT "ActionExecution_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "ActionStep"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_actionPlanId_fkey" FOREIGN KEY ("actionPlanId") REFERENCES "ActionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BenefitLedger" ADD CONSTRAINT "BenefitLedger_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringEvent" ADD CONSTRAINT "MonitoringEvent_citizenId_fkey" FOREIGN KEY ("citizenId") REFERENCES "Citizen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringEvent" ADD CONSTRAINT "MonitoringEvent_entitlementId_fkey" FOREIGN KEY ("entitlementId") REFERENCES "Entitlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_citizenId_fkey" FOREIGN KEY ("citizenId") REFERENCES "Citizen"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_citizenId_fkey" FOREIGN KEY ("citizenId") REFERENCES "Citizen"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DemoPersona" ADD CONSTRAINT "DemoPersona_citizenId_fkey" FOREIGN KEY ("citizenId") REFERENCES "Citizen"("id") ON DELETE SET NULL ON UPDATE CASCADE;
