import { describe, expect, it } from "vitest";

import {
  LOCALES,
  isLocale,
  otherLocale,
  translator,
  type StringKey,
} from "@/lib/i18n";

const en = translator("en");
const hi = translator("hi");

/**
 * A spread of keys across every surface. Deliberately a sample rather than a
 * generated list: the Hindi table is typed as `Record<StringKey, string>`, so
 * a missing translation is already a compile error. What a test adds is a
 * check on the *quality* of what is there, which only matters for strings a
 * person actually reads.
 */
const SAMPLED_KEYS: StringKey[] = [
  "app.prototypeNotice",
  "app.switchPerson",
  "home.tagline1",
  "home.intro",
  "actions.askHeading",
  "receipt.question",
  "receipt.yes",
  "receipt.no",
  "receipt.notSure",
  "money.received",
  "money.unverified",
  "money.missing",
  "money.potential",
  "status.notConfirmed",
  "status.didNotReach",
  "group.needsAction",
  "why.label",
  "bank.heading",
];

describe("locales", () => {
  it("recognises the supported locales", () => {
    expect(LOCALES).toEqual(["en", "hi"]);
    expect(isLocale("hi")).toBe(true);
    expect(isLocale("fr")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
  });

  it("toggles between the two", () => {
    expect(otherLocale("en")).toBe("hi");
    expect(otherLocale("hi")).toBe("en");
  });
});

describe("translations exist and differ", () => {
  it("returns Devanagari for Hindi on every sampled key", () => {
    for (const key of SAMPLED_KEYS) {
      const value = hi(key);
      expect(value, key).not.toBe("");
      expect(value, key).toMatch(/[ऀ-ॿ]/);
    }
  });

  it("does not leave English text in the Hindi table", () => {
    for (const key of SAMPLED_KEYS) {
      expect(hi(key), key).not.toBe(en(key));
    }
  });

  it("never returns a raw key", () => {
    for (const key of SAMPLED_KEYS) {
      expect(en(key), key).not.toBe(key);
      expect(hi(key), key).not.toBe(key);
    }
  });
});

describe("THE distinction survives translation", () => {
  it("keeps 'not yet confirmed' and 'did not arrive' clearly different", () => {
    // If these two collapsed in Hindi, a Hindi-speaking citizen would be told
    // money was lost when it is merely unconfirmed. That is the exact failure
    // the entire system is built to prevent, and a translation is just as
    // capable of causing it as a data model.
    expect(hi("money.unverified")).not.toBe(hi("money.missing"));
    expect(hi("status.notConfirmed")).not.toBe(hi("status.didNotReach"));
  });

  it("states in Hindi that unconfirmed is NOT missing", () => {
    // The hedge is the whole point of the figure; it must survive.
    expect(hi("money.unverifiedHedge")).toMatch(/गुम नहीं/);
  });

  it("keeps the three answers distinct", () => {
    const answers = [hi("receipt.yes"), hi("receipt.no"), hi("receipt.notSure")];
    expect(new Set(answers).size).toBe(3);
  });

  it("offers 'not sure' as a legitimate answer in Hindi too", () => {
    expect(hi("receipt.notSureIsFine")).toMatch(/ठीक है/);
  });
});

describe("the prototype warning is translated", () => {
  it("says the government data is simulated, in both languages", () => {
    // A citizen reading Hindi must get the same caveat, not a silent
    // fallback to a sentence they cannot read.
    expect(en("app.prototypeNotice")).toMatch(/simulated/i);
    expect(hi("app.prototypeNotice")).toMatch(/नकली/);
  });
});

describe("the privacy promise is translated", () => {
  it("states in Hindi what is not kept", () => {
    expect(hi("bank.keep3")).toMatch(/दस्तावेज़/);
    expect(hi("bank.keep3")).toMatch(/खाता नंबर/);
  });
});
