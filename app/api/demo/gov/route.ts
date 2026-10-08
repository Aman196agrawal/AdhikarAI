/**
 * POST /api/demo/gov
 *
 * The demo console's control over the simulated government portal.
 *
 * Gated on DEMO_MODE. This endpoint makes the *government* act - approve,
 * reject, release a payment, fail one - which is how months of benefit
 * lifecycle can be shown in minutes. Everything it does writes to the gov_*
 * store, so the resulting disagreement with the citizen's record is a genuine
 * one reached through the normal code path.
 */

import { handler, ok, parseBody, z, ApiError } from "@/lib/api/http";
import { requireCitizen, requireDemoMode } from "@/lib/authz";
import {
  govApproveApplication,
  govFailPaymentOnSeeding,
  govRejectApplication,
  govReleasePayment,
  govReturnForDocument,
  govSkipPayment,
  govStallApplication,
} from "@/lib/adapters/mockGovControl";
import { prisma } from "@/lib/db";
import { paise } from "@/lib/engine/money";
import { periodLabel } from "@/lib/engine/period";
import { currentClock } from "@/lib/services/clock";

const Body = z.object({
  citizenId: z.string().min(1),
  entitlementId: z.string().min(1),
  action: z.enum([
    "APPROVE",
    "REJECT",
    "RETURN_FOR_DOCUMENT",
    "STALL",
    "RELEASE_PAYMENT",
    "FAIL_PAYMENT_SEEDING",
    "SKIP_PAYMENT",
  ]),
  reason: z.string().max(300).optional(),
  documentKind: z.string().max(60).optional(),
  daysPending: z.coerce.number().int().min(1).max(3650).optional(),
  periodLabel: z.string().max(20).optional(),
});

export const POST = handler("POST /api/demo/gov", async (request) => {
  requireDemoMode();

  const body = await parseBody(request, Body);
  const citizen = await requireCitizen(body.citizenId);
  const clock = await currentClock();

  const entitlement = await prisma.entitlement.findFirstOrThrow({
    where: { id: body.entitlementId, citizenId: citizen.citizenId },
    include: { scheme: true, application: true },
  });

  const applicationRef = entitlement.application?.govApplicationRef;
  if (!applicationRef) {
    throw new ApiError(
      "UNPROCESSABLE",
      "This benefit has not been submitted to the portal yet, so the portal cannot act on it.",
    );
  }

  const citizenRow = await prisma.citizen.findUniqueOrThrow({
    where: { id: citizen.citizenId },
    select: { aadhaarLast4: true, bankAccountLast4: true },
  });

  const period =
    body.periodLabel ?? periodLabel(entitlement.frequency, clock.now());

  switch (body.action) {
    case "APPROVE":
      await govApproveApplication({ applicationRef, clock, note: body.reason });
      break;

    case "REJECT":
      await govRejectApplication({
        applicationRef,
        reason: body.reason ?? "Rejected after verification.",
        clock,
      });
      break;

    case "RETURN_FOR_DOCUMENT":
      await govReturnForDocument({
        applicationRef,
        documentKind: body.documentKind ?? "INCOME_CERTIFICATE",
        clock,
      });
      break;

    case "STALL":
      await govStallApplication({
        applicationRef,
        daysPending: body.daysPending ?? 94,
        clock,
      });
      break;

    case "RELEASE_PAYMENT": {
      if (entitlement.expectedAmountPaise === null) {
        throw new ApiError(
          "UNPROCESSABLE",
          "This benefit is not a cash transfer, so there is no payment to release.",
        );
      }
      await govReleasePayment({
        applicationRef,
        schemeCode: entitlement.scheme.code,
        aadhaarLast4: citizenRow.aadhaarLast4 ?? "0000",
        periodLabel: period,
        amountPaise: paise(entitlement.expectedAmountPaise),
        bankAccountLast4: citizenRow.bankAccountLast4 ?? undefined,
        clock,
      });
      break;
    }

    case "FAIL_PAYMENT_SEEDING":
      await govFailPaymentOnSeeding({
        applicationRef,
        periodLabel: period,
        clock,
      });
      break;

    case "SKIP_PAYMENT":
      await govSkipPayment({ applicationRef, periodLabel: period });
      break;
  }

  return ok({
    action: body.action,
    applicationRef,
    periodLabel: period,
    note: "This changed the SIMULATED government record. Run an audit to see what AdhikarAI makes of it.",
  });
});
