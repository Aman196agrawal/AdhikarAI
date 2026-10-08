# Demo script

Roughly six minutes. The point to land is in the first thirty seconds and
proved in the last ninety.

**Before you start**

```bash
npm run db:up && npm run seed:all && npm run dev
```

Open two tabs: `http://localhost:3000` and `http://localhost:3000/demo`.
Check `DEMO_MODE=true` in `.env`.

---

## 0 · The opening line (20s)

> Scheme discovery in India is solved. myScheme exists. A dozen chatbots will
> tell you what you qualify for.
>
> What nobody does is check whether the money actually arrived.

Click into **Kamala Devi**.

---

## 1 · One screen, six different states (60s)

Scroll to **Your money**. Point at the four figures and read the labels:

> Received two thousand two hundred. Not yet confirmed, two hundred. Did not
> arrive, two hundred. And an estimate of what she could still claim.
>
> Those are four different claims with four different strengths of evidence,
> so they are four separate numbers. We never add them up, because the sum
> would be a lie about at least three of them.

Then scroll through the benefit groups:

> Needs action. Needs checking. Not yet claimed. All in order. Does not apply.
>
> One citizen, six states at once. That is what the final mile actually looks
> like.

Point at **PMMVY — does not apply**:

> She is sixty-seven. The maternity benefit requires under fifty-five. The
> system says no, and it can tell you which clause and show you the source.

**If asked how real the data is:** every state on that screen was produced by
running the real pipeline in `prisma/seed-demo.ts` — extraction, discovery,
application, approval, submission, audit. No rows were hand-written.

---

## 2 · The question (45s)

Scroll back to the top, to **We need to ask you something**:

> The government says two hundred rupees was sent for her old age pension in
> April. Did she receive it?
>
> Three buttons, the same size. We do not make "yes" the easy one. The people
> this is for often genuinely cannot tell, and if you nudge them toward yes you
> manufacture false confirmations from exactly the users least able to check.

Click **Not sure**.

> Not sure is a real answer. It does not become yes and it does not become no.
> It stays unknown, and we offer to check.

The bank upload panel appears. Read the three bullets:

> We look for one payment. We keep the amount, the date, four characters of the
> reference, and a fingerprint of the file. We do not keep the document, the
> balance, the account number, or any other transaction.
>
> Verify the benefit, not the person's finances.

---

## 3 · The loop (2m 30s — this is the demo)

Open **IGNOAPS** from the Needs action group. Scroll to **Problems we found**.

> The government released two hundred rupees in May. Kamala says it never
> arrived. Both records are accurate; the money is still missing.

Point at the cause and open **What makes us think that?**:

> Aadhaar not seeded to the beneficiary account. That is not the model
> guessing — it is quoting the bank's own return message. If it cannot cite
> evidence, the diagnosis is recorded as unknown and a human is asked. That
> rule is enforced in code, not in a prompt.

Click **Work out what went wrong**, then **Review what we propose**.

> Here is the second approval gate. The problem, the evidence, the cause, how
> confident we are, and every step we would take. Nothing has been sent.

Click **Yes, go ahead**, then **Carry out the approved steps**, then
**Check whether it actually worked**.

> It did not work.
>
> That is the most important moment in this demo. The action completed
> perfectly and the money still is not there. A system that marked this done
> would be lying.

Click **Work it out again**.

> It diagnoses again, and it will not propose what already failed. Having
> exhausted the direct fix, it escalates to a human grievance officer.

Approve and execute. Then, in the demo console tab, **Release this period's
payment**. Back on the benefit, answer **Yes** and re-verify.

> Recovered. Two hundred rupees that had not reached her, and now has.
>
> That is the metric. Not applications submitted — benefits that actually
> arrived.

---

## 4 · It keeps watching (45s)

In the demo console, click **+3 months**.

> Nothing about her benefits changed. Only the date. The real monitor then ran
> over a later "now" and drew its own conclusions.

Back to the dashboard:

> February and March were due and nothing came. It found a continuity gap
> without anyone logging in.
>
> In production that is a five-minute cron, not a button.

---

## 5 · Close (20s)

> We do not measure success by how many applications our agent submitted. We
> measure it by how many benefits actually reached the citizen.
>
> And the thing that makes that possible is one modelling decision: we never
> let "we cannot confirm this" collapse into either "received" or "missing".

---

## Questions you will probably get

**Is this hitting real government APIs?**
No, and the UI says so on every screen. It is a labelled simulation behind an
adapter interface — one file to swap. No real endpoint is invented anywhere.
The separation is structural: the government's records live in their own
tables and the engine can only reach them through that adapter, which a test
enforces.

**How accurate is the scheme data?**
Ten central schemes, about forty-eight clauses, each with its own source URL
and verification date. Four are source-checked; the rest are compiled from
official documentation and flagged as such, because the registry should not
overstate its own reliability. Figures are central assistance — state top-ups
are not modelled. Two numbers were corrected against sources while building.

**What stops the model making things up?**
It never decides anything. Eligibility, money, state transitions and
reconciliation are deterministic code with no model call in the path.
Diagnosis is the one place interpretation is genuinely needed, and there every
citation is checked against the supplied evidence — unsupported ones are
dropped and the diagnosis is forced to UNKNOWN.

**Why not RAG over the schemes?**
With a curated registry, an exact structured filter beats an embedding ranking
and never loses an entitlement to a low similarity score. "The model ranked it
0.42" is not an explanation a citizen can act on.

**Could it act without the citizen agreeing?**
No, and it is guarded twice. The state machine has no edge that reaches
submission or execution without passing an approval gate, and the services
independently refuse without an approved record. Three tests cover the refusal.

**What is missing?**
Production authentication, encryption at rest, live government integration, and
the registry needs re-verifying before real use. All listed in the README.
