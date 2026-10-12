/**
 * An in-memory SchemeSource for sync tests. Each test mutates `schemes`,
 * `facets` and the failure switches between sync runs to simulate a source
 * changing over time.
 */

import type {
  CatalogueDetail,
  CatalogueListing,
  CatalogueTexts,
  FacetMap,
  FacetMemberships,
  SchemeSource,
} from "@/lib/catalogue/types";

export interface FakeScheme {
  listing: CatalogueListing;
  english: Partial<CatalogueTexts>;
  hindi?: Partial<CatalogueTexts>;
  referenceUrls?: string[];
}

export function listing(externalId: string, overrides: Partial<CatalogueListing> = {}): CatalogueListing {
  return {
    externalId,
    name: `Scheme ${externalId}`,
    shortTitle: externalId.toUpperCase(),
    level: "Central",
    states: [],
    categories: ["Social welfare & Empowerment"],
    ministry: "Ministry Of Rural Development",
    tags: [],
    schemeFor: "Individual",
    briefDescription: `About ${externalId}.`,
    closesOn: null,
    ...overrides,
  };
}

const texts = (partial: Partial<CatalogueTexts>): CatalogueTexts => ({
  name: null,
  briefDescription: null,
  eligibilityMd: null,
  benefitsMd: null,
  exclusionsMd: null,
  documentsMd: null,
  applicationProcessMd: null,
  ...partial,
});

export class FakeSchemeSource implements SchemeSource {
  readonly name = "fake";
  schemes = new Map<string, FakeScheme>();
  facets = new Map<string, FacetMap>();
  incompleteFacets: string[] = [];

  failListing = false;
  failFacets = false;
  failDetailFor = new Set<string>();
  detailCalls: Array<{ externalId: string; lang: string }> = [];

  add(scheme: FakeScheme): this {
    this.schemes.set(scheme.listing.externalId, scheme);
    return this;
  }

  remove(externalId: string): this {
    this.schemes.delete(externalId);
    return this;
  }

  officialUrl(externalId: string): string {
    return `https://example.gov.in/schemes/${externalId}`;
  }

  async listAll(): Promise<CatalogueListing[]> {
    if (this.failListing) throw new Error("listing unavailable");
    return [...this.schemes.values()].map((s) => s.listing);
  }

  async facetMemberships(): Promise<FacetMemberships> {
    if (this.failFacets) throw new Error("facets unavailable");
    return { byScheme: new Map(this.facets), incomplete: [...this.incompleteFacets] };
  }

  async fetchDetail(externalId: string, lang: "en" | "hi"): Promise<CatalogueDetail | null> {
    this.detailCalls.push({ externalId, lang });
    if (this.failDetailFor.has(externalId)) throw new Error(`detail unavailable for ${externalId}`);
    const scheme = this.schemes.get(externalId);
    if (!scheme) return null;
    const chosen = lang === "hi" ? scheme.hindi : scheme.english;
    if (!chosen) return null;
    return { texts: texts(chosen), referenceUrls: scheme.referenceUrls ?? [], raw: { externalId, lang } };
  }
}
