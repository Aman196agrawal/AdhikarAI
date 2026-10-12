# 5. Continuous monitoring subgraph

**Agent:** 10 Continuous Monitoring — fully deterministic, no prompt.

The monitor only decides *what deserves a look* and records why. The audit
subgraph then works out what actually changed. Each tick is bounded by a batch
size so it finishes inside a serverless time limit; leftovers wait for the next
tick.

```mermaid
flowchart TD
  START((Scheduler tick)) --> now["read clock<br/>(simulated in demo)"]:::code
  now --> select["select_due_benefits<br/>up to batchSize"]:::code

  select --> why{"reason"}:::code
  why -- "instalment due" --> e1["PAYMENT_DUE"]:::code
  why -- "unpaid past 15-day grace" --> e2["PAYMENT_MISSED"]:::code
  why -- "renewal window" --> e3["RENEWAL_DUE"]:::code
  why -- "portal status changed" --> e4["STATUS_CHANGED"]:::code
  why -- "new mismatch found" --> e5["NEW_DISCREPANCY"]:::code
  why -- "healthy, last audit > 7 days" --> e6["routine re-audit"]:::code

  e1 --> record
  e2 --> record
  e3 --> record
  e4 --> record
  e5 --> record
  e6 --> record
  record["record MonitoringEvent<br/>RE_AUDIT_REQUIRED"]:::code --> audit[["Audit & recovery<br/>subgraph"]]:::sub

  audit --> more{"more due benefits<br/>in this batch?"}:::code
  more -- yes --> select
  more -- no --> END((END · next tick))

  classDef code fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef sub fill:#dcfce7,stroke:#16a34a,color:#052e16
```

## Graph state

| Field | Written by |
|---|---|
| `now` | clock |
| `batch[]` (benefitId, reason) | select_due_benefits |
| `events[]` | record MonitoringEvent |
| `processed`, `remaining` | loop counter |

A minimum gap between routine re-audits of the same benefit stops a benefit
with an open problem from being re-audited on every tick.
