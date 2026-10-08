/**
 * Choosing the locale for a request.
 *
 * Order of preference: an explicit choice the person made (cookie), then the
 * locale on their citizen record, then English. The citizen record matters —
 * Sunita Devi is seeded as a Hindi speaker, so her screens come up in Hindi
 * without anyone touching a toggle, which is what it would do in reality.
 */

import { cookies } from "next/headers";

import { isLocale, type Locale } from "@/lib/i18n";

export const LOCALE_COOKIE = "adhikarai_locale";

export async function resolveLocale(citizenLocale?: string): Promise<Locale> {
  const store = await cookies();
  const chosen = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(chosen)) return chosen;
  if (isLocale(citizenLocale)) return citizenLocale;
  return "en";
}
