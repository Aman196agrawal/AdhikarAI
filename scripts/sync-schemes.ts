/**
 * Nightly scheme catalogue sync: `npm run sync:schemes`.
 *
 * Syncs the catalogue from myScheme, then drafts rules for new and changed
 * schemes. Run by .github/workflows/scheme-sync.yml; safe to run by hand.
 *
 * Options:
 *   --limit N         only the first N listed schemes (never withdraws anything)
 *   --no-draft        skip AI rule drafting
 *   --draft-limit N   draft at most N schemes this run (default 200)
 *   --no-hindi        skip fetching Hindi texts
 *
 * Exits non-zero when the sync FAILED, so the workflow run shows red and the
 * team hears about it. A PARTIAL run exits zero: the catalogue was updated,
 * and the run record lists what failed.
 */

import "dotenv/config";

import { draftPendingRules } from "../lib/catalogue/drafting";
import { createMySchemeSource } from "../lib/catalogue/myscheme/source";
import { syncCatalogue } from "../lib/catalogue/sync";
import { systemClock } from "../lib/clock";
import { prisma } from "../lib/db";
import { llm } from "../lib/llm";

function numberArg(name: string): number | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} needs a positive whole number`);
  }
  return value;
}

async function main(): Promise<void> {
  const clock = systemClock();
  const limit = numberArg("--limit");
  const draftLimit = numberArg("--draft-limit");
  const draft = !process.argv.includes("--no-draft");
  const fetchHindi = !process.argv.includes("--no-hindi");

  console.log(
    `Syncing the scheme catalogue from myScheme${limit ? ` (first ${limit} schemes only)` : ""}...`,
  );
  console.log("This is deliberately slow: about one request per second.\n");

  const summary = await syncCatalogue({
    source: createMySchemeSource(),
    clock,
    limit,
    fetchHindi,
  });

  console.log(
    `Sync ${summary.status}: ${summary.listed} listed, ${summary.created} new, ` +
      `${summary.changed} changed, ${summary.unchanged} unchanged, ` +
      `${summary.withdrawn} withdrawn, ${summary.failed} failed.`,
  );
  if (summary.note) console.log(`Note: ${summary.note}`);

  if (summary.status === "FAILED") {
    process.exitCode = 1;
    return;
  }

  if (draft && llm().name === "stub") {
    // Stub drafts are test fixtures. In a real database they would sit in the
    // review queue looking like real proposals, so they are never written.
    console.log("Drafting skipped: no real model is configured (LLM_PROVIDER is stub).");
  } else if (draft) {
    const drafting = await draftPendingRules({ clock, limit: draftLimit, runId: summary.runId });
    console.log(
      `Drafting: ${drafting.drafted} schemes drafted (${drafting.rules} rules), ${drafting.failed} failed. ` +
        "Drafted rules wait for review at /admin/catalogue.",
    );
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
