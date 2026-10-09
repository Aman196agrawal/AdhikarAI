/**
 * What a single payment was expected to be.
 *
 * One function, used by the audit, the receipt question and the bank check, so
 * the three can never disagree about it. They did: each computed its own,
 * from the entitlement's total.
 *
 * For a benefit paid in stages, the expectation for one disbursement is that
 * stage - what the government says it released - not the whole entitlement.
 * Otherwise the not-yet-due remainder is reported as proven missing money, and
 * a bank statement is searched for a credit far larger than the one sent.
 */

import { paise, type Paise } from "@/lib/engine/money";
import { getScheme } from "@/lib/registry";

export function expectedForPayment(input: {
  schemeCode: string;
  /** The entitlement's per-instalment amount. Null for in-kind benefits. */
  entitlementExpected: bigint | null;
  /** What the government reports releasing for this payment. */
  reportedAmount: bigint;
  /** Whether this disbursement actually left the treasury. */
  released?: boolean;
}): Paise | null {
  const staged = getScheme(input.schemeCode)?.paidInStages === true;

  if (staged && (input.released ?? true)) return paise(input.reportedAmount);
  if (input.entitlementExpected === null) return null;
  return paise(input.entitlementExpected);
}
