/**
 * Bilingual strings.
 *
 * The stated audience is rural and often elderly Indian citizens, so Hindi is
 * not a nice-to-have on this product — it is a condition of the thing working
 * at all for the people it names.
 *
 * Two translation principles, both of which cost precision and are worth it:
 *
 *   1. Everyday register, not administrative Hindi. A pension claimant should
 *      not need to parse "संवितरण" to find out whether her money arrived. The
 *      Hindi here is closer to how the question would be asked out loud.
 *   2. The distinction survives translation. "Not yet confirmed" and "did not
 *      arrive" must remain obviously different statements in Hindi, because
 *      collapsing them is the exact failure the whole system is built to
 *      avoid.
 *
 * Scheme names, descriptions and clause text are NOT here: they come from the
 * registry, which carries its own `nameHi`, `descriptionHi` and `textHi` from
 * the official source.
 */

export type Locale = "en" | "hi";

export const LOCALES: readonly Locale[] = ["en", "hi"];

export function isLocale(value: string | undefined | null): value is Locale {
  return value === "en" || value === "hi";
}

const STRINGS = {
  // --- Shell -------------------------------------------------------------
  "app.prototypeNotice":
    "Prototype. Government application and payment data shown here is simulated, not live.",
  "app.switchPerson": "Switch person",
  "app.back": "Back",
  "app.backToBenefits": "Back to all benefits",
  "app.language": "भाषा / Language",

  // --- Home --------------------------------------------------------------
  "home.tagline1": "Finding your benefits isn’t enough.",
  "home.tagline2": "We make sure you receive them.",
  "home.intro":
    "Most systems stop once they have told you which schemes you qualify for. This one keeps going: it checks what the government actually did, asks whether the money reached you, works out why when it didn’t, and keeps watching afterwards.",
  "home.choose": "Choose someone to follow",
  "home.chooseHint":
    "There is no sign-in in this prototype. Pick a person to see their benefits.",
  "home.open": "Open",

  // --- Pending actions ---------------------------------------------------
  "actions.askHeading": "We need to ask you something",
  "actions.askHint": "One question, and it only takes a moment.",
  "actions.approvalHeading": "Waiting for your approval",
  "actions.approvalHint":
    "Nothing is sent or filed on your behalf until you say so.",
  "actions.review": "Review it",

  // --- The receipt question ---------------------------------------------
  "receipt.question": "Did you receive this money?",
  "receipt.yes": "Yes",
  "receipt.no": "No",
  "receipt.notSure": "Not sure",
  "receipt.notSureIsFine":
    "“Not sure” is a perfectly good answer. We will help you check.",
  "receipt.saving": "Saving…",
  "receipt.recorded": "Thank you. We have recorded that.",

  // --- Money totals ------------------------------------------------------
  "money.heading": "Your money",
  "money.headingHint":
    "These four figures are kept apart on purpose. They are not the same kind of claim.",
  "money.received": "Received",
  "money.receivedHedge": "Confirmed by you or proven by evidence",
  "money.unverified": "Not yet confirmed",
  "money.unverifiedHedge": "Reported as sent. Not missing — unconfirmed.",
  "money.missing": "Did not arrive",
  "money.missingHedge": "Proven absent, with evidence",
  "money.potential": "You may be entitled to",
  "money.potentialHedge": "A yearly estimate for benefits not yet claimed",
  "money.expected": "Expected",
  "money.recovered": "recovered",

  // --- Status ------------------------------------------------------------
  "status.receivedVerified": "Received, verified",
  "status.citizenConfirmed": "You confirmed receiving it",
  "status.notConfirmed": "Not yet confirmed",
  "status.didNotReach": "Did not reach you",
  "status.noPaymentYet": "No payment yet",
  "status.qualify": "You qualify",
  "status.mayQualify": "You may qualify",
  "status.doesNotApply": "Does not apply to you",
  "status.allInOrder": "All in order",
  "status.needsAnswer": "Needs your answer",
  "status.needsAction": "Needs action",
  "status.demoData": "Demo data",
  "status.simulatedGovData": "Simulated government data",

  // --- Benefit groups ----------------------------------------------------
  "group.needsAction": "Needs action",
  "group.needsActionHint":
    "Something has gone wrong and we can do something about it.",
  "group.needsChecking": "Needs checking",
  "group.needsCheckingHint":
    "We cannot yet confirm these reached you. That is not the same as them being lost.",
  "group.notClaimed": "Not yet claimed",
  "group.notClaimedHint": "You appear to qualify but have not claimed these.",
  "group.allInOrder": "All in order",
  "group.allInOrderHint": "Arriving as they should. We keep watching anyway.",
  "group.doesNotApply": "Does not apply",
  "group.doesNotApplyHint":
    "These do not apply to you. We show them so you can see we checked, and why.",
  "group.seeEverything": "See everything about this benefit",

  // --- Why drawer --------------------------------------------------------
  "why.label": "Why?",
  "why.showRules": "Why? Show every rule and its official source",
  "why.howDoWeKnow": "How do we know?",
  "why.met": "Met",
  "why.notMet": "Not met",
  "why.unknown": "Unknown",
  "why.fromDocument": "from a document",
  "why.youToldUs": "you told us",
  "why.inferred": "worked out from what you said",
  "why.notEstablished": "not established",

  // --- Bank evidence -----------------------------------------------------
  "bank.heading": "Shall we check your bank record?",
  "bank.intro":
    "If you have a photo of your passbook page, or a bank statement, we can look for this one payment.",
  "bank.keep1":
    "We look for one payment, of the amount due, around the date it was sent.",
  "bank.keep2":
    "We keep four things: the amount found, its date, the last four characters of its reference, and a fingerprint of the file.",
  "bank.keep3":
    "We do not keep the document, your balance, your account number, or any other transaction on the page.",
  "bank.choose": "Choose a file",
  "bank.checking": "Checking…",
  "bank.limits": "PDF or photo, up to 12 MB. One page showing the payment is enough.",
} as const;

export type StringKey = keyof typeof STRINGS;

/**
 * Hindi. Every key is required, so a missing translation is a type error
 * rather than an English string silently appearing mid-sentence.
 */
const HINDI: Record<StringKey, string> = {
  "app.prototypeNotice":
    "यह एक प्रोटोटाइप है। यहाँ दिखाई गई सरकारी आवेदन और भुगतान जानकारी असली नहीं, नकली है।",
  "app.switchPerson": "व्यक्ति बदलें",
  "app.back": "वापस",
  "app.backToBenefits": "सभी लाभों पर वापस जाएँ",
  "app.language": "भाषा / Language",

  "home.tagline1": "लाभ खोज लेना ही काफ़ी नहीं है।",
  "home.tagline2": "हम यह पक्का करते हैं कि वह आप तक पहुँचे।",
  "home.intro":
    "ज़्यादातर सेवाएँ यह बताकर रुक जाती हैं कि आप किन योजनाओं के पात्र हैं। यह वहाँ से आगे बढ़ती है: देखती है कि सरकार ने असल में क्या किया, पूछती है कि पैसा आप तक पहुँचा या नहीं, न पहुँचने पर कारण पता करती है, और उसके बाद भी नज़र रखती रहती है।",
  "home.choose": "किसी एक व्यक्ति को चुनें",
  "home.chooseHint":
    "इस प्रोटोटाइप में लॉगिन नहीं है। उनके लाभ देखने के लिए कोई व्यक्ति चुनें।",
  "home.open": "खोलें",

  "actions.askHeading": "हमें आपसे कुछ पूछना है",
  "actions.askHint": "बस एक सवाल, और इसमें पल भर लगेगा।",
  "actions.approvalHeading": "आपकी मंज़ूरी का इंतज़ार है",
  "actions.approvalHint":
    "जब तक आप हाँ नहीं कहते, आपकी ओर से कुछ भी नहीं भेजा जाएगा।",
  "actions.review": "देखें",

  "receipt.question": "क्या आपको यह पैसा मिला?",
  "receipt.yes": "हाँ",
  "receipt.no": "नहीं",
  "receipt.notSure": "पता नहीं",
  "receipt.notSureIsFine":
    "“पता नहीं” कहना बिल्कुल ठीक है। हम जाँचने में आपकी मदद करेंगे।",
  "receipt.saving": "सहेजा जा रहा है…",
  "receipt.recorded": "धन्यवाद। हमने यह दर्ज कर लिया है।",

  "money.heading": "आपका पैसा",
  "money.headingHint":
    "ये चारों आँकड़े जान-बूझकर अलग रखे गए हैं। ये एक जैसी बातें नहीं हैं।",
  "money.received": "मिल गया",
  "money.receivedHedge": "आपने पुष्टि की, या सबूत से साबित हुआ",
  "money.unverified": "अभी पुष्टि नहीं",
  "money.unverifiedHedge": "भेजा गया बताया गया है। गुम नहीं — बस पुष्टि बाक़ी है।",
  "money.missing": "नहीं पहुँचा",
  "money.missingHedge": "सबूत के साथ साबित कि नहीं पहुँचा",
  "money.potential": "आपको और मिल सकता है",
  "money.potentialHedge": "जो लाभ अभी नहीं लिए, उनका सालाना अनुमान",
  "money.expected": "मिलना चाहिए",
  "money.recovered": "वापस दिलाया गया",

  "status.receivedVerified": "मिल गया, सत्यापित",
  "status.citizenConfirmed": "आपने मिलने की पुष्टि की",
  "status.notConfirmed": "अभी पुष्टि नहीं",
  "status.didNotReach": "आप तक नहीं पहुँचा",
  "status.noPaymentYet": "अभी कोई भुगतान नहीं",
  "status.qualify": "आप पात्र हैं",
  "status.mayQualify": "आप पात्र हो सकते हैं",
  "status.doesNotApply": "आप पर लागू नहीं",
  "status.allInOrder": "सब ठीक है",
  "status.needsAnswer": "आपके जवाब की ज़रूरत",
  "status.needsAction": "कार्रवाई ज़रूरी",
  "status.demoData": "नमूना जानकारी",
  "status.simulatedGovData": "नकली सरकारी जानकारी",

  "group.needsAction": "कार्रवाई ज़रूरी",
  "group.needsActionHint": "कुछ गड़बड़ हुई है और हम उसे ठीक करवा सकते हैं।",
  "group.needsChecking": "जाँच ज़रूरी",
  "group.needsCheckingHint":
    "हम अभी पक्का नहीं कह सकते कि ये आप तक पहुँचे। इसका मतलब यह नहीं कि ये गुम हो गए।",
  "group.notClaimed": "अभी तक नहीं लिए",
  "group.notClaimedHint": "लगता है आप पात्र हैं, पर आपने अभी तक आवेदन नहीं किया।",
  "group.allInOrder": "सब ठीक है",
  "group.allInOrderHint": "जैसे आने चाहिए वैसे आ रहे हैं। फिर भी हम नज़र रखे हुए हैं।",
  "group.doesNotApply": "लागू नहीं",
  "group.doesNotApplyHint":
    "ये आप पर लागू नहीं होतीं। हम इन्हें इसलिए दिखाते हैं ताकि आप देख सकें कि हमने जाँचा, और क्यों नहीं।",
  "group.seeEverything": "इस लाभ के बारे में सब कुछ देखें",

  "why.label": "क्यों?",
  "why.showRules": "क्यों? हर नियम और उसका आधिकारिक स्रोत देखें",
  "why.howDoWeKnow": "हमें कैसे पता?",
  "why.met": "पूरा हुआ",
  "why.notMet": "पूरा नहीं हुआ",
  "why.unknown": "पता नहीं",
  "why.fromDocument": "दस्तावेज़ से",
  "why.youToldUs": "आपने बताया",
  "why.inferred": "आपकी बात से निकाला गया",
  "why.notEstablished": "तय नहीं हुआ",

  "bank.heading": "क्या हम आपका बैंक रिकॉर्ड देखें?",
  "bank.intro":
    "अगर आपके पास पासबुक के पन्ने की फ़ोटो या बैंक स्टेटमेंट है, तो हम सिर्फ़ इस एक भुगतान को ढूँढ सकते हैं।",
  "bank.keep1":
    "हम सिर्फ़ एक भुगतान ढूँढते हैं — उतनी ही रकम, उसी तारीख़ के आसपास।",
  "bank.keep2":
    "हम चार चीज़ें रखते हैं: मिली हुई रकम, उसकी तारीख़, रेफ़रेंस के आख़िरी चार अक्षर, और फ़ाइल की पहचान।",
  "bank.keep3":
    "हम न दस्तावेज़ रखते हैं, न आपका बैलेंस, न खाता नंबर, और न पन्ने का कोई दूसरा लेन-देन।",
  "bank.choose": "फ़ाइल चुनें",
  "bank.checking": "जाँचा जा रहा है…",
  "bank.limits":
    "PDF या फ़ोटो, 12 MB तक। जिस पन्ने पर भुगतान दिख रहा है, वही काफ़ी है।",
};

const TABLES: Record<Locale, Record<StringKey, string>> = {
  en: STRINGS,
  hi: HINDI,
};

/** A bound translator for one locale. */
export type Translate = (key: StringKey) => string;

export function translator(locale: Locale): Translate {
  const table = TABLES[locale] ?? TABLES.en;
  // Falls back to English rather than showing a raw key: an untranslated
  // sentence is bad, a key like "money.unverified" on screen is worse.
  return (key) => table[key] ?? TABLES.en[key] ?? key;
}

/** The other locale, for a two-way toggle. */
export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "hi" : "en";
}

export const LOCALE_LABEL: Record<Locale, string> = {
  en: "English",
  hi: "हिंदी",
};
