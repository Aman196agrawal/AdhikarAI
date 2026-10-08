# Deploying to Vercel + Neon

Nothing here needs a credit card. Both free tiers are sufficient.

Keep the local Docker setup working as a stage fallback — a live demo that
depends on network, model latency and a database cold start is worth having an
escape hatch from.

---

## 1 · Database (Neon)

Create a project at <https://neon.tech> and copy the **pooled** connection
string. It will look like:

```
postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
```

Use the pooled endpoint, not the direct one: serverless functions open and
close connections constantly, and the direct endpoint will exhaust its limit.

Apply the schema and load the registry:

```bash
DATABASE_URL="<neon-pooled-url>" npx prisma migrate deploy
DATABASE_URL="<neon-pooled-url>" npm run seed
```

Then, only if you want the demo personas in production:

```bash
DATABASE_URL="<neon-pooled-url>" DEMO_MODE=true npm run seed:demo
```

---

## 2 · Deploy

```bash
npx vercel            # link the project
npx vercel --prod
```

Set these in **Project → Settings → Environment Variables**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled URL |
| `LLM_PROVIDER` | `gemini`, or `stub` to run free and deterministic |
| `GEMINI_API_KEY` | only if using `gemini` |
| `CRON_SECRET` | a long random string — `openssl rand -hex 32` |
| `DEMO_MODE` | `true` for a demo deployment |

> **`DEMO_MODE` must be `false` anywhere real citizen data lives.** It exposes
> the console that drives the simulated government and shifts the clock. With
> it off, the demo routes return 404, demo citizen records are refused, and the
> stored clock offset is ignored outright rather than trusted to be zero.

Do not set `TEST_DATABASE_URL` in production. It is only read by the test
suite, and pointing it at anything real would be dangerous.

---

## 3 · The monitoring heartbeat

Vercel Hobby has no long-lived process, so the five-minute tick comes from
GitHub Actions (`.github/workflows/monitoring.yml`).

In **GitHub → Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|---|---|
| `MONITORING_URL` | `https://<your-deployment>/api/monitoring/tick` |
| `CRON_SECRET` | exactly the value set in Vercel |

Then run the workflow once by hand (**Actions → monitoring → Run workflow**)
and check the output. A healthy pass looks like:

```
pass 1: {"ok":true,"data":{"audited":3,"actionRequired":1,"moreRemaining":false,...}}
Queue clear.
```

Verify the guard is actually on — this must be refused:

```bash
curl -i -X POST https://<your-deployment>/api/monitoring/tick
# HTTP/2 401
```

> **Vercel Cron is deliberately not used.** It issues a GET, and this endpoint
> refuses GET because a state-changing GET is triggerable by a link prefetch or
> a crawler. On Hobby it is daily-only in any case. Weakening the endpoint to
> accommodate it would trade a real safety property for a backstop that fires
> once a day.

---

## 4 · Check it works

```bash
curl -s https://<your-deployment>/api/citizens | head -c 400
```

Then in a browser: pick a persona, confirm the dashboard shows the four
separated money figures, and confirm the prototype banner is visible at the top
of every page.

---

## Known constraints on Hobby

**Function timeout.** Hobby caps execution, which is why the agent loop is
decomposed into short idempotent steps rather than one long orchestration, and
why the monitoring tick processes a bounded batch and reports
`moreRemaining` instead of draining the queue.

**Neon cold starts.** The free tier scales to zero and the first request after
idle takes a second or two. Load the dashboard once before presenting.

**Model latency.** Only the agent paths call Gemini. The dashboard, audit and
reconciliation are pure database and deterministic code, so the screen the demo
spends most time on does not wait on a model. Setting `LLM_PROVIDER=stub`
removes model latency entirely and still runs the whole loop, which is a
reasonable choice for a timed demo.

---

## If the deployment misbehaves

**Prisma fails to start.** Prisma 7 requires a driver adapter; this project
uses `@prisma/adapter-pg`, which is already wired up in `lib/db.ts`. Check
`DATABASE_URL` is the pooled endpoint and includes `sslmode=require`.

**"No demo people" on the home page.** The registry seed ran but the demo seed
did not, or `DEMO_MODE` is not `true`.

**Connection limit errors.** You are on the direct Neon endpoint. Switch to the
pooled one.

**The cron reports 401.** `CRON_SECRET` differs between GitHub and Vercel, or
is unset in Vercel — in which case the endpoint refuses everything by design
rather than defaulting to open.
