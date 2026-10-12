# 2. Onboarding & discovery subgraph

**Agents:** 01 Profile Agent · 02 Entitlement Discovery Agent
**Prompts:** `profile_extraction`, `discovery_explainer`

The rules engine decides eligibility. The explainer only explains verdicts it
is handed; it never changes one.

```mermaid
flowchart TD
  START((START)) --> input{"input type"}:::code
  input -- "chat / voice text" --> pex["profile_extraction<br/>facts + provenance per field<br/>SELF_DECLARED / INFERRED"]:::llm
  input -- "document image / PDF" --> dex["profile_extraction (document)<br/>read attached document"]:::llm

  pex --> validate["validate_profile<br/>coerce types · reject unknown fields<br/>regex / validators"]:::code
  dex --> validate
  validate -- "document fields pass" --> verified["mark DOCUMENT_VERIFIED<br/>(set in code, never by the model)"]:::code
  verified --> merge_profile
  validate --> merge_profile["merge_into_profile<br/>store provenance"]:::code

  merge_profile --> complete{"mandatory fields<br/>present?"}:::code
  complete -- no --> questions["missing_field_questions<br/>deterministic follow-ups"]:::code
  questions --> END_ASK((back to chat))
  complete -- yes --> fanout(("fan-out"))

  fanout --> sql["sql_candidates<br/>filter by state / level"]:::code
  fanout --> vec["semantic_match<br/>pgvector"]:::planned
  fanout --> rules["rules_engine<br/>evaluate clauses → verdict"]:::code

  sql --> join(("join"))
  vec --> join
  rules --> join

  join --> rank["rank_and_score<br/>GREEN / YELLOW / RED<br/>coverage-based confidence<br/>expected amount + schedule"]:::code
  rank --> baseline["persist_entitlements<br/>baseline for later audits"]:::code
  baseline --> explain["discovery_explainer<br/>explain each verdict in<br/>citizen's language"]:::plannedllm
  explain --> END((END))

  classDef llm fill:#ede9fe,stroke:#7c3aed,color:#1e1b4b
  classDef code fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef planned fill:#f3f4f6,stroke:#9ca3af,color:#374151,stroke-dasharray:5 5
  classDef plannedllm fill:#ede9fe,stroke:#7c3aed,color:#1e1b4b,stroke-dasharray:5 5
```

## Graph state

| Field | Written by |
|---|---|
| `rawInput` / `document` (bytes, never persisted) | entry |
| `extraction` (fields + provenance) | profile_extraction |
| `accepted[]`, `rejected[]` | validate_profile |
| `profile` | merge_into_profile |
| `missingQuestions[]` | missing_field_questions |
| `candidates[]` | sql_candidates, semantic_match |
| `verdicts[]` (scheme, verdict, failed / unknown clauses) | rules_engine |
| `entitlements[]` (verdict, confidence, expected amount) | rank_and_score |
| `explanations[]` | discovery_explainer |

**Fallback:** if `profile_extraction` fails validation after its retries, no
fields are written and the citizen is asked the deterministic questions instead.
If `discovery_explainer` fails, verdicts are shown with their rule-based reasons.
