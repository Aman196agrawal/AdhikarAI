import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createMySchemeSource } from "@/lib/catalogue/myscheme/source";
import { createPoliteHttp, SourceHttpError } from "@/lib/catalogue/politeHttp";

const realPage = JSON.parse(
  readFileSync(join(__dirname, "..", "fixtures", "myscheme", "search-page-0.json"), "utf8"),
);

/** A search response with the real envelope, carrying the given slugs. */
function page(slugs: string[], total: number, from: number) {
  return {
    ...realPage,
    data: {
      ...realPage.data,
      hits: {
        items: slugs.map((slug) => ({ id: slug, fields: { slug, schemeName: `Scheme ${slug}`, level: "Central", beneficiaryState: ["All"] } })),
        page: { from, pageNumber: from / 10, size: 10, total, totalPages: Math.ceil(total / 10) },
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const noSleep = async () => {};

describe("politeHttp", () => {
  it("waits between requests, and backs off before a retry", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const http = createPoliteHttp({
      minIntervalMs: 1000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async () => {
        calls += 1;
        return calls === 1 ? jsonResponse({}, 503) : jsonResponse({ ok: true });
      },
    });

    await expect(http.getJson("https://x/a")).resolves.toEqual({ ok: true });
    await http.getJson("https://x/b");
    // Retry 1 waits 2s of backoff then the 1s interval; the next request waits 1s.
    expect(sleeps).toEqual([2000, 1000, 1000]);
    expect(http.requestCount).toBe(3);
  });

  it("does not retry a request the server says is wrong", async () => {
    let calls = 0;
    const http = createPoliteHttp({
      sleep: noSleep,
      fetch: async () => {
        calls += 1;
        return jsonResponse({}, 404);
      },
    });
    await expect(http.getJson("https://x/missing")).rejects.toBeInstanceOf(SourceHttpError);
    expect(calls).toBe(1);
  });

  it("retries network failures and then gives up with the last error", async () => {
    let calls = 0;
    const http = createPoliteHttp({
      sleep: noSleep,
      retries: 2,
      fetch: async () => {
        calls += 1;
        throw new Error("ECONNRESET");
      },
    });
    await expect(http.getJson("https://x/flaky")).rejects.toThrow(/Network error: ECONNRESET/);
    expect(calls).toBe(3);
  });
});

describe("myScheme source", () => {
  it("pages through the whole listing with the website's query format", async () => {
    const urls: string[] = [];
    const slugs = Array.from({ length: 23 }, (_, i) => `s${i}`);
    const source = createMySchemeSource({
      baseUrl: "https://www.myscheme.gov.in",
      sleep: noSleep,
      fetch: async (url) => {
        urls.push(url);
        const from = Number(new URL(url).searchParams.get("from"));
        return jsonResponse(page(slugs.slice(from, from + 10), slugs.length, from));
      },
    });

    const listings = await source.listAll();
    expect(listings.map((l) => l.externalId)).toEqual(slugs);
    expect(urls).toHaveLength(3);

    const first = new URL(urls[0]);
    expect(first.pathname).toBe("/api/apisetu/search/schemes");
    expect(first.searchParams.get("q")).toBe("[]");
    expect(first.searchParams.get("size")).toBe("10");
    expect(new URL(urls[2]).searchParams.get("from")).toBe("20");
  });

  it("sends the API key only when one is configured", async () => {
    const seen: Array<Record<string, string>> = [];
    const make = (apiKey: string) =>
      createMySchemeSource({
        apiKey,
        sleep: noSleep,
        fetch: async (_url, init) => {
          seen.push((init?.headers ?? {}) as Record<string, string>);
          return jsonResponse(page(["a"], 1, 0));
        },
      });

    await make("").listAll();
    await make("secret-key").listAll();
    expect(seen[0]["x-api-key"]).toBeUndefined();
    expect(seen[1]["x-api-key"]).toBe("secret-key");
    expect(seen[1]["User-Agent"]).toMatch(/AdhikarAI/);
  });

  it("records each scheme's restrictive filter values", async () => {
    const source = createMySchemeSource({
      sleep: noSleep,
      fetch: async (url) => {
        const q = JSON.parse(new URL(url).searchParams.get("q") ?? "[]") as Array<{ identifier: string; value: string }>;
        if (q.length === 0) return jsonResponse(page(["widow", "farm", "all"], 3, 0));
        const { identifier, value } = q[0];
        if (identifier === "gender" && value === "Female") return jsonResponse(page(["widow"], 1, 0));
        if (identifier === "maritalStatus" && value === "Widowed") return jsonResponse(page(["widow"], 1, 0));
        if (identifier === "occupation" && value === "Farmer") return jsonResponse(page(["farm"], 1, 0));
        return jsonResponse(page([], 0, 0));
      },
    });

    await source.listAll();
    const { byScheme, incomplete } = await source.facetMemberships();
    expect(byScheme.get("widow")).toEqual({ gender: ["Female"], maritalStatus: ["Widowed"] });
    expect(byScheme.get("farm")).toEqual({ occupation: ["Farmer"] });
    expect(byScheme.get("all")).toBeUndefined();
    expect(incomplete).toEqual([]);
  });

  it("refuses to record a filter the source ignored, rather than restricting every scheme", async () => {
    const source = createMySchemeSource({
      sleep: noSleep,
      // Every query returns the full catalogue: the filter had no effect.
      fetch: async () => jsonResponse(page(["a", "b"], 2, 0)),
    });

    await source.listAll();
    const { byScheme, incomplete } = await source.facetMemberships();
    expect(byScheme.size).toBe(0);
    expect(incomplete).toContain("gender");
    expect(incomplete).toContain("caste");
  });

  it("marks a filter incomplete when its query fails", async () => {
    const source = createMySchemeSource({
      sleep: noSleep,
      retries: 0,
      fetch: async (url) => {
        const q = new URL(url).searchParams.get("q") ?? "[]";
        if (q.includes("isBpl")) return jsonResponse({}, 500);
        if (q === "[]") return jsonResponse(page(["a", "b"], 2, 0));
        return jsonResponse(page([], 0, 0));
      },
    });

    await source.listAll();
    const { incomplete } = await source.facetMemberships();
    expect(incomplete).toEqual(expect.arrayContaining(["isBpl"]));
    expect(incomplete).not.toContain("gender");
  });

  it("links to the scheme's own page on myScheme", () => {
    expect(createMySchemeSource().officialUrl("pm-kisan")).toBe("https://www.myscheme.gov.in/schemes/pm-kisan");
  });
});
