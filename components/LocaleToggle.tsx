/**
 * The language switch.
 *
 * A server action rather than client state: the choice has to survive a
 * reload and apply to server-rendered pages, and this audience is the last
 * one to make wait for a hydration round-trip.
 */

import { LOCALE_LABEL, otherLocale, type Locale } from "@/lib/i18n";
import { LOCALE_COOKIE } from "@/lib/locale";

async function switchLocale(formData: FormData): Promise<void> {
  "use server";

  const { cookies } = await import("next/headers");
  const { revalidatePath } = await import("next/cache");

  const next = String(formData.get("locale") ?? "en");
  const store = await cookies();
  store.set(LOCALE_COOKIE, next, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });

  revalidatePath("/", "layout");
}

export function LocaleToggle({ locale }: { locale: Locale }) {
  const next = otherLocale(locale);

  return (
    <form action={switchLocale}>
      <input type="hidden" name="locale" value={next} />
      <button
        type="submit"
        className="rounded-[var(--radius-card)] border bg-surface px-3 py-2 text-sm font-medium hover:bg-surface-sunken"
        lang={next}
      >
        {LOCALE_LABEL[next]}
      </button>
    </form>
  );
}
