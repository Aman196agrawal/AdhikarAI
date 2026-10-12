# 1. Top-level orchestrator graph

The citizen talks only to the Chat / Orchestrator node. It gathers what is
missing, then routes into a subgraph. Subgraph results come back to the chat
node, which reports progress truthfully — never claiming success before an
adapter confirms it.

```mermaid
flowchart TD
  START((START)) --> chat["chat_orchestrator<br/>understand request · preferred language<br/>never asks for OTP / password"]:::planned
  chat --> route{"route_request"}:::code

  route -- "new citizen / profile update" --> onboard[["Onboarding & discovery<br/>subgraph"]]:::sub
  route -- "apply for a scheme" --> apply[["Application<br/>subgraph"]]:::sub
  route -- "benefit stopped / rejected / unpaid" --> audit[["Audit & recovery<br/>subgraph"]]:::sub
  route -- "need more info" --> ask["ask_citizen<br/>only what is needed to proceed"]:::code
  route -- "status question" --> status["read_dashboard<br/>engine output only"]:::code

  ask --> chat
  onboard --> chat
  apply --> chat
  audit --> chat
  status --> chat
  chat -- "conversation done" --> END((END))

  cron(["Scheduler tick"]):::code --> monitor[["Continuous monitoring<br/>subgraph"]]:::sub
  monitor --> audit

  classDef llm fill:#ede9fe,stroke:#7c3aed,color:#1e1b4b
  classDef code fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef sub fill:#dcfce7,stroke:#16a34a,color:#052e16
  classDef planned fill:#ede9fe,stroke:#7c3aed,color:#1e1b4b,stroke-dasharray:5 5
```

## Graph state

| Field | Type | Written by |
|---|---|---|
| `citizenId` | string | session |
| `locale` | `"en" \| "hi"` | chat_orchestrator |
| `messages` | chat history | chat_orchestrator, ask_citizen |
| `intent` | `onboard \| apply \| recover \| status \| clarify` | route_request |
| `benefitId` | string? | route_request |
| `pendingApproval` | approval id? | subgraphs (on `interrupt()`) |
| `lastResult` | subgraph summary | subgraphs |

Monitoring is not started by the citizen: a scheduler tick enters the audit
subgraph directly, and any resulting approval request surfaces to the citizen
through the chat node.
