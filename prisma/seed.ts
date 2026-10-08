/**
 * Seed the scheme registry and demo control rows.
 *
 * Idempotent: safe to re-run. Schemes are upserted by code and their clauses
 * replaced wholesale, so editing lib/registry/schemes.ts and re-seeding brings
 * the database back in line without orphaning removed clauses.
 *
 * This seeds the REGISTRY only. Demo citizens, applications and the simulated
 * government store are seeded separately (prisma/seed-demo.ts) so a real
 * deployment can load the registry without any mock citizen data.
 */

import "dotenv/config";

import { prisma } from "../lib/db";
import { rupees } from "../lib/engine/money";
import { SCHEMES, validateRegistry } from "../lib/registry";
import type { Prisma } from "../lib/generated/prisma/client";

/**
 * Widen a typed registry structure to Prisma's JSON input type.
 *
 * `formSchema` is a typed array in the registry, which is what we want for
 * authoring, but Prisma's Json column input does not accept a typed array
 * directly. The shape is unchanged; only the static type is widened.
 */
const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

async function seedSchemes(): Promise<void> {
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
          spec.benefitAmountRupees === null
            ? null
            : rupees(spec.benefitAmountRupees),
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
      update: {
        name: spec.name,
        nameHi: spec.nameHi,
        governmentLevel: spec.governmentLevel,
        states: spec.states,
        category: spec.category,
        description: spec.description,
        descriptionHi: spec.descriptionHi,
        benefitType: spec.benefitType,
        benefitAmountPaise:
          spec.benefitAmountRupees === null
            ? null
            : rupees(spec.benefitAmountRupees),
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
    });

    // Replace clauses wholesale rather than upserting one by one, so a clause
    // deleted from the registry does not linger in the database and keep
    // influencing verdicts.
    await prisma.ruleClause.deleteMany({ where: { schemeId: scheme.id } });
    await prisma.ruleClause.createMany({
      data: spec.clauses.map((clause) => ({
        schemeId: scheme.id,
        code: clause.code,
        kind: clause.kind,
        field: clause.field,
        op: clause.op,
        value: clause.value as never,
        mandatory: clause.mandatory,
        evidenceDocs: clause.evidenceDocs,
        text: clause.text,
        textHi: clause.textHi,
        sourceName: clause.sourceName,
        sourceUrl: clause.sourceUrl,
        lastVerified: new Date(clause.lastVerified),
      })),
    });

    const checked = spec.verificationStatus === "SOURCE_CHECKED" ? "✓" : "·";
    console.log(
      `  ${checked} ${spec.code.padEnd(16)} ${spec.clauses.length} clauses`,
    );
  }
}

async function seedDemoClock(): Promise<void> {
  // Singleton row at offset zero. The demo console advances it; nothing else
  // writes it, and lib/clock.ts ignores it entirely unless DEMO_MODE is on.
  await prisma.demoClock.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", offsetDays: 0, offsetMinutes: 0 },
    update: {},
  });
}

async function main(): Promise<void> {
  const problems = validateRegistry();
  if (problems.length > 0) {
    // Refuse to seed a registry with structural problems. A missing source URL
    // or a malformed clause would silently degrade every downstream verdict.
    console.error("Registry validation failed:\n");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Seeding ${SCHEMES.length} schemes...`);
  await seedSchemes();
  await seedDemoClock();

  const sourceChecked = SCHEMES.filter(
    (s) => s.verificationStatus === "SOURCE_CHECKED",
  ).length;
  const clauses = SCHEMES.reduce((n, s) => n + s.clauses.length, 0);

  console.log(
    `\nDone. ${SCHEMES.length} schemes, ${clauses} clauses.\n` +
      `  ✓ ${sourceChecked} source-checked, · ${SCHEMES.length - sourceChecked} compiled from documentation.\n` +
      `  Registry figures are central assistance; state top-ups are not modelled.`,
  );
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
