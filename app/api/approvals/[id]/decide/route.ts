/**
 * POST /api/approvals/[id]/decide
 *
 * Both human-in-the-loop gates. The approval's own `kind` decides which
 * service handles it, so a caller cannot route an application approval into
 * the corrective-action path.
 */

import { prisma } from "@/lib/db";
import { ApiError, handler, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { decideApplicationApproval } from "@/lib/services/application";
import { decideActionApproval } from "@/lib/services/recovery";
import { currentClock } from "@/lib/services/clock";

const Body = z.object({
  citizenId: z.string().min(1),
  decision: z.enum(["APPROVED", "REJECTED"]),
  edits: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(500).optional(),
});

export const POST = handler(
  "POST /api/approvals/[id]/decide",
  async (request, ctx) => {
    const body = await parseBody(request, Body);
    const citizen = await requireCitizen(body.citizenId);
    const approvalId = await routeParam(ctx, "id");

    const approval = await prisma.approval.findUnique({
      where: { id: approvalId },
      select: { kind: true },
    });
    if (!approval) throw new ApiError("NOT_FOUND", "No such approval.");

    const clock = await currentClock();

    if (approval.kind === "APPLICATION_SUBMISSION") {
      return ok(
        await decideApplicationApproval({
          citizenId: citizen.citizenId,
          approvalId,
          decision: body.decision,
          edits: body.edits,
          note: body.note,
          clock,
        }),
      );
    }

    return ok(
      await decideActionApproval({
        citizenId: citizen.citizenId,
        approvalId,
        decision: body.decision,
        note: body.note,
        clock,
      }),
    );
  },
);
