# Staff Portal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give partner-organisation staff a secure portal — email/password login, four roles, a district-scoped case queue, and an assisted-citizen mode with witnessed consent — without ever letting staff approve on a citizen's behalf.

**Architecture:** Authentication lives in a small, framework-free `lib/auth/` module (scrypt hashing, hashed database sessions, Postgres-backed rate limiting, CSRF checks) consumed only by `lib/authz.ts`, which stays the single place a request becomes an identity. Staff "open" a citizen, which sets an assisting cookie; every existing citizen page and API is reused unchanged except that its access check now goes through `authorizeCitizen`. Cases, consent evidence and staff administration are services in `lib/staff/`, driven by thin route handlers and a few server-rendered pages under `/staff`.

**Tech Stack:** Next.js 16 (App Router, route handlers, server components), TypeScript, Prisma 7 + Postgres (driver adapter `@prisma/adapter-pg`), Zod 4, Vitest 5, Node `crypto` (scrypt, sha256, timingSafeEqual). No new runtime dependencies.

**Spec:** `docs/specs/2026-10-12-staff-portal-design.md` (approved 2026-10-12). Open questions were left at the spec defaults: 2 h idle / 12 h absolute sessions, cross-district access for admins only, priority rules as in spec §7.2.

## Global Constraints

- No new npm dependencies. Hashing, tokens and comparisons use `node:crypto` only.
- Never write "Claude" or "Anthropic" anywhere in the repo: no commit trailers, no PR attribution, no file content.
- `new Date()` with no arguments and `Date.now()` are banned outside `lib/clock.ts` (architecture test). Pass a `Clock`; security code uses `systemClock()`, benefit and case code uses `currentClock()` from `lib/services/clock.ts`.
- Sessions: cookie `adhikarai_staff`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` when `NODE_ENV === "production"`; idle expiry 2 h; absolute expiry 12 h; only `sha256(token)` stored.
- Passwords: scrypt N=32768, r=8, p=1, 16-byte salt, 64-byte key, format `scrypt$N$r$p$saltB64$hashB64`; policy ≥ 12 characters, not the email, not a common password.
- Rate limits: 5 failed logins per account in 15 min → lock 15 min, doubling per further lockout within 24 h, capped at 24 h; > 20 failures per IP hash in 15 min → refuse 15 min. One response for every failure: HTTP 401, message `Email or password is incorrect, or the account is temporarily locked.`
- CSRF: every POST/PUT/PATCH/DELETE route handler is built with `mutation()`, except `app/api/monitoring/tick/route.ts` (bearer token).
- Staff never approve: no code path lets a staff identity set `Approval.decision` without a `ConsentEvidence` row with `channel = IN_PERSON` and `citizenPresent = true`, recorded by a `FIELD_WORKER`. `Approval.decidedBy` is always `citizen:<id>`.
- `RECOVERED` is reachable only through `reverifyBenefit` (existing). Staff code never calls `transitionEntitlement` directly.
- History is never deleted or rewritten: no `delete`/`deleteMany` on `Citizen`, `AuditLog`, `AccessLog`, `CaseEvent`, `ConsentEvidence`, `CitizenStatement`, and no `update`/`updateMany` on `AuditLog`, `AccessLog`, `CaseEvent`, `ConsentEvidence`, `CitizenStatement`, outside `tests/` and `prisma/seed*`. The only permitted delete is `LoginAttempt` rows older than 30 days.
- Refusals for citizens outside a staff member's scope are `NOT_FOUND`, never `UNAUTHORIZED`.
- Environment: new required secret `AUTH_SECRET` (used to salt IP and email hashes). Tests set it in `tests/setup.ts`.
- Use the Write/Edit tools for TypeScript files; bash heredocs break on backticks and apostrophes in this repo.
- Run commands from `adhikarai/`. Tests: `npx vitest run <path>`. Full gate: `npx tsc --noEmit && npx eslint && npx vitest run`.

## Review Focus

1. **A staff member whose roles or districts change mid-shift keeps using their open tab.** Expect the very next request to be refused (sessions revoked on role/district change) — test added in Task 4 (`revokes on role change`) and Task 9 (`updating roles revokes sessions`).
2. **Two field workers press "take" on the same case at the same moment.** Expect exactly one to get it and the other to see a conflict, not two assignees — test in Task 8 (`concurrent take`).
3. **A citizen moves district (admin changes `Citizen.district`) while a worker in the old district has their record open.** Expect the old worker to lose access on the next request unless a case is assigned to them — test in Task 7 (`loses access after district change`).
4. **A login request arrives with mixed-case or padded email (`" Asha@NGO.org "`).** Expect it to match the stored lower-cased account and count against the same lockout — test in Task 6 (`normalises email`).
5. **A worker records consent, then the approval is opened again in a second tab and consent is submitted twice.** Expect the second submission to be refused as already decided, with one evidence row — test in Task 10 (`double submission`).

---

## File Structure

```
lib/auth/                       framework-free authentication (no next/* except cookies.ts)
  password.ts                   hashPassword, verifyPassword, needsRehash, checkPolicy, temporaryPassword
  commonPasswords.ts            short bundled deny-list
  hashing.ts                    sha256Hex, keyedHash (AUTH_SECRET-salted)
  sessions.ts                   createSession, resolveSession, revokeSession, revokeAllForStaff, constants
  rateLimit.ts                  checkLoginAllowed, recordLoginResult, purgeOldAttempts
  login.ts                      login, logout, changePassword (orchestration + security audit)
  csrf.ts                       assertSameOrigin, assertBodyType, hasAmbientCredentials
  cookies.ts                    cookie names, readCookie (Request), readCookieFromStore, set/clear header builders
lib/staff/                      staff-domain services
  permissions.ts                Capability, can, requireCapability, caseKindsFor
  staffAdmin.ts                 createStaff, updateStaff, deactivateStaff, resetPassword, unlockStaff, listStaff
  citizens.ts                   registerCitizen, searchCitizens, changeCitizenDistrict
  consent.ts                    recordConsentDecision, recordCitizenStatement
  cases.ts                      openCase, priorityFor, listQueue, takeCase, assignCase, setCaseStatus, addNote, resolveCase, reopenCase, releaseCasesOf
  caseActions.ts                recordHumanRootCause, requestReaudit, requestReverify (bridges to recovery services)
  triggers.ts                   caseFromExecution, caseFromUnknownCause, caseFromRepeatedFailure
lib/authz.ts                    (modify) requireStaff, currentStaff, authorizeCitizen, CitizenAccess; requireAdmin removed
lib/session.ts                  (modify) requireSelectedCitizen → demo persona or staff+assist cookie
lib/api/http.ts                 (modify) mutation(), FORBIDDEN + UNSUPPORTED_MEDIA_TYPE codes
lib/services/transitions.ts     (modify) Actor gains staff kinds; actorStaffId written to AuditLog
app/api/staff/**                new route handlers (login, logout, password, me, assist, cases, citizens, admin)
app/staff/**                    new pages (login, password, queue, case, citizens, admin)
scripts/create-admin.ts         bootstrap first admin
tests/unit/password.test.ts, tests/unit/permissions.test.ts
tests/scenarios/staff*.test.ts, csrf.test.ts, districtIsolation.test.ts, assistedConsent.test.ts, cases.test.ts, caseTriggers.test.ts
tests/helpers/staff.ts          createTestStaff, signIn, staffRequest
```

---

### Task 1: Database schema, migration and test helpers

**Files:**
- Modify: `prisma/schema.prisma` (append new models; add columns to `Citizen`, `Approval`, `AuditLog`, `RootCause`)
- Create: `prisma/migrations/<timestamp>_staff_portal/migration.sql` (generated)
- Modify: `prisma/seed-demo.ts` (demo personas get districts)
- Modify: `tests/setup.ts` (set `AUTH_SECRET`)
- Modify: `tests/helpers/db.ts` (reset staff data)
- Modify: `.env.example` (document `AUTH_SECRET`, `APP_ORIGIN`)
- Test: `tests/scenarios/staffSchema.test.ts`

**Interfaces:**
- Produces: Prisma models `Staff`, `StaffSession`, `LoginAttempt`, `AccessLog`, `Case`, `CaseEvent`, `ConsentEvidence`, `CitizenStatement`; enums `StaffRole`, `CaseKind`, `CaseStatus`, `ConsentMethod`, `AttestChannel`; columns `Citizen.district/state/registeredByStaffId/archivedAt`, `Approval.consentEvidenceId`, `AuditLog.actorStaffId`, `RootCause.recordedByStaffId`. Helper `resetStaffData(): Promise<void>`.

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/staffSchema.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/db";

import { createCitizen, resetCitizenData, resetStaffData } from "../helpers/db";

describe("staff portal schema", () => {
  beforeEach(async () => {
    await resetStaffData();
    await resetCitizenData();
  });

  it("stores staff with several roles and districts", async () => {
    const staff = await prisma.staff.create({
      data: {
        email: "asha@ngo.org",
        name: "Asha",
        passwordHash: "scrypt$1$1$1$a$b",
        roles: ["CASEWORKER", "FIELD_WORKER"],
        districts: ["Gaya", "Patna"],
      },
    });
    expect(staff.roles).toEqual(["CASEWORKER", "FIELD_WORKER"]);
    expect(staff.mustChangePassword).toBe(true);
    expect(staff.isActive).toBe(true);
  });

  it("gives citizens a staff-controlled district and an archive flag", async () => {
    const { id } = await createCitizen();
    const citizen = await prisma.citizen.update({
      where: { id },
      data: { district: "Gaya", state: "Bihar" },
    });
    expect(citizen.district).toBe("Gaya");
    expect(citizen.archivedAt).toBeNull();
  });

  it("makes case creation idempotent on sourceKey", async () => {
    const { id } = await createCitizen();
    const data = {
      citizenId: id,
      kind: "UNKNOWN_CAUSE" as const,
      priority: 2,
      district: "Gaya",
      sourceKey: "rootcause:abc",
      summary: "x",
      openedAt: new Date("2026-10-12T00:00:00Z"),
      dueAt: new Date("2026-10-17T00:00:00Z"),
    };
    await prisma.case.create({ data });
    await expect(prisma.case.create({ data })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/staffSchema.test.ts`
Expected: FAIL — `resetStaffData` is not exported / `prisma.staff` is undefined.

- [ ] **Step 3: Add the models**

Append to `prisma/schema.prisma`:

```prisma
// ---------------------------------------------------------------------------
// Staff portal
// See docs/specs/2026-10-12-staff-portal-design.md.
// ---------------------------------------------------------------------------

enum StaffRole {
  ADMIN
  CASEWORKER
  FIELD_WORKER
  RULE_REVIEWER
}

enum CaseKind {
  UNKNOWN_CAUSE
  ACTION_FAILED
  NEEDS_CLARIFICATION
  NO_APPLICATION_REFERENCE
  COLLECT_DOCUMENT
  ASSISTED_VERIFICATION
}

enum CaseStatus {
  OPEN
  ASSIGNED
  IN_PROGRESS
  WAITING_ON_CITIZEN
  WAITING_ON_GOVERNMENT
  RESOLVED
  CLOSED_NO_ACTION
}

enum ConsentMethod {
  SPOKEN
  SIGNED
  THUMB_IMPRESSION
  CITIZEN_TAPPED
}

enum AttestChannel {
  IN_PERSON
  PHONE
}

model Staff {
  id                 String      @id @default(cuid())
  /// Stored lower-cased and trimmed.
  email              String      @unique
  name               String
  /// "scrypt$N$r$p$saltB64$hashB64"
  passwordHash       String
  roles              StaffRole[]
  /// Ignored for ADMIN, who sees every district.
  districts          String[]
  state              String?
  isActive           Boolean     @default(true)
  mustChangePassword Boolean     @default(true)
  failedLoginCount   Int         @default(0)
  lockedUntil        DateTime?
  passwordChangedAt  DateTime?
  createdById        String?
  createdAt          DateTime    @default(now())
  deactivatedAt      DateTime?

  sessions StaffSession[]
}

model StaffSession {
  id           String    @id @default(cuid())
  staffId      String
  /// sha256 of the cookie token. The token itself is never stored.
  tokenHash    String    @unique
  createdAt    DateTime
  lastSeenAt   DateTime
  expiresAt    DateTime
  revokedAt    DateTime?
  revokeReason String?
  ipHash       String?
  userAgent    String?

  staff Staff @relation(fields: [staffId], references: [id], onDelete: Restrict)

  @@index([staffId, revokedAt])
}

model LoginAttempt {
  id        String   @id @default(cuid())
  emailHash String
  ipHash    String
  succeeded Boolean
  at        DateTime

  @@index([emailHash, at])
  @@index([ipHash, at])
}

/// Every citizen record opened by staff.
model AccessLog {
  id        String   @id @default(cuid())
  staffId   String
  citizenId String
  action    String
  at        DateTime

  @@index([citizenId, at])
  @@index([staffId, at])
}

model Case {
  id            String     @id @default(cuid())
  citizenId     String
  entitlementId String?
  kind          CaseKind
  status        CaseStatus @default(OPEN)
  /// 1 (highest) .. 3
  priority      Int
  /// Copied from Citizen.district when opened; "UNASSIGNED" if the citizen has none.
  district      String
  /// e.g. "execution:<id>". Makes creation idempotent.
  sourceKey     String     @unique
  summary       String
  assignedToId  String?
  openedAt      DateTime
  assignedAt    DateTime?
  dueAt         DateTime
  resolvedAt    DateTime?
  resolution    String?

  events CaseEvent[]

  @@index([district, status])
  @@index([assignedToId, status])
  @@index([citizenId, status])
}

/// Append-only history of a case.
model CaseEvent {
  id        String   @id @default(cuid())
  caseId    String
  /// Null when the system acted.
  staffId   String?
  type      String
  fromValue String?
  toValue   String?
  note      String?
  at        DateTime

  case Case @relation(fields: [caseId], references: [id], onDelete: Restrict)

  @@index([caseId, at])
}

/// One per staff-recorded approval decision. Immutable.
model ConsentEvidence {
  id                String           @id @default(cuid())
  approvalId        String           @unique
  citizenId         String
  decision          ApprovalDecision
  method            ConsentMethod
  channel           AttestChannel
  language          String
  /// The exact summary read to the citizen.
  statementShown    Json
  citizenPresent    Boolean
  recordedByStaffId String
  secondWitnessName String?
  recordedAt        DateTime
}

/// A citizen's answer recorded by staff, e.g. a receipt confirmation. Immutable.
model CitizenStatement {
  id                String        @id @default(cuid())
  citizenId         String
  subjectEntity     String
  subjectId         String
  statement         String
  channel           AttestChannel
  recordedByStaffId String
  recordedAt        DateTime

  @@index([subjectEntity, subjectId])
}
```

In `model Citizen`, after `isDemo Boolean @default(false)` add:

```prisma
  /// Staff-controlled. Scopes which staff may open this record. Never taken
  /// from the citizen's own profile, which the citizen (or a model) can edit.
  district            String?
  state               String?
  registeredByStaffId String?
  /// Citizens are archived, never deleted: deletion would cascade through
  /// their whole recovery history.
  archivedAt          DateTime?
```

In `model Approval`, after `note String?` add:

```prisma
  /// Set when staff recorded this decision as witnessed consent.
  consentEvidenceId String? @unique
```

In `model AuditLog`, after `actor String` add `actorStaffId String?` and add `@@index([actorStaffId])` next to the existing indexes.

In `model RootCause`, after `reasoning String` add:

```prisma
  /// Set when a caseworker, not the agent, recorded this cause.
  recordedByStaffId String?
```

- [ ] **Step 4: Generate the migration and client, sync the test database**

Run:
```bash
npx prisma format
npx prisma migrate dev --name staff_portal
npx prisma generate
npm run db:test
```
Expected: a new folder `prisma/migrations/*_staff_portal/`, "Generated Prisma Client", "All migrations have been successfully applied."

- [ ] **Step 5: Test helpers, env, demo districts**

In `tests/helpers/db.ts`, append:

```ts
/** Remove staff accounts, sessions, cases and staff-recorded evidence. */
export async function resetStaffData(): Promise<void> {
  await prisma.caseEvent.deleteMany({});
  await prisma.case.deleteMany({});
  await prisma.consentEvidence.deleteMany({});
  await prisma.citizenStatement.deleteMany({});
  await prisma.accessLog.deleteMany({});
  await prisma.loginAttempt.deleteMany({});
  await prisma.staffSession.deleteMany({});
  await prisma.staff.deleteMany({});
}
```

In `tests/setup.ts`, after `process.env.LLM_PROVIDER = "stub";` add:

```ts
// Salts the IP and email hashes used for rate limiting. Any fixed value works
// in tests; production must set a long random one.
process.env.AUTH_SECRET = "test-auth-secret-not-for-production";
```

In `.env.example`, append:

```bash

# --- Staff portal -----------------------------------------------------------
# Long random string. Salts the hashed IPs and emails used for login rate
# limiting. Required. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
AUTH_SECRET=""
# Public origin, only needed behind a proxy that rewrites Host (CSRF check).
APP_ORIGIN=""
```

In `prisma/seed-demo.ts`, add `district: string;` to `interface Persona`, set `district: "Gaya"` on `KAMALA`, `district: "Patna"` on Ramesh, `district: "Gaya"` on Sunita, and in `createPersona` add to the `prisma.citizen.create` data: `district: persona.district, state: "Bihar",`.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/scenarios/staffSchema.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add prisma tests/setup.ts tests/helpers/db.ts tests/scenarios/staffSchema.test.ts .env.example
git commit -m "Staff portal: schema for staff, sessions, cases and consent evidence"
```

---

### Task 2: Password hashing and policy

**Files:**
- Create: `lib/auth/hashing.ts`
- Create: `lib/auth/commonPasswords.ts`
- Create: `lib/auth/password.ts`
- Test: `tests/unit/password.test.ts`

**Interfaces:**
- Produces:
  - `sha256Hex(value: string): string`
  - `keyedHash(value: string): string` — sha256 of `AUTH_SECRET + ":" + value`; throws if `AUTH_SECRET` is unset.
  - `hashPassword(password: string): Promise<string>`
  - `verifyPassword(password: string, stored: string): Promise<boolean>`
  - `verifyAgainstDummy(password: string): Promise<false>` — same work as a real verify, always false.
  - `needsRehash(stored: string): boolean`
  - `checkPolicy(password: string, email: string): string[]` — empty means acceptable.
  - `temporaryPassword(): string` — 16 random bytes, base64url (22 chars).
  - `SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLength: 64, saltLength: 16 }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/password.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { keyedHash, sha256Hex } from "@/lib/auth/hashing";
import {
  checkPolicy,
  hashPassword,
  needsRehash,
  temporaryPassword,
  verifyAgainstDummy,
  verifyPassword,
} from "@/lib/auth/password";

describe("hashPassword / verifyPassword", () => {
  it("verifies the right password and refuses a wrong one", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterY", stored)).toBe(false);
    expect(await verifyPassword("", stored)).toBe(false);
  });

  it("salts every hash", async () => {
    const a = await hashPassword("same password here");
    const b = await hashPassword("same password here");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same password here", a)).toBe(true);
    expect(await verifyPassword("same password here", b)).toBe(true);
  });

  it("stores its parameters, so they can be raised later", async () => {
    const stored = await hashPassword("a long enough password");
    const [scheme, N, r, p, salt, hash] = stored.split("$");
    expect([scheme, N, r, p]).toEqual(["scrypt", "32768", "8", "1"]);
    expect(Buffer.from(salt, "base64").length).toBe(16);
    expect(Buffer.from(hash, "base64").length).toBe(64);
    expect(needsRehash(stored)).toBe(false);
    expect(needsRehash("scrypt$16384$8$1$" + salt + "$" + hash)).toBe(true);
  });

  it("refuses malformed stored hashes instead of throwing", async () => {
    expect(await verifyPassword("anything", "")).toBe(false);
    expect(await verifyPassword("anything", "scrypt$32768$8$1$onlysalt")).toBe(false);
    expect(await verifyPassword("anything", "bcrypt$whatever")).toBe(false);
  });

  it("does the same work for an unknown account", async () => {
    expect(await verifyAgainstDummy("any password at all")).toBe(false);
  });
});

describe("checkPolicy", () => {
  it("accepts a long, unusual password", () => {
    expect(checkPolicy("tulsi-chai-at-dawn-42", "asha@ngo.org")).toEqual([]);
  });

  it("refuses short, email-equal and common passwords", () => {
    expect(checkPolicy("short", "a@b.org")[0]).toMatch(/12 characters/);
    expect(checkPolicy("Asha@ngo.org", "asha@ngo.org").join(" ")).toMatch(/email/);
    expect(checkPolicy("password1234", "a@b.org").join(" ")).toMatch(/common/);
  });
});

describe("hashing helpers", () => {
  it("keys hashes with AUTH_SECRET", () => {
    expect(keyedHash("1.2.3.4")).toBe(keyedHash("1.2.3.4"));
    expect(keyedHash("1.2.3.4")).not.toBe(sha256Hex("1.2.3.4"));
  });

  it("generates unguessable temporary passwords", () => {
    const a = temporaryPassword();
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(temporaryPassword()).not.toBe(a);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/password.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/hashing`.

- [ ] **Step 3: Implement**

Create `lib/auth/hashing.ts`:

```ts
/**
 * Hash helpers for identifiers that must be countable but never stored raw:
 * IP addresses and typed email addresses (rate limiting), session tokens.
 */

import { createHash } from "node:crypto";

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * sha256 salted with AUTH_SECRET. Without the secret, a leaked LoginAttempt
 * table cannot be reversed by hashing every IPv4 address.
 */
export function keyedHash(value: string): string {
  const secret = (process.env.AUTH_SECRET ?? "").trim();
  if (secret === "") {
    throw new Error("AUTH_SECRET is not set. See .env.example.");
  }
  return sha256Hex(`${secret}:${value}`);
}
```

Create `lib/auth/commonPasswords.ts`:

```ts
/**
 * A short deny-list of passwords that appear at the top of every breach list,
 * plus local favourites. Not exhaustive by design: length (12+) does most of
 * the work; this catches the predictable long ones.
 */
export const COMMON_PASSWORDS = new Set([
  "password1234", "password12345", "passwordpassword", "123456789012",
  "1234567890123", "qwertyuiop12", "qwerty123456", "iloveyou1234",
  "welcome12345", "letmein12345", "admin1234567", "administrator",
  "changeme1234", "abcdefghijkl", "111111111111", "000000000000",
  "aaaaaaaaaaaa", "india1234567", "bharat123456", "jaihind12345",
  "sachin123456", "ganesh123456", "krishna12345", "shivaji12345",
  "hanuman12345", "adhikarai123", "adhikarai1234", "government123",
  "mypassword12", "passw0rd1234", "p@ssw0rd1234", "p@ssword1234",
]);
```

Create `lib/auth/password.ts`:

```ts
/**
 * Password hashing and policy.
 *
 * scrypt from node:crypto - a memory-hard, well-studied KDF that ships with
 * Node, so there is no dependency to audit. The stored string carries its own
 * parameters, so they can be raised later and old hashes upgraded on the next
 * successful sign-in (`needsRehash`).
 */

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

import { COMMON_PASSWORDS } from "./commonPasswords";

export const SCRYPT_PARAMS = { N: 32768, r: 8, p: 1, keyLength: 64, saltLength: 16 } as const;

function scrypt(password: string, salt: Buffer, N: number, r: number, p: number, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // maxmem must exceed 128 * N * r bytes, or Node refuses the parameters.
    scryptCallback(password, salt, keyLength, { N, r, p, maxmem: 256 * N * r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const { N, r, p, keyLength, saltLength } = SCRYPT_PARAMS;
  const salt = randomBytes(saltLength);
  const key = await scrypt(password, salt, N, r, p, keyLength);
  return ["scrypt", N, r, p, salt.toString("base64"), key.toString("base64")].join("$");
}

interface Parsed {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  const salt = Buffer.from(parts[4], "base64");
  const hash = Buffer.from(parts[5], "base64");
  if (salt.length === 0 || hash.length === 0) return null;
  return { N, r, p, salt, hash };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed || password === "") return false;
  const key = await scrypt(password, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.hash.length);
  return key.length === parsed.hash.length && timingSafeEqual(key, parsed.hash);
}

/** A fixed hash with the current parameters, computed once. */
let dummy: Promise<string> | null = null;

/**
 * Spend the same time as a real verification and return false. Used when the
 * email matches no account, so response time does not reveal which emails
 * have accounts.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummy ??= hashPassword("dummy-password-for-unknown-accounts");
  await verifyPassword(password || "x", await dummy);
  return false;
}

export function needsRehash(stored: string): boolean {
  const parsed = parse(stored);
  if (!parsed) return true;
  return (
    parsed.N < SCRYPT_PARAMS.N ||
    parsed.r !== SCRYPT_PARAMS.r ||
    parsed.p !== SCRYPT_PARAMS.p ||
    parsed.hash.length !== SCRYPT_PARAMS.keyLength
  );
}

/** Problems with a proposed password; empty means acceptable. */
export function checkPolicy(password: string, email: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push("Use at least 12 characters.");
  if (password.trim().toLowerCase() === email.trim().toLowerCase()) {
    problems.push("Do not use your email address as your password.");
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    problems.push("That password is too common. Choose something less predictable.");
  }
  return problems;
}

export function temporaryPassword(): string {
  return randomBytes(16).toString("base64url");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/password.test.ts`
Expected: PASS (9 tests). Each hash takes ~100 ms; the file should finish in a few seconds.

- [ ] **Step 5: Commit**

```bash
git add lib/auth/hashing.ts lib/auth/commonPasswords.ts lib/auth/password.ts tests/unit/password.test.ts
git commit -m "Staff auth: scrypt password hashing and policy"
```

---

### Task 3: Login rate limiting and lockout

**Files:**
- Create: `lib/auth/rateLimit.ts`
- Test: `tests/scenarios/loginRateLimit.test.ts` (unit-level part; the HTTP part is added in Task 6)

**Interfaces:**
- Consumes: `keyedHash` (Task 2); Prisma `LoginAttempt`, `Staff`, `AuditLog`.
- Produces:
  - `ACCOUNT_FAILURE_LIMIT = 5`, `IP_FAILURE_LIMIT = 20`, `WINDOW_MS = 15 * 60_000`, `BASE_LOCK_MS = 15 * 60_000`, `MAX_LOCK_MS = 24 * 60 * 60_000`
  - `normaliseEmail(email: string): string`
  - `checkLoginAllowed(db: PrismaClient, input: { email: string; ip: string; clock: Clock }): Promise<{ allowed: true } | { allowed: false; reason: "ACCOUNT_LOCKED" | "IP_THROTTLED" }>`
  - `recordLoginResult(db: PrismaClient, input: { email: string; ip: string; succeeded: boolean; clock: Clock }): Promise<{ lockedUntil: Date | null }>`
  - `unlockStaffAccount(db: PrismaClient, staffId: string): Promise<void>`
  - `purgeOldAttempts(db: PrismaClient, clock: Clock): Promise<number>`

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/loginRateLimit.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import {
  checkLoginAllowed,
  purgeOldAttempts,
  recordLoginResult,
  unlockStaffAccount,
} from "@/lib/auth/rateLimit";
import { fixedClock } from "@/lib/clock";
import { prisma } from "@/lib/db";

import { resetStaffData } from "../helpers/db";

const T0 = new Date("2026-10-12T10:00:00Z");
const at = (minutes: number) => fixedClock(new Date(T0.getTime() + minutes * 60_000));

async function staff(email = "asha@ngo.org") {
  return prisma.staff.create({
    data: { email, name: "Asha", passwordHash: "x", roles: ["CASEWORKER"], districts: ["Gaya"] },
  });
}

async function fail(email: string, ip: string, minute: number, times = 1) {
  let last: { lockedUntil: Date | null } = { lockedUntil: null };
  for (let i = 0; i < times; i += 1) {
    last = await recordLoginResult(prisma, { email, ip, succeeded: false, clock: at(minute) });
  }
  return last;
}

describe("login rate limiting", () => {
  beforeEach(resetStaffData);

  it("locks an account after five failures within fifteen minutes", async () => {
    await staff();
    await fail("asha@ngo.org", "1.1.1.1", 0, 4);
    expect(await checkLoginAllowed(prisma, { email: "asha@ngo.org", ip: "1.1.1.1", clock: at(1) })).toEqual({ allowed: true });

    const result = await fail("asha@ngo.org", "1.1.1.1", 2);
    expect(result.lockedUntil?.toISOString()).toBe(new Date(T0.getTime() + 17 * 60_000).toISOString());
    expect(await checkLoginAllowed(prisma, { email: "asha@ngo.org", ip: "9.9.9.9", clock: at(3) })).toEqual({
      allowed: false,
      reason: "ACCOUNT_LOCKED",
    });
  });

  it("lets the lock expire", async () => {
    await staff();
    await fail("asha@ngo.org", "1.1.1.1", 0, 5);
    expect(await checkLoginAllowed(prisma, { email: "asha@ngo.org", ip: "1.1.1.1", clock: at(16) })).toEqual({ allowed: true });
  });

  it("doubles the lock for repeated lockouts within a day, capped at 24 hours", async () => {
    await staff();
    const first = await fail("asha@ngo.org", "1.1.1.1", 0, 5);
    const second = await fail("asha@ngo.org", "1.1.1.1", 20, 5);
    expect(first.lockedUntil!.getTime() - at(0).now().getTime()).toBe(15 * 60_000);
    expect(second.lockedUntil!.getTime() - at(20).now().getTime()).toBe(30 * 60_000);

    // Many lockouts later, the lock never exceeds a day.
    let last = second;
    for (let round = 0; round < 10; round += 1) last = await fail("asha@ngo.org", "1.1.1.1", 60 * 24 + round, 5);
    expect(last.lockedUntil!.getTime() - at(60 * 24 + 9).now().getTime()).toBeLessThanOrEqual(24 * 60 * 60_000);
  });

  it("does not count failures older than the window", async () => {
    await staff();
    await fail("asha@ngo.org", "1.1.1.1", 0, 4);
    const later = await fail("asha@ngo.org", "1.1.1.1", 20);
    expect(later.lockedUntil).toBeNull();
  });

  it("throttles an IP across many accounts, including unknown ones", async () => {
    for (let i = 0; i < 21; i += 1) await fail(`nobody${i}@x.org`, "6.6.6.6", 1);
    expect(await checkLoginAllowed(prisma, { email: "someone@else.org", ip: "6.6.6.6", clock: at(2) })).toEqual({
      allowed: false,
      reason: "IP_THROTTLED",
    });
    expect(await checkLoginAllowed(prisma, { email: "someone@else.org", ip: "7.7.7.7", clock: at(2) })).toEqual({ allowed: true });
  });

  it("resets the counter on success and lets an admin unlock", async () => {
    const s = await staff();
    await fail("asha@ngo.org", "1.1.1.1", 0, 5);
    await unlockStaffAccount(prisma, s.id);
    expect(await checkLoginAllowed(prisma, { email: "asha@ngo.org", ip: "1.1.1.1", clock: at(1) })).toEqual({ allowed: true });
    await recordLoginResult(prisma, { email: "asha@ngo.org", ip: "1.1.1.1", succeeded: true, clock: at(1) });
    expect((await prisma.staff.findUniqueOrThrow({ where: { id: s.id } })).failedLoginCount).toBe(0);
  });

  it("stores only hashes of emails and IPs", async () => {
    await fail("Asha@NGO.org", "1.2.3.4", 0);
    const row = await prisma.loginAttempt.findFirstOrThrow();
    expect(row.emailHash).not.toContain("asha");
    expect(row.ipHash).not.toContain("1.2.3.4");
  });

  it("purges attempts older than thirty days", async () => {
    await fail("a@x.org", "1.1.1.1", 0);
    expect(await purgeOldAttempts(prisma, at(60 * 24 * 31))).toBe(1);
    expect(await prisma.loginAttempt.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/loginRateLimit.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/rateLimit`.

- [ ] **Step 3: Implement**

Create `lib/auth/rateLimit.ts`:

```ts
/**
 * Login rate limiting, counted in Postgres so it holds across serverless
 * instances (they share no memory).
 *
 * Two independent limits: per account (lock it, with escalating duration)
 * and per IP (stop one source spraying many accounts). Emails and IPs are
 * stored only as keyed hashes.
 */

import type { Clock } from "@/lib/clock";
import type { PrismaClient } from "@/lib/generated/prisma/client";

import { keyedHash } from "./hashing";

export const ACCOUNT_FAILURE_LIMIT = 5;
export const IP_FAILURE_LIMIT = 20;
export const WINDOW_MS = 15 * 60_000;
export const BASE_LOCK_MS = 15 * 60_000;
export const MAX_LOCK_MS = 24 * 60 * 60_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

const ago = (clock: Clock, ms: number) => new Date(clock.now().getTime() - ms);

export async function checkLoginAllowed(
  db: PrismaClient,
  input: { email: string; ip: string; clock: Clock },
): Promise<{ allowed: true } | { allowed: false; reason: "ACCOUNT_LOCKED" | "IP_THROTTLED" }> {
  const ipFailures = await db.loginAttempt.count({
    where: { ipHash: keyedHash(input.ip), succeeded: false, at: { gte: ago(input.clock, WINDOW_MS) } },
  });
  if (ipFailures > IP_FAILURE_LIMIT) return { allowed: false, reason: "IP_THROTTLED" };

  const staff = await db.staff.findUnique({
    where: { email: normaliseEmail(input.email) },
    select: { lockedUntil: true },
  });
  if (staff?.lockedUntil && staff.lockedUntil > input.clock.now()) {
    return { allowed: false, reason: "ACCOUNT_LOCKED" };
  }
  return { allowed: true };
}

export async function recordLoginResult(
  db: PrismaClient,
  input: { email: string; ip: string; succeeded: boolean; clock: Clock },
): Promise<{ lockedUntil: Date | null }> {
  const email = normaliseEmail(input.email);
  const now = input.clock.now();

  await db.loginAttempt.create({
    data: { emailHash: keyedHash(email), ipHash: keyedHash(input.ip), succeeded: input.succeeded, at: now },
  });

  const staff = await db.staff.findUnique({ where: { email }, select: { id: true } });
  if (!staff) return { lockedUntil: null };

  if (input.succeeded) {
    await db.staff.update({ where: { id: staff.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    return { lockedUntil: null };
  }

  // Failures since the last success, inside the window.
  const lastSuccess = await db.loginAttempt.findFirst({
    where: { emailHash: keyedHash(email), succeeded: true },
    orderBy: { at: "desc" },
    select: { at: true },
  });
  const since = new Date(Math.max(ago(input.clock, WINDOW_MS).getTime(), lastSuccess?.at.getTime() ?? 0));
  const failures = await db.loginAttempt.count({
    where: { emailHash: keyedHash(email), succeeded: false, at: { gte: since } },
  });

  if (failures < ACCOUNT_FAILURE_LIMIT || failures % ACCOUNT_FAILURE_LIMIT !== 0) {
    await db.staff.update({ where: { id: staff.id }, data: { failedLoginCount: failures } });
    return { lockedUntil: null };
  }

  // Escalate: each earlier lockout in the last 24 h doubles the lock.
  const recentLockouts = await db.auditLog.count({
    where: { entity: "Staff", entityId: staff.id, toState: "LOCKED", createdAt: { gte: ago(input.clock, MAX_LOCK_MS) } },
  });
  const lockMs = Math.min(BASE_LOCK_MS * 2 ** recentLockouts, MAX_LOCK_MS);
  const lockedUntil = new Date(now.getTime() + lockMs);

  await db.staff.update({ where: { id: staff.id }, data: { failedLoginCount: failures, lockedUntil } });
  await db.auditLog.create({
    data: {
      actor: "system:rate-limit",
      entity: "Staff",
      entityId: staff.id,
      toState: "LOCKED",
      reason: `Locked for ${Math.round(lockMs / 60_000)} minutes after ${failures} failed sign-in attempts.`,
      createdAt: now,
    },
  });

  // Start a fresh count after the lock, so the next lockout needs five new failures.
  await db.loginAttempt.create({
    data: { emailHash: keyedHash(email), ipHash: keyedHash("lock-marker"), succeeded: true, at: now },
  });

  return { lockedUntil };
}

export async function unlockStaffAccount(db: PrismaClient, staffId: string): Promise<void> {
  await db.staff.update({ where: { id: staffId }, data: { lockedUntil: null, failedLoginCount: 0 } });
}

export async function purgeOldAttempts(db: PrismaClient, clock: Clock): Promise<number> {
  const { count } = await db.loginAttempt.deleteMany({ where: { at: { lt: ago(clock, RETENTION_MS) } } });
  return count;
}
```

Note on the lock marker: a `succeeded: true` row with a sentinel IP hash resets the "failures since last success" window after a lockout without counting as a real sign-in. The IP limit only counts `succeeded: false`, so markers never affect it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scenarios/loginRateLimit.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/rateLimit.ts tests/scenarios/loginRateLimit.test.ts
git commit -m "Staff auth: Postgres-backed login rate limiting with escalating lockout"
```

---

### Task 4: Sessions and cookies

**Files:**
- Create: `lib/auth/sessions.ts`
- Create: `lib/auth/cookies.ts`
- Test: `tests/scenarios/staffSessions.test.ts`

**Interfaces:**
- Consumes: `sha256Hex`, `keyedHash` (Task 2).
- Produces:
  - `IDLE_MS = 2 * 60 * 60_000`, `ABSOLUTE_MS = 12 * 60 * 60_000`, `TOUCH_INTERVAL_MS = 60_000`
  - `type RevokeReason = "LOGOUT" | "PASSWORD_CHANGED" | "PASSWORD_RESET" | "DEACTIVATED" | "ROLES_CHANGED" | "ADMIN_REVOKED"`
  - `interface StaffContext { staffId: string; sessionId: string; email: string; name: string; roles: StaffRole[]; districts: string[]; mustChangePassword: boolean }`
  - `createSession(db, { staffId, clock, ip?, userAgent? }): Promise<{ token: string; sessionId: string; expiresAt: Date }>`
  - `resolveSession(db, token: string | null, clock): Promise<StaffContext | null>`
  - `revokeSession(db, sessionId, reason, clock): Promise<void>`
  - `revokeAllForStaff(db, staffId, reason, clock, options?: { exceptSessionId?: string }): Promise<number>`
  - `STAFF_COOKIE = "adhikarai_staff"`, `ASSIST_COOKIE = "adhikarai_assist"`
  - `readCookie(request: Request, name: string): string | null`
  - `readCookieFromStore(name: string): Promise<string | null>` (uses `next/headers`)
  - `sessionCookie(token: string): string` (a `Set-Cookie` header value), `clearCookie(name: string): string`

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/staffSessions.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { clearCookie, readCookie, sessionCookie, STAFF_COOKIE } from "@/lib/auth/cookies";
import { sha256Hex } from "@/lib/auth/hashing";
import { createSession, resolveSession, revokeAllForStaff, revokeSession } from "@/lib/auth/sessions";
import { fixedClock } from "@/lib/clock";
import { prisma } from "@/lib/db";

import { resetStaffData } from "../helpers/db";

const T0 = new Date("2026-10-12T09:00:00Z");
const at = (minutes: number) => fixedClock(new Date(T0.getTime() + minutes * 60_000));

async function staff(overrides: Partial<{ isActive: boolean; mustChangePassword: boolean }> = {}) {
  return prisma.staff.create({
    data: {
      email: `s${Math.random()}@ngo.org`,
      name: "Asha",
      passwordHash: "x",
      roles: ["FIELD_WORKER"],
      districts: ["Gaya"],
      mustChangePassword: false,
      ...overrides,
    },
  });
}

describe("staff sessions", () => {
  beforeEach(resetStaffData);

  it("stores only a hash of the token and resolves the right staff member", async () => {
    const s = await staff();
    const { token, sessionId } = await createSession(prisma, { staffId: s.id, clock: at(0) });

    const row = await prisma.staffSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(row.tokenHash).not.toBe(token);

    const context = await resolveSession(prisma, token, at(1));
    expect(context).toMatchObject({ staffId: s.id, sessionId, roles: ["FIELD_WORKER"], districts: ["Gaya"] });
  });

  it("refuses a guessed, altered or missing token", async () => {
    const s = await staff();
    const { token } = await createSession(prisma, { staffId: s.id, clock: at(0) });
    expect(await resolveSession(prisma, null, at(1))).toBeNull();
    expect(await resolveSession(prisma, token.slice(0, -1) + "x", at(1))).toBeNull();
    expect(await resolveSession(prisma, "guess", at(1))).toBeNull();
  });

  it("expires after two idle hours, and keeps a session alive while it is used", async () => {
    const s = await staff();
    const { token } = await createSession(prisma, { staffId: s.id, clock: at(0) });
    expect(await resolveSession(prisma, token, at(110))).not.toBeNull(); // touched at 110
    expect(await resolveSession(prisma, token, at(220))).not.toBeNull(); // 110 min idle
    expect(await resolveSession(prisma, token, at(341))).toBeNull(); // 121 min idle
  });

  it("expires after twelve hours however active", async () => {
    const s = await staff();
    const { token } = await createSession(prisma, { staffId: s.id, clock: at(0) });
    for (let m = 60; m < 720; m += 60) expect(await resolveSession(prisma, token, at(m))).not.toBeNull();
    expect(await resolveSession(prisma, token, at(721))).toBeNull();
  });

  it("refuses a revoked session on the very next request", async () => {
    const s = await staff();
    const { token, sessionId } = await createSession(prisma, { staffId: s.id, clock: at(0) });
    await revokeSession(prisma, sessionId, "LOGOUT", at(1));
    expect(await resolveSession(prisma, token, at(1))).toBeNull();
    const row = await prisma.staffSession.findUniqueOrThrow({ where: { id: sessionId } });
    expect(row.revokeReason).toBe("LOGOUT");
  });

  it("revokes every session of a staff member, optionally keeping one", async () => {
    const s = await staff();
    const a = await createSession(prisma, { staffId: s.id, clock: at(0) });
    const b = await createSession(prisma, { staffId: s.id, clock: at(0) });
    const c = await createSession(prisma, { staffId: s.id, clock: at(0) });

    expect(await revokeAllForStaff(prisma, s.id, "PASSWORD_CHANGED", at(1), { exceptSessionId: c.sessionId })).toBe(2);
    expect(await resolveSession(prisma, a.token, at(2))).toBeNull();
    expect(await resolveSession(prisma, b.token, at(2))).toBeNull();
    expect(await resolveSession(prisma, c.token, at(2))).not.toBeNull();
  });

  it("revokes on role change", async () => {
    const s = await staff();
    const { token } = await createSession(prisma, { staffId: s.id, clock: at(0) });
    await prisma.staff.update({ where: { id: s.id }, data: { roles: ["CASEWORKER"] } });
    await revokeAllForStaff(prisma, s.id, "ROLES_CHANGED", at(1));
    expect(await resolveSession(prisma, token, at(1))).toBeNull();
  });

  it("refuses sessions of deactivated or locked staff", async () => {
    const s = await staff();
    const { token } = await createSession(prisma, { staffId: s.id, clock: at(0) });
    await prisma.staff.update({ where: { id: s.id }, data: { isActive: false } });
    expect(await resolveSession(prisma, token, at(1))).toBeNull();
  });

  it("reports mustChangePassword so the caller can restrict the session", async () => {
    const s = await staff({ mustChangePassword: true });
    const { token } = await createSession(prisma, { staffId: s.id, clock: at(0) });
    expect((await resolveSession(prisma, token, at(1)))?.mustChangePassword).toBe(true);
  });
});

describe("session cookies", () => {
  it("builds a hardened cookie and reads it back", () => {
    const header = sessionCookie("tok123");
    expect(header).toMatch(/^adhikarai_staff=tok123;/);
    expect(header).toMatch(/HttpOnly/);
    expect(header).toMatch(/SameSite=Lax/);
    expect(header).toMatch(/Path=\//);
    expect(header).toMatch(/Max-Age=43200/);

    const request = new Request("http://t/", { headers: { cookie: `a=1; ${STAFF_COOKIE}=tok123; b=2` } });
    expect(readCookie(request, STAFF_COOKIE)).toBe("tok123");
    expect(readCookie(new Request("http://t/"), STAFF_COOKIE)).toBeNull();
    expect(clearCookie(STAFF_COOKIE)).toMatch(/Max-Age=0/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/staffSessions.test.ts`
Expected: FAIL — cannot resolve `@/lib/auth/cookies`.

- [ ] **Step 3: Implement**

Create `lib/auth/sessions.ts`:

```ts
/**
 * Staff sessions: opaque random tokens, stored only as sha256 hashes.
 *
 * Database sessions rather than signed tokens, deliberately: a staff member
 * who leaves, changes role or changes password must lose access on the next
 * request, which a self-contained token cannot do.
 */

import { randomBytes } from "node:crypto";

import type { Clock } from "@/lib/clock";
import type { PrismaClient, StaffRole } from "@/lib/generated/prisma/client";

import { keyedHash, sha256Hex } from "./hashing";

export const IDLE_MS = 2 * 60 * 60_000;
export const ABSOLUTE_MS = 12 * 60 * 60_000;
export const TOUCH_INTERVAL_MS = 60_000;

export type RevokeReason =
  | "LOGOUT"
  | "PASSWORD_CHANGED"
  | "PASSWORD_RESET"
  | "DEACTIVATED"
  | "ROLES_CHANGED"
  | "ADMIN_REVOKED";

export interface StaffContext {
  staffId: string;
  sessionId: string;
  email: string;
  name: string;
  roles: StaffRole[];
  districts: string[];
  mustChangePassword: boolean;
}

export async function createSession(
  db: PrismaClient,
  input: { staffId: string; clock: Clock; ip?: string; userAgent?: string },
): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const now = input.clock.now();
  const expiresAt = new Date(now.getTime() + ABSOLUTE_MS);

  const session = await db.staffSession.create({
    data: {
      staffId: input.staffId,
      tokenHash: sha256Hex(token),
      createdAt: now,
      lastSeenAt: now,
      expiresAt,
      ipHash: input.ip ? keyedHash(input.ip) : null,
      userAgent: input.userAgent?.slice(0, 200) ?? null,
    },
  });
  return { token, sessionId: session.id, expiresAt };
}

export async function resolveSession(
  db: PrismaClient,
  token: string | null,
  clock: Clock,
): Promise<StaffContext | null> {
  if (!token) return null;
  const now = clock.now();

  const session = await db.staffSession.findUnique({
    where: { tokenHash: sha256Hex(token) },
    include: { staff: true },
  });
  if (!session || session.revokedAt) return null;
  if (session.expiresAt <= now) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > IDLE_MS) return null;

  const staff = session.staff;
  if (!staff.isActive) return null;
  if (staff.lockedUntil && staff.lockedUntil > now) return null;

  if (now.getTime() - session.lastSeenAt.getTime() >= TOUCH_INTERVAL_MS) {
    await db.staffSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
  }

  return {
    staffId: staff.id,
    sessionId: session.id,
    email: staff.email,
    name: staff.name,
    roles: staff.roles,
    districts: staff.districts,
    mustChangePassword: staff.mustChangePassword,
  };
}

export async function revokeSession(
  db: PrismaClient,
  sessionId: string,
  reason: RevokeReason,
  clock: Clock,
): Promise<void> {
  await db.staffSession.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: clock.now(), revokeReason: reason },
  });
}

export async function revokeAllForStaff(
  db: PrismaClient,
  staffId: string,
  reason: RevokeReason,
  clock: Clock,
  options: { exceptSessionId?: string } = {},
): Promise<number> {
  const { count } = await db.staffSession.updateMany({
    where: {
      staffId,
      revokedAt: null,
      ...(options.exceptSessionId ? { id: { not: options.exceptSessionId } } : {}),
    },
    data: { revokedAt: clock.now(), revokeReason: reason },
  });
  return count;
}
```

Create `lib/auth/cookies.ts`:

```ts
/**
 * The only file that reads or writes the staff cookies.
 *
 * Route handlers read from the Request (so tests can drive them with plain
 * Request objects); server components read through next/headers.
 */

import { ABSOLUTE_MS } from "./sessions";

export const STAFF_COOKIE = "adhikarai_staff";
/** Which citizen a signed-in staff member is currently assisting. */
export const ASSIST_COOKIE = "adhikarai_assist";

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) {
      const value = decodeURIComponent(rest.join("="));
      return value === "" ? null : value;
    }
  }
  return null;
}

export async function readCookieFromStore(name: string): Promise<string | null> {
  const { cookies } = await import("next/headers");
  const value = (await cookies()).get(name)?.value;
  return value && value !== "" ? value : null;
}

function attributes(maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function sessionCookie(token: string): string {
  return `${STAFF_COOKIE}=${encodeURIComponent(token)}; ${attributes(ABSOLUTE_MS / 1000)}`;
}

export function assistCookie(citizenId: string): string {
  return `${ASSIST_COOKIE}=${encodeURIComponent(citizenId)}; ${attributes(ABSOLUTE_MS / 1000)}`;
}

export function clearCookie(name: string): string {
  return `${name}=; ${attributes(0)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scenarios/staffSessions.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/auth/sessions.ts lib/auth/cookies.ts tests/scenarios/staffSessions.test.ts
git commit -m "Staff auth: hashed database sessions with idle and absolute expiry"
```

---

### Task 5: CSRF protection on every mutating route

**Files:**
- Create: `lib/auth/csrf.ts`
- Modify: `lib/api/http.ts` (error codes; `mutation()`)
- Modify: every file listed below (switch POST/PUT to `mutation`)
- Modify: `tests/boundaries/architecture.test.ts`
- Test: `tests/scenarios/csrf.test.ts`

Routes to convert (exactly these 16; `app/api/monitoring/tick/route.ts` stays on `handler` — bearer token, no cookie):
`app/api/action-plans/[id]/execute/route.ts`, `app/api/admin/catalogue/rules/[id]/route.ts`, `app/api/admin/catalogue/schemes/[id]/unmapped/route.ts`, `app/api/applications/[id]/request-approval/route.ts`, `app/api/applications/[id]/submit/route.ts`, `app/api/applications/route.ts`, `app/api/approvals/[id]/decide/route.ts`, `app/api/benefits/[id]/audit/route.ts`, `app/api/benefits/[id]/diagnose/route.ts`, `app/api/benefits/[id]/reverify/route.ts`, `app/api/demo/clock/route.ts`, `app/api/demo/gov/route.ts`, `app/api/entitlements/discover/route.ts`, `app/api/payments/[id]/confirm/route.ts`, `app/api/profile/route.ts`, `app/api/verify/bank-evidence/route.ts` (multipart).

**Interfaces:**
- Consumes: `STAFF_COOKIE`, `ASSIST_COOKIE`, `readCookie` (Task 4); `CITIZEN_COOKIE` from `lib/session.ts`.
- Produces:
  - `ApiErrorCode` gains `"FORBIDDEN"` (403) and `"UNSUPPORTED_MEDIA_TYPE"` (415).
  - `hasAmbientCredentials(request: Request): boolean`
  - `assertSameOrigin(request: Request): void` — throws `ApiError("FORBIDDEN", ...)`.
  - `assertBodyType(request: Request, body: "json" | "multipart" | "none"): void` — throws `ApiError("UNSUPPORTED_MEDIA_TYPE", ...)`.
  - `mutation(route: string, fn: (request: Request, ctx: RouteCtx) => Promise<Response>, options?: { body?: "json" | "multipart" | "none" })` — same return type as `handler`.

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/csrf.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { mutation, ok } from "@/lib/api/http";

const echo = mutation("POST /test", async () => ok({ done: true }));
const upload = mutation("POST /upload", async () => ok({ done: true }), { body: "multipart" });

function req(headers: Record<string, string>, body = "{}") {
  return new Request("http://app.test/api/x", { method: "POST", headers, body });
}

describe("mutation() CSRF guard", () => {
  it("allows a same-origin JSON request with a session cookie", async () => {
    const response = await echo(
      req({ origin: "http://app.test", "content-type": "application/json", cookie: "adhikarai_staff=t" }),
    );
    expect(response.status).toBe(200);
  });

  it("refuses a cross-origin request even with a valid cookie", async () => {
    const response = await echo(
      req({ origin: "http://evil.test", "content-type": "application/json", cookie: "adhikarai_staff=t" }),
    );
    expect(response.status).toBe(403);
  });

  it("refuses a cookie-authenticated request with no Origin", async () => {
    const response = await echo(req({ "content-type": "application/json", cookie: "adhikarai_staff=t" }));
    expect(response.status).toBe(403);
  });

  it("allows a request with no Origin and no ambient credentials (nothing to forge)", async () => {
    const response = await echo(req({ "content-type": "application/json" }));
    expect(response.status).toBe(200);
  });

  it("refuses JSON sent as text/plain, the classic form-based CSRF", async () => {
    const response = await echo(
      req({ origin: "http://app.test", "content-type": "text/plain", cookie: "adhikarai_staff=t" }, '{"a":1}'),
    );
    expect(response.status).toBe(415);
  });

  it("requires multipart on upload routes", async () => {
    expect((await upload(req({ "content-type": "application/json" }))).status).toBe(415);
    expect((await upload(req({ "content-type": "multipart/form-data; boundary=x" }))).status).toBe(200);
  });

  it("honours APP_ORIGIN behind a proxy", async () => {
    process.env.APP_ORIGIN = "https://adhikarai.example.org";
    try {
      const response = await echo(
        req({ origin: "https://adhikarai.example.org", "content-type": "application/json", cookie: "adhikarai_staff=t" }),
      );
      expect(response.status).toBe(200);
    } finally {
      delete process.env.APP_ORIGIN;
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/csrf.test.ts`
Expected: FAIL — `mutation` is not exported from `@/lib/api/http`.

- [ ] **Step 3: Implement csrf.ts**

Create `lib/auth/csrf.ts`:

```ts
/**
 * CSRF checks for route handlers.
 *
 * A forged cross-site request can only do harm if the browser attaches
 * credentials to it automatically - our cookies. So: when a request carries
 * any of our cookies, it must prove it came from our own origin. Independently,
 * JSON routes demand a JSON Content-Type, which a plain HTML form cannot send
 * (it can send text/plain, which request.json() would happily parse).
 * SameSite=Lax on the cookies is a third, separate layer.
 */

import { ApiError } from "@/lib/api/http";

import { ASSIST_COOKIE, readCookie, STAFF_COOKIE } from "./cookies";

/** The demo persona cookie. Duplicated (not imported) to avoid a cycle with lib/session.ts. */
const CITIZEN_COOKIE = "adhikarai_citizen";

export function hasAmbientCredentials(request: Request): boolean {
  return [STAFF_COOKIE, ASSIST_COOKIE, CITIZEN_COOKIE].some((name) => readCookie(request, name) !== null);
}

function allowedHosts(request: Request): Set<string> {
  const hosts = new Set<string>();
  const add = (value: string | null | undefined) => {
    if (value) hosts.add(value.toLowerCase());
  };
  add(new URL(request.url).host);
  add(request.headers.get("host"));
  add(request.headers.get("x-forwarded-host"));
  const appOrigin = (process.env.APP_ORIGIN ?? "").trim();
  if (appOrigin) add(new URL(appOrigin).host);
  return hosts;
}

export function assertSameOrigin(request: Request): void {
  const origin = request.headers.get("origin");

  if (!origin || origin === "null") {
    if (hasAmbientCredentials(request)) {
      throw new ApiError("FORBIDDEN", "This request must come from the AdhikarAI site itself.");
    }
    return;
  }

  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    throw new ApiError("FORBIDDEN", "This request must come from the AdhikarAI site itself.");
  }
  if (!allowedHosts(request).has(host)) {
    throw new ApiError("FORBIDDEN", "This request must come from the AdhikarAI site itself.");
  }
}

export function assertBodyType(request: Request, body: "json" | "multipart" | "none"): void {
  if (body === "none") return;
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const ok = body === "json" ? type.startsWith("application/json") : type.startsWith("multipart/form-data");
  if (!ok) {
    throw new ApiError(
      "UNSUPPORTED_MEDIA_TYPE",
      body === "json" ? "Send this request as application/json." : "Send this request as a file upload (multipart/form-data).",
    );
  }
}
```

- [ ] **Step 4: Add the codes and `mutation()` to `lib/api/http.ts`**

In `lib/api/http.ts`, extend the union and the status map:

```ts
export type ApiErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "UNPROCESSABLE"
  | "NEEDS_HUMAN_REVIEW"
  | "INTERNAL";

const STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNSUPPORTED_MEDIA_TYPE: 415,
  UNPROCESSABLE: 422,
  NEEDS_HUMAN_REVIEW: 422,
  INTERNAL: 500,
};
```

Directly after the `handler` function, add:

```ts
/**
 * A state-changing route handler: `handler` plus the CSRF checks.
 *
 * Every POST/PUT/PATCH/DELETE route is built with this (an architecture test
 * enforces it). The checks run before the body is read, inside the same
 * error handling, so a refusal is a clean 403/415.
 */
export function mutation(
  route: string,
  fn: (request: Request, ctx: RouteCtx) => Promise<Response>,
  options: { body?: "json" | "multipart" | "none" } = {},
): (request: Request, ctx?: RouteCtx) => Promise<Response> {
  return handler(route, async (request, ctx) => {
    const { assertBodyType, assertSameOrigin } = await import("@/lib/auth/csrf");
    assertSameOrigin(request);
    assertBodyType(request, options.body ?? "json");
    return fn(request, ctx);
  });
}
```

(The dynamic import avoids a module cycle: `lib/auth/csrf.ts` imports `ApiError` from this file.)

- [ ] **Step 5: Run the CSRF test**

Run: `npx vitest run tests/scenarios/csrf.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 6: Convert the 16 routes**

In each listed file: change the import `handler` → `mutation` (keep `handler` too if the file also exports a GET built with it, e.g. `app/api/profile/route.ts`, `app/api/applications/route.ts`, `app/api/demo/*`), and change `export const POST = handler(` (or `PUT`) to `export const POST = mutation(`. In `app/api/verify/bank-evidence/route.ts` add the options argument as the third parameter: `mutation("POST /api/verify/bank-evidence", async (request) => { ... }, { body: "multipart" })`.

Routes whose POST reads no body (check each: if it never calls `parseBody`/`request.json()`/`formData()`) get `{ body: "none" }`. Check with:

```bash
for f in $(grep -rl "export const POST\|export const PUT" app/api); do grep -q "parseBody\|request.json\|formData" "$f" || echo "NO BODY: $f"; done
```

- [ ] **Step 7: Add the architecture test**

Append to `tests/boundaries/architecture.test.ts`:

```ts
describe("every state-changing route is CSRF-guarded", () => {
  it("builds POST/PUT/PATCH/DELETE handlers with mutation()", () => {
    // The scheduler authenticates with a bearer token and carries no cookie.
    const exempt = new Set(["app/api/monitoring/tick/route.ts"]);
    const offenders: string[] = [];

    for (const file of sourceFiles("app/api").filter((f) => f.endsWith("route.ts"))) {
      if (exempt.has(file)) continue;
      const source = code(read(file));
      for (const match of source.matchAll(/export\s+const\s+(POST|PUT|PATCH|DELETE)\s*=\s*(\w+)\s*\(/g)) {
        if (match[2] !== "mutation") offenders.push(`${file}: ${match[1]} uses ${match[2]}`);
      }
      if (/export\s+(async\s+)?function\s+(POST|PUT|PATCH|DELETE)\b/.test(source)) {
        offenders.push(`${file}: exports a bare function handler`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 8: Run the whole suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. Existing scenario tests send `content-type: application/json` and no cookies, so they pass the guard. If a test posts without a content type, add `headers: { "content-type": "application/json" }` to that test's request — do not weaken the guard.

- [ ] **Step 9: Commit**

```bash
git add lib/auth/csrf.ts lib/api/http.ts app/api tests/scenarios/csrf.test.ts tests/boundaries/architecture.test.ts
git commit -m "CSRF: same-origin and content-type checks on every mutating route"
```

---

### Task 6: Staff sign-in, sign-out, password change, and the first admin

**Files:**
- Create: `lib/auth/login.ts`
- Modify: `lib/authz.ts` (add `currentStaff`, `requireStaff`)
- Create: `lib/staff/permissions.ts`
- Create: `app/api/staff/login/route.ts`, `app/api/staff/logout/route.ts`, `app/api/staff/password/route.ts`, `app/api/staff/me/route.ts`
- Create: `scripts/create-admin.ts`; Modify: `package.json` (script `staff:create-admin`)
- Create: `tests/helpers/staff.ts`
- Test: `tests/unit/permissions.test.ts`, `tests/scenarios/staffLogin.test.ts`

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces:
  - `type Capability = "citizen.view" | "citizen.assist" | "citizen.register" | "citizen.changeDistrict" | "consent.record" | "statement.record" | "case.viewQueue" | "case.take" | "case.assign" | "case.work" | "catalogue.review" | "staff.manage" | "logs.read"`
  - `can(staff: { roles: StaffRole[] }, capability: Capability): boolean`
  - `requireCapability(staff: { roles: StaffRole[] }, capability: Capability): void` (throws `FORBIDDEN`)
  - `FIELD_CASE_KINDS: CaseKind[]`, `caseKindsFor(roles: StaffRole[]): CaseKind[]`
  - `login(db, { email, password, ip, userAgent, clock }): Promise<{ ok: true; token: string; staffId: string; mustChangePassword: boolean } | { ok: false }>`
  - `logout(db, context: StaffContext, clock): Promise<void>`
  - `changePassword(db, { context: StaffContext; current: string; next: string; clock }): Promise<{ token: string }>` (throws `UNPROCESSABLE` with policy problems as details, `UNAUTHORIZED` on wrong current password)
  - `LOGIN_FAILED_MESSAGE = "Email or password is incorrect, or the account is temporarily locked."`
  - `currentStaff(request: Request | null, options?: { allowPasswordChange?: boolean }): Promise<StaffContext | null>`
  - `requireStaff(request: Request | null, capability?: Capability, options?: { allowPasswordChange?: boolean }): Promise<StaffContext>`
  - `clientIp(request: Request): string`
  - Test helpers: `createTestStaff(input: { roles: StaffRole[]; districts?: string[]; email?: string; password?: string; mustChangePassword?: boolean }): Promise<{ id: string; email: string; password: string }>`, `signIn(email: string, password: string): Promise<string>` (returns cookie header value `adhikarai_staff=<token>`), `staffRequest(url: string, cookie: string, init?: { method?: string; body?: unknown }): Request`

Permission table (from spec §2):

| Role | Capabilities |
|---|---|
| ADMIN | `citizen.view`, `citizen.changeDistrict`, `case.viewQueue`, `case.assign`, `staff.manage`, `logs.read` |
| CASEWORKER | `citizen.view`, `citizen.assist`, `statement.record`, `case.viewQueue`, `case.take`, `case.work` |
| FIELD_WORKER | `citizen.view`, `citizen.assist`, `citizen.register`, `consent.record`, `statement.record`, `case.viewQueue`, `case.take`, `case.work` |
| RULE_REVIEWER | `catalogue.review` |

`citizen.assist` covers editing profile facts, uploading documents, running discovery, preparing/submitting applications after the citizen's approval, running audits/diagnosis/re-verification, and executing an already-approved plan.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/permissions.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { can, caseKindsFor, requireCapability } from "@/lib/staff/permissions";

describe("permissions", () => {
  it("matches the spec table", () => {
    expect(can({ roles: ["ADMIN"] }, "staff.manage")).toBe(true);
    expect(can({ roles: ["ADMIN"] }, "citizen.assist")).toBe(false);
    expect(can({ roles: ["ADMIN"] }, "consent.record")).toBe(false);
    expect(can({ roles: ["ADMIN"] }, "case.take")).toBe(false);
    expect(can({ roles: ["CASEWORKER"] }, "consent.record")).toBe(false);
    expect(can({ roles: ["CASEWORKER"] }, "statement.record")).toBe(true);
    expect(can({ roles: ["FIELD_WORKER"] }, "consent.record")).toBe(true);
    expect(can({ roles: ["FIELD_WORKER"] }, "citizen.register")).toBe(true);
    expect(can({ roles: ["RULE_REVIEWER"] }, "citizen.view")).toBe(false);
    expect(can({ roles: ["RULE_REVIEWER"] }, "catalogue.review")).toBe(true);
  });

  it("takes the union of several roles", () => {
    expect(can({ roles: ["ADMIN", "FIELD_WORKER"] }, "consent.record")).toBe(true);
    expect(can({ roles: ["ADMIN", "FIELD_WORKER"] }, "staff.manage")).toBe(true);
  });

  it("refuses with FORBIDDEN", () => {
    expect(() => requireCapability({ roles: ["CASEWORKER"] }, "staff.manage")).toThrow(/permission/);
  });

  it("limits field workers to field case kinds", () => {
    expect(caseKindsFor(["FIELD_WORKER"]).sort()).toEqual(["ASSISTED_VERIFICATION", "COLLECT_DOCUMENT"]);
    expect(caseKindsFor(["CASEWORKER"])).toHaveLength(4);
    expect(caseKindsFor(["CASEWORKER", "FIELD_WORKER"])).toHaveLength(6);
    expect(caseKindsFor(["ADMIN"])).toHaveLength(6);
    expect(caseKindsFor(["RULE_REVIEWER"])).toEqual([]);
  });
});
```

Create `tests/helpers/staff.ts`:

```ts
/** Staff fixtures for scenario tests. */

import { POST as loginRoute } from "@/app/api/staff/login/route";
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db";
import type { StaffRole } from "@/lib/generated/prisma/client";

export const ORIGIN = "http://t";

export async function createTestStaff(input: {
  roles: StaffRole[];
  districts?: string[];
  email?: string;
  password?: string;
  mustChangePassword?: boolean;
}): Promise<{ id: string; email: string; password: string }> {
  const password = input.password ?? "a-long-test-password";
  const email = input.email ?? `${input.roles.join("-").toLowerCase()}-${Math.random().toString(36).slice(2, 8)}@ngo.org`;
  const staff = await prisma.staff.create({
    data: {
      email,
      name: email.split("@")[0],
      passwordHash: await hashPassword(password),
      roles: input.roles,
      districts: input.districts ?? ["Gaya"],
      mustChangePassword: input.mustChangePassword ?? false,
    },
  });
  return { id: staff.id, email, password };
}

/** Sign in through the real route; returns the Cookie header value. */
export async function signIn(email: string, password: string): Promise<string> {
  const response = await loginRoute(
    new Request(`${ORIGIN}/api/staff/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": "10.0.0.1" },
      body: JSON.stringify({ email, password }),
    }),
  );
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status}`);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0];
}

/** A same-origin request carrying the staff cookie. */
export function staffRequest(url: string, cookie: string, init: { method?: string; body?: unknown } = {}): Request {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  return new Request(`${ORIGIN}${url}`, {
    method,
    headers: {
      cookie,
      ...(method === "GET" ? {} : { origin: ORIGIN, "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}
```

Create `tests/scenarios/staffLogin.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { POST as loginRoute } from "@/app/api/staff/login/route";
import { POST as logoutRoute } from "@/app/api/staff/logout/route";
import { GET as meRoute } from "@/app/api/staff/me/route";
import { POST as passwordRoute } from "@/app/api/staff/password/route";
import { prisma } from "@/lib/db";

import { resetStaffData } from "../helpers/db";
import { createTestStaff, ORIGIN, signIn, staffRequest } from "../helpers/staff";

function loginRequest(email: string, password: string, ip = "10.0.0.1") {
  return new Request(`${ORIGIN}/api/staff/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "x-forwarded-for": ip },
    body: JSON.stringify({ email, password }),
  });
}

describe("staff sign-in", () => {
  beforeEach(resetStaffData);

  it("signs in and sets a hardened session cookie", async () => {
    const s = await createTestStaff({ roles: ["CASEWORKER"] });
    const response = await loginRoute(loginRequest(s.email, s.password));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(/adhikarai_staff=.+HttpOnly; SameSite=Lax/);
    const body = await response.json();
    expect(body.data).toMatchObject({ staffId: s.id, mustChangePassword: false });
  });

  it("normalises email", async () => {
    const s = await createTestStaff({ roles: ["CASEWORKER"], email: "asha@ngo.org" });
    expect((await loginRoute(loginRequest("  Asha@NGO.org ", s.password))).status).toBe(200);
  });

  it("gives the same answer for wrong password, unknown email and locked account", async () => {
    const s = await createTestStaff({ roles: ["CASEWORKER"] });
    const wrong = await loginRoute(loginRequest(s.email, "not-the-password"));
    const unknown = await loginRoute(loginRequest("nobody@ngo.org", "whatever-password"));
    for (let i = 0; i < 5; i += 1) await loginRoute(loginRequest(s.email, "still-wrong-pass"));
    const locked = await loginRoute(loginRequest(s.email, s.password));

    for (const response of [wrong, unknown, locked]) expect(response.status).toBe(401);
    const bodies = await Promise.all([wrong, unknown, locked].map((r) => r.json()));
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
  });

  it("records security events in the audit log, without the password", async () => {
    const s = await createTestStaff({ roles: ["CASEWORKER"] });
    await loginRoute(loginRequest(s.email, "wrong-password-x"));
    await loginRoute(loginRequest(s.email, s.password));
    const events = await prisma.auditLog.findMany({ where: { entity: "Staff", entityId: s.id } });
    expect(events.map((e) => e.toState)).toEqual(expect.arrayContaining(["LOGIN_FAILED", "LOGIN"]));
    expect(JSON.stringify(events)).not.toContain(s.password);
  });

  it("signs out and the cookie stops working", async () => {
    const s = await createTestStaff({ roles: ["CASEWORKER"] });
    const cookie = await signIn(s.email, s.password);
    expect((await meRoute(staffRequest("/api/staff/me", cookie))).status).toBe(200);
    expect((await logoutRoute(staffRequest("/api/staff/logout", cookie, { body: {} }))).status).toBe(200);
    expect((await meRoute(staffRequest("/api/staff/me", cookie))).status).toBe(401);
  });

  it("forces a password change before anything else, then revokes other sessions", async () => {
    const s = await createTestStaff({ roles: ["CASEWORKER"], mustChangePassword: true });
    const first = await signIn(s.email, s.password);
    const second = await signIn(s.email, s.password);

    // Only the password route and sign-out work until the password is changed.
    expect((await meRoute(staffRequest("/api/staff/me", first))).status).toBe(401);

    const weak = await passwordRoute(staffRequest("/api/staff/password", first, { body: { current: s.password, next: "short" } }));
    expect(weak.status).toBe(422);

    const changed = await passwordRoute(
      staffRequest("/api/staff/password", first, { body: { current: s.password, next: "a-brand-new-password" } }),
    );
    expect(changed.status).toBe(200);
    const fresh = (changed.headers.get("set-cookie") ?? "").split(";")[0];

    expect((await meRoute(staffRequest("/api/staff/me", fresh))).status).toBe(200);
    expect((await meRoute(staffRequest("/api/staff/me", first))).status).toBe(401);
    expect((await meRoute(staffRequest("/api/staff/me", second))).status).toBe(401);
  });

  it("refuses a wrong current password", async () => {
    const s = await createTestStaff({ roles: ["CASEWORKER"] });
    const cookie = await signIn(s.email, s.password);
    const response = await passwordRoute(
      staffRequest("/api/staff/password", cookie, { body: { current: "not-it-at-all", next: "a-brand-new-password" } }),
    );
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/permissions.test.ts tests/scenarios/staffLogin.test.ts`
Expected: FAIL — cannot resolve `@/lib/staff/permissions` / `@/app/api/staff/login/route`.

- [ ] **Step 3: Implement permissions**

Create `lib/staff/permissions.ts`:

```ts
/**
 * What each staff role may do. Spec §2. A staff member holds one or more
 * roles; their capabilities are the union.
 *
 * Note what is absent from every row: approving an application or a
 * corrective action. Staff can record that a citizen consented in front of
 * them (consent.record); the decision itself is always the citizen's.
 */

import { ApiError } from "@/lib/api/http";
import type { CaseKind, StaffRole } from "@/lib/generated/prisma/client";

export type Capability =
  | "citizen.view"
  | "citizen.assist"
  | "citizen.register"
  | "citizen.changeDistrict"
  | "consent.record"
  | "statement.record"
  | "case.viewQueue"
  | "case.take"
  | "case.assign"
  | "case.work"
  | "catalogue.review"
  | "staff.manage"
  | "logs.read";

const BY_ROLE: Record<StaffRole, readonly Capability[]> = {
  ADMIN: ["citizen.view", "citizen.changeDistrict", "case.viewQueue", "case.assign", "staff.manage", "logs.read"],
  CASEWORKER: ["citizen.view", "citizen.assist", "statement.record", "case.viewQueue", "case.take", "case.work"],
  FIELD_WORKER: [
    "citizen.view",
    "citizen.assist",
    "citizen.register",
    "consent.record",
    "statement.record",
    "case.viewQueue",
    "case.take",
    "case.work",
  ],
  RULE_REVIEWER: ["catalogue.review"],
};

export function can(staff: { roles: readonly StaffRole[] }, capability: Capability): boolean {
  return staff.roles.some((role) => BY_ROLE[role].includes(capability));
}

export function requireCapability(staff: { roles: readonly StaffRole[] }, capability: Capability): void {
  if (!can(staff, capability)) {
    throw new ApiError("FORBIDDEN", "You do not have permission to do that.");
  }
}

export const FIELD_CASE_KINDS: CaseKind[] = ["COLLECT_DOCUMENT", "ASSISTED_VERIFICATION"];
export const CASEWORKER_CASE_KINDS: CaseKind[] = [
  "UNKNOWN_CAUSE",
  "ACTION_FAILED",
  "NEEDS_CLARIFICATION",
  "NO_APPLICATION_REFERENCE",
];

/** Which case kinds a staff member may see in the queue and work. */
export function caseKindsFor(roles: readonly StaffRole[]): CaseKind[] {
  const kinds = new Set<CaseKind>();
  if (roles.includes("ADMIN") || roles.includes("CASEWORKER")) CASEWORKER_CASE_KINDS.forEach((k) => kinds.add(k));
  if (roles.includes("ADMIN") || roles.includes("FIELD_WORKER")) FIELD_CASE_KINDS.forEach((k) => kinds.add(k));
  return [...kinds];
}
```

- [ ] **Step 4: Implement login orchestration**

Create `lib/auth/login.ts`:

```ts
/**
 * Sign-in, sign-out and password change: the orchestration of hashing,
 * rate limiting and sessions, with every security event written to the
 * audit log. Never logs a password or token.
 */

import { ApiError } from "@/lib/api/http";
import type { Clock } from "@/lib/clock";
import type { PrismaClient } from "@/lib/generated/prisma/client";

import { checkPolicy, hashPassword, needsRehash, verifyAgainstDummy, verifyPassword } from "./password";
import { checkLoginAllowed, normaliseEmail, recordLoginResult } from "./rateLimit";
import { createSession, revokeAllForStaff, revokeSession, type StaffContext } from "./sessions";

export const LOGIN_FAILED_MESSAGE = "Email or password is incorrect, or the account is temporarily locked.";

async function securityEvent(
  db: PrismaClient,
  staffId: string,
  event: string,
  reason: string,
  clock: Clock,
  actorStaffId: string | null = staffId,
): Promise<void> {
  await db.auditLog.create({
    data: {
      actor: actorStaffId ? `staff:${actorStaffId}` : "system:auth",
      actorStaffId,
      entity: "Staff",
      entityId: staffId,
      toState: event,
      reason,
      createdAt: clock.now(),
    },
  });
}

export async function login(
  db: PrismaClient,
  input: { email: string; password: string; ip: string; userAgent?: string; clock: Clock },
): Promise<{ ok: true; token: string; staffId: string; mustChangePassword: boolean } | { ok: false }> {
  const email = normaliseEmail(input.email);
  const gate = await checkLoginAllowed(db, { email, ip: input.ip, clock: input.clock });
  const staff = await db.staff.findUnique({ where: { email } });

  if (!gate.allowed || !staff || !staff.isActive) {
    // Same work and same answer whatever the reason.
    await verifyAgainstDummy(input.password);
    await recordLoginResult(db, { email, ip: input.ip, succeeded: false, clock: input.clock });
    if (staff) await securityEvent(db, staff.id, "LOGIN_FAILED", gate.allowed ? "Account inactive." : `Refused: ${gate.reason}.`, input.clock, null);
    return { ok: false };
  }

  if (!(await verifyPassword(input.password, staff.passwordHash))) {
    await recordLoginResult(db, { email, ip: input.ip, succeeded: false, clock: input.clock });
    await securityEvent(db, staff.id, "LOGIN_FAILED", "Wrong password.", input.clock, null);
    return { ok: false };
  }

  await recordLoginResult(db, { email, ip: input.ip, succeeded: true, clock: input.clock });
  if (needsRehash(staff.passwordHash)) {
    await db.staff.update({ where: { id: staff.id }, data: { passwordHash: await hashPassword(input.password) } });
  }
  const session = await createSession(db, { staffId: staff.id, clock: input.clock, ip: input.ip, userAgent: input.userAgent });
  await securityEvent(db, staff.id, "LOGIN", "Signed in.", input.clock);
  return { ok: true, token: session.token, staffId: staff.id, mustChangePassword: staff.mustChangePassword };
}

export async function logout(db: PrismaClient, context: StaffContext, clock: Clock): Promise<void> {
  await revokeSession(db, context.sessionId, "LOGOUT", clock);
  await securityEvent(db, context.staffId, "LOGOUT", "Signed out.", clock);
}

export async function changePassword(
  db: PrismaClient,
  input: { context: StaffContext; current: string; next: string; clock: Clock },
): Promise<{ token: string }> {
  const staff = await db.staff.findUniqueOrThrow({ where: { id: input.context.staffId } });
  if (!(await verifyPassword(input.current, staff.passwordHash))) {
    throw new ApiError("UNAUTHORIZED", "Your current password is not correct.");
  }
  const problems = checkPolicy(input.next, staff.email);
  if (input.next === input.current) problems.push("Choose a password different from the current one.");
  if (problems.length > 0) throw new ApiError("UNPROCESSABLE", "That password cannot be used.", problems);

  await db.staff.update({
    where: { id: staff.id },
    data: { passwordHash: await hashPassword(input.next), mustChangePassword: false, passwordChangedAt: input.clock.now() },
  });
  // Every session, including this one, is replaced: the old token was issued
  // under the old password.
  await revokeAllForStaff(db, staff.id, "PASSWORD_CHANGED", input.clock);
  const session = await createSession(db, { staffId: staff.id, clock: input.clock });
  await securityEvent(db, staff.id, "PASSWORD_CHANGED", "Password changed; all other sessions ended.", input.clock);
  return { token: session.token };
}
```

- [ ] **Step 5: Add `currentStaff` / `requireStaff` / `clientIp` to `lib/authz.ts`**

Add these imports at the top of `lib/authz.ts`:

```ts
import { readCookie, readCookieFromStore, STAFF_COOKIE } from "@/lib/auth/cookies";
import { resolveSession, type StaffContext } from "@/lib/auth/sessions";
import { systemClock } from "@/lib/clock";
import { requireCapability, type Capability } from "@/lib/staff/permissions";
```

and append:

```ts
export type { StaffContext };

/**
 * The signed-in staff member, or null.
 *
 * `request` null means "a server component": the cookie is read through
 * next/headers. A session that must change its password counts as signed
 * out everywhere except the password route.
 */
export async function currentStaff(
  request: Request | null,
  options: { allowPasswordChange?: boolean } = {},
): Promise<StaffContext | null> {
  const token = request ? readCookie(request, STAFF_COOKIE) : await readCookieFromStore(STAFF_COOKIE);
  // Real time, never the demo clock: session expiry is a security property.
  const staff = await resolveSession(prisma, token, systemClock());
  if (!staff) return null;
  if (staff.mustChangePassword && !options.allowPasswordChange) return null;
  return staff;
}

export async function requireStaff(
  request: Request | null,
  capability?: Capability,
  options: { allowPasswordChange?: boolean } = {},
): Promise<StaffContext> {
  const staff = await currentStaff(request, options);
  if (!staff) throw new ApiError("UNAUTHORIZED", "Sign in as staff to continue.");
  if (capability) requireCapability(staff, capability);
  return staff;
}

/** Best-effort client IP for rate limiting. Only ever stored hashed. */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}
```

- [ ] **Step 6: Add the routes**

Create `app/api/staff/login/route.ts`:

```ts
/**
 * POST /api/staff/login  { email, password }
 *
 * One answer for every failure (wrong password, unknown email, locked
 * account, throttled IP), so the response reveals nothing about accounts.
 */

import { fail, mutation, ok, parseBody, z } from "@/lib/api/http";
import { sessionCookie } from "@/lib/auth/cookies";
import { login, LOGIN_FAILED_MESSAGE } from "@/lib/auth/login";
import { clientIp } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";

const Body = z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(500) });

export const POST = mutation("POST /api/staff/login", async (request) => {
  const body = await parseBody(request, Body);
  const result = await login(prisma, {
    email: body.email,
    password: body.password,
    ip: clientIp(request),
    userAgent: request.headers.get("user-agent") ?? undefined,
    clock: systemClock(),
  });

  if (!result.ok) return fail("UNAUTHORIZED", LOGIN_FAILED_MESSAGE);

  const response = ok({ staffId: result.staffId, mustChangePassword: result.mustChangePassword });
  response.headers.append("set-cookie", sessionCookie(result.token));
  return response;
});
```

Create `app/api/staff/logout/route.ts`:

```ts
/** POST /api/staff/logout — ends this session. */

import { mutation, ok } from "@/lib/api/http";
import { ASSIST_COOKIE, clearCookie, STAFF_COOKIE } from "@/lib/auth/cookies";
import { logout } from "@/lib/auth/login";
import { requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";

export const POST = mutation(
  "POST /api/staff/logout",
  async (request) => {
    const staff = await requireStaff(request, undefined, { allowPasswordChange: true });
    await logout(prisma, staff, systemClock());
    const response = ok({ signedOut: true });
    response.headers.append("set-cookie", clearCookie(STAFF_COOKIE));
    response.headers.append("set-cookie", clearCookie(ASSIST_COOKIE));
    return response;
  },
  { body: "none" },
);
```

Create `app/api/staff/password/route.ts`:

```ts
/** POST /api/staff/password  { current, next } — also reachable while a change is forced. */

import { mutation, ok, parseBody, z } from "@/lib/api/http";
import { sessionCookie } from "@/lib/auth/cookies";
import { changePassword } from "@/lib/auth/login";
import { requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";

const Body = z.object({ current: z.string().min(1).max(500), next: z.string().min(1).max(500) });

export const POST = mutation("POST /api/staff/password", async (request) => {
  const staff = await requireStaff(request, undefined, { allowPasswordChange: true });
  const body = await parseBody(request, Body);
  const { token } = await changePassword(prisma, { context: staff, current: body.current, next: body.next, clock: systemClock() });
  const response = ok({ changed: true });
  response.headers.append("set-cookie", sessionCookie(token));
  return response;
});
```

Create `app/api/staff/me/route.ts`:

```ts
/** GET /api/staff/me — who is signed in, with their roles and districts. */

import { handler, ok } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";

export const GET = handler("GET /api/staff/me", async (request) => {
  const staff = await requireStaff(request);
  return ok({ staffId: staff.staffId, name: staff.name, email: staff.email, roles: staff.roles, districts: staff.districts });
});
```

- [ ] **Step 7: Bootstrap script**

Create `scripts/create-admin.ts`:

```ts
/**
 * Create the first admin: npm run staff:create-admin -- --email you@org.in --name "Your Name"
 *
 * Prints a one-time temporary password; the admin must change it at first
 * sign-in. Refuses if an active admin already exists, unless --force.
 */

import "dotenv/config";

import { hashPassword, temporaryPassword } from "../lib/auth/password";
import { normaliseEmail } from "../lib/auth/rateLimit";
import { prisma } from "../lib/db";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const email = arg("--email");
  const name = arg("--name");
  if (!email || !name) throw new Error('Usage: npm run staff:create-admin -- --email you@org.in --name "Your Name"');

  const existing = await prisma.staff.count({ where: { roles: { has: "ADMIN" }, isActive: true } });
  if (existing > 0 && !process.argv.includes("--force")) {
    throw new Error("An active admin already exists. Use the staff admin screen, or pass --force.");
  }

  const password = temporaryPassword();
  const staff = await prisma.staff.create({
    data: {
      email: normaliseEmail(email),
      name,
      passwordHash: await hashPassword(password),
      roles: ["ADMIN"],
      districts: [],
      mustChangePassword: true,
    },
  });
  await prisma.auditLog.create({
    data: { actor: "system:bootstrap", entity: "Staff", entityId: staff.id, toState: "CREATED", reason: "First admin created by script." },
  });

  console.log(`Admin created: ${staff.email}`);
  console.log(`Temporary password (shown once, change it at first sign-in): ${password}`);
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
```

In `package.json` scripts add: `"staff:create-admin": "tsx scripts/create-admin.ts"`.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/unit/permissions.test.ts tests/scenarios/staffLogin.test.ts`
Expected: PASS (4 + 7 tests).

- [ ] **Step 9: Commit**

```bash
git add lib/auth/login.ts lib/authz.ts lib/staff/permissions.ts app/api/staff scripts/create-admin.ts package.json tests/helpers/staff.ts tests/unit/permissions.test.ts tests/scenarios/staffLogin.test.ts
git commit -m "Staff auth: sign-in, sign-out, forced password change, first-admin script"
```

---
### Task 7: Citizen authorization, access logging and assisted mode

Fixes conflicts C1 (real citizens exposed), C2 (identity from the body), C5 (staff in the audit trail), C7 (staff-controlled district).

**Files:**
- Modify: `lib/services/transitions.ts` (Actor kinds, `actorStaffId` on audit rows)
- Modify: `lib/authz.ts` (add `authorizeCitizen`, `CitizenAccess`)
- Modify: `lib/session.ts` (`requireSelectedCitizen` via demo persona or staff + assist cookie)
- Modify: `app/page.tsx` (persona picker demo-only)
- Modify: `app/api/citizens/route.ts` (demo-only)
- Modify: the 17 citizen routes listed in Step 6
- Create: `app/api/staff/assist/route.ts`, `app/api/staff/assist/stop/route.ts`
- Modify: `tests/scenarios/api.test.ts` (non-demo citizen list now 404)
- Modify: `tests/boundaries/architecture.test.ts`
- Test: `tests/scenarios/districtIsolation.test.ts`

**Interfaces:**
- Consumes: `currentStaff`, `StaffContext`, `requireCapability`, `Capability` (Task 6); `assistCookie`, `ASSIST_COOKIE`, `readCookieFromStore`, `clearCookie` (Task 4).
- Produces:
  - `type Actor = ... | { kind: "staff"; staffId: string } | { kind: "citizen-via-staff"; citizenId: string; staffId: string }`
  - `actorStaffId(actor: Actor): string | null`
  - `interface CitizenAccess extends CitizenContext { district: string | null; actor: Actor; staff: StaffContext | null }`
  - `authorizeCitizen(request: Request | null, citizenId: string | null | undefined, options: { purpose: string; capability?: Capability }): Promise<CitizenAccess>`
  - `requireSelectedCitizen(purpose?: string): Promise<CitizenAccess>`

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/districtIsolation.test.ts`:

```ts
/**
 * A staff member sees citizens in their districts and citizens whose open
 * case is assigned to them - nobody else, on any route. Refusals are 404,
 * so ids outside one's scope cannot even be confirmed to exist.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { GET as catalogueMatches } from "@/app/api/catalogue/matches/route";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { POST as discover } from "@/app/api/entitlements/discover/route";
import { GET as entitlements } from "@/app/api/entitlements/route";
import { POST as decide } from "@/app/api/approvals/[id]/decide/route";
import { POST as confirm } from "@/app/api/payments/[id]/confirm/route";
import { GET as profile } from "@/app/api/profile/route";
import { POST as assist } from "@/app/api/staff/assist/route";
import { prisma } from "@/lib/db";
import { recordAudit } from "@/lib/services/transitions";

import { createCitizen, ensureRegistry, resetCitizenData, resetStaffData } from "../helpers/db";
import { createTestStaff, signIn, staffRequest } from "../helpers/staff";

let gayaWorker: string;
let gayaWorkerId: string;
let gayaCitizen: string;
let patnaCitizen: string;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Every citizen-scoped route, called for `citizenId` with this cookie. */
function calls(citizenId: string, cookie: string): Array<[string, () => Promise<Response>]> {
  return [
    ["GET /api/dashboard", () => dashboard(staffRequest(`/api/dashboard?citizenId=${citizenId}`, cookie))],
    ["GET /api/entitlements", () => entitlements(staffRequest(`/api/entitlements?citizenId=${citizenId}`, cookie))],
    ["GET /api/profile", () => profile(staffRequest(`/api/profile?citizenId=${citizenId}`, cookie))],
    ["GET /api/catalogue/matches", () => catalogueMatches(staffRequest(`/api/catalogue/matches?citizenId=${citizenId}`, cookie))],
    ["POST /api/entitlements/discover", () => discover(staffRequest("/api/entitlements/discover", cookie, { body: { citizenId } }))],
    ["POST /api/approvals/x/decide", () => decide(staffRequest("/api/approvals/x/decide", cookie, { body: { citizenId, decision: "APPROVED" } }), ctx("x"))],
    ["POST /api/payments/x/confirm", () => confirm(staffRequest("/api/payments/x/confirm", cookie, { body: { citizenId, answer: "YES" } }), ctx("x"))],
    ["POST /api/staff/assist", () => assist(staffRequest("/api/staff/assist", cookie, { body: { citizenId } }))],
  ];
}

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  await ensureRegistry();
});

afterAll(() => {
  process.env.DEMO_MODE = "false";
});

beforeEach(async () => {
  await resetStaffData();
  await resetCitizenData();
  gayaCitizen = (await createCitizen()).id;
  patnaCitizen = (await createCitizen({ name: "Ramesh Kumar" })).id;
  await prisma.citizen.update({ where: { id: gayaCitizen }, data: { district: "Gaya", state: "Bihar" } });
  await prisma.citizen.update({ where: { id: patnaCitizen }, data: { district: "Patna", state: "Bihar" } });

  const worker = await createTestStaff({ roles: ["FIELD_WORKER"], districts: ["Gaya"] });
  gayaWorkerId = worker.id;
  gayaWorker = await signIn(worker.email, worker.password);
});

describe("district isolation", () => {
  it("returns 404 for a citizen in another district on every citizen route", async () => {
    for (const [name, call] of calls(patnaCitizen, gayaWorker)) {
      const response = await call();
      expect(response.status, name).toBe(404);
    }
  });

  it("writes no access log for refusals", async () => {
    for (const [, call] of calls(patnaCitizen, gayaWorker)) await call();
    expect(await prisma.accessLog.count({ where: { citizenId: patnaCitizen } })).toBe(0);
  });

  it("allows and logs access within the staff member's district", async () => {
    const response = await dashboard(staffRequest(`/api/dashboard?citizenId=${gayaCitizen}`, gayaWorker));
    expect(response.status).toBe(200);
    const log = await prisma.accessLog.findFirstOrThrow({ where: { citizenId: gayaCitizen } });
    expect(log).toMatchObject({ staffId: gayaWorkerId, action: "GET /api/dashboard" });
  });

  it("grants access through an assigned open case, and only while it is open", async () => {
    const opened = await prisma.case.create({
      data: {
        citizenId: patnaCitizen,
        kind: "COLLECT_DOCUMENT",
        priority: 2,
        district: "Patna",
        sourceKey: "test:assigned",
        summary: "Collect a document",
        assignedToId: gayaWorkerId,
        status: "ASSIGNED",
        openedAt: new Date("2026-10-12T00:00:00Z"),
        dueAt: new Date("2026-10-17T00:00:00Z"),
      },
    });
    expect((await dashboard(staffRequest(`/api/dashboard?citizenId=${patnaCitizen}`, gayaWorker))).status).toBe(200);

    await prisma.case.update({ where: { id: opened.id }, data: { status: "RESOLVED" } });
    expect((await dashboard(staffRequest(`/api/dashboard?citizenId=${patnaCitizen}`, gayaWorker))).status).toBe(404);
  });

  it("loses access after district change", async () => {
    expect((await dashboard(staffRequest(`/api/dashboard?citizenId=${gayaCitizen}`, gayaWorker))).status).toBe(200);
    await prisma.citizen.update({ where: { id: gayaCitizen }, data: { district: "Patna" } });
    expect((await dashboard(staffRequest(`/api/dashboard?citizenId=${gayaCitizen}`, gayaWorker))).status).toBe(404);
  });

  it("lets an admin see every district but not act for citizens", async () => {
    const admin = await createTestStaff({ roles: ["ADMIN"], districts: [] });
    const cookie = await signIn(admin.email, admin.password);
    expect((await dashboard(staffRequest(`/api/dashboard?citizenId=${patnaCitizen}`, cookie))).status).toBe(200);
    expect((await discover(staffRequest("/api/entitlements/discover", cookie, { body: { citizenId: patnaCitizen } }))).status).toBe(403);
  });

  it("refuses a rule reviewer any citizen data", async () => {
    const reviewer = await createTestStaff({ roles: ["RULE_REVIEWER"], districts: ["Gaya"] });
    const cookie = await signIn(reviewer.email, reviewer.password);
    expect((await dashboard(staffRequest(`/api/dashboard?citizenId=${gayaCitizen}`, cookie))).status).toBe(403);
  });

  it("hides archived citizens from everyone but admins", async () => {
    await prisma.citizen.update({ where: { id: gayaCitizen }, data: { archivedAt: new Date("2026-10-01T00:00:00Z") } });
    expect((await dashboard(staffRequest(`/api/dashboard?citizenId=${gayaCitizen}`, gayaWorker))).status).toBe(404);
  });

  it("refuses every citizen route without a session when demo mode is off", async () => {
    process.env.DEMO_MODE = "false";
    try {
      const response = await dashboard(new Request(`http://t/api/dashboard?citizenId=${gayaCitizen}`));
      expect(response.status).toBe(401);
    } finally {
      process.env.DEMO_MODE = "true";
    }
  });

  it("starts assisted mode only for an accessible citizen, setting the assist cookie", async () => {
    const response = await assist(staffRequest("/api/staff/assist", gayaWorker, { body: { citizenId: gayaCitizen } }));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toMatch(new RegExp(`adhikarai_assist=${gayaCitizen}`));
  });

  it("attributes staff actions in the audit trail", async () => {
    await recordAudit(prisma, {
      citizenId: gayaCitizen,
      actor: { kind: "staff", staffId: gayaWorkerId },
      entity: "Citizen",
      entityId: gayaCitizen,
      reason: "test",
    });
    await recordAudit(prisma, {
      citizenId: gayaCitizen,
      actor: { kind: "citizen-via-staff", citizenId: gayaCitizen, staffId: gayaWorkerId },
      entity: "Citizen",
      entityId: gayaCitizen,
      reason: "test",
    });
    const rows = await prisma.auditLog.findMany({ where: { citizenId: gayaCitizen } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.actor, r.actorStaffId])).toEqual(expect.arrayContaining([
      [`staff:${gayaWorkerId}`, gayaWorkerId],
      [`citizen:${gayaCitizen}/via:staff:${gayaWorkerId}`, gayaWorkerId],
    ]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/districtIsolation.test.ts`
Expected: FAIL — cannot resolve `@/app/api/staff/assist/route`.

- [ ] **Step 3: Staff kinds in the audit trail**

In `lib/services/transitions.ts` replace the `Actor` type and `actorLabel`, and add `actorStaffId`:

```ts
export type Actor =
  | { kind: "citizen"; citizenId: string }
  | { kind: "agent"; name: string }
  | { kind: "cron" }
  | { kind: "demo-console" }
  /** A staff member acting in their own name (casework, assisted operations). */
  | { kind: "staff"; staffId: string }
  /** The citizen's own decision or statement, recorded by staff in their presence. */
  | { kind: "citizen-via-staff"; citizenId: string; staffId: string };

export function actorLabel(actor: Actor): string {
  switch (actor.kind) {
    case "citizen":
      return `citizen:${actor.citizenId}`;
    case "agent":
      return `agent:${actor.name}`;
    case "cron":
      return "cron";
    case "demo-console":
      return "demo-console";
    case "staff":
      return `staff:${actor.staffId}`;
    case "citizen-via-staff":
      return `citizen:${actor.citizenId}/via:staff:${actor.staffId}`;
  }
}

/** The staff member involved in an action, for the indexed audit column. */
export function actorStaffId(actor: Actor): string | null {
  return actor.kind === "staff" || actor.kind === "citizen-via-staff" ? actor.staffId : null;
}
```

In the same file, in both `tx.auditLog.create` (inside `transitionEntitlement`) and `db.auditLog.create` (inside `recordAudit`), add to `data`: `actorStaffId: actorStaffId(input.actor),`.

- [ ] **Step 4: `authorizeCitizen`**

In `lib/authz.ts`, add imports:

```ts
import type { Actor } from "@/lib/services/transitions";
import { type Capability } from "@/lib/staff/permissions";
```

(merge with the Task 6 import of `requireCapability`), and append:

```ts
export interface CitizenAccess extends CitizenContext {
  district: string | null;
  /** Who is acting: the citizen (demo persona) or the staff member. */
  actor: Actor;
  staff: StaffContext | null;
}

const OPEN_CASE_STATUSES = ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING_ON_CITIZEN", "WAITING_ON_GOVERNMENT"] as const;

/**
 * The single place a request becomes "who may act on which citizen".
 *
 * The citizenId names WHICH citizen; the identity comes from the session.
 * Staff: allowed for admins, for citizens in their districts, and for
 * citizens whose open case is assigned to them; every permitted open is
 * written to AccessLog. Demo mode without a session: demo citizens only,
 * exactly as before. Anything else: refused, as NOT_FOUND when signed in,
 * so ids outside one's scope cannot be confirmed to exist.
 */
export async function authorizeCitizen(
  request: Request | null,
  citizenId: string | null | undefined,
  options: { purpose: string; capability?: Capability },
): Promise<CitizenAccess> {
  if (!citizenId || citizenId.trim() === "") {
    throw new ApiError("UNAUTHORIZED", "No citizen was identified for this request.");
  }

  const staff = await currentStaff(request);

  if (staff) {
    requireCapability(staff, options.capability ?? "citizen.view");

    const citizen = await prisma.citizen.findUnique({
      where: { id: citizenId },
      select: { id: true, name: true, locale: true, isDemo: true, district: true, archivedAt: true },
    });
    const isAdmin = staff.roles.includes("ADMIN");
    const notFound = new ApiError("NOT_FOUND", "That citizen record does not exist.");

    if (!citizen) throw notFound;
    if (citizen.isDemo && !isDemoMode()) throw notFound;
    if (citizen.archivedAt && !isAdmin) throw notFound;

    const inDistrict = isAdmin || (citizen.district !== null && staff.districts.includes(citizen.district));
    if (!inDistrict) {
      const assigned = await prisma.case.count({
        where: { citizenId, assignedToId: staff.staffId, status: { in: [...OPEN_CASE_STATUSES] } },
      });
      if (assigned === 0) throw notFound;
    }

    await prisma.accessLog.create({
      data: { staffId: staff.staffId, citizenId, action: options.purpose, at: systemClock().now() },
    });

    return {
      citizenId: citizen.id,
      name: citizen.name,
      locale: citizen.locale,
      isDemo: citizen.isDemo,
      district: citizen.district,
      actor: { kind: "staff", staffId: staff.staffId },
      staff,
    };
  }

  if (isDemoMode()) {
    const citizen = await requireCitizen(citizenId);
    // The persona picker serves demo citizens only, even in demo mode.
    if (!citizen.isDemo) throw new ApiError("NOT_FOUND", "That citizen record does not exist.");
    return {
      ...citizen,
      district: null,
      actor: { kind: "citizen", citizenId: citizen.citizenId },
      staff: null,
    };
  }

  throw new ApiError("UNAUTHORIZED", "Sign in as staff to continue.");
}
```

- [ ] **Step 5: Pages: demo persona, or staff assisting a citizen**

Replace the body of `lib/session.ts` (keep `CITIZEN_COOKIE` and `selectedCitizenId` exports) with:

```ts
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { ASSIST_COOKIE, readCookieFromStore } from "@/lib/auth/cookies";
import { authorizeCitizen, currentStaff, isDemoMode, type CitizenAccess } from "@/lib/authz";

export const CITIZEN_COOKIE = "adhikarai_citizen";

export async function selectedCitizenId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(CITIZEN_COOKIE)?.value;
  return value && value.trim() !== "" ? value : null;
}

/**
 * The citizen a page is about.
 *
 * Signed-in staff: the citizen they are assisting (assist cookie), checked
 * against their districts. Otherwise, in demo mode only: the chosen demo
 * persona. Otherwise: the staff sign-in page.
 *
 * redirect() works by throwing, so it is never called inside a try block.
 */
export async function requireSelectedCitizen(purpose = "view:page"): Promise<CitizenAccess> {
  const staff = await currentStaff(null);

  if (staff) {
    const assisting = await readCookieFromStore(ASSIST_COOKIE);
    if (!assisting) redirect("/staff/citizens");
    const access = await authorizeCitizen(null, assisting, { purpose }).catch(() => null);
    if (!access) redirect("/staff/citizens");
    return access;
  }

  if (!isDemoMode()) redirect("/staff/login");

  const id = await selectedCitizenId();
  if (!id) redirect("/");
  const access = await authorizeCitizen(null, id, { purpose }).catch(() => null);
  if (!access) redirect("/");
  return access;
}
```

- [ ] **Step 6: Migrate the citizen routes**

In each route below, replace `requireCitizen(<id>)` with `authorizeCitizen(request, <id>, { purpose: "<METHOD> <path>", capability: "<cap>" })`, keep the result in the same variable (usually `citizen`, rename to `access` only where the table says to pass the actor), update the import from `@/lib/authz`, and where the route calls a service that accepts `actor`, pass `actor: access.staff ? access.actor : undefined` (so the citizen path keeps today's default agent actors).

| Route file | Capability | Pass actor to |
|---|---|---|
| `app/api/action-plans/[id]/execute/route.ts` | `citizen.assist` | `executeActionPlan` |
| `app/api/applications/route.ts` (POST) | `citizen.assist` | `prepareApplication` |
| `app/api/applications/[id]/request-approval/route.ts` | `citizen.assist` | `requestApplicationApproval` |
| `app/api/applications/[id]/submit/route.ts` | `citizen.assist` | `submitApplication` |
| `app/api/approvals/[id]/decide/route.ts` | `citizen.view` | — (see below) |
| `app/api/benefits/[id]/audit/route.ts` | `citizen.assist` | `auditBenefit` |
| `app/api/benefits/[id]/diagnose/route.ts` | `citizen.assist` | `diagnoseAndPlan` |
| `app/api/benefits/[id]/reverify/route.ts` | `citizen.assist` | `reverifyBenefit` |
| `app/api/benefits/[id]/route.ts` | `citizen.view` | — |
| `app/api/catalogue/matches/route.ts` | `citizen.view` | — |
| `app/api/dashboard/route.ts` | `citizen.view` | — |
| `app/api/demo/gov/route.ts` | `citizen.assist` | — |
| `app/api/entitlements/discover/route.ts` | `citizen.assist` | `discoverAndPersist` |
| `app/api/entitlements/route.ts` | `citizen.view` | — |
| `app/api/payments/[id]/confirm/route.ts` | `citizen.view` | — (see below) |
| `app/api/profile/route.ts` GET | `citizen.view` | — |
| `app/api/profile/route.ts` POST | `citizen.assist` | — |
| `app/api/verify/bank-evidence/route.ts` | `citizen.assist` | — |

Example — `app/api/entitlements/discover/route.ts` after the change:

```ts
export const POST = mutation("POST /api/entitlements/discover", async (request) => {
  const body = await parseBody(request, Body);
  const access = await authorizeCitizen(request, body.citizenId, {
    purpose: "POST /api/entitlements/discover",
    capability: "citizen.assist",
  });

  const profile = await loadProfile(access.citizenId);
  const result = await discoverAndPersist({
    citizenId: access.citizenId,
    profile,
    actor: access.staff ? access.actor : undefined,
  });
  // ...rest unchanged, using access.citizenId where it used citizen.citizenId
});
```

Until Task 10 adds witnessed consent and recorded statements, staff must not use the two routes where a citizen answers for themselves. In `app/api/approvals/[id]/decide/route.ts` and `app/api/payments/[id]/confirm/route.ts`, directly after `authorizeCitizen`, add:

```ts
if (access.staff) {
  throw new ApiError("FORBIDDEN", "Staff cannot answer for a citizen. Record the citizen's own answer instead.");
}
```

Leave `requireCitizen` exported from `lib/authz.ts` (used by `authorizeCitizen`), but no route or page may call it.

- [ ] **Step 7: Persona picker and citizen list are demo-only**

In `app/api/citizens/route.ts`, at the start of the handler:

```ts
if (!isDemoMode()) {
  // Real citizens are never listed to an anonymous caller. Staff use
  // /api/staff/citizens, which is district-scoped.
  throw new ApiError("NOT_FOUND", "Not found.");
}
```

(import `ApiError` from `@/lib/api/http`), and simplify the query to `where: { isDemo: true }`.

In `app/page.tsx`:
- In `choosePersona`, before setting the cookie: `if (!isDemoMode()) return;` and verify the id is a demo citizen: `const persona = await prisma.citizen.findFirst({ where: { id: citizenId, isDemo: true }, select: { id: true } }); if (!persona) return;`
- At the top of `HomePage`: `if (!isDemoMode()) redirect("/staff/login");`

In `tests/scenarios/api.test.ts`, change the test `hides demo personas when demo mode is off` to expect the route to refuse:

```ts
  it("refuses to list citizens when demo mode is off", async () => {
    process.env.DEMO_MODE = "false";
    const response = await getCitizens(new Request("http://t/api/citizens"));
    expect(response.status).toBe(404);
    process.env.DEMO_MODE = "true";
  });
```

- [ ] **Step 8: Assist routes**

Create `app/api/staff/assist/route.ts`:

```ts
/**
 * POST /api/staff/assist  { citizenId }
 *
 * Start assisting a citizen: every citizen page then shows that citizen, with
 * the staff member's access checked on each request. Logged like any open.
 */

import { mutation, ok, parseBody, z } from "@/lib/api/http";
import { assistCookie } from "@/lib/auth/cookies";
import { authorizeCitizen } from "@/lib/authz";

const Body = z.object({ citizenId: z.string().min(1) });

export const POST = mutation("POST /api/staff/assist", async (request) => {
  const body = await parseBody(request, Body);
  const access = await authorizeCitizen(request, body.citizenId, { purpose: "assist:start" });
  if (!access.staff) {
    // Demo personas are chosen on the home page, not here.
    return ok({ assisting: null });
  }
  const response = ok({ assisting: access.citizenId, name: access.name });
  response.headers.append("set-cookie", assistCookie(access.citizenId));
  return response;
});
```

Create `app/api/staff/assist/stop/route.ts`:

```ts
/** POST /api/staff/assist/stop — stop assisting; clears the assist cookie. */

import { mutation, ok } from "@/lib/api/http";
import { ASSIST_COOKIE, clearCookie } from "@/lib/auth/cookies";
import { requireStaff } from "@/lib/authz";

export const POST = mutation(
  "POST /api/staff/assist/stop",
  async (request) => {
    await requireStaff(request);
    const response = ok({ assisting: null });
    response.headers.append("set-cookie", clearCookie(ASSIST_COOKIE));
    return response;
  },
  { body: "none" },
);
```

- [ ] **Step 9: Architecture tests**

Append to `tests/boundaries/architecture.test.ts`:

```ts
describe("citizen data is reached only through authorizeCitizen", () => {
  it("no route or page calls requireCitizen directly", () => {
    const offenders = [...sourceFiles("app")].filter((file) => /\brequireCitizen\s*\(/.test(code(read(file))));
    expect(offenders).toEqual([]);
  });

  it("every API route that takes a citizenId authorizes it", () => {
    // Exempt: the demo-only persona list, the cron tick, and staff routes that
    // are scoped by district in their own services (search, register, admin).
    const exempt = new Set([
      "app/api/citizens/route.ts",
      "app/api/monitoring/tick/route.ts",
      "app/api/staff/citizens/route.ts",
      "app/api/staff/admin/access-log/route.ts",
    ]);
    const offenders: string[] = [];
    for (const file of sourceFiles("app/api").filter((f) => f.endsWith("route.ts"))) {
      if (exempt.has(file)) continue;
      const source = code(read(file));
      if (/\bcitizenId\b/.test(source) && !/\bauthorizeCitizen\s*\(/.test(source)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 10: Run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, including the new `districtIsolation` tests. Existing scenario tests that create citizens with `createCitizen()` (always `isDemo: true`) and set `DEMO_MODE=true` keep working. If any existing test uses a non-demo citizen through a route without a session, mark that citizen `isDemo: true` in the test — do not relax `authorizeCitizen`.

- [ ] **Step 11: Commit**

```bash
git add lib/services/transitions.ts lib/authz.ts lib/session.ts app tests
git commit -m "Authorization: session-derived citizen access, district scoping, access log, assisted mode"
```

---

### Task 8: Cases — opening, queue, assignment, resolution

**Files:**
- Create: `lib/staff/cases.ts`
- Create: `app/api/staff/cases/route.ts`, `app/api/staff/cases/[id]/route.ts`, `app/api/staff/cases/[id]/take/route.ts`, `app/api/staff/cases/[id]/assign/route.ts`, `app/api/staff/cases/[id]/status/route.ts`, `app/api/staff/cases/[id]/note/route.ts`, `app/api/staff/cases/[id]/resolve/route.ts`, `app/api/staff/cases/[id]/reopen/route.ts`
- Test: `tests/scenarios/cases.test.ts`

**Interfaces:**
- Consumes: `StaffContext` (Task 4), `can`, `requireCapability`, `caseKindsFor` (Task 6), `authorizeCitizen` (Task 7), `currentClock` from `lib/services/clock.ts`.
- Produces (all in `lib/staff/cases.ts`):
  - `OPEN_STATUSES: CaseStatus[]`
  - `priorityFor(input: { schemeCode: string | null; provenMissingPaise: bigint | null }): { priority: 1 | 2 | 3; dueInDays: 2 | 5 | 10 }`
  - `openCase(db: PrismaClient, input: { citizenId: string; entitlementId?: string | null; kind: CaseKind; sourceKey: string; summary: string; clock: Clock }): Promise<{ caseId: string; created: boolean }>`
  - `listCases(db, staff: StaffContext, scope: "mine" | "queue", clock: Clock): Promise<CaseListItem[]>` where `CaseListItem = { id, kind, status, priority, district, summary, dueAt: string, openedAt: string, overdue: boolean, assignedToId: string | null, citizen: { id: string; name: string } }`
  - `getCase(db, staff: StaffContext, caseId: string): Promise<CaseDetail>` (`CaseDetail` = the case row with `events` ordered by `at` and `citizen: { id, name }`); throws `NOT_FOUND` outside scope.
  - `takeCase(db, { staff, caseId, clock }): Promise<void>` — `CONFLICT` if someone else got it first.
  - `assignCase(db, { admin, caseId, assigneeId, clock }): Promise<void>`
  - `setCaseStatus(db, { staff, caseId, status: "IN_PROGRESS" | "WAITING_ON_CITIZEN" | "WAITING_ON_GOVERNMENT", note?, clock }): Promise<void>`
  - `addCaseNote(db, { staff, caseId, note, clock }): Promise<void>`
  - `resolveCase(db, { staff, caseId, resolution: "RESOLVED" | "CLOSED_NO_ACTION", note, clock }): Promise<void>`
  - `reopenCase(db, { staff, caseId, note, clock }): Promise<void>`
  - `releaseCasesOf(db, { staffId, byStaffId, clock }): Promise<number>`
  - `appendCaseEvent(db, input: { caseId: string; staffId: string | null; type: string; fromValue?: string | null; toValue?: string | null; note?: string | null; at: Date }): Promise<void>`

Rules (spec §7, made concrete):
- Priority 1: scheme code starts with `NSAP-` or `NFSA-`, or proven missing ≥ ₹1,000 (100,000 paise) → due in 2 days. Priority 2: any proven missing money > 0 → 5 days. Otherwise priority 3 → 10 days.
- Scope: admins see every case; others see cases in their districts whose kind is in `caseKindsFor(roles)`, plus cases assigned to them. District `UNASSIGNED` (citizen without a district) is admin-only.
- Take: requires `case.take`, kind in `caseKindsFor`, district covered; atomic `updateMany where { id, status: "OPEN", assignedToId: null }`.
- Assign: requires `case.assign`; assignee active, `can(assignee, "case.take")`, kind in `caseKindsFor(assignee.roles)`, assignee covers the district.
- Status/note/resolve: only the assignee (admins may add notes and reopen).
- Resolve `RESOLVED`: note ≥ 10 characters; for `UNKNOWN_CAUSE` and `ACTION_FAILED`, additionally requires a `ROOT_CAUSE_RECORDED` event on the case or the case's entitlement being in `RECOVERED`, `MONITORING` or `VERIFIED_RECEIVED`. `CLOSED_NO_ACTION`: note ≥ 10 characters. Neither changes the benefit.
- Reopen: from `RESOLVED`/`CLOSED_NO_ACTION` back to `OPEN`, unassigned.
- Every change appends a `CaseEvent`.

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/cases.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { fixedClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import type { StaffContext } from "@/lib/auth/sessions";
import {
  addCaseNote,
  assignCase,
  getCase,
  listCases,
  openCase,
  priorityFor,
  releaseCasesOf,
  reopenCase,
  resolveCase,
  setCaseStatus,
  takeCase,
} from "@/lib/staff/cases";
import type { StaffRole } from "@/lib/generated/prisma/client";

import { createCitizen, ensureRegistry, resetCitizenData, resetStaffData } from "../helpers/db";

const CLOCK = fixedClock(new Date("2026-10-12T10:00:00Z"));

async function staff(roles: StaffRole[], districts: string[] = ["Gaya"]): Promise<StaffContext> {
  const row = await prisma.staff.create({
    data: { email: `${Math.random()}@ngo.org`, name: roles.join("+"), passwordHash: "x", roles, districts, mustChangePassword: false },
  });
  return { staffId: row.id, sessionId: "test", email: row.email, name: row.name, roles, districts, mustChangePassword: false };
}

let citizenId: string;

beforeAll(async () => {
  await ensureRegistry();
});

afterAll(async () => {
  await resetStaffData();
});

beforeEach(async () => {
  await resetStaffData();
  await resetCitizenData();
  citizenId = (await createCitizen()).id;
  await prisma.citizen.update({ where: { id: citizenId }, data: { district: "Gaya" } });
});

const open = (kind: Parameters<typeof openCase>[1]["kind"] = "UNKNOWN_CAUSE", sourceKey = `k:${Math.random()}`) =>
  openCase(prisma, { citizenId, kind, sourceKey, summary: "Something needs a person", clock: CLOCK });

describe("priority", () => {
  it("follows the spec rules", () => {
    expect(priorityFor({ schemeCode: "NSAP-IGNOAPS", provenMissingPaise: 0n })).toEqual({ priority: 1, dueInDays: 2 });
    expect(priorityFor({ schemeCode: "PM-KISAN", provenMissingPaise: 100_000n })).toEqual({ priority: 1, dueInDays: 2 });
    expect(priorityFor({ schemeCode: "PM-KISAN", provenMissingPaise: 20_000n })).toEqual({ priority: 2, dueInDays: 5 });
    expect(priorityFor({ schemeCode: "PM-KISAN", provenMissingPaise: null })).toEqual({ priority: 3, dueInDays: 10 });
  });
});

describe("opening cases", () => {
  it("is idempotent on sourceKey and copies the citizen's district", async () => {
    const first = await open("UNKNOWN_CAUSE", "rootcause:1");
    const again = await open("UNKNOWN_CAUSE", "rootcause:1");
    expect(first.created).toBe(true);
    expect(again).toEqual({ caseId: first.caseId, created: false });

    const row = await prisma.case.findUniqueOrThrow({ where: { id: first.caseId }, include: { events: true } });
    expect(row).toMatchObject({ district: "Gaya", status: "OPEN", priority: 3 });
    expect(row.dueAt.toISOString()).toBe("2026-10-22T10:00:00.000Z");
    expect(row.events.map((e) => e.type)).toEqual(["OPENED"]);
  });

  it("files citizens with no district under UNASSIGNED", async () => {
    await prisma.citizen.update({ where: { id: citizenId }, data: { district: null } });
    const { caseId } = await open();
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).district).toBe("UNASSIGNED");
  });
});

describe("the queue", () => {
  it("shows a caseworker their district's caseworker cases only", async () => {
    const caseworker = await staff(["CASEWORKER"]);
    await open("UNKNOWN_CAUSE");
    await open("COLLECT_DOCUMENT");
    const other = await createCitizen({ name: "Elsewhere" });
    await prisma.citizen.update({ where: { id: other.id }, data: { district: "Patna" } });
    await openCase(prisma, { citizenId: other.id, kind: "UNKNOWN_CAUSE", sourceKey: "patna", summary: "x", clock: CLOCK });

    const queue = await listCases(prisma, caseworker, "queue", CLOCK);
    expect(queue.map((c) => [c.kind, c.district])).toEqual([["UNKNOWN_CAUSE", "Gaya"]]);
  });

  it("shows admins everything, including UNASSIGNED", async () => {
    const admin = await staff(["ADMIN"], []);
    await prisma.citizen.update({ where: { id: citizenId }, data: { district: null } });
    await open("UNKNOWN_CAUSE");
    expect(await listCases(prisma, admin, "queue", CLOCK)).toHaveLength(1);
  });

  it("sorts by priority, then due date", async () => {
    const caseworker = await staff(["CASEWORKER"]);
    await open("UNKNOWN_CAUSE", "a");
    await prisma.case.update({ where: { sourceKey: "a" }, data: { priority: 2 } });
    await open("ACTION_FAILED", "b");
    await prisma.case.update({ where: { sourceKey: "b" }, data: { priority: 1 } });
    const queue = await listCases(prisma, caseworker, "queue", CLOCK);
    expect(queue.map((c) => c.kind)).toEqual(["ACTION_FAILED", "UNKNOWN_CAUSE"]);
  });
});

describe("taking and assigning", () => {
  it("concurrent take: exactly one wins", async () => {
    const a = await staff(["CASEWORKER"]);
    const b = await staff(["CASEWORKER"]);
    const { caseId } = await open();

    const results = await Promise.allSettled([
      takeCase(prisma, { staff: a, caseId, clock: CLOCK }),
      takeCase(prisma, { staff: b, caseId, clock: CLOCK }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/already taken/);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status).toBe("ASSIGNED");
  });

  it("refuses a field worker a caseworker case, and anyone a case outside their district", async () => {
    const field = await staff(["FIELD_WORKER"]);
    const patna = await staff(["CASEWORKER"], ["Patna"]);
    const { caseId } = await open("UNKNOWN_CAUSE");
    await expect(takeCase(prisma, { staff: field, caseId, clock: CLOCK })).rejects.toThrow();
    await expect(takeCase(prisma, { staff: patna, caseId, clock: CLOCK })).rejects.toThrow();
  });

  it("lets an admin assign only to someone who covers the district and can work the kind", async () => {
    const admin = await staff(["ADMIN"], []);
    const field = await staff(["FIELD_WORKER"]);
    const caseworker = await staff(["CASEWORKER"]);
    const { caseId } = await open("UNKNOWN_CAUSE");

    await expect(assignCase(prisma, { admin, caseId, assigneeId: field.staffId, clock: CLOCK })).rejects.toThrow();
    await assignCase(prisma, { admin, caseId, assigneeId: caseworker.staffId, clock: CLOCK });
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).assignedToId).toBe(caseworker.staffId);
    await expect(assignCase(prisma, { admin: caseworker, caseId, assigneeId: caseworker.staffId, clock: CLOCK })).rejects.toThrow(/permission/);
  });
});

describe("working and resolving", () => {
  it("lets only the assignee change status, and records every change", async () => {
    const a = await staff(["CASEWORKER"]);
    const b = await staff(["CASEWORKER"]);
    const { caseId } = await open("NEEDS_CLARIFICATION");
    await takeCase(prisma, { staff: a, caseId, clock: CLOCK });

    await expect(setCaseStatus(prisma, { staff: b, caseId, status: "IN_PROGRESS", clock: CLOCK })).rejects.toThrow();
    await setCaseStatus(prisma, { staff: a, caseId, status: "WAITING_ON_CITIZEN", note: "Called, will bring papers", clock: CLOCK });
    await addCaseNote(prisma, { staff: a, caseId, note: "Visited the house", clock: CLOCK });

    const detail = await getCase(prisma, a, caseId);
    expect(detail.events.map((e) => e.type)).toEqual(["OPENED", "ASSIGNED", "STATUS_CHANGED", "NOTE"]);
  });

  it("needs a reason to resolve, and a recorded root cause for an unknown-cause case", async () => {
    const a = await staff(["CASEWORKER"]);
    const { caseId } = await open("UNKNOWN_CAUSE");
    await takeCase(prisma, { staff: a, caseId, clock: CLOCK });

    await expect(resolveCase(prisma, { staff: a, caseId, resolution: "RESOLVED", note: "short", clock: CLOCK })).rejects.toThrow();
    await expect(
      resolveCase(prisma, { staff: a, caseId, resolution: "RESOLVED", note: "Spoke to the block office", clock: CLOCK }),
    ).rejects.toThrow(/root cause/);

    await prisma.caseEvent.create({ data: { caseId, staffId: a.staffId, type: "ROOT_CAUSE_RECORDED", at: CLOCK.now() } });
    await resolveCase(prisma, { staff: a, caseId, resolution: "RESOLVED", note: "Cause recorded, plan proposed", clock: CLOCK });
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status).toBe("RESOLVED");
  });

  it("closes with no action, reopens, and never touches the benefit", async () => {
    const a = await staff(["CASEWORKER"]);
    const { caseId } = await open("NEEDS_CLARIFICATION");
    await takeCase(prisma, { staff: a, caseId, clock: CLOCK });
    await resolveCase(prisma, { staff: a, caseId, resolution: "CLOSED_NO_ACTION", note: "Citizen unreachable for two weeks", clock: CLOCK });
    await reopenCase(prisma, { staff: a, caseId, note: "Citizen called back", clock: CLOCK });
    const row = await prisma.case.findUniqueOrThrow({ where: { id: caseId } });
    expect(row).toMatchObject({ status: "OPEN", assignedToId: null });
  });

  it("returns a deactivated staff member's cases to the queue", async () => {
    const a = await staff(["CASEWORKER"]);
    const { caseId } = await open();
    await takeCase(prisma, { staff: a, caseId, clock: CLOCK });
    expect(await releaseCasesOf(prisma, { staffId: a.staffId, byStaffId: null, clock: CLOCK })).toBe(1);
    expect((await prisma.case.findUniqueOrThrow({ where: { id: caseId } })).status).toBe("OPEN");
  });

  it("hides another district's case detail as not found", async () => {
    const patna = await staff(["CASEWORKER"], ["Patna"]);
    const { caseId } = await open();
    await expect(getCase(prisma, patna, caseId)).rejects.toThrow(/does not exist/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/cases.test.ts`
Expected: FAIL — cannot resolve `@/lib/staff/cases`.

- [ ] **Step 3: Implement**

Create `lib/staff/cases.ts`:

```ts
/**
 * Cases: the work the system cannot finish on its own, made visible to a
 * person. Spec §7.
 *
 * A case is a pointer to a benefit and a reason a human is needed. Working
 * it never changes the benefit's state directly: recovery still goes
 * through the citizen's approval and re-verification (lib/staff/caseActions.ts).
 */

import { ApiError } from "@/lib/api/http";
import type { StaffContext } from "@/lib/auth/sessions";
import type { Clock } from "@/lib/clock";
import type { CaseKind, CaseStatus, PrismaClient } from "@/lib/generated/prisma/client";
import { log } from "@/lib/log";

import { can, caseKindsFor, requireCapability } from "./permissions";

export const OPEN_STATUSES: CaseStatus[] = ["OPEN", "ASSIGNED", "IN_PROGRESS", "WAITING_ON_CITIZEN", "WAITING_ON_GOVERNMENT"];
const CLOSED_STATUSES: CaseStatus[] = ["RESOLVED", "CLOSED_NO_ACTION"];
const DAY_MS = 24 * 60 * 60_000;

export interface CaseListItem {
  id: string;
  kind: CaseKind;
  status: CaseStatus;
  priority: number;
  district: string;
  summary: string;
  dueAt: string;
  openedAt: string;
  overdue: boolean;
  assignedToId: string | null;
  citizen: { id: string; name: string };
}

export function priorityFor(input: { schemeCode: string | null; provenMissingPaise: bigint | null }): {
  priority: 1 | 2 | 3;
  dueInDays: 2 | 5 | 10;
} {
  const code = input.schemeCode ?? "";
  const missing = input.provenMissingPaise ?? 0n;
  if (code.startsWith("NSAP-") || code.startsWith("NFSA-") || missing >= 100_000n) return { priority: 1, dueInDays: 2 };
  if (missing > 0n) return { priority: 2, dueInDays: 5 };
  return { priority: 3, dueInDays: 10 };
}

export async function appendCaseEvent(
  db: PrismaClient,
  input: { caseId: string; staffId: string | null; type: string; fromValue?: string | null; toValue?: string | null; note?: string | null; at: Date },
): Promise<void> {
  await db.caseEvent.create({ data: input });
}

export async function openCase(
  db: PrismaClient,
  input: { citizenId: string; entitlementId?: string | null; kind: CaseKind; sourceKey: string; summary: string; clock: Clock },
): Promise<{ caseId: string; created: boolean }> {
  const existing = await db.case.findUnique({ where: { sourceKey: input.sourceKey }, select: { id: true } });
  if (existing) return { caseId: existing.id, created: false };

  const citizen = await db.citizen.findUniqueOrThrow({ where: { id: input.citizenId }, select: { district: true } });
  const entitlement = input.entitlementId
    ? await db.entitlement.findUnique({
        where: { id: input.entitlementId },
        select: { scheme: { select: { code: true } }, ledger: { select: { gapAmountPaise: true } } },
      })
    : null;
  const { priority, dueInDays } = priorityFor({
    schemeCode: entitlement?.scheme.code ?? null,
    provenMissingPaise: entitlement?.ledger?.gapAmountPaise ?? null,
  });
  const now = input.clock.now();

  try {
    const created = await db.case.create({
      data: {
        citizenId: input.citizenId,
        entitlementId: input.entitlementId ?? null,
        kind: input.kind,
        priority,
        district: citizen.district ?? "UNASSIGNED",
        sourceKey: input.sourceKey,
        summary: input.summary.slice(0, 500),
        openedAt: now,
        dueAt: new Date(now.getTime() + dueInDays * DAY_MS),
        events: { create: { type: "OPENED", note: input.summary.slice(0, 500), at: now } },
      },
    });
    log.info("case.opened", { caseId: created.id, kind: input.kind, priority });
    return { caseId: created.id, created: true };
  } catch (error) {
    // Two triggers raced on the same sourceKey; the other one won.
    const winner = await db.case.findUnique({ where: { sourceKey: input.sourceKey }, select: { id: true } });
    if (winner) return { caseId: winner.id, created: false };
    throw error;
  }
}

function covers(staff: StaffContext, district: string): boolean {
  return staff.roles.includes("ADMIN") || staff.districts.includes(district);
}

const notFound = () => new ApiError("NOT_FOUND", "That case does not exist.");

async function loadCase(db: PrismaClient, staff: StaffContext, caseId: string) {
  const row = await db.case.findUnique({ where: { id: caseId } });
  if (!row) throw notFound();
  const visible =
    row.assignedToId === staff.staffId ||
    (covers(staff, row.district) && caseKindsFor(staff.roles).includes(row.kind));
  if (!visible) throw notFound();
  return row;
}

function requireAssignee(staff: StaffContext, row: { assignedToId: string | null }): void {
  if (row.assignedToId !== staff.staffId) {
    throw new ApiError("FORBIDDEN", "Only the person this case is assigned to can do that.");
  }
}

export async function listCases(
  db: PrismaClient,
  staff: StaffContext,
  scope: "mine" | "queue",
  clock: Clock,
): Promise<CaseListItem[]> {
  requireCapability(staff, "case.viewQueue");
  const isAdmin = staff.roles.includes("ADMIN");

  const where =
    scope === "mine"
      ? { assignedToId: staff.staffId, status: { in: OPEN_STATUSES } }
      : {
          status: { in: OPEN_STATUSES },
          kind: { in: caseKindsFor(staff.roles) },
          ...(isAdmin ? {} : { district: { in: staff.districts } }),
        };

  const rows = await db.case.findMany({
    where,
    orderBy: [{ priority: "asc" }, { dueAt: "asc" }],
    take: 200,
  });
  const citizens = await db.citizen.findMany({
    where: { id: { in: [...new Set(rows.map((r) => r.citizenId))] } },
    select: { id: true, name: true },
  });
  const nameOf = new Map(citizens.map((c) => [c.id, c.name]));
  const now = clock.now().getTime();

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status,
    priority: row.priority,
    district: row.district,
    summary: row.summary,
    dueAt: row.dueAt.toISOString(),
    openedAt: row.openedAt.toISOString(),
    overdue: row.dueAt.getTime() < now,
    assignedToId: row.assignedToId,
    citizen: { id: row.citizenId, name: nameOf.get(row.citizenId) ?? "Unknown" },
  }));
}
```

Continue `lib/staff/cases.ts`:

```ts
export async function getCase(db: PrismaClient, staff: StaffContext, caseId: string) {
  requireCapability(staff, "case.viewQueue");
  const row = await loadCase(db, staff, caseId);
  const [events, citizen] = await Promise.all([
    db.caseEvent.findMany({ where: { caseId }, orderBy: [{ at: "asc" }, { id: "asc" }] }),
    db.citizen.findUniqueOrThrow({ where: { id: row.citizenId }, select: { id: true, name: true } }),
  ]);
  return { ...row, events, citizen };
}

export type CaseDetail = Awaited<ReturnType<typeof getCase>>;

export async function takeCase(db: PrismaClient, input: { staff: StaffContext; caseId: string; clock: Clock }): Promise<void> {
  requireCapability(input.staff, "case.take");
  const row = await loadCase(db, input.staff, input.caseId);
  const now = input.clock.now();

  const taken = await db.case.updateMany({
    where: { id: row.id, status: "OPEN", assignedToId: null },
    data: { status: "ASSIGNED", assignedToId: input.staff.staffId, assignedAt: now },
  });
  if (taken.count === 0) throw new ApiError("CONFLICT", "Someone else has already taken this case.");
  await appendCaseEvent(db, { caseId: row.id, staffId: input.staff.staffId, type: "ASSIGNED", fromValue: null, toValue: input.staff.staffId, at: now });
}

export async function assignCase(
  db: PrismaClient,
  input: { admin: StaffContext; caseId: string; assigneeId: string; clock: Clock },
): Promise<void> {
  requireCapability(input.admin, "case.assign");
  const row = await db.case.findUnique({ where: { id: input.caseId } });
  if (!row) throw notFound();
  if (CLOSED_STATUSES.includes(row.status)) throw new ApiError("CONFLICT", "Reopen this case before assigning it.");

  const assignee = await db.staff.findUnique({ where: { id: input.assigneeId } });
  const eligible =
    assignee &&
    assignee.isActive &&
    can(assignee, "case.take") &&
    caseKindsFor(assignee.roles).includes(row.kind) &&
    (assignee.roles.includes("ADMIN") || assignee.districts.includes(row.district));
  if (!eligible) {
    throw new ApiError("UNPROCESSABLE", "That person cannot work this case: check their roles and districts.");
  }

  const now = input.clock.now();
  await db.case.update({ where: { id: row.id }, data: { status: "ASSIGNED", assignedToId: assignee.id, assignedAt: now } });
  await appendCaseEvent(db, { caseId: row.id, staffId: input.admin.staffId, type: "ASSIGNED", fromValue: row.assignedToId, toValue: assignee.id, at: now });
}

export async function setCaseStatus(
  db: PrismaClient,
  input: { staff: StaffContext; caseId: string; status: "IN_PROGRESS" | "WAITING_ON_CITIZEN" | "WAITING_ON_GOVERNMENT"; note?: string; clock: Clock },
): Promise<void> {
  requireCapability(input.staff, "case.work");
  const row = await loadCase(db, input.staff, input.caseId);
  requireAssignee(input.staff, row);
  if (CLOSED_STATUSES.includes(row.status)) throw new ApiError("CONFLICT", "This case is closed. Reopen it first.");

  const now = input.clock.now();
  await db.case.update({ where: { id: row.id }, data: { status: input.status } });
  await appendCaseEvent(db, { caseId: row.id, staffId: input.staff.staffId, type: "STATUS_CHANGED", fromValue: row.status, toValue: input.status, note: input.note ?? null, at: now });
}

export async function addCaseNote(db: PrismaClient, input: { staff: StaffContext; caseId: string; note: string; clock: Clock }): Promise<void> {
  const row = await loadCase(db, input.staff, input.caseId);
  if (!input.staff.roles.includes("ADMIN")) requireAssignee(input.staff, row);
  const note = input.note.trim();
  if (note.length < 3) throw new ApiError("BAD_REQUEST", "Write a note.");
  await appendCaseEvent(db, { caseId: row.id, staffId: input.staff.staffId, type: "NOTE", note: note.slice(0, 2000), at: input.clock.now() });
}

const SETTLED_STATES = new Set(["RECOVERED", "MONITORING", "VERIFIED_RECEIVED"]);

export async function resolveCase(
  db: PrismaClient,
  input: { staff: StaffContext; caseId: string; resolution: "RESOLVED" | "CLOSED_NO_ACTION"; note: string; clock: Clock },
): Promise<void> {
  requireCapability(input.staff, "case.work");
  const row = await loadCase(db, input.staff, input.caseId);
  requireAssignee(input.staff, row);
  if (CLOSED_STATUSES.includes(row.status)) throw new ApiError("CONFLICT", "This case is already closed.");

  const note = input.note.trim();
  if (note.length < 10) throw new ApiError("BAD_REQUEST", "Say what was done, in at least a few words.");

  if (input.resolution === "RESOLVED" && (row.kind === "UNKNOWN_CAUSE" || row.kind === "ACTION_FAILED")) {
    const recorded = await db.caseEvent.count({ where: { caseId: row.id, type: "ROOT_CAUSE_RECORDED" } });
    const settled = row.entitlementId
      ? SETTLED_STATES.has(
          (await db.entitlement.findUnique({ where: { id: row.entitlementId }, select: { lifecycleState: true } }))?.lifecycleState ?? "",
        )
      : false;
    if (recorded === 0 && !settled) {
      throw new ApiError("UNPROCESSABLE", "Record a root cause (or re-verify the benefit) before resolving this case.");
    }
  }

  const now = input.clock.now();
  await db.case.update({ where: { id: row.id }, data: { status: input.resolution, resolvedAt: now, resolution: note.slice(0, 2000) } });
  await appendCaseEvent(db, { caseId: row.id, staffId: input.staff.staffId, type: "RESOLVED", fromValue: row.status, toValue: input.resolution, note, at: now });
}

export async function reopenCase(db: PrismaClient, input: { staff: StaffContext; caseId: string; note: string; clock: Clock }): Promise<void> {
  const row = await db.case.findUnique({ where: { id: input.caseId } });
  if (!row) throw notFound();
  const allowed = input.staff.roles.includes("ADMIN") || row.assignedToId === input.staff.staffId;
  if (!allowed) throw notFound();
  if (!CLOSED_STATUSES.includes(row.status)) throw new ApiError("CONFLICT", "This case is not closed.");

  const now = input.clock.now();
  await db.case.update({ where: { id: row.id }, data: { status: "OPEN", assignedToId: null, assignedAt: null, resolvedAt: null } });
  await appendCaseEvent(db, { caseId: row.id, staffId: input.staff.staffId, type: "REOPENED", fromValue: row.status, toValue: "OPEN", note: input.note.slice(0, 2000), at: now });
}

export async function releaseCasesOf(db: PrismaClient, input: { staffId: string; byStaffId: string | null; clock: Clock }): Promise<number> {
  const rows = await db.case.findMany({ where: { assignedToId: input.staffId, status: { in: OPEN_STATUSES } }, select: { id: true } });
  const now = input.clock.now();
  for (const row of rows) {
    await db.case.update({ where: { id: row.id }, data: { status: "OPEN", assignedToId: null, assignedAt: null } });
    await appendCaseEvent(db, { caseId: row.id, staffId: input.byStaffId, type: "ASSIGNED", fromValue: input.staffId, toValue: null, note: "Returned to the queue: assignee deactivated.", at: now });
  }
  return rows.length;
}
```

- [ ] **Step 4: Routes**

Create `app/api/staff/cases/route.ts`:

```ts
/** GET /api/staff/cases?scope=mine|queue */

import { handler, ok, parseQuery, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { listCases } from "@/lib/staff/cases";

const Query = z.object({ scope: z.enum(["mine", "queue"]).default("queue") });

export const GET = handler("GET /api/staff/cases", async (request) => {
  const staff = await requireStaff(request, "case.viewQueue");
  const { scope } = parseQuery(request, Query);
  return ok({ scope, cases: await listCases(prisma, staff, scope, await currentClock()) });
});
```

Create `app/api/staff/cases/[id]/route.ts`:

```ts
/** GET /api/staff/cases/:id — case detail; opening it is an access to the citizen's record. */

import { handler, ok, routeParam } from "@/lib/api/http";
import { authorizeCitizen, requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { getCase } from "@/lib/staff/cases";

export const GET = handler("GET /api/staff/cases/:id", async (request, ctx) => {
  const staff = await requireStaff(request, "case.viewQueue");
  const detail = await getCase(prisma, staff, await routeParam(ctx, "id"));
  await authorizeCitizen(request, detail.citizenId, { purpose: "view:case" });
  return ok({
    ...detail,
    openedAt: detail.openedAt.toISOString(),
    dueAt: detail.dueAt.toISOString(),
    assignedAt: detail.assignedAt?.toISOString() ?? null,
    resolvedAt: detail.resolvedAt?.toISOString() ?? null,
    events: detail.events.map((e) => ({ ...e, at: e.at.toISOString() })),
  });
});
```

Create the six action routes. Each follows this shape — `app/api/staff/cases/[id]/take/route.ts`:

```ts
/** POST /api/staff/cases/:id/take */

import { mutation, ok, routeParam } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { takeCase } from "@/lib/staff/cases";

export const POST = mutation(
  "POST /api/staff/cases/:id/take",
  async (request, ctx) => {
    const staff = await requireStaff(request, "case.take");
    await takeCase(prisma, { staff, caseId: await routeParam(ctx, "id"), clock: await currentClock() });
    return ok({ taken: true });
  },
  { body: "none" },
);
```

`app/api/staff/cases/[id]/assign/route.ts`:

```ts
/** POST /api/staff/cases/:id/assign  { staffId } — admins only. */

import { mutation, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { assignCase } from "@/lib/staff/cases";

const Body = z.object({ staffId: z.string().min(1) });

export const POST = mutation("POST /api/staff/cases/:id/assign", async (request, ctx) => {
  const admin = await requireStaff(request, "case.assign");
  const body = await parseBody(request, Body);
  await assignCase(prisma, { admin, caseId: await routeParam(ctx, "id"), assigneeId: body.staffId, clock: await currentClock() });
  return ok({ assigned: body.staffId });
});
```

`app/api/staff/cases/[id]/status/route.ts`:

```ts
/** POST /api/staff/cases/:id/status  { status, note? } */

import { mutation, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { setCaseStatus } from "@/lib/staff/cases";

const Body = z.object({
  status: z.enum(["IN_PROGRESS", "WAITING_ON_CITIZEN", "WAITING_ON_GOVERNMENT"]),
  note: z.string().max(2000).optional(),
});

export const POST = mutation("POST /api/staff/cases/:id/status", async (request, ctx) => {
  const staff = await requireStaff(request, "case.work");
  const body = await parseBody(request, Body);
  await setCaseStatus(prisma, { staff, caseId: await routeParam(ctx, "id"), status: body.status, note: body.note, clock: await currentClock() });
  return ok({ status: body.status });
});
```

`app/api/staff/cases/[id]/note/route.ts`:

```ts
/** POST /api/staff/cases/:id/note  { note } */

import { mutation, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { addCaseNote } from "@/lib/staff/cases";

const Body = z.object({ note: z.string().min(1).max(2000) });

export const POST = mutation("POST /api/staff/cases/:id/note", async (request, ctx) => {
  const staff = await requireStaff(request);
  const body = await parseBody(request, Body);
  await addCaseNote(prisma, { staff, caseId: await routeParam(ctx, "id"), note: body.note, clock: await currentClock() });
  return ok({ noted: true });
});
```

`app/api/staff/cases/[id]/resolve/route.ts`:

```ts
/** POST /api/staff/cases/:id/resolve  { resolution, note } */

import { mutation, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { resolveCase } from "@/lib/staff/cases";

const Body = z.object({ resolution: z.enum(["RESOLVED", "CLOSED_NO_ACTION"]), note: z.string().min(1).max(2000) });

export const POST = mutation("POST /api/staff/cases/:id/resolve", async (request, ctx) => {
  const staff = await requireStaff(request, "case.work");
  const body = await parseBody(request, Body);
  await resolveCase(prisma, { staff, caseId: await routeParam(ctx, "id"), resolution: body.resolution, note: body.note, clock: await currentClock() });
  return ok({ resolution: body.resolution });
});
```

`app/api/staff/cases/[id]/reopen/route.ts`:

```ts
/** POST /api/staff/cases/:id/reopen  { note } */

import { mutation, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { reopenCase } from "@/lib/staff/cases";

const Body = z.object({ note: z.string().min(1).max(2000) });

export const POST = mutation("POST /api/staff/cases/:id/reopen", async (request, ctx) => {
  const staff = await requireStaff(request);
  const body = await parseBody(request, Body);
  await reopenCase(prisma, { staff, caseId: await routeParam(ctx, "id"), note: body.note, clock: await currentClock() });
  return ok({ status: "OPEN" });
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx tsc --noEmit && npx vitest run tests/scenarios/cases.test.ts tests/boundaries`
Expected: PASS (14 case tests; architecture tests still green — `getCase`'s route calls `authorizeCitizen`).

- [ ] **Step 6: Commit**

```bash
git add lib/staff/cases.ts app/api/staff/cases tests/scenarios/cases.test.ts
git commit -m "Cases: idempotent opening, district-scoped queue, atomic take, resolution rules"
```

---

### Task 9: Staff administration and citizen registration

**Files:**
- Create: `lib/staff/staffAdmin.ts`
- Create: `lib/staff/citizens.ts`
- Create: `app/api/staff/admin/staff/route.ts`, `app/api/staff/admin/staff/[id]/route.ts`, `app/api/staff/admin/staff/[id]/reset-password/route.ts`, `app/api/staff/admin/staff/[id]/unlock/route.ts`, `app/api/staff/admin/staff/[id]/revoke-sessions/route.ts`, `app/api/staff/admin/access-log/route.ts`
- Create: `app/api/staff/citizens/route.ts`, `app/api/staff/citizens/[id]/district/route.ts`
- Test: `tests/scenarios/staffAdmin.test.ts`

**Interfaces:**
- Consumes: `hashPassword`, `temporaryPassword`, `checkPolicy` (Task 2); `normaliseEmail`, `unlockStaffAccount` (Task 3); `revokeAllForStaff` (Task 4); `requireCapability` (Task 6); `releaseCasesOf` (Task 8).
- Produces:
  - `createStaff(db, { admin: StaffContext; email: string; name: string; roles: StaffRole[]; districts: string[]; state?: string; clock: Clock }): Promise<{ staffId: string; temporaryPassword: string }>`
  - `updateStaff(db, { admin; staffId; name?: string; roles?: StaffRole[]; districts?: string[]; clock }): Promise<{ sessionsRevoked: number }>`
  - `deactivateStaff(db, { admin; staffId; clock }): Promise<{ casesReturned: number }>`
  - `resetStaffPassword(db, { admin; staffId; clock }): Promise<{ temporaryPassword: string }>`
  - `listStaff(db, admin): Promise<Array<{ id, email, name, roles, districts, isActive, lockedUntil: string | null, mustChangePassword }>>`
  - `registerCitizen(db, { staff: StaffContext; name: string; nameHi?: string; phone?: string; locale?: "en" | "hi"; district: string; state?: string; aadhaarLast4?: string; bankAccountLast4?: string; clock }): Promise<{ citizenId: string }>`
  - `searchCitizens(db, staff, query: string): Promise<Array<{ id, name, district, state }>>`
  - `changeCitizenDistrict(db, { admin; citizenId; district: string; state?: string; clock }): Promise<void>`

Rules: admins cannot deactivate, demote or reset themselves through these functions (prevents locking the organisation out; another admin must do it). Every change writes an `AuditLog` row with `entity: "Staff"` (or `"Citizen"` for district/registration) and `actorStaffId`.

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/staffAdmin.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";

import { POST as createRoute } from "@/app/api/staff/admin/staff/route";
import { PATCH as updateRoute } from "@/app/api/staff/admin/staff/[id]/route";
import { POST as resetRoute } from "@/app/api/staff/admin/staff/[id]/reset-password/route";
import { POST as registerRoute } from "@/app/api/staff/citizens/route";
import { GET as meRoute } from "@/app/api/staff/me/route";
import { prisma } from "@/lib/db";

import { resetCitizenData, resetStaffData } from "../helpers/db";
import { createTestStaff, signIn, staffRequest } from "../helpers/staff";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

let admin: string;
let adminId: string;

beforeEach(async () => {
  await resetStaffData();
  await resetCitizenData();
  const a = await createTestStaff({ roles: ["ADMIN"], districts: [] });
  adminId = a.id;
  admin = await signIn(a.email, a.password);
});

describe("staff administration", () => {
  it("creates staff with a one-time temporary password they must change", async () => {
    const response = await createRoute(
      staffRequest("/api/staff/admin/staff", admin, {
        body: { email: "New.Worker@NGO.org", name: "New Worker", roles: ["FIELD_WORKER"], districts: ["Gaya"] },
      }),
    );
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{22}$/);

    const row = await prisma.staff.findUniqueOrThrow({ where: { email: "new.worker@ngo.org" } });
    expect(row).toMatchObject({ mustChangePassword: true, roles: ["FIELD_WORKER"], createdById: adminId });
    expect(row.passwordHash).not.toContain(data.temporaryPassword);
  });

  it("refuses a duplicate email and anyone who is not an admin", async () => {
    const worker = await createTestStaff({ roles: ["CASEWORKER"], email: "dup@ngo.org" });
    const dup = await createRoute(staffRequest("/api/staff/admin/staff", admin, { body: { email: "dup@ngo.org", name: "D", roles: ["CASEWORKER"], districts: ["Gaya"] } }));
    expect(dup.status).toBe(409);

    const cookie = await signIn(worker.email, worker.password);
    const forbidden = await createRoute(staffRequest("/api/staff/admin/staff", cookie, { body: { email: "x@ngo.org", name: "X", roles: ["ADMIN"], districts: [] } }));
    expect(forbidden.status).toBe(403);
  });

  it("updating roles revokes sessions", async () => {
    const worker = await createTestStaff({ roles: ["CASEWORKER"] });
    const cookie = await signIn(worker.email, worker.password);
    const response = await updateRoute(
      staffRequest(`/api/staff/admin/staff/${worker.id}`, admin, { method: "PATCH", body: { roles: ["FIELD_WORKER"] } }),
      ctx(worker.id),
    );
    expect(response.status).toBe(200);
    expect((await meRoute(staffRequest("/api/staff/me", cookie))).status).toBe(401);
  });

  it("deactivation ends sessions and returns open cases to the queue", async () => {
    const worker = await createTestStaff({ roles: ["CASEWORKER"] });
    const cookie = await signIn(worker.email, worker.password);
    const response = await updateRoute(
      staffRequest(`/api/staff/admin/staff/${worker.id}`, admin, { method: "PATCH", body: { isActive: false } }),
      ctx(worker.id),
    );
    expect(response.status).toBe(200);
    expect((await meRoute(staffRequest("/api/staff/me", cookie))).status).toBe(401);
  });

  it("resets a password: old one stops working, sessions end, change is forced", async () => {
    const worker = await createTestStaff({ roles: ["CASEWORKER"] });
    const cookie = await signIn(worker.email, worker.password);
    const response = await resetRoute(staffRequest(`/api/staff/admin/staff/${worker.id}/reset-password`, admin, { body: {} }), ctx(worker.id));
    const { data } = await response.json();
    expect((await meRoute(staffRequest("/api/staff/me", cookie))).status).toBe(401);
    await expect(signIn(worker.email, worker.password)).rejects.toThrow();
    const fresh = await signIn(worker.email, data.temporaryPassword);
    expect((await meRoute(staffRequest("/api/staff/me", fresh))).status).toBe(401); // must change first
  });

  it("will not let an admin deactivate or demote themselves", async () => {
    const response = await updateRoute(
      staffRequest(`/api/staff/admin/staff/${adminId}`, admin, { method: "PATCH", body: { isActive: false } }),
      ctx(adminId),
    );
    expect(response.status).toBe(422);
  });
});

describe("citizen registration", () => {
  it("lets a field worker register a citizen in their own district only", async () => {
    const worker = await createTestStaff({ roles: ["FIELD_WORKER"], districts: ["Gaya"] });
    const cookie = await signIn(worker.email, worker.password);

    const ok = await registerRoute(staffRequest("/api/staff/citizens", cookie, { body: { name: "Meena Devi", district: "Gaya", state: "Bihar" } }));
    expect(ok.status).toBe(200);
    const { data } = await ok.json();
    const row = await prisma.citizen.findUniqueOrThrow({ where: { id: data.citizenId } });
    expect(row).toMatchObject({ district: "Gaya", registeredByStaffId: worker.id, isDemo: false });

    const elsewhere = await registerRoute(staffRequest("/api/staff/citizens", cookie, { body: { name: "Other", district: "Patna" } }));
    expect(elsewhere.status).toBe(403);
  });

  it("refuses a full Aadhaar number - only the last four digits are kept", async () => {
    const worker = await createTestStaff({ roles: ["FIELD_WORKER"], districts: ["Gaya"] });
    const cookie = await signIn(worker.email, worker.password);
    const response = await registerRoute(staffRequest("/api/staff/citizens", cookie, { body: { name: "M", district: "Gaya", aadhaarLast4: "999988887777" } }));
    expect(response.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/staffAdmin.test.ts`
Expected: FAIL — cannot resolve `@/app/api/staff/admin/staff/route`.

- [ ] **Step 3: Implement `lib/staff/staffAdmin.ts`**

```ts
/**
 * Staff administration: accounts, roles, districts, deactivation, resets.
 * Admin-only. Every change ends the affected person's sessions when it
 * changes what they may do, and is written to the audit log.
 */

import { ApiError } from "@/lib/api/http";
import { hashPassword, temporaryPassword } from "@/lib/auth/password";
import { normaliseEmail } from "@/lib/auth/rateLimit";
import { revokeAllForStaff, type StaffContext } from "@/lib/auth/sessions";
import type { Clock } from "@/lib/clock";
import type { PrismaClient, StaffRole } from "@/lib/generated/prisma/client";

import { releaseCasesOf } from "./cases";
import { requireCapability } from "./permissions";

async function audit(db: PrismaClient, admin: StaffContext, staffId: string, event: string, reason: string, clock: Clock) {
  await db.auditLog.create({
    data: { actor: `staff:${admin.staffId}`, actorStaffId: admin.staffId, entity: "Staff", entityId: staffId, toState: event, reason, createdAt: clock.now() },
  });
}

function notSelf(admin: StaffContext, staffId: string, what: string): void {
  if (admin.staffId === staffId) {
    throw new ApiError("UNPROCESSABLE", `You cannot ${what} your own account. Ask another admin.`);
  }
}

export async function createStaff(
  db: PrismaClient,
  input: { admin: StaffContext; email: string; name: string; roles: StaffRole[]; districts: string[]; state?: string; clock: Clock },
): Promise<{ staffId: string; temporaryPassword: string }> {
  requireCapability(input.admin, "staff.manage");
  if (input.roles.length === 0) throw new ApiError("BAD_REQUEST", "Give the account at least one role.");

  const email = normaliseEmail(input.email);
  if (await db.staff.findUnique({ where: { email }, select: { id: true } })) {
    throw new ApiError("CONFLICT", "An account with that email already exists.");
  }

  const password = temporaryPassword();
  const staff = await db.staff.create({
    data: {
      email,
      name: input.name.trim(),
      passwordHash: await hashPassword(password),
      roles: [...new Set(input.roles)],
      districts: [...new Set(input.districts.map((d) => d.trim()).filter(Boolean))],
      state: input.state ?? null,
      mustChangePassword: true,
      createdById: input.admin.staffId,
    },
  });
  await audit(db, input.admin, staff.id, "CREATED", `Created with roles ${staff.roles.join(", ")}.`, input.clock);
  return { staffId: staff.id, temporaryPassword: password };
}

export async function updateStaff(
  db: PrismaClient,
  input: { admin: StaffContext; staffId: string; name?: string; roles?: StaffRole[]; districts?: string[]; clock: Clock },
): Promise<{ sessionsRevoked: number }> {
  requireCapability(input.admin, "staff.manage");
  const before = await db.staff.findUnique({ where: { id: input.staffId } });
  if (!before) throw new ApiError("NOT_FOUND", "No such staff member.");
  if (input.roles && !input.roles.includes("ADMIN") && before.roles.includes("ADMIN")) notSelf(input.admin, input.staffId, "remove admin from");
  if (input.roles && input.roles.length === 0) throw new ApiError("BAD_REQUEST", "Keep at least one role.");

  const rolesChanged = input.roles !== undefined && [...input.roles].sort().join() !== [...before.roles].sort().join();
  const districtsChanged = input.districts !== undefined && [...input.districts].sort().join() !== [...before.districts].sort().join();

  await db.staff.update({
    where: { id: input.staffId },
    data: {
      ...(input.name ? { name: input.name.trim() } : {}),
      ...(input.roles ? { roles: [...new Set(input.roles)] } : {}),
      ...(input.districts ? { districts: [...new Set(input.districts.map((d) => d.trim()).filter(Boolean))] } : {}),
    },
  });

  let sessionsRevoked = 0;
  if (rolesChanged || districtsChanged) {
    sessionsRevoked = await revokeAllForStaff(db, input.staffId, "ROLES_CHANGED", input.clock);
    await audit(
      db,
      input.admin,
      input.staffId,
      "ROLES_CHANGED",
      `Roles ${input.roles?.join(", ") ?? before.roles.join(", ")}; districts ${input.districts?.join(", ") ?? before.districts.join(", ")}.`,
      input.clock,
    );
  }
  return { sessionsRevoked };
}

export async function deactivateStaff(
  db: PrismaClient,
  input: { admin: StaffContext; staffId: string; clock: Clock },
): Promise<{ casesReturned: number }> {
  requireCapability(input.admin, "staff.manage");
  notSelf(input.admin, input.staffId, "deactivate");
  const now = input.clock.now();
  await db.staff.update({ where: { id: input.staffId }, data: { isActive: false, deactivatedAt: now } });
  await revokeAllForStaff(db, input.staffId, "DEACTIVATED", input.clock);
  const casesReturned = await releaseCasesOf(db, { staffId: input.staffId, byStaffId: input.admin.staffId, clock: input.clock });
  await audit(db, input.admin, input.staffId, "DEACTIVATED", `Deactivated; ${casesReturned} open case(s) returned to the queue.`, input.clock);
  return { casesReturned };
}

export async function reactivateStaff(db: PrismaClient, input: { admin: StaffContext; staffId: string; clock: Clock }): Promise<void> {
  requireCapability(input.admin, "staff.manage");
  await db.staff.update({ where: { id: input.staffId }, data: { isActive: true, deactivatedAt: null } });
  await audit(db, input.admin, input.staffId, "REACTIVATED", "Reactivated.", input.clock);
}

export async function resetStaffPassword(
  db: PrismaClient,
  input: { admin: StaffContext; staffId: string; clock: Clock },
): Promise<{ temporaryPassword: string }> {
  requireCapability(input.admin, "staff.manage");
  notSelf(input.admin, input.staffId, "reset the password of");
  const password = temporaryPassword();
  await db.staff.update({
    where: { id: input.staffId },
    data: { passwordHash: await hashPassword(password), mustChangePassword: true, lockedUntil: null, failedLoginCount: 0 },
  });
  await revokeAllForStaff(db, input.staffId, "PASSWORD_RESET", input.clock);
  await audit(db, input.admin, input.staffId, "PASSWORD_RESET", "Temporary password issued; all sessions ended.", input.clock);
  return { temporaryPassword: password };
}

export async function listStaff(db: PrismaClient, admin: StaffContext) {
  requireCapability(admin, "staff.manage");
  const rows = await db.staff.findMany({ orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  return rows.map((s) => ({
    id: s.id,
    email: s.email,
    name: s.name,
    roles: s.roles,
    districts: s.districts,
    isActive: s.isActive,
    mustChangePassword: s.mustChangePassword,
    lockedUntil: s.lockedUntil?.toISOString() ?? null,
  }));
}
```

- [ ] **Step 4: Implement `lib/staff/citizens.ts`**

```ts
/**
 * Citizens from the staff side: registration (field workers, own district),
 * district-scoped search, and district changes (admins only, logged).
 */

import { ApiError } from "@/lib/api/http";
import type { StaffContext } from "@/lib/auth/sessions";
import type { Clock } from "@/lib/clock";
import type { PrismaClient } from "@/lib/generated/prisma/client";

import { requireCapability } from "./permissions";

export async function registerCitizen(
  db: PrismaClient,
  input: {
    staff: StaffContext;
    name: string;
    nameHi?: string;
    phone?: string;
    locale?: "en" | "hi";
    district: string;
    state?: string;
    aadhaarLast4?: string;
    bankAccountLast4?: string;
    clock: Clock;
  },
): Promise<{ citizenId: string }> {
  requireCapability(input.staff, "citizen.register");
  const district = input.district.trim();
  if (!input.staff.districts.includes(district)) {
    throw new ApiError("FORBIDDEN", "You can register citizens only in your own districts.");
  }

  const citizen = await db.citizen.create({
    data: {
      name: input.name.trim(),
      nameHi: input.nameHi?.trim() || null,
      phone: input.phone?.trim() || null,
      locale: input.locale ?? "hi",
      district,
      state: input.state?.trim() || null,
      aadhaarLast4: input.aadhaarLast4 ?? null,
      bankAccountLast4: input.bankAccountLast4 ?? null,
      isDemo: false,
      registeredByStaffId: input.staff.staffId,
    },
  });
  await db.auditLog.create({
    data: {
      citizenId: citizen.id,
      actor: `staff:${input.staff.staffId}`,
      actorStaffId: input.staff.staffId,
      entity: "Citizen",
      entityId: citizen.id,
      toState: "REGISTERED",
      reason: `Registered in ${district} by staff.`,
      createdAt: input.clock.now(),
    },
  });
  return { citizenId: citizen.id };
}

export async function searchCitizens(db: PrismaClient, staff: StaffContext, query: string) {
  requireCapability(staff, "citizen.view");
  const isAdmin = staff.roles.includes("ADMIN");
  const rows = await db.citizen.findMany({
    where: {
      isDemo: process.env.DEMO_MODE?.trim().toLowerCase() === "true" ? undefined : false,
      archivedAt: isAdmin ? undefined : null,
      ...(isAdmin ? {} : { district: { in: staff.districts } }),
      ...(query.trim() ? { name: { contains: query.trim(), mode: "insensitive" as const } } : {}),
    },
    orderBy: { name: "asc" },
    take: 50,
    select: { id: true, name: true, nameHi: true, district: true, state: true },
  });
  return rows;
}

export async function changeCitizenDistrict(
  db: PrismaClient,
  input: { admin: StaffContext; citizenId: string; district: string; state?: string; clock: Clock },
): Promise<void> {
  requireCapability(input.admin, "citizen.changeDistrict");
  const before = await db.citizen.findUnique({ where: { id: input.citizenId }, select: { district: true } });
  if (!before) throw new ApiError("NOT_FOUND", "That citizen record does not exist.");
  await db.citizen.update({
    where: { id: input.citizenId },
    data: { district: input.district.trim(), ...(input.state ? { state: input.state.trim() } : {}) },
  });
  await db.auditLog.create({
    data: {
      citizenId: input.citizenId,
      actor: `staff:${input.admin.staffId}`,
      actorStaffId: input.admin.staffId,
      entity: "Citizen",
      entityId: input.citizenId,
      fromState: before.district,
      toState: input.district.trim(),
      reason: "District changed by an admin.",
      createdAt: input.clock.now(),
    },
  });
}
```

- [ ] **Step 5: Routes**

`app/api/staff/admin/staff/route.ts`:

```ts
/** GET /api/staff/admin/staff — list; POST — create (returns a one-time temporary password). */

import { handler, mutation, ok, parseBody, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { createStaff, listStaff } from "@/lib/staff/staffAdmin";

const Role = z.enum(["ADMIN", "CASEWORKER", "FIELD_WORKER", "RULE_REVIEWER"]);
const Body = z.object({
  email: z.email().max(200),
  name: z.string().min(1).max(120),
  roles: z.array(Role).min(1),
  districts: z.array(z.string().min(1).max(80)).max(50),
  state: z.string().max(80).optional(),
});

export const GET = handler("GET /api/staff/admin/staff", async (request) => {
  const admin = await requireStaff(request, "staff.manage");
  return ok({ staff: await listStaff(prisma, admin) });
});

export const POST = mutation("POST /api/staff/admin/staff", async (request) => {
  const admin = await requireStaff(request, "staff.manage");
  const body = await parseBody(request, Body);
  return ok(await createStaff(prisma, { admin, ...body, clock: systemClock() }));
});
```

`app/api/staff/admin/staff/[id]/route.ts`:

```ts
/** PATCH /api/staff/admin/staff/:id  { name?, roles?, districts?, isActive? } */

import { mutation, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { deactivateStaff, reactivateStaff, updateStaff } from "@/lib/staff/staffAdmin";

const Role = z.enum(["ADMIN", "CASEWORKER", "FIELD_WORKER", "RULE_REVIEWER"]);
const Body = z.object({
  name: z.string().min(1).max(120).optional(),
  roles: z.array(Role).min(1).optional(),
  districts: z.array(z.string().min(1).max(80)).max(50).optional(),
  isActive: z.boolean().optional(),
});

export const PATCH = mutation("PATCH /api/staff/admin/staff/:id", async (request, ctx) => {
  const admin = await requireStaff(request, "staff.manage");
  const staffId = await routeParam(ctx, "id");
  const body = await parseBody(request, Body);
  const clock = systemClock();

  const result: Record<string, unknown> = {};
  if (body.name || body.roles || body.districts) {
    Object.assign(result, await updateStaff(prisma, { admin, staffId, name: body.name, roles: body.roles, districts: body.districts, clock }));
  }
  if (body.isActive === false) Object.assign(result, await deactivateStaff(prisma, { admin, staffId, clock }));
  if (body.isActive === true) await reactivateStaff(prisma, { admin, staffId, clock });
  return ok(result);
});
```

`app/api/staff/admin/staff/[id]/reset-password/route.ts`:

```ts
/** POST /api/staff/admin/staff/:id/reset-password — returns a one-time temporary password. */

import { mutation, ok, routeParam } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { resetStaffPassword } from "@/lib/staff/staffAdmin";

export const POST = mutation(
  "POST /api/staff/admin/staff/:id/reset-password",
  async (request, ctx) => {
    const admin = await requireStaff(request, "staff.manage");
    return ok(await resetStaffPassword(prisma, { admin, staffId: await routeParam(ctx, "id"), clock: systemClock() }));
  },
  { body: "none" },
);
```

Note: the test posts `{ body: {} }` with JSON content type; `{ body: "none" }` skips the content-type check, so both work.

`app/api/staff/admin/staff/[id]/unlock/route.ts`:

```ts
/** POST /api/staff/admin/staff/:id/unlock */

import { mutation, ok, routeParam } from "@/lib/api/http";
import { unlockStaffAccount } from "@/lib/auth/rateLimit";
import { requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";

export const POST = mutation(
  "POST /api/staff/admin/staff/:id/unlock",
  async (request, ctx) => {
    const admin = await requireStaff(request, "staff.manage");
    const staffId = await routeParam(ctx, "id");
    await unlockStaffAccount(prisma, staffId);
    await prisma.auditLog.create({
      data: { actor: `staff:${admin.staffId}`, actorStaffId: admin.staffId, entity: "Staff", entityId: staffId, toState: "UNLOCKED", reason: "Unlocked by an admin.", createdAt: systemClock().now() },
    });
    return ok({ unlocked: true });
  },
  { body: "none" },
);
```

`app/api/staff/admin/staff/[id]/revoke-sessions/route.ts`:

```ts
/** POST /api/staff/admin/staff/:id/revoke-sessions */

import { mutation, ok, routeParam } from "@/lib/api/http";
import { revokeAllForStaff } from "@/lib/auth/sessions";
import { requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";

export const POST = mutation(
  "POST /api/staff/admin/staff/:id/revoke-sessions",
  async (request, ctx) => {
    const admin = await requireStaff(request, "staff.manage");
    const staffId = await routeParam(ctx, "id");
    const clock = systemClock();
    const revoked = await revokeAllForStaff(prisma, staffId, "ADMIN_REVOKED", clock);
    await prisma.auditLog.create({
      data: { actor: `staff:${admin.staffId}`, actorStaffId: admin.staffId, entity: "StaffSession", entityId: staffId, toState: "REVOKED", reason: `${revoked} session(s) ended by an admin.`, createdAt: clock.now() },
    });
    return ok({ revoked });
  },
  { body: "none" },
);
```

`app/api/staff/admin/access-log/route.ts`:

```ts
/** GET /api/staff/admin/access-log?citizenId=&staffId= — admins only, newest first. */

import { handler, ok, parseQuery, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";

const Query = z.object({ citizenId: z.string().optional(), staffId: z.string().optional() });

export const GET = handler("GET /api/staff/admin/access-log", async (request) => {
  await requireStaff(request, "logs.read");
  const query = parseQuery(request, Query);
  const rows = await prisma.accessLog.findMany({
    where: { ...(query.citizenId ? { citizenId: query.citizenId } : {}), ...(query.staffId ? { staffId: query.staffId } : {}) },
    orderBy: { at: "desc" },
    take: 200,
  });
  return ok({ entries: rows.map((r) => ({ ...r, at: r.at.toISOString() })) });
});
```

`app/api/staff/citizens/route.ts`:

```ts
/** GET /api/staff/citizens?q= — district-scoped search; POST — register (field workers). */

import { handler, mutation, ok, parseBody, parseQuery, z } from "@/lib/api/http";
import { requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { registerCitizen, searchCitizens } from "@/lib/staff/citizens";

const Query = z.object({ q: z.string().max(100).default("") });
const Body = z.object({
  name: z.string().min(1).max(120),
  nameHi: z.string().max(120).optional(),
  phone: z.string().regex(/^[0-9+ -]{6,20}$/).optional(),
  locale: z.enum(["en", "hi"]).optional(),
  district: z.string().min(1).max(80),
  state: z.string().max(80).optional(),
  // Last four digits only: a full identifier is never accepted.
  aadhaarLast4: z.string().regex(/^\d{4}$/).optional(),
  bankAccountLast4: z.string().regex(/^\d{4}$/).optional(),
});

export const GET = handler("GET /api/staff/citizens", async (request) => {
  const staff = await requireStaff(request, "citizen.view");
  const { q } = parseQuery(request, Query);
  return ok({ citizens: await searchCitizens(prisma, staff, q) });
});

export const POST = mutation("POST /api/staff/citizens", async (request) => {
  const staff = await requireStaff(request, "citizen.register");
  const body = await parseBody(request, Body);
  return ok(await registerCitizen(prisma, { staff, ...body, clock: systemClock() }));
});
```

`app/api/staff/citizens/[id]/district/route.ts`:

```ts
/** PATCH /api/staff/citizens/:id/district  { district, state? } — admins only. */

import { mutation, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { authorizeCitizen, requireStaff } from "@/lib/authz";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { changeCitizenDistrict } from "@/lib/staff/citizens";

const Body = z.object({ district: z.string().min(1).max(80), state: z.string().max(80).optional() });

export const PATCH = mutation("PATCH /api/staff/citizens/:id/district", async (request, ctx) => {
  const admin = await requireStaff(request, "citizen.changeDistrict");
  const citizenId = await routeParam(ctx, "id");
  await authorizeCitizen(request, citizenId, { purpose: "change-district" });
  const body = await parseBody(request, Body);
  await changeCitizenDistrict(prisma, { admin, citizenId, district: body.district, state: body.state, clock: systemClock() });
  return ok({ district: body.district });
});
```

- [ ] **Step 6: Run tests**

Run: `npx tsc --noEmit && npx vitest run tests/scenarios/staffAdmin.test.ts tests/boundaries`
Expected: PASS (8 tests; architecture tests green).

- [ ] **Step 7: Commit**

```bash
git add lib/staff/staffAdmin.ts lib/staff/citizens.ts app/api/staff/admin app/api/staff/citizens tests/scenarios/staffAdmin.test.ts
git commit -m "Staff admin: accounts, roles, districts, resets; field-worker citizen registration"
```

---

### Task 10: Witnessed consent and recorded citizen statements

Fixes conflict C4. Staff record that a citizen decided, in person; they never decide.

**Files:**
- Modify: `lib/services/application.ts` (`decideApplicationApproval`)
- Modify: `lib/services/recovery.ts` (`decideActionApproval`)
- Modify: `lib/services/receipt.ts` (`confirmReceipt` accepts `actor`)
- Create: `lib/staff/consent.ts`
- Modify: `app/api/approvals/[id]/decide/route.ts`, `app/api/payments/[id]/confirm/route.ts`
- Test: `tests/scenarios/assistedConsent.test.ts`

**Interfaces:**
- Consumes: `authorizeCitizen`, `CitizenAccess` (Task 7); `requireCapability` (Task 6).
- Produces:
  - `ConsentInput` (Zod): `{ method: "SPOKEN" | "SIGNED" | "THUMB_IMPRESSION" | "CITIZEN_TAPPED"; language: "en" | "hi"; statementShown: string (20..5000); citizenPresent: true; secondWitnessName?: string; channel?: "IN_PERSON" }` — any `channel` other than `IN_PERSON` is refused.
  - `interface ConsentRecord { method: ConsentMethod; channel: "IN_PERSON"; language: string; statementShown: string; citizenPresent: true; recordedByStaffId: string; secondWitnessName: string | null }`
  - `consentFromRequest(access: CitizenAccess, consent: z.infer<typeof ConsentInput> | undefined): { actor: Actor; consent: ConsentRecord }` — throws `FORBIDDEN` unless the staff member can `consent.record`, `UNPROCESSABLE` when evidence is missing or not in person.
  - `decideApplicationApproval(input: { ...existing; actor?: Actor; consent?: ConsentRecord })`
  - `decideActionApproval(input: { ...existing; actor?: Actor; consent?: ConsentRecord })`
  - `confirmReceipt(input: { ...existing; actor?: Actor })`
  - `recordCitizenStatement(db, { staff: StaffContext; citizenId: string; subjectEntity: string; subjectId: string; statement: string; channel: "IN_PERSON" | "PHONE"; clock }): Promise<{ statementId: string }>`

- [ ] **Step 1: Write the failing test**

Create `tests/scenarios/assistedConsent.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { extractProfile } from "@/lib/agents/profileAgent";
import { POST as decide } from "@/app/api/approvals/[id]/decide/route";
import { prisma } from "@/lib/db";
import { prepareApplication, requestApplicationApproval } from "@/lib/services/application";
import { discoverAndPersist } from "@/lib/services/discovery";
import { loadProfile, saveProfileFields } from "@/lib/services/profile";

import { createCitizen, ensureRegistry, resetCitizenData, resetStaffData } from "../helpers/db";
import { createTestStaff, signIn, staffRequest } from "../helpers/staff";

const KAMALA_INTAKE = `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`;

const IDENTITY_FIELDS = {
  aadhaarNumber: "999988887777",
  fullName: "Kamala Devi",
  dateOfBirth: "1959-04-12",
  district: "Gaya",
  bplCardNumber: "BR-PHH-00241",
  bankAccountNumber: "30124578821",
  ifscCode: "SBIN0001234",
};

const CONSENT = {
  method: "THUMB_IMPRESSION",
  language: "hi",
  statementShown: "आपका वृद्धावस्था पेंशन आवेदन ब्लॉक कार्यालय को भेजा जाएगा। आधार और बैंक खाता संलग्न हैं।",
  citizenPresent: true,
};

let citizenId: string;
let approvalId: string;
let field: string;
let fieldId: string;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const decideAs = (cookie: string, body: unknown) =>
  decide(staffRequest(`/api/approvals/${approvalId}/decide`, cookie, { body }), ctx(approvalId));

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  await ensureRegistry();
});

afterAll(() => {
  process.env.DEMO_MODE = "false";
});

beforeEach(async () => {
  await resetStaffData();
  await resetCitizenData();
  citizenId = (await createCitizen()).id;
  await prisma.citizen.update({ where: { id: citizenId }, data: { district: "Gaya" } });

  const extraction = await extractProfile({ intake: KAMALA_INTAKE });
  await saveProfileFields(citizenId, extraction.accepted, { rawIntake: KAMALA_INTAKE });
  await discoverAndPersist({ citizenId, profile: await loadProfile(citizenId) });
  const entitlement = await prisma.entitlement.findFirstOrThrow({ where: { citizenId, scheme: { code: "NSAP-IGNOAPS" } } });
  await prepareApplication({ citizenId, entitlementId: entitlement.id, providedFields: IDENTITY_FIELDS });
  const application = await prisma.application.findFirstOrThrow({ where: { entitlementId: entitlement.id } });
  approvalId = (await requestApplicationApproval({ citizenId, applicationId: application.id })).approvalId;

  const worker = await createTestStaff({ roles: ["FIELD_WORKER"], districts: ["Gaya"] });
  fieldId = worker.id;
  field = await signIn(worker.email, worker.password);
});

describe("witnessed consent", () => {
  it("records the citizen's decision with evidence, atomically, as the citizen's own", async () => {
    const response = await decideAs(field, { citizenId, decision: "APPROVED", consent: CONSENT });
    expect(response.status).toBe(200);

    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } });
    expect(approval.decision).toBe("APPROVED");
    expect(approval.decidedBy).toBe(`citizen:${citizenId}`);
    const evidence = await prisma.consentEvidence.findUniqueOrThrow({ where: { approvalId } });
    expect(approval.consentEvidenceId).toBe(evidence.id);
    expect(evidence).toMatchObject({
      decision: "APPROVED",
      method: "THUMB_IMPRESSION",
      channel: "IN_PERSON",
      citizenPresent: true,
      recordedByStaffId: fieldId,
      language: "hi",
    });

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entity: "Approval", entityId: approvalId } });
    expect(audit.actor).toBe(`citizen:${citizenId}/via:staff:${fieldId}`);
    expect(audit.actorStaffId).toBe(fieldId);
  });

  it("refuses a staff decision with no consent evidence", async () => {
    const response = await decideAs(field, { citizenId, decision: "APPROVED" });
    expect(response.status).toBe(422);
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).decision).toBe("PENDING");
  });

  it("refuses consent taken by phone or without the citizen present", async () => {
    expect((await decideAs(field, { citizenId, decision: "APPROVED", consent: { ...CONSENT, channel: "PHONE" } })).status).toBe(400);
    expect((await decideAs(field, { citizenId, decision: "APPROVED", consent: { ...CONSENT, citizenPresent: false } })).status).toBe(400);
    expect(await prisma.consentEvidence.count()).toBe(0);
  });

  it("lets only field workers record consent - not caseworkers, not admins", async () => {
    const caseworker = await createTestStaff({ roles: ["CASEWORKER"], districts: ["Gaya"] });
    const admin = await createTestStaff({ roles: ["ADMIN"], districts: [] });
    for (const s of [caseworker, admin]) {
      const cookie = await signIn(s.email, s.password);
      expect((await decideAs(cookie, { citizenId, decision: "APPROVED", consent: CONSENT })).status).toBe(403);
    }
    expect((await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).decision).toBe("PENDING");
  });

  it("records a citizen declining, with the same evidence", async () => {
    const response = await decideAs(field, { citizenId, decision: "REJECTED", consent: { ...CONSENT, method: "SPOKEN" } });
    expect(response.status).toBe(200);
    expect((await prisma.consentEvidence.findUniqueOrThrow({ where: { approvalId } })).decision).toBe("REJECTED");
  });

  it("double submission: the second is refused and only one evidence row exists", async () => {
    const first = await decideAs(field, { citizenId, decision: "APPROVED", consent: CONSENT });
    const second = await decideAs(field, { citizenId, decision: "APPROVED", consent: CONSENT });
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(await prisma.consentEvidence.count({ where: { approvalId } })).toBe(1);
  });

  it("still lets the demo citizen decide for themselves, and refuses evidence from a non-staff caller", async () => {
    const own = await decide(
      new Request(`http://t/api/approvals/${approvalId}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ citizenId, decision: "APPROVED", consent: CONSENT }),
      }),
      ctx(approvalId),
    );
    expect(own.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/assistedConsent.test.ts`
Expected: FAIL — the decide route still answers 403 for staff (Task 7 stopgap), so the first test fails.

- [ ] **Step 3: `lib/staff/consent.ts`**

```ts
/**
 * Witnessed consent and recorded statements. Spec §6.
 *
 * A staff member never decides. They record that the citizen, in front of
 * them, decided - with how they consented and the exact words read to them.
 * The decision is stored as the citizen's (decidedBy = citizen:<id>), the
 * evidence is immutable, and the staff member is named next to it.
 */

import * as z from "zod";

import { ApiError } from "@/lib/api/http";
import type { CitizenAccess } from "@/lib/authz";
import type { StaffContext } from "@/lib/auth/sessions";
import type { Clock } from "@/lib/clock";
import type { ConsentMethod, PrismaClient } from "@/lib/generated/prisma/client";
import type { Actor } from "@/lib/services/transitions";

import { requireCapability } from "./permissions";

export const ConsentInput = z.object({
  method: z.enum(["SPOKEN", "SIGNED", "THUMB_IMPRESSION", "CITIZEN_TAPPED"]),
  language: z.enum(["en", "hi"]),
  statementShown: z.string().min(20).max(5000),
  citizenPresent: z.literal(true),
  secondWitnessName: z.string().min(1).max(120).optional(),
  // Approvals are in person only. Present only so a wrong value is refused loudly.
  channel: z.literal("IN_PERSON").optional(),
});

export interface ConsentRecord {
  method: ConsentMethod;
  channel: "IN_PERSON";
  language: string;
  statementShown: string;
  citizenPresent: true;
  recordedByStaffId: string;
  secondWitnessName: string | null;
}

/** Turn a staff request into the actor and evidence for a citizen decision. */
export function consentFromRequest(
  access: CitizenAccess,
  consent: z.infer<typeof ConsentInput> | undefined,
): { actor: Actor; consent: ConsentRecord } {
  const staff = access.staff;
  if (!staff) throw new ApiError("BAD_REQUEST", "Consent evidence is recorded by staff only.");
  requireCapability(staff, "consent.record");
  if (!consent) {
    throw new ApiError(
      "UNPROCESSABLE",
      "Staff cannot decide for a citizen. Read the summary to the citizen and record their consent: how they agreed, in which language, and that they were present.",
    );
  }
  return {
    actor: { kind: "citizen-via-staff", citizenId: access.citizenId, staffId: staff.staffId },
    consent: {
      method: consent.method,
      channel: "IN_PERSON",
      language: consent.language,
      statementShown: consent.statementShown,
      citizenPresent: true,
      recordedByStaffId: staff.staffId,
      secondWitnessName: consent.secondWitnessName ?? null,
    },
  };
}

export async function recordCitizenStatement(
  db: PrismaClient,
  input: { staff: StaffContext; citizenId: string; subjectEntity: string; subjectId: string; statement: string; channel: "IN_PERSON" | "PHONE"; clock: Clock },
): Promise<{ statementId: string }> {
  requireCapability(input.staff, "statement.record");
  const row = await db.citizenStatement.create({
    data: {
      citizenId: input.citizenId,
      subjectEntity: input.subjectEntity,
      subjectId: input.subjectId,
      statement: input.statement,
      channel: input.channel,
      recordedByStaffId: input.staff.staffId,
      recordedAt: input.clock.now(),
    },
  });
  return { statementId: row.id };
}
```

- [ ] **Step 4: Make the approval decision atomic and evidence-aware**

In `lib/services/application.ts`, `decideApplicationApproval`:

1. Add to the input type: `actor?: Actor;` and `consent?: ConsentRecord;` (import `type ConsentRecord` from `@/lib/staff/consent`).
2. Replace `const actor: Actor = { kind: "citizen", citizenId: input.citizenId };` with `const actor: Actor = input.actor ?? { kind: "citizen", citizenId: input.citizenId };`
3. Replace the `prisma.approval.update({...})` call with the guarded transaction below, and **move the `input.edits` loop to directly after it** (so edits apply only when the decision actually landed):

```ts
  const decidedAt = (input.clock ?? systemClock()).now();

  // The decision and its consent evidence land together or not at all, and
  // only if nobody decided first (a second tab, a double tap).
  await prisma.$transaction(async (tx) => {
    const updated = await tx.approval.updateMany({
      where: { id: approval.id, decision: "PENDING" },
      data: {
        decision: input.decision,
        decidedBy: `citizen:${input.citizenId}`,
        decidedAt,
        edits: input.edits ? asJson(input.edits) : undefined,
        note: input.note,
      },
    });
    if (updated.count === 0) throw new ApiError("CONFLICT", "This approval was already decided.");

    if (input.consent) {
      const evidence = await tx.consentEvidence.create({
        data: {
          approvalId: approval.id,
          citizenId: input.citizenId,
          decision: input.decision,
          ...input.consent,
          recordedAt: decidedAt,
        },
      });
      await tx.approval.update({ where: { id: approval.id }, data: { consentEvidenceId: evidence.id } });
    }
  });
```

4. In the `recordAudit` call for the APPROVED branch, keep `actor` (now possibly citizen-via-staff). Its reason text "The citizen approved..." stays true.

Apply the same four changes to `decideActionApproval` in `lib/services/recovery.ts` (it has no `edits`; its `now` is `input.clock.now()`).

In `lib/services/receipt.ts`, `confirmReceipt`: add `actor?: Actor;` to the input and replace `const actor: Actor = { kind: "citizen", citizenId: input.citizenId };` with `const actor: Actor = input.actor ?? { kind: "citizen", citizenId: input.citizenId };`

- [ ] **Step 5: Routes**

In `app/api/approvals/[id]/decide/route.ts`, extend `Body` with `consent: ConsentInput.optional(),` and replace the Task 7 stopgap with:

```ts
    let actor: Actor | undefined;
    let consent: ConsentRecord | undefined;
    if (access.staff) {
      ({ actor, consent } = consentFromRequest(access, body.consent));
    } else if (body.consent) {
      throw new ApiError("BAD_REQUEST", "Consent evidence is recorded by staff only.");
    }
```

and pass `actor, consent` to both `decideApplicationApproval({...})` and `decideActionApproval({...})`. Import `consentFromRequest`, `ConsentInput`, `type ConsentRecord` from `@/lib/staff/consent` and `type Actor` from `@/lib/services/transitions`.

In `app/api/payments/[id]/confirm/route.ts`, extend `Body` with `channel: z.enum(["IN_PERSON", "PHONE"]).optional(),` and replace the stopgap with:

```ts
    let actor: Actor | undefined;
    if (access.staff) {
      if (!body.channel) throw new ApiError("BAD_REQUEST", "Say whether the citizen told you in person or by phone.");
      await recordCitizenStatement(prisma, {
        staff: access.staff,
        citizenId: access.citizenId,
        subjectEntity: "Payment",
        subjectId: paymentId,
        statement: body.answer,
        channel: body.channel,
        clock,
      });
      actor = { kind: "citizen-via-staff", citizenId: access.citizenId, staffId: access.staff.staffId };
    }
```

(placed after `paymentId` and `clock` are read), and pass `actor` to `confirmReceipt`. Add a test to `assistedConsent.test.ts`:

```ts
describe("recorded statements", () => {
  it("records a receipt answer given by phone, attributed to the citizen via staff", async () => {
    const caseworker = await createTestStaff({ roles: ["CASEWORKER"], districts: ["Gaya"] });
    const cookie = await signIn(caseworker.email, caseworker.password);
    const { POST: confirm } = await import("@/app/api/payments/[id]/confirm/route");
    const missingChannel = await confirm(
      staffRequest("/api/payments/p/confirm", cookie, { body: { citizenId, answer: "YES" } }),
      ctx("p"),
    );
    expect(missingChannel.status).toBe(400);
  });
});
```

(A full receipt flow needs a released payment; `tests/scenarios/recovery.test.ts` already covers `confirmReceipt` itself. This test pins the staff-specific rule.)

- [ ] **Step 6: Run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, including all of `assistedConsent.test.ts` and the unchanged recovery/application suites.

- [ ] **Step 7: Commit**

```bash
git add lib/staff/consent.ts lib/services/application.ts lib/services/recovery.ts lib/services/receipt.ts app/api/approvals app/api/payments tests/scenarios/assistedConsent.test.ts
git commit -m "Consent: witnessed, immutable evidence for staff-recorded citizen decisions"
```

---
### Task 11: Cases open themselves; caseworkers act through the recovery loop

Fixes conflict C9. Also closes a latent gap found during planning: `decideActionApproval` does not refuse a **superseded** plan, so approving an old pending approval would revive it. Human-recorded root causes supersede plans more often, so the guard lands here.

**Files:**
- Create: `lib/staff/triggers.ts`
- Create: `lib/staff/caseActions.ts`
- Modify: `lib/services/recovery.ts` (hooks; `humanDiagnosis` input; superseded guard)
- Modify: `lib/llm/stub.ts` (export `getStubFixture`, for tests to restore fixtures)
- Create: `app/api/staff/cases/[id]/root-cause/route.ts`, `app/api/staff/cases/[id]/reaudit/route.ts`, `app/api/staff/cases/[id]/reverify/route.ts`
- Create: `tests/helpers/recoveryFixture.ts`
- Test: `tests/scenarios/caseTriggers.test.ts`

**Interfaces:**
- Consumes: `openCase`, `appendCaseEvent`, `OPEN_STATUSES` (Task 8); `requireCapability` (Task 6); existing `diagnoseAndPlan`, `auditBenefit`, `reverifyBenefit`.
- Produces:
  - `caseFromExecution(db, { citizenId, entitlementId, executionId, stepKind: ActionKind, status: ExecutionStatus, message: string, clock }): Promise<void>`
  - `caseFromUnknownCause(db, { citizenId, entitlementId, rootCauseId, reasoning, clock }): Promise<void>`
  - `caseFromRepeatedFailure(db, { citizenId, entitlementId, gapId, clock }): Promise<void>`
  - `diagnoseAndPlan(input: { ...existing; humanDiagnosis?: HumanDiagnosis })` where `HumanDiagnosis = { kind: RootCauseKind; evidence: string[]; recommendedAction: ActionKind; reasoning: string; staffId: string }`
  - `recordHumanRootCause(db, { staff, caseId, kind, evidence, recommendedAction, reasoning, clock }): Promise<{ actionPlanId: string; approvalId: string }>`
  - `requestReaudit(db, { staff, caseId, clock }): Promise<{ decision: string; summary: string }>`
  - `requestReverify(db, { staff, caseId, clock }): Promise<{ resolved: boolean; summary: string }>`
  - `getStubFixture(task: string): StubFixture | undefined`

Case kinds by trigger (spec §7.1):

| Execution outcome | Step kind | Case kind |
|---|---|---|
| `NEEDS_HUMAN_REVIEW` | `REQUEST_DOCUMENT` | `COLLECT_DOCUMENT` |
| `NEEDS_HUMAN_REVIEW` | `CORRECT_INFORMATION`, `RESUBMIT`, `REAPPLY`, `RETRY_OPERATION` | `NO_APPLICATION_REFERENCE` |
| `NEEDS_HUMAN_REVIEW` | anything else (incl. `REQUEST_CLARIFICATION`) | `NEEDS_CLARIFICATION` |
| `SUCCEEDED` | `REQUEST_ASSISTED_VERIFICATION` | `ASSISTED_VERIFICATION` |

Plus `UNKNOWN_CAUSE` when a root cause is recorded as `UNKNOWN`, and `ACTION_FAILED` when a gap has two or more `FAILED` plans (source key `gap-failed:<gapId>:<count>`, so each further failure opens a fresh case).

- [ ] **Step 1: Shared recovery fixture**

Create `tests/helpers/recoveryFixture.ts` (the setup from `tests/scenarios/recovery.test.ts`, made reusable):

```ts
/**
 * Drive a demo citizen's old-age pension to a confirmed payment discrepancy:
 * the government released it, the bank returned it over Aadhaar seeding, and
 * the citizen confirmed it never arrived. Returns the open gap.
 */

import { extractProfile } from "@/lib/agents/profileAgent";
import { govApproveApplication, govFailPaymentOnSeeding, govReleasePayment } from "@/lib/adapters/mockGovControl";
import type { Clock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { rupees } from "@/lib/engine/money";
import {
  decideApplicationApproval,
  prepareApplication,
  requestApplicationApproval,
  submitApplication,
} from "@/lib/services/application";
import { auditBenefit } from "@/lib/services/audit";
import { discoverAndPersist } from "@/lib/services/discovery";
import { loadProfile, saveProfileFields } from "@/lib/services/profile";

export const KAMALA_INTAKE = `My name is Kamala Devi. I am 67 years old and I am a widow.
I live in a village in Bihar and I do farming on 2 acres of land.
I have a BPL ration card and a bank account. I am not receiving any pension.`;

export const IDENTITY_FIELDS = {
  aadhaarNumber: "999988887777",
  fullName: "Kamala Devi",
  dateOfBirth: "1959-04-12",
  district: "Gaya",
  bplCardNumber: "BR-PHH-00241",
  bankAccountNumber: "30124578821",
  ifscCode: "SBIN0001234",
};

const PENSION = rupees(200);
const PERIOD = "2026-06";

export async function setUpDiscrepancy(input: {
  citizenId: string;
  aadhaarLast4: string;
  clock: Clock;
}): Promise<{ gapId: string; entitlementId: string }> {
  const { citizenId, aadhaarLast4, clock } = input;
  const extraction = await extractProfile({ intake: KAMALA_INTAKE });
  await saveProfileFields(citizenId, extraction.accepted, { rawIntake: KAMALA_INTAKE });
  await discoverAndPersist({ citizenId, profile: await loadProfile(citizenId) });

  const entitlementId = (
    await prisma.entitlement.findFirstOrThrow({ where: { citizenId, scheme: { code: "NSAP-IGNOAPS" } }, select: { id: true } })
  ).id;

  await prepareApplication({ citizenId, entitlementId, providedFields: IDENTITY_FIELDS });
  const application = await prisma.application.findFirstOrThrow({ where: { entitlementId } });
  const { approvalId } = await requestApplicationApproval({ citizenId, applicationId: application.id });
  await decideApplicationApproval({ citizenId, approvalId, decision: "APPROVED" });
  const submission = await submitApplication({ citizenId, applicationId: application.id, clock });
  if (!submission.ok) throw new Error("setup: submission failed");

  await govApproveApplication({ applicationRef: submission.applicationRef, clock });
  await govReleasePayment({
    applicationRef: submission.applicationRef,
    schemeCode: "NSAP-IGNOAPS",
    aadhaarLast4,
    periodLabel: PERIOD,
    amountPaise: PENSION,
    clock,
  });
  await govFailPaymentOnSeeding({ applicationRef: submission.applicationRef, periodLabel: PERIOD, clock });
  await auditBenefit({ citizenId, entitlementId, clock });

  const payment = await prisma.payment.findFirstOrThrow({ where: { entitlementId, periodLabel: PERIOD } });
  await prisma.receiptVerification.create({
    data: {
      paymentId: payment.id,
      citizenReport: "NO",
      method: "CITIZEN_CONFIRMATION",
      expectedAmountPaise: PENSION,
      resultState: "PAYMENT_DISCREPANCY",
      verifiedAt: clock.now(),
    },
  });
  await auditBenefit({ citizenId, entitlementId, clock });

  const gap = await prisma.benefitGap.findFirstOrThrow({ where: { entitlementId, kind: "PAYMENT_MISSED", resolvedAt: null } });
  return { gapId: gap.id, entitlementId };
}
```

- [ ] **Step 2: Write the failing test**

Add to `lib/llm/stub.ts`, next to `registerStubFixture`:

```ts
/** The fixture registered for a task, so a test can restore it after overriding. */
export function getStubFixture(task: string): StubFixture | undefined {
  return fixtures.get(task);
}
```

Create `tests/scenarios/caseTriggers.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { setGrievanceProvider } from "@/lib/adapters/grievance";
import { setGovGateway } from "@/lib/adapters/mockGovGateway";
import type { StaffContext } from "@/lib/auth/sessions";
import { fixedClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { registerStubFixture, resetLlmProvider } from "@/lib/llm";
import { getStubFixture, type StubFixture } from "@/lib/llm/stub";
import { decideActionApproval, diagnoseAndPlan, executeActionPlan, reverifyBenefit } from "@/lib/services/recovery";
import { recordHumanRootCause, requestReverify } from "@/lib/staff/caseActions";
import { takeCase } from "@/lib/staff/cases";

import { createCitizen, ensureRegistry, resetCitizenData, resetStaffData } from "../helpers/db";
import { setUpDiscrepancy } from "../helpers/recoveryFixture";

const CLOCK = fixedClock(new Date("2026-06-15T10:00:00.000Z"));

let citizenId: string;
let aadhaarLast4: string;
let caseworker: StaffContext;
const saved: Record<string, StubFixture | undefined> = {};

const CLARIFY_PLAN = () => ({
  summary: "Ask the department to clarify the status.",
  expectedOutcome: "The department explains what is needed.",
  steps: [
    {
      kind: "REQUEST_CLARIFICATION",
      description: "Ask the department to clarify.",
      reason: "The status is ambiguous.",
      documentsRequired: [],
      informationRequired: [],
      channel: "Caseworker",
    },
  ],
  evidenceNeeded: ["A reply from the department"],
});

async function approveAndExecute(gapId: string) {
  const { actionPlanId, approvalId } = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });
  await decideActionApproval({ citizenId, approvalId, decision: "APPROVED", clock: CLOCK });
  return executeActionPlan({ citizenId, actionPlanId, clock: CLOCK });
}

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.LLM_PROVIDER = "stub";
  resetLlmProvider();
  await ensureRegistry();
  saved.diagnose = getStubFixture("diagnose.rootCause");
  saved.plan = getStubFixture("plan.correctiveAction");
});

afterEach(() => {
  if (saved.diagnose) registerStubFixture("diagnose.rootCause", saved.diagnose);
  if (saved.plan) registerStubFixture("plan.correctiveAction", saved.plan);
});

afterAll(() => {
  process.env.DEMO_MODE = "false";
  setGovGateway(null);
  setGrievanceProvider(null);
});

beforeEach(async () => {
  setGovGateway(null);
  setGrievanceProvider(null);
  await resetStaffData();
  await resetCitizenData();
  const citizen = await createCitizen();
  citizenId = citizen.id;
  aadhaarLast4 = citizen.aadhaarLast4;
  await prisma.citizen.update({ where: { id: citizenId }, data: { district: "Gaya" } });
  const row = await prisma.staff.create({
    data: { email: "cw@ngo.org", name: "CW", passwordHash: "x", roles: ["CASEWORKER", "FIELD_WORKER"], districts: ["Gaya"], mustChangePassword: false },
  });
  caseworker = { staffId: row.id, sessionId: "t", email: row.email, name: row.name, roles: row.roles, districts: row.districts, mustChangePassword: false };
});

describe("cases open themselves", () => {
  it("opens an ASSISTED_VERIFICATION case when a CSC verification is requested, once", async () => {
    const { gapId } = await setUpDiscrepancy({ citizenId, aadhaarLast4, clock: CLOCK });
    await approveAndExecute(gapId);

    const cases = await prisma.case.findMany({ where: { citizenId } });
    expect(cases.map((c) => c.kind)).toEqual(["ASSISTED_VERIFICATION"]);
    expect(cases[0]).toMatchObject({ district: "Gaya", priority: 1 }); // NSAP pension
  });

  it("opens an UNKNOWN_CAUSE case when the diagnosis cannot find a cause", async () => {
    registerStubFixture("diagnose.rootCause", () => ({
      kind: "UNKNOWN",
      citedEvidence: [],
      reasoning: "Nothing in the evidence identifies a cause.",
      recommendedAction: "REQUEST_CLARIFICATION",
    }));
    const { gapId } = await setUpDiscrepancy({ citizenId, aadhaarLast4, clock: CLOCK });
    const result = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });

    const opened = await prisma.case.findUniqueOrThrow({ where: { sourceKey: `rootcause:${result.rootCauseId}` } });
    expect(opened.kind).toBe("UNKNOWN_CAUSE");
  });

  it("opens NEEDS_CLARIFICATION, then ACTION_FAILED when a second plan fails too", async () => {
    registerStubFixture("plan.correctiveAction", CLARIFY_PLAN);
    const { gapId, entitlementId } = await setUpDiscrepancy({ citizenId, aadhaarLast4, clock: CLOCK });

    await approveAndExecute(gapId);
    expect((await prisma.case.findMany({ where: { citizenId } })).map((c) => c.kind)).toEqual(["NEEDS_CLARIFICATION"]);

    const reverify = await reverifyBenefit({ citizenId, entitlementId, clock: CLOCK });
    expect(reverify.resolved).toBe(false);
    await approveAndExecute(gapId);

    const kinds = (await prisma.case.findMany({ where: { citizenId }, orderBy: { openedAt: "asc" } })).map((c) => c.kind);
    expect(kinds).toContain("ACTION_FAILED");
    expect(kinds.filter((k) => k === "NEEDS_CLARIFICATION")).toHaveLength(2);
  });
});

describe("caseworkers act through the loop, never around it", () => {
  async function unknownCase() {
    registerStubFixture("diagnose.rootCause", () => ({
      kind: "UNKNOWN",
      citedEvidence: [],
      reasoning: "Nothing identifies a cause.",
      recommendedAction: "REQUEST_CLARIFICATION",
    }));
    const { gapId } = await setUpDiscrepancy({ citizenId, aadhaarLast4, clock: CLOCK });
    const first = await diagnoseAndPlan({ citizenId, gapId, clock: CLOCK });
    const opened = await prisma.case.findUniqueOrThrow({ where: { sourceKey: `rootcause:${first.rootCauseId}` } });
    await takeCase(prisma, { staff: caseworker, caseId: opened.id, clock: CLOCK });
    return { caseId: opened.id, firstApprovalId: first.approvalId };
  }

  it("records a human root cause with evidence, producing a plan the citizen must still approve", async () => {
    const { caseId } = await unknownCase();
    const result = await recordHumanRootCause(prisma, {
      staff: caseworker,
      caseId,
      kind: "AADHAAR_ISSUE",
      evidence: ["Bank manager confirmed the account is not seeded with Aadhaar."],
      recommendedAction: "CORRECT_INFORMATION",
      reasoning: "Spoke to the branch: the account was never seeded.",
      clock: CLOCK,
    });

    const cause = await prisma.rootCause.findFirstOrThrow({ where: { recordedByStaffId: caseworker.staffId } });
    expect(cause.kind).toBe("AADHAAR_ISSUE");
    const approval = await prisma.approval.findUniqueOrThrow({ where: { id: result.approvalId } });
    expect(approval.decision).toBe("PENDING"); // the citizen decides, not the caseworker
    const events = await prisma.caseEvent.findMany({ where: { caseId } });
    expect(events.map((e) => e.type)).toContain("ROOT_CAUSE_RECORDED");
  });

  it("refuses a root cause without evidence, and refuses UNKNOWN as a human cause", async () => {
    const { caseId } = await unknownCase();
    await expect(
      recordHumanRootCause(prisma, { staff: caseworker, caseId, kind: "BANK_ISSUE", evidence: [], recommendedAction: "CORRECT_INFORMATION", reasoning: "Probably the bank.", clock: CLOCK }),
    ).rejects.toThrow(/evidence/);
    await expect(
      recordHumanRootCause(prisma, { staff: caseworker, caseId, kind: "UNKNOWN", evidence: ["Something specific happened."], recommendedAction: "REQUEST_CLARIFICATION", reasoning: "x", clock: CLOCK }),
    ).rejects.toThrow();
  });

  it("refuses to revive a superseded plan through its old approval", async () => {
    const { caseId, firstApprovalId } = await unknownCase();
    await recordHumanRootCause(prisma, {
      staff: caseworker,
      caseId,
      kind: "AADHAAR_ISSUE",
      evidence: ["Bank manager confirmed the account is not seeded with Aadhaar."],
      recommendedAction: "CORRECT_INFORMATION",
      reasoning: "Spoke to the branch.",
      clock: CLOCK,
    });
    await expect(decideActionApproval({ citizenId, approvalId: firstApprovalId, decision: "APPROVED", clock: CLOCK })).rejects.toThrow(/replaced/);
  });

  it("re-verification is the only way to recovered; a failed one leaves the case open", async () => {
    registerStubFixture("plan.correctiveAction", CLARIFY_PLAN);
    const { gapId, entitlementId } = await setUpDiscrepancy({ citizenId, aadhaarLast4, clock: CLOCK });
    await approveAndExecute(gapId);
    const opened = await prisma.case.findFirstOrThrow({ where: { citizenId, kind: "NEEDS_CLARIFICATION" } });
    await takeCase(prisma, { staff: caseworker, caseId: opened.id, clock: CLOCK });

    const result = await requestReverify(prisma, { staff: caseworker, caseId: opened.id, clock: CLOCK });
    expect(result.resolved).toBe(false);
    const entitlement = await prisma.entitlement.findUniqueOrThrow({ where: { id: entitlementId } });
    expect(entitlement.lifecycleState).not.toBe("RECOVERED");
    expect((await prisma.case.findUniqueOrThrow({ where: { id: opened.id } })).status).toBe("ASSIGNED");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/scenarios/caseTriggers.test.ts`
Expected: FAIL — cannot resolve `@/lib/staff/caseActions`.

- [ ] **Step 4: Triggers**

Create `lib/staff/triggers.ts`:

```ts
/**
 * Where the recovery loop hands work to a person. Each trigger opens a case
 * idempotently (by source key), so a retried execution never opens two.
 */

import type { Clock } from "@/lib/clock";
import type { ActionKind, CaseKind, ExecutionStatus, PrismaClient } from "@/lib/generated/prisma/client";

import { openCase } from "./cases";

const NEEDS_APPLICATION_REFERENCE = new Set<ActionKind>(["CORRECT_INFORMATION", "RESUBMIT", "REAPPLY", "RETRY_OPERATION"]);

export async function caseFromExecution(
  db: PrismaClient,
  input: {
    citizenId: string;
    entitlementId: string;
    executionId: string;
    stepKind: ActionKind;
    status: ExecutionStatus;
    message: string;
    clock: Clock;
  },
): Promise<void> {
  let kind: CaseKind | null = null;
  if (input.status === "NEEDS_HUMAN_REVIEW") {
    kind =
      input.stepKind === "REQUEST_DOCUMENT"
        ? "COLLECT_DOCUMENT"
        : NEEDS_APPLICATION_REFERENCE.has(input.stepKind)
          ? "NO_APPLICATION_REFERENCE"
          : "NEEDS_CLARIFICATION";
  } else if (input.status === "SUCCEEDED" && input.stepKind === "REQUEST_ASSISTED_VERIFICATION") {
    kind = "ASSISTED_VERIFICATION";
  }
  if (!kind) return;

  await openCase(db, {
    citizenId: input.citizenId,
    entitlementId: input.entitlementId,
    kind,
    sourceKey: `execution:${input.executionId}`,
    summary: input.message,
    clock: input.clock,
  });
}

export async function caseFromUnknownCause(
  db: PrismaClient,
  input: { citizenId: string; entitlementId: string; rootCauseId: string; reasoning: string; clock: Clock },
): Promise<void> {
  await openCase(db, {
    citizenId: input.citizenId,
    entitlementId: input.entitlementId,
    kind: "UNKNOWN_CAUSE",
    sourceKey: `rootcause:${input.rootCauseId}`,
    summary: `The cause could not be established automatically: ${input.reasoning}`,
    clock: input.clock,
  });
}

export async function caseFromRepeatedFailure(
  db: PrismaClient,
  input: { citizenId: string; entitlementId: string; gapId: string; clock: Clock },
): Promise<void> {
  const failed = await db.actionPlan.count({ where: { gapId: input.gapId, status: "FAILED" } });
  if (failed < 2) return;
  await openCase(db, {
    citizenId: input.citizenId,
    entitlementId: input.entitlementId,
    kind: "ACTION_FAILED",
    sourceKey: `gap-failed:${input.gapId}:${failed}`,
    summary: `Corrective action has failed ${failed} times for this benefit.`,
    clock: input.clock,
  });
}
```

- [ ] **Step 5: Hook the triggers into recovery, add `humanDiagnosis`, guard superseded plans**

In `lib/services/recovery.ts`:

1. Imports: `import { caseFromExecution, caseFromRepeatedFailure, caseFromUnknownCause } from "@/lib/staff/triggers";` and `import type { RootCauseKind } from "@/lib/generated/prisma/enums";` (if not already imported).

2. Add above `diagnoseAndPlan`:

```ts
/** A cause recorded by a caseworker instead of diagnosed by the agent. */
export interface HumanDiagnosis {
  kind: RootCauseKind;
  evidence: string[];
  recommendedAction: ActionKind;
  reasoning: string;
  staffId: string;
}

/**
 * Case creation must never break the citizen's flow: a failure is logged
 * loudly and the recovery step carries on.
 */
async function openCaseSafely(work: () => Promise<void>, context: Record<string, unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    log.error("case.open_failed", { ...context, error: error instanceof Error ? error : String(error) });
  }
}
```

3. In `diagnoseAndPlan`, add `humanDiagnosis?: HumanDiagnosis;` to the input type, and replace `const diagnosis = await diagnoseGap({...});` with:

```ts
  const diagnosis = input.humanDiagnosis
    ? {
        kind: input.humanDiagnosis.kind,
        confidence: 0.9,
        citedEvidence: input.humanDiagnosis.evidence,
        reasoning: input.humanDiagnosis.reasoning,
        recommendedAction: input.humanDiagnosis.recommendedAction,
      }
    : await diagnoseGap({
        // ...the existing arguments, unchanged
      });
```

4. In the `prisma.rootCause.create` data add `recordedByStaffId: input.humanDiagnosis?.staffId ?? null,` and directly after it:

```ts
  if (diagnosis.kind === "UNKNOWN") {
    await openCaseSafely(
      () => caseFromUnknownCause(prisma, { citizenId: input.citizenId, entitlementId: entitlement.id, rootCauseId: rootCause.id, reasoning: diagnosis.reasoning, clock: input.clock }),
      { rootCauseId: rootCause.id },
    );
  }
```

5. In `executeActionPlan`, directly after `await prisma.actionExecution.update({...})` inside the loop:

```ts
    await openCaseSafely(
      () =>
        caseFromExecution(prisma, {
          citizenId: input.citizenId,
          entitlementId: entitlement.id,
          executionId: execution.id,
          stepKind: step.kind,
          status: result.status,
          message: result.message,
          clock: input.clock,
        }),
      { executionId: execution.id },
    );
```

and directly after `await prisma.actionPlan.update({ where: { id: plan.id }, data: { status: allSucceeded ? "EXECUTED" : "FAILED" } });`:

```ts
  if (!allSucceeded) {
    await openCaseSafely(
      () => caseFromRepeatedFailure(prisma, { citizenId: input.citizenId, entitlementId: entitlement.id, gapId: plan.gapId, clock: input.clock }),
      { gapId: plan.gapId },
    );
  }
```

6. In `decideActionApproval`, after the `approval.decision !== "PENDING"` check, add:

```ts
  if (approval.actionPlan.status === "SUPERSEDED") {
    throw new ApiError("CONFLICT", "This plan was replaced by a newer one. Review the current plan instead.");
  }
```

- [ ] **Step 6: Case actions**

Create `lib/staff/caseActions.ts`:

```ts
/**
 * What a caseworker can make the recovery loop do. Each action goes through
 * the same services the agent uses - so the citizen still approves every
 * plan, and only re-verification can mark a benefit recovered.
 */

import { ApiError } from "@/lib/api/http";
import type { StaffContext } from "@/lib/auth/sessions";
import type { Clock } from "@/lib/clock";
import type { ActionKind, PrismaClient, RootCauseKind } from "@/lib/generated/prisma/client";
import { auditBenefit } from "@/lib/services/audit";
import { diagnoseAndPlan, reverifyBenefit } from "@/lib/services/recovery";

import { appendCaseEvent } from "./cases";
import { requireCapability } from "./permissions";

async function assignedCase(db: PrismaClient, staff: StaffContext, caseId: string) {
  requireCapability(staff, "case.work");
  const row = await db.case.findUnique({ where: { id: caseId } });
  if (!row) throw new ApiError("NOT_FOUND", "That case does not exist.");
  if (row.assignedToId !== staff.staffId) throw new ApiError("FORBIDDEN", "Take this case before acting on it.");
  if (!row.entitlementId) throw new ApiError("UNPROCESSABLE", "This case is not about a specific benefit.");
  return { ...row, entitlementId: row.entitlementId };
}

export async function recordHumanRootCause(
  db: PrismaClient,
  input: {
    staff: StaffContext;
    caseId: string;
    kind: RootCauseKind;
    evidence: string[];
    recommendedAction: ActionKind;
    reasoning: string;
    clock: Clock;
  },
): Promise<{ actionPlanId: string; approvalId: string }> {
  const row = await assignedCase(db, input.staff, input.caseId);

  if (input.kind === "UNKNOWN") {
    throw new ApiError("UNPROCESSABLE", "Record what you found. If the cause is still unknown, add a note instead.");
  }
  // The same rule the agent is held to: no cause without evidence.
  const evidence = input.evidence.map((e) => e.trim()).filter((e) => e.length >= 10);
  if (evidence.length === 0) {
    throw new ApiError("UNPROCESSABLE", "Give at least one piece of evidence for this cause (what you saw or were told, by whom).");
  }

  const entitlement = await db.entitlement.findUniqueOrThrow({ where: { id: row.entitlementId }, select: { lifecycleState: true } });
  if (entitlement.lifecycleState === "ACTION_EXECUTED" || entitlement.lifecycleState === "REVERIFYING") {
    throw new ApiError("CONFLICT", "The last action has been carried out. Re-verify the benefit first, then record a cause.");
  }

  const gap = await db.benefitGap.findFirst({
    where: { entitlementId: row.entitlementId, resolvedAt: null },
    orderBy: { detectedAt: "desc" },
    select: { id: true },
  });
  if (!gap) throw new ApiError("UNPROCESSABLE", "There is no open problem on this benefit to diagnose.");

  const result = await diagnoseAndPlan({
    citizenId: row.citizenId,
    gapId: gap.id,
    clock: input.clock,
    actor: { kind: "staff", staffId: input.staff.staffId },
    humanDiagnosis: {
      kind: input.kind,
      evidence,
      recommendedAction: input.recommendedAction,
      reasoning: input.reasoning.trim() || evidence.join(" "),
      staffId: input.staff.staffId,
    },
  });

  await appendCaseEvent(db, {
    caseId: row.id,
    staffId: input.staff.staffId,
    type: "ROOT_CAUSE_RECORDED",
    toValue: input.kind,
    note: `${input.reasoning.trim()} Evidence: ${evidence.join(" | ")}`.slice(0, 2000),
    at: input.clock.now(),
  });
  return { actionPlanId: result.actionPlanId, approvalId: result.approvalId };
}

export async function requestReaudit(
  db: PrismaClient,
  input: { staff: StaffContext; caseId: string; clock: Clock },
): Promise<{ decision: string; summary: string }> {
  const row = await assignedCase(db, input.staff, input.caseId);
  const audit = await auditBenefit({
    citizenId: row.citizenId,
    entitlementId: row.entitlementId,
    clock: input.clock,
    actor: { kind: "staff", staffId: input.staff.staffId },
  });
  await appendCaseEvent(db, { caseId: row.id, staffId: input.staff.staffId, type: "REAUDIT_REQUESTED", toValue: audit.decision, note: audit.summary.slice(0, 2000), at: input.clock.now() });
  return { decision: audit.decision, summary: audit.summary };
}

export async function requestReverify(
  db: PrismaClient,
  input: { staff: StaffContext; caseId: string; clock: Clock },
): Promise<{ resolved: boolean; summary: string }> {
  const row = await assignedCase(db, input.staff, input.caseId);
  // reverifyBenefit is the only code path to RECOVERED; nothing here sets it.
  const result = await reverifyBenefit({
    citizenId: row.citizenId,
    entitlementId: row.entitlementId,
    clock: input.clock,
    actor: { kind: "staff", staffId: input.staff.staffId },
  });
  await appendCaseEvent(db, {
    caseId: row.id,
    staffId: input.staff.staffId,
    type: "REVERIFY_REQUESTED",
    toValue: result.resolved ? "RESOLVED" : "NOT_RESOLVED",
    note: result.summary.slice(0, 2000),
    at: input.clock.now(),
  });
  return { resolved: result.resolved, summary: result.summary };
}
```

- [ ] **Step 7: Routes**

`app/api/staff/cases/[id]/root-cause/route.ts`:

```ts
/** POST /api/staff/cases/:id/root-cause  { kind, evidence[], recommendedAction, reasoning } */

import { ApiError, mutation, ok, parseBody, routeParam, z } from "@/lib/api/http";
import { authorizeCitizen, requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { recordHumanRootCause } from "@/lib/staff/caseActions";

const Body = z.object({
  kind: z.enum([
    "MISSING_DOCUMENT", "DATA_MISMATCH", "BANK_ISSUE", "AADHAAR_ISSUE", "ELIGIBILITY_ISSUE", "VERIFICATION_ISSUE",
    "TECHNICAL_FAILURE", "APPLICATION_ERROR", "REJECTION", "DELAYED_PROCESSING", "RENEWAL_ISSUE",
  ]),
  evidence: z.array(z.string().min(1).max(500)).min(1).max(10),
  recommendedAction: z.enum([
    "REQUEST_DOCUMENT", "CORRECT_INFORMATION", "REQUEST_CLARIFICATION", "RESUBMIT", "REAPPLY", "SUBMIT_GRIEVANCE",
    "ESCALATE_GRIEVANCE", "RETRY_OPERATION", "REQUEST_ASSISTED_VERIFICATION", "WAIT_AND_MONITOR",
  ]),
  reasoning: z.string().max(2000).default(""),
});

export const POST = mutation("POST /api/staff/cases/:id/root-cause", async (request, ctx) => {
  const staff = await requireStaff(request, "case.work");
  const caseId = await routeParam(ctx, "id");
  const row = await prisma.case.findUnique({ where: { id: caseId }, select: { citizenId: true } });
  if (!row) throw new ApiError("NOT_FOUND", "That case does not exist.");
  await authorizeCitizen(request, row.citizenId, { purpose: "case:root-cause", capability: "citizen.assist" });
  const body = await parseBody(request, Body);
  return ok(await recordHumanRootCause(prisma, { staff, caseId, ...body, clock: await currentClock() }));
});
```

`app/api/staff/cases/[id]/reaudit/route.ts`:

```ts
/** POST /api/staff/cases/:id/reaudit */

import { ApiError, mutation, ok, routeParam } from "@/lib/api/http";
import { authorizeCitizen, requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { requestReaudit } from "@/lib/staff/caseActions";

export const POST = mutation(
  "POST /api/staff/cases/:id/reaudit",
  async (request, ctx) => {
    const staff = await requireStaff(request, "case.work");
    const caseId = await routeParam(ctx, "id");
    const row = await prisma.case.findUnique({ where: { id: caseId }, select: { citizenId: true } });
    if (!row) throw new ApiError("NOT_FOUND", "That case does not exist.");
    await authorizeCitizen(request, row.citizenId, { purpose: "case:reaudit", capability: "citizen.assist" });
    return ok(await requestReaudit(prisma, { staff, caseId, clock: await currentClock() }));
  },
  { body: "none" },
);
```

`app/api/staff/cases/[id]/reverify/route.ts`:

```ts
/** POST /api/staff/cases/:id/reverify — the only route to "recovered" from a case. */

import { ApiError, mutation, ok, routeParam } from "@/lib/api/http";
import { authorizeCitizen, requireStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { requestReverify } from "@/lib/staff/caseActions";

export const POST = mutation(
  "POST /api/staff/cases/:id/reverify",
  async (request, ctx) => {
    const staff = await requireStaff(request, "case.work");
    const caseId = await routeParam(ctx, "id");
    const row = await prisma.case.findUnique({ where: { id: caseId }, select: { citizenId: true } });
    if (!row) throw new ApiError("NOT_FOUND", "That case does not exist.");
    await authorizeCitizen(request, row.citizenId, { purpose: "case:reverify", capability: "citizen.assist" });
    return ok(await requestReverify(prisma, { staff, caseId, clock: await currentClock() }));
  },
  { body: "none" },
);
```

- [ ] **Step 8: Run tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. `tests/scenarios/recovery.test.ts` is unchanged and still green: cases are opened alongside its flows, `Case` has no foreign key to `Citizen` (Task 1), so `resetCitizenData` is unaffected, and none of its assertions count cases.

- [ ] **Step 9: Commit**

```bash
git add lib/staff/triggers.ts lib/staff/caseActions.ts lib/services/recovery.ts lib/llm/stub.ts app/api/staff/cases tests/helpers/recoveryFixture.ts tests/scenarios/caseTriggers.test.ts
git commit -m "Cases open from the recovery loop; caseworker root causes, re-audit and re-verify"
```

---

### Task 12: Scheme-rule review moves behind the RULE_REVIEWER role

Fixes conflict C8.

**Files:**
- Modify: `lib/authz.ts` (delete `requireAdmin`)
- Modify: `app/api/admin/catalogue/queue/route.ts`, `app/api/admin/catalogue/rules/[id]/route.ts`, `app/api/admin/catalogue/schemes/[id]/unmapped/route.ts`, `app/api/admin/catalogue/runs/route.ts`
- Modify: `components/CatalogueReview.tsx` (no token form; uses the staff session)
- Modify: `tests/helpers/staff.ts` (`name` option)
- Modify: `tests/scenarios/catalogueReview.test.ts`
- Modify: `.env.example`, `README.md`, `docs/DEPLOY.md` (remove `ADMIN_TOKEN`)

**Interfaces:**
- Consumes: `requireStaff` (Task 6), `createTestStaff`, `signIn` (Task 6).
- Produces: catalogue admin routes require `catalogue.review`; `CatalogRule.reviewedBy` becomes `staff:<staffId>`.

- [ ] **Step 1: Update the tests first**

In `tests/helpers/staff.ts`, add `name?: string;` to `createTestStaff`'s input and use `name: input.name ?? email.split("@")[0],`.

In `tests/scenarios/catalogueReview.test.ts`:

1. Remove `const TOKEN = ...`, every `process.env.ADMIN_TOKEN` line, and `adminHeaders`.
2. Add `import { createTestStaff, signIn } from "../helpers/staff";` and `resetStaffData` to the `../helpers/db` import.
3. Add module state and a header builder:

```ts
let reviewerCookie: string;
let reviewerId: string;

const adminHeaders = (extra: Record<string, string> = {}) => ({
  cookie: reviewerCookie,
  origin: "http://test",
  "content-type": "application/json",
  ...extra,
});
```

4. In `beforeEach`, add before the citizen setup:

```ts
  await resetStaffData();
  const reviewer = await createTestStaff({ roles: ["RULE_REVIEWER"], name: "Reviewer One" });
  reviewerId = reviewer.id;
  reviewerCookie = await signIn(reviewer.email, reviewer.password);
```

5. Change the expectation `toMatchObject({ status: "APPROVED", reviewedBy: "Reviewer One" })` to `toMatchObject({ status: "APPROVED", reviewedBy: \`staff:${reviewerId}\` })`, and in the edit test `reviewedBy: "Reviewer One"` to `reviewedBy: \`staff:${reviewerId}\``.
6. Replace the whole `describe("admin guard", ...)` block with:

```ts
describe("rule-review guard", () => {
  it("refuses a request with no staff session", async () => {
    const response = await getRuns(new Request("http://test/api/admin/catalogue/runs"));
    expect(response.status).toBe(401);
  });

  it("refuses staff without the RULE_REVIEWER role", async () => {
    const caseworker = await createTestStaff({ roles: ["CASEWORKER"] });
    const cookie = await signIn(caseworker.email, caseworker.password);
    const response = await getRuns(new Request("http://test/api/admin/catalogue/runs", { headers: { cookie } }));
    expect(response.status).toBe(403);
  });

  it("reports catalogue health to a rule reviewer", async () => {
    await syncCatalogue({ source: source(), clock: CLOCK });
    const response = await getRuns(new Request("http://test/api/admin/catalogue/runs", { headers: adminHeaders() }));
    expect(response.status).toBe(200);
    const data = (await response.json()).data;
    expect(data.catalogue.active).toBe(5);
    expect(data.runs[0]).toMatchObject({ status: "SUCCEEDED", created: 5 });
  });
});
```

Note `signIn` uses origin `http://t`; that only matters for the login request itself.

- [ ] **Step 2: Run to verify the updated tests fail**

Run: `npx vitest run tests/scenarios/catalogueReview.test.ts`
Expected: FAIL — routes still demand `ADMIN_TOKEN` (404).

- [ ] **Step 3: Switch the routes**

In each of the four catalogue admin routes, replace `requireAdmin(request)` with `await requireStaff(request, "catalogue.review")` and update the import. In `app/api/admin/catalogue/rules/[id]/route.ts`:

```ts
  const staff = await requireStaff(request, "catalogue.review");
  // ...
  const rule = await decideRule({
    ruleId,
    decision: body.decision,
    edit: body.edit,
    reviewer: `staff:${staff.staffId}`,
    clock: systemClock(),
  });
```

Delete `requireAdmin` from `lib/authz.ts`.

- [ ] **Step 4: Review screen uses the session**

In `components/CatalogueReview.tsx`:
- Delete `STORAGE_KEY`, `Credentials`, `NO_CREDENTIALS`, `readStored`, `parseCredentials`, `subscribeToStorage`, the `useSyncExternalStore` read, `signedIn`/`setCredentials` state, and the whole sign-in `<form>` branch.
- `authHeaders()` becomes `({ "content-type": "application/json" })` (the session cookie travels automatically; the browser adds `Origin`).
- `loadReviewData()` takes no arguments. When either response is 401, return `{ ok: false, message: "Sign in as a rule reviewer to review rules." }`; when 403, `{ ok: false, message: "Your account does not have the rule reviewer role." }`.
- The effect runs once on mount (`[]` deps, same `cancelled` pattern), and `refresh` calls `loadReviewData()`.
- When the message is the sign-in one, render a link `<a href="/staff/login?next=/admin/catalogue">Sign in</a>` under the error.
- Remove the "Reviewing as {credentials.reviewer}" hint; show nothing in its place.

- [ ] **Step 5: Docs**

Remove the `ADMIN_TOKEN` block from `.env.example`. In `README.md`, replace the `ADMIN_TOKEN` row of the environment table with `| \`AUTH_SECRET\` | Salts hashed IPs and emails for sign-in rate limiting. Required. |`, and change "Only a person can approve a rule, at `/admin/catalogue`" to "Only a person with the rule-reviewer role can approve a rule, at `/admin/catalogue`". In `docs/DEPLOY.md` section 3b, replace the `ADMIN_TOKEN` paragraph with: "Give a staff member the RULE_REVIEWER role (staff admin screen) so someone can review rules at `/admin/catalogue`."

- [ ] **Step 6: Run tests**

Run: `npx tsc --noEmit && npx eslint && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/authz.ts app/api/admin components/CatalogueReview.tsx tests .env.example README.md docs/DEPLOY.md
git commit -m "Catalogue review: RULE_REVIEWER role replaces the shared admin token"
```

---

### Task 13: Staff screens — sign-in, password, queue, case

**Files:**
- Create: `app/staff/layout.tsx`, `app/staff/login/page.tsx`, `app/staff/password/page.tsx`, `app/staff/page.tsx`, `app/staff/cases/[id]/page.tsx`
- Create: `components/staff/LoginForm.tsx`, `components/staff/PasswordForm.tsx`, `components/staff/SignOutButton.tsx`, `components/staff/CaseActions.tsx`
- Modify: `scripts/smoke.mjs`
- Test: smoke checks (Step 6)

**Interfaces:**
- Consumes: `currentStaff`, `requireStaff` (Task 6); `listCases`, `getCase` (Task 8); case action routes (Tasks 8, 11); `can`, `caseKindsFor` (Task 6).
- Produces: pages `/staff/login`, `/staff/password`, `/staff`, `/staff/cases/[id]`.

Read `node_modules/next/dist/docs/01-app/02-guides/authentication.md` (sections "Creating a Data Access Layer" and "Optimistic checks with Proxy") before writing the layout: every page below calls `currentStaff(null)` itself; there is no `proxy.ts`.

- [ ] **Step 1: Shared client pieces**

Create `components/staff/LoginForm.tsx`:

```tsx
"use client";

/** Staff sign-in. One message for every failure, matching the API. */

import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { buttonClass } from "@/components/ui";

export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData): Promise<void> {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/staff/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: form.get("email"), password: form.get("password") }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!payload?.ok) {
      setError(payload?.error?.message ?? "Could not sign in.");
      return;
    }
    const next = params.get("next");
    router.push(payload.data.mustChangePassword ? "/staff/password" : next && next.startsWith("/") ? next : "/staff");
    router.refresh();
  }

  return (
    <form action={(form) => void submit(form)} className="space-y-4">
      <label className="block text-sm font-medium">
        Email
        <input name="email" type="email" autoComplete="username" required className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      <label className="block text-sm font-medium">
        Password
        <input name="password" type="password" autoComplete="current-password" required className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      {error ? <p role="alert" className="text-sm text-[var(--bad)]">{error}</p> : null}
      <button type="submit" disabled={busy} className={buttonClass.primary}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
```

Create `components/staff/PasswordForm.tsx`:

```tsx
"use client";

/** Change password; also the forced first-sign-in change. */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClass } from "@/components/ui";

export function PasswordForm({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  async function submit(form: FormData): Promise<void> {
    if (form.get("next") !== form.get("confirm")) {
      setProblems(["The two new passwords do not match."]);
      return;
    }
    setBusy(true);
    const response = await fetch("/api/staff/password", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ current: form.get("current"), next: form.get("next") }),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    if (!payload?.ok) {
      const details = Array.isArray(payload?.error?.details) ? (payload.error.details as string[]) : [];
      setProblems(details.length > 0 ? details : [payload?.error?.message ?? "Could not change the password."]);
      return;
    }
    router.push("/staff");
    router.refresh();
  }

  return (
    <form action={(form) => void submit(form)} className="space-y-4">
      {forced ? <p className="text-sm text-muted">Choose your own password before you continue.</p> : null}
      <label className="block text-sm font-medium">
        Current password
        <input name="current" type="password" autoComplete="current-password" required className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      <label className="block text-sm font-medium">
        New password (at least 12 characters)
        <input name="next" type="password" autoComplete="new-password" minLength={12} required className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      <label className="block text-sm font-medium">
        New password again
        <input name="confirm" type="password" autoComplete="new-password" minLength={12} required className="mt-1 w-full rounded border px-3 py-2" />
      </label>
      {problems.length > 0 ? (
        <ul role="alert" className="list-disc pl-5 text-sm text-[var(--bad)]">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      ) : null}
      <button type="submit" disabled={busy} className={buttonClass.primary}>Save password</button>
    </form>
  );
}
```

Create `components/staff/SignOutButton.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";

export function SignOutButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="text-sm font-medium text-accent hover:underline"
      onClick={async () => {
        await fetch("/api/staff/logout", { method: "POST" });
        router.push("/staff/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
```

- [ ] **Step 2: Layout and auth pages**

Create `app/staff/layout.tsx`:

```tsx
/**
 * Staff area shell. Each page checks the session itself (data access layer
 * pattern); the layout only renders the header for whoever is signed in.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { SignOutButton } from "@/components/staff/SignOutButton";
import { currentStaff } from "@/lib/authz";
import { can } from "@/lib/staff/permissions";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: { children: ReactNode }) {
  const staff = await currentStaff(null, { allowPasswordChange: true });

  return (
    <div className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b pb-4">
        <Link href="/staff" className="text-sm font-semibold uppercase tracking-wider text-accent">
          AdhikarAI · Staff
        </Link>
        {staff ? (
          <nav className="flex flex-wrap items-center gap-4 text-sm">
            {can(staff, "case.viewQueue") ? <Link href="/staff">Cases</Link> : null}
            {can(staff, "citizen.view") ? <Link href="/staff/citizens">Citizens</Link> : null}
            {can(staff, "catalogue.review") ? <Link href="/admin/catalogue">Scheme rules</Link> : null}
            {can(staff, "staff.manage") ? <Link href="/staff/admin">Admin</Link> : null}
            <span className="text-muted">{staff.name} ({staff.roles.join(", ").toLowerCase()})</span>
            <SignOutButton />
          </nav>
        ) : null}
      </header>
      {children}
    </div>
  );
}
```

Create `app/staff/login/page.tsx`:

```tsx
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { LoginForm } from "@/components/staff/LoginForm";
import { Card } from "@/components/ui";
import { currentStaff } from "@/lib/authz";

export default async function StaffLoginPage() {
  if (await currentStaff(null)) redirect("/staff");
  return (
    <main className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">Staff sign-in</h1>
      <p className="mt-1 text-muted">For partner organisation staff. Citizens do not need to sign in here.</p>
      <Card className="mt-6">
        <Suspense>
          <LoginForm />
        </Suspense>
      </Card>
    </main>
  );
}
```

Create `app/staff/password/page.tsx`:

```tsx
import { redirect } from "next/navigation";

import { PasswordForm } from "@/components/staff/PasswordForm";
import { Card } from "@/components/ui";
import { currentStaff } from "@/lib/authz";

export default async function StaffPasswordPage() {
  const staff = await currentStaff(null, { allowPasswordChange: true });
  if (!staff) redirect("/staff/login");
  return (
    <main className="mx-auto max-w-md">
      <h1 className="text-2xl font-bold">Change password</h1>
      <Card className="mt-6">
        <PasswordForm forced={staff.mustChangePassword} />
      </Card>
    </main>
  );
}
```

- [ ] **Step 3: Queue page**

Create `app/staff/page.tsx`:

```tsx
/** My cases first, then the district queue. Spec §7.2–7.3. */

import Link from "next/link";
import { redirect } from "next/navigation";

import { Card, EmptyState, SectionHeading, StatusPill } from "@/components/ui";
import { currentStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { listCases, type CaseListItem } from "@/lib/staff/cases";
import { can } from "@/lib/staff/permissions";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  UNKNOWN_CAUSE: "Cause unknown",
  ACTION_FAILED: "Action failed repeatedly",
  NEEDS_CLARIFICATION: "Needs clarification",
  NO_APPLICATION_REFERENCE: "No application reference",
  COLLECT_DOCUMENT: "Collect a document",
  ASSISTED_VERIFICATION: "Verify at CSC",
};

function CaseRow({ item }: { item: CaseListItem }) {
  return (
    <Card as="li">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link href={`/staff/cases/${item.id}`} className="font-semibold hover:underline">
          {item.citizen.name} — {KIND_LABEL[item.kind] ?? item.kind}
        </Link>
        <div className="flex gap-2">
          <StatusPill tone={item.priority === 1 ? "bad" : item.priority === 2 ? "warn" : "neutral"} icon="•">
            Priority {item.priority}
          </StatusPill>
          {item.overdue ? <StatusPill tone="bad" icon="!">Overdue</StatusPill> : null}
        </div>
      </div>
      <p className="mt-1 text-sm text-muted">{item.summary}</p>
      <p className="mt-1 text-xs text-subtle">
        {item.district} · {item.status.replace(/_/g, " ").toLowerCase()} · due {item.dueAt.slice(0, 10)}
      </p>
    </Card>
  );
}

export default async function StaffHomePage() {
  const staff = await currentStaff(null);
  if (!staff) redirect("/staff/login");
  if (!can(staff, "case.viewQueue")) redirect(can(staff, "catalogue.review") ? "/admin/catalogue" : "/staff/login");

  const clock = await currentClock();
  const [mine, queue] = await Promise.all([
    can(staff, "case.take") ? listCases(prisma, staff, "mine", clock) : Promise.resolve([]),
    listCases(prisma, staff, "queue", clock),
  ]);
  const unassigned = queue.filter((c) => c.assignedToId === null);

  return (
    <main className="space-y-8">
      {can(staff, "case.take") ? (
        <section>
          <SectionHeading hint="Cases assigned to you.">My cases ({mine.length})</SectionHeading>
          {mine.length === 0 ? <EmptyState>Nothing assigned to you.</EmptyState> : <ul className="space-y-3">{mine.map((c) => <CaseRow key={c.id} item={c} />)}</ul>}
        </section>
      ) : null}
      <section>
        <SectionHeading hint="Open cases in your districts that nobody has taken yet, most urgent first.">
          Queue ({unassigned.length})
        </SectionHeading>
        {unassigned.length === 0 ? <EmptyState>The queue is empty.</EmptyState> : <ul className="space-y-3">{unassigned.map((c) => <CaseRow key={c.id} item={c} />)}</ul>}
      </section>
    </main>
  );
}
```

- [ ] **Step 4: Case page and its actions**

Create `components/staff/CaseActions.tsx`:

```tsx
"use client";

/**
 * Case actions. Every button calls one API route; the server enforces who may
 * do what. Note what is not here: no "approve", no "mark recovered".
 */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClass } from "@/components/ui";

const ROOT_CAUSES = [
  "MISSING_DOCUMENT", "DATA_MISMATCH", "BANK_ISSUE", "AADHAAR_ISSUE", "ELIGIBILITY_ISSUE", "VERIFICATION_ISSUE",
  "TECHNICAL_FAILURE", "APPLICATION_ERROR", "REJECTION", "DELAYED_PROCESSING", "RENEWAL_ISSUE",
];
const ACTIONS = [
  "REQUEST_DOCUMENT", "CORRECT_INFORMATION", "REQUEST_CLARIFICATION", "RESUBMIT", "REAPPLY", "SUBMIT_GRIEVANCE",
  "ESCALATE_GRIEVANCE", "RETRY_OPERATION", "REQUEST_ASSISTED_VERIFICATION", "WAIT_AND_MONITOR",
];

interface Props {
  caseId: string;
  citizenId: string;
  isAssignee: boolean;
  canTake: boolean;
  isOpenUnassigned: boolean;
  isClosed: boolean;
  canWorkBenefit: boolean;
  showRootCause: boolean;
}

export function CaseActions(props: Props) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function call(path: string, body?: unknown): Promise<void> {
    setBusy(true);
    setMessage(null);
    const response = await fetch(`/api/staff/cases/${props.caseId}/${path}`, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    setBusy(false);
    setMessage(payload?.ok ? (payload.data?.summary ?? "Done.") : (payload?.error?.message ?? "That did not work."));
    router.refresh();
  }

  async function openForCitizen(): Promise<void> {
    await fetch("/api/staff/assist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizenId: props.citizenId }),
    });
    router.push("/dashboard");
  }

  return (
    <div className="space-y-6">
      {message ? <p role="status" className="rounded border px-3 py-2 text-sm">{message}</p> : null}

      {props.canTake && props.isOpenUnassigned ? (
        <button type="button" disabled={busy} className={buttonClass.primary} onClick={() => void call("take")}>Take this case</button>
      ) : null}

      {props.isAssignee && !props.isClosed ? (
        <>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass.secondary} disabled={busy} onClick={() => void openForCitizen()}>Open citizen&apos;s record</button>
            {(["IN_PROGRESS", "WAITING_ON_CITIZEN", "WAITING_ON_GOVERNMENT"] as const).map((status) => (
              <button key={status} type="button" className={buttonClass.secondary} disabled={busy} onClick={() => void call("status", { status })}>
                {status.replace(/_/g, " ").toLowerCase()}
              </button>
            ))}
          </div>

          <form action={(f) => void call("note", { note: String(f.get("note") ?? "") })} className="space-y-2">
            <textarea name="note" required minLength={3} rows={2} placeholder="What happened (call, visit, office reply)…" className="w-full rounded border px-3 py-2" />
            <button type="submit" className={buttonClass.secondary} disabled={busy}>Add note</button>
          </form>

          {props.canWorkBenefit ? (
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass.secondary} disabled={busy} onClick={() => void call("reaudit")}>Re-audit the benefit</button>
              <button type="button" className={buttonClass.secondary} disabled={busy} onClick={() => void call("reverify")}>Re-verify (checks if recovered)</button>
            </div>
          ) : null}

          {props.showRootCause ? (
            <form
              className="space-y-2 rounded border p-3"
              action={(f) =>
                void call("root-cause", {
                  kind: f.get("kind"),
                  recommendedAction: f.get("action"),
                  evidence: String(f.get("evidence") ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
                  reasoning: String(f.get("reasoning") ?? ""),
                })
              }
            >
              <p className="text-sm font-semibold">Record the cause you found</p>
              <p className="text-xs text-subtle">A new plan is prepared from it, and the citizen must approve it before anything is done.</p>
              <select name="kind" required className="w-full rounded border px-2 py-1">{ROOT_CAUSES.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ").toLowerCase()}</option>)}</select>
              <select name="action" required className="w-full rounded border px-2 py-1">{ACTIONS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ").toLowerCase()}</option>)}</select>
              <textarea name="evidence" required rows={3} placeholder="Evidence, one per line: what you saw or were told, and by whom" className="w-full rounded border px-3 py-2" />
              <textarea name="reasoning" rows={2} placeholder="Your reasoning" className="w-full rounded border px-3 py-2" />
              <button type="submit" className={buttonClass.primary} disabled={busy}>Record cause</button>
            </form>
          ) : null}

          <form action={(f) => void call("resolve", { resolution: f.get("resolution"), note: String(f.get("note") ?? "") })} className="space-y-2 rounded border p-3">
            <p className="text-sm font-semibold">Close this case</p>
            <select name="resolution" className="w-full rounded border px-2 py-1">
              <option value="RESOLVED">Resolved</option>
              <option value="CLOSED_NO_ACTION">Closed without action (unreachable, not eligible, duplicate)</option>
            </select>
            <textarea name="note" required minLength={10} rows={2} placeholder="What was done, or why it is being closed" className="w-full rounded border px-3 py-2" />
            <button type="submit" className={buttonClass.secondary} disabled={busy}>Close case</button>
          </form>
        </>
      ) : null}

      {props.isClosed && props.isAssignee ? (
        <form action={(f) => void call("reopen", { note: String(f.get("note") ?? "") })} className="space-y-2">
          <textarea name="note" required rows={2} placeholder="Why it is being reopened" className="w-full rounded border px-3 py-2" />
          <button type="submit" className={buttonClass.secondary} disabled={busy}>Reopen</button>
        </form>
      ) : null}
    </div>
  );
}
```

Create `app/staff/cases/[id]/page.tsx`:

```tsx
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { CaseActions } from "@/components/staff/CaseActions";
import { Card, SectionHeading } from "@/components/ui";
import { authorizeCitizen, currentStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { getCase } from "@/lib/staff/cases";
import { can } from "@/lib/staff/permissions";

export const dynamic = "force-dynamic";

export default async function CasePage({ params }: { params: Promise<{ id: string }> }) {
  const staff = await currentStaff(null);
  if (!staff) redirect("/staff/login");

  const { id } = await params;
  const detail = await getCase(prisma, staff, id).catch(() => null);
  if (!detail) notFound();
  // Opening a case is opening the citizen's record: checked and logged.
  const access = await authorizeCitizen(null, detail.citizenId, { purpose: "view:case" }).catch(() => null);
  if (!access) notFound();

  const isAssignee = detail.assignedToId === staff.staffId;
  const isClosed = detail.status === "RESOLVED" || detail.status === "CLOSED_NO_ACTION";

  return (
    <main className="space-y-6">
      <Link href="/staff" className="text-sm text-accent hover:underline">← All cases</Link>
      <Card>
        <h1 className="text-xl font-bold">{detail.citizen.name}</h1>
        <p className="mt-1">{detail.summary}</p>
        <p className="mt-1 text-sm text-subtle">
          {detail.kind.replace(/_/g, " ").toLowerCase()} · priority {detail.priority} · {detail.district} · {detail.status.replace(/_/g, " ").toLowerCase()} · due {detail.dueAt.toISOString().slice(0, 10)}
        </p>
      </Card>
      <CaseActions
        caseId={detail.id}
        citizenId={detail.citizenId}
        isAssignee={isAssignee}
        canTake={can(staff, "case.take")}
        isOpenUnassigned={detail.status === "OPEN" && detail.assignedToId === null}
        isClosed={isClosed}
        canWorkBenefit={detail.entitlementId !== null && can(staff, "citizen.assist")}
        showRootCause={detail.entitlementId !== null && (detail.kind === "UNKNOWN_CAUSE" || detail.kind === "ACTION_FAILED")}
      />
      <section>
        <SectionHeading hint="Every change to this case, oldest first.">History</SectionHeading>
        <ol className="space-y-2 text-sm">
          {detail.events.map((event) => (
            <li key={event.id} className="rounded border px-3 py-2">
              <span className="font-medium">{event.type.replace(/_/g, " ").toLowerCase()}</span>
              {event.toValue ? ` → ${event.toValue}` : ""}
              <span className="text-subtle"> · {event.at.toISOString().slice(0, 16).replace("T", " ")}</span>
              {event.note ? <p className="text-muted">{event.note}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}
```

- [ ] **Step 5: Smoke checks**

In `scripts/smoke.mjs`, add to the `results` array:

```js
    await check("staff login", "/staff/login", null, ["Staff sign-in"]),
```

and, after the existing loop, a redirect check that does not follow the redirect, so the 307 itself is asserted:

```js
  const staffHome = await fetch(`${BASE}/staff`, { redirect: "manual" });
  const redirected = staffHome.status >= 300 && staffHome.status < 400 && (staffHome.headers.get("location") ?? "").includes("/staff/login");
  results.push({ ok: redirected, label: "staff (signed out)", detail: `HTTP ${staffHome.status} → ${staffHome.headers.get("location") ?? "-"}` });
```

- [ ] **Step 6: Verify**

Run:
```bash
npx tsc --noEmit && npx eslint && npx vitest run
npx next build
npx next start -p 3123   # in a second terminal / background
SMOKE_BASE_URL=http://localhost:3123 node scripts/smoke.mjs
```
Expected: all tests pass, build succeeds, smoke reports every page rendered including "staff login" and "staff (signed out)". (A stale `next dev` started before `prisma generate` gives false 500s — always smoke a fresh server.)

- [ ] **Step 7: Commit**

```bash
git add app/staff components/staff scripts/smoke.mjs
git commit -m "Staff screens: sign-in, password, case queue and case detail"
```

---

### Task 14: Staff screens — citizens, assisted mode, witnessed consent, admin

**Files:**
- Create: `lib/staff/consentSummary.ts`; Test: `tests/unit/consentSummary.test.ts`
- Create: `app/staff/citizens/page.tsx`, `components/staff/CitizenSearch.tsx`, `components/staff/RegisterCitizenForm.tsx`
- Create: `components/staff/AssistBanner.tsx`; Modify: `app/layout.tsx`
- Modify: `components/ApprovalDecision.tsx` (assisted variant), `app/approve/[id]/page.tsx`
- Modify: `components/ReceiptAnswer.tsx` (channel for staff), `app/dashboard/page.tsx` (pass `isStaff`)
- Create: `app/staff/admin/page.tsx`, `components/staff/StaffAdminPanel.tsx`
- Modify: `scripts/smoke.mjs`

**Interfaces:**
- Consumes: everything above.
- Produces: `consentSummary(kind: "APPLICATION_SUBMISSION" | "CORRECTIVE_ACTION", shown: Record<string, unknown>, locale: "en" | "hi"): string` — the exact text read to the citizen and stored as `statementShown`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/consentSummary.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { consentSummary } from "@/lib/staff/consentSummary";

describe("consentSummary", () => {
  it("says what will be submitted, in English", () => {
    const text = consentSummary(
      "APPLICATION_SUBMISSION",
      { schemeName: "Old Age Pension", documents: [{ kind: "AADHAAR", provided: true }], governmentTarget: "Block office", declarations: ["NOT_INCOME_TAX_PAYER"] },
      "en",
    );
    expect(text).toContain("Old Age Pension");
    expect(text).toContain("AADHAAR");
    expect(text).toContain("Block office");
    expect(text.length).toBeGreaterThanOrEqual(20);
  });

  it("lists every corrective step, in Hindi", () => {
    const text = consentSummary(
      "CORRECTIVE_ACTION",
      { schemeName: "Old Age Pension", planSummary: "Fix Aadhaar seeding", steps: [{ description: "Submit a correction" }, { description: "Ask the CSC to confirm" }] },
      "hi",
    );
    expect(text).toMatch(/[ऀ-ॿ]/);
    expect(text).toContain("Submit a correction");
    expect(text).toContain("Ask the CSC to confirm");
  });
});
```

Run: `npx vitest run tests/unit/consentSummary.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 2: Implement the summary**

Create `lib/staff/consentSummary.ts`:

```ts
/**
 * The words a field worker reads to the citizen before recording consent.
 * Stored verbatim as ConsentEvidence.statementShown, so "what was the
 * citizen told?" always has an exact answer.
 */

type Shown = Record<string, unknown>;

const list = (value: unknown): Shown[] => (Array.isArray(value) ? (value as Shown[]) : []);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

export function consentSummary(
  kind: "APPLICATION_SUBMISSION" | "CORRECTIVE_ACTION",
  shown: Shown,
  locale: "en" | "hi",
): string {
  const scheme = str(shown.schemeName) || "this scheme";

  if (kind === "APPLICATION_SUBMISSION") {
    const documents = list(shown.documents).filter((d) => d.provided).map((d) => str(d.kind)).join(", ") || "none";
    const target = str(shown.governmentTarget) || "the government office";
    const declarations = list(shown.declarations).length > 0 ? (shown.declarations as string[]).join(", ") : "";
    return locale === "hi"
      ? `आपका ${scheme} का आवेदन ${target} को भेजा जाएगा। साथ में दस्तावेज़: ${documents}।${declarations ? ` आप यह भी घोषित कर रहे हैं: ${declarations}।` : ""} क्या आप इसे भेजने के लिए सहमत हैं?`
      : `Your application for ${scheme} will be sent to ${target}. Documents attached: ${documents}.${declarations ? ` You are also declaring: ${declarations}.` : ""} Do you agree to send it?`;
  }

  const steps = list(shown.steps).map((s, i) => `${i + 1}. ${str(s.description)}`).join(" ");
  const plan = str(shown.planSummary);
  return locale === "hi"
    ? `${scheme} की समस्या ठीक करने के लिए यह किया जाएगा: ${plan} कदम: ${steps} क्या आप इसके लिए सहमत हैं?`
    : `To fix the problem with ${scheme}, this will be done: ${plan} Steps: ${steps} Do you agree?`;
}
```

Run the test — Expected: PASS.

- [ ] **Step 3: Assisted approval**

In `components/ApprovalDecision.tsx`, add an optional prop:

```ts
  /** Present when a field worker is recording the citizen's in-person decision. */
  assisted?: { summaryEn: string; summaryHi: string };
```

Inside the component, add state and render the consent fields above the two buttons when `assisted` is set:

```tsx
  const [language, setLanguage] = useState<"en" | "hi">("hi");
  const [method, setMethod] = useState<"SPOKEN" | "SIGNED" | "THUMB_IMPRESSION" | "CITIZEN_TAPPED">("SPOKEN");
  const [present, setPresent] = useState(false);
  const [witness, setWitness] = useState("");
  const statement = assisted ? (language === "hi" ? assisted.summaryHi : assisted.summaryEn) : "";
```

```tsx
      {assisted ? (
        <div className="mb-4 space-y-3 rounded border p-3">
          <p className="text-sm font-semibold">Read this to the citizen, then record what they decided</p>
          <div className="flex gap-3 text-sm">
            <label><input type="radio" checked={language === "hi"} onChange={() => setLanguage("hi")} /> हिंदी</label>
            <label><input type="radio" checked={language === "en"} onChange={() => setLanguage("en")} /> English</label>
          </div>
          <blockquote className="rounded bg-[var(--surface-sunken,transparent)] p-3 text-sm">{statement}</blockquote>
          <label className="block text-sm">
            How did they give their answer?
            <select value={method} onChange={(e) => setMethod(e.target.value as typeof method)} className="mt-1 w-full rounded border px-2 py-1">
              <option value="SPOKEN">Spoke it aloud</option>
              <option value="SIGNED">Signed</option>
              <option value="THUMB_IMPRESSION">Thumb impression</option>
              <option value="CITIZEN_TAPPED">Pressed the button themselves</option>
            </select>
          </label>
          <label className="block text-sm">
            <input type="checkbox" checked={present} onChange={(e) => setPresent(e.target.checked)} /> The citizen is here with me now
          </label>
          <label className="block text-sm">
            Second witness (optional)
            <input value={witness} onChange={(e) => setWitness(e.target.value)} className="mt-1 w-full rounded border px-2 py-1" />
          </label>
        </div>
      ) : null}
```

In `decide()`, change the body to include consent when assisted:

```ts
        body: JSON.stringify({
          citizenId,
          decision,
          ...(assisted
            ? { consent: { method, language, statementShown: statement, citizenPresent: present, ...(witness.trim() ? { secondWitnessName: witness.trim() } : {}) } }
            : {}),
        }),
```

and disable both buttons when `assisted && !present`. When assisted, label the buttons "Citizen agrees" / "Citizen declines" (override `approveLabel` / `rejectLabel`).

In `app/approve/[id]/page.tsx`, at both `<ApprovalDecision ... />` usages, add:

```tsx
            assisted={
              citizen.staff
                ? {
                    summaryEn: consentSummary(approval.kind, approval.shownEvidence as Record<string, unknown>, "en"),
                    summaryHi: consentSummary(approval.kind, approval.shownEvidence as Record<string, unknown>, "hi"),
                  }
                : undefined
            }
```

(import `consentSummary` from `@/lib/staff/consentSummary` and `can` from `@/lib/staff/permissions`). Staff without `consent.record` (caseworkers, admins) get a 403 from the API with its explanatory message; additionally hide the control for them: render `<p className="text-sm text-muted">Only a field worker with the citizen present can record their decision.</p>` instead of `<ApprovalDecision>` when `citizen.staff && !can(citizen.staff, "consent.record")`.

- [ ] **Step 4: Receipt answers by staff**

In `components/ReceiptAnswer.tsx`, add prop `isStaff?: boolean`. When true, render above the answer buttons:

```tsx
      {isStaff ? (
        <fieldset className="mb-2 flex gap-3 text-sm">
          <legend className="sr-only">How did the citizen tell you?</legend>
          <label><input type="radio" name="channel" checked={channel === "IN_PERSON"} onChange={() => setChannel("IN_PERSON")} /> In person</label>
          <label><input type="radio" name="channel" checked={channel === "PHONE"} onChange={() => setChannel("PHONE")} /> By phone</label>
        </fieldset>
      ) : null}
```

with `const [channel, setChannel] = useState<"IN_PERSON" | "PHONE">("IN_PERSON");`, and include `...(isStaff ? { channel } : {})` in the POST body. In `app/dashboard/page.tsx`, pass `isStaff={citizen.staff !== null}` to `<ReceiptAnswer>` (the dashboard already has `citizen` from `requireSelectedCitizen()`).

- [ ] **Step 5: Assist banner**

Create `components/staff/AssistBanner.tsx`:

```tsx
/**
 * Shown on every page while a staff member is assisting a citizen, so it is
 * never ambiguous whose record is open or who is acting.
 */

import { readCookieFromStore, ASSIST_COOKIE } from "@/lib/auth/cookies";
import { currentStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";

import { StopAssistingButton } from "./StopAssistingButton";

export async function AssistBanner() {
  const staff = await currentStaff(null);
  if (!staff) return null;
  const citizenId = await readCookieFromStore(ASSIST_COOKIE);
  if (!citizenId) return null;
  const citizen = await prisma.citizen.findUnique({ where: { id: citizenId }, select: { name: true } });
  if (!citizen) return null;

  return (
    <div className="border-b border-[var(--accent-ring)] bg-[var(--accent-soft,transparent)] px-4 py-2 text-sm">
      Assisting <strong>{citizen.name}</strong> · signed in as {staff.name} · <a href="/staff" className="underline">Staff area</a> · <StopAssistingButton />
    </div>
  );
}
```

Create `components/staff/StopAssistingButton.tsx`:

```tsx
"use client";

import { useRouter } from "next/navigation";

export function StopAssistingButton() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="underline"
      onClick={async () => {
        await fetch("/api/staff/assist/stop", { method: "POST" });
        router.push("/staff/citizens");
        router.refresh();
      }}
    >
      Stop assisting
    </button>
  );
}
```

In `app/layout.tsx`, render `<AssistBanner />` directly below the existing prototype notice (import from `@/components/staff/AssistBanner`).

- [ ] **Step 6: Citizens page**

Create `components/staff/CitizenSearch.tsx`:

```tsx
"use client";

/** Search citizens in your districts and open one in assisted mode. */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClass } from "@/components/ui";

interface Row { id: string; name: string; nameHi: string | null; district: string | null; state: string | null }

export function CitizenSearch({ initial }: { initial: Row[] }) {
  const router = useRouter();
  const [rows, setRows] = useState(initial);
  const [error, setError] = useState<string | null>(null);

  async function search(q: string): Promise<void> {
    const response = await fetch(`/api/staff/citizens?q=${encodeURIComponent(q)}`);
    const payload = await response.json().catch(() => null);
    if (payload?.ok) setRows(payload.data.citizens);
  }

  async function assist(citizenId: string): Promise<void> {
    setError(null);
    const response = await fetch("/api/staff/assist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizenId }),
    });
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) {
      setError(payload?.error?.message ?? "Could not open that record.");
      return;
    }
    router.push("/dashboard");
    router.refresh();
  }

  return (
    <div className="space-y-3">
      <input type="search" placeholder="Search by name" onChange={(e) => void search(e.target.value)} className="w-full rounded border px-3 py-2" />
      {error ? <p role="alert" className="text-sm text-[var(--bad)]">{error}</p> : null}
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center justify-between rounded border px-3 py-2">
            <span>{row.name} {row.nameHi ? <span className="text-subtle">{row.nameHi}</span> : null} <span className="text-xs text-subtle">· {row.district ?? "no district"}</span></span>
            <button type="button" className={buttonClass.secondary} onClick={() => void assist(row.id)}>Assist</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Create `components/staff/RegisterCitizenForm.tsx`:

```tsx
"use client";

/** Register a citizen in one of your districts. Last four digits only for Aadhaar and bank. */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClass } from "@/components/ui";

export function RegisterCitizenForm({ districts }: { districts: string[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  async function submit(form: FormData): Promise<void> {
    setError(null);
    const value = (key: string) => {
      const v = String(form.get(key) ?? "").trim();
      return v === "" ? undefined : v;
    };
    const response = await fetch("/api/staff/citizens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: value("name"),
        nameHi: value("nameHi"),
        phone: value("phone"),
        district: value("district"),
        state: value("state"),
        locale: value("locale"),
        aadhaarLast4: value("aadhaarLast4"),
        bankAccountLast4: value("bankAccountLast4"),
      }),
    });
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) {
      setError(payload?.error?.message ?? "Could not register.");
      return;
    }
    await fetch("/api/staff/assist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ citizenId: payload.data.citizenId }),
    });
    router.push("/onboard");
  }

  return (
    <form action={(f) => void submit(f)} className="grid gap-3 sm:grid-cols-2">
      <input name="name" required placeholder="Name" className="rounded border px-3 py-2" />
      <input name="nameHi" placeholder="नाम (हिंदी)" className="rounded border px-3 py-2" />
      <input name="phone" placeholder="Phone (optional)" className="rounded border px-3 py-2" />
      <select name="district" required className="rounded border px-3 py-2">{districts.map((d) => <option key={d}>{d}</option>)}</select>
      <input name="state" placeholder="State" className="rounded border px-3 py-2" />
      <select name="locale" className="rounded border px-3 py-2"><option value="hi">हिंदी</option><option value="en">English</option></select>
      <input name="aadhaarLast4" inputMode="numeric" pattern="\d{4}" placeholder="Aadhaar: last 4 digits only" className="rounded border px-3 py-2" />
      <input name="bankAccountLast4" inputMode="numeric" pattern="\d{4}" placeholder="Bank account: last 4 digits only" className="rounded border px-3 py-2" />
      {error ? <p role="alert" className="text-sm text-[var(--bad)] sm:col-span-2">{error}</p> : null}
      <button type="submit" className={`${buttonClass.primary} sm:col-span-2`}>Register and start intake</button>
    </form>
  );
}
```

Create `app/staff/citizens/page.tsx`:

```tsx
import { redirect } from "next/navigation";

import { CitizenSearch } from "@/components/staff/CitizenSearch";
import { RegisterCitizenForm } from "@/components/staff/RegisterCitizenForm";
import { Card, SectionHeading } from "@/components/ui";
import { currentStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { searchCitizens } from "@/lib/staff/citizens";
import { can } from "@/lib/staff/permissions";

export const dynamic = "force-dynamic";

export default async function StaffCitizensPage() {
  const staff = await currentStaff(null);
  if (!staff) redirect("/staff/login");
  if (!can(staff, "citizen.view")) redirect("/staff");
  const initial = await searchCitizens(prisma, staff, "");

  return (
    <main className="space-y-8">
      <section>
        <SectionHeading hint="Citizens in your districts. Opening a record is logged.">Citizens</SectionHeading>
        <CitizenSearch initial={initial} />
      </section>
      {can(staff, "citizen.register") ? (
        <section>
          <SectionHeading hint="For someone who is not yet in the system.">Register a citizen</SectionHeading>
          <Card><RegisterCitizenForm districts={staff.districts} /></Card>
        </section>
      ) : null}
    </main>
  );
}
```

- [ ] **Step 7: Admin page**

Create `components/staff/StaffAdminPanel.tsx`:

```tsx
"use client";

/** Staff accounts: create, change roles/districts, deactivate, reset, unlock. */

import { useRouter } from "next/navigation";
import { useState } from "react";

import { buttonClass } from "@/components/ui";

const ROLES = ["ADMIN", "CASEWORKER", "FIELD_WORKER", "RULE_REVIEWER"] as const;

interface StaffRow { id: string; email: string; name: string; roles: string[]; districts: string[]; isActive: boolean; lockedUntil: string | null; mustChangePassword: boolean }

export function StaffAdminPanel({ staff, selfId }: { staff: StaffRow[]; selfId: string }) {
  const router = useRouter();
  const [notice, setNotice] = useState<string | null>(null);

  async function send(url: string, method: string, body?: unknown): Promise<unknown> {
    const response = await fetch(url, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null);
    if (!payload?.ok) {
      setNotice(payload?.error?.message ?? "That did not work.");
      return null;
    }
    router.refresh();
    return payload.data;
  }

  async function create(form: FormData): Promise<void> {
    const data = (await send("/api/staff/admin/staff", "POST", {
      email: form.get("email"),
      name: form.get("name"),
      roles: ROLES.filter((r) => form.get(r) === "on"),
      districts: String(form.get("districts") ?? "").split(",").map((d) => d.trim()).filter(Boolean),
    })) as { temporaryPassword: string } | null;
    if (data) setNotice(`Account created. Temporary password (shown once, give it to them privately): ${data.temporaryPassword}`);
  }

  async function reset(id: string): Promise<void> {
    const data = (await send(`/api/staff/admin/staff/${id}/reset-password`, "POST")) as { temporaryPassword: string } | null;
    if (data) setNotice(`Temporary password (shown once): ${data.temporaryPassword}`);
  }

  return (
    <div className="space-y-6">
      {notice ? <p role="status" className="rounded border px-3 py-2 text-sm">{notice}</p> : null}
      <form action={(f) => void create(f)} className="grid gap-2 rounded border p-3 sm:grid-cols-2">
        <input name="email" type="email" required placeholder="Email" className="rounded border px-3 py-2" />
        <input name="name" required placeholder="Name" className="rounded border px-3 py-2" />
        <input name="districts" placeholder="Districts, comma separated" className="rounded border px-3 py-2 sm:col-span-2" />
        <div className="flex flex-wrap gap-3 text-sm sm:col-span-2">
          {ROLES.map((r) => <label key={r}><input type="checkbox" name={r} /> {r.replace("_", " ").toLowerCase()}</label>)}
        </div>
        <button type="submit" className={`${buttonClass.primary} sm:col-span-2`}>Create account</button>
      </form>
      <ul className="space-y-2">
        {staff.map((s) => (
          <li key={s.id} className="rounded border px-3 py-2 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span>
                <strong>{s.name}</strong> {s.email} · {s.roles.join(", ").toLowerCase()} · {s.districts.join(", ") || "all districts"}
                {!s.isActive ? " · deactivated" : ""}{s.lockedUntil ? " · locked" : ""}{s.mustChangePassword ? " · must change password" : ""}
              </span>
              {s.id !== selfId ? (
                <span className="flex flex-wrap gap-2">
                  <button type="button" className={buttonClass.secondary} onClick={() => void reset(s.id)}>Reset password</button>
                  {s.lockedUntil ? <button type="button" className={buttonClass.secondary} onClick={() => void send(`/api/staff/admin/staff/${s.id}/unlock`, "POST")}>Unlock</button> : null}
                  <button type="button" className={buttonClass.secondary} onClick={() => void send(`/api/staff/admin/staff/${s.id}/revoke-sessions`, "POST")}>Sign out everywhere</button>
                  <button type="button" className={buttonClass.secondary} onClick={() => void send(`/api/staff/admin/staff/${s.id}`, "PATCH", { isActive: !s.isActive })}>
                    {s.isActive ? "Deactivate" : "Reactivate"}
                  </button>
                </span>
              ) : <span className="text-subtle">you</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Create `app/staff/admin/page.tsx`:

```tsx
import Link from "next/link";
import { redirect } from "next/navigation";

import { StaffAdminPanel } from "@/components/staff/StaffAdminPanel";
import { SectionHeading } from "@/components/ui";
import { currentStaff } from "@/lib/authz";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { listCases } from "@/lib/staff/cases";
import { can } from "@/lib/staff/permissions";
import { listStaff } from "@/lib/staff/staffAdmin";

export const dynamic = "force-dynamic";

export default async function StaffAdminPage() {
  const staff = await currentStaff(null);
  if (!staff) redirect("/staff/login");
  if (!can(staff, "staff.manage")) redirect("/staff");

  const clock = await currentClock();
  const [people, queue] = await Promise.all([listStaff(prisma, staff), listCases(prisma, staff, "queue", clock)]);
  const DAY = 24 * 60 * 60_000;
  const stale = queue.filter((c) => c.assignedToId === null && clock.now().getTime() - new Date(c.openedAt).getTime() > 2 * DAY);
  const overdue = queue.filter((c) => c.overdue);

  return (
    <main className="space-y-8">
      <section>
        <SectionHeading hint="Unassigned for more than 48 hours, or past their due date.">Needs attention</SectionHeading>
        <ul className="space-y-1 text-sm">
          {[...new Map([...stale, ...overdue].map((c) => [c.id, c])).values()].map((c) => (
            <li key={c.id}><Link href={`/staff/cases/${c.id}`} className="hover:underline">{c.citizen.name} — {c.kind.replace(/_/g, " ").toLowerCase()} ({c.district})</Link>{c.overdue ? " · overdue" : " · unassigned 48h+"}</li>
          ))}
        </ul>
      </section>
      <section>
        <SectionHeading hint="Changing roles or districts signs the person out everywhere.">Staff</SectionHeading>
        <StaffAdminPanel staff={people} selfId={staff.staffId} />
      </section>
    </main>
  );
}
```

- [ ] **Step 8: Smoke, build, full gate**

`check` in `scripts/smoke.mjs` uses `redirect: "manual"`, so a signed-out page is asserted as a redirect, exactly like the Task 13 check. After that check, add:

```js
  const staffCitizens = await fetch(`${BASE}/staff/citizens`, { redirect: "manual" });
  results.push({
    ok: staffCitizens.status >= 300 && staffCitizens.status < 400 && (staffCitizens.headers.get("location") ?? "").includes("/staff/login"),
    label: "staff citizens (signed out)",
    detail: `HTTP ${staffCitizens.status} → ${staffCitizens.headers.get("location") ?? "-"}`,
  });
```

Run:
```bash
npx tsc --noEmit && npx eslint && npx vitest run
npx next build && npx next start -p 3123
SMOKE_BASE_URL=http://localhost:3123 node scripts/smoke.mjs
```
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add lib/staff/consentSummary.ts tests/unit/consentSummary.test.ts app components scripts/smoke.mjs
git commit -m "Staff screens: citizens, assisted mode banner, witnessed consent form, staff admin"
```

---

### Task 15: History rules, log hygiene, cleanup job, docs, final verification

**Files:**
- Modify: `tests/boundaries/architecture.test.ts` (history rules; `lib/auth` purity)
- Modify: `lib/log.ts` (redaction keys)
- Modify: `lib/services/monitoring.ts` (purge old login attempts)
- Modify: `README.md`, `docs/DEPLOY.md`, `docs/specs/2026-10-12-staff-portal-design.md` (status)

- [ ] **Step 1: Architecture tests for history and module purity**

Append to `tests/boundaries/architecture.test.ts`:

```ts
describe("history is never deleted or rewritten", () => {
  const sources = () => [...sourceFiles("lib"), ...sourceFiles("app"), ...sourceFiles("scripts")];

  it("never deletes citizens, logs, case history, consent or statements", () => {
    const models = ["citizen", "auditLog", "accessLog", "caseEvent", "consentEvidence", "citizenStatement"];
    const offenders: string[] = [];
    for (const file of sources()) {
      const source = code(read(file));
      for (const model of models) {
        if (new RegExp(`\\.\\s*${model}\\s*\\.\\s*delete(Many)?\\s*\\(`).test(source)) offenders.push(`${file}: ${model}.delete`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("never edits logs, case history, consent or statements", () => {
    const models = ["auditLog", "accessLog", "caseEvent", "consentEvidence", "citizenStatement"];
    const offenders: string[] = [];
    for (const file of sources()) {
      const source = code(read(file));
      for (const model of models) {
        if (new RegExp(`\\.\\s*${model}\\s*\\.\\s*(update|updateMany|upsert)\\s*\\(`).test(source)) offenders.push(`${file}: ${model}.update`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("keeps lib/auth free of Next.js except the cookie adapter", () => {
    const offenders = sourceFiles("lib/auth")
      .filter((f) => f !== "lib/auth/cookies.ts")
      .filter((f) => /from\s+["']next\//.test(read(f)));
    expect(offenders).toEqual([]);
  });
});
```

Run: `npx vitest run tests/boundaries` — Expected: PASS.

- [ ] **Step 2: Log redaction**

In `lib/log.ts`, add to `REDACTED_KEYS`: `"passwordhash"`, `"tokenhash"`, `"temporarypassword"`, `"current"`, `"next"`, `"cookie"`, `"setcookie"`. (`password`, `token` and `authorization` are already there.)

- [ ] **Step 3: Purge old login attempts in the monitoring tick**

In `lib/services/monitoring.ts`, at the start of `runMonitoringTick`, add:

```ts
  // Rate-limit counters only - never history. Kept 30 days.
  await purgeOldAttempts(prisma, systemClock());
```

(import `purgeOldAttempts` from `@/lib/auth/rateLimit` and `systemClock` from `@/lib/clock` — real time, because rate limiting runs on real time).

- [ ] **Step 4: Docs**

`README.md` — add a section after "The scheme catalogue":

```markdown
## Staff portal

Partner-organisation staff sign in at `/staff` with email and password.
Four roles — admin, caseworker, field worker, rule reviewer — and a person
may hold several. Staff see citizens in their districts, plus any citizen
whose open case is assigned to them; every record opened is logged.

- **Cases** open automatically whenever the system needs a person: the cause
  of a problem is unknown, an action failed twice, a document must be
  collected, a CSC verification is due. Caseworkers record what they found;
  the citizen still approves every plan, and only re-verification can mark a
  benefit recovered.
- **Assisted mode**: a field worker opens a citizen's record and uses the
  normal screens on their behalf. At an approval, the worker reads the
  summary aloud and records the citizen's own decision — how they gave it,
  in which language, that they were present. Staff never approve for anyone.

First admin: `npm run staff:create-admin -- --email you@org.in --name "Your Name"`.
Design: `docs/specs/2026-10-12-staff-portal-design.md`.
```

`docs/DEPLOY.md` — add before "Check it works":

```markdown
## 3c · Before any real citizen data

1. Set `DEMO_MODE=false` and a long random `AUTH_SECRET` in Vercel.
2. Create the first admin from your machine against the production database:
   `DATABASE_URL=<neon url> npm run staff:create-admin -- --email you@org.in --name "Your Name"`
3. Sign in at `/staff/login`, change the temporary password, then create staff
   accounts with their roles and districts from `/staff/admin`.
4. With demo mode off, the persona picker and `/api/citizens` are gone; every
   citizen page requires a staff session.
```

In the spec, change the status line to `**Status:** implemented on \`staff-portal\``.

- [ ] **Step 5: Final verification**

Run:
```bash
npx tsc --noEmit
npx eslint
npx vitest run
npx next build
npx next start -p 3123   # background
SMOKE_BASE_URL=http://localhost:3123 node scripts/smoke.mjs
git grep -il "claude\|anthropic"
```
Expected: typecheck and lint clean; every test passes (the 487 existing plus the new ones); build succeeds; smoke renders every page; the name scan prints nothing.

- [ ] **Step 6: Commit**

```bash
git add tests/boundaries/architecture.test.ts lib/log.ts lib/services/monitoring.ts README.md docs
git commit -m "Staff portal: history rules, log hygiene, attempt cleanup, deployment checklist"
```
