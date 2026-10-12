# 3. Application subgraph

**Agent:** 03 Application / Form Agent
**Prompt:** `form_assistant`
**Approval gate 1:** `interrupt()` before any submission

Submission is refused in code unless an `APPROVED` approval row of kind
`APPLICATION_SUBMISSION` exists. The state machine has no edge from
`APPLICATION_DRAFT` straight to `SUBMITTED` — a second, independent guard.

```mermaid
flowchart TD
  START((START)) --> select["select_scheme_and_channel<br/>from GREEN / YELLOW entitlement"]:::code
  select --> prefill["prefill_form<br/>map profile → form fields"]:::code
  prefill --> assist["form_assistant<br/>field mapping help<br/>missing-document guidance"]:::plannedllm
  assist --> validate["validate_form<br/>required fields · formats<br/>identity numbers left for citizen"]:::code
  validate --> docs{"documents<br/>complete?"}:::code
  docs -- no --> request["request_documents<br/>list what is missing"]:::code
  request --> END_WAIT((back to chat))
  docs -- yes --> draft["save_draft<br/>APPLICATION_DRAFT"]:::code
  draft --> gate1{{"interrupt()<br/>APPROVAL GATE 1<br/>citizen reviews the draft"}}:::gate

  gate1 -- rejected / edit --> prefill
  gate1 -- approved --> check["assert_approval<br/>APPROVED row must exist"]:::code
  check --> submit["submit_via_gateway<br/>idempotency key"]:::code
  submit -- "gateway error" --> retry{"retryable?<br/>(portal unavailable)"}:::code
  retry -- yes --> submit
  retry -- no --> review["report failure<br/>fix form, re-approve"]:::code
  submit -- accepted --> record["record SUBMITTED<br/>audit trail"]:::code
  record --> END((END))
  review --> END

  classDef llm fill:#ede9fe,stroke:#7c3aed,color:#1e1b4b
  classDef code fill:#e0f2fe,stroke:#0284c7,color:#0c4a6e
  classDef gate fill:#fef3c7,stroke:#d97706,color:#451a03
  classDef plannedllm fill:#ede9fe,stroke:#7c3aed,color:#1e1b4b,stroke-dasharray:5 5
```

## Graph state

| Field | Written by |
|---|---|
| `schemeCode`, `channel` | select_scheme_and_channel |
| `formFields{}` | prefill_form, form_assistant |
| `missingDocuments[]` | form_assistant, validate_form |
| `validationErrors[]` | validate_form |
| `applicationId` | save_draft |
| `approvalId`, `decision` | approval gate 1 (resume value) |
| `submissionRef`, `idempotencyKey` | submit_via_gateway |

**Bounded authority:** `form_assistant` can suggest field values and explain
documents. It cannot submit, cannot mark a field verified, and its suggestions
pass through `validate_form` like any other input.
