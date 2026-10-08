/**
 * Intake.
 *
 * Completes the lifecycle's first step: a citizen describes their
 * circumstances and the system builds a structured, provenance-tagged profile
 * from it. The demo normally starts from a seeded persona, but this is where
 * a real one would begin, and it is worth showing — the extraction, the
 * validation that discards what it cannot trust, and the questions computed
 * from what the scheme rules actually need.
 */

import Link from "next/link";

import { PROFILE_FIELD_SPECS, isProfileFieldKey } from "@/lib/profile/fields";
import { missingFieldQuestions } from "@/lib/agents/profileAgent";
import { loadProfile } from "@/lib/services/profile";
import { requireSelectedCitizen } from "@/lib/session";
import { resolveLocale } from "@/lib/locale";
import { LocaleToggle } from "@/components/LocaleToggle";
import { OnboardChat } from "@/components/OnboardChat";
import { buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function OnboardPage() {
  const citizen = await requireSelectedCitizen();
  const locale = await resolveLocale(citizen.locale);
  const profile = await loadProfile(citizen.citizenId);

  const fields = Object.entries(profile).map(([key, field]) => ({
    key,
    label: isProfileFieldKey(key) ? PROFILE_FIELD_SPECS[key].label : key,
    value: (field?.value ?? null) as unknown,
    provenance: field?.provenance ?? "MISSING",
  }));

  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-accent">
            AdhikarAI
          </p>
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
            {locale === "hi" ? `नमस्ते, ${citizen.name}` : `Hello, ${citizen.name}`}
          </h1>
        </div>
        <div className="flex gap-2">
          <LocaleToggle locale={locale} />
          <Link href="/dashboard" className={buttonClass.secondary}>
            {locale === "hi" ? "मेरे लाभ" : "My benefits"}
          </Link>
        </div>
      </div>

      <p className="mt-4 text-muted">
        {locale === "hi"
          ? "कोई लंबा फ़ॉर्म नहीं। बस अपने बारे में बताइए, और हम देखेंगे कि आपको कौन-कौन से सरकारी लाभ मिलने चाहिए।"
          : "No long form. Just tell us about yourself, and we will work out which government benefits you should be receiving."}
      </p>

      <div className="mt-6">
        <OnboardChat
          citizenId={citizen.citizenId}
          locale={locale}
          initialFields={fields}
          initialQuestions={missingFieldQuestions(profile)}
        />
      </div>
    </main>
  );
}
