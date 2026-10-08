# AdhikarAI — Benefit Continuity Platform (MVP)

## Context

Government scheme *discovery* in India is a solved commodity — myScheme, dozens of
chatbots, countless directories. The unsolved problem is everything that happens
**after** discovery: applications that sit pending for months, rejections over a single
missing document, payments the government records as disbursed that never reach a bank
account, monthly benefits that silently stop in month three. A citizen who is told "you
are eligible for IGNOAPS" and nothing more has received information, not a benefit.

AdhikarAI closes that loop. It maintains a persistent baseline of what a citizen
*should* be receiving, then continuously reconciles that baseline against reality,
diagnoses gaps, plans corrective action, executes it under human approval, re-verifies
the outcome, and keeps watching.

**The load-bearing idea.** The system never collapses these four things into one value:

| | |
|---|---|
| What the citizen **should** get | `Entitlement.expectedAmount` |
| What the government **says** happened | `gov_*` tables, read only via adapter |
| What the citizen **reports** | `ReceiptVerification.citizenReport` |
| What evidence **proves** | `ReceiptVerification.evidenceResult` |

Most implementations of this idea have a `received: boolean`. That single modelling
mistake destroys the entire product thesis, because it forces *unknown* to become either
*received* or *missing* — and both are lies. Here, `UNKNOWN` is a first-class persisted
state and **never** arithmetically becomes zero.

**Intended outcome:** a working prototype whose demo visibly does not stop at
submission — it detects a gap, diagnoses it, plans, asks permission, acts, re-checks,
*fails*, re-diagnoses, escalates, recovers, and continues monitoring.

**Success metric:** benefits actually recovered, not applications submitted.

---

## Decisions already made (do not re-litigate during implementation)

| Decision | Choice | Consequence |
|---|---|---|
| Timeline | ~1 week | Build in §44 priority order; cut from the edges |
| Stack | Next.js 15 (App Router) + TypeScript strict + Postgres/Prisma | One deployable unit |
| LLM | Google Gemini, behind a provider interface | `stub` provider makes tests free + deterministic |
| Human approver | The citizen | One citizen UI + a separate labeled demo console |
| Registry | 10 central schemes, deep rules | Depth over breadth; every clause carries a source URL |
| Monitoring | Real external cron + simulated clock for demo | Loop is real; only the clock is faked, and it says so |
| Bank verification | Real Gemini vision, ephemeral, synthetic demo PDFs | No real financial data on stage |
| Demo data | One hero citizen spanning six lifecycle states | One screen proves the whole lifecycle |
| Testing | Engine unit tests + 10 service-layer scenario tests + 1 Playwright | Scenario tests are cheap because the gateway is deterministic |
| Auth | Persona selector, no login; authorization boundaries still real | Real auth drops in later without touching business logic |
| Hosting | **Vercel Hobby + Neon** (not droppable) | No long-lived process — see below |

### Explicitly cut from the spec, with reasons

- **Vector DB / RAG for scheme matching (§6).** For 10 schemes, semantic retrieval is
  strictly worse than structured filters plus a rule engine — slower, less explainable,
  and it undercuts the §26 evidence model. Retrieval stays deterministic; the LLM reasons
  over clauses it was *handed*, and never searches for them.
- **LLM self-reported confidence (§27).** A model asked "how confident are you, 0–1"
  returns a number that looks rigorous and means nothing. Confidence is derived
  deterministically from rule coverage instead — auditable and unit-testable.
- **Production auth / encryption-at-rest (§30).** Boundaries designed correctly, IAM not built.
- **Live government APIs (§6, §33).** Curated registry with real source URLs plus a
  loudly-labeled mock gateway. No invented endpoints.

### Agreed cut order if the week runs short

1. Voice input/output → 2. Hindi translation (i18n plumbing stays) → 3. Playwright pass.
Deployment and the core loop are never cut.

### Two spec tensions, resolved

- **§9 (discard raw documents) vs §26/§41 (evidence references + full audit trail).**
  `evidenceReference` points at a `ReceiptVerification` row holding only
  `{expectedAmount, matchedAmount, matchedOn, refLast4, docSha256, method}` — never a
  file path, never a stored document. The hash proves *a* document was seen without
  retaining it.
- **§22 (don't build fake agents) vs §42 (demonstrate agency).** Agency lives in the
  orchestrated loop and in **re-planning after failure**, not in the agent count. One
  LLM service with distinct grounded prompts, driven by a deterministic state machine.

---

## Architecture

### Principle: deterministic core, LLM at the edges

`lib/engine/**` contains **zero LLM calls** — pure functions over typed inputs. Money,
state transitions, reconciliation and eligibility aggregation live there. `lib/agents/**`
wraps the LLM and may only return schema-validated structured output that the engine then
checks. A CI test asserts `lib/engine/` imports nothing from `lib/llm/` or `lib/agents/`.

```
adhikarai/
  app/
    page.tsx                     # persona selector (demo entry)
    onboard/                     # chat intake, voice-enabled
    dashboard/                   # hero screen: metrics + benefit cards
    benefit/[id]/                # lifecycle timeline, evidence drawer, "Why?"
    approve/[id]/                # approval gates 1 and 2
    verify/[paymentId]/          # YES / NO / NOT SURE + bank upload
    demo/                        # labeled DEMO console
    api/
      profile/ entitlements/ applications/ benefits/
      action-plans/ actions/ verify/ loop/ monitoring/ demo/
  lib/
    engine/      money stateMachine rules confidence reconciler continuity gaps ledger
    agents/      profile discovery application rootCause actionPlanner explainer
    llm/         provider.ts gemini.ts stub.ts schema.ts
    adapters/    govGateway.ts mockGovGateway.ts grievance.ts notification.ts
    registry/    schemes/*.ts   (10 schemes + rule clauses + source metadata)
    clock.ts     orchestrator.ts authz.ts
  prisma/schema.prisma
  messages/{en,hi}.json
  tests/{unit,scenarios,e2e}
  docs/specs/   # this document, copied in as step 1
```

### The two-store design — the architecture embodying §47

The government's view and the citizen's view live in **physically separate tables**,
because the entire product exists for the case where they disagree.

- `gov_application`, `gov_disbursement`, `gov_status_event` — the simulated portal's truth.
- Everything else — the citizen's truth.
- Engine and agents may **only** reach `gov_*` through the `GovGateway` interface, never
  via direct Prisma. Swapping in a real API is therefore a one-file change. Enforced by test.
- The demo console mutates `gov_*` exclusively, which is why it can create a genuine
  disagreement rather than a staged one.

### Serverless consequences (Vercel Hobby)

No long-lived process and a 60s function ceiling, so:

1. **The agent loop is decomposed into short idempotent steps.**
   `POST /api/loop/step {caseId, idempotencyKey}` advances **exactly one** state
   transition and returns the new state. The UI and the cron tick each drive it by
   repeated calls. States awaiting human approval block until an `Approval` row exists.
   This satisfies §40 for free and suits the two approval gates better than one long call.
2. **Monitoring runs off an external pinger.** A GitHub Actions workflow on a 5-minute
   cron calls `POST /api/monitoring/tick` with `Authorization: Bearer $CRON_SECRET`. The
   tick processes a bounded batch (≤25 ledger rows) and returns, so it never times out.
   A Vercel Cron daily entry acts as backstop.
3. **`docker compose` stays working locally** as a stage fallback, where a real in-process
   60s scheduler is used instead. Same tick code, different trigger.

### Simulated clock

`lib/clock.ts` exports `now()`, reading an offset from a single `DemoClock` row. **All**
engine and agent code uses `now()`; `new Date()` is banned outside `clock.ts` and a test
enforces it. The demo console advances the offset, which is what makes a three-month
continuity gap appear on stage in ten seconds. Every UI surface reading a simulated date
renders a `DEMO CLOCK` badge.

---

## The deterministic engine

### Money

Integers in paise throughout. No floats anywhere in financial paths. `money.ts` owns
parsing, formatting (`₹2,000`), and arithmetic. Prisma columns are `BigInt`.

### Rule clauses — grounded and sourced

```ts
type RuleClause = {
  id: string; schemeId: string
  kind: 'ELIGIBILITY' | 'EXCLUSION' | 'DEPENDENCY'
  field: ProfileFieldKey                 // 'age' | 'landHoldingHectares' | ...
  op: 'gte'|'lte'|'eq'|'in'|'not_in'|'between'|'exists'
  value: unknown
  mandatory: boolean
  evidenceDocs: string[]                 // documents that would prove this
  text: string                           // official clause wording
  sourceUrl: string; sourceName: string; lastVerified: string
}
```

Every profile field carries **provenance**, which is what makes GREEN vs YELLOW honest:

`DOCUMENT_VERIFIED` (1.0) · `SELF_DECLARED` (0.7) · `INFERRED` (0.5) · `MISSING` (0)

Per-clause result: `SATISFIED | VIOLATED | UNKNOWN`. Aggregation to the §6 states:

| Condition | Result |
|---|---|
| Any mandatory clause `VIOLATED`, or any `EXCLUSION` satisfied | **RED** — not eligible |
| All mandatory `SATISFIED` | **GREEN** — eligible |
| No violation, but ≥1 mandatory `UNKNOWN`/`MISSING` | **YELLOW** — potentially eligible |

### Confidence — derived, not asked

```
confidence = Σ(weight(provenance) for mandatory clauses) / count(mandatory clauses)
```

Returned with `missingEvidence[]` naming exactly which clauses dragged it down. Testable,
explainable, and it cannot hallucinate.

### The reconciler — the heart of the product

```ts
type ReceiptState =
  | 'NOT_DISBURSED'
  | 'DISBURSED_RECEIPT_UNVERIFIED'   // YELLOW
  | 'CITIZEN_CONFIRMED'              // BLUE
  | 'VERIFIED_RECEIVED'              // GREEN
  | 'PAYMENT_DISCREPANCY'            // RED
```

Truth table over four independent inputs:

| Expected | Govt reports | Citizen says | Evidence | → Receipt state | gapAmount |
|---|---|---|---|---|---|
| ₹2,000 | not disbursed | — | — | `NOT_DISBURSED` | 0 (not yet due) |
| ₹2,000 | ₹2,000 | *(no answer)* | none | `DISBURSED_RECEIPT_UNVERIFIED` | **0** |
| ₹2,000 | ₹2,000 | NOT SURE | none | `DISBURSED_RECEIPT_UNVERIFIED` | **0** |
| ₹2,000 | ₹2,000 | YES | none | `CITIZEN_CONFIRMED` | 0 |
| ₹2,000 | ₹2,000 | YES / any | matched ₹2,000 | `VERIFIED_RECEIVED` | 0 |
| ₹2,000 | ₹2,000 | NO | none | `PAYMENT_DISCREPANCY` | 2,000 |
| ₹2,000 | ₹2,000 | NO | no match found | `PAYMENT_DISCREPANCY` | 2,000 |
| ₹2,000 | ₹2,000 | YES | matched ₹1,200 | `PAYMENT_DISCREPANCY` | 800 |
| ₹2,000 | ₹1,200 | YES | matched ₹1,200 | `PAYMENT_DISCREPANCY` | 800 |

**The rule that matters most:** rows 2 and 3 produce `gapAmount = 0`, not 2,000. Unknown
receipt is reported as *unverified*, never as missing money. A dedicated unit test asserts
no input combination yields a non-zero gap without positive evidence of absence.

### Continuity audit

Each scheme declares a schedule generator (`MONTHLY | QUARTERLY | TRIANNUAL | ONE_TIME`
plus anchor dates). On entitlement creation the engine materializes `ExpectedPayment`
rows forward. The continuity check joins expected against actual and emits gaps:

```
expected ₹600/mo:  Jan ✓   Feb ✓   Mar ✗   Apr ✓
→ BenefitGap { kind: PAYMENT_MISSED, period: '2026-03', amount: 60000 }
```

Also detects delays (received, but late beyond tolerance), interruptions (≥2 consecutive
misses), and renewals coming due.

### State machine

The §24 states as an explicit `Record<State, State[]>` transition table.
`assertTransition(from, to)` throws on an illegal move; every successful transition writes
an `AuditLog` row with actor, reason, evidence reference and both states. Nothing anywhere
else may write a status field directly — enforced by keeping status mutation inside
`engine/stateMachine.ts`.

### Gap classification (§12)

`NEVER_APPLIED · APPLICATION_PENDING_TOO_LONG · REJECTED · BLOCKED · MISSING_DOCUMENT ·
PAYMENT_MISSED · PAYMENT_DELAYED · PAYMENT_INTERRUPTED · UNCLAIMED · RECEIPT_UNVERIFIED ·
RENEWAL_MISSED · STATUS_UNKNOWN`

Each gap carries `kind`, `amount` (nullable — *never* a guess), `evidence[]`, `detectedAt`.

---

## The LLM layer

`lib/llm/provider.ts` defines one interface: `generateStructured<T>(prompt, zodSchema)`
and `generateFromDocument<T>(buffer, mimeType, prompt, zodSchema)`. Implementations:
`gemini.ts` and `stub.ts` (deterministic fixtures — used by every test and by dev with no
key, so the whole loop runs at zero API cost).

Every call validates against a Zod schema, retries once on validation failure with the
error appended, then fails to `NEEDS_HUMAN_REVIEW` rather than guessing. Model output is
*never* trusted for amounts, states, or authorization.

| Agent | Job | Grounded in | May NOT |
|---|---|---|---|
| Profile | chat/voice/docs → structured profile + provenance per field | user input, OCR | invent fields; set `DOCUMENT_VERIFIED` without a document |
| Discovery | reason over *retrieved* clauses, explain each verdict | clause text handed to it | decide GREEN/YELLOW/RED — the engine does |
| Application | pre-fill form fields, list missing documents | profile + scheme form schema | submit anything |
| Root cause | interpret status/rejection text → cause + evidence | gov status events, audit findings | propose a cause with no supporting evidence |
| Action planner | ordered corrective steps + expected outcome | gap + root cause + scheme rules | execute |
| Explainer | render everything in simple Hindi/English | engine output only | restate numbers it wasn't given |

**Root-cause honesty rule:** the agent must cite at least one evidence row; with none, it
must return `UNKNOWN`. Enforced in code, not in the prompt.

---

## Privacy-preserving bank verification (§9, §48)

`POST /api/verify/bank-evidence` — `runtime = 'nodejs'`, multipart into a memory Buffer:

```
read into Buffer (never written to disk)
  → sha256(buffer)
  → Gemini vision, single turn, prompt extracts ONLY transactions where
      |amount − expectedAmount| ≤ tolerance  AND  date ∈ [expected − 15d, expected + 30d]
  → buffer dereferenced
  → persist ReceiptVerification {
      expectedAmount, matchedAmount, matchedOn,
      refLast4, status, method: 'BANK_EVIDENCE', docSha256, verifiedAt }
```

No statement, no balances, no unrelated transactions, no file. A test asserts the handler
performs no `fs` write, and a redaction helper keeps document bytes and extracted
transaction text out of every log line. The UI states plainly that the file is processed
and discarded, and never claims deletion from every possible backup.

---

## Data model (Prisma)

**Citizen side** — `Citizen · CitizenProfile · ProfileField(value, provenance, sourceDocId)
· Document(metadata only) · Scheme · RuleClause · Entitlement · ExpectedPayment ·
Application · ApplicationField · ApplicationDocument · Approval · BenefitAudit ·
AuditFinding · BenefitGap · RootCause · ActionPlan · ActionStep · ActionExecution ·
Payment · ReceiptVerification · BenefitLedger · MonitoringEvent · Notification · AuditLog`

**Government side (mock)** — `GovApplication · GovDisbursement · GovStatusEvent`

**Demo** — `DemoClock · DemoPersona`

Every row has `id`, `createdAt`, `updatedAt`. Status columns are Prisma enums mirroring
§24. `Document` stores only `{filename, mimeType, kind, sha256, uploadedAt}` — bytes are
never persisted. `BenefitLedger` is the §19 projection feeding dashboard, monitoring and
re-audit.

---

## Frontend

Tailwind + a small local component set. Every citizen-facing surface follows §37: simple
language, large targets, status as colour **plus** text plus icon (never colour alone),
and technical detail hidden behind an expandable **"Why?"** drawer showing clause text,
source URL, `lastVerified`, provenance and confidence.

The hero dashboard shows Kamala Devi's six simultaneous states so one screen proves the
lifecycle. Gap figures are worded per §36 — "Potential", "Estimated", "Unverified" — and
an unverified receipt is never rendered as a confirmed loss.

i18n via a flat dictionary in `messages/{en,hi}.json`; voice via the browser Web Speech
API (`hi-IN` / `en-IN`) on the intake chat and the YES/NO/NOT SURE confirmation only.

All mock-sourced data renders a `DEMO DATA` badge. The demo console is visually distinct
and labeled so it can never be mistaken for citizen-facing product.

---

## Implementation sequence

Follows §44 priorities so that anything cut is at the edges. TDD on the engine: tests
first there, since that is where a silent bug is catastrophic.

**Day 1 — Foundation.** Copy this spec to `docs/specs/`. `git init`. Scaffold Next.js +
TS strict + Tailwind. `docker compose` Postgres for dev, Neon for deploy. Full Prisma
schema + migration. `clock.ts`. `money.ts`. Seed the 10 schemes with rule clauses and real
source URLs. *Gate: `prisma migrate` clean, seed loads, `money` + `clock` tests pass.*

**Day 2 — Engine (TDD).** `rules`, `confidence`, `reconciler`, `continuity`, `gaps`,
`stateMachine`, `ledger` with unit tests written first. Include the boundary tests: no
non-zero gap without evidence of absence; no illegal transition; no float in money paths.
*Gate: full reconciler truth table green.*

**Day 3 — Priority 1.** LLM provider + stub + Zod validation. Profile and Discovery
agents. `/onboard` chat intake. `POST /api/entitlements/discover` → entitlements with
expected amounts, schedules, evidence and confidence. *Gate: profile in, ranked GREEN/
YELLOW/RED entitlements out, each explainable.*

**Day 4 — Priority 2 + 3.** Application agent, approval gate 1, mock gov gateway,
submission with idempotency key. Benefit Audit agent: status, approval, payment, receipt
and continuity audits producing findings and gaps. *Gate: apply → approve → submit →
audit detects a gap.*

**Day 5 — Priority 4 + 5.** Root cause, audit decision (HEALTHY / NEEDS VERIFICATION /
ACTION REQUIRED), action planner, approval gate 2, action agent with adapters,
re-verification agent, ledger updates, orchestrator step endpoint. *Gate: the full
failure→re-diagnose→escalate→recover loop runs end to end.*

**Day 6 — Priority 6 + UI.** Dashboard, benefit cards, lifecycle timeline, verify screens,
bank-evidence upload, demo console with time travel, monitoring tick, GitHub Actions cron.
*Gate: advancing the clock three months surfaces a continuity gap and auto-triggers re-audit.*

**Day 7 — Harden and ship.** The 10 scenario integration tests. Hindi strings. Voice on
two screens. Deploy to Vercel + Neon. Playwright happy path. Synthetic bank statement
PDFs. README with setup and env documentation. Demo script.

---

## Demo data

**Kamala Devi, 67, rural** — one dashboard, six lifecycle states (§34 scenarios 1–7):

| Scheme | Expected | State | Scenario |
|---|---|---|---|
| PM-KISAN | ₹2,000 | `VERIFIED_RECEIVED` | 1 — healthy |
| NFSA ration | in-kind | `DISBURSED_RECEIPT_UNVERIFIED` | 2 — needs verification |
| IGNOAPS | ₹600/mo | `PAYMENT_DISCREPANCY` | 3 — govt paid, she did not receive |
| PMAY-G | ₹1.2L | `REJECTED` (missing document) | 4 — action required |
| PM-JAY | ₹5L cover | `PENDING` 94 days | 5 — stuck, escalate |
| PMMVY | — | `NEVER_APPLIED` | 6 — unclaimed |
| IGNOAPS history | ₹600/mo | March missing | 7 — continuity gap |

**The live run (scenario 8)** drives IGNOAPS the whole way: gap → root cause (Aadhaar–bank
seeding mismatch) → action plan → citizen approval → execute → re-verify → **still
unresolved** → re-diagnose → escalate grievance → re-verify → recovered → ledger updated →
monitoring resumes. The deliberate first failure is the point: it is what distinguishes a
loop from a pipeline.

Two secondary personas cover the remaining edge scenarios.

---

## Verification

```bash
docker compose up -d && npx prisma migrate dev && npm run seed
npm run test:unit          # engine: money, rules, confidence, reconciler, continuity, gaps, stateMachine
npm run test:scenarios     # all 10 §34/§54 scenarios, service layer, stub LLM + mock gateway
npm run test:boundaries    # engine imports no LLM; no new Date() outside clock.ts;
                           # gov_* reached only via adapter; no fs write in bank handler
npm run test:e2e           # Playwright happy path (droppable)
npm run dev                # manual walkthrough
```

**Manual end-to-end acceptance** — the §53 definition of done, in order: onboard Kamala by
chat → review ranked entitlements with "Why?" evidence → prepare the PMMVY application →
approve gate 1 → submit → audit → demo console releases an IGNOAPS payment → citizen
answers NO → `PAYMENT_DISCREPANCY` → root cause → action plan → approve gate 2 → execute →
re-verify fails → re-diagnose → escalate → upload a synthetic bank statement → verified →
recovered → ledger reflects the recovery → advance the clock three months → continuity gap
auto-detected → re-audit fires without being asked.

**Final check:** the dashboard must at no point display an unverified receipt as either
received or missing. If it ever does, the core thesis is broken regardless of what else works.

### Environment variables

| Name | Purpose |
|---|---|
| `DATABASE_URL` | Neon (prod) / Docker Postgres (dev) |
| `GEMINI_API_KEY` | Omit to run entirely on the deterministic stub provider |
| `LLM_PROVIDER` | `gemini` \| `stub` |
| `CRON_SECRET` | Bearer token for `/api/monitoring/tick` |
| `DEMO_MODE` | Gates the demo console and clock controls |

No secrets committed; `.env.example` documents all five.
