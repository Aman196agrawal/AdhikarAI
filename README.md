# AdhikarAI

**Finding your benefits isn't enough. AdhikarAI makes sure you receive them.**

Government scheme *discovery* in India is a solved problem. The unsolved part is
everything after it: applications that sit pending for months, rejections over a
single missing document, payments the government records as disbursed that never
reach a bank account, monthly pensions that silently stop in month three.

AdhikarAI maintains a baseline of what a citizen *should* be receiving and then
continuously reconciles it against reality — diagnosing gaps, planning
corrective action, executing it under human approval, re-verifying the outcome,
and carrying on watching.

---

## The one idea everything else rests on

Four things are tracked separately and never merged:

| | |
|---|---|
| What the citizen **should** get | `Entitlement.expectedAmountPaise` |
| What the government **says** happened | the `gov_*` tables, read only via an adapter |
| What the citizen **reports** | `ReceiptVerification.citizenReport` |
| What the evidence **proves** | `ReceiptVerification.evidenceResult` |

Most implementations of this idea have a `received: boolean`. That single
modelling decision is fatal, because it forces *unknown* to be recorded as
either *received* or *missing* — and both are false.

Here `UNKNOWN` is a first-class persisted state, and the rule is enforced by an
exhaustive test: **an amount is only ever counted as missing with positive
evidence of absence.** A payment nobody has confirmed is reported as
*unverified*, never as lost.

---

## Quick start

Requires Node 20.9+, Docker, and about two minutes.

```bash
npm install
npm run db:up          # Postgres on host port 5433
cp .env.example .env   # works as-is for local development
npx prisma migrate dev
npm run seed:all       # scheme registry, then the demo citizens
npm run dev
```

Open <http://localhost:3000> and pick a persona.

**No API key is needed.** `LLM_PROVIDER=stub` runs the entire closed loop on
deterministic fixtures. Set `LLM_PROVIDER=gemini` and a `GEMINI_API_KEY` to use
the real model.

### Running the tests

```bash
npm run db:test        # creates and migrates a SEPARATE test database
npm test               # 398 tests
npm run smoke          # load every page against a running server
```

`npm run smoke` exists because of a real miss. Passing a function across the
Server/Client Component boundary is invalid in React, and it made the dashboard
return 500 — while typecheck was clean, `next build` succeeded, and every test
passed. None of those execute a page render. The smoke check is the floor
beneath the test suite: start the server, load every route in both languages,
assert a 200 and that the expected content is actually there.

The scenario tests clear citizen data between cases, so they use their own
database. Without that, running the suite would delete your demo personas —
which is a bad thing to discover on a demo day.

> It has to be a separate *database*, not a separate schema. Prisma 7 requires a
> driver adapter, and plain `pg` ignores the Prisma-specific `?schema=`
> parameter. The CLI still honours it, so migrations land in the named schema
> while the running client quietly keeps writing to `public` — which looks
> exactly like working isolation right up until the data disappears.

---

## What to look at first

**The dashboard** shows four money figures side by side, each with its own
hedge, and never sums them:

- **Received** — confirmed by the citizen or proven by evidence
- **Not yet confirmed** — reported as sent, unconfirmed. *Not missing.*
- **Did not arrive** — proven absent, with evidence
- **You may be entitled to** — a projection from eligibility, not money owed

**The receipt question** is the signature interaction. Three buttons of equal
size and weight: *Yes*, *No*, *Not sure*. None is styled as the primary action,
because nudging someone toward "yes" would manufacture false confirmations from
exactly the users least able to check. "Not sure" is a normal answer, and for
this audience frequently the only honest one.

**Any "Why?" drawer** opens onto the actual rule text, its official source URL,
and the date it was checked — plus whether each fact came from a document, from
what the citizen said, or was inferred.

---

## The demo

Kamala Devi, 67, a widow in rural Bihar, carries six lifecycle states at once:

| Scheme | State |
|---|---|
| PM-KISAN | received, verified against bank evidence |
| NSAP-IGNOAPS | Feb confirmed · **Mar missing** · Apr unanswered · **May did not arrive** |
| NSAP-IGNWPS | eligible, never claimed |
| PMAY-G | rejected, income certificate missing |
| PM-JAY | pending 94 days, no decision |
| NFSA | approved, in-kind — no rupee value asserted |
| PMMVY | correctly excluded (she is 67; the scheme requires under 55) |

That last row matters as much as the others: the engine *rejects* schemes with a
citable reason rather than spraying everything at everyone.

**All of this was produced by running the real pipeline**, not by inserting
rows — see `prisma/seed-demo.ts`. Hand-written demo data can show states the
engine could never actually reach, and proves nothing.

### The live run

From the dashboard, drive the IGNOAPS discrepancy through the whole loop:

```
gap → diagnose → plan → approve → act → re-verify → STILL BROKEN
    → re-diagnose (without repeating what failed) → escalate → recover
```

The first corrective action failing is deliberate. A loop that succeeds on the
first attempt is indistinguishable from a pipeline, and the claim being made
here is that this is a loop. `tests/scenarios/recovery.test.ts` asserts the
whole sequence.

The **demo console** (`/demo`) drives the two things that are simulated: the
government portal and the clock. Advancing the clock three months makes the real
monitor re-audit over a later "now" and reach its own conclusions — the benefit
data is not touched.

---

## Architecture

```
app/              screens and API routes
components/       UI; Money and StatusPill enforce product rules, not just styling
lib/
  engine/         THE DECISION CORE. Pure functions, zero LLM calls.
  agents/         LLM-backed extraction, diagnosis, planning
  llm/            one provider interface; gemini + deterministic stub
  adapters/       GovGateway, grievance — the only route to the government side
  registry/       10 schemes, ~48 clauses, each with its own source URL
  services/       orchestration and persistence
prisma/           schema, registry seed, demo seed
tests/            unit · scenarios · boundaries
```

### Deterministic core, LLM at the edges

`lib/engine/**` contains no model calls. Eligibility, money, reconciliation and
state transitions must be reproducible and citable, and a model that answers
differently on a retry is neither. The model extracts, interprets and explains;
the engine decides.

Enforced by `tests/boundaries/architecture.test.ts`, which also checks that
ambient time is read in exactly one place, that `gov_*` tables are reachable
only from `lib/adapters`, that no filesystem write exists in the document path,
and that no float conversion appears in the engine. Each detector has a
self-test proving it still fires on known-bad input — a guard that silently
stops matching is worse than no guard.

### Things deliberately not done the obvious way

**Confidence is derived, not asked.** The specification called for the model to
report a confidence number. A model asked "how confident are you, 0 to 1"
produces a figure that looks rigorous, cannot be reproduced, and would sit next
to a statement about money someone is owed. Confidence here is a pure function
of rule coverage weighted by per-field provenance, and it is reported in words
rather than as a percentage.

**No vector search.** For a curated registry, an exact structured filter cannot
be beaten by an embedding ranking and can be badly beaten by one. A citizen must
never miss an entitlement because a vector scored it low, and "the model ranked
it 0.42" is not an explanation anyone can act on.

**Diagnosis must cite evidence, enforced in code.** The model receives a
numbered evidence list; every citation is checked back against it, invented ones
are dropped, and a diagnosis left with no surviving citation is forced to
`UNKNOWN`. *Unknown* beats a confident fabrication that sends someone to the
wrong office.

**Both approval gates are enforced twice.** The state machine has no edge from
`APPLICATION_DRAFT` to `SUBMITTED`, nor from `ACTION_PLANNED` to
`ACTION_EXECUTED` — and the services independently refuse to act without an
`APPROVED` row. Either alone would be bypassable by a bug that set state
directly, and these actions file grievances in a citizen's name.

**Undecided exclusions are declarations, not blockers.** Requiring a citizen to
pre-emptively deny eight things before anything reads as eligible is noisy and
unlike the real process, where exclusions are self-declarations signed at
submission. A *known* exclusion still produces RED.

---

## Privacy: verify the benefit, not the person's finances

When a citizen cannot tell whether a transfer arrived, they can supply a bank
statement. What happens to it:

```
upload      multipart, into a memory buffer. Never written to disk.
  → sha256  a fingerprint, so we can say a document was seen
  → extract ONLY credits matching the expected amount, within a date window
  → discard the buffer goes out of scope
  → record  { expected, matched, date, last 4 of reference, hash }
```

The balance, every other transaction, and the account number are never
extracted, let alone stored. The date window is enforced in code, not merely
requested in the prompt. A failed search is reported as "we did not find it",
explicitly **not** as proof the money never arrived — a statement for the wrong
account is at least as likely.

This does not claim that dropping a buffer guarantees erasure from every cache
and log in the world. It claims the narrower, true thing: this application never
writes the document anywhere.

---

## Continuous monitoring

`POST /api/monitoring/tick`, authenticated with `CRON_SECRET`, selects benefits
on concrete conditions (an instalment overdue past grace, an unresolved gap not
already being worked, an audit gone stale), records *why* each was selected, and
re-audits a bounded batch.

The heartbeat is `.github/workflows/monitoring.yml`, every five minutes.

> Vercel Cron is not used. It issues a GET, and this endpoint refuses GET
> because a state-changing GET is triggerable by a prefetch or a crawler; on
> Hobby it is also daily-only. Weakening the endpoint would have traded a real
> safety property for a backstop that fires once a day.

Locally, the demo console runs a pass on demand.

---

## Environment

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres. Docker locally, Neon in production. |
| `TEST_DATABASE_URL` | Separate database for the test suite. Must not equal `DATABASE_URL`. |
| `LLM_PROVIDER` | `stub` (default, free, deterministic) or `gemini`. |
| `GEMINI_API_KEY` | Only needed for `gemini`. |
| `CRON_SECRET` | Bearer token for the monitoring tick. Unset means refused, never open. |
| `DEMO_MODE` | `true` exposes the demo console and the simulated clock. Must be `false` anywhere real citizen data lives. |

No secrets are committed. `.env.example` documents all six.

---

## Data provenance — please read

The scheme registry is **curated for a prototype**. Amounts and conditions were
compiled from official documentation and each clause carries its own source URL
and `lastVerified` date, but it is a hand-maintained snapshot, not a live feed.

Each scheme records a `verificationStatus`:

- `SOURCE_CHECKED` — checked against its source URL on the stated date
- `COMPILED_UNVERIFIED` — compiled from documentation, not re-checked there

That distinction exists so the registry cannot overstate its own reliability.
Four of the ten are source-checked.

**Cash figures are central assistance. State top-ups are not modelled** — the
real amount a citizen receives is often higher. Two figures were corrected
against sources during the build: IGNOAPS central assistance is ₹200/month at
ages 60–79 (not ₹600), and PMMVY requires the beneficiary to be under 55 at
childbirth.

Before any real use, every clause must be re-verified and the registry replaced
by an official source (myScheme / API Setu) behind the existing adapter
interface.

**No real government API endpoint is invented anywhere in this codebase.** The
only implementation is a clearly-labelled simulation, every result it returns
carries `isMock`, and the UI says so wherever those results appear.

---

## Documents

- [`docs/DEMO.md`](docs/DEMO.md) — a six-minute demo script, with the questions
  you will probably get and how to answer them
- [`docs/DEPLOY.md`](docs/DEPLOY.md) — Vercel + Neon, the monitoring heartbeat,
  and the Hobby-tier constraints that shaped the architecture
- [`docs/specs/`](docs/specs/) — the approved design document this was built to

---

## Status

Working prototype. 376 tests, clean typecheck, production build passing.

Not built, and deliberately so: production authentication (the demo uses a
persona selector, confined to one function so real auth replaces one file),
encryption at rest, and live government integration.
