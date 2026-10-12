import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { canonicalJson, fingerprint } from "@/lib/catalogue/fingerprint";
import { flattenRichText, parseDetail, parseSearchPage } from "@/lib/catalogue/myscheme/parse";
import type { NormalisedScheme } from "@/lib/catalogue/types";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(join(__dirname, "..", "fixtures", "myscheme", name), "utf8"));

describe("parseSearchPage (real myScheme response)", () => {
  const page = parseSearchPage(fixture("search-page-0.json"));

  it("reads the paging and every hit", () => {
    expect(page.total).toBe(5102);
    expect(page.from).toBe(0);
    expect(page.size).toBe(10);
    expect(page.listings).toHaveLength(10);
  });

  it("normalises a central scheme", () => {
    const igndps = page.listings.find((l) => l.externalId === "igndps");
    expect(igndps).toMatchObject({
      name: "Indira Gandhi National Disability Pension Scheme",
      shortTitle: "IGNDPS",
      level: "Central",
      ministry: "Ministry Of Rural Development",
      // "All" means applicable everywhere, which the catalogue stores as [].
      states: [],
      closesOn: null,
    });
    // Trailing blank lines in the source are trimmed.
    expect(igndps?.briefDescription.endsWith("society.")).toBe(true);
  });

  it("keeps the state of a state scheme and tolerates a missing ministry", () => {
    const psw = page.listings.find((l) => l.externalId === "psw");
    expect(psw?.level).toBe("State");
    expect(psw?.states).toEqual(["Dadra & Nagar Haveli and Daman & Diu"]);
    expect(psw?.ministry).toBeNull();
  });

  it("rejects a response without the hits it needs, naming the problem", () => {
    expect(() => parseSearchPage({ data: { facets: [] } })).toThrow(/unexpected shape/);
    expect(() => parseSearchPage({ status: "Failure" })).toThrow(/unexpected shape/);
  });

  it("rejects a hit with no slug rather than inventing an id", () => {
    const raw = fixture("search-page-0.json") as {
      data: { hits: { items: Array<{ fields: Record<string, unknown> }> } };
    };
    raw.data.hits.items[0].fields.slug = "";
    expect(() => parseSearchPage(raw)).toThrow(/unexpected shape/);
  });
});

describe("parseDetail (provisional shape)", () => {
  it("reads the language block and markdown fields", () => {
    const detail = parseDetail(
      {
        data: {
          en: {
            basicDetails: { schemeName: "PM Kisan" },
            schemeContent: {
              briefDescription: "Income support.",
              benefits_md: "₹6,000 per year.",
              references: [{ title: "Guidelines", url: "https://pmkisan.gov.in/guide.pdf" }, { url: "not a url" }],
            },
            eligibilityCriteria: { eligibilityDescription_md: "Land-holding farmer families." },
            applicationProcess: { documents_md: "Aadhaar, land record." },
          },
        },
      },
      "en",
    );
    expect(detail?.texts).toMatchObject({
      name: "PM Kisan",
      briefDescription: "Income support.",
      benefitsMd: "₹6,000 per year.",
      eligibilityMd: "Land-holding farmer families.",
      documentsMd: "Aadhaar, land record.",
    });
    expect(detail?.referenceUrls).toEqual(["https://pmkisan.gov.in/guide.pdf"]);
  });

  it("returns null when there is no recognisable content, instead of guessing", () => {
    expect(parseDetail({ data: {} }, "en")).toBeNull();
    expect(parseDetail(null, "en")).toBeNull();
  });

  it("flattens rich-text trees to their words", () => {
    const tree = [
      { type: "paragraph", children: [{ text: "Applicant must be " }, { text: "a farmer." }] },
      { type: "paragraph", children: [{ text: "Aged 18 or over." }] },
    ];
    const text = flattenRichText(tree);
    expect(text).toContain("Applicant must be a farmer.");
    expect(text).toContain("Aged 18 or over.");
    expect(flattenRichText("   ")).toBeNull();
  });
});

describe("fingerprint", () => {
  const base: NormalisedScheme = {
    listing: {
      externalId: "x",
      name: "X",
      shortTitle: null,
      level: "Central",
      states: ["Bihar", "Assam"],
      categories: ["A", "B"],
      ministry: null,
      tags: ["t1", "t2"],
      schemeFor: null,
      briefDescription: "About X.",
      closesOn: null,
    },
    facets: { gender: ["Female", "Transgender"] },
    english: {
      name: null,
      briefDescription: null,
      eligibilityMd: "Must be a widow.",
      benefitsMd: null,
      exclusionsMd: null,
      documentsMd: null,
      applicationProcessMd: null,
    },
    referenceUrls: [],
    officialUrl: "https://example.gov.in/x",
  };

  it("ignores key order, list order and re-wrapped whitespace", () => {
    const shuffled: NormalisedScheme = {
      ...base,
      listing: { ...base.listing, states: ["Assam", "Bihar"], tags: ["t2", "t1"] },
      facets: { gender: ["Transgender", "Female"] },
      english: { ...base.english, eligibilityMd: "Must  be a\n widow. " },
    };
    expect(fingerprint(shuffled)).toBe(fingerprint(base));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });

  it("changes when anything a citizen would read changes", () => {
    const original = fingerprint(base);
    expect(fingerprint({ ...base, english: { ...base.english, eligibilityMd: "Must be a widow aged 40+." } })).not.toBe(original);
    expect(fingerprint({ ...base, facets: { gender: ["Female"] } })).not.toBe(original);
    expect(fingerprint({ ...base, listing: { ...base.listing, closesOn: "2027-03-31" } })).not.toBe(original);
  });
});
