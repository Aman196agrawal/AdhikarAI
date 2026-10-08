/**
 * Scenario: profile intake through to persisted entitlements.
 *
 * Covers design scenario 6 (an eligible citizen who has never applied) and the
 * Priority 1 gate: a citizen describes their circumstances in plain language,
 * and the system produces ranked, explainable, persisted entitlements.
 *
 * Runs against a real database and the deterministic stub provider.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractProfile } from "@/lib/agents/profileAgent";
import { prisma } from "@/lib/db";
import { formatINR, deserialize } from "@/lib/engine/money";
import {
  discoverAndPersist,
  evaluateEntitlements,
  toWire,
} from "@/lib/services/discovery";
import { loadProfile, saveProfileFields } from "@/lib/services/profile";
import {
  createCitizen,
  disconnect,
  ensureRegistry,
  resetCitizenData,
} from "../helpers/db";

const KAMALA_INTAKE = `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`;

let citizenId: string;

beforeAll(async () => {
  await ensureRegistry();
});

beforeEach(async () => {
  await resetCitizenData();
  const citizen = await createCitizen();
  citizenId = citizen.id;
});

afterAll(async () => {
  await disconnect();
});

describe("intake to persisted profile", () => {
  it("stores each extracted field with its provenance", async () => {
    const extraction = await extractProfile({ intake: KAMALA_INTAKE });
    const result = await saveProfileFields(citizenId, extraction.accepted, {
      rawIntake: KAMALA_INTAKE,
    });

    expect(result.written).toBeGreaterThan(5);

    const stored = await loadProfile(citizenId);
    expect(stored.age?.value).toBe(67);
    expect(stored.age?.provenance).toBe("SELF_DECLARED");
    expect(stored.maritalStatus?.provenance).toBe("INFERRED");
  });

  it("round-trips through the database without losing types", async () => {
    const extraction = await extractProfile({ intake: KAMALA_INTAKE });
    await saveProfileFields(citizenId, extraction.accepted);

    const stored = await loadProfile(citizenId);
    // JSON storage must not turn a number into a string or a boolean into 1.
    expect(typeof stored.age?.value).toBe("number");
    expect(typeof stored.isWidow?.value).toBe("boolean");
    expect(typeof stored.state?.value).toBe("string");
    expect(stored.landHoldingHectares?.value).toBeCloseTo(0.809, 3);
  });

  it("does not let a weaker source overwrite documentary evidence", async () => {
    // A value read off an Aadhaar card must not be downgraded by the same
    // value merely mentioned in conversation: that would silently weaken the
    // confidence score behind a benefit decision.
    await saveProfileFields(citizenId, [
      {
        key: "age",
        value: 67,
        provenance: "DOCUMENT_VERIFIED",
        note: "Read from Aadhaar card.",
      },
    ]);

    const result = await saveProfileFields(citizenId, [
      {
        key: "age",
        value: 67,
        provenance: "SELF_DECLARED",
        note: "Mentioned in conversation.",
      },
    ]);

    expect(result.skipped.map((s) => s.key)).toContain("age");
    const stored = await loadProfile(citizenId);
    expect(stored.age?.provenance).toBe("DOCUMENT_VERIFIED");
  });
});

describe("discovery persists ranked, explainable entitlements", () => {
  beforeEach(async () => {
    const extraction = await extractProfile({ intake: KAMALA_INTAKE });
    await saveProfileFields(citizenId, extraction.accepted, {
      rawIntake: KAMALA_INTAKE,
    });
  });

  it("creates one entitlement per applicable scheme", async () => {
    const profile = await loadProfile(citizenId);
    const result = await discoverAndPersist({ citizenId, profile });

    expect(result.created).toBe(10);
    expect(await prisma.entitlement.count({ where: { citizenId } })).toBe(10);
  });

  it("ranks eligible benefits first and excluded ones last", async () => {
    const profile = await loadProfile(citizenId);
    const { entitlements } = await discoverAndPersist({ citizenId, profile });

    const verdicts = entitlements.map((e) => e.verdict);
    const firstRed = verdicts.indexOf("RED");
    const lastGreen = verdicts.lastIndexOf("GREEN");
    expect(lastGreen).toBeLessThan(firstRed === -1 ? verdicts.length : firstRed);
  });

  it("identifies the unclaimed widow pension she qualifies for", async () => {
    const profile = await loadProfile(citizenId);
    const { entitlements } = await discoverAndPersist({ citizenId, profile });

    const ignwps = entitlements.find((e) => e.schemeCode === "NSAP-IGNWPS");
    expect(ignwps?.verdict).toBe("GREEN");
    expect(formatINR(ignwps!.expectedAmountPaise!)).toBe("₹300");
    expect(formatINR(ignwps!.annualValuePaise!)).toBe("₹3,600");
  });

  it("excludes the maternity benefit on age, with a citable clause", async () => {
    const profile = await loadProfile(citizenId);
    const { entitlements } = await discoverAndPersist({ citizenId, profile });

    const pmmvy = entitlements.find((e) => e.schemeCode === "PMMVY");
    expect(pmmvy?.verdict).toBe("RED");
    expect(pmmvy?.blockingClauses).toContain("AGE_UNDER_55");

    const clause = pmmvy?.evaluation.clauses.find(
      (c) => c.clauseCode === "AGE_UNDER_55",
    );
    expect(clause?.sourceUrl).toMatch(/^https:\/\//);
    expect(clause?.observedValue).toBe(67);
  });

  it("stores the full clause evaluation for the Why? drawer", async () => {
    const profile = await loadProfile(citizenId);
    await discoverAndPersist({ citizenId, profile });

    const entitlement = await prisma.entitlement.findFirstOrThrow({
      where: { citizenId, scheme: { code: "NSAP-IGNOAPS" } },
    });

    const stored = entitlement.clauseResults as {
      verdict: string;
      clauses: Array<{ code: string; text: string; sourceUrl: string }>;
    };
    expect(stored.verdict).toBe("GREEN");
    expect(stored.clauses.length).toBeGreaterThan(2);
    // Explanations must not depend on re-joining the registry, so a decision
    // stays readable after a scheme's rules change.
    for (const clause of stored.clauses) {
      expect(clause.text.length).toBeGreaterThan(10);
      expect(clause.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it("sets the opening lifecycle state from the verdict", async () => {
    const profile = await loadProfile(citizenId);
    await discoverAndPersist({ citizenId, profile });

    const rows = await prisma.entitlement.findMany({
      where: { citizenId },
      select: { verdict: true, lifecycleState: true },
    });

    for (const row of rows) {
      if (row.verdict === "GREEN") expect(row.lifecycleState).toBe("ELIGIBLE");
      if (row.verdict === "YELLOW") {
        expect(row.lifecycleState).toBe("POTENTIAL_ENTITLEMENT");
      }
      if (row.verdict === "RED") expect(row.lifecycleState).toBe("DISCOVERED");
    }
  });

  it("stores no payment schedule for a benefit nobody has applied for", async () => {
    // Materialising due dates here would make the continuity audit report
    // missed payments for money that was never owed.
    const profile = await loadProfile(citizenId);
    await discoverAndPersist({ citizenId, profile });

    expect(await prisma.expectedPayment.count()).toBe(0);
  });
});

describe("re-running discovery", () => {
  beforeEach(async () => {
    const extraction = await extractProfile({ intake: KAMALA_INTAKE });
    await saveProfileFields(citizenId, extraction.accepted);
  });

  it("updates in place rather than duplicating", async () => {
    const profile = await loadProfile(citizenId);
    await discoverAndPersist({ citizenId, profile });
    const second = await discoverAndPersist({ citizenId, profile });

    expect(second.created).toBe(0);
    expect(second.updated).toBe(10);
    expect(await prisma.entitlement.count({ where: { citizenId } })).toBe(10);
  });

  it("upgrades a YELLOW verdict to GREEN when the missing answer arrives", async () => {
    const before = await loadProfile(citizenId);
    const first = await discoverAndPersist({ citizenId, profile: before });

    const pmkisan = first.entitlements.find((e) => e.schemeCode === "PM-KISAN");
    expect(pmkisan?.verdict).toBe("YELLOW");
    expect(pmkisan?.missingEvidence.length).toBeGreaterThan(0);

    // The citizen confirms the Aadhaar seeding that was unknown.
    await saveProfileFields(citizenId, [
      {
        key: "isAadhaarLinkedToBank",
        value: true,
        provenance: "SELF_DECLARED",
        note: "Confirmed by the citizen.",
      },
    ]);

    const after = await loadProfile(citizenId);
    const second = await discoverAndPersist({ citizenId, profile: after });
    const updated = second.entitlements.find((e) => e.schemeCode === "PM-KISAN");

    expect(updated?.verdict).toBe("GREEN");
    expect(updated?.missingEvidence).toEqual([]);
  });

  it("records a verdict change in the audit trail", async () => {
    const before = await loadProfile(citizenId);
    await discoverAndPersist({ citizenId, profile: before });

    await saveProfileFields(citizenId, [
      {
        key: "isAadhaarLinkedToBank",
        value: true,
        provenance: "SELF_DECLARED",
        note: "Confirmed by the citizen.",
      },
    ]);
    const after = await loadProfile(citizenId);
    await discoverAndPersist({ citizenId, profile: after });

    const logs = await prisma.auditLog.findMany({
      where: { citizenId, entity: "Entitlement" },
    });
    const change = logs.find(
      (l) => l.fromState === "YELLOW" && l.toState === "GREEN",
    );
    expect(change).toBeDefined();
    expect(change?.actor).toBe("agent:discovery");
  });

  it("does not drag an advanced benefit back to ELIGIBLE", async () => {
    // A benefit that is already submitted, or being recovered, must not be
    // reset because discovery ran again.
    const profile = await loadProfile(citizenId);
    await discoverAndPersist({ citizenId, profile });

    const entitlement = await prisma.entitlement.findFirstOrThrow({
      where: { citizenId, scheme: { code: "NSAP-IGNOAPS" } },
    });
    await prisma.entitlement.update({
      where: { id: entitlement.id },
      data: { lifecycleState: "SUBMITTED" },
    });

    await discoverAndPersist({ citizenId, profile });

    const after = await prisma.entitlement.findUniqueOrThrow({
      where: { id: entitlement.id },
      select: { lifecycleState: true },
    });
    expect(after.lifecycleState).toBe("SUBMITTED");
  });
});

describe("the wire format", () => {
  it("serialises paise as strings and keeps null meaning not-a-cash-amount", async () => {
    const extraction = await extractProfile({ intake: KAMALA_INTAKE });
    await saveProfileFields(citizenId, extraction.accepted);
    const profile = await loadProfile(citizenId);

    const entitlements = evaluateEntitlements(profile);
    const wire = entitlements.map(toWire);

    // JSON.stringify would throw on a BigInt, so this also proves the
    // response is actually serialisable.
    expect(() => JSON.stringify(wire)).not.toThrow();

    const ignwps = wire.find((e) => e.schemeCode === "NSAP-IGNWPS");
    expect(ignwps?.expectedAmountPaise).toBe("30000");
    expect(deserialize(ignwps!.expectedAmountPaise!)).toBe(30000n);

    // NFSA foodgrain has no rupee value; null must survive, not become "0".
    const nfsa = wire.find((e) => e.schemeCode === "NFSA-PHH");
    expect(nfsa?.expectedAmountPaise).toBeNull();
    expect(nfsa?.annualValuePaise).toBeNull();
    expect(nfsa?.benefitNote).toMatch(/IN-KIND/i);
  });
});
