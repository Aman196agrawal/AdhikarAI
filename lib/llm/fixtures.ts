/**
 * Deterministic stub fixtures.
 *
 * One per LLM task. Each returns schema-valid output derived from the prompt,
 * so the whole closed loop runs with `LLM_PROVIDER=stub` at zero cost and with
 * identical results on every run.
 *
 * These are intentionally simple: the fixture for profile extraction does
 * keyword matching, not language understanding. That is the point. Tests need
 * a fixed input-to-output mapping they can assert against, and the engine -
 * which is what the tests are really exercising - cannot tell the difference
 * between a fixture's structured output and a model's.
 *
 * Fixture output passes the same Zod validation as a real provider's, so a
 * fixture that drifts out of shape fails loudly.
 */

import { registerStubFixture } from "./stub";
import type { LlmRequest } from "./provider";

/**
 * The citizen's own words, taken from between the intake markers.
 *
 * Scanning the whole prompt would match the field catalogue the profile agent
 * includes - which names "rural", "Farmer", "BPL" and so on - and extract
 * fields from an intake that never mentioned any of them.
 */
function citizenWords(request: LlmRequest<unknown>): string {
  const fenced = /<<<CITIZEN_WORDS([\s\S]*?)CITIZEN_WORDS>>>/.exec(request.prompt);
  return (fenced?.[1] ?? "").toLowerCase();
}

/** The full prompt, for tasks whose fixtures key off supplied engine facts. */
function promptText(request: LlmRequest<unknown>): string {
  return request.prompt.toLowerCase();
}

interface StubField {
  key: string;
  value: string | number | boolean | null;
  provenance: "SELF_DECLARED" | "INFERRED";
  note: string;
}

/**
 * Keyword rules for the extraction fixture.
 *
 * Ordered, first match wins per key. Deliberately conservative: a phrase that
 * is not matched yields no field, which the system then asks about - the same
 * behaviour as a real model declining to guess.
 */
const EXTRACTION_RULES: Array<{
  pattern: RegExp;
  produce: (match: RegExpExecArray) => StubField[];
}> = [
  {
    // "I am 67", "67 years old", "age 67"
    pattern: /(?:i am|age|aged|umar|उम्र)\D{0,12}(\d{1,3})|(\d{1,3})\s*(?:years? old|saal|वर्ष)/,
    produce: (m) => {
      const age = Number(m[1] ?? m[2]);
      return [
        {
          key: "age",
          value: age,
          provenance: "SELF_DECLARED",
          note: `Stated age of ${age}.`,
        },
      ];
    },
  },
  {
    pattern: /\b(widow|widowed|vidhwa|विधवा)\b/,
    produce: () => [
      {
        key: "isWidow",
        value: true,
        provenance: "SELF_DECLARED",
        note: "Described herself as a widow.",
      },
      {
        key: "maritalStatus",
        value: "WIDOWED",
        provenance: "INFERRED",
        note: "Deduced from stating she is a widow.",
      },
    ],
  },
  {
    pattern: /\b(village|rural|gaon|gaanv|गाँव|गांव)\b/,
    produce: () => [
      {
        key: "ruralUrban",
        value: "rural",
        provenance: "SELF_DECLARED",
        note: "Said she lives in a village.",
      },
    ],
  },
  {
    pattern: /\b(town|city|urban|shahar|शहर)\b/,
    produce: () => [
      {
        key: "ruralUrban",
        value: "urban",
        provenance: "SELF_DECLARED",
        note: "Said she lives in a town or city.",
      },
    ],
  },
  {
    pattern: /\b(farm|farmer|farming|kisan|kheti|किसान|खेती)\b/,
    produce: () => [
      {
        key: "isFarmer",
        value: true,
        provenance: "SELF_DECLARED",
        note: "Described farming as her work.",
      },
      {
        key: "occupation",
        value: "Farmer",
        provenance: "INFERRED",
        note: "Deduced from describing farming work.",
      },
    ],
  },
  {
    // "2 acres", "0.8 hectares"
    pattern: /([\d.]+)\s*(acre|acres|hectare|hectares|bigha)/,
    produce: (m) => {
      const amount = Number(m[1]);
      const unit = m[2];
      const hectares = unit.startsWith("acre")
        ? Math.round(amount * 0.4047 * 1000) / 1000
        : amount;
      return [
        {
          key: "landHoldingHectares",
          value: hectares,
          provenance: unit.startsWith("acre") ? "INFERRED" : "SELF_DECLARED",
          note: `Stated ${amount} ${unit}; converted to ${hectares} hectares.`,
        },
      ];
    },
  },
  {
    pattern: /\b(bpl|below poverty|antyodaya|ration card)\b/,
    produce: () => [
      {
        key: "hasBplCard",
        value: true,
        provenance: "SELF_DECLARED",
        note: "Mentioned holding a BPL or ration card.",
      },
    ],
  },
  {
    pattern: /\b(bank account|bank khata|passbook|बैंक)\b/,
    produce: () => [
      {
        key: "hasBankAccount",
        value: true,
        provenance: "SELF_DECLARED",
        note: "Mentioned having a bank account.",
      },
    ],
  },
  {
    pattern: /\bbihar\b/,
    produce: () => [
      {
        key: "state",
        value: "Bihar",
        provenance: "SELF_DECLARED",
        note: "Named Bihar as her state.",
      },
    ],
  },
  {
    pattern: /\b(no pension|not receiving any pension|koi pension nahi)\b/,
    produce: () => [
      {
        key: "monthlyPensionRupees",
        value: 0,
        provenance: "SELF_DECLARED",
        note: "Said she receives no pension.",
      },
    ],
  },
];

registerStubFixture("profile.extract", (request) => {
  const text = citizenWords(request);
  const fields: StubField[] = [];
  const seen = new Set<string>();

  for (const rule of EXTRACTION_RULES) {
    const match = rule.pattern.exec(text);
    if (!match) continue;

    for (const field of rule.produce(match)) {
      if (seen.has(field.key)) continue;
      seen.add(field.key);
      fields.push(field);
    }
  }

  return {
    fields,
    // Left empty: the system computes the questions worth asking from the
    // registry's mandatory clauses, which is strictly better than improvising.
    clarifyingQuestions: [],
    conflicts: [],
  };
});

registerStubFixture("profile.extractDocument", () => ({
  documentKind: "OTHER",
  fields: [],
  legible: false,
  notes:
    "The stub provider cannot read documents. Set LLM_PROVIDER=gemini with a key to extract from a real document.",
}));

registerStubFixture("explain.entitlement", (request) => {
  // Echo the scheme name the prompt supplied rather than inventing detail, so
  // the fixture can never introduce a fact the engine did not provide.
  const scheme = /scheme:\s*(.+)/i.exec(request.prompt)?.[1]?.trim() ?? "this scheme";
  const verdict = /verdict:\s*(GREEN|YELLOW|RED)/i.exec(request.prompt)?.[1] ?? "YELLOW";

  const headline =
    verdict === "GREEN"
      ? `You appear to qualify for ${scheme}.`
      : verdict === "RED"
        ? `You do not qualify for ${scheme}.`
        : `You may qualify for ${scheme}, but some information is missing.`;

  return {
    headline,
    detail:
      "This summary was generated without a language model, so it restates the engine's decision rather than rephrasing it. The conditions and their official sources are shown in full under Why?.",
    nextStep:
      verdict === "YELLOW" ? "Answer the remaining questions." : "",
  };
});

registerStubFixture("bank.extractMatchingTransactions", () => ({
  matches: [],
  legible: false,
  notABankStatement: false,
}));

registerStubFixture("diagnose.rootCause", (request) => {
  const text = promptText(request);

  // Keyed off the evidence the prompt actually contains, so the stub's
  // diagnosis is still grounded in supplied facts.
  if (/aadhaar/.test(text) && /(seed|link|mismatch)/.test(text)) {
    return {
      kind: "AADHAAR_ISSUE",
      citedEvidence: ["Government status mentions an Aadhaar seeding problem."],
      reasoning:
        "The disbursement failed and the status refers to Aadhaar seeding of the bank account, which prevents a Direct Benefit Transfer from completing.",
      recommendedAction: "CORRECT_INFORMATION",
    };
  }

  if (/missing document|not attached|pending document/.test(text)) {
    return {
      kind: "MISSING_DOCUMENT",
      citedEvidence: ["The application status records a required document as missing."],
      reasoning:
        "The department returned the application because a required document was not attached.",
      recommendedAction: "REQUEST_DOCUMENT",
    };
  }

  if (/pending for \d+ days|pending too long|stalled/.test(text)) {
    return {
      kind: "DELAYED_PROCESSING",
      citedEvidence: ["The application has been pending beyond the normal processing window."],
      reasoning:
        "No decision has been recorded well beyond the expected processing time, with no request for further information.",
      recommendedAction: "ESCALATE_GRIEVANCE",
    };
  }

  // No supporting evidence found: UNKNOWN, never a plausible guess.
  return {
    kind: "UNKNOWN",
    citedEvidence: [],
    reasoning:
      "The available evidence does not identify a cause. Escalating for human review rather than asserting one.",
    recommendedAction: "REQUEST_CLARIFICATION",
  };
});

registerStubFixture("plan.correctiveAction", (request) => {
  const text = promptText(request);

  if (/aadhaar_issue/.test(text)) {
    return {
      summary:
        "Correct the Aadhaar-to-bank seeding so the pension transfer can complete.",
      expectedOutcome:
        "The next monthly disbursement reaches the citizen's account and receipt is confirmed.",
      steps: [
        {
          kind: "CORRECT_INFORMATION",
          description:
            "Submit an Aadhaar seeding correction request for the pension disbursement account.",
          reason:
            "The transfer cannot complete while the account is not correctly seeded.",
          documentsRequired: ["AADHAAR", "BANK_PASSBOOK"],
          informationRequired: ["Bank account number", "IFSC code"],
          channel: "State social welfare portal",
        },
        {
          kind: "REQUEST_ASSISTED_VERIFICATION",
          description:
            "Ask the Common Service Centre operator to confirm the seeding has taken effect.",
          reason:
            "Confirming the correction before the next payment cycle avoids losing another month.",
          documentsRequired: [],
          informationRequired: [],
          channel: "Common Service Centre",
        },
      ],
      evidenceNeeded: [
        "A disbursement recorded as released and confirmed as received",
      ],
    };
  }

  if (/missing_document/.test(text)) {
    return {
      summary: "Supply the missing document and resubmit the application.",
      expectedOutcome: "The application moves from returned to under review.",
      steps: [
        {
          kind: "REQUEST_DOCUMENT",
          description: "Collect the required document from the citizen.",
          reason: "The department returned the application without it.",
          documentsRequired: ["INCOME_CERTIFICATE"],
          informationRequired: [],
          channel: "Citizen upload",
        },
        {
          kind: "RESUBMIT",
          description: "Resubmit the completed application to the portal.",
          reason: "A returned application is not reconsidered until resubmitted.",
          documentsRequired: [],
          informationRequired: [],
          channel: "Government portal",
        },
      ],
      evidenceNeeded: ["An application status of under review or approved"],
    };
  }

  return {
    summary: "Escalate for human review.",
    expectedOutcome: "A caseworker establishes the cause and advises next steps.",
    steps: [
      {
        kind: "ESCALATE_GRIEVANCE",
        description: "Raise a grievance with the implementing department.",
        reason:
          "The cause could not be established from the available evidence.",
        documentsRequired: [],
        informationRequired: [],
        channel: "Grievance portal",
      },
    ],
    evidenceNeeded: ["A response from the department"],
  };
});
