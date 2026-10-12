/**
 * myScheme as a catalogue source (access route B in the design).
 *
 * Reads the same JSON the myScheme website reads. It is not a published API,
 * so it is treated with care: requests go through `politeHttp` (one at a
 * time, about one per second), the optional key lives only in the
 * environment, and every row the sync writes credits myScheme and links to
 * the scheme's own page there.
 *
 * When API Setu access is approved, an `ApiSetuSource` implementing the same
 * `SchemeSource` interface replaces this file and nothing else changes.
 *
 * Configuration (all optional):
 *   MYSCHEME_BASE_URL     default https://www.myscheme.gov.in
 *   MYSCHEME_SEARCH_PATH  default /api/apisetu/search/schemes   (verified)
 *   MYSCHEME_DETAIL_PATH  default /api/apisetu/schemes          (NOT yet verified)
 *   MYSCHEME_PAGE_SIZE    default 10                            (10 verified)
 *   MYSCHEME_API_KEY      sent as x-api-key when set
 */

import { log } from "@/lib/log";

import { createPoliteHttp, type PoliteHttp, type PoliteHttpOptions } from "../politeHttp";
import type {
  CatalogueDetail,
  CatalogueListing,
  FacetMap,
  FacetMemberships,
  SchemeSource,
} from "../types";
import { parseDetail, parseSearchPage } from "./parse";

/**
 * Filters whose restrictive values we record per scheme, because each maps
 * onto a profile field the matcher can test. Values meaning "no restriction"
 * are skipped. State and level come from the listing itself, so they are not
 * here; age is a range facet and is left to drafted rules.
 */
export const DERIVED_FACETS: Record<string, { neutral: string[]; values: string[] }> = {
  gender: { neutral: ["All"], values: ["Female", "Male", "Transgender"] },
  caste: {
    neutral: ["All"],
    values: [
      "Scheduled Caste (SC)",
      "Scheduled Tribe (ST)",
      "Other Backward Class (OBC)",
      "General",
      "Particularly Vulnerable Tribal Group (PVTG)",
      "De-Notified, Nomadic, and Semi-Nomadic (DNT) communities",
    ],
  },
  residence: { neutral: ["Both"], values: ["Rural", "Urban"] },
  maritalStatus: {
    neutral: ["All"],
    values: ["Never Married", "Married", "Widowed", "Divorced", "Separated"],
  },
  employmentStatus: {
    neutral: ["All"],
    values: ["Employed", "Self-Employed/ Entrepreneur", "Unemployed"],
  },
  occupation: { neutral: ["All"], values: [] /* taken from the live facet list */ },
  disability: { neutral: ["No"], values: ["Yes"] },
  minority: { neutral: ["No"], values: ["Yes"] },
  isBpl: { neutral: ["No"], values: ["Yes"] },
  isStudent: { neutral: ["No"], values: ["Yes"] },
  isGovEmployee: { neutral: ["No"], values: ["Yes"] },
  isEconomicDistress: { neutral: ["No"], values: ["Yes"] },
};

/** Safety cap on pages per query, far above today's ~511. */
const MAX_PAGES = 2000;

export interface MySchemeSourceOptions extends PoliteHttpOptions {
  baseUrl?: string;
  searchPath?: string;
  detailPath?: string;
  pageSize?: number;
  apiKey?: string;
  http?: PoliteHttp;
}

export function createMySchemeSource(options: MySchemeSourceOptions = {}): SchemeSource {
  const env = process.env;
  // `||`, not `??`: an empty value in .env means "use the default".
  const baseUrl = (options.baseUrl || env.MYSCHEME_BASE_URL || "https://www.myscheme.gov.in").replace(/\/$/, "");
  const searchPath = options.searchPath || env.MYSCHEME_SEARCH_PATH || "/api/apisetu/search/schemes";
  const detailPath = options.detailPath || env.MYSCHEME_DETAIL_PATH || "/api/apisetu/schemes";
  const pageSize = options.pageSize ?? (Number(env.MYSCHEME_PAGE_SIZE) || 10);
  const apiKey = (options.apiKey ?? env.MYSCHEME_API_KEY ?? "").trim();

  const http =
    options.http ??
    createPoliteHttp({
      ...options,
      headers: {
        "User-Agent": "AdhikarAI-catalogue-sync/1.0 (benefit-continuity service; nightly, ~1 req/s)",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
        ...options.headers,
      },
    });

  function searchUrl(filters: unknown[], from: number): string {
    const params = new URLSearchParams({
      lang: "en",
      q: JSON.stringify(filters),
      keyword: "",
      sort: "",
      from: String(from),
      size: String(pageSize),
    });
    return `${baseUrl}${searchPath}?${params.toString()}`;
  }

  /** Every listing matching the filters, page by page. */
  async function searchAll(filters: unknown[]) {
    const first = parseSearchPage(await http.getJson(searchUrl(filters, 0)));
    const listings = [...first.listings];
    const total = first.total;

    for (let page = 1; listings.length < total && page < MAX_PAGES; page += 1) {
      const next = parseSearchPage(await http.getJson(searchUrl(filters, page * pageSize)));
      if (next.listings.length === 0) break;
      listings.push(...next.listings);
    }

    return { listings, total, firstRaw: first };
  }

  let cachedTotal: number | null = null;

  return {
    name: "myscheme",

    officialUrl(externalId: string) {
      return `https://www.myscheme.gov.in/schemes/${encodeURIComponent(externalId)}`;
    },

    async listAll(): Promise<CatalogueListing[]> {
      const { listings, total } = await searchAll([]);
      cachedTotal = total;

      const byId = new Map<string, CatalogueListing>();
      for (const listing of listings) byId.set(listing.externalId, listing);

      if (byId.size < total) {
        // Pages can shift while we read them (relevance sorting, live edits).
        // Report it; the sync's withdrawal rules make a short listing safe.
        log.warn("catalogue.myscheme.listing_short", { total, received: byId.size });
      }
      return [...byId.values()];
    },

    async facetMemberships(): Promise<FacetMemberships> {
      const memberships = new Map<string, FacetMap>();
      const incomplete = new Set<string>();
      const overall = cachedTotal ?? (await searchAll([])).total;

      // Occupation values are many and change; read them from the live facet
      // list rather than hard-coding them.
      const occupations = await liveFacetValues("occupation", DERIVED_FACETS.occupation.neutral);
      if (occupations.length === 0) incomplete.add("occupation");

      for (const [identifier, spec] of Object.entries(DERIVED_FACETS)) {
        const values = identifier === "occupation" ? occupations : spec.values;

        for (const value of values) {
          let result;
          try {
            result = await searchAll([{ identifier, value }]);
          } catch (error) {
            incomplete.add(identifier);
            log.warn("catalogue.myscheme.facet_failed", {
              identifier,
              value,
              message: error instanceof Error ? error.message : String(error),
            });
            continue;
          }

          // If the filter was ignored, every scheme comes back. Recording that
          // would mark the whole catalogue as, say, "for women only". Skip it.
          if (result.total >= overall) {
            incomplete.add(identifier);
            log.warn("catalogue.myscheme.facet_ignored", { identifier, value, total: result.total });
            continue;
          }

          if (result.listings.length < result.total) incomplete.add(identifier);

          for (const listing of result.listings) {
            const map = memberships.get(listing.externalId) ?? {};
            map[identifier] = [...new Set([...(map[identifier] ?? []), value])];
            memberships.set(listing.externalId, map);
          }
        }
      }

      return { byScheme: memberships, incomplete: [...incomplete] };

      async function liveFacetValues(identifier: string, neutral: string[]): Promise<string[]> {
        try {
          const raw = await http.getJson(searchUrl([], 0));
          const facets = (raw as { data?: { facets?: Array<{ identifier?: string; entries?: Array<{ label?: unknown }> }> } })
            ?.data?.facets;
          const facet = facets?.find((f) => f.identifier === identifier);
          return (facet?.entries ?? [])
            .map((e) => String(e.label ?? ""))
            .filter((label) => label !== "" && !neutral.includes(label));
        } catch {
          return [];
        }
      }
    },

    async fetchDetail(externalId: string, lang: "en" | "hi"): Promise<CatalogueDetail | null> {
      const params = new URLSearchParams({ slug: externalId, lang });
      const raw = await http.getJson(`${baseUrl}${detailPath}?${params.toString()}`);
      return parseDetail(raw, lang);
    },
  };
}
