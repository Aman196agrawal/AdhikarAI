/**
 * Scheme catalogue types.
 *
 * The catalogue is every scheme an external source lists (about 5,100 on
 * myScheme), kept separate from the curated registry in `lib/registry`. The
 * registry holds what a payment-by-payment continuity audit needs; the
 * catalogue holds breadth, and must never be silently stale.
 *
 * A `SchemeSource` is the only thing that knows how a particular source is
 * shaped. Everything downstream - sync, change detection, rule drafting,
 * matching - works on the normalised types here, so replacing the myScheme
 * website's API with the official API Setu one is a new source, nothing more.
 *
 * See docs/specs/2026-10-12-scheme-catalogue-sync-design.md.
 */

/** One scheme as a source's listing reports it. Cheap to fetch in bulk. */
export interface CatalogueListing {
  externalId: string;
  name: string;
  shortTitle: string | null;
  /** "Central" or "State". */
  level: string;
  /** Empty means applicable across India. */
  states: string[];
  categories: string[];
  ministry: string | null;
  tags: string[];
  schemeFor: string | null;
  briefDescription: string;
  /** ISO date the scheme stops accepting applications, when the source says. */
  closesOn: string | null;
}

/** The long-form texts of a scheme, in one language. */
export interface CatalogueTexts {
  name: string | null;
  briefDescription: string | null;
  eligibilityMd: string | null;
  benefitsMd: string | null;
  exclusionsMd: string | null;
  documentsMd: string | null;
  applicationProcessMd: string | null;
}

/** One scheme's full detail, normalised. */
export interface CatalogueDetail {
  texts: CatalogueTexts;
  referenceUrls: string[];
  /** The source's raw response, kept verbatim in the snapshot history. */
  raw: unknown;
}

/**
 * Restrictive filter values per identifier, e.g. `{ gender: ["Female"] }`.
 *
 * An identifier that is absent means the scheme does not restrict on it.
 * Values are the source's own labels; `lib/catalogue/match.ts` maps them onto
 * profile fields.
 */
export type FacetMap = Record<string, string[]>;

export interface FacetMemberships {
  byScheme: Map<string, FacetMap>;
  /** Identifiers not read in full; "*" means none were. */
  incomplete: string[];
}

/** Everything the sync stores for one scheme. */
export interface NormalisedScheme {
  listing: CatalogueListing;
  facets: FacetMap;
  english: CatalogueTexts;
  referenceUrls: string[];
  officialUrl: string;
}

export interface SchemeSource {
  /** Stable name stored on every row, e.g. "myscheme". */
  readonly name: string;

  /** Every scheme the source currently lists. Throws if the listing fails. */
  listAll(): Promise<CatalogueListing[]>;

  /**
   * Which schemes carry each restrictive filter value, keyed by externalId.
   *
   * `incomplete` names identifiers whose memberships could not be read in
   * full this time (a query failed, or the source ignored the filter). The
   * sync keeps the previously stored values for those, so one failed request
   * cannot strip a restriction from every scheme. A source that cannot
   * provide facets at all returns an empty map and `incomplete: ["*"]`.
   */
  facetMemberships(): Promise<FacetMemberships>;

  /** Full detail for one scheme, or null when the source has none. */
  fetchDetail(externalId: string, lang: "en" | "hi"): Promise<CatalogueDetail | null>;

  /** The public page a citizen should be sent to for this scheme. */
  officialUrl(externalId: string): string;
}
