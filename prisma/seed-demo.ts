/**
 * Demo data.
 *
 * Built by driving the REAL pipeline - profile extraction, discovery,
 * application, approval, submission, government simulation, audit,
 * reconciliation - rather than by inserting hand-crafted rows.
 *
 * That matters more than it sounds. Hand-written demo rows prove nothing: they
 * can show any state the author wants, including states the engine could never
 * actually produce. Every state on this dashboard was reached by the same code
 * path a real citizen's would be, which means the demo is also an end-to-end
 * test of the whole system.
 *
 * Run with: npm run seed:demo  (after npm run seed)
 */

import "dotenv/config";

import { extractProfile } from "../lib/agents/profileAgent";
import {
  govApproveApplication,
  govRejectApplication,
  govReleasePayment,
  govReturnForDocument,
  govStallApplication,
} from "../lib/adapters/mockGovControl";
import { fixedClock, type Clock } from "../lib/clock";
import { prisma } from "../lib/db";
import { formatINR, paise, rupees } from "../lib/engine/money";
import { auditBenefit } from "../lib/services/audit";
import {
  decideApplicationApproval,
  prepareApplication,
  requestApplicationApproval,
  submitApplication,
} from "../lib/services/application";
import { discoverAndPersist } from "../lib/services/discovery";
import { loadProfile, saveProfileFields } from "../lib/services/profile";
import { confirmReceipt } from "../lib/services/receipt";

/**
 * The demo's "today". Fixed so the dashboard looks identical on every run and
 * the narrated figures in the demo script stay correct.
 */
const TODAY = new Date("2026-06-15T10:00:00.000Z");
const clockAt = (iso: string): Clock => fixedClock(new Date(iso));
const NOW = fixedClock(TODAY);

interface Persona {
  name: string;
  nameHi?: string;
  aadhaarLast4: string;
  bankAccountLast4: string;
  locale: string;
  intake: string;
  /** Identity values a citizen types at the approval screen. */
  identity: Record<string, unknown>;
}

const KAMALA: Persona = {
  name: "Kamala Devi",
  nameHi: "कमला देवी",
  aadhaarLast4: "4417",
  bankAccountLast4: "8821",
  locale: "en",
  intake: `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`,
  identity: {
    aadhaarNumber: "999988884417",
    fullName: "Kamala Devi",
    dateOfBirth: "1959-04-12",
    district: "Gaya",
    bplCardNumber: "BR-PHH-00241",
    rationCardNumber: "BR-PHH-00241",
    rationCardType: "PHH",
    householdSize: 3,
    bankAccountNumber: "30124578821",
    ifscCode: "SBIN0001234",
    housingType: "KUCCHA",
    landHoldingHectares: 0.809,
  },
};

const RAMESH: Persona = {
  name: "Ramesh Kumar",
  nameHi: "रमेश कुमार",
  aadhaarLast4: "7732",
  bankAccountLast4: "4190",
  locale: "en",
  intake: `I am Ramesh Kumar, 34 years old. I work as a potter in a town in Bihar.
I have a bank account. I do not pay income tax and nobody in my family works for the government.`,
  identity: {
    aadhaarNumber: "999977327732",
    fullName: "Ramesh Kumar",
    dateOfBirth: "1992-02-20",
    district: "Patna",
    artisanTrade: "POTTER",
    bankAccountNumber: "30199884190",
    ifscCode: "PUNB0123456",
  },
};

const SUNITA: Persona = {
  name: "Sunita Devi",
  nameHi: "सुनीता देवी",
  aadhaarLast4: "5508",
  bankAccountLast4: "7715",
  locale: "hi",
  intake: `My name is Sunita Devi and I am 28 years old. I live in a village in Bihar.
I am pregnant with my first child. I have a bank account and a BPL ration card.`,
  identity: {
    aadhaarNumber: "999955085508",
    fullName: "Sunita Devi",
    dateOfBirth: "1998-07-03",
    district: "Nalanda",
    lmpDate: "2026-02-01",
    mcpCardNumber: "MCP-BR-55081",
    bankAccountNumber: "30155087715",
    ifscCode: "SBIN0001234",
  },
};

/** Create a citizen, extract their profile, and run discovery. */
async function createPersona(persona: Persona): Promise<string> {
  const citizen = await prisma.citizen.create({
    data: {
      name: persona.name,
      nameHi: persona.nameHi,
      aadhaarLast4: persona.aadhaarLast4,
      bankAccountLast4: persona.bankAccountLast4,
      locale: persona.locale,
      isDemo: true,
    },
  });

  const extraction = await extractProfile({ intake: persona.intake });
  await saveProfileFields(citizen.id, extraction.accepted, {
    rawIntake: persona.intake,
  });

  // A few facts the conversation did not establish, recorded as the citizen's
  // own answers - exactly as the app would after asking them.
  const answers = persona.identity;
  const declared: Array<[string, unknown]> = [];
  if (typeof answers.rationCardType === "string") {
    declared.push(["rationCardType", answers.rationCardType]);
  }
  if (typeof answers.householdSize === "number") {
    declared.push(["householdSize", answers.householdSize]);
  }
  if (typeof answers.housingType === "string") {
    declared.push(["housingType", answers.housingType]);
  }

  await saveProfileFields(
    citizen.id,
    declared.map(([key, value]) => ({
      key: key as never,
      value: value as never,
      provenance: "SELF_DECLARED" as const,
      note: "Answered directly by the citizen.",
    })),
  );

  await discoverAndPersist({
    citizenId: citizen.id,
    profile: await loadProfile(citizen.id),
  });

  return citizen.id;
}

async function entitlementIdFor(
  citizenId: string,
  schemeCode: string,
): Promise<string> {
  const row = await prisma.entitlement.findFirstOrThrow({
    where: { citizenId, scheme: { code: schemeCode } },
    select: { id: true },
  });
  return row.id;
}

/** Take a benefit all the way to lodged at the portal. */
async function lodge(
  citizenId: string,
  schemeCode: string,
  identity: Record<string, unknown>,
  clock: Clock,
): Promise<{ entitlementId: string; applicationRef: string } | null> {
  const entitlementId = await entitlementIdFor(citizenId, schemeCode);

  const entitlement = await prisma.entitlement.findUniqueOrThrow({
    where: { id: entitlementId },
    select: { verdict: true },
  });
  if (entitlement.verdict === "RED") return null;

  const prepared = await prepareApplication({
    citizenId,
    entitlementId,
    providedFields: identity,
  });

  if (!prepared.readyForApproval) {
    console.log(
      `    ! ${schemeCode}: left as a draft, missing ${prepared.missingFields.join(", ")}`,
    );
    return null;
  }

  const { approvalId } = await requestApplicationApproval({
    citizenId,
    applicationId: prepared.applicationId,
  });
  await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED" });

  const outcome = await submitApplication({
    citizenId,
    applicationId: prepared.applicationId,
    clock,
  });

  if (!outcome.ok) {
    console.log(`    ! ${schemeCode}: submission failed (${outcome.reason})`);
    return null;
  }

  return { entitlementId, applicationRef: outcome.applicationRef };
}

/**
 * Kamala Devi: one dashboard carrying six distinct lifecycle states.
 *
 * Every one of them is produced by the engine, not asserted.
 */
async function buildKamala(): Promise<void> {
  console.log("\nKamala Devi, 67, rural Bihar");
  const citizenId = await createPersona(KAMALA);

  // --- Scenario 1: healthy. PM-KISAN, received and verified. --------------
  const kisan = await lodge(citizenId, "PM-KISAN", KAMALA.identity, clockAt("2026-01-20T10:00:00Z"));
  if (kisan) {
    await govApproveApplication({
      applicationRef: kisan.applicationRef,
      clock: clockAt("2026-02-05T10:00:00Z"),
    });
    await govReleasePayment({
      applicationRef: kisan.applicationRef,
      schemeCode: "PM-KISAN",
      aadhaarLast4: KAMALA.aadhaarLast4,
      periodLabel: "2026-T1",
      amountPaise: rupees(2000),
      bankAccountLast4: KAMALA.bankAccountLast4,
      clock: clockAt("2026-04-10T10:00:00Z"),
    });
    await auditBenefit({ citizenId, entitlementId: kisan.entitlementId, clock: NOW });

    const payment = await prisma.payment.findFirstOrThrow({
      where: { entitlementId: kisan.entitlementId, periodLabel: "2026-T1" },
    });
    // Confirmed by the citizen AND matched against bank evidence.
    await prisma.receiptVerification.create({
      data: {
        paymentId: payment.id,
        citizenReport: "YES",
        evidenceResult: "MATCHED",
        method: "BANK_EVIDENCE",
        expectedAmountPaise: rupees(2000),
        matchedAmountPaise: rupees(2000),
        matchedOn: new Date("2026-04-11T00:00:00Z"),
        refLast4: "8821",
        docSha256: "demo-evidence-hash-pmkisan",
        resultState: "VERIFIED_RECEIVED",
        note: "Matched against a bank statement the citizen supplied. Statement not retained.",
        verifiedAt: new Date("2026-04-12T10:00:00Z"),
      },
    });
    await auditBenefit({ citizenId, entitlementId: kisan.entitlementId, clock: NOW });
    console.log("  PM-KISAN        healthy, receipt verified against bank evidence");
  }

  // --- Scenarios 2, 3 and 7: IGNOAPS across four months ------------------
  // One benefit showing three different receipt states plus a missing month,
  // which demonstrates per-period reconciliation better than spreading it
  // across schemes.
  const pension = await lodge(
    citizenId,
    "NSAP-IGNOAPS",
    KAMALA.identity,
    clockAt("2026-01-12T10:00:00Z"),
  );
  if (pension) {
    await govApproveApplication({
      applicationRef: pension.applicationRef,
      clock: clockAt("2026-02-08T10:00:00Z"),
    });

    for (const [period, day] of [
      ["2026-02", "2026-02-10"],
      // 2026-03 is deliberately never released: the continuity gap.
      ["2026-04", "2026-04-10"],
      ["2026-05", "2026-05-10"],
    ] as const) {
      await govReleasePayment({
        applicationRef: pension.applicationRef,
        schemeCode: "NSAP-IGNOAPS",
        aadhaarLast4: KAMALA.aadhaarLast4,
        periodLabel: period,
        amountPaise: rupees(200),
        bankAccountLast4: KAMALA.bankAccountLast4,
        clock: NOW,
        releasedOn: new Date(`${day}T10:00:00Z`),
      });
    }

    await auditBenefit({ citizenId, entitlementId: pension.entitlementId, clock: NOW });

    // February: confirmed by the citizen.
    const feb = await prisma.payment.findFirst({
      where: { entitlementId: pension.entitlementId, periodLabel: "2026-02" },
    });
    if (feb) {
      await confirmReceipt({
        citizenId,
        paymentId: feb.id,
        answer: "YES",
        clock: clockAt("2026-02-20T10:00:00Z"),
      });
    }

    // April: left unanswered on purpose. This is the "did you receive it?"
    // card waiting on the dashboard.

    // May: the citizen says it never arrived - the hero discrepancy.
    const may = await prisma.payment.findFirst({
      where: { entitlementId: pension.entitlementId, periodLabel: "2026-05" },
    });
    if (may) {
      await confirmReceipt({
        citizenId,
        paymentId: may.id,
        answer: "NO",
        clock: clockAt("2026-06-01T10:00:00Z"),
        note: "I checked at the bank and nothing came.",
      });
      // The bank's own explanation, which the diagnosis will cite.
      await prisma.govStatusEvent.create({
        data: {
          applicationRef: pension.applicationRef,
          schemeCode: "NSAP-IGNOAPS",
          status: "DISBURSEMENT_RETURNED",
          note: "Credit returned by the bank: Aadhaar is not seeded to the beneficiary account, so the transfer could not be completed.",
          occurredOn: new Date("2026-05-14T10:00:00Z"),
        },
      });
    }

    await auditBenefit({ citizenId, entitlementId: pension.entitlementId, clock: NOW });
    console.log(
      "  NSAP-IGNOAPS    Feb confirmed, Mar missing, Apr unanswered, May discrepancy",
    );
  }

  // --- Scenario 4: rejected for a missing document ------------------------
  const housing = await lodge(citizenId, "PMAY-G", KAMALA.identity, clockAt("2026-03-02T10:00:00Z"));
  if (housing) {
    await govReturnForDocument({
      applicationRef: housing.applicationRef,
      documentKind: "INCOME_CERTIFICATE",
      clock: clockAt("2026-03-25T10:00:00Z"),
    });
    await govRejectApplication({
      applicationRef: housing.applicationRef,
      reason:
        "Income certificate was not attached within the time allowed, so the application was closed.",
      clock: clockAt("2026-05-02T10:00:00Z"),
    });
    await auditBenefit({ citizenId, entitlementId: housing.entitlementId, clock: NOW });
    console.log("  PMAY-G          rejected, income certificate missing");
  }

  // --- Scenario 5: stalled with the department ----------------------------
  const health = await lodge(citizenId, "PM-JAY", KAMALA.identity, clockAt("2026-03-13T10:00:00Z"));
  if (health) {
    await govStallApplication({
      applicationRef: health.applicationRef,
      daysPending: 94,
      clock: NOW,
    });
    await auditBenefit({ citizenId, entitlementId: health.entitlementId, clock: NOW });
    console.log("  PM-JAY          pending 94 days with no decision");
  }

  // --- Scenario 6: eligible, never claimed --------------------------------
  // IGNWPS is left entirely alone. She qualifies as a widow aged 40 to 79 and
  // has never applied, which the audit reports as NEVER_APPLIED.
  const widow = await entitlementIdFor(citizenId, "NSAP-IGNWPS");
  await auditBenefit({ citizenId, entitlementId: widow, clock: NOW });
  console.log("  NSAP-IGNWPS     eligible, never applied (unclaimed)");

  // --- In-kind, and a correct exclusion -----------------------------------
  const ration = await lodge(citizenId, "NFSA-PHH", KAMALA.identity, clockAt("2026-02-01T10:00:00Z"));
  if (ration) {
    await govApproveApplication({
      applicationRef: ration.applicationRef,
      clock: clockAt("2026-02-20T10:00:00Z"),
    });
    await auditBenefit({ citizenId, entitlementId: ration.entitlementId, clock: NOW });
    console.log("  NFSA-PHH        approved, in-kind (no rupee value asserted)");
  }

  const maternity = await entitlementIdFor(citizenId, "PMMVY");
  await auditBenefit({ citizenId, entitlementId: maternity, clock: NOW });
  console.log("  PMMVY           correctly excluded on age (she is 67)");
}

/** Ramesh Kumar: an artisan, and a portal submission failure. */
async function buildRamesh(): Promise<void> {
  console.log("\nRamesh Kumar, 34, urban Bihar");
  const citizenId = await createPersona(RAMESH);

  // Needs an explicit artisan answer, which the intake implies but does not
  // state in the structured terms the rules require.
  await saveProfileFields(citizenId, [
    {
      key: "isArtisan",
      value: true,
      provenance: "SELF_DECLARED",
      note: "Described working as a potter.",
    },
    {
      key: "artisanTrade",
      value: "POTTER",
      provenance: "SELF_DECLARED",
      note: "Described working as a potter.",
    },
    {
      key: "hasBankAccount",
      value: true,
      provenance: "SELF_DECLARED",
      note: "Said he has a bank account.",
    },
  ]);
  await discoverAndPersist({
    citizenId,
    profile: await loadProfile(citizenId),
  });

  const trade = await lodge(
    citizenId,
    "PM-VISHWAKARMA",
    RAMESH.identity,
    clockAt("2026-04-05T10:00:00Z"),
  );
  if (trade) {
    await govApproveApplication({
      applicationRef: trade.applicationRef,
      clock: clockAt("2026-05-01T10:00:00Z"),
    });
    await govReleasePayment({
      applicationRef: trade.applicationRef,
      schemeCode: "PM-VISHWAKARMA",
      aadhaarLast4: RAMESH.aadhaarLast4,
      periodLabel: "ONCE",
      amountPaise: rupees(15000),
      bankAccountLast4: RAMESH.bankAccountLast4,
      clock: clockAt("2026-05-20T10:00:00Z"),
    });
    await auditBenefit({ citizenId, entitlementId: trade.entitlementId, clock: NOW });

    // A partial payment: the toolkit grant arrived short.
    const payment = await prisma.payment.findFirst({
      where: { entitlementId: trade.entitlementId },
    });
    if (payment) {
      await prisma.receiptVerification.create({
        data: {
          paymentId: payment.id,
          citizenReport: "YES",
          evidenceResult: "PARTIAL_MATCH",
          method: "BANK_EVIDENCE",
          expectedAmountPaise: rupees(15000),
          matchedAmountPaise: rupees(12000),
          matchedOn: new Date("2026-05-21T00:00:00Z"),
          refLast4: "4190",
          docSha256: "demo-evidence-hash-vishwakarma",
          resultState: "PAYMENT_DISCREPANCY",
          note: "Bank evidence showed a short credit. Statement not retained.",
          verifiedAt: new Date("2026-05-25T10:00:00Z"),
        },
      });
      await auditBenefit({ citizenId, entitlementId: trade.entitlementId, clock: NOW });
      console.log(
        `  PM-VISHWAKARMA  short payment: ${formatINR(rupees(12000))} of ${formatINR(rupees(15000))}`,
      );
    }
  }
}

/** Sunita Devi: the maternity benefit Kamala is correctly excluded from. */
async function buildSunita(): Promise<void> {
  console.log("\nSunita Devi, 28, rural Bihar");
  const citizenId = await createPersona(SUNITA);

  await saveProfileFields(citizenId, [
    {
      key: "isPregnantOrLactating",
      value: true,
      provenance: "SELF_DECLARED",
      note: "Said she is pregnant.",
    },
    {
      key: "isFirstLivingChild",
      value: true,
      provenance: "SELF_DECLARED",
      note: "Said this is her first child.",
    },
    {
      key: "gender",
      value: "female",
      provenance: "INFERRED",
      note: "Deduced from stating she is pregnant.",
    },
    {
      key: "hasBankAccount",
      value: true,
      provenance: "SELF_DECLARED",
      note: "Said she has a bank account.",
    },
    {
      key: "hasBplCard",
      value: true,
      provenance: "SELF_DECLARED",
      note: "Said she has a BPL ration card.",
    },
  ]);
  await discoverAndPersist({
    citizenId,
    profile: await loadProfile(citizenId),
  });

  const maternity = await lodge(
    citizenId,
    "PMMVY",
    SUNITA.identity,
    clockAt("2026-04-18T10:00:00Z"),
  );
  if (maternity) {
    await govApproveApplication({
      applicationRef: maternity.applicationRef,
      clock: clockAt("2026-05-06T10:00:00Z"),
    });
    await govReleasePayment({
      applicationRef: maternity.applicationRef,
      schemeCode: "PMMVY",
      aadhaarLast4: SUNITA.aadhaarLast4,
      periodLabel: "ONCE",
      amountPaise: rupees(1000),
      bankAccountLast4: SUNITA.bankAccountLast4,
      clock: clockAt("2026-05-28T10:00:00Z"),
    });
    await auditBenefit({ citizenId, entitlementId: maternity.entitlementId, clock: NOW });
    console.log("  PMMVY           first instalment released, receipt unconfirmed");
  }
}

async function registerPersonas(): Promise<void> {
  const citizens = await prisma.citizen.findMany({
    where: { isDemo: true },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true },
  });

  const descriptions: Record<string, string> = {
    "Kamala Devi":
      "67, widow, rural Bihar. Six benefit states at once, including a payment the government says it sent.",
    "Ramesh Kumar": "34, potter, urban Bihar. A toolkit grant that arrived short.",
    "Sunita Devi": "28, expecting her first child, rural Bihar.",
  };

  for (const [index, citizen] of citizens.entries()) {
    await prisma.demoPersona.upsert({
      where: { code: citizen.name.toLowerCase().replace(/\s+/g, "-") },
      create: {
        code: citizen.name.toLowerCase().replace(/\s+/g, "-"),
        label: citizen.name,
        description: descriptions[citizen.name] ?? "",
        citizenId: citizen.id,
        position: index,
      },
      update: { citizenId: citizen.id, position: index },
    });
  }
}

async function summarise(): Promise<void> {
  const ledgers = await prisma.benefitLedger.findMany();
  const totals = ledgers.reduce(
    (acc, l) => ({
      received: acc.received + l.receivedAmountPaise,
      unverified: acc.unverified + l.unverifiedAmountPaise,
      missing: acc.missing + l.gapAmountPaise,
    }),
    { received: 0n, unverified: 0n, missing: 0n },
  );

  const gaps = await prisma.benefitGap.count({ where: { resolvedAt: null } });

  console.log(`
Demo data ready. Simulated today: ${TODAY.toISOString().slice(0, 10)}

  Received (confirmed or proven)   ${formatINR(paise(totals.received))}
  Unverified (released, unconfirmed) ${formatINR(paise(totals.unverified))}
  Proven missing (with evidence)   ${formatINR(paise(totals.missing))}
  Open problems                    ${gaps}

Those three money figures are deliberately separate. Unverified is NOT missing.

Every state above was produced by running the real pipeline, not by inserting
rows, so this seed doubles as an end-to-end check of the whole system.`);
}

async function main(): Promise<void> {
  const schemes = await prisma.scheme.count();
  if (schemes === 0) {
    console.error("The scheme registry is empty. Run `npm run seed` first.");
    process.exitCode = 1;
    return;
  }

  console.log("Clearing existing demo citizens...");
  await prisma.auditLog.deleteMany({});
  await prisma.citizen.deleteMany({ where: { isDemo: true } });
  await prisma.govDisbursement.deleteMany({});
  await prisma.govStatusEvent.deleteMany({});
  await prisma.govApplication.deleteMany({});

  await buildKamala();
  await buildRamesh();
  await buildSunita();
  await registerPersonas();
  await summarise();
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
