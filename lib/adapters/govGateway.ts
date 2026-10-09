/**
 * The government gateway interface.
 *
 * Every read of or write to the government's side of the world goes through
 * here. That boundary is the architecture expressing the product's central
 * claim: what the government believes and what the citizen experiences are
 * different things, held in physically separate stores, and only reconciled
 * deliberately.
 *
 * Practical consequences:
 *
 *   - The engine and the agents cannot query `gov_*` tables. A boundary test
 *     enforces it, so the separation cannot erode through one convenient
 *     import.
 *   - Replacing the mock with a real portal or API Setu integration means
 *     implementing this interface in one new file. Nothing upstream changes.
 *   - Every result is explicitly labelled with its provenance via `isMock`, so
 *     the UI can state plainly that a status came from a simulation. Passing
 *     mock data off as a real government record is the one thing this
 *     boundary must never permit.
 *
 * NO REAL GOVERNMENT API ENDPOINT IS INVENTED ANYWHERE IN THIS CODEBASE. The
 * only implementation is a clearly-labelled simulation.
 */

import type {
  GovApplicationStatus,
  GovDisbursementStatus,
} from "@/lib/generated/prisma/enums";

/** How the government identifies a citizen: by partial Aadhaar, as a portal would. */
export interface GovCitizenRef {
  schemeCode: string;
  aadhaarLast4: string;
}

export interface SubmitApplicationInput extends GovCitizenRef {
  /**
   * Caller-supplied key making submission idempotent (spec section 40).
   * Re-submitting with the same key must not create a second application.
   */
  idempotencyKey: string;
  fields: Record<string, unknown>;
  /** Document kinds attached, by name. Never document bytes. */
  documents: string[];
  /** Exclusion clauses the citizen affirmed at approval. */
  declarations: string[];
  submittedAt: Date;
}

export type SubmitApplicationResult =
  | {
      ok: true;
      applicationRef: string;
      status: GovApplicationStatus;
      receivedOn: Date;
      /** True when an existing application was returned instead of a new one. */
      deduplicated: boolean;
    }
  | {
      ok: false;
      /**
       * Why it failed. Each maps to a distinct recovery path, so they must not
       * be collapsed into a generic error: a portal outage should be retried,
       * a validation rejection needs the form corrected, and a duplicate means
       * the citizen already has an application to look at.
       */
      reason:
        | "PORTAL_UNAVAILABLE"
        | "VALIDATION_REJECTED"
        | "DUPLICATE_APPLICATION"
        | "SCHEME_NOT_FOUND";
      message: string;
      /** Present for DUPLICATE_APPLICATION, pointing at the existing one. */
      applicationRef?: string;
      fieldErrors?: Array<{ field: string; message: string }>;
    };

export interface GovStatusEventRecord {
  status: string;
  note: string;
  occurredOn: Date;
}

export interface GovApplicationStatusResult {
  applicationRef: string;
  schemeCode: string;
  status: GovApplicationStatus;
  receivedOn: Date;
  decidedOn: Date | null;
  rejectionReason: string | null;
  pendingDocument: string | null;
  /** Chronological status history, which is the evidence root-cause reads. */
  events: GovStatusEventRecord[];
}

export interface GovDisbursementRecord {
  disbursementRef: string;
  applicationRef: string;
  schemeCode: string;
  periodLabel: string;
  /** What the government says it released, in paise. */
  amountPaise: bigint;
  releasedOn: Date;
  channel: string;
  bankAccountLast4: string | null;
  status: GovDisbursementStatus;
  failureReason: string | null;
}

export interface CorrectInformationInput extends GovCitizenRef {
  applicationRef: string;
  idempotencyKey: string;
  /** Which fields to correct, and to what. */
  corrections: Record<string, unknown>;
  reason: string;
  /** When the correction is made. Supplied, never read from the record. */
  requestedAt: Date;
}

export interface SubmitDocumentInput extends GovCitizenRef {
  applicationRef: string;
  idempotencyKey: string;
  documentKind: string;
  /** Hash only. Document bytes never cross this boundary. */
  documentSha256: string;
  /** When the document is supplied. */
  requestedAt: Date;
}

export type GovOperationResult =
  | { ok: true; reference: string; acceptedOn: Date; note: string }
  | {
      ok: false;
      reason: "PORTAL_UNAVAILABLE" | "NOT_FOUND" | "REJECTED";
      message: string;
    };

/**
 * The government side of the world.
 *
 * Read operations return `null` for "no such record", which is distinct from
 * an empty list meaning "the record exists and has nothing in it". A caller
 * must be able to tell "the portal has no application" from "the application
 * exists and has no disbursements yet", because those lead to different
 * diagnoses.
 */
export interface GovGateway {
  readonly name: string;
  /** True when results are simulated. Surfaced in the UI, never hidden. */
  readonly isMock: boolean;

  submitApplication(input: SubmitApplicationInput): Promise<SubmitApplicationResult>;

  getApplicationStatus(
    applicationRef: string,
  ): Promise<GovApplicationStatusResult | null>;

  /**
   * Disbursements recorded against one of OUR applications.
   *
   * Deliberately keyed by application reference only. An earlier version also
   * offered lookups by scheme and the last four digits of Aadhaar; four digits
   * identify one person in ten thousand, so in any real caseload that would
   * have attached another citizen's payments to this one.
   */
  listDisbursements(ref: { applicationRef: string }): Promise<GovDisbursementRecord[]>;

  correctInformation(input: CorrectInformationInput): Promise<GovOperationResult>;

  submitDocument(input: SubmitDocumentInput): Promise<GovOperationResult>;
}
