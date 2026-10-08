/**
 * Profile persistence.
 *
 * Fields are stored one row per attribute with their provenance, which is what
 * lets the rule engine distinguish a documented fact from something the
 * citizen mentioned in passing, and what makes the confidence score
 * reconstructable rather than a stored opinion.
 *
 * Upserting per field (rather than replacing the profile) means a later
 * conversation or an uploaded document can strengthen one attribute's
 * provenance without disturbing the rest.
 */

import type { AcceptedField } from "@/lib/agents/profileAgent";
import type { Profile, ProfileFieldValue } from "@/lib/engine/rules";
import { prisma } from "@/lib/db";
import { Prisma } from "@/lib/generated/prisma/client";
import { isProfileFieldKey } from "@/lib/profile/fields";
import type { ProfileFieldKey } from "@/lib/registry/types";
import type { Db } from "./transitions";

/**
 * Store a scalar in a Json column.
 *
 * `Prisma.JsonNull` writes a JSON null, which is what an explicit "I asked and
 * there is none" answer means. `Prisma.DbNull` would write a SQL NULL, making
 * the row indistinguishable from a field nobody ever established - and that
 * distinction is exactly what lets the rule engine return UNKNOWN instead of
 * asserting a negative.
 */
function toJsonValue(
  value: string | number | boolean | null,
): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  return value === null ? Prisma.JsonNull : value;
}

/** Provenance strength, so a weaker source cannot overwrite a stronger one. */
const PROVENANCE_RANK = {
  DOCUMENT_VERIFIED: 3,
  SELF_DECLARED: 2,
  INFERRED: 1,
  MISSING: 0,
} as const;

/** Load a citizen's profile in the shape the rule engine consumes. */
export async function loadProfile(citizenId: string): Promise<Profile> {
  const stored = await prisma.citizenProfile.findUnique({
    where: { citizenId },
    include: { fields: true },
  });

  if (!stored) return {};

  const profile: Profile = {};
  for (const field of stored.fields) {
    if (!isProfileFieldKey(field.key)) continue;
    profile[field.key] = {
      // Stored as JSON; the value was range-checked before it was written.
      value: field.value as ProfileFieldValue["value"],
      provenance: field.provenance,
    };
  }
  return profile;
}

export interface SaveProfileResult {
  written: number;
  /** Fields left alone because the stored value had stronger provenance. */
  skipped: Array<{ key: ProfileFieldKey; reason: string }>;
}

/**
 * Persist extracted fields.
 *
 * A field is written unless the stored version rests on stronger evidence: a
 * value read off an Aadhaar card is not overwritten by the same value merely
 * mentioned in conversation, because that would silently weaken the
 * confidence score. The citizen correcting a documented value is handled
 * separately, as an explicit correction.
 */
export async function saveProfileFields(
  citizenId: string,
  fields: readonly AcceptedField[],
  options?: { rawIntake?: string; db?: Db },
): Promise<SaveProfileResult> {
  const db = options?.db ?? prisma;

  const profile = await db.citizenProfile.upsert({
    where: { citizenId },
    create: { citizenId, rawIntake: options?.rawIntake },
    update: options?.rawIntake ? { rawIntake: options.rawIntake } : {},
    include: { fields: true },
  });

  const existing = new Map(profile.fields.map((f) => [f.key, f]));
  const skipped: SaveProfileResult["skipped"] = [];
  let written = 0;

  for (const field of fields) {
    const current = existing.get(field.key);

    if (
      current &&
      PROVENANCE_RANK[current.provenance] > PROVENANCE_RANK[field.provenance]
    ) {
      skipped.push({
        key: field.key,
        reason: `stored value is ${current.provenance}, which outranks ${field.provenance}`,
      });
      continue;
    }

    await db.profileField.upsert({
      where: { profileId_key: { profileId: profile.id, key: field.key } },
      create: {
        profileId: profile.id,
        key: field.key,
        value: toJsonValue(field.value),
        provenance: field.provenance,
        note: field.note,
      },
      update: {
        value: toJsonValue(field.value),
        provenance: field.provenance,
        note: field.note,
      },
    });
    written += 1;
  }

  return { written, skipped };
}

/**
 * Record a citizen's direct answer to a question.
 *
 * Always SELF_DECLARED, and always allowed to overwrite: when the citizen
 * answers a question about their own circumstances, their answer wins over an
 * inference the system made earlier.
 */
export async function recordCitizenAnswer(
  citizenId: string,
  key: ProfileFieldKey,
  value: string | number | boolean | null,
  options?: { db?: Db },
): Promise<void> {
  const db = options?.db ?? prisma;

  const profile = await db.citizenProfile.upsert({
    where: { citizenId },
    create: { citizenId },
    update: {},
  });

  await db.profileField.upsert({
    where: { profileId_key: { profileId: profile.id, key } },
    create: {
      profileId: profile.id,
      key,
      value: toJsonValue(value),
      provenance: "SELF_DECLARED",
      note: "Answered directly by the citizen.",
    },
    update: {
      value: toJsonValue(value),
      provenance: "SELF_DECLARED",
      note: "Answered directly by the citizen.",
    },
  });
}
