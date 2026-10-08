/**
 * POST /api/payments/[id]/confirm
 *
 * The YES / NO / NOT SURE answer. All three are recorded as given; none is
 * coerced into another.
 */

import { handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { serialize } from "@/lib/engine/money";
import { currentClock } from "@/lib/services/clock";
import { confirmReceipt } from "@/lib/services/receipt";

const Body = z.object({
  citizenId: z.string().min(1),
  answer: z.enum(["YES", "NO", "NOT_SURE"]),
  note: z.string().max(500).optional(),
});

export const POST = handler(
  "POST /api/payments/[id]/confirm",
  async (request, ctx) => {
    const body = await parseBody(request, Body);
    const citizen = await requireCitizen(body.citizenId);
    const paymentId = await routeParam(ctx, "id");
    const clock = await currentClock();

    const result = await confirmReceipt({
      citizenId: citizen.citizenId,
      paymentId,
      answer: body.answer,
      note: body.note,
      clock,
    });

    return ok({
      paymentId: result.paymentId,
      receiptState: result.receiptState,
      // Kept as separate named fields all the way to the browser.
      gapAmountPaise: serialize(result.gapAmount),
      unverifiedAmountPaise: serialize(result.unverifiedAmount),
      reasons: result.reasons,
      offerBankVerification: result.offerBankVerification,
      nextStep: result.nextStep,
    });
  },
);
