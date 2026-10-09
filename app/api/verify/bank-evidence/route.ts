/**
 * POST /api/verify/bank-evidence
 *
 * Ephemeral bank statement verification.
 *
 * The document arrives as multipart, is read into memory, checked for ONE
 * transaction, and dropped. Nothing is written to disk and nothing but the
 * minimal verification record reaches the database.
 *
 * `runtime = "nodejs"` because this needs Node's crypto for the fingerprint
 * and a real Buffer; it must not run on an edge runtime.
 *
 * A boundary test asserts there is no filesystem write anywhere in this path.
 */

import { ApiError, fail, handler, ok } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { paise, serialize } from "@/lib/engine/money";
import { reconcile } from "@/lib/engine/reconciler";
import {
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_LABEL,
  isAcceptedMimeType,
  verifyBankEvidence,
} from "@/lib/documents/bankEvidence";
import { currentClock } from "@/lib/services/clock";
import { expectedForPayment } from "@/lib/services/expected";
import { auditBenefit } from "@/lib/services/audit";
import { recordAudit } from "@/lib/services/transitions";

export const runtime = "nodejs";

export const POST = handler("POST /api/verify/bank-evidence", async (request) => {
  // Refuse an oversized upload from its declared length, BEFORE reading the
  // body. formData() buffers the entire request in memory, so checking the
  // file size afterwards meant a huge upload was fully read first.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    throw new ApiError(
      "BAD_REQUEST",
      `That file is larger than ${MAX_UPLOAD_LABEL}. A photo of the single page showing the payment is enough.`,
    );
  }

  const form = await request.formData().catch(() => null);
  if (!form) {
    throw new ApiError("BAD_REQUEST", "Expected a file upload.");
  }

  const citizenId = String(form.get("citizenId") ?? "");
  const paymentId = String(form.get("paymentId") ?? "");
  const file = form.get("file");

  const citizen = await requireCitizen(citizenId);

  if (!(file instanceof File)) {
    throw new ApiError("BAD_REQUEST", "No file was attached.");
  }
  if (file.size === 0) {
    throw new ApiError("BAD_REQUEST", "The file was empty.");
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(
      "BAD_REQUEST",
      `That file is larger than ${MAX_UPLOAD_LABEL}. A photo of the single page showing the payment is enough.`,
    );
  }
  if (!isAcceptedMimeType(file.type)) {
    throw new ApiError(
      "BAD_REQUEST",
      "Please upload a PDF or a photo (JPEG, PNG, WEBP or HEIC).",
    );
  }

  const payment = await prisma.payment.findFirst({
    where: { id: paymentId, entitlement: { citizenId: citizen.citizenId } },
    include: {
      entitlement: { include: { scheme: { select: { name: true, code: true } } } },
      verifications: { orderBy: [{ verifiedAt: "desc" }, { id: "desc" }], take: 1 },
    },
  });

  if (!payment) throw new ApiError("NOT_FOUND", "No such payment.");

  const clock = await currentClock();
  // The stage actually sent, for a staged benefit - not the full entitlement,
  // or the statement is searched for a credit far larger than the real one.
  const expected =
    expectedForPayment({
      schemeCode: payment.entitlement.scheme.code,
      entitlementExpected: payment.entitlement.expectedAmountPaise,
      reportedAmount: payment.reportedAmountPaise,
    }) ?? paise(payment.reportedAmountPaise);

  // Read into memory. This buffer is the only copy, and it is never written
  // anywhere; it goes out of scope when this handler returns.
  const bytes = new Uint8Array(await file.arrayBuffer());

  const evidence = await verifyBankEvidence({
    bytes,
    mimeType: file.type,
    expectedAmount: expected,
    expectedOn: payment.reportedOn,
    schemeName: payment.entitlement.scheme.name,
    clock,
  });

  if (evidence.failure !== null) {
    // Nothing was established, so nothing is recorded against the payment.
    return fail("UNPROCESSABLE", evidence.explanation, {
      failure: evidence.failure,
    });
  }

  // Re-reconcile with the evidence alongside whatever the citizen said.
  const previousAnswer = payment.verifications[0]?.citizenReport ?? null;

  const result = reconcile({
    expectedAmount: expected,
    governmentReportedAmount: paise(payment.reportedAmountPaise),
    citizenReport: previousAnswer,
    evidence: { result: evidence.result, matchedAmount: evidence.matchedAmount },
  });

  await prisma.receiptVerification.create({
    data: {
      paymentId: payment.id,
      citizenReport: previousAnswer,
      evidenceResult: evidence.result,
      method: "BANK_EVIDENCE",
      expectedAmountPaise: expected,
      // This is ALL that survives the document.
      matchedAmountPaise: evidence.matchedAmount,
      matchedOn: evidence.matchedOn,
      refLast4: evidence.refLast4,
      docSha256: evidence.docSha256,
      resultState: result.receiptState,
      note: "Checked against a document the citizen supplied. The document was not retained.",
      verifiedAt: clock.now(),
    },
  });

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      receiptState: result.receiptState,
      gapAmountPaise: result.gapAmount,
    },
  });

  await recordAudit(prisma, {
    citizenId: citizen.citizenId,
    actor: { kind: "citizen", citizenId: citizen.citizenId },
    entity: "Payment",
    entityId: payment.id,
    toState: result.receiptState,
    // The audit log records that a document was checked and its fingerprint,
    // never its contents.
    reason: `Checked against a supplied document (sha256 ${evidence.docSha256.slice(0, 12)}...). ${evidence.explanation}`,
  });

  // Re-audit rather than writing this one payment's figures into the ledger,
  // which overwrote every other period's totals. See confirmReceipt.
  await auditBenefit({
    citizenId: citizen.citizenId,
    entitlementId: payment.entitlementId,
    clock,
    actor: { kind: "citizen", citizenId: citizen.citizenId },
  });

  return ok({
    paymentId: payment.id,
    result: evidence.result,
    receiptState: result.receiptState,
    matchedAmountPaise:
      evidence.matchedAmount === null ? null : serialize(evidence.matchedAmount),
    matchedOn: evidence.matchedOn?.toISOString() ?? null,
    refLast4: evidence.refLast4,
    gapAmountPaise: serialize(result.gapAmount),
    unverifiedAmountPaise: serialize(result.unverifiedAmount),
    explanation: evidence.explanation,
    privacyNote:
      "Only the matching amount, its date, the last four characters of the reference and a fingerprint of the file were kept. The document itself was not stored.",
  });
});
