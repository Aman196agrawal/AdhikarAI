/**
 * Catalogue sync.
 *
 * Brings the catalogue in line with what a source lists today, and records
 * exactly what changed. Run nightly (scripts/sync-schemes.ts, from GitHub
 * Actions). The guarantees, each tested in tests/scenarios/catalogueSync:
 *
 *   1. Change is detected by fingerprint, not by trusting the source.
 *   2. A changed scheme's rules go STALE at once, so a rule drafted from old
 *      text can never decide eligibility against new text.
 *   3. Nothing is withdrawn on a single absence: a scheme must be missing from
 *      two consecutive full syncs. A listing that suddenly shrinks by more than
 *      half is treated as a source failure, and nothing is touched.
 *   4. A failure for one scheme (its detail did not load) never erases what we
 *      already knew about it; the previous texts are kept and the run is PARTIAL.
 *   5. Every run leaves a SchemeSyncRun row saying what it did.
 */

import type { Clock } from "@/lib/clock";
import { prisma as defaultDb } from "@/lib/db";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { log } from "@/lib/log";

import { fingerprint } from "./fingerprint";
import { trackedSchemeCodeFor } from "./tracked";
import type {
  CatalogueListing,
  CatalogueTexts,
  FacetMap,
  NormalisedScheme,
  SchemeSource,
} from "./types";

export interface SyncOptions {
  source: SchemeSource;
  clock: Clock;
  db?: PrismaClient;
  /**
   * Process only the first N listed schemes. A limited run is a partial view
   * of the source, so it never withdraws anything.
   */
  limit?: number;
  /** Fetch Hindi texts for new and changed schemes. Default true. */
  fetchHindi?: boolean;
}

export interface SyncSummary {
  runId: string;
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  listed: number;
  created: number;
  changed: number;
  unchanged: number;
  withdrawn: number;
  failed: number;
  note?: string;
}

/** Withdraw only after this many consecutive full syncs without the scheme. */
export const MISSING_SYNCS_BEFORE_WITHDRAWAL = 2;

/** A listing below this share of the active catalogue is a source failure. */
export const MIN_LISTING_SHARE = 0.5;

const MAX_STORED_ERRORS = 50;

const asJson = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

const EMPTY_TEXTS: CatalogueTexts = {
  name: null,
  briefDescription: null,
  eligibilityMd: null,
  benefitsMd: null,
  exclusionsMd: null,
  documentsMd: null,
  applicationProcessMd: null,
};

type ExistingRow = {
  id: string;
  externalId: string;
  contentHash: string;
  status: "ACTIVE" | "WITHDRAWN";
  facets: unknown;
  eligibilityMd: string | null;
  benefitsMd: string | null;
  exclusionsMd: string | null;
  documentsMd: string | null;
  applicationProcessMd: string | null;
  referenceUrls: string[];
  missingSyncCount: number;
  trackedSchemeCode: string | null;
};

function storedTexts(row: ExistingRow): CatalogueTexts {
  return {
    ...EMPTY_TEXTS,
    eligibilityMd: row.eligibilityMd,
    benefitsMd: row.benefitsMd,
    exclusionsMd: row.exclusionsMd,
    documentsMd: row.documentsMd,
    applicationProcessMd: row.applicationProcessMd,
  };
}

/**
 * This sync's facets for one scheme, keeping the stored values for any
 * identifier the source could not read in full.
 */
function mergeFacets(
  fresh: FacetMap | undefined,
  stored: unknown,
  incomplete: string[],
): FacetMap {
  const previous = (stored ?? {}) as FacetMap;
  if (incomplete.includes("*")) return { ...previous };

  const merged: FacetMap = { ...(fresh ?? {}) };
  for (const identifier of incomplete) {
    if (previous[identifier]) merged[identifier] = previous[identifier];
    else delete merged[identifier];
  }
  return merged;
}

function rowData(scheme: NormalisedScheme, hash: string) {
  const { listing, english } = scheme;
  return {
    name: listing.name,
    shortTitle: listing.shortTitle,
    level: listing.level,
    states: listing.states,
    categories: listing.categories,
    ministry: listing.ministry,
    tags: listing.tags,
    schemeFor: listing.schemeFor,
    closesOn: listing.closesOn ? new Date(listing.closesOn) : null,
    briefDescription: english.briefDescription ?? listing.briefDescription,
    eligibilityMd: english.eligibilityMd,
    benefitsMd: english.benefitsMd,
    exclusionsMd: english.exclusionsMd,
    documentsMd: english.documentsMd,
    applicationProcessMd: english.applicationProcessMd,
    facets: asJson(scheme.facets),
    officialUrl: scheme.officialUrl,
    referenceUrls: scheme.referenceUrls,
    contentHash: hash,
  };
}

/** The snapshot keeps the normalised content: small, and exactly what was hashed. */
function snapshotPayload(scheme: NormalisedScheme) {
  return asJson({
    listing: scheme.listing,
    facets: scheme.facets,
    english: scheme.english,
    referenceUrls: scheme.referenceUrls,
  });
}

export async function syncCatalogue(options: SyncOptions): Promise<SyncSummary> {
  const db = options.db ?? defaultDb;
  const { source, clock } = options;
  const fetchHindi = options.fetchHindi ?? true;
  const fullRun = options.limit === undefined;

  const run = await db.schemeSyncRun.create({
    data: { source: source.name, startedAt: clock.now() },
  });

  const counts = { listed: 0, created: 0, changed: 0, unchanged: 0, withdrawn: 0, failed: 0 };
  const errors: Array<{ externalId?: string; message: string }> = [];
  const recordError = (message: string, externalId?: string) => {
    if (errors.length < MAX_STORED_ERRORS) errors.push({ externalId, message });
  };

  const finish = async (
    status: SyncSummary["status"],
    note?: string,
  ): Promise<SyncSummary> => {
    await db.schemeSyncRun.update({
      where: { id: run.id },
      data: { status, finishedAt: clock.now(), ...counts, errors: asJson(errors), note },
    });
    log.info("catalogue.sync.finished", { runId: run.id, source: source.name, status, ...counts });
    return { runId: run.id, status, ...counts, note };
  };

  // 1. The listing. Without it there is nothing safe to do.
  let listings: CatalogueListing[];
  try {
    listings = await source.listAll();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordError(`Listing failed: ${message}`);
    return finish("FAILED", "The source listing could not be read; the catalogue was left unchanged.");
  }
  if (options.limit !== undefined) listings = listings.slice(0, options.limit);
  counts.listed = listings.length;

  const activeBefore = await db.catalogScheme.count({
    where: { source: source.name, status: "ACTIVE" },
  });
  if (fullRun && activeBefore > 0 && listings.length < activeBefore * MIN_LISTING_SHARE) {
    recordError(`Listing returned ${listings.length} schemes; ${activeBefore} were active.`);
    return finish(
      "FAILED",
      "The listing shrank by more than half, which looks like a source failure; nothing was changed or withdrawn.",
    );
  }

  // 2. Facet memberships. A failure here costs precision, not correctness.
  let facets: { byScheme: Map<string, FacetMap>; incomplete: string[] };
  try {
    facets = await source.facetMemberships();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordError(`Facet memberships failed: ${message}`);
    facets = { byScheme: new Map(), incomplete: ["*"] };
  }
  if (facets.incomplete.length > 0) {
    recordError(`Facets kept from the previous sync for: ${facets.incomplete.join(", ")}`);
  }

  const existingRows = (await db.catalogScheme.findMany({
    where: { source: source.name },
    select: {
      id: true,
      externalId: true,
      contentHash: true,
      status: true,
      facets: true,
      eligibilityMd: true,
      benefitsMd: true,
      exclusionsMd: true,
      documentsMd: true,
      applicationProcessMd: true,
      referenceUrls: true,
      missingSyncCount: true,
      trackedSchemeCode: true,
    },
  })) as ExistingRow[];
  const existing = new Map(existingRows.map((row) => [row.externalId, row]));

  // 3. Each listed scheme.
  for (const listing of listings) {
    const previous = existing.get(listing.externalId);
    const now = clock.now();

    let english: CatalogueTexts;
    let referenceUrls: string[];
    try {
      const detail = await source.fetchDetail(listing.externalId, "en");
      if (detail) {
        english = detail.texts;
        referenceUrls = detail.referenceUrls;
      } else if (previous) {
        english = storedTexts(previous);
        referenceUrls = previous.referenceUrls;
      } else {
        english = { ...EMPTY_TEXTS };
        referenceUrls = [];
      }
    } catch (error) {
      counts.failed += 1;
      recordError(error instanceof Error ? error.message : String(error), listing.externalId);
      english = previous ? storedTexts(previous) : { ...EMPTY_TEXTS };
      referenceUrls = previous?.referenceUrls ?? [];
    }

    const normalised: NormalisedScheme = {
      listing,
      facets: mergeFacets(facets.byScheme.get(listing.externalId), previous?.facets, facets.incomplete),
      english,
      referenceUrls,
      officialUrl: source.officialUrl(listing.externalId),
    };
    const hash = fingerprint(normalised);

    if (previous && previous.contentHash === hash) {
      await db.catalogScheme.update({
        where: { id: previous.id },
        data: {
          lastFetchedAt: now,
          missingSyncCount: 0,
          // A scheme that was withdrawn and is listed again is back.
          ...(previous.status === "WITHDRAWN" ? { status: "ACTIVE", withdrawnAt: null } : {}),
        },
      });
      counts.unchanged += 1;
      continue;
    }

    const hindi = fetchHindi ? await tryHindi(source, listing.externalId) : null;
    const data = {
      ...rowData(normalised, hash),
      ...(hindi ? { hindi: asJson(hindi), nameHi: hindi.name ?? null } : {}),
      lastFetchedAt: now,
      lastChangedAt: now,
      missingSyncCount: 0,
      status: "ACTIVE" as const,
      withdrawnAt: null,
      draftStatus: "PENDING" as const,
    };

    if (!previous) {
      await db.catalogScheme.create({
        data: {
          ...data,
          source: source.name,
          externalId: listing.externalId,
          firstSeenAt: now,
          trackedSchemeCode: trackedSchemeCodeFor(source.name, listing.externalId),
          snapshots: {
            create: { contentHash: hash, fetchedAt: now, payload: snapshotPayload(normalised) },
          },
        },
      });
      counts.created += 1;
      continue;
    }

    await db.$transaction([
      db.catalogScheme.update({ where: { id: previous.id }, data }),
      db.catalogSnapshot.upsert({
        where: { catalogSchemeId_contentHash: { catalogSchemeId: previous.id, contentHash: hash } },
        create: {
          catalogSchemeId: previous.id,
          contentHash: hash,
          fetchedAt: now,
          payload: snapshotPayload(normalised),
        },
        update: { fetchedAt: now },
      }),
      // The guarantee: rules drafted from the old text stop counting now.
      db.catalogRule.updateMany({
        where: {
          catalogSchemeId: previous.id,
          status: { in: ["DRAFT", "APPROVED"] },
          sourceHash: { not: hash },
        },
        data: { status: "STALE" },
      }),
    ]);
    counts.changed += 1;

    if (previous.trackedSchemeCode) {
      log.warn("catalogue.sync.tracked_scheme_changed", {
        externalId: listing.externalId,
        trackedSchemeCode: previous.trackedSchemeCode,
      });
      recordError(
        `Source text changed for tracked scheme ${previous.trackedSchemeCode}; re-verify lib/registry/schemes.ts.`,
        listing.externalId,
      );
    }
  }

  // 4. Withdrawals - full runs only, and never on a single absence.
  if (fullRun) {
    const listedIds = new Set(listings.map((l) => l.externalId));
    for (const row of existingRows) {
      if (listedIds.has(row.externalId) || row.status === "WITHDRAWN") continue;

      const missing = row.missingSyncCount + 1;
      const withdraw = missing >= MISSING_SYNCS_BEFORE_WITHDRAWAL;
      await db.catalogScheme.update({
        where: { id: row.id },
        data: {
          missingSyncCount: missing,
          ...(withdraw ? { status: "WITHDRAWN", withdrawnAt: clock.now() } : {}),
        },
      });
      if (withdraw) counts.withdrawn += 1;
    }
  }

  return finish(counts.failed > 0 ? "PARTIAL" : "SUCCEEDED");
}

async function tryHindi(
  source: SchemeSource,
  externalId: string,
): Promise<CatalogueTexts | null> {
  try {
    const detail = await source.fetchDetail(externalId, "hi");
    return detail?.texts ?? null;
  } catch (error) {
    // Hindi is a convenience; its absence never fails a scheme.
    log.warn("catalogue.sync.hindi_failed", {
      externalId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
