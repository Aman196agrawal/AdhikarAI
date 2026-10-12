/**
 * Matching a citizen against the scheme catalogue.
 *
 * Deterministic, like discovery for the curated registry: no model call. Three
 * layers, each only ever making the answer MORE cautious:
 *
 *   1. State and closing date - central schemes, plus state schemes for the
 *      citizen's state; schemes past their closing date are skipped.
 *   2. Facets - the source's own filter values (gender, caste, BPL, ...),
 *      mapped onto profile fields. A facet excludes a scheme only when the
 *      profile clearly contradicts it. When the profile is silent, the facet
 *      becomes something to confirm, never a reason to hide a scheme.
 *   3. Approved rules - when a reviewer has approved the scheme's rules for
 *      its CURRENT text, they are evaluated by the same engine as the curated
 *      registry (`evaluateScheme`).
 *
 * Verdicts:
 *   GREEN    approved rules all satisfied, nothing unmapped, nothing to confirm
 *   YELLOW   approved rules not contradicted, but something is undecided
 *   POSSIBLE no usable rules yet - "may be eligible, check the official page"
 *
 * Non-matches are not returned: 5,000 rows of "not for you" helps nobody.
 */

import type { Clock } from "@/lib/clock";
import { prisma as defaultDb } from "@/lib/db";
import { evaluateScheme, type Profile } from "@/lib/engine/rules";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { ClauseSpec, ProfileFieldKey } from "@/lib/registry/types";

import type { FacetMap } from "./types";

export type CatalogueVerdict = "GREEN" | "YELLOW" | "POSSIBLE";

export interface CatalogueMatch {
  externalId: string;
  source: string;
  name: string;
  nameHi: string | null;
  level: string;
  states: string[];
  categories: string[];
  ministry: string | null;
  briefDescription: string;
  officialUrl: string;
  closesOn: string | null;
  lastFetchedAt: string;
  verdict: CatalogueVerdict;
  /** Restrictions the citizen was positively matched on, e.g. "Widowed". */
  matchedOn: string[];
  /** What the citizen should confirm, in plain words. */
  toConfirm: string[];
  /** Approved rules that were evaluated. 0 means POSSIBLE. */
  rulesEvaluated: number;
}

export interface FacetOutcome {
  excludedBy: string | null;
  matched: string[];
  unknown: string[];
}

// ---------------------------------------------------------------------------
// Facets
// ---------------------------------------------------------------------------

type Answer = "match" | "mismatch" | "unknown";

const value = (profile: Profile, key: ProfileFieldKey) => profile[key]?.value;

const has = (profile: Profile, key: ProfileFieldKey) =>
  profile[key] !== undefined && profile[key]?.value !== null;

function text(profile: Profile, key: ProfileFieldKey): string {
  const v = value(profile, key);
  return typeof v === "string" ? v.toLowerCase() : "";
}

/** One answer per restrictive value; the scheme matches if any value does. */
type FacetRule = {
  /** Shown to the citizen when the profile cannot decide this facet. */
  confirm: string;
  answer: (label: string, profile: Profile) => Answer;
};

const byEquality =
  (field: ProfileFieldKey, labels: Record<string, string>) =>
  (label: string, profile: Profile): Answer => {
    if (!has(profile, field)) return "unknown";
    const mine = labels[String(value(profile, field)).toLowerCase()];
    if (mine === undefined) return "unknown";
    return mine === label ? "match" : "mismatch";
  };

const byFlag =
  (field: ProfileFieldKey) =>
  (label: string, profile: Profile): Answer => {
    if (label !== "Yes" || !has(profile, field)) return "unknown";
    return value(profile, field) === true ? "match" : "mismatch";
  };

/** Occupation labels and how a profile shows them. */
const OCCUPATIONS: Record<string, (profile: Profile) => boolean> = {
  Farmer: (p) => value(p, "isFarmer") === true || /farm|kisan|agricultur|cultivat/.test(text(p, "occupation")),
  "Dairy Farmer": (p) => /dairy|cattle|milk/.test(text(p, "occupation")),
  "Construction Worker": (p) => /construction|mason|brick/.test(text(p, "occupation")),
  "Unorganized Worker": (p) =>
    ["CASUAL_LABOUR", "SALARIED_INFORMAL"].includes(String(value(p, "employmentStatus"))) ||
    /labour|labor|domestic|daily wage/.test(text(p, "occupation")),
  "Organized Worker": (p) => value(p, "employmentStatus") === "SALARIED_FORMAL",
  Fishermen: (p) => /fish/.test(text(p, "occupation")),
  Artists: (p) => /artist|musician|painter|performer/.test(text(p, "occupation")),
  "Artisans, Spinners & Weavers": (p) => value(p, "isArtisan") === true || /weav|spinn|artisan|handloom/.test(text(p, "occupation")),
  "Khadi Artisan": (p) => /khadi/.test(text(p, "occupation")),
  Student: (p) => /student/.test(text(p, "occupation")),
  Sportsperson: (p) => /sport|athlet|player/.test(text(p, "occupation")),
  "Ex Servicemen": (p) => /ex.?service|veteran|retired (army|soldier)/.test(text(p, "occupation")),
  Journalist: (p) => /journalist|reporter/.test(text(p, "occupation")),
  "Safai Karamchari": (p) => /safai|sanitation|sweeper|manual scaveng/.test(text(p, "occupation")),
  "Teacher / Faculty": (p) => /teacher|faculty|lecturer|professor/.test(text(p, "occupation")),
  "Coir Worker": (p) => /coir/.test(text(p, "occupation")),
  "Street Vendor": (p) => /vendor|hawker|thela/.test(text(p, "occupation")),
  "Health Worker": (p) => /health worker|asha|nurse|anm\b/.test(text(p, "occupation")),
  "Lawyer / Law Graduate / Advocate": (p) => /lawyer|advocate|law graduate/.test(text(p, "occupation")),
};

function occupationAnswer(label: string, profile: Profile): Answer {
  const known = Object.hasOwn(OCCUPATIONS, label) ? OCCUPATIONS[label] : undefined;
  if (known?.(profile)) return "match";
  // A mismatch needs a profile occupation we actually understand; an
  // occupation we cannot place proves nothing about this scheme.
  const understood = Object.values(OCCUPATIONS).some((test) => test(profile));
  return understood && known !== undefined ? "mismatch" : "unknown";
}

const FACET_RULES: Record<string, FacetRule> = {
  gender: {
    confirm: "Your gender",
    answer: byEquality("gender", { female: "Female", male: "Male", other: "Transgender" }),
  },
  caste: {
    confirm: "Your social category (SC / ST / OBC / General)",
    answer: (label, profile) => {
      // PVTG is a subset of ST, and DNT is not recorded in the profile, so
      // neither can be decided from social category alone.
      if (label.includes("PVTG") || label.includes("DNT")) return "unknown";
      return byEquality("socialCategory", {
        sc: "Scheduled Caste (SC)",
        st: "Scheduled Tribe (ST)",
        obc: "Other Backward Class (OBC)",
        general: "General",
      })(label, profile);
    },
  },
  residence: {
    confirm: "Whether you live in a rural or urban area",
    answer: byEquality("ruralUrban", { rural: "Rural", urban: "Urban" }),
  },
  maritalStatus: {
    confirm: "Your marital status",
    answer: (label, profile) => {
      if (label === "Widowed" && value(profile, "isWidow") === true) return "match";
      return byEquality("maritalStatus", {
        single: "Never Married",
        married: "Married",
        widowed: "Widowed",
        divorced: "Divorced",
        separated: "Separated",
      })(label, profile);
    },
  },
  employmentStatus: {
    confirm: "Your employment status",
    answer: byEquality("employmentStatus", {
      salaried_formal: "Employed",
      salaried_informal: "Employed",
      government_service: "Employed",
      casual_labour: "Employed",
      self_employed: "Self-Employed/ Entrepreneur",
      unemployed: "Unemployed",
    }),
  },
  occupation: { confirm: "Your occupation", answer: occupationAnswer },
  disability: {
    confirm: "Whether you have a disability",
    answer: (label, profile) => {
      if (label !== "Yes" || !has(profile, "disabilityPercent")) return "unknown";
      return Number(value(profile, "disabilityPercent")) > 0 ? "match" : "mismatch";
    },
  },
  isBpl: {
    confirm: "Whether your household is below the poverty line (BPL card)",
    answer: (label, profile) => {
      if (label === "Yes" && value(profile, "rationCardType") === "AAY") return "match";
      return byFlag("hasBplCard")(label, profile);
    },
  },
  isGovEmployee: {
    confirm: "Whether you are a government employee",
    answer: byFlag("isGovernmentEmployee"),
  },
  isStudent: {
    confirm: "Whether you are a student",
    answer: (label, profile) => (label === "Yes" && /student/.test(text(profile, "occupation")) ? "match" : "unknown"),
  },
  minority: { confirm: "Whether you belong to a notified minority community", answer: () => "unknown" },
  isEconomicDistress: { confirm: "Whether your family is in economic distress", answer: () => "unknown" },
};

/** Test a scheme's facets against a profile. */
export function facetCheck(facets: FacetMap, profile: Profile): FacetOutcome {
  const matched: string[] = [];
  const unknown: string[] = [];

  for (const [identifier, labels] of Object.entries(facets)) {
    const rule = FACET_RULES[identifier];
    if (!rule || labels.length === 0) continue;

    const answers = labels.map((label) => ({ label, answer: rule.answer(label, profile) }));
    const hit = answers.find((a) => a.answer === "match");
    if (hit) {
      matched.push(hit.label);
    } else if (answers.every((a) => a.answer === "mismatch")) {
      return { excludedBy: `${identifier}: ${labels.join(" / ")}`, matched, unknown };
    } else {
      unknown.push(rule.confirm);
    }
  }

  return { excludedBy: null, matched, unknown };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** "Jammu & Kashmir" and "jammu and kashmir" are the same state. */
const stateKey = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/\s+/g, " ").trim();

type RuleRow = {
  code: string;
  kind: "ELIGIBILITY" | "EXCLUSION" | "DEPENDENCY";
  field: string;
  op: string;
  value: unknown;
  mandatory: boolean;
  text: string;
  status: string;
  sourceHash: string;
  reviewedAt: Date | null;
};

/**
 * The approved rules usable for this scheme right now, or null.
 *
 * Usable means: drafting finished, every rule drafted from the current text
 * has been reviewed (none left as DRAFT), and at least one was approved. A
 * half-reviewed rule set would be a partial picture presented as a whole one.
 */
export function usableRules(scheme: {
  contentHash: string;
  draftStatus: string;
  officialUrl: string;
  rules: RuleRow[];
}): ClauseSpec[] | null {
  if (scheme.draftStatus !== "DRAFTED") return null;
  const current = scheme.rules.filter((r) => r.sourceHash === scheme.contentHash);
  if (current.some((r) => r.status === "DRAFT")) return null;

  const approved = current.filter((r) => r.status === "APPROVED");
  if (approved.length === 0) return null;

  return approved.map((r) => ({
    code: r.code,
    kind: r.kind,
    field: r.field as ProfileFieldKey,
    op: r.op as ClauseSpec["op"],
    value: r.value,
    mandatory: r.mandatory,
    evidenceDocs: [],
    text: r.text,
    sourceName: "myScheme",
    sourceUrl: scheme.officialUrl,
    lastVerified: (r.reviewedAt ?? new Date(0)).toISOString().slice(0, 10),
  }));
}

const VERDICT_RANK: Record<CatalogueVerdict, number> = { GREEN: 0, YELLOW: 1, POSSIBLE: 2 };

export async function matchCatalogue(options: {
  profile: Profile;
  clock: Clock;
  db?: PrismaClient;
  limit?: number;
}): Promise<{ total: number; counts: Record<CatalogueVerdict, number>; matches: CatalogueMatch[] }> {
  const db = options.db ?? defaultDb;
  const { profile } = options;
  const today = options.clock.now();
  const state = text(profile, "state");

  const schemes = await db.catalogScheme.findMany({
    where: { status: "ACTIVE" },
    select: {
      externalId: true,
      source: true,
      name: true,
      nameHi: true,
      level: true,
      states: true,
      categories: true,
      ministry: true,
      briefDescription: true,
      officialUrl: true,
      closesOn: true,
      lastFetchedAt: true,
      facets: true,
      contentHash: true,
      draftStatus: true,
      unmappedCriteria: true,
      rules: {
        where: { status: { in: ["DRAFT", "APPROVED"] } },
        select: {
          code: true,
          kind: true,
          field: true,
          op: true,
          value: true,
          mandatory: true,
          text: true,
          status: true,
          sourceHash: true,
          reviewedAt: true,
        },
      },
    },
  });

  const matches: CatalogueMatch[] = [];

  for (const scheme of schemes) {
    if (scheme.closesOn && scheme.closesOn < today) continue;
    if (
      scheme.states.length > 0 &&
      state !== "" &&
      !scheme.states.some((s) => stateKey(s) === stateKey(state))
    ) {
      continue;
    }

    const facets = facetCheck(scheme.facets as FacetMap, profile);
    if (facets.excludedBy) continue;

    const toConfirm = [...facets.unknown];
    if (scheme.states.length > 0 && state === "") toConfirm.push("Which state you live in");

    let verdict: CatalogueVerdict = "POSSIBLE";
    const clauses = usableRules(scheme);

    if (clauses) {
      const evaluation = evaluateScheme({ code: scheme.externalId, clauses }, profile);
      if (evaluation.verdict === "RED") continue;

      for (const code of evaluation.unknownClauses) {
        const clause = clauses.find((c) => c.code === code);
        if (clause) toConfirm.push(clause.text);
      }
      // Conditions nobody could express as a rule keep the answer at YELLOW.
      toConfirm.push(...scheme.unmappedCriteria);

      verdict = evaluation.verdict === "GREEN" && toConfirm.length === 0 ? "GREEN" : "YELLOW";
    }

    matches.push({
      externalId: scheme.externalId,
      source: scheme.source,
      name: scheme.name,
      nameHi: scheme.nameHi,
      level: scheme.level,
      states: scheme.states,
      categories: scheme.categories,
      ministry: scheme.ministry,
      briefDescription: scheme.briefDescription,
      officialUrl: scheme.officialUrl,
      closesOn: scheme.closesOn?.toISOString().slice(0, 10) ?? null,
      lastFetchedAt: scheme.lastFetchedAt.toISOString(),
      verdict,
      matchedOn: facets.matched,
      toConfirm,
      rulesEvaluated: clauses?.length ?? 0,
    });
  }

  matches.sort(
    (a, b) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      // A scheme aimed squarely at this citizen before a general one.
      b.matchedOn.length - a.matchedOn.length ||
      a.toConfirm.length - b.toConfirm.length ||
      a.name.localeCompare(b.name),
  );

  const counts = { GREEN: 0, YELLOW: 0, POSSIBLE: 0 };
  for (const m of matches) counts[m.verdict] += 1;

  return { total: matches.length, counts, matches: matches.slice(0, options.limit ?? 50) };
}
