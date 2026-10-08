/**
 * Database helpers for scenario tests.
 *
 * Scenario tests run against a real Postgres, because the behaviour under test
 * includes the persistence: upsert semantics, provenance precedence and the
 * audit trail are exactly the sort of thing a mocked database would
 * cheerfully get wrong.
 */

import { prisma } from "@/lib/db";
import { SCHEMES, validateRegistry } from "@/lib/registry";
import { rupees } from "@/lib/engine/money";
import type { Prisma } from "@/lib/generated/prisma/client";

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

/**
 * Delete all citizen-side data, leaving the scheme registry in place.
 *
 * Order matters only where cascades do not cover it; most tables cascade from
 * Citizen. The gov_* tables are cleared too, since a leftover disbursement
 * would make the next test's audit disagree with its fixtures.
 */
export async function resetCitizenData(): Promise<void> {
  await prisma.auditLog.deleteMany({});
  await prisma.citizen.deleteMany({});
  await prisma.govDisbursement.deleteMany({});
  await prisma.govStatusEvent.deleteMany({});
  await prisma.govApplication.deleteMany({});
}

/** Seed the registry if it is missing, so tests do not depend on run order. */
export async function ensureRegistry(): Promise<void> {
  const problems = validateRegistry();
  if (problems.length > 0) {
    throw new Error(`Registry is invalid:\n${problems.join("\n")}`);
  }

  const count = await prisma.scheme.count();
  if (count >= SCHEMES.length) return;

  for (const spec of SCHEMES) {
    const scheme = await prisma.scheme.upsert({
      where: { code: spec.code },
      create: {
        code: spec.code,
        name: spec.name,
        nameHi: spec.nameHi,
        governmentLevel: spec.governmentLevel,
        states: spec.states,
        category: spec.category,
        description: spec.description,
        descriptionHi: spec.descriptionHi,
        benefitType: spec.benefitType,
        benefitAmountPaise:
          spec.benefitAmountRupees === null ? null : rupees(spec.benefitAmountRupees),
        benefitNote: spec.benefitNote,
        frequency: spec.frequency,
        durationMonths: spec.durationMonths,
        installmentsPerYear: spec.installmentsPerYear,
        applicationMethod: spec.applicationMethod,
        applicationUrl: spec.applicationUrl,
        formSchema: asJson(spec.formSchema),
        requiredDocuments: spec.requiredDocuments,
        sourceName: spec.sourceName,
        sourceUrl: spec.sourceUrl,
        lastVerified: new Date(spec.lastVerified),
        verificationStatus: spec.verificationStatus,
      },
      update: {},
    });

    await prisma.ruleClause.deleteMany({ where: { schemeId: scheme.id } });
    await prisma.ruleClause.createMany({
      data: spec.clauses.map((clause) => ({
        schemeId: scheme.id,
        code: clause.code,
        kind: clause.kind,
        field: clause.field,
        op: clause.op,
        value: asJson(clause.value),
        mandatory: clause.mandatory,
        evidenceDocs: clause.evidenceDocs,
        text: clause.text,
        textHi: clause.textHi,
        sourceName: clause.sourceName,
        sourceUrl: clause.sourceUrl,
        lastVerified: new Date(clause.lastVerified),
      })),
    });
  }
}

/** Create a demo citizen. */
export async function createCitizen(
  overrides?: Partial<{
    name: string;
    aadhaarLast4: string;
    bankAccountLast4: string;
    locale: string;
  }>,
): Promise<{ id: string; aadhaarLast4: string }> {
  const citizen = await prisma.citizen.create({
    data: {
      name: overrides?.name ?? "Kamala Devi",
      nameHi: "कमला देवी",
      aadhaarLast4: overrides?.aadhaarLast4 ?? "4417",
      bankAccountLast4: overrides?.bankAccountLast4 ?? "8821",
      locale: overrides?.locale ?? "en",
      isDemo: true,
    },
  });
  return { id: citizen.id, aadhaarLast4: citizen.aadhaarLast4 ?? "4417" };
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
