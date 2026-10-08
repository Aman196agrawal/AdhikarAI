/**
 * The demo console.
 *
 * Deliberately a separate screen with its own visual treatment, and gated on
 * DEMO_MODE. It drives the simulated government and the clock — the two
 * things being faked — and must never be mistaken for the citizen product.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { isDemoMode } from "@/lib/authz";
import { realNow } from "@/lib/clock";
import { prisma } from "@/lib/db";
import { currentClock } from "@/lib/services/clock";
import { requireSelectedCitizen } from "@/lib/session";
import { DemoConsole } from "@/components/DemoConsole";
import { Card, EmptyState, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function DemoPage() {
  // Not merely hidden: the whole surface does not exist outside demo mode.
  if (!isDemoMode()) notFound();

  const citizen = await requireSelectedCitizen();
  const clock = await currentClock();

  const entitlements = await prisma.entitlement.findMany({
    where: { citizenId: citizen.citizenId },
    include: { scheme: { select: { code: true, name: true } }, application: true },
    orderBy: [{ verdict: "asc" }, { confidence: "desc" }],
  });

  const benefits = entitlements.map((row) => ({
    id: row.id,
    schemeCode: row.scheme.code,
    schemeName: row.scheme.name,
    lifecycleState: row.lifecycleState,
    hasApplication: row.application?.govApplicationRef != null,
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-[var(--demo)]">
            ▲ Demo console
          </p>
          <h1 className="mt-1 text-2xl font-bold sm:text-3xl">
            Drive the simulation
          </h1>
        </div>
        <div className="flex gap-2">
          <Link href="/dashboard" className={buttonClass.secondary}>
            Citizen view
          </Link>
          <Link href="/" className={buttonClass.secondary}>
            Switch person
          </Link>
        </div>
      </div>

      <Card className="mt-5 border-[var(--demo-border)] bg-[var(--demo-soft)]">
        <p className="text-sm leading-relaxed text-[var(--demo)]">
          <strong className="font-semibold">This is not the product.</strong>{" "}
          This panel controls the two things that are simulated: the government
          portal and the date. AdhikarAI itself is unchanged — it reads the
          government&rsquo;s records through the same adapter it would use
          against a real API, and reaches its own conclusions. Nothing here
          tells the citizen screen what to display.
        </p>
      </Card>

      <div className="mt-6">
        {benefits.length === 0 ? (
          <EmptyState>
            This person has no benefits worked out yet. Run{" "}
            <code className="rounded bg-surface-sunken px-1.5 py-0.5">
              npm run seed:all
            </code>
            .
          </EmptyState>
        ) : (
          <DemoConsole
            citizenId={citizen.citizenId}
            citizenName={citizen.name}
            benefits={benefits}
            clockNow={clock.now().toISOString()}
            clockIsSimulated={clock.isSimulated}
            realNow={realNow().toISOString()}
          />
        )}
      </div>
    </main>
  );
}
