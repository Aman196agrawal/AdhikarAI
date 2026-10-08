/**
 * Profile field specifications.
 *
 * The deterministic contract for every citizen attribute a rule may test:
 * its type, its permitted values, and its plausible range. This is the layer
 * that validates model output (spec section 31).
 *
 * Why it matters: an extraction model asked for a citizen's age can return
 * `"67 years"`, `67.0`, `"sixty-seven"` or `670`. Passing any of those into
 * the rule engine would decide a pension on a misread value. Everything the
 * model extracts is coerced and range-checked here first, and anything that
 * fails is DROPPED and reported as a conflict rather than guessed at.
 *
 * Dropping is the right failure mode: a missing field yields a YELLOW verdict
 * and a request for evidence, which is recoverable. A wrong field yields a
 * confident GREEN or RED, which is not.
 */

import type { ProfileFieldKey } from "@/lib/registry/types";

export interface FieldSpec {
  type: "number" | "string" | "boolean";
  /** Permitted values for an enumerated field, compared case-insensitively. */
  domain?: readonly string[];
  /** Inclusive plausible bounds for a numeric field. */
  min?: number;
  max?: number;
  /** Whether the value must be a whole number. */
  integer?: boolean;
  label: string;
  labelHi?: string;
  /** The question to ask when this field is missing and a rule needs it. */
  question: string;
  questionHi?: string;
}

export const RURAL_URBAN = ["rural", "urban"] as const;
export const GENDERS = ["female", "male", "other"] as const;
export const SOCIAL_CATEGORIES = ["GENERAL", "OBC", "SC", "ST"] as const;
export const MARITAL_STATUSES = [
  "SINGLE",
  "MARRIED",
  "WIDOWED",
  "DIVORCED",
  "SEPARATED",
] as const;
export const RATION_CARD_TYPES = ["AAY", "PHH", "NON_NFSA", "NONE"] as const;
export const HOUSING_TYPES = [
  "HOUSELESS",
  "KUCCHA",
  "SEMI_PUCCA",
  "PUCCA",
] as const;
export const EMPLOYMENT_STATUSES = [
  "SELF_EMPLOYED",
  "CASUAL_LABOUR",
  "SALARIED_INFORMAL",
  "SALARIED_FORMAL",
  "GOVERNMENT_SERVICE",
  "UNEMPLOYED",
  "RETIRED",
] as const;
export const ARTISAN_TRADES = [
  "CARPENTER",
  "BOAT_MAKER",
  "ARMOURER",
  "BLACKSMITH",
  "HAMMER_TOOLKIT_MAKER",
  "LOCKSMITH",
  "GOLDSMITH",
  "POTTER",
  "SCULPTOR",
  "COBBLER",
  "MASON",
  "BASKET_WEAVER",
  "DOLL_TOY_MAKER",
  "BARBER",
  "GARLAND_MAKER",
  "WASHERMAN",
  "TAILOR",
  "FISHING_NET_MAKER",
] as const;

export const PROFILE_FIELD_SPECS: Record<ProfileFieldKey, FieldSpec> = {
  age: {
    type: "number",
    // 120 is a deliberate sanity bound: an extraction returning 670 from
    // "67 years 0 months" must be rejected, not used to deny a pension.
    min: 0,
    max: 120,
    integer: true,
    label: "Age",
    labelHi: "उम्र",
    question: "How old are you?",
    questionHi: "आपकी उम्र क्या है?",
  },
  gender: {
    type: "string",
    domain: GENDERS,
    label: "Gender",
    question: "What is your gender?",
  },
  state: {
    type: "string",
    label: "State",
    labelHi: "राज्य",
    question: "Which state do you live in?",
    questionHi: "आप किस राज्य में रहते हैं?",
  },
  district: {
    type: "string",
    label: "District",
    labelHi: "जिला",
    question: "Which district do you live in?",
  },
  ruralUrban: {
    type: "string",
    domain: RURAL_URBAN,
    label: "Rural or urban",
    question: "Do you live in a village or in a town or city?",
    questionHi: "आप गाँव में रहते हैं या शहर में?",
  },
  socialCategory: {
    type: "string",
    domain: SOCIAL_CATEGORIES,
    label: "Social category",
    question: "Which social category do you belong to?",
  },
  maritalStatus: {
    type: "string",
    domain: MARITAL_STATUSES,
    label: "Marital status",
    question: "What is your marital status?",
  },
  isWidow: {
    type: "boolean",
    label: "Widow",
    question: "Are you a widow?",
  },
  annualIncomeRupees: {
    type: "number",
    min: 0,
    max: 100_000_000,
    label: "Annual family income",
    labelHi: "वार्षिक पारिवारिक आय",
    question: "Roughly what is your family's total income in a year?",
  },
  occupation: {
    type: "string",
    label: "Occupation",
    labelHi: "व्यवसाय",
    question: "What work do you do?",
    questionHi: "आप क्या काम करते हैं?",
  },
  employmentStatus: {
    type: "string",
    domain: EMPLOYMENT_STATUSES,
    label: "Employment status",
    question: "How would you describe your employment?",
  },
  hasBplCard: {
    type: "boolean",
    label: "Below Poverty Line card",
    question: "Do you have a BPL card?",
    questionHi: "क्या आपके पास बीपीएल कार्ड है?",
  },
  rationCardType: {
    type: "string",
    domain: RATION_CARD_TYPES,
    label: "Ration card type",
    question: "What kind of ration card do you have?",
  },
  householdSize: {
    type: "number",
    min: 1,
    max: 30,
    integer: true,
    label: "Household size",
    question: "How many people live in your household?",
  },
  isFarmer: {
    type: "boolean",
    label: "Farmer",
    question: "Do you farm land?",
    questionHi: "क्या आप खेती करते हैं?",
  },
  landHoldingHectares: {
    type: "number",
    min: 0,
    max: 1000,
    label: "Land holding (hectares)",
    question: "How much land do you own, in acres or hectares?",
  },
  housingType: {
    type: "string",
    domain: HOUSING_TYPES,
    label: "Housing type",
    question: "What kind of house do you live in?",
  },
  hasPuccaHouse: {
    type: "boolean",
    label: "Owns a pucca house",
    question: "Do you own a pucca (permanent) house?",
  },
  seccDeprivationCriteria: {
    type: "string",
    label: "SECC deprivation category",
    question: "Is your household listed in the SECC deprivation list?",
  },
  disabilityPercent: {
    type: "number",
    min: 0,
    max: 100,
    label: "Disability percentage",
    question: "Do you have a disability certificate, and what percentage does it state?",
  },
  isPregnantOrLactating: {
    type: "boolean",
    label: "Pregnant or lactating",
    question: "Are you currently pregnant or breastfeeding?",
  },
  livingChildrenCount: {
    type: "number",
    min: 0,
    max: 20,
    integer: true,
    label: "Living children",
    question: "How many living children do you have?",
  },
  isFirstLivingChild: {
    type: "boolean",
    label: "First living child",
    question: "Is this your first living child?",
  },
  isArtisan: {
    type: "boolean",
    label: "Traditional artisan",
    question: "Do you work as a traditional craftsperson or artisan?",
  },
  artisanTrade: {
    type: "string",
    domain: ARTISAN_TRADES,
    label: "Artisan trade",
    question: "Which craft or trade do you work in?",
  },
  hasJobCard: {
    type: "boolean",
    label: "MGNREGA job card",
    question: "Do you have a MGNREGA job card?",
  },
  hasBankAccount: {
    type: "boolean",
    label: "Bank account",
    question: "Do you have a bank or post office account?",
    questionHi: "क्या आपका बैंक या डाकघर में खाता है?",
  },
  isAadhaarLinkedToBank: {
    type: "boolean",
    label: "Aadhaar linked to bank account",
    question: "Is your Aadhaar linked to your bank account?",
    questionHi: "क्या आपका आधार बैंक खाते से जुड़ा है?",
  },
  isIncomeTaxPayer: {
    type: "boolean",
    label: "Pays income tax",
    question: "Does anyone in your family pay income tax?",
  },
  isGovernmentEmployee: {
    type: "boolean",
    label: "Government employee",
    question: "Is anyone in your family a government employee?",
  },
  isInstitutionalLandholder: {
    type: "boolean",
    label: "Institutional land holder",
    question: "Is the land held by an institution rather than by your family?",
  },
  monthlyPensionRupees: {
    type: "number",
    min: 0,
    max: 10_000_000,
    label: "Monthly pension",
    question: "Do you receive a pension, and how much per month?",
  },
  isProfessional: {
    type: "boolean",
    label: "Practising professional",
    question:
      "Is anyone in your family a practising doctor, engineer, lawyer, chartered accountant or architect?",
  },
};

export const PROFILE_FIELD_KEYS = Object.keys(
  PROFILE_FIELD_SPECS,
) as ProfileFieldKey[];

export function isProfileFieldKey(key: string): key is ProfileFieldKey {
  return Object.hasOwn(PROFILE_FIELD_SPECS, key);
}

export type CoercionResult =
  | { ok: true; value: string | number | boolean | null }
  | { ok: false; reason: string };

const TRUTHY = new Set(["true", "yes", "y", "1", "haan", "हाँ", "हां"]);
const FALSY = new Set(["false", "no", "n", "0", "nahi", "नहीं", "ना"]);

/**
 * Coerce and validate a raw extracted value for a known field.
 *
 * Returns a failure rather than a best guess. The caller drops the field and
 * records the reason, which surfaces to the citizen as a question instead of
 * a wrong decision.
 */
export function coerceProfileValue(
  key: ProfileFieldKey,
  raw: unknown,
): CoercionResult {
  const spec = PROFILE_FIELD_SPECS[key];

  // An explicit null means "asked, and there is none" - a meaningful answer
  // that the rule engine treats differently from an absent field.
  if (raw === null) return { ok: true, value: null };
  if (raw === undefined || raw === "") {
    return { ok: false, reason: "no value provided" };
  }

  switch (spec.type) {
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (typeof raw === "string") {
        const normalised = raw.trim().toLowerCase();
        if (TRUTHY.has(normalised)) return { ok: true, value: true };
        if (FALSY.has(normalised)) return { ok: true, value: false };
      }
      return {
        ok: false,
        reason: `expected a yes/no value for ${spec.label}, received ${JSON.stringify(raw)}`,
      };
    }

    case "number": {
      let numeric: number | null = null;

      if (typeof raw === "number") {
        numeric = raw;
      } else if (typeof raw === "string") {
        // Tolerate a trailing unit or currency symbol, but nothing more
        // creative: "67 years" is unambiguous, "sixty-seven" is not.
        const cleaned = raw.replace(/[₹,\s]/g, "");
        const match = /^-?\d+(?:\.\d+)?/.exec(cleaned);
        if (match && /^-?[\d.]+(?:[a-zA-Z%]*)$/.test(cleaned)) {
          numeric = Number(match[0]);
        }
      }

      if (numeric === null || !Number.isFinite(numeric)) {
        return {
          ok: false,
          reason: `expected a number for ${spec.label}, received ${JSON.stringify(raw)}`,
        };
      }
      if (spec.integer && !Number.isInteger(numeric)) {
        return {
          ok: false,
          reason: `${spec.label} must be a whole number, received ${numeric}`,
        };
      }
      if (spec.min !== undefined && numeric < spec.min) {
        return {
          ok: false,
          reason: `${spec.label} of ${numeric} is below the plausible minimum of ${spec.min}`,
        };
      }
      if (spec.max !== undefined && numeric > spec.max) {
        return {
          ok: false,
          reason: `${spec.label} of ${numeric} is above the plausible maximum of ${spec.max}`,
        };
      }
      return { ok: true, value: numeric };
    }

    case "string": {
      if (typeof raw !== "string") {
        return {
          ok: false,
          reason: `expected text for ${spec.label}, received ${JSON.stringify(raw)}`,
        };
      }
      const trimmed = raw.trim();
      if (trimmed === "") return { ok: false, reason: "empty text" };

      if (spec.domain) {
        const match = spec.domain.find(
          (option) => option.toLowerCase() === trimmed.toLowerCase(),
        );
        if (!match) {
          return {
            ok: false,
            reason: `${spec.label} must be one of ${spec.domain.join(", ")}, received "${trimmed}"`,
          };
        }
        return { ok: true, value: match };
      }

      return { ok: true, value: trimmed };
    }
  }
}
