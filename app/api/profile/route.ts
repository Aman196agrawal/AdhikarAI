/**
 * POST /api/profile  - add to a citizen's profile from what they said
 * GET  /api/profile  - read the current profile and what is still needed
 *
 * The response always reports what was REJECTED alongside what was accepted.
 * A field the extractor got wrong and the validator dropped is information the
 * citizen may need to correct, and hiding it would make the system look more
 * certain than it is.
 */

import { extractProfile, missingFieldQuestions } from "@/lib/agents/profileAgent";
import { handler, ok, parseBody, parseQuery, z } from "@/lib/api/http";
import { requireCitizen } from "@/lib/authz";
import { PROFILE_FIELD_SPECS } from "@/lib/profile/fields";
import { loadProfile, saveProfileFields, recordCitizenAnswer } from "@/lib/services/profile";
import { isProfileFieldKey } from "@/lib/profile/fields";
import { ApiError } from "@/lib/api/http";

const PostBody = z.object({
  citizenId: z.string().min(1),
  /** Free-text intake, in the citizen's own words. */
  intake: z.string().min(1).max(4000).optional(),
  /**
   * Direct answers to specific questions. Always recorded as SELF_DECLARED
   * and allowed to overwrite an earlier inference: when a citizen answers a
   * question about their own circumstances, their answer wins.
   */
  answers: z
    .array(
      z.object({
        key: z.string().min(1),
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
      }),
    )
    .max(40)
    .optional(),
});

function describeProfile(profile: Awaited<ReturnType<typeof loadProfile>>) {
  return Object.entries(profile).map(([key, field]) => ({
    key,
    label: isProfileFieldKey(key) ? PROFILE_FIELD_SPECS[key].label : key,
    value: field?.value ?? null,
    provenance: field?.provenance ?? "MISSING",
  }));
}

export const POST = handler("POST /api/profile", async (request) => {
  const body = await parseBody(request, PostBody);
  const citizen = await requireCitizen(body.citizenId);

  if (!body.intake && (!body.answers || body.answers.length === 0)) {
    throw new ApiError(
      "BAD_REQUEST",
      "Provide either intake text or at least one answer.",
    );
  }

  const rejected: Array<{ key: string; reason: string }> = [];
  let accepted = 0;
  let llmStatus: Record<string, unknown> | null = null;

  // Direct answers first: they are authoritative, and extraction should see
  // them as already-established context.
  for (const answer of body.answers ?? []) {
    if (!isProfileFieldKey(answer.key)) {
      rejected.push({ key: answer.key, reason: "not a recognised attribute" });
      continue;
    }
    await recordCitizenAnswer(citizen.citizenId, answer.key, answer.value);
    accepted += 1;
  }

  if (body.intake) {
    const existing = await loadProfile(citizen.citizenId);
    const extraction = await extractProfile({ intake: body.intake, existing });

    const saved = await saveProfileFields(citizen.citizenId, extraction.accepted, {
      rawIntake: body.intake,
    });

    accepted += saved.written;
    rejected.push(
      ...extraction.rejected.map((r) => ({ key: r.key, reason: r.reason })),
    );

    llmStatus = {
      ok: extraction.llm.ok,
      provider: extraction.llm.provider,
      attempts: extraction.llm.attempts,
      ...(extraction.llm.reason ? { reason: extraction.llm.reason } : {}),
    };
  }

  const profile = await loadProfile(citizen.citizenId);

  return ok({
    citizenId: citizen.citizenId,
    acceptedCount: accepted,
    rejected,
    profile: describeProfile(profile),
    questions: missingFieldQuestions(profile),
    llm: llmStatus,
  });
});

const GetQuery = z.object({ citizenId: z.string().min(1) });

export const GET = handler("GET /api/profile", async (request) => {
  const query = parseQuery(request, GetQuery);
  const citizen = await requireCitizen(query.citizenId);
  const profile = await loadProfile(citizen.citizenId);

  return ok({
    citizenId: citizen.citizenId,
    name: citizen.name,
    locale: citizen.locale,
    profile: describeProfile(profile),
    questions: missingFieldQuestions(profile),
  });
});
