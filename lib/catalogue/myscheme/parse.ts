/**
 * Parsing myScheme responses.
 *
 * SEARCH is fitted to a real response captured from the website
 * (tests/fixtures/myscheme/search-page-0.json):
 *   GET https://www.myscheme.gov.in/api/apisetu/search/schemes
 *       ?lang=en&q=<filters JSON>&keyword=&sort=&from=<offset>&size=<n>
 *
 * DETAIL is PROVISIONAL. Its field names come from an open-source client of
 * the site and have not yet been checked against a captured response. It is
 * parsed tolerantly - every field optional, rich text flattened - and the raw
 * payload is always kept in the snapshot, so nothing is lost if a name is
 * wrong; a mismatch shows up as empty texts, never as a crash or a guess.
 *
 * Both parsers are lenient about extra fields (sources add them) and strict
 * about the few fields the sync cannot work without.
 */

import * as z from "zod";

import type { CatalogueDetail, CatalogueListing, CatalogueTexts } from "../types";

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

const SearchHit = z.object({
  id: z.string().optional(),
  fields: z
    .object({
      slug: z.string().min(1),
      schemeName: z.string().min(1),
      schemeShortTitle: z.string().nullish(),
      level: z.string().nullish(),
      beneficiaryState: z.array(z.string()).nullish(),
      schemeCategory: z.array(z.string()).nullish(),
      nodalMinistryName: z.string().nullish(),
      tags: z.array(z.string()).nullish(),
      schemeFor: z.string().nullish(),
      briefDescription: z.string().nullish(),
      schemeCloseDate: z.string().nullish(),
    })
    .loose(),
});

const SearchResponse = z.object({
  status: z.string().optional(),
  statusCode: z.number().optional(),
  data: z.object({
    hits: z.object({
      items: z.array(SearchHit),
      page: z.object({
        from: z.number(),
        size: z.number(),
        total: z.number(),
      }),
    }),
  }),
});

export interface SearchPage {
  listings: CatalogueListing[];
  total: number;
  from: number;
  size: number;
}

/** "All" in beneficiaryState means applicable everywhere: store as []. */
function normaliseStates(states: string[] | null | undefined): string[] {
  const list = (states ?? []).map((s) => s.trim()).filter(Boolean);
  return list.some((s) => s.toLowerCase() === "all") ? [] : list;
}

function isoDateOrNull(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

export function parseSearchPage(raw: unknown): SearchPage {
  const parsed = SearchResponse.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `myScheme search response has an unexpected shape: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }

  const { items, page } = parsed.data.data.hits;
  return {
    total: page.total,
    from: page.from,
    size: page.size,
    listings: items.map(({ fields }) => ({
      externalId: fields.slug.trim(),
      name: fields.schemeName.trim(),
      shortTitle: fields.schemeShortTitle?.trim() || null,
      level: fields.level?.trim() || "Central",
      states: normaliseStates(fields.beneficiaryState),
      categories: fields.schemeCategory ?? [],
      ministry: fields.nodalMinistryName?.trim() || null,
      tags: fields.tags ?? [],
      schemeFor: fields.schemeFor?.trim() || null,
      briefDescription: (fields.briefDescription ?? "").trim(),
      closesOn: isoDateOrNull(fields.schemeCloseDate),
    })),
  };
}

// ---------------------------------------------------------------------------
// Detail (provisional - see the header)
// ---------------------------------------------------------------------------

/**
 * Flatten rich text into plain text.
 *
 * The site stores some sections as markdown strings and others as a tree of
 * `{ type, children, text }` nodes. Either way, what we keep is the words.
 */
export function flattenRichText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value.trim() || null;

  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      parts.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      parts.push("\n");
      return;
    }
    if (typeof node === "object") {
      const record = node as Record<string, unknown>;
      if (typeof record.text === "string") parts.push(record.text);
      if (record.children !== undefined) walk(record.children);
      if (record.type === "paragraph" || record.type === "list_item") parts.push("\n");
    }
  };
  walk(value);

  const text = parts.join("").replace(/\n{3,}/g, "\n\n").trim();
  return text === "" ? null : text;
}

function pick(record: unknown, ...path: string[]): unknown {
  let current = record;
  for (const key of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** The first non-empty text among candidate locations. */
function firstText(record: unknown, ...paths: string[][]): string | null {
  for (const path of paths) {
    const text = flattenRichText(pick(record, ...path));
    if (text) return text;
  }
  return null;
}

/**
 * Parse a detail response.
 *
 * Accepts the payload either at the top level or under `data`, and the
 * language block either keyed by language (`{ en: {...} }`) or flat.
 * Returns null when the response has no recognisable scheme content at all.
 */
export function parseDetail(raw: unknown, lang: "en" | "hi"): CatalogueDetail | null {
  const root = pick(raw, "data") ?? raw;
  const block = pick(root, lang) ?? pick(root, "en") ?? root;

  const texts: CatalogueTexts = {
    name: firstText(block, ["basicDetails", "schemeName"]),
    briefDescription: firstText(
      block,
      ["schemeContent", "briefDescription"],
      ["basicDetails", "briefDescription"],
    ),
    eligibilityMd: firstText(
      block,
      ["eligibilityCriteria", "eligibilityDescription_md"],
      ["eligibilityCriteria", "eligibilityDescription"],
    ),
    benefitsMd: firstText(
      block,
      ["schemeContent", "benefits_md"],
      ["schemeContent", "benefits"],
    ),
    exclusionsMd: firstText(
      block,
      ["schemeContent", "exclusions_md"],
      ["schemeContent", "exclusions"],
    ),
    documentsMd: firstText(
      block,
      ["documentsRequired", "documentsRequired_md"],
      ["applicationProcess", "documents_md"],
      ["applicationProcess", "documents"],
    ),
    applicationProcessMd: firstText(
      block,
      ["applicationProcess", "process_md"],
      ["applicationProcess", "process"],
    ),
  };

  const references = pick(block, "schemeContent", "references");
  const referenceUrls = Array.isArray(references)
    ? references
        .map((r) => pick(r, "url"))
        .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u))
    : [];

  const hasContent = Object.values(texts).some((t) => t !== null);
  if (!hasContent) return null;

  return { texts, referenceUrls, raw };
}
