/**
 * GET /api/entitlements?citizenId=...
 *
 * The persisted entitlements, read back without re-evaluating. This is what
 * the dashboard loads: the stored clause results make every verdict
 * explainable without re-joining the registry, so a decision made weeks ago
 * stays readable even after a scheme's rules change.
 */

import { handler, ok, parseQuery, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { paise, serialize } from "@/lib/engine/money";
import { annualValue } from "@/lib/engine/period";

const Query = z.object({
  citizenId: z.string().min(1),
  /** Omit excluded schemes from the response. */
  includeExcluded: z.enum(["true", "false"]).optional(),
});

export const GET = handler("GET /api/entitlements", async (request) => {
  const query = parseQuery(request, Query);
  const citizen = await requireCitizen(query.citizenId);
  const includeExcluded = query.includeExcluded !== "false";

  const rows = await prisma.entitlement.findMany({
    where: {
      citizenId: citizen.citizenId,
      ...(includeExcluded ? {} : { verdict: { not: "RED" } }),
    },
    include: {
      scheme: {
        select: {
          code: true,
          name: true,
          nameHi: true,
          category: true,
          benefitType: true,
          benefitNote: true,
          applicationUrl: true,
          sourceName: true,
          sourceUrl: true,
          lastVerified: true,
          verificationStatus: true,
        },
      },
      application: { select: { id: true, status: true, submittedAt: true } },
      ledger: true,
    },
    orderBy: [{ verdict: "asc" }, { confidence: "desc" }],
  });

  return ok({
    citizenId: citizen.citizenId,
    entitlements: rows.map((row) => {
      // Prisma returns a plain bigint; brand it at the boundary so the rest
      // of the money API applies. The brand exists precisely to stop a raw
      // number or an unconverted rupee value being used as paise.
      const perInstalment =
        row.expectedAmountPaise === null ? null : paise(row.expectedAmountPaise);
      const annual =
        perInstalment === null ? null : annualValue(row.frequency, perInstalment);

      return {
        id: row.id,
        verdict: row.verdict,
        confidence: row.confidence,
        lifecycleState: row.lifecycleState,
        // Paise cross the wire as strings; null means "not a fixed cash
        // amount", which is not zero.
        expectedAmountPaise: perInstalment === null ? null : serialize(perInstalment),
        annualValuePaise: annual === null ? null : serialize(annual),
        frequency: row.frequency,
        missingEvidence: row.missingEvidence,
        pendingDeclarations: row.pendingDeclarations,
        /** Full clause evaluation as stored, for the Why? drawer. */
        clauseResults: row.clauseResults,
        scheme: {
          ...row.scheme,
          lastVerified: row.scheme.lastVerified.toISOString().slice(0, 10),
        },
        application: row.application
          ? {
              id: row.application.id,
              status: row.application.status,
              submittedAt: row.application.submittedAt?.toISOString() ?? null,
            }
          : null,
        ledger: row.ledger
          ? {
              receiptState: row.ledger.receiptState,
              recoveryStatus: row.ledger.recoveryStatus,
              receivedAmountPaise: serialize(row.ledger.receivedAmountPaise),
              unverifiedAmountPaise: serialize(row.ledger.unverifiedAmountPaise),
              gapAmountPaise: serialize(row.ledger.gapAmountPaise),
              recoveredAmountPaise: serialize(row.ledger.recoveredAmountPaise),
              lastVerifiedAt: row.ledger.lastVerifiedAt?.toISOString() ?? null,
            }
          : null,
      };
    }),
  });
});
