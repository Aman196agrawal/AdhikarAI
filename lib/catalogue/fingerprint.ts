/**
 * Content fingerprints.
 *
 * A scheme has changed exactly when its fingerprint has. The fingerprint is a
 * sha256 over a canonical JSON of the NORMALISED content - never the raw
 * response - so a source reordering keys, adding a tracking field or changing
 * whitespace does not register as a change, while any edit to what a citizen
 * would read does.
 */

import { createHash } from "node:crypto";

import type { NormalisedScheme } from "./types";

/** JSON with object keys sorted at every depth, so key order cannot matter. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Collapse runs of whitespace, so re-wrapped text is not a change. */
function tidy(text: string | null): string | null {
  if (text === null) return null;
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed === "" ? null : collapsed;
}

/**
 * Fingerprint what matters about a scheme.
 *
 * Lists whose order carries no meaning (states, categories, tags, facet
 * values) are sorted first, so a source returning them in a different order
 * is not reported as a change.
 */
export function fingerprint(scheme: NormalisedScheme): string {
  const sorted = (values: string[]) => [...values].sort();
  const facets = Object.fromEntries(
    Object.entries(scheme.facets).map(([k, v]) => [k, sorted(v)]),
  );

  const content = {
    listing: {
      ...scheme.listing,
      briefDescription: tidy(scheme.listing.briefDescription),
      states: sorted(scheme.listing.states),
      categories: sorted(scheme.listing.categories),
      tags: sorted(scheme.listing.tags),
    },
    facets,
    english: Object.fromEntries(
      Object.entries(scheme.english).map(([k, v]) => [k, tidy(v)]),
    ),
    referenceUrls: sorted(scheme.referenceUrls),
  };

  return createHash("sha256").update(canonicalJson(content)).digest("hex");
}
