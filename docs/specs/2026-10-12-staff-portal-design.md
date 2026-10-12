# Staff portal — design

**Date:** 2026-10-12 · **Status:** draft for review · **Branch:** `staff-portal`

## Goal

Give the partner organisation's staff a secure place to work: a queue of
cases the system cannot resolve on its own, and an assisted mode for helping
citizens in person. The citizen remains the only person who can approve an
application or a corrective action; staff can record that a citizen gave
consent in their presence, never give it for them.

## Decisions already made

| Decision | Choice |
|---|---|
| What staff do | Both: back-office case queue **and** in-person assisted mode |
| Who logs in | Staff only, for now. Citizen self-login (phone OTP) later |
| Staff sign-in | Email + password |
| Authentication build | Approach A: own implementation, Node `scrypt`, database sessions, all through `lib/authz.ts` |
| Roles | `ADMIN`, `CASEWORKER`, `FIELD_WORKER`, `RULE_REVIEWER`; a staff member may hold several |
| Consent in assisted mode | Staff record **witnessed** consent; they never approve on the citizen's behalf |
| Data access | Own districts + cases assigned to them; admins see all; every record opened is logged |
| History | Complete audit and recovery history preserved; a benefit is marked recovered only after re-verification |

---

## 1. Audit of the existing code, and conflicts

The current design is honest about being demo-only: one function,
`requireCitizen` in `lib/authz.ts`, turns a request into an identity, and
every citizen route goes through it (all 24 API routes import `lib/authz`;
`GET /api/citizens` only to read the demo flag — see C1). That
single choke point is what makes this change tractable. Next 16's own
guidance agrees: authorization belongs in a central data access layer, with
`proxy.ts` (the former middleware) used at most for optimistic redirects
(`node_modules/next/dist/docs/01-app/02-guides/authentication.md`).

What has to change before real people's data goes in:

| # | Conflict | Where | Resolution in this design |
|---|---|---|---|
| C1 | **Real citizens are exposed when demo mode is off.** `GET /api/citizens` lists every non-demo citizen to any caller, and the home page's `choosePersona` server action sets the citizen cookie to any id it is given. | `app/api/citizens/route.ts`, `app/page.tsx` | Both work only when `DEMO_MODE=true`, and then only for `isDemo` citizens. With demo mode off, citizen pages redirect to `/staff/login`. |
| C2 | **Identity comes from the request body.** Every citizen route trusts the `citizenId` the caller sends. | All citizen API routes | `requireCitizen(id)` is replaced by `authorizeCitizen(request, id)`, which derives the actor from the staff session (or the demo persona, demo mode only) and checks district access. The id in the body says *which* citizen, never *who is asking*. |
| C3 | **No CSRF protection on JSON routes.** `parseBody` calls `request.json()` whatever the Content-Type, so once a session cookie authenticates requests, a cross-site `<form enctype="text/plain">` could submit JSON. | `lib/api/http.ts` | A `mutation()` wrapper enforces same-origin + JSON content type on every state-changing route (§5). Server actions keep Next's built-in Origin check. |
| C4 | **Approvals assume the citizen clicked.** `Approval.decidedBy` is `"citizen:<id>"` with no record of how consent was obtained. | `Approval` model, `decideApplicationApproval`, `decideActionApproval` | New `ConsentEvidence` row, required whenever a decision is recorded by staff (§6). |
| C5 | **Audit trail has no staff.** `Actor` has no staff kind, `AuditLog.actor` is free text, and reads are not logged at all. | `lib/services/transitions.ts`, `AuditLog` | `Actor` gains `staff` and `citizen-via-staff`; `AuditLog.actorStaffId` added; new `AccessLog` for every record opened (§8). |
| C6 | **Deleting a citizen deletes their history.** 27 `onDelete: Cascade` relations, including every gap, root cause, plan and execution. | `prisma/schema.prisma` | Application code never deletes a citizen; it archives (`Citizen.archivedAt`). An architecture test forbids `citizen.delete*` outside tests and seed scripts. |
| C7 | **No staff-controlled district.** District exists only as a citizen profile fact, which the citizen (or the model) can change. Scoping access by it would let a profile edit move a record between districts. | `ProfileField` | New `Citizen.district` + `Citizen.state`, set and changed only by staff, and logged. |
| C8 | **Catalogue review uses a shared password and a self-declared name.** `ADMIN_TOKEN` + `x-reviewer` header. | `requireAdmin`, `/api/admin/catalogue/*` | Replaced by a `RULE_REVIEWER` session; the reviewer is the signed-in staff member. |
| C9 | **"Human review" leads nowhere.** Executions return `NEEDS_HUMAN_REVIEW` with messages such as "Referred to a caseworker", but no caseworker exists. | `lib/services/recovery.ts` | Each such outcome opens a `Case` (§7). |
| C10 | **No shared memory for rate limiting.** Serverless instances share nothing in memory. | Deployment | Login attempts are counted in Postgres (§4.4). |

Already correct and kept as-is:

- **Re-verification before recovery.** The only code path to `RECOVERED` is `reverifyBenefit`, after a fresh audit, and the state machine only allows `REVERIFYING → RECOVERED`. Staff actions cannot bypass it (§7.4).
- **The approval gates themselves.** `submitApplication` and `executeActionPlan` refuse without an `APPROVED` approval row, independent of the state machine.
- **Cron authentication.** `CRON_SECRET` bearer tokens carry no cookies, so they are not CSRF-exposed.
- **GET never mutates**, a convention every route already follows.

---

## 2. Roles and permissions

A staff member holds one or more roles. Permissions are the union of their roles.

| Capability | ADMIN | CASEWORKER | FIELD_WORKER | RULE_REVIEWER |
|---|:-:|:-:|:-:|:-:|
| Sign in, change own password | ✓ | ✓ | ✓ | ✓ |
| View citizens in own districts | ✓ (all) | ✓ | ✓ | — |
| Register a new citizen (in own district) | — | — | ✓ | — |
| Edit a citizen's profile facts (attributed to staff) | — | ✓ | ✓ | — |
| Change a citizen's district | ✓ | — | — | — |
| Upload documents for a citizen | — | ✓ | ✓ | — |
| Run discovery / draft an application for a citizen | — | ✓ | ✓ | — |
| **Record witnessed consent** (in person) | — | — | ✓ | — |
| Record a citizen statement (e.g. "money received"), in person or by phone | — | ✓ | ✓ | — |
| See the case queue (own districts) | ✓ (all) | ✓ | ✓ (field kinds) | — |
| Take / be assigned a case | — | ✓ | ✓ (field kinds) | — |
| Assign or reassign any case | ✓ | — | — | — |
| Record a root cause, request re-audit / re-verification on a case | — | ✓ | — | — |
| Review catalogue rules | — | — | — | ✓ |
| Manage staff (invite, roles, districts, deactivate, reset password) | ✓ | — | — | — |
| Read access and audit logs | ✓ | — | — | — |
| **Approve an application or corrective action** | **never** | **never** | **never** | **never** |

Notes:

- **Admins do no casework**: they cannot record consent, statements or root causes, edit citizen data, or take cases. Admin is an oversight role (accounts, assignment, districts, logs); keeping it out of casework means the people who manage accounts are not the people whose actions they would be checking. One person who needs both can hold ADMIN plus a working role, and every action is still attributed to them.
- **Consent is field-worker only and in person only.** A phone call is good enough to record a statement ("yes, the money arrived"), not to authorise a submission on someone's behalf.
- Field-kind cases are `COLLECT_DOCUMENT` and `ASSISTED_VERIFICATION` (§7.1).

---

## 3. Data model

New and changed Prisma models. Names and fields are binding for implementation.

```prisma
enum StaffRole { ADMIN CASEWORKER FIELD_WORKER RULE_REVIEWER }

model Staff {
  id                 String      @id @default(cuid())
  email              String      @unique            // stored lower-cased, trimmed
  name               String
  passwordHash       String                          // "scrypt$N$r$p$saltB64$hashB64"
  roles              StaffRole[]
  districts          String[]                        // ["Patna", "Gaya"]; ignored for ADMIN
  state              String?                         // e.g. "Bihar"
  isActive           Boolean     @default(true)
  mustChangePassword Boolean     @default(true)      // set on create and on admin reset
  failedLoginCount   Int         @default(0)
  lockedUntil        DateTime?
  passwordChangedAt  DateTime?
  createdById        String?
  createdAt          DateTime    @default(now())
  deactivatedAt      DateTime?
  sessions           StaffSession[]
}

model StaffSession {
  id            String    @id @default(cuid())
  staffId       String
  tokenHash     String    @unique                    // sha256 of the cookie token; the token itself is never stored
  createdAt     DateTime
  lastSeenAt    DateTime
  expiresAt     DateTime                             // absolute limit
  revokedAt     DateTime?
  revokeReason  String?                              // LOGOUT | PASSWORD_CHANGED | PASSWORD_RESET | DEACTIVATED | ROLES_CHANGED | ADMIN_REVOKED | EXPIRED
  ipHash        String?                              // sha256(ip + server salt), never the raw IP
  userAgent     String?
  staff Staff @relation(fields: [staffId], references: [id], onDelete: Restrict)
  @@index([staffId, revokedAt])
}

model LoginAttempt {
  id        String   @id @default(cuid())
  emailHash String                                   // sha256(lower(email) + salt): counts per account without storing typed emails
  ipHash    String
  succeeded Boolean
  at        DateTime
  @@index([emailHash, at])
  @@index([ipHash, at])
}

model AccessLog {                                    // every citizen record opened by staff
  id        String   @id @default(cuid())
  staffId   String
  citizenId String
  action    String                                   // "view:dashboard", "view:benefit", "api:GET /api/entitlements", ...
  at        DateTime
  @@index([citizenId, at])
  @@index([staffId, at])
}

enum CaseKind   { UNKNOWN_CAUSE ACTION_FAILED NEEDS_CLARIFICATION NO_APPLICATION_REFERENCE COLLECT_DOCUMENT ASSISTED_VERIFICATION }
enum CaseStatus { OPEN ASSIGNED IN_PROGRESS WAITING_ON_CITIZEN WAITING_ON_GOVERNMENT RESOLVED CLOSED_NO_ACTION }

model Case {
  id               String     @id @default(cuid())
  citizenId        String
  entitlementId    String?
  kind             CaseKind
  status           CaseStatus @default(OPEN)
  priority         Int                                // 1 (highest) .. 3
  district         String                             // copied from Citizen.district when opened
  sourceKey        String     @unique                 // e.g. "execution:<id>" — makes creation idempotent
  summary          String
  assignedToId     String?
  openedAt         DateTime
  assignedAt       DateTime?
  dueAt            DateTime
  resolvedAt       DateTime?
  resolution       String?                            // see §7.4
  events           CaseEvent[]
  @@index([district, status])
  @@index([assignedToId, status])
}

model CaseEvent {                                    // append-only history of a case
  id        String   @id @default(cuid())
  caseId    String
  staffId   String?                                  // null when the system acted
  type      String                                   // OPENED | ASSIGNED | STATUS_CHANGED | NOTE | ROOT_CAUSE_RECORDED | REAUDIT_REQUESTED | REVERIFY_REQUESTED | REOPENED | RESOLVED
  fromValue String?
  toValue   String?
  note      String?
  at        DateTime
  case Case @relation(fields: [caseId], references: [id], onDelete: Restrict)
  @@index([caseId, at])
}

enum ConsentMethod  { SPOKEN SIGNED THUMB_IMPRESSION CITIZEN_TAPPED }
enum AttestChannel  { IN_PERSON PHONE }

model ConsentEvidence {                              // one per staff-recorded approval decision
  id                String        @id @default(cuid())
  approvalId        String        @unique
  citizenId         String
  decision          ApprovalDecision                 // APPROVED or REJECTED — declining is recorded too
  method            ConsentMethod
  channel           AttestChannel                    // must be IN_PERSON for approvals
  language          String                           // "en" | "hi" — what the summary was read in
  statementShown    Json                             // the exact summary text read to the citizen
  citizenPresent    Boolean                          // must be true
  recordedByStaffId String
  secondWitnessName String?                          // optional, e.g. a family member or panchayat member
  recordedAt        DateTime
}

model CitizenStatement {                             // a citizen's answer recorded by staff (e.g. receipt confirmation)
  id                String        @id @default(cuid())
  citizenId         String
  subjectEntity     String                           // "Payment"
  subjectId         String
  statement         String                           // "RECEIVED" | "NOT_RECEIVED" | "NOT_SURE" | ...
  channel           AttestChannel
  recordedByStaffId String
  recordedAt        DateTime
}
```

Changes to existing models:

| Model | Change |
|---|---|
| `Citizen` | add `district String?`, `state String?` (staff-controlled; required for citizens registered by staff), `registeredByStaffId String?`, `archivedAt DateTime?` |
| `Approval` | add `consentEvidenceId String? @unique`. `decidedBy` stays `"citizen:<id>"` even when staff recorded it — it is always the citizen's decision |
| `AuditLog` | add `actorStaffId String?` + index; `actor` strings gain `staff:<id>` and `citizen:<id>/via:staff:<id>` |
| `RootCause` | add `recordedByStaffId String?` (human-recorded causes, §7.4) |

**History rules (enforced by architecture tests):** no code outside `tests/`
and `prisma/seed*` calls `delete`/`deleteMany` on `Citizen`, `AuditLog`,
`AccessLog`, `CaseEvent`, `ConsentEvidence`, `CitizenStatement`; no code calls
`update`/`updateMany` on `AuditLog`, `AccessLog`, `CaseEvent`,
`ConsentEvidence`, `CitizenStatement`.

---

## 4. Authentication

All of it lives in `lib/auth/` (modular, no Next imports except in the cookie
adapter), consumed only by `lib/authz.ts`.

```
lib/auth/password.ts   hash, verify, needsRehash, policy
lib/auth/sessions.ts   create, resolve, touch, revoke, revokeAllFor
lib/auth/rateLimit.ts  recordAttempt, isLocked, ipThrottled
lib/auth/cookies.ts    the only file that reads/writes the session cookie
lib/auth/csrf.ts       assertSameOrigin, assertJson
```

### 4.1 Passwords

- **Hash:** Node `crypto.scrypt`, N = 2^15, r = 8, p = 1, 16-byte random salt, 64-byte key, stored as `scrypt$N$r$p$salt$hash` so parameters can be raised later; `needsRehash` upgrades on next successful login.
- **Verify** with `crypto.timingSafeEqual`. For an unknown email, verify against a fixed dummy hash, so response time does not reveal whether an account exists.
- **Policy:** at least 12 characters, not equal to the email, not in a short bundled list of common passwords. No composition rules (they make passwords worse, not better).
- New staff and admin resets get a random temporary password (shown once to the admin) and `mustChangePassword = true`; until changed, the only reachable pages are change-password and sign-out.

### 4.2 Session lifecycle

| Event | Effect |
|---|---|
| **Sign in** | 32 random bytes → base64url token in cookie `adhikarai_staff` (`HttpOnly`, `Secure` in production, `SameSite=Lax`, `Path=/`). Only `sha256(token)` is stored. Absolute expiry 12 h; idle expiry 2 h (shared devices in the field). |
| **Each request** | Resolve by hash; reject if revoked, past `expiresAt`, idle past 2 h, staff inactive, or locked. `lastSeenAt` updated at most once a minute. |
| **Sign out** | Session revoked (`LOGOUT`), cookie cleared. |
| **Password changed / reset** | All the staff member's sessions revoked; on self-change a fresh session is issued to the current device. |
| **Deactivated** | All sessions revoked (`DEACTIVATED`); sign-in refused. |
| **Roles or districts changed** | All sessions revoked (`ROLES_CHANGED`), so no session carries stale permissions. |
| **Admin revokes** | One or all sessions (`ADMIN_REVOKED`). |

Session fixation is not possible: a token is created only at sign-in and
never accepted from anywhere but the cookie.

### 4.3 CSRF

Every state-changing route handler is wrapped in `mutation()` (replacing
`handler()` for POST/PUT/PATCH/DELETE), which before anything else:

1. requires an `Origin` header equal to the request host (or to `APP_ORIGIN` when set, for proxies); a missing Origin on a cookie-authenticated mutation is refused;
2. requires `Content-Type: application/json` for JSON bodies, or `multipart/form-data` on the two upload routes;
3. relies on `SameSite=Lax` as a second, independent layer.

Exempt: the cron route (bearer token, no cookie). Server actions keep Next's
built-in Origin/Host check. An architecture test fails if any route file
exports a POST/PUT/PATCH/DELETE not built with `mutation()`, except the
allow-listed cron route.

### 4.4 Rate limiting and lockout

Counted in `LoginAttempt` (Postgres), so it holds across serverless instances.

- **Per account:** 5 failures within 15 minutes locks it for 15 minutes (`lockedUntil`). Each further lockout in 24 h doubles the lock, capped at 24 h. An admin can unlock.
- **Per IP:** more than 20 failed attempts within 15 minutes from one IP hash are refused for 15 minutes, whatever the account.
- **One message for every failure:** "Email or password is incorrect, or the account is temporarily locked." No hint which.
- Attempts older than 30 days are deleted by the monitoring tick (the only permitted delete in this design: rate-limit counters, not history).

---

## 5. Authorization

`lib/authz.ts` stays the single place a request becomes an identity:

```ts
requireStaff(request, { roles?: StaffRole[] }): Promise<StaffContext>
authorizeCitizen(request, citizenId, purpose): Promise<{ citizen, actor }>
```

`authorizeCitizen`:

1. **Demo mode** (`DEMO_MODE=true`) and a demo persona cookie for an `isDemo` citizen: allowed, actor `citizen:<id>`. (Unchanged demo behaviour.)
2. **Staff session:** allowed when the staff member is `ADMIN`, or the citizen's `district` is in their `districts`, or an open case for that citizen is assigned to them. Actor `staff:<id>`. Writes an `AccessLog` row.
3. Otherwise `NOT_FOUND` — never `UNAUTHORIZED` — so a staff member cannot probe which citizen ids exist outside their districts.

Every citizen-scoped route and page calls `authorizeCitizen`. An
architecture test fails if a route under `app/api/` reads `citizenId` and
does not call it.

Archived citizens are readable by admins only.

---

## 6. Consent evidence

The approval screen gains an assisted variant, shown to a `FIELD_WORKER`:

1. The worker picks the language; the screen shows the **exact** summary that will be stored as `statementShown` — what will be submitted, to whom, which documents, which fields were corrected.
2. The worker reads it to the citizen, then records: **decision** (approve / decline), **method** (spoken, signed, thumb impression, or citizen tapped approve themselves), **citizen present** (must be ticked), optional second witness.
3. One transaction writes `ConsentEvidence`, then the `Approval` decision with `decidedBy = "citizen:<id>"` and `consentEvidenceId`, then audit rows under `citizen:<id>/via:staff:<id>`.

Rules, enforced in the services (not only the UI):

- A staff-originated decision without complete, in-person evidence is refused (`UNPROCESSABLE`).
- `channel` must be `IN_PERSON` for approvals.
- Only `FIELD_WORKER` may record it; `ADMIN`, `CASEWORKER`, `RULE_REVIEWER` cannot.
- Evidence is immutable. A mistake is corrected by the citizen deciding again on a new approval, never by editing.
- No signature image, thumbprint or photo is stored. The record is the worker's attributed attestation plus the exact text shown. (Storing biometrics would create a far larger privacy liability than it removes.)
- A citizen declining is recorded with the same evidence.

Receipt confirmations and other citizen answers recorded by staff go to
`CitizenStatement` (in person or by phone) and then through the existing
services, attributed `citizen:<id>/via:staff:<id>`.

---

## 7. Cases

### 7.1 When a case opens

Opened automatically, idempotently (by `sourceKey`), in the same transaction
as the event that causes it:

| Trigger | Kind | Who works it |
|---|---|---|
| Execution step returns `NEEDS_HUMAN_REVIEW` with adapter `caseworker` | `NEEDS_CLARIFICATION` | Caseworker |
| Execution step returns `NEEDS_HUMAN_REVIEW` for a missing application reference | `NO_APPLICATION_REFERENCE` | Caseworker |
| Execution step returns `NEEDS_HUMAN_REVIEW` with adapter `citizen` (document requested) | `COLLECT_DOCUMENT` | Field worker |
| `REQUEST_ASSISTED_VERIFICATION` executed | `ASSISTED_VERIFICATION` | Field worker |
| Root cause recorded as `UNKNOWN` | `UNKNOWN_CAUSE` | Caseworker |
| Corrective action plan `FAILED` a second time for the same gap | `ACTION_FAILED` | Caseworker |

Demo citizens get cases too, so the flow can be shown; their cases carry the
demo badge.

### 7.2 Priority and due date

- **Priority 1:** pension or food-security benefits (`NSAP-*`, `NFSA-*`), or proven missing money ≥ ₹1,000. Due in 2 days.
- **Priority 2:** any other proven missing money. Due in 5 days.
- **Priority 3:** everything else. Due in 10 days.

The queue sorts by priority, then due date. Overdue cases are highlighted;
unassigned cases older than 48 hours appear at the top of the admin view.

### 7.3 Assignment

- Staff see the queue for their districts, filtered to the kinds their roles can work.
- **Take:** a caseworker or field worker assigns an `OPEN` case to themselves (single assignee; compare-and-set, so two people cannot take the same case).
- **Assign / reassign:** admins only, to a staff member who covers the case's district and holds a role that can work its kind.
- Deactivating a staff member returns their open cases to `OPEN` (logged).
- Every change is a `CaseEvent`.

### 7.4 Working and resolving a case

What staff can do, and what it triggers:

| Action | Effect |
|---|---|
| Add note | `CaseEvent NOTE` |
| Set waiting on citizen / government | Status change, logged |
| **Record root cause** (caseworker) | Creates a `RootCause` with `recordedByStaffId`, the chosen kind, and **at least one evidence note** (the same "no cause without evidence" rule the agent follows). The planner then proposes an action, and **the citizen must still approve it** before anything executes. |
| **Request re-audit** | Runs the existing audit for that benefit |
| **Request re-verification** | Calls the existing `reverifyBenefit` — the **only** route to `RECOVERED`. If the audit does not show the gap resolved, the benefit stays where it is and the case stays open. |
| Resolve | Allowed only when the triggering condition is gone (e.g. the document arrived, the gap resolved after re-verification) or with resolution `CLOSED_NO_ACTION` + a mandatory reason (citizen unreachable, not eligible, duplicate). Closing never changes the benefit's state; monitoring keeps watching it. |
| Reopen | Allowed; logged |

Staff can never set a benefit's lifecycle state directly, never mark it
`RECOVERED`, and never approve a plan.

---

## 8. Audit logging

| What | Where |
|---|---|
| Every state change (existing behaviour) | `AuditLog`, now with `actorStaffId` when staff were involved |
| Every citizen record opened by staff | `AccessLog` |
| Sign-in success, failure, lockout, unlock, password change and reset, session revoked, staff created / roles or districts changed / deactivated | `AuditLog` with `entity = "Staff"` or `"StaffSession"` |
| Case history | `CaseEvent` (append-only) |
| Consent and citizen statements | `ConsentEvidence`, `CitizenStatement` (immutable) |

Logs never contain passwords, session tokens, raw IPs, full Aadhaar or bank
numbers; the existing redacting logger already strips identifiers and gains
`password` and `token` keys.

---

## 9. Screens

| Path | Who | What |
|---|---|---|
| `/staff/login`, `/staff/password` | everyone | Sign in; forced and voluntary password change |
| `/staff` | caseworker, field worker | My cases, then the district queue |
| `/staff/cases/[id]` | caseworker, field worker | Case detail: citizen summary, benefit, evidence, history, actions (§7.4) |
| `/staff/citizens` | field worker, caseworker | Search citizens in own districts; register new (field worker) |
| `/staff/citizens/[id]` | field worker, caseworker | Assisted view: reuses dashboard, benefit, onboarding and approval components for that citizen |
| `/staff/admin` | admin | Staff management, unassigned and overdue cases, access log |
| `/admin/catalogue` | rule reviewer | Existing screen, now behind the role instead of `ADMIN_TOKEN` |

With `DEMO_MODE=false`, `/`, `/dashboard`, `/benefit/*`, `/schemes`, `/onboard`
and `/approve/*` redirect to `/staff/login`.

**Bootstrap:** `npm run staff:create-admin -- --email you@org.in --name "Name"`
creates the first admin and prints a one-time temporary password. It refuses
to run if an active admin already exists, unless `--force` is given.

---

## 10. Tests

Offline, against the test database. Grouped as you asked:

**Password hashing** (`tests/unit/password.test.ts`)
- hash → verify succeeds; wrong password, empty, truncated hash fail
- same password hashes differently each time (salt)
- stored format carries parameters; `needsRehash` true for weaker parameters, and a login rehashes
- unknown-email path performs a dummy verify (timing-equivalence asserted by call, not by stopwatch)
- policy rejects < 12 characters, email-as-password, common passwords

**Session lifecycle and revocation** (`tests/scenarios/staffSessions.test.ts`)
- only the token hash is stored; a guessed or altered token is refused
- idle expiry (2 h) and absolute expiry (12 h) with a fixed clock
- logout revokes; password change revokes all others and keeps the current device; admin reset, deactivation and role/district change revoke all
- a revoked session is refused on the very next request
- `mustChangePassword` blocks everything except change-password and sign-out

**CSRF** (`tests/scenarios/csrf.test.ts`)
- cross-origin POST with a valid session cookie → 403
- missing Origin on a cookie-authenticated mutation → 403
- `text/plain` body containing JSON → 415
- same-origin JSON POST → allowed
- architecture test: every mutating route uses `mutation()`

**Rate limiting** (`tests/scenarios/loginRateLimit.test.ts`)
- 5 failures lock the account; the 6th attempt with the right password is refused
- lock expires after the window; repeated lockouts double, capped
- per-IP throttle across many accounts
- identical response body for wrong password, unknown email and locked account

**Role permissions** (`tests/scenarios/staffPermissions.test.ts`)
- table-driven over every staff route × every role, asserting allowed / refused per §2
- no role, including admin, can decide an approval without consent evidence
- only field workers can record consent; admins cannot take cases

**District isolation** (`tests/scenarios/districtIsolation.test.ts`)
- a staff member in district A gets `NOT_FOUND` for a district-B citizen on **every** citizen-scoped API route and page (table-driven from the route list)
- assignment of a district-B case to them grants access to that citizen only, and only while the case is open
- the queue never lists another district's cases
- an `AccessLog` row is written for each permitted open, none for refusals

**Consent and recovery** (`tests/scenarios/assistedConsent.test.ts`)
- evidence + approval written atomically; evidence cannot be updated
- `PHONE` channel or `citizenPresent = false` refused for approvals
- a declined decision is recorded with evidence
- a human-recorded root cause without evidence is refused
- resolving a case never sets `RECOVERED`; re-verification is the only way, and a failed re-verification leaves the case open

**Cases** (`tests/scenarios/cases.test.ts`)
- each trigger in §7.1 opens exactly one case (idempotent on retry)
- concurrent take: exactly one wins
- deactivation returns cases to the queue
- `CLOSED_NO_ACTION` requires a reason and leaves monitoring active

**Architecture** (added to `tests/boundaries/architecture.test.ts`)
- no history deletes / audit updates outside tests and seed (§3)
- every citizen-scoped route calls `authorizeCitizen`
- `lib/auth/*` imports nothing from `next/*` except `cookies.ts`

**Smoke:** `/staff/login` renders; signed-out access to `/staff` redirects.

---

## 11. Rollout

1. Migration adds tables and nullable columns; existing demo data keeps working with `DEMO_MODE=true`.
2. The demo still runs on the persona picker; the staff portal runs alongside it.
3. Before any real citizen is registered: `DEMO_MODE=false`, create the first admin, set staff districts, and backfill `Citizen.district` for any non-demo citizens.

## Out of scope

- Citizen self-login (phone OTP), SMS, email sending.
- Two-factor authentication. **Recommended next** for admin accounts (TOTP), because an admin account can read every district.
- Real government portal integration (still the labelled simulation).

## Open questions for review

1. **Session lengths:** 2 h idle / 12 h absolute assumes shared devices in the field. Longer for office staff?
2. **Cross-district work:** should a caseworker ever see cases outside their districts (e.g. a state-level team), or is that admin-only?
3. **Priority rules** in §7.2 are a starting point; does the organisation have its own?
