/**
 * Scenario: the Priority 1 API surface, end to end.
 *
 * Calls the route handlers directly rather than through a running server.
 * That exercises the real request parsing, authorization, services and
 * database, while staying fast enough to run on every change.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as getCitizens } from "@/app/api/citizens/route";
import {
  GET as getEntitlements,
} from "@/app/api/entitlements/route";
import { POST as discover } from "@/app/api/entitlements/discover/route";
import { GET as getProfile, POST as postProfile } from "@/app/api/profile/route";
import { deserialize, formatINR } from "@/lib/engine/money";
import {
  createCitizen,
  disconnect,
  ensureRegistry,
  resetCitizenData,
} from "../helpers/db";

const KAMALA_INTAKE = `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`;

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function json(response: Response): Promise<any> {
  return (await response.json()) as any;
}

let citizenId: string;

beforeAll(async () => {
  // The persona list stands in for a login, so these routes need demo mode.
  process.env.DEMO_MODE = "true";
  await ensureRegistry();
});

beforeEach(async () => {
  await resetCitizenData();
  citizenId = (await createCitizen()).id;
});

afterAll(async () => {
  process.env.DEMO_MODE = "false";
  await disconnect();
});

describe("GET /api/citizens", () => {
  it("lists the demo personas", async () => {
    const body = await json(await getCitizens(new Request("http://t/api/citizens")));
    expect(body.ok).toBe(true);
    expect(body.data.demoMode).toBe(true);
    expect(body.data.citizens).toHaveLength(1);
    expect(body.data.citizens[0].name).toBe("Kamala Devi");
  });

  it("hides demo personas when demo mode is off", async () => {
    process.env.DEMO_MODE = "false";
    const body = await json(await getCitizens(new Request("http://t/api/citizens")));
    expect(body.data.citizens).toHaveLength(0);
    process.env.DEMO_MODE = "true";
  });
});

describe("POST /api/profile", () => {
  it("extracts from intake and reports what is still needed", async () => {
    const body = await json(
      await postProfile(
        post("http://t/api/profile", { citizenId, intake: KAMALA_INTAKE }),
      ),
    );

    expect(body.ok).toBe(true);
    expect(body.data.acceptedCount).toBeGreaterThan(5);

    const age = body.data.profile.find((f: any) => f.key === "age");
    expect(age.value).toBe(67);
    expect(age.label).toBe("Age");

    // Questions come from what mandatory clauses need, not from the model.
    expect(body.data.questions.length).toBeGreaterThan(0);
    expect(body.data.questions[0]).toHaveProperty("blocks");
  });

  it("records a direct answer as the citizen's own and lets it win", async () => {
    await postProfile(
      post("http://t/api/profile", { citizenId, intake: KAMALA_INTAKE }),
    );

    const body = await json(
      await postProfile(
        post("http://t/api/profile", {
          citizenId,
          answers: [{ key: "isAadhaarLinkedToBank", value: true }],
        }),
      ),
    );

    const field = body.data.profile.find(
      (f: any) => f.key === "isAadhaarLinkedToBank",
    );
    expect(field.value).toBe(true);
    expect(field.provenance).toBe("SELF_DECLARED");
  });

  it("reports a rejected attribute instead of silently dropping it", async () => {
    const body = await json(
      await postProfile(
        post("http://t/api/profile", {
          citizenId,
          answers: [{ key: "notAField", value: 1 }],
        }),
      ),
    );
    expect(body.data.rejected).toEqual([
      { key: "notAField", reason: "not a recognised attribute" },
    ]);
  });

  it("refuses a request with neither intake nor answers", async () => {
    const response = await postProfile(post("http://t/api/profile", { citizenId }));
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error.code).toBe("BAD_REQUEST");
  });

  it("refuses an unknown citizen", async () => {
    const response = await postProfile(
      post("http://t/api/profile", { citizenId: "nope", intake: "hello" }),
    );
    expect(response.status).toBe(404);
  });

  it("refuses a malformed body without leaking internals", async () => {
    const response = await postProfile(
      new Request("http://t/api/profile", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );
    expect(response.status).toBe(400);
    const body = await json(response);
    expect(body.error.message).toMatch(/valid JSON/i);
    expect(JSON.stringify(body)).not.toMatch(/prisma|at Object|node_modules/i);
  });
});

describe("GET /api/profile", () => {
  it("reads the stored profile back", async () => {
    await postProfile(
      post("http://t/api/profile", { citizenId, intake: KAMALA_INTAKE }),
    );

    const body = await json(
      await getProfile(new Request(`http://t/api/profile?citizenId=${citizenId}`)),
    );
    expect(body.data.name).toBe("Kamala Devi");
    expect(body.data.profile.length).toBeGreaterThan(5);
  });

  it("requires a citizen id", async () => {
    const response = await getProfile(new Request("http://t/api/profile"));
    expect(response.status).toBe(400);
  });
});

describe("POST /api/entitlements/discover", () => {
  beforeEach(async () => {
    await postProfile(
      post("http://t/api/profile", { citizenId, intake: KAMALA_INTAKE }),
    );
  });

  it("returns ranked entitlements with counts", async () => {
    const body = await json(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );

    expect(body.ok).toBe(true);
    expect(body.data.created).toBe(10);
    expect(body.data.entitlements).toHaveLength(10);
    expect(body.data.counts.eligible).toBeGreaterThan(0);
    expect(body.data.counts.excluded).toBeGreaterThan(0);
  });

  it("serialises paise as strings so the response is valid JSON", async () => {
    const response = await discover(
      post("http://t/api/entitlements/discover", { citizenId }),
    );
    // A BigInt would have thrown during serialisation inside the handler.
    const body = await json(response);

    const ignwps = body.data.entitlements.find(
      (e: any) => e.schemeCode === "NSAP-IGNWPS",
    );
    expect(typeof ignwps.expectedAmountPaise).toBe("string");
    expect(formatINR(deserialize(ignwps.expectedAmountPaise))).toBe("₹300");
  });

  it("keeps a null amount null for an in-kind benefit", async () => {
    const body = await json(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );
    const nfsa = body.data.entitlements.find(
      (e: any) => e.schemeCode === "NFSA-PHH",
    );
    // Not zero. Foodgrain has no rupee value, and rendering it as 0 would
    // understate every dashboard total as though it were a fact.
    expect(nfsa.expectedAmountPaise).toBeNull();
    expect(nfsa.annualValuePaise).toBeNull();
  });

  it("includes the citable clause behind an exclusion", async () => {
    const body = await json(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );
    const pmmvy = body.data.entitlements.find((e: any) => e.schemeCode === "PMMVY");

    expect(pmmvy.verdict).toBe("RED");
    const blocking = pmmvy.clauses.find((c: any) => c.code === "AGE_UNDER_55");
    expect(blocking.disqualifies).toBe(true);
    expect(blocking.sourceUrl).toMatch(/^https:\/\//);
    expect(blocking.text).toMatch(/55 years/);
  });

  it("reports source provenance so the UI can show how trustworthy it is", async () => {
    const body = await json(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );
    const ignoaps = body.data.entitlements.find(
      (e: any) => e.schemeCode === "NSAP-IGNOAPS",
    );
    expect(ignoaps.source.verificationStatus).toBe("SOURCE_CHECKED");
    expect(ignoaps.source.url).toBe("https://nsap.nic.in/");
  });

  it("carries pending declarations for approval gate 1", async () => {
    const body = await json(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );
    const pmkisan = body.data.entitlements.find(
      (e: any) => e.schemeCode === "PM-KISAN",
    );
    expect(pmkisan.pendingDeclarations).toContain("EXCL_INCOME_TAX_PAYER");
  });
});

describe("GET /api/entitlements", () => {
  beforeEach(async () => {
    await postProfile(
      post("http://t/api/profile", { citizenId, intake: KAMALA_INTAKE }),
    );
    await discover(post("http://t/api/entitlements/discover", { citizenId }));
  });

  it("reads persisted entitlements without re-evaluating", async () => {
    const body = await json(
      await getEntitlements(
        new Request(`http://t/api/entitlements?citizenId=${citizenId}`),
      ),
    );
    expect(body.data.entitlements).toHaveLength(10);

    const first = body.data.entitlements[0];
    expect(first.clauseResults).toBeTruthy();
    expect(first.lifecycleState).toBeTruthy();
  });

  it("can omit excluded schemes", async () => {
    const body = await json(
      await getEntitlements(
        new Request(
          `http://t/api/entitlements?citizenId=${citizenId}&includeExcluded=false`,
        ),
      ),
    );
    expect(body.data.entitlements.length).toBeLessThan(10);
    for (const entitlement of body.data.entitlements) {
      expect(entitlement.verdict).not.toBe("RED");
    }
  });

  it("scopes results to the requested citizen", async () => {
    // Authorization is demo-grade, but scoping is real: no handler reads "the
    // current citizen" from ambient state.
    const other = await createCitizen({ name: "Another Person" });
    const body = await json(
      await getEntitlements(
        new Request(`http://t/api/entitlements?citizenId=${other.id}`),
      ),
    );
    expect(body.data.entitlements).toEqual([]);
  });
});
