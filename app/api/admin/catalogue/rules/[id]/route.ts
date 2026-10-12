/**
 * POST /api/admin/catalogue/rules/:id
 *
 * Approve or reject one drafted rule, optionally editing it as part of the
 * approval. The reviewer comes from the x-reviewer header and is recorded.
 */

import { handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireAdmin } from "@/lib/authz";
import { decideRule } from "@/lib/catalogue/review";
import { systemClock } from "@/lib/clock";

const Scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const Body = z.object({
  decision: z.enum(["APPROVED", "REJECTED"]),
  edit: z
    .object({
      kind: z.enum(["ELIGIBILITY", "EXCLUSION"]),
      field: z.string().min(1),
      op: z.string().min(1),
      value: z.union([Scalar, z.array(Scalar)]),
      mandatory: z.boolean(),
      text: z.string().min(1).max(300),
      sourceQuote: z.string().min(1).max(600),
    })
    .optional(),
});

export const POST = handler("POST /api/admin/catalogue/rules/:id", async (request, ctx) => {
  const { reviewer } = requireAdmin(request);
  const ruleId = await routeParam(ctx, "id");
  const body = await parseBody(request, Body);

  const rule = await decideRule({
    ruleId,
    decision: body.decision,
    edit: body.edit,
    reviewer,
    clock: systemClock(),
  });

  return ok({
    id: rule.id,
    status: rule.status,
    reviewedBy: rule.reviewedBy,
    reviewedAt: rule.reviewedAt?.toISOString() ?? null,
  });
});
