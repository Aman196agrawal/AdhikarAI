/**
 * Links between catalogue entries and the curated, payment-tracked schemes in
 * lib/registry/schemes.ts.
 *
 * When a linked catalogue entry's source text changes, the sync flags the
 * tracked scheme for re-verification - the curated registry is hand-maintained
 * and this is how it learns that the world moved.
 *
 * Only links confirmed against a real myScheme listing belong here. A wrong
 * link would flag the wrong scheme, so a slug is added only once it has been
 * seen in a captured response (igndps: tests/fixtures/myscheme/search-page-0.json).
 * Admins can also set `trackedSchemeCode` on a row directly.
 */

const LINKS: Record<string, Record<string, string>> = {
  myscheme: {
    igndps: "NSAP-IGNDPS",
  },
};

export function trackedSchemeCodeFor(source: string, externalId: string): string | null {
  return LINKS[source]?.[externalId] ?? null;
}
