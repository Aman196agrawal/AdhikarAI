/**
 * The curated scheme registry: ten central schemes with full rule sets.
 *
 * Read the DATA PROVENANCE WARNING in ./types.ts before trusting any figure
 * here. In short: cash amounts are CENTRAL assistance, state top-ups are not
 * modelled, and `verificationStatus` distinguishes records checked against
 * their source URL from records compiled from documentation.
 *
 * Depth over breadth is deliberate. Ten schemes with ~8 citable clauses each
 * make the audit engine defensible; forty schemes with an age-and-state check
 * each would make it a lookup table.
 */

import type { SchemeSpec } from "./types";

/** Date the SOURCE_CHECKED records were verified against their source URLs. */
const CHECKED = "2026-10-08";

/**
 * Date the COMPILED_UNVERIFIED records were compiled. These were written from
 * official scheme documentation but NOT re-opened at their source URL, so they
 * are flagged accordingly rather than claiming a verification that did not
 * happen.
 */
const COMPILED = "2026-10-08";

const NSAP_SOURCE = {
  sourceName: "National Social Assistance Programme (NSAP), Ministry of Rural Development",
  sourceUrl: "https://nsap.nic.in/",
  lastVerified: CHECKED,
};

// ---------------------------------------------------------------------------
// 1. PM-KISAN
// ---------------------------------------------------------------------------

const PM_KISAN: SchemeSpec = {
  code: "PM-KISAN",
  name: "Pradhan Mantri Kisan Samman Nidhi",
  nameHi: "प्रधानमंत्री किसान सम्मान निधि",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Agriculture & Farmer Welfare",
  description:
    "Income support of ₹6,000 per year to land-holding farmer families, paid in three equal instalments of ₹2,000 directly into the beneficiary's bank account.",
  descriptionHi:
    "भूमिधारक किसान परिवारों को ₹6,000 प्रति वर्ष, ₹2,000 की तीन समान किस्तों में सीधे बैंक खाते में।",
  benefitType: "CASH",
  benefitAmountRupees: 2000,
  benefitNote:
    "₹2,000 per instalment, three instalments per year (₹6,000 annually). Paid by Direct Benefit Transfer.",
  frequency: "TRIANNUAL",
  installmentsPerYear: 3,
  applicationMethod:
    "Self-registration on the PM-KISAN portal, or through the village Patwari / Revenue Officer / Common Service Centre.",
  applicationUrl: "https://pmkisan.gov.in/",
  requiredDocuments: ["AADHAAR", "LAND_RECORD", "BANK_PASSBOOK"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name as per Aadhaar", type: "text", required: true },
    { key: "state", label: "State", type: "text", required: true, fromProfileField: "state" },
    { key: "district", label: "District", type: "text", required: true, fromProfileField: "district" },
    { key: "landHoldingHectares", label: "Cultivable land (hectares)", type: "number", required: true, fromProfileField: "landHoldingHectares" },
    { key: "bankAccountNumber", label: "Bank account number", type: "text", required: true },
    { key: "ifscCode", label: "IFSC code", type: "text", required: true, validation: "11 characters" },
  ],
  sourceName: "PM-KISAN, Department of Agriculture & Farmers Welfare",
  sourceUrl: "https://pmkisan.gov.in/",
  lastVerified: COMPILED,
  verificationStatus: "COMPILED_UNVERIFIED",
  clauses: [
    {
      code: "IS_FARMER",
      kind: "ELIGIBILITY",
      field: "isFarmer",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["LAND_RECORD"],
      text: "The beneficiary must be a member of a land-holding farmer family.",
      textHi: "लाभार्थी भूमिधारक किसान परिवार का सदस्य होना चाहिए।",
      sourceName: "PM-KISAN Operational Guidelines",
      sourceUrl: "https://pmkisan.gov.in/Documents/RevisedFAQ.pdf",
      lastVerified: COMPILED,
    },
    {
      code: "HAS_CULTIVABLE_LAND",
      kind: "ELIGIBILITY",
      field: "landHoldingHectares",
      op: "gt",
      value: 0,
      mandatory: true,
      evidenceDocs: ["LAND_RECORD"],
      text: "The family must own cultivable land recorded in its name in the land records.",
      sourceName: "PM-KISAN Operational Guidelines",
      sourceUrl: "https://pmkisan.gov.in/Documents/RevisedFAQ.pdf",
      lastVerified: COMPILED,
    },
    {
      code: "AADHAAR_BANK_SEEDED",
      kind: "DEPENDENCY",
      field: "isAadhaarLinkedToBank",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["AADHAAR", "BANK_PASSBOOK"],
      text: "The beneficiary's Aadhaar must be seeded to the bank account for Direct Benefit Transfer.",
      textHi: "प्रत्यक्ष लाभ अंतरण के लिए आधार को बैंक खाते से जोड़ा जाना आवश्यक है।",
      sourceName: "PM-KISAN Operational Guidelines",
      sourceUrl: "https://pmkisan.gov.in/Documents/RevisedFAQ.pdf",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_INCOME_TAX_PAYER",
      kind: "EXCLUSION",
      field: "isIncomeTaxPayer",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["INCOME_CERTIFICATE"],
      text: "Farmer families in which any member paid income tax in the last assessment year are excluded.",
      sourceName: "PM-KISAN Exclusion Categories",
      sourceUrl: "https://pmkisan.gov.in/Documents/RevisedFAQ.pdf",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_GOVERNMENT_EMPLOYEE",
      kind: "EXCLUSION",
      field: "isGovernmentEmployee",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: [],
      text: "Serving or retired officers and employees of Central or State Government departments and public sector undertakings are excluded (multi-tasking and Group D staff excepted).",
      sourceName: "PM-KISAN Exclusion Categories",
      sourceUrl: "https://pmkisan.gov.in/Documents/RevisedFAQ.pdf",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_INSTITUTIONAL_LANDHOLDER",
      kind: "EXCLUSION",
      field: "isInstitutionalLandholder",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["LAND_RECORD"],
      text: "All institutional land holders are excluded.",
      sourceName: "PM-KISAN Exclusion Categories",
      sourceUrl: "https://pmkisan.gov.in/Documents/RevisedFAQ.pdf",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_HIGH_PENSION",
      kind: "EXCLUSION",
      field: "monthlyPensionRupees",
      op: "gte",
      value: 10000,
      mandatory: true,
      evidenceDocs: [],
      text: "Retired pensioners with a monthly pension of ₹10,000 or more are excluded (multi-tasking and Group D staff excepted).",
      sourceName: "PM-KISAN Exclusion Categories",
      sourceUrl: "https://pmkisan.gov.in/Documents/RevisedFAQ.pdf",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_PROFESSIONAL",
      kind: "EXCLUSION",
      field: "isProfessional",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: [],
      text: "Practising professionals such as doctors, engineers, lawyers, chartered accountants and architects are excluded.",
      sourceName: "PM-KISAN Exclusion Categories",
      sourceUrl: "https://pmkisan.gov.in/Documents/RevisedFAQ.pdf",
      lastVerified: COMPILED,
    },
  ],
};

// ---------------------------------------------------------------------------
// 2. IGNOAPS (NSAP)
// ---------------------------------------------------------------------------

const IGNOAPS: SchemeSpec = {
  code: "NSAP-IGNOAPS",
  name: "Indira Gandhi National Old Age Pension Scheme",
  nameHi: "इंदिरा गांधी राष्ट्रीय वृद्धावस्था पेंशन योजना",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Social Security & Pension",
  description:
    "Monthly old-age pension for persons aged 60 and above belonging to a Below Poverty Line family. Central assistance is ₹200 per month for ages 60–79 and ₹500 per month from age 80.",
  descriptionHi:
    "गरीबी रेखा से नीचे के 60 वर्ष या अधिक आयु के व्यक्तियों के लिए मासिक वृद्धावस्था पेंशन।",
  benefitType: "CASH",
  benefitAmountRupees: 200,
  benefitNote:
    "CENTRAL assistance only: ₹200/month for ages 60–79, rising to ₹500/month at 80. Most States add a top-up, so the amount actually credited is commonly higher. State top-ups are NOT modelled in this registry.",
  frequency: "MONTHLY",
  applicationMethod:
    "Application to the Gram Panchayat / Block Development Office or municipality, or online via the State social welfare portal.",
  applicationUrl: "https://nsap.nic.in/",
  requiredDocuments: ["AADHAAR", "AGE_PROOF", "RATION_CARD", "BANK_PASSBOOK"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "dateOfBirth", label: "Date of birth", type: "date", required: true },
    { key: "state", label: "State", type: "text", required: true, fromProfileField: "state" },
    { key: "district", label: "District", type: "text", required: true, fromProfileField: "district" },
    { key: "bplCardNumber", label: "BPL / ration card number", type: "text", required: true },
    { key: "bankAccountNumber", label: "Bank account number", type: "text", required: true },
    { key: "ifscCode", label: "IFSC code", type: "text", required: true, validation: "11 characters" },
  ],
  ...NSAP_SOURCE,
  verificationStatus: "SOURCE_CHECKED",
  clauses: [
    {
      code: "AGE_60_PLUS",
      kind: "ELIGIBILITY",
      field: "age",
      op: "gte",
      value: 60,
      mandatory: true,
      evidenceDocs: ["AGE_PROOF", "AADHAAR"],
      text: "The applicant must be aged 60 years or above.",
      textHi: "आवेदक की आयु 60 वर्ष या अधिक होनी चाहिए।",
      ...NSAP_SOURCE,
    },
    {
      code: "BPL_HOUSEHOLD",
      kind: "ELIGIBILITY",
      field: "hasBplCard",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["RATION_CARD", "INCOME_CERTIFICATE"],
      text: "The applicant must belong to a family living Below the Poverty Line according to the criteria prescribed by the Government of India.",
      textHi: "आवेदक भारत सरकार के मानदंडों के अनुसार गरीबी रेखा से नीचे के परिवार से होना चाहिए।",
      ...NSAP_SOURCE,
    },
    {
      code: "HAS_BANK_ACCOUNT",
      kind: "DEPENDENCY",
      field: "hasBankAccount",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["BANK_PASSBOOK"],
      text: "A bank or post office account is required for disbursement of the pension.",
      ...NSAP_SOURCE,
    },
    {
      code: "AADHAAR_BANK_SEEDED",
      kind: "DEPENDENCY",
      field: "isAadhaarLinkedToBank",
      op: "is_true",
      value: true,
      mandatory: false,
      evidenceDocs: ["AADHAAR", "BANK_PASSBOOK"],
      text: "Aadhaar seeding of the disbursement account is required for Direct Benefit Transfer in most States.",
      ...NSAP_SOURCE,
    },
  ],
};

// ---------------------------------------------------------------------------
// 3. IGNWPS (NSAP)
// ---------------------------------------------------------------------------

const IGNWPS: SchemeSpec = {
  code: "NSAP-IGNWPS",
  name: "Indira Gandhi National Widow Pension Scheme",
  nameHi: "इंदिरा गांधी राष्ट्रीय विधवा पेंशन योजना",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Social Security & Pension",
  description:
    "Monthly pension of ₹300 (central assistance) for widows aged 40 to 79 belonging to a Below Poverty Line family.",
  descriptionHi:
    "गरीबी रेखा से नीचे के परिवार की 40 से 79 वर्ष की विधवाओं के लिए ₹300 मासिक पेंशन।",
  benefitType: "CASH",
  benefitAmountRupees: 300,
  benefitNote:
    "CENTRAL assistance of ₹300/month. States commonly add a top-up, which is not modelled here. On attaining age 80 the beneficiary transfers to IGNOAPS at the higher rate.",
  frequency: "MONTHLY",
  applicationMethod:
    "Application to the Gram Panchayat / Block Development Office or municipality, or online via the State social welfare portal.",
  applicationUrl: "https://nsap.nic.in/",
  requiredDocuments: ["AADHAAR", "AGE_PROOF", "DEATH_CERTIFICATE", "RATION_CARD", "BANK_PASSBOOK"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "dateOfBirth", label: "Date of birth", type: "date", required: true },
    { key: "spouseDeathCertificateNumber", label: "Spouse death certificate number", type: "text", required: true },
    { key: "state", label: "State", type: "text", required: true, fromProfileField: "state" },
    { key: "district", label: "District", type: "text", required: true, fromProfileField: "district" },
    { key: "bplCardNumber", label: "BPL / ration card number", type: "text", required: true },
    { key: "bankAccountNumber", label: "Bank account number", type: "text", required: true },
    { key: "ifscCode", label: "IFSC code", type: "text", required: true, validation: "11 characters" },
  ],
  ...NSAP_SOURCE,
  verificationStatus: "SOURCE_CHECKED",
  clauses: [
    {
      code: "AGE_40_TO_79",
      kind: "ELIGIBILITY",
      field: "age",
      op: "between",
      value: [40, 79],
      mandatory: true,
      evidenceDocs: ["AGE_PROOF", "AADHAAR"],
      text: "The applicant must be aged between 40 and 79 years.",
      textHi: "आवेदक की आयु 40 से 79 वर्ष के बीच होनी चाहिए।",
      ...NSAP_SOURCE,
    },
    {
      code: "IS_WIDOW",
      kind: "ELIGIBILITY",
      field: "isWidow",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["DEATH_CERTIFICATE"],
      text: "The applicant must be a widow.",
      textHi: "आवेदक विधवा होनी चाहिए।",
      ...NSAP_SOURCE,
    },
    {
      code: "BPL_HOUSEHOLD",
      kind: "ELIGIBILITY",
      field: "hasBplCard",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["RATION_CARD", "INCOME_CERTIFICATE"],
      text: "The applicant must belong to a family living Below the Poverty Line according to the criteria prescribed by the Government of India.",
      ...NSAP_SOURCE,
    },
    {
      code: "HAS_BANK_ACCOUNT",
      kind: "DEPENDENCY",
      field: "hasBankAccount",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["BANK_PASSBOOK"],
      text: "A bank or post office account is required for disbursement of the pension.",
      ...NSAP_SOURCE,
    },
  ],
};

// ---------------------------------------------------------------------------
// 4. IGNDPS (NSAP)
// ---------------------------------------------------------------------------

const IGNDPS: SchemeSpec = {
  code: "NSAP-IGNDPS",
  name: "Indira Gandhi National Disability Pension Scheme",
  nameHi: "इंदिरा गांधी राष्ट्रीय दिव्यांगता पेंशन योजना",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Social Security & Pension",
  description:
    "Monthly pension of ₹300 (central assistance) for persons aged 18 to 79 with severe or multiple disability, belonging to a Below Poverty Line family.",
  benefitType: "CASH",
  benefitAmountRupees: 300,
  benefitNote:
    "CENTRAL assistance of ₹300/month. States commonly add a top-up, which is not modelled here.",
  frequency: "MONTHLY",
  applicationMethod:
    "Application to the Gram Panchayat / Block Development Office or municipality, or online via the State social welfare portal.",
  applicationUrl: "https://nsap.nic.in/",
  requiredDocuments: ["AADHAAR", "AGE_PROOF", "DISABILITY_CERTIFICATE", "RATION_CARD", "BANK_PASSBOOK"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "dateOfBirth", label: "Date of birth", type: "date", required: true },
    { key: "disabilityPercent", label: "Disability percentage", type: "number", required: true, fromProfileField: "disabilityPercent" },
    { key: "disabilityCertificateNumber", label: "Disability certificate number", type: "text", required: true },
    { key: "bplCardNumber", label: "BPL / ration card number", type: "text", required: true },
    { key: "bankAccountNumber", label: "Bank account number", type: "text", required: true },
    { key: "ifscCode", label: "IFSC code", type: "text", required: true, validation: "11 characters" },
  ],
  ...NSAP_SOURCE,
  verificationStatus: "SOURCE_CHECKED",
  clauses: [
    {
      code: "AGE_18_TO_79",
      kind: "ELIGIBILITY",
      field: "age",
      op: "between",
      value: [18, 79],
      mandatory: true,
      evidenceDocs: ["AGE_PROOF", "AADHAAR"],
      text: "The applicant must be aged between 18 and 79 years.",
      ...NSAP_SOURCE,
    },
    {
      code: "SEVERE_DISABILITY",
      kind: "ELIGIBILITY",
      field: "disabilityPercent",
      op: "gte",
      value: 80,
      mandatory: true,
      evidenceDocs: ["DISABILITY_CERTIFICATE"],
      text: "The applicant must have severe or multiple disability of 80 percent or more.",
      textHi: "आवेदक को 80 प्रतिशत या अधिक गंभीर या बहुविकलांगता होनी चाहिए।",
      ...NSAP_SOURCE,
    },
    {
      code: "BPL_HOUSEHOLD",
      kind: "ELIGIBILITY",
      field: "hasBplCard",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["RATION_CARD", "INCOME_CERTIFICATE"],
      text: "The applicant must belong to a family living Below the Poverty Line according to the criteria prescribed by the Government of India.",
      ...NSAP_SOURCE,
    },
    {
      code: "HAS_BANK_ACCOUNT",
      kind: "DEPENDENCY",
      field: "hasBankAccount",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["BANK_PASSBOOK"],
      text: "A bank or post office account is required for disbursement of the pension.",
      ...NSAP_SOURCE,
    },
  ],
};

// ---------------------------------------------------------------------------
// 5. Ayushman Bharat PM-JAY
// ---------------------------------------------------------------------------

const PM_JAY: SchemeSpec = {
  code: "PM-JAY",
  name: "Ayushman Bharat Pradhan Mantri Jan Arogya Yojana",
  nameHi: "आयुष्मान भारत प्रधानमंत्री जन आरोग्य योजना",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Health Insurance",
  description:
    "Health cover of ₹5,00,000 per family per year for secondary and tertiary care hospitalisation, available at empanelled public and private hospitals.",
  descriptionHi:
    "सूचीबद्ध अस्पतालों में द्वितीयक और तृतीयक देखभाल के लिए प्रति परिवार प्रति वर्ष ₹5,00,000 का स्वास्थ्य कवर।",
  benefitType: "INSURANCE",
  benefitAmountRupees: 500000,
  benefitNote:
    "A cover limit, not a cash transfer. The family can use up to ₹5,00,000 of cashless treatment per year; no money is credited to a bank account.",
  frequency: "ANNUAL",
  applicationMethod:
    "Eligibility verification at a Common Service Centre, empanelled hospital Ayushman Mitra desk, or via the beneficiary portal; Ayushman card issued on verification.",
  applicationUrl: "https://beneficiary.nha.gov.in/",
  requiredDocuments: ["AADHAAR", "RATION_CARD"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "state", label: "State", type: "text", required: true, fromProfileField: "state" },
    { key: "district", label: "District", type: "text", required: true, fromProfileField: "district" },
    { key: "householdSize", label: "Number of family members", type: "number", required: true, fromProfileField: "householdSize" },
    { key: "rationCardNumber", label: "Ration card number", type: "text", required: false },
  ],
  sourceName: "National Health Authority, Ayushman Bharat PM-JAY",
  sourceUrl: "https://pmjay.gov.in/",
  lastVerified: COMPILED,
  verificationStatus: "COMPILED_UNVERIFIED",
  clauses: [
    {
      code: "SECC_DEPRIVATION_OR_OCCUPATIONAL",
      kind: "ELIGIBILITY",
      field: "seccDeprivationCriteria",
      op: "exists",
      value: null,
      mandatory: true,
      evidenceDocs: ["RATION_CARD"],
      text: "The household must be identified as entitled under the deprivation or occupational criteria of the Socio-Economic Caste Census 2011, or be covered by a State-notified extension of the scheme.",
      textHi:
        "परिवार सामाजिक-आर्थिक जाति जनगणना 2011 के अभाव या व्यावसायिक मानदंडों के तहत पात्र होना चाहिए।",
      sourceName: "PM-JAY Eligibility Criteria",
      sourceUrl: "https://pmjay.gov.in/about/pmjay",
      lastVerified: COMPILED,
    },
    {
      code: "RURAL_OR_URBAN_COVERED",
      kind: "ELIGIBILITY",
      field: "ruralUrban",
      op: "in",
      value: ["rural", "urban"],
      mandatory: false,
      evidenceDocs: ["RESIDENCE_PROOF"],
      text: "Both rural and urban households are covered, through separate deprivation and occupational category lists.",
      sourceName: "PM-JAY Eligibility Criteria",
      sourceUrl: "https://pmjay.gov.in/about/pmjay",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_INCOME_TAX_PAYER",
      kind: "EXCLUSION",
      field: "isIncomeTaxPayer",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["INCOME_CERTIFICATE"],
      text: "Households meeting automatic exclusion criteria, including income tax paying households, are not entitled under the SECC-based list.",
      sourceName: "PM-JAY Eligibility Criteria",
      sourceUrl: "https://pmjay.gov.in/about/pmjay",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_GOVERNMENT_EMPLOYEE",
      kind: "EXCLUSION",
      field: "isGovernmentEmployee",
      op: "is_true",
      value: true,
      mandatory: false,
      evidenceDocs: [],
      text: "Households with a government employee member are generally excluded from the SECC-based entitlement list.",
      sourceName: "PM-JAY Eligibility Criteria",
      sourceUrl: "https://pmjay.gov.in/about/pmjay",
      lastVerified: COMPILED,
    },
  ],
};

// ---------------------------------------------------------------------------
// 6. PMAY-Gramin
// ---------------------------------------------------------------------------

const PMAY_G: SchemeSpec = {
  code: "PMAY-G",
  name: "Pradhan Mantri Awaas Yojana - Gramin",
  nameHi: "प्रधानमंत्री आवास योजना - ग्रामीण",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Housing",
  description:
    "Assistance of ₹1,20,000 in plain areas for construction of a pucca house by rural households that are houseless or living in kutcha or dilapidated housing.",
  descriptionHi:
    "बेघर या कच्चे मकान में रहने वाले ग्रामीण परिवारों को पक्का मकान बनाने के लिए मैदानी क्षेत्रों में ₹1,20,000 की सहायता।",
  benefitType: "CASH",
  benefitAmountRupees: 120000,
  benefitNote:
    "₹1,20,000 in plain areas and ₹1,30,000 in hilly, difficult and Integrated Action Plan districts. Released in instalments tied to verified construction milestones, so the schedule is milestone-driven rather than calendar-driven.",
  frequency: "ONE_TIME",
  paidInStages: true,
  applicationMethod:
    "Identification through the Awaas+ survey and Gram Sabha verification; application supported by the Block Development Office.",
  applicationUrl: "https://pmayg.nic.in/",
  requiredDocuments: ["AADHAAR", "BANK_PASSBOOK", "JOB_CARD", "RESIDENCE_PROOF"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "state", label: "State", type: "text", required: true, fromProfileField: "state" },
    { key: "district", label: "District", type: "text", required: true, fromProfileField: "district" },
    { key: "housingType", label: "Current housing type", type: "select", required: true, fromProfileField: "housingType", options: ["HOUSELESS", "KUCCHA", "SEMI_PUCCA", "PUCCA"] },
    { key: "jobCardNumber", label: "MGNREGA job card number", type: "text", required: false, fromProfileField: "hasJobCard" },
    { key: "bankAccountNumber", label: "Bank account number", type: "text", required: true },
    { key: "ifscCode", label: "IFSC code", type: "text", required: true, validation: "11 characters" },
  ],
  sourceName: "Pradhan Mantri Awaas Yojana - Gramin, Ministry of Rural Development",
  sourceUrl: "https://pmayg.nic.in/",
  lastVerified: COMPILED,
  verificationStatus: "COMPILED_UNVERIFIED",
  clauses: [
    {
      code: "RURAL_HOUSEHOLD",
      kind: "ELIGIBILITY",
      field: "ruralUrban",
      op: "eq",
      value: "rural",
      mandatory: true,
      evidenceDocs: ["RESIDENCE_PROOF"],
      text: "The household must be resident in a rural area.",
      textHi: "परिवार ग्रामीण क्षेत्र का निवासी होना चाहिए।",
      sourceName: "PMAY-G Framework for Implementation",
      sourceUrl: "https://pmayg.nic.in/netiayHome/home.aspx",
      lastVerified: COMPILED,
    },
    {
      code: "HOUSELESS_OR_KUCCHA",
      kind: "ELIGIBILITY",
      field: "housingType",
      op: "in",
      value: ["HOUSELESS", "KUCCHA"],
      mandatory: true,
      evidenceDocs: ["RESIDENCE_PROOF"],
      text: "The household must be houseless, or living in a kutcha or dilapidated house with up to two rooms.",
      textHi: "परिवार बेघर होना चाहिए या कच्चे या जीर्ण-शीर्ण मकान में रहना चाहिए।",
      sourceName: "PMAY-G Framework for Implementation",
      sourceUrl: "https://pmayg.nic.in/netiayHome/home.aspx",
      lastVerified: COMPILED,
    },
    {
      code: "NO_PUCCA_HOUSE",
      kind: "EXCLUSION",
      field: "hasPuccaHouse",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["RESIDENCE_PROOF"],
      text: "Households already owning a pucca house are not eligible for assistance.",
      sourceName: "PMAY-G Framework for Implementation",
      sourceUrl: "https://pmayg.nic.in/netiayHome/home.aspx",
      lastVerified: COMPILED,
    },
    {
      code: "AWAAS_PLUS_IDENTIFIED",
      kind: "DEPENDENCY",
      field: "seccDeprivationCriteria",
      op: "exists",
      value: null,
      mandatory: true,
      evidenceDocs: [],
      text: "The household must appear in the Awaas+ / SECC-based permanent wait list and be verified by the Gram Sabha.",
      sourceName: "PMAY-G Framework for Implementation",
      sourceUrl: "https://pmayg.nic.in/netiayHome/home.aspx",
      lastVerified: COMPILED,
    },
    {
      code: "HAS_BANK_ACCOUNT",
      kind: "DEPENDENCY",
      field: "hasBankAccount",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["BANK_PASSBOOK"],
      text: "A bank account is required, as assistance is released electronically in milestone-linked instalments.",
      sourceName: "PMAY-G Framework for Implementation",
      sourceUrl: "https://pmayg.nic.in/netiayHome/home.aspx",
      lastVerified: COMPILED,
    },
  ],
};

// ---------------------------------------------------------------------------
// 7. NFSA subsidised foodgrain
// ---------------------------------------------------------------------------

const NFSA: SchemeSpec = {
  code: "NFSA-PHH",
  name: "National Food Security Act - Subsidised Foodgrain",
  nameHi: "राष्ट्रीय खाद्य सुरक्षा अधिनियम - रियायती खाद्यान्न",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Food Security",
  description:
    "Subsidised foodgrain through the Public Distribution System: 5 kg per person per month for priority households, and 35 kg per household per month under Antyodaya Anna Yojana.",
  descriptionHi:
    "सार्वजनिक वितरण प्रणाली के माध्यम से रियायती खाद्यान्न: प्राथमिक परिवारों के लिए प्रति व्यक्ति 5 किलो प्रति माह।",
  benefitType: "IN_KIND",
  benefitAmountRupees: null,
  benefitNote:
    "An IN-KIND entitlement, not a cash transfer. Priority households receive 5 kg of foodgrain per person per month; Antyodaya households receive 35 kg per household. No rupee amount is credited, so expected cash value is deliberately null rather than zero.",
  frequency: "MONTHLY",
  applicationMethod:
    "Application for a ration card to the State Food and Civil Supplies department, or at the Fair Price Shop / Common Service Centre.",
  applicationUrl: "https://nfsa.gov.in/",
  requiredDocuments: ["AADHAAR", "RATION_CARD", "RESIDENCE_PROOF"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Head of household name", type: "text", required: true },
    { key: "householdSize", label: "Number of family members", type: "number", required: true, fromProfileField: "householdSize" },
    { key: "state", label: "State", type: "text", required: true, fromProfileField: "state" },
    { key: "district", label: "District", type: "text", required: true, fromProfileField: "district" },
    { key: "rationCardType", label: "Ration card type", type: "select", required: true, fromProfileField: "rationCardType", options: ["AAY", "PHH", "NON_NFSA"] },
  ],
  sourceName: "Department of Food & Public Distribution, NFSA",
  sourceUrl: "https://nfsa.gov.in/",
  lastVerified: COMPILED,
  verificationStatus: "COMPILED_UNVERIFIED",
  clauses: [
    {
      code: "NFSA_RATION_CARD",
      kind: "ELIGIBILITY",
      field: "rationCardType",
      op: "in",
      value: ["AAY", "PHH"],
      mandatory: true,
      evidenceDocs: ["RATION_CARD"],
      text: "The household must hold an Antyodaya Anna Yojana or Priority Household ration card issued under the National Food Security Act.",
      textHi:
        "परिवार के पास राष्ट्रीय खाद्य सुरक्षा अधिनियम के तहत अंत्योदय अन्न योजना या प्राथमिक परिवार राशन कार्ड होना चाहिए।",
      sourceName: "National Food Security Act, 2013",
      sourceUrl: "https://nfsa.gov.in/portal/NFSA-Act",
      lastVerified: COMPILED,
    },
    {
      code: "HOUSEHOLD_SIZE_KNOWN",
      kind: "DEPENDENCY",
      field: "householdSize",
      op: "gte",
      value: 1,
      mandatory: true,
      evidenceDocs: ["RATION_CARD"],
      text: "The number of enrolled household members determines the monthly quantity for priority households, at 5 kg per person.",
      sourceName: "National Food Security Act, 2013",
      sourceUrl: "https://nfsa.gov.in/portal/NFSA-Act",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_INCOME_TAX_PAYER",
      kind: "EXCLUSION",
      field: "isIncomeTaxPayer",
      op: "is_true",
      value: true,
      mandatory: false,
      evidenceDocs: ["INCOME_CERTIFICATE"],
      text: "States apply exclusion criteria for priority household identification, which commonly exclude income tax paying households.",
      sourceName: "National Food Security Act, 2013",
      sourceUrl: "https://nfsa.gov.in/portal/NFSA-Act",
      lastVerified: COMPILED,
    },
  ],
};

// ---------------------------------------------------------------------------
// 8. PMMVY
// ---------------------------------------------------------------------------

const PMMVY: SchemeSpec = {
  code: "PMMVY",
  name: "Pradhan Mantri Matru Vandana Yojana",
  nameHi: "प्रधानमंत्री मातृ वंदना योजना",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Maternity Benefit",
  description:
    "Maternity benefit of ₹5,000 for the first living child, paid in three instalments on early pregnancy registration, after six months of pregnancy, and after birth registration.",
  descriptionHi:
    "पहले जीवित बच्चे के लिए ₹5,000 का मातृत्व लाभ, तीन किस्तों में।",
  benefitType: "CASH",
  benefitAmountRupees: 5000,
  benefitNote:
    "₹5,000 total, in three instalments of ₹1,000, ₹2,000 and ₹2,000. Since 1 April 2022 the benefit is also available for a second child if that child is a girl.",
  frequency: "ONE_TIME",
  paidInStages: true,
  applicationMethod:
    "Registration through the Anganwadi Centre or approved health facility, or self-registration on the PMMVY portal.",
  applicationUrl: "https://pmmvy.wcd.gov.in/",
  requiredDocuments: ["AADHAAR", "BANK_PASSBOOK", "OTHER"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "dateOfBirth", label: "Date of birth", type: "date", required: true },
    { key: "lmpDate", label: "Last menstrual period date", type: "date", required: true },
    { key: "mcpCardNumber", label: "Mother and Child Protection card number", type: "text", required: true },
    { key: "bankAccountNumber", label: "Bank account number", type: "text", required: true },
    { key: "ifscCode", label: "IFSC code", type: "text", required: true, validation: "11 characters" },
  ],
  sourceName: "Ministry of Women & Child Development, PMMVY",
  sourceUrl: "https://pmmvy.wcd.gov.in/",
  lastVerified: CHECKED,
  verificationStatus: "SOURCE_CHECKED",
  clauses: [
    {
      code: "AGE_UNDER_55",
      kind: "ELIGIBILITY",
      field: "age",
      op: "lt",
      value: 55,
      mandatory: true,
      evidenceDocs: ["AGE_PROOF", "AADHAAR"],
      text: "The beneficiary must be less than 55 years of age at the time of childbirth.",
      textHi: "लाभार्थी की आयु बच्चे के जन्म के समय 55 वर्ष से कम होनी चाहिए।",
      sourceName: "PMMVY Frequently Asked Questions, Ministry of Women & Child Development",
      sourceUrl:
        "https://wcd.nic.in/sites/default/files/FINAL%20PMMVY%20%28FAQ%29%20BOOKELT_0.pdf",
      lastVerified: CHECKED,
    },
    {
      code: "AGE_AT_LEAST_18",
      kind: "ELIGIBILITY",
      field: "age",
      op: "gte",
      value: 18,
      mandatory: true,
      evidenceDocs: ["AGE_PROOF", "AADHAAR"],
      // The official floor is 18 years and 7 months. This registry models age
      // in whole years, so the clause is set at 18 rather than rounded up to
      // 19: rounding up would wrongly exclude a genuinely eligible 18-year-old,
      // and a false RED is far more harmful than a YELLOW needing a date check.
      text: "The beneficiary must be at least 18 years and 7 months of age at the time of childbirth. This registry compares whole years only, so applicants aged exactly 18 require the date of birth to be checked before a final decision.",
      sourceName: "PMMVY Frequently Asked Questions, Ministry of Women & Child Development",
      sourceUrl:
        "https://wcd.nic.in/sites/default/files/FINAL%20PMMVY%20%28FAQ%29%20BOOKELT_0.pdf",
      lastVerified: CHECKED,
    },
    {
      code: "PREGNANT_OR_LACTATING",
      kind: "ELIGIBILITY",
      field: "isPregnantOrLactating",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["OTHER"],
      text: "The beneficiary must be a pregnant woman or lactating mother.",
      textHi: "लाभार्थी गर्भवती महिला या स्तनपान कराने वाली माता होनी चाहिए।",
      sourceName: "PMMVY Frequently Asked Questions, Ministry of Women & Child Development",
      sourceUrl:
        "https://wcd.nic.in/sites/default/files/FINAL%20PMMVY%20%28FAQ%29%20BOOKELT_0.pdf",
      lastVerified: CHECKED,
    },
    {
      code: "FIRST_LIVING_CHILD",
      kind: "ELIGIBILITY",
      field: "isFirstLivingChild",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["OTHER"],
      text: "The benefit is for the first living child of the family; since 1 April 2022 it also applies to a second child if that child is a girl.",
      sourceName: "PMMVY Frequently Asked Questions, Ministry of Women & Child Development",
      sourceUrl:
        "https://wcd.nic.in/sites/default/files/FINAL%20PMMVY%20%28FAQ%29%20BOOKELT_0.pdf",
      lastVerified: CHECKED,
    },
    {
      code: "INCOME_UNDER_8_LAKH",
      kind: "ELIGIBILITY",
      field: "annualIncomeRupees",
      op: "lte",
      value: 800000,
      mandatory: false,
      evidenceDocs: ["INCOME_CERTIFICATE"],
      text: "Eligible categories include women whose net family income is less than ₹8 lakh per annum, alongside several other qualifying categories.",
      sourceName: "PMMVY Frequently Asked Questions, Ministry of Women & Child Development",
      sourceUrl:
        "https://wcd.nic.in/sites/default/files/FINAL%20PMMVY%20%28FAQ%29%20BOOKELT_0.pdf",
      lastVerified: CHECKED,
    },
    {
      code: "HAS_BANK_ACCOUNT",
      kind: "DEPENDENCY",
      field: "hasBankAccount",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["BANK_PASSBOOK"],
      text: "The cash incentive is credited directly to the beneficiary's bank or post office account.",
      sourceName: "PMMVY Frequently Asked Questions, Ministry of Women & Child Development",
      sourceUrl:
        "https://wcd.nic.in/sites/default/files/FINAL%20PMMVY%20%28FAQ%29%20BOOKELT_0.pdf",
      lastVerified: CHECKED,
    },
  ],
};

// ---------------------------------------------------------------------------
// 9. MGNREGA
// ---------------------------------------------------------------------------

const MGNREGA: SchemeSpec = {
  code: "MGNREGA",
  name: "Mahatma Gandhi National Rural Employment Guarantee Scheme",
  nameHi: "महात्मा गांधी राष्ट्रीय ग्रामीण रोजगार गारंटी योजना",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Employment Guarantee",
  description:
    "A legal guarantee of at least 100 days of wage employment in a financial year to every rural household whose adult members volunteer to do unskilled manual work.",
  descriptionHi:
    "प्रत्येक ग्रामीण परिवार को वित्तीय वर्ष में कम से कम 100 दिन के रोजगार की कानूनी गारंटी।",
  benefitType: "SERVICE",
  benefitAmountRupees: null,
  benefitNote:
    "A guarantee of up to 100 days of work per household per financial year. The daily wage is notified separately for each State, so no single rupee amount applies nationally and the expected cash value is deliberately null rather than zero.",
  frequency: "AS_NEEDED",
  applicationMethod:
    "Apply to the Gram Panchayat for a job card, then submit a written work application for employment.",
  applicationUrl: "https://nrega.nic.in/",
  requiredDocuments: ["AADHAAR", "JOB_CARD", "BANK_PASSBOOK", "RESIDENCE_PROOF", "PHOTOGRAPH"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "state", label: "State", type: "text", required: true, fromProfileField: "state" },
    { key: "district", label: "District", type: "text", required: true, fromProfileField: "district" },
    { key: "householdSize", label: "Number of adult members", type: "number", required: true, fromProfileField: "householdSize" },
    { key: "bankAccountNumber", label: "Bank account number", type: "text", required: true },
    { key: "ifscCode", label: "IFSC code", type: "text", required: true, validation: "11 characters" },
  ],
  sourceName: "Ministry of Rural Development, MGNREGA",
  sourceUrl: "https://nrega.nic.in/",
  lastVerified: COMPILED,
  verificationStatus: "COMPILED_UNVERIFIED",
  clauses: [
    {
      code: "AGE_18_PLUS",
      kind: "ELIGIBILITY",
      field: "age",
      op: "gte",
      value: 18,
      mandatory: true,
      evidenceDocs: ["AGE_PROOF", "AADHAAR"],
      text: "The applicant must be an adult aged 18 years or above.",
      textHi: "आवेदक की आयु 18 वर्ष या अधिक होनी चाहिए।",
      sourceName: "Mahatma Gandhi NREGA, 2005",
      sourceUrl: "https://nrega.nic.in/MGNREGA_new/Nrega_home.aspx",
      lastVerified: COMPILED,
    },
    {
      code: "RURAL_HOUSEHOLD",
      kind: "ELIGIBILITY",
      field: "ruralUrban",
      op: "eq",
      value: "rural",
      mandatory: true,
      evidenceDocs: ["RESIDENCE_PROOF"],
      text: "The applicant must be a member of a rural household resident in the Gram Panchayat area.",
      textHi: "आवेदक ग्राम पंचायत क्षेत्र के ग्रामीण परिवार का सदस्य होना चाहिए।",
      sourceName: "Mahatma Gandhi NREGA, 2005",
      sourceUrl: "https://nrega.nic.in/MGNREGA_new/Nrega_home.aspx",
      lastVerified: COMPILED,
    },
    {
      code: "HAS_JOB_CARD",
      kind: "DEPENDENCY",
      field: "hasJobCard",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["JOB_CARD"],
      text: "A registered job card issued by the Gram Panchayat is required before employment can be demanded.",
      textHi: "रोजगार की मांग करने से पहले ग्राम पंचायत द्वारा जारी पंजीकृत जॉब कार्ड आवश्यक है।",
      sourceName: "Mahatma Gandhi NREGA, 2005",
      sourceUrl: "https://nrega.nic.in/MGNREGA_new/Nrega_home.aspx",
      lastVerified: COMPILED,
    },
    {
      code: "WILLING_UNSKILLED_WORK",
      kind: "ELIGIBILITY",
      field: "employmentStatus",
      op: "not_in",
      value: ["SALARIED_FORMAL", "GOVERNMENT_SERVICE"],
      mandatory: false,
      evidenceDocs: [],
      text: "The guarantee applies to adult members volunteering to do unskilled manual work.",
      sourceName: "Mahatma Gandhi NREGA, 2005",
      sourceUrl: "https://nrega.nic.in/MGNREGA_new/Nrega_home.aspx",
      lastVerified: COMPILED,
    },
    {
      code: "HAS_BANK_ACCOUNT",
      kind: "DEPENDENCY",
      field: "hasBankAccount",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["BANK_PASSBOOK"],
      text: "Wages are paid electronically into the worker's bank or post office account.",
      sourceName: "Mahatma Gandhi NREGA, 2005",
      sourceUrl: "https://nrega.nic.in/MGNREGA_new/Nrega_home.aspx",
      lastVerified: COMPILED,
    },
  ],
};

// ---------------------------------------------------------------------------
// 10. PM Vishwakarma
// ---------------------------------------------------------------------------

const PM_VISHWAKARMA: SchemeSpec = {
  code: "PM-VISHWAKARMA",
  name: "PM Vishwakarma",
  nameHi: "पीएम विश्वकर्मा",
  governmentLevel: "CENTRAL",
  states: [],
  category: "Artisan & Craft Livelihood",
  description:
    "Support for traditional artisans and craftspeople: skill training with a stipend, a ₹15,000 toolkit incentive, and collateral-free credit of ₹1,00,000 followed by ₹2,00,000 at a concessional interest rate.",
  descriptionHi:
    "पारंपरिक शिल्पकारों के लिए कौशल प्रशिक्षण, ₹15,000 टूलकिट प्रोत्साहन और संपार्श्विक-मुक्त ऋण।",
  benefitType: "LOAN",
  benefitAmountRupees: 15000,
  benefitNote:
    "The ₹15,000 toolkit incentive is the direct cash component modelled here. The credit component (₹1,00,000 then ₹2,00,000 collateral-free) is a loan, not a transfer, and is not treated as expected income.",
  frequency: "ONE_TIME",
  applicationMethod:
    "Registration through a Common Service Centre with three-stage verification by the Gram Panchayat or Urban Local Body, District and Screening Committee.",
  applicationUrl: "https://pmvishwakarma.gov.in/",
  requiredDocuments: ["AADHAAR", "BANK_PASSBOOK", "RESIDENCE_PROOF"],
  formSchema: [
    { key: "aadhaarNumber", label: "Aadhaar number", type: "text", required: true, validation: "12 digits" },
    { key: "fullName", label: "Full name", type: "text", required: true },
    { key: "artisanTrade", label: "Trade", type: "select", required: true, fromProfileField: "artisanTrade", options: ["CARPENTER", "BLACKSMITH", "GOLDSMITH", "POTTER", "COBBLER", "MASON", "BASKET_WEAVER", "BARBER", "GARLAND_MAKER", "WASHERMAN", "TAILOR", "BOAT_MAKER", "ARMOURER", "HAMMER_TOOLKIT_MAKER", "LOCKSMITH", "SCULPTOR", "FISHING_NET_MAKER", "DOLL_TOY_MAKER"] },
    { key: "state", label: "State", type: "text", required: true, fromProfileField: "state" },
    { key: "district", label: "District", type: "text", required: true, fromProfileField: "district" },
    { key: "bankAccountNumber", label: "Bank account number", type: "text", required: true },
    { key: "ifscCode", label: "IFSC code", type: "text", required: true, validation: "11 characters" },
  ],
  sourceName: "Ministry of Micro, Small & Medium Enterprises, PM Vishwakarma",
  sourceUrl: "https://pmvishwakarma.gov.in/",
  lastVerified: COMPILED,
  verificationStatus: "COMPILED_UNVERIFIED",
  clauses: [
    {
      code: "AGE_18_PLUS",
      kind: "ELIGIBILITY",
      field: "age",
      op: "gte",
      value: 18,
      mandatory: true,
      evidenceDocs: ["AGE_PROOF", "AADHAAR"],
      text: "The artisan or craftsperson must have completed 18 years of age on the date of registration.",
      sourceName: "PM Vishwakarma Scheme Guidelines",
      sourceUrl: "https://pmvishwakarma.gov.in/",
      lastVerified: COMPILED,
    },
    {
      code: "IS_ARTISAN",
      kind: "ELIGIBILITY",
      field: "isArtisan",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: [],
      text: "The applicant must be a traditional artisan or craftsperson working with their hands and tools in an unorganised, self-employed capacity.",
      textHi:
        "आवेदक अपने हाथों और औजारों से काम करने वाला पारंपरिक शिल्पकार होना चाहिए।",
      sourceName: "PM Vishwakarma Scheme Guidelines",
      sourceUrl: "https://pmvishwakarma.gov.in/",
      lastVerified: COMPILED,
    },
    {
      code: "TRADE_IN_COVERED_LIST",
      kind: "ELIGIBILITY",
      field: "artisanTrade",
      op: "in",
      value: [
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
      ],
      mandatory: true,
      evidenceDocs: [],
      text: "The applicant's trade must be one of the eighteen family-based traditional trades covered by the scheme.",
      sourceName: "PM Vishwakarma Scheme Guidelines",
      sourceUrl: "https://pmvishwakarma.gov.in/",
      lastVerified: COMPILED,
    },
    {
      code: "EXCL_GOVERNMENT_EMPLOYEE",
      kind: "EXCLUSION",
      field: "isGovernmentEmployee",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: [],
      text: "Government employees and their family members are not eligible under the scheme.",
      sourceName: "PM Vishwakarma Scheme Guidelines",
      sourceUrl: "https://pmvishwakarma.gov.in/",
      lastVerified: COMPILED,
    },
    {
      code: "HAS_BANK_ACCOUNT",
      kind: "DEPENDENCY",
      field: "hasBankAccount",
      op: "is_true",
      value: true,
      mandatory: true,
      evidenceDocs: ["BANK_PASSBOOK"],
      text: "A bank account is required for the toolkit incentive and for the credit component.",
      sourceName: "PM Vishwakarma Scheme Guidelines",
      sourceUrl: "https://pmvishwakarma.gov.in/",
      lastVerified: COMPILED,
    },
  ],
};

/** All registry schemes, in dashboard display order. */
export const SCHEMES: readonly SchemeSpec[] = [
  PM_KISAN,
  IGNOAPS,
  IGNWPS,
  IGNDPS,
  PM_JAY,
  PMAY_G,
  NFSA,
  PMMVY,
  MGNREGA,
  PM_VISHWAKARMA,
];
