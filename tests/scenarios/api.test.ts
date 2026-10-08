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

/**
 * Shapes these tests read off the wire.
 *
 * Declared rather than reached for with `any`, so a response that changes
 * shape fails to compile here instead of quietly making an assertion
 * meaningless. They are partial on purpose: each one names only the fields a
 * test actually inspects.
 */
interface ProfileField {
  key: string;
  label: string;
  value: unknown;
  provenance: string;
}

interface WireClause {
  code: string;
  disqualifies: boolean;
  sourceUrl: string;
  text: string;
}

interface WireEntitlement {
  schemeCode: string;
  verdict: string;
  expectedAmountPaise: string | null;
  annualValuePaise: string | null;
  benefitNote: string | null;
  pendingDeclarations: string[];
  clauses: WireClause[];
  source: { verificationStatus: string; url: string };
  /** Present on the persisted read (GET /api/entitlements), not on discover. */
  clauseResults?: unknown;
  lifecycleState?: string;
}

type ApiBody<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

async function json<T>(response: Response): Promise<ApiBody<T>> {
  return (await response.json()) as ApiBody<T>;
}

/** Unwrap a successful response, failing loudly if it was an error. */
function data<T>(body: ApiBody<T>): T {
  if (!body.ok) {
    throw new Error(`Expected a successful response, got: ${body.error.message}`);
  }
  return body.data;
}

/** Unwrap an error response, failing loudly if it succeeded. */
function error<T>(body: ApiBody<T>): { code: string; message: string } {
  if (body.ok) throw new Error("Expected an error response, got a success.");
  return body.error;
}

/**
 * Assert something was found.
 *
 * `find` returns `T | undefined`, and a test that read fields off `undefined`
 * would fail with a confusing error or, worse, pass vacuously. Typing these
 * payloads surfaced every such site; the previous `any` hid them all.
 */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected to find ${what}.`);
  }
  return value;
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
    const body = await json<{
      demoMode: boolean;
      citizens: Array<{ name: string }>;
    }>(await getCitizens(new Request("http://t/api/citizens")));

    expect(body.ok).toBe(true);
    expect(data(body).demoMode).toBe(true);
    expect(data(body).citizens).toHaveLength(1);
    expect(data(body).citizens[0].name).toBe("Kamala Devi");
  });

  it("hides demo personas when demo mode is off", async () => {
    process.env.DEMO_MODE = "false";
    const body = await json<{ citizens: unknown[] }>(
      await getCitizens(new Request("http://t/api/citizens")),
    );
    expect(data(body).citizens).toHaveLength(0);
    process.env.DEMO_MODE = "true";
  });
});

describe("POST /api/profile", () => {
  it("extracts from intake and reports what is still needed", async () => {
    const body = await json<{ acceptedCount: number; profile: ProfileField[]; questions: Array<{ blocks: string[] }>; rejected: Array<{ key: string; reason: string }>; name?: string }>(
      await postProfile(
        post("http://t/api/profile", { citizenId, intake: KAMALA_INTAKE }),
      ),
    );

    expect(body.ok).toBe(true);
    expect(data(body).acceptedCount).toBeGreaterThan(5);

    const age = must(
      data(body).profile.find((f) => f.key === "age"),
      "the age field",
    );
    expect(age.value).toBe(67);
    expect(age.label).toBe("Age");

    // Questions come from what mandatory clauses need, not from the model.
    expect(data(body).questions.length).toBeGreaterThan(0);
    expect(data(body).questions[0]).toHaveProperty("blocks");
  });

  it("records a direct answer as the citizen's own and lets it win", async () => {
    await postProfile(
      post("http://t/api/profile", { citizenId, intake: KAMALA_INTAKE }),
    );

    const body = await json<{ acceptedCount: number; profile: ProfileField[]; questions: Array<{ blocks: string[] }>; rejected: Array<{ key: string; reason: string }>; name?: string }>(
      await postProfile(
        post("http://t/api/profile", {
          citizenId,
          answers: [{ key: "isAadhaarLinkedToBank", value: true }],
        }),
      ),
    );

    const field = must(
      data(body).profile.find((f) => f.key === "isAadhaarLinkedToBank"),
      "the Aadhaar seeding field",
    );
    expect(field.value).toBe(true);
    expect(field.provenance).toBe("SELF_DECLARED");
  });

  it("reports a rejected attribute instead of silently dropping it", async () => {
    const body = await json<{ acceptedCount: number; profile: ProfileField[]; questions: Array<{ blocks: string[] }>; rejected: Array<{ key: string; reason: string }>; name?: string }>(
      await postProfile(
        post("http://t/api/profile", {
          citizenId,
          answers: [{ key: "notAField", value: 1 }],
        }),
      ),
    );
    expect(data(body).rejected).toEqual([
      { key: "notAField", reason: "not a recognised attribute" },
    ]);
  });

  it("refuses a request with neither intake nor answers", async () => {
    const response = await postProfile(post("http://t/api/profile", { citizenId }));
    expect(response.status).toBe(400);
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(response);
    expect(error(body).code).toBe("BAD_REQUEST");
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
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(response);
    expect(error(body).message).toMatch(/valid JSON/i);
    expect(JSON.stringify(body)).not.toMatch(/prisma|at Object|node_modules/i);
  });
});

describe("GET /api/profile", () => {
  it("reads the stored profile back", async () => {
    await postProfile(
      post("http://t/api/profile", { citizenId, intake: KAMALA_INTAKE }),
    );

    const body = await json<{ acceptedCount: number; profile: ProfileField[]; questions: Array<{ blocks: string[] }>; rejected: Array<{ key: string; reason: string }>; name?: string }>(
      await getProfile(new Request(`http://t/api/profile?citizenId=${citizenId}`)),
    );
    expect(data(body).name).toBe("Kamala Devi");
    expect(data(body).profile.length).toBeGreaterThan(5);
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
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );

    expect(body.ok).toBe(true);
    expect(data(body).created).toBe(10);
    expect(data(body).entitlements).toHaveLength(10);
    expect(data(body).counts.eligible).toBeGreaterThan(0);
    expect(data(body).counts.excluded).toBeGreaterThan(0);
  });

  it("serialises paise as strings so the response is valid JSON", async () => {
    const response = await discover(
      post("http://t/api/entitlements/discover", { citizenId }),
    );
    // A BigInt would have thrown during serialisation inside the handler.
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(response);

    const ignwps = must(
      data(body).entitlements.find((e) => e.schemeCode === "NSAP-IGNWPS"),
      "IGNWPS",
    );
    expect(typeof ignwps.expectedAmountPaise).toBe("string");
    expect(formatINR(deserialize(must(ignwps.expectedAmountPaise, "an amount")))).toBe(
      "₹300",
    );
  });

  it("keeps a null amount null for an in-kind benefit", async () => {
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );
    const nfsa = must(
      data(body).entitlements.find((e) => e.schemeCode === "NFSA-PHH"),
      "NFSA",
    );
    // Not zero. Foodgrain has no rupee value, and rendering it as 0 would
    // understate every dashboard total as though it were a fact.
    expect(nfsa.expectedAmountPaise).toBeNull();
    expect(nfsa.annualValuePaise).toBeNull();
  });

  it("includes the citable clause behind an exclusion", async () => {
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );
    const pmmvy = must(
      data(body).entitlements.find((e) => e.schemeCode === "PMMVY"),
      "PMMVY",
    );

    expect(pmmvy.verdict).toBe("RED");
    const blocking = must(
      pmmvy.clauses.find((c) => c.code === "AGE_UNDER_55"),
      "the age clause",
    );
    expect(blocking.disqualifies).toBe(true);
    expect(blocking.sourceUrl).toMatch(/^https:\/\//);
    expect(blocking.text).toMatch(/55 years/);
  });

  it("reports source provenance so the UI can show how trustworthy it is", async () => {
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );
    const ignoaps = must(
      data(body).entitlements.find((e) => e.schemeCode === "NSAP-IGNOAPS"),
      "IGNOAPS",
    );
    expect(ignoaps.source.verificationStatus).toBe("SOURCE_CHECKED");
    expect(ignoaps.source.url).toBe("https://nsap.nic.in/");
  });

  it("carries pending declarations for approval gate 1", async () => {
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(
      await discover(post("http://t/api/entitlements/discover", { citizenId })),
    );
    const pmkisan = must(
      data(body).entitlements.find((e) => e.schemeCode === "PM-KISAN"),
      "PM-KISAN",
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
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(
      await getEntitlements(
        new Request(`http://t/api/entitlements?citizenId=${citizenId}`),
      ),
    );
    expect(data(body).entitlements).toHaveLength(10);

    const first = data(body).entitlements[0];
    expect(first.clauseResults).toBeTruthy();
    expect(first.lifecycleState).toBeTruthy();
  });

  it("can omit excluded schemes", async () => {
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(
      await getEntitlements(
        new Request(
          `http://t/api/entitlements?citizenId=${citizenId}&includeExcluded=false`,
        ),
      ),
    );
    expect(data(body).entitlements.length).toBeLessThan(10);
    for (const entitlement of data(body).entitlements) {
      expect(entitlement.verdict).not.toBe("RED");
    }
  });

  it("scopes results to the requested citizen", async () => {
    // Authorization is demo-grade, but scoping is real: no handler reads "the
    // current citizen" from ambient state.
    const other = await createCitizen({ name: "Another Person" });
    const body = await json<{ created: number; entitlements: WireEntitlement[]; counts: { eligible: number; excluded: number } }>(
      await getEntitlements(
        new Request(`http://t/api/entitlements?citizenId=${other.id}`),
      ),
    );
    expect(data(body).entitlements).toEqual([]);
  });
});
