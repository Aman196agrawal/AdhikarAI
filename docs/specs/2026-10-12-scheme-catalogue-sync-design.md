# Scheme catalogue sync — design

**Date:** 2026-10-12 · **Status:** implemented on `myscheme-sync` (see Implementation notes) · **Branch:** `myscheme-sync`

## Goal

Every scheme a citizen could benefit from — about 4,700 central and state
schemes listed on myScheme — is in our database, and it never goes stale
silently. Discovery is where the whole lifecycle starts; if the scheme list is
wrong or out of date, nothing after it matters.

## Decisions already made

| Decision | Choice |
|---|---|
| Purpose | Real use by citizens, not only the hackathon |
| Access | **A + B**: build against the myScheme website's API now; apply to API Setu in parallel and swap the source when approved |
| Rule review | **Team reviews** AI-drafted rules before they can produce a firm "eligible" |
| Freshness | Nightly sync, content fingerprints, rules expire automatically when their source text changes |

Conditions on route B: polite rate (about 1 request per second), the API key
only in `.env` / repository secrets (`MYSCHEME_API_KEY`), myScheme credited
wherever its content appears, and a permission request emailed to myScheme.
myScheme's copyright policy allows reproduction free of charge when the
material is reproduced accurately and the source is prominently acknowledged.

## What myScheme provides

- **Search** — `GET api.myscheme.gov.in/search/v6/schemes?lang=&q=<filters JSON>&keyword=&from=&size=`
  returns paged hits with `slug`, `schemeName`, `schemeShortTitle`,
  `briefDescription`, `schemeCategory`, `nodalMinistryName`, `level`,
  `beneficiaryState`, `tags`, `schemeFor`. Filters (`q`) cover gender, caste,
  age range, residence, occupation, disability, minority, student, marital
  status, state and level.
- **Detail** — `GET api.myscheme.gov.in/schemes/v6/public/schemes?slug=&lang=en|hi`
  returns `basicDetails`, `schemeContent` (description, `benefits_md`,
  references), `eligibilityCriteria.eligibilityDescription_md`,
  `applicationProcess` (including documents required).

Eligibility and benefit amounts are **prose**, not rules. Field names above
come from an open-source client of the website's API and are **not yet
confirmed against a live response** — see "Open item" below. All parsing is
tolerant: unknown fields are ignored, missing ones become null.

## Architecture

```
SchemeSource (interface)
 ├─ MySchemeWebSource   route B, now
 └─ ApiSetuSource       route A, when access is approved (same interface)
        │
        ▼
syncSchemes()  — run nightly by GitHub Actions (`npm run sync:schemes`)
  1. list every scheme, page by page
  2. fetch English detail for each; Hindi only when English content changed
  3. normalise + fingerprint (sha256 of a stable JSON of the normalised content)
  4. classify: NEW / CHANGED / UNCHANGED; listed-before-but-missing → WITHDRAWN
  5. NEW or CHANGED → store a snapshot, update the catalogue row,
     mark that scheme's existing rules STALE, queue it for rule drafting
  6. record a SchemeSyncRun with counts and per-scheme errors
        │
        ▼
draftRules()  — AI turns eligibility prose into DRAFT rules (same nightly job)
        │
        ▼
Admin review (/admin/catalogue) — team approves / edits / rejects DRAFT rules
        │
        ▼
Discovery — tracked schemes (unchanged) + catalogue matches (new)
```

### Change from the conversational design

Section 1 proposed putting myScheme schemes into the existing `Scheme` table.
That table carries fields that only make sense for a benefit we track payment
by payment (frequency, instalment amount, form schema), and filling them with
placeholders for 4,700 schemes would silently corrupt the continuity audit.
So myScheme data lives in **separate catalogue tables**, and a catalogue entry
can be linked to a tracked scheme by code. The ten curated schemes, and every
module that reads them, are unchanged.

## Data model (new tables)

**`CatalogScheme`** — one row per external scheme.
`source` + `externalId` (myScheme slug) unique; `name`, `nameHi`,
`shortTitle`, `level`, `states[]`, `categories[]`, `ministry`, `tags[]`,
`briefDescription`, `eligibilityMd`, `benefitsMd`, `documentsMd`,
`applicationProcessMd`, `hindi` (JSON of the same texts), `officialUrl`,
`referenceUrls[]`, `contentHash`, `status` (`ACTIVE` / `WITHDRAWN`),
`firstSeenAt`, `lastFetchedAt`, `lastChangedAt`, `withdrawnAt`,
`unmappedCriteria[]` (eligibility conditions the drafter could not turn into a
rule), `draftStatus` (`PENDING` / `DRAFTED` / `FAILED`), `trackedSchemeCode`
(links to a curated `Scheme.code`, e.g. `PM-KISAN`).

**`CatalogSnapshot`** — immutable history: `catalogSchemeId`, `contentHash`,
`fetchedAt`, `payload` (the normalised content that was fingerprinted). Unique on (scheme, hash).

**`CatalogRule`** — a drafted or approved rule, in exactly the shape of the
existing `ClauseSpec` (`kind`, `field`, `op`, `value`, `mandatory`, `text`) so
the existing `evaluateClause` engine evaluates it unchanged. Plus
`sourceQuote` (the sentence it came from), `sourceHash` (the `contentHash` it
was drafted from), `status` (`DRAFT` / `APPROVED` / `REJECTED` / `STALE`),
`draftedBy` (`ai` / `human`), `reviewedBy`, `reviewedAt`.

**`SchemeSyncRun`** — `source`, `startedAt`, `finishedAt`, `status`
(`RUNNING` / `SUCCEEDED` / `PARTIAL` / `FAILED`), counts (`listed`, `created`,
`changed`, `unchanged`, `withdrawn`, `failed`), `errors` (JSON, capped).

## Freshness rules

1. A rule is used only while `status = APPROVED` **and** `sourceHash` equals
   the scheme's current `contentHash`. A changed source text therefore
   disables its rules immediately, before anyone re-reviews them.
2. A withdrawn scheme is marked, never deleted.
3. A failed or partial sync keeps the last good data. Every catalogue result
   carries `lastFetchedAt`; the UI shows it.
4. A scheme missing from one listing is not withdrawn until it is missing
   from **two consecutive successful** syncs, so a flaky page cannot withdraw
   schemes.
5. A sync whose listing returns fewer than 50% of the previously active
   schemes is treated as a source failure: nothing is withdrawn, the run is
   `FAILED`.
6. When a catalogue scheme linked to a tracked scheme changes, the tracked
   scheme is flagged for re-verification (logged and visible in admin).

## Rule drafting (AI)

New agent `lib/agents/ruleDrafter.ts`, same pattern as the existing agents:
Zod schema, the existing `generateValidated` retry, the stub provider in
tests. Input: the eligibility text and the list of allowed profile fields and
operators. Output: rules + `unmapped[]`. Code then:

- rejects any rule whose field or operator is not in the allowed lists, or
  whose `sourceQuote` does not appear in the eligibility text;
- saves the survivors as `DRAFT` with `sourceHash = contentHash`;
- on model failure sets `draftStatus = FAILED` and drafts nothing.

The drafter never produces `APPROVED`. Only a human review does.

## Discovery

`evaluateEntitlements` for tracked schemes is unchanged. A new
`matchCatalogue(profile)` returns catalogue matches:

- **State pre-filter**: central schemes, plus state schemes whose `states`
  contains the citizen's state.
- **With usable approved rules** (rule 1 above): evaluated by
  `evaluateClause`; verdict GREEN / YELLOW / RED by the same logic as tracked
  schemes. GREEN additionally requires `unmappedCriteria` to be empty —
  otherwise the best possible verdict is YELLOW.
- **Without usable rules**: verdict `POSSIBLE` — "may be eligible, check the
  official page". Never GREEN.
- Every match carries `officialUrl`, `lastFetchedAt`, and "Source: myScheme".
- RED catalogue matches are not returned (4,700 rows of "not for you" helps
  nobody); tracked-scheme REDs still are.

Catalogue matches are returned by a new endpoint and shown in a separate
"More schemes you may qualify for" section. They are **not** persisted as
`Entitlement` rows, because entitlements feed the payment audit and these
schemes have no payment model.

## Admin review

`/admin/catalogue`: list schemes with DRAFT or STALE rules (most recently
changed first), show the eligibility text beside the drafted rules, approve /
edit / reject each. Protected by `ADMIN_TOKEN` (header or cookie); with no
`ADMIN_TOKEN` set, the admin routes return 404. This is a stopgap until real
authentication exists.

## Operations

- `npm run sync:schemes` — full sync (`--limit N` for a partial run,
  `--no-draft` to skip AI drafting).
- `.github/workflows/scheme-sync.yml` — nightly at 02:30 IST, `timeout-minutes: 300`,
  `concurrency: scheme-sync`. Secrets: `DATABASE_URL`, `MYSCHEME_API_KEY`,
  `GEMINI_API_KEY`.
- Client: 1 request/second, 30 s timeout, 3 retries with exponential backoff
  on 429/5xx/network errors, identifying `User-Agent`.

## Testing

All tests run without network, against a `FakeSchemeSource` and recorded
fixtures:

- normalisation and fingerprinting (stable across key order, changes on text change);
- sync classification: new, changed, unchanged, withdrawn (two-strikes rule),
  mass-disappearance guard, per-scheme fetch errors → `PARTIAL`;
- rules go STALE when source text changes; stale rules are not used;
- drafter: invalid field/operator dropped, invented quote dropped, model failure → `FAILED`;
- discovery: POSSIBLE without rules, GREEN only with approved+fresh rules and no unmapped criteria;
- admin: 404 without `ADMIN_TOKEN`, 401 with a wrong token, approve/reject transitions.

## Implementation notes (2026-10-12)

What changed between this design and the code, and why:

- **Endpoint verified.** A search response captured from a team member's
  browser shows the site now calls `GET www.myscheme.gov.in/api/apisetu/search/schemes`
  (not `api.myscheme.gov.in/search/v6`). It is saved as
  `tests/fixtures/myscheme/search-page-0.json` and the search parser is fitted
  to it: 5,102 schemes, pages of 10.
- **Facets are derived, not read.** Search hits carry state and level but not
  gender, caste, BPL and so on; the response only has overall counts. So the
  source runs one filtered search per restrictive value (about 700 page
  requests a night) and records which schemes each returns. If a filtered
  search returns the whole catalogue, the filter was ignored and is skipped.
  If one fails, the sync keeps the previously stored values for that filter.
- **Snapshots store the normalised content**, not the raw response: exactly
  what was fingerprinted, a few KB each, so ~5,100 snapshots stay small enough
  for the Neon free tier.
- **Drafting runs as a second step** of the same nightly script
  (`draftPendingRules`), not inside the sync, and is skipped entirely when no
  real model is configured: stub drafts must never reach a real review queue.
- **A rule set counts only when fully reviewed**: no DRAFT left for the current
  text, and at least one APPROVED. REJECTED rules do not cap the verdict; the
  reviewer clears or keeps unmapped conditions explicitly.

## Open items

- **Detail endpoint unverified.** The default `/api/apisetu/schemes?slug=&lang=`
  and its field names are still from the open-source client. Parsing is
  tolerant and a failed detail never erases stored text, but one detail
  response should be captured into `tests/fixtures/myscheme/` and the parser
  fitted to it before the first full run.
- **Filter query format unverified.** `q=[{"identifier":"gender","value":"Female"}]`
  is also from the open-source client. The ignored-filter guard makes a wrong
  format harmless (no facets recorded) but useless; capture one filtered
  search URL to confirm.
- **Tracked-scheme links.** Only `igndps → NSAP-IGNDPS` is confirmed; other
  curated schemes need their myScheme slugs confirmed before linking.
- **Permission and API Setu.** The email to myScheme and the API Setu
  application are with the team.

## Out of scope

- Turning catalogue schemes into tracked, payment-audited benefits (stays a
  curated step in `lib/registry/schemes.ts`).
- Application filing for catalogue schemes (link to the official page instead).
- Real authentication.
