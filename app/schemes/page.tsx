/**
 * Every catalogue scheme the selected citizen may qualify for.
 *
 * The dashboard shows the first few; this is the full list. Deterministic and
 * read-only, like /api/catalogue/matches, which it mirrors.
 */

import Link from "next/link";

import { CatalogueMatchList } from "@/components/CatalogueMatchList";
import { LocaleToggle } from "@/components/LocaleToggle";
import { EmptyState, SectionHeading } from "@/components/ui";
import { matchCatalogue } from "@/lib/catalogue/match";
import { systemClock } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { translator } from "@/lib/i18n";
import { resolveLocale } from "@/lib/locale";
import { loadProfile } from "@/lib/services/profile";
import { requireSelectedCitizen } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function SchemesPage() {
  const citizen = await requireSelectedCitizen();
  const locale = await resolveLocale(citizen.locale);
  const t = translator(locale);

  const profile = await loadProfile(citizen.citizenId);
  const result = await matchCatalogue({ profile, clock: systemClock(), limit: 200 });
  const lastRun = await prisma.schemeSyncRun.findFirst({
    where: { status: { in: ["SUCCEEDED", "PARTIAL"] } },
    orderBy: { startedAt: "desc" },
    select: { finishedAt: true },
  });

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link href="/dashboard" className="text-sm font-medium text-accent hover:underline">
          ← {t("app.backToBenefits")}
        </Link>
        <LocaleToggle locale={locale} />
      </div>

      <section className="mt-6">
        <SectionHeading hint={t("catalogue.hint")}>
          {t("catalogue.heading")} ({result.total})
        </SectionHeading>

        {result.total === 0 ? (
          <EmptyState>{t("catalogue.notLoaded")}</EmptyState>
        ) : (
          <CatalogueMatchList
            matches={result.matches}
            locale={locale}
            labels={{
              possible: t("catalogue.possible"),
              meantFor: t("catalogue.meantFor"),
              toConfirm: t("catalogue.toConfirm"),
              official: t("catalogue.official"),
              closes: t("catalogue.closes"),
            }}
          />
        )}

        <p className="mt-6 text-xs text-subtle">
          {t("catalogue.source")}:{" "}
          {lastRun?.finishedAt ? lastRun.finishedAt.toISOString().slice(0, 10) : "—"}
        </p>
      </section>
    </main>
  );
}
