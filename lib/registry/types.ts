/**
 * Scheme registry types.
 *
 * The registry is the grounding for entitlement discovery. The LLM never
 * recalls scheme rules from memory and never searches for them: it reasons
 * over clauses handed to it from here, and the *verdict* is computed by
 * lib/engine/rules.ts, not by the model.
 *
 * Every clause carries its own source URL and verification date. That is a
 * hard requirement (spec section 28), not documentation: a benefit decision a
 * citizen cannot trace back to an official rule is not auditable.
 *
 * ---------------------------------------------------------------------------
 * DATA PROVENANCE WARNING
 * ---------------------------------------------------------------------------
 * This registry is CURATED FOR A PROTOTYPE. The amounts and conditions were
 * compiled from official scheme documentation and are accurate to the best of
 * our knowledge at `lastVerified`, but they are a point-in-time snapshot
 * maintained by hand, not a live feed.
 *
 * Scheme rules change. State top-ups vary widely and are generally NOT
 * modelled here; cash figures are central assistance unless stated otherwise.
 * Before this is used for real benefit decisions, every clause must be
 * re-verified against its `sourceUrl`, and the registry should be replaced by
 * an official data source (myScheme / API Setu) behind
 * lib/adapters/govGateway.ts. No official API endpoint is invented anywhere in
 * this codebase.
 */

import type {
  BenefitFrequency,
  BenefitType,
  ClauseKind,
  DocumentKind,
  GovernmentLevel,
} from "@/lib/generated/prisma/enums";

/**
 * The canonical set of citizen profile attributes that clauses may test.
 *
 * A closed union rather than `string`, so a clause cannot reference a field the
 * profile agent never populates. Adding a clause for a new attribute requires
 * adding it here, which forces the extraction side to be updated too.
 */
export type ProfileFieldKey =
  // Identity and demography
  | "age"
  | "gender"
  | "state"
  | "district"
  | "ruralUrban"
  | "socialCategory"
  | "maritalStatus"
  | "isWidow"
  // Economic
  | "annualIncomeRupees"
  | "occupation"
  | "employmentStatus"
  | "hasBplCard"
  | "rationCardType"
  | "householdSize"
  // Land and housing
  | "isFarmer"
  | "landHoldingHectares"
  | "housingType"
  | "hasPuccaHouse"
  | "seccDeprivationCriteria"
  // Disability and health
  | "disabilityPercent"
  // Maternity
  | "isPregnantOrLactating"
  | "livingChildrenCount"
  | "isFirstLivingChild"
  // Occupational / scheme-specific
  | "isArtisan"
  | "artisanTrade"
  | "hasJobCard"
  // Banking and identity linkage
  | "hasBankAccount"
  | "isAadhaarLinkedToBank"
  // Statutory exclusions
  | "isIncomeTaxPayer"
  | "isGovernmentEmployee"
  | "isInstitutionalLandholder"
  | "monthlyPensionRupees"
  | "isProfessional";

/**
 * Comparison operators available to a clause.
 *
 * Deliberately small and total: each is a pure, decidable check over a single
 * profile value, which is what lets the engine return a three-valued result
 * (SATISFIED / VIOLATED / UNKNOWN) without ever consulting a model.
 */
export type ClauseOperator =
  | "gte"
  | "lte"
  | "gt"
  | "lt"
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "between"
  | "exists"
  | "is_true"
  | "is_false";

/** A single eligibility, exclusion or dependency condition. */
export interface ClauseSpec {
  /** Stable code, unique within the scheme, e.g. "AGE_60_PLUS". */
  code: string;
  kind: ClauseKind;
  field: ProfileFieldKey;
  op: ClauseOperator;
  /** Comparison operand. `between` takes a two-element tuple; `exists` takes null. */
  value: unknown;
  /**
   * Whether the clause must hold for eligibility.
   *
   * A violated mandatory clause makes the verdict RED. An unknown mandatory
   * clause makes it YELLOW and is reported as missing evidence. Non-mandatory
   * clauses inform ranking but never block.
   */
  mandatory: boolean;
  /** Documents that would move this clause to DOCUMENT_VERIFIED provenance. */
  evidenceDocs: DocumentKind[];
  /** The official condition, worded closely to the source. Shown in "Why?". */
  text: string;
  textHi?: string;
  sourceName: string;
  sourceUrl: string;
  /** ISO date (YYYY-MM-DD) this clause was last checked against its source. */
  lastVerified: string;
}

/**
 * How well a registry record's provenance is actually established.
 *
 * This exists so the registry cannot overstate its own reliability. A record
 * compiled from documentation knowledge and one checked against its source URL
 * on a given date are different things, and the UI shows the difference rather
 * than presenting both as equally authoritative.
 */
export type VerificationStatus =
  /** Checked against `sourceUrl` on `lastVerified`. */
  | "SOURCE_CHECKED"
  /** Compiled from official documentation but not re-checked at the URL. */
  | "COMPILED_UNVERIFIED";

/** A field the Application Agent pre-fills, validated by the engine. */
export interface FormFieldSpec {
  key: string;
  label: string;
  labelHi?: string;
  type: "text" | "number" | "date" | "select" | "boolean";
  required: boolean;
  /** Profile key this is pre-filled from, when one maps directly. */
  fromProfileField?: ProfileFieldKey;
  options?: string[];
  /** Human-readable rule, e.g. "11-digit account number". */
  validation?: string;
}

/** A scheme and its full rule set. */
export interface SchemeSpec {
  code: string;
  name: string;
  nameHi?: string;
  governmentLevel: GovernmentLevel;
  /** Empty means applicable across India. */
  states: string[];
  category: string;
  description: string;
  descriptionHi?: string;

  benefitType: BenefitType;
  /**
   * Cash value in RUPEES, converted to paise at seed time.
   *
   * Null for in-kind or variable benefits, where `benefitNote` explains what
   * the citizen actually receives. Null here is "not a fixed cash amount", and
   * must never be rendered as zero.
   */
  benefitAmountRupees: number | null;
  benefitNote?: string;

  frequency: BenefitFrequency;
  durationMonths?: number;
  installmentsPerYear?: number;
  /**
   * True when the benefit amount is paid out in several unequal stages
   * (PMMVY: 1,000 then 2,000 then 2,000; PMAY-G: tied to construction
   * milestones).
   *
   * Without this, the first stage was reconciled against the WHOLE amount,
   * and the remainder - not yet due - was reported as proven missing money.
   * For a staged benefit each disbursement is reconciled against what the
   * government says that stage was, so a shortfall can only be established
   * by the citizen or by evidence, never by arithmetic against the total.
   */
  paidInStages?: boolean;

  applicationMethod: string;
  applicationUrl?: string;

  formSchema: FormFieldSpec[];
  requiredDocuments: DocumentKind[];

  sourceName: string;
  sourceUrl: string;
  lastVerified: string;
  verificationStatus: VerificationStatus;

  clauses: ClauseSpec[];
}
