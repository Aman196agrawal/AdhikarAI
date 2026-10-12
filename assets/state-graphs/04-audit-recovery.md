# 4. Audit & recovery loop subgraph

**Agents:** 04 Benefit Audit · 06 Audit Decision · 05 Root Cause Analysis ·
07 Action Planner · 08 Action Agent · 09 Re-verification
**Prompts:** `root_cause`, `planner`
**Approval gate 2:** `interrupt()` before any corrective action runs

This is where the system's agency lives: diagnose → plan → approve → act →
re-verify, and **re-plan after failure** with the previous attempts fed back in
so the same fix is not proposed twice.

```mermaid
flowchart TD
  START((START)) --> audit["benefit_audit<br/>status · payments · receipts · continuity<br/>vs. ledger baseline → gaps[]"]:::code
  audit --> decide{"audit_decision"}:::code

  decide -- HEALTHY --> healthy["mark MONITORING"]:::code
  decide -- NEEDS_VERIFICATION --> receipt["request_receipt_evidence<br/>citizen confirms or uploads statement"]:::code
  decide -- ACTION_REQUIRED --> rc_rules["root_cause_rules<br/>known portal error codes"]:::planned

  rc_rules -- "code matched" --> rc_done
  rc_rules -- "ambiguous" --> rc_llm["root_cause<br/>cite numbered evidence only"]:::llm
  rc_llm --> ground{"citations exist in<br/>evidence list?"}:::code
  ground -- yes --> rc_done["ROOT_CAUSE_IDENTIFIED<br/>MISSING_DOCUMENT · DATA_MISMATCH · BANK_ISSUE<br/>AADHAAR_ISSUE · ELIGIBILITY · VERIFICATION · …"]:::code
  ground -- "no → forced UNKNOWN" --> human["NEEDS_HUMAN_REVIEW"]:::code

  rc_done --> plan["planner<br/>ordered steps · documents<br/>fields to correct · channel"]:::llm
  plan --> allowed{"action types in<br/>allowed list?<br/>no amounts invented?"}:::code
  allowed -- no --> human
  allowed -- yes --> gate2{{"interrupt()<br/>APPROVAL GATE 2<br/>citizen approves the plan"}}:::gate

  gate2 -- "rejected → revise plan" --> plan
  gate2 -- approved --> assert["assert_approval<br/>CORRECTIVE_ACTION APPROVED"]:::code
  assert --> act["action_agent<br/>run step via adapter<br/>portal · grievance · notification"]:::code
  act -- "adapter failed" --> replan["record failed attempt<br/>attempt += 1"]:::code
  replan --> rc_llm
  act -- "adapter confirmed" --> reverify["reverification<br/>re-read status and payments"]:::code

  reverify -- recovered --> ledger["update_ledger<br/>RECOVERED → MONITORING"]:::code
  reverify -- "not recovered" --> reaudit["RE_AUDIT_REQUIRED"]:::code
  reaudit --> audit

  healthy --> END((END))
  receipt --> END
  ledger --> END
  human --> END

  classDef llm fill:#ede9fe,stroke:#7c3aed,color:#1e1b4b
  classDef code fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef gate fill:#fef3c7,stroke:#d97706,color:#451a03
  classDef planned fill:#f3f4f6,stroke:#9ca3af,color:#374151,stroke-dasharray:5 5
```

## Graph state

| Field | Written by |
|---|---|
| `benefitId` | entry |
| `gaps[]` (kind, expected, actual, evidence) | benefit_audit |
| `decision` (`HEALTHY \| NEEDS_VERIFICATION \| ACTION_REQUIRED`) | audit_decision |
| `evidence[]` (numbered) | benefit_audit |
| `rootCause` (kind, cited evidence, confidence) | root_cause_rules / root_cause |
| `attempt`, `previousAttempts[]` | record failed attempt |
| `actionPlan` (steps of allowed `ActionKind`) | planner |
| `approvalId`, `decision` | approval gate 2 (resume value) |
| `execution` (status, adapter reference) | action_agent |
| `recovered` | reverification |

**Allowed action types** (planner cannot invent others): `REQUEST_DOCUMENT`,
`CORRECT_INFORMATION`, `REQUEST_CLARIFICATION`, `RESUBMIT`, `REAPPLY`,
`SUBMIT_GRIEVANCE`, `ESCALATE_GRIEVANCE`, `RETRY_OPERATION`,
`REQUEST_ASSISTED_VERIFICATION`, `WAIT_AND_MONITOR`.

**Fallbacks:** a model failure in `root_cause` yields `UNKNOWN`, never a guessed
cause; a model failure in `planner` yields no plan and routes to human review.
