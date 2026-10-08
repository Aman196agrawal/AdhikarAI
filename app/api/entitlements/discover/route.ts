/**
 * POST /api/entitlements/discover
 *
 * Runs the deterministic discovery pipeline and persists the result as the
 * baseline every later audit reconciles against.
 *
 * No model call happens in this request. The verdicts come from the rule
 * engine and the confidence from rule coverage, which is why the same profile
 * always produces the same answer.
 */

import { handler, ok, parseBody, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { discoverAndPersist, toWire } from "@/lib/services/discovery";
import { loadProfile } from "@/lib/services/profile";
import { missingFieldQuestions } from "@/lib/agents/profileAgent";

const Body = z.object({ citizenId: z.string().min(1) });

export const POST = handler("POST /api/entitlements/discover", async (request) => {
  const body = await parseBody(request, Body);
  const citizen = await requireCitizen(body.citizenId);

  const profile = await loadProfile(citizen.citizenId);
  const result = await discoverAndPersist({
    citizenId: citizen.citizenId,
    profile,
  });

  const entitlements = result.entitlements.map(toWire);

  return ok({
    citizenId: citizen.citizenId,
    created: result.created,
    updated: result.updated,
    counts: {
      eligible: entitlements.filter((e) => e.verdict === "GREEN").length,
      potentiallyEligible: entitlements.filter((e) => e.verdict === "YELLOW").length,
      excluded: entitlements.filter((e) => e.verdict === "RED").length,
    },
    entitlements,
    /**
     * Returned alongside the results because a YELLOW verdict is only
     * actionable if the citizen knows which answer would resolve it.
     */
    questions: missingFieldQuestions(profile),
  });
});
