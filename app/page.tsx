/**
 * The persona selector: the demo's front door.
 *
 * Stands in for a login. Choosing a persona sets a cookie and goes to the
 * dashboard. See lib/session.ts for why this is confined to one place.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { isDemoMode } from "@/lib/authz";
import { CITIZEN_COOKIE } from "@/lib/session";
import { Card, EmptyState, Money, buttonClass } from "@/components/ui";

export const dynamic = "force-dynamic";

async function choosePersona(formData: FormData): Promise<void> {
  "use server";

  const { cookies } = await import("next/headers");
  const citizenId = String(formData.get("citizenId") ?? "");
  if (citizenId === "") return;

  const store = await cookies();
  store.set(CITIZEN_COOKIE, citizenId, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 12,
  });

  redirect("/dashboard");
}

export default async function HomePage() {
  const demoMode = isDemoMode();

  const personas = await prisma.demoPersona.findMany({
    where: { citizenId: { not: null } },
    orderBy: { position: "asc" },
    include: {
      citizen: {
        select: { nameHi: true, locale: true },
      },
    },
  });

  // Headline figures per persona, so the chooser previews what each one shows.
  const summaries = new Map<
    string,
    { received: bigint; unverified: bigint; missing: bigint; open: number }
  >();

  for (const persona of personas) {
    if (!persona.citizenId) continue;
    const ledgers = await prisma.benefitLedger.findMany({
      where: { entitlement: { citizenId: persona.citizenId } },
    });
    const open = await prisma.benefitGap.count({
      where: { entitlement: { citizenId: persona.citizenId }, resolvedAt: null },
    });
    summaries.set(persona.citizenId, {
      received: ledgers.reduce((n, l) => n + l.receivedAmountPaise, 0n),
      unverified: ledgers.reduce((n, l) => n + l.unverifiedAmountPaise, 0n),
      missing: ledgers.reduce((n, l) => n + l.gapAmountPaise, 0n),
      open,
    });
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <header>
        <p className="text-sm font-semibold uppercase tracking-wider text-accent">
          AdhikarAI
        </p>
        <h1 className="mt-2 text-balance text-3xl font-bold leading-tight sm:text-4xl">
          Finding your benefits isn&rsquo;t enough.
        </h1>
        <p className="mt-1 text-balance text-2xl font-semibold text-muted sm:text-3xl">
          We make sure you receive them.
        </p>
        <p className="mt-5 max-w-2xl text-muted">
          Most systems stop once they have told you which schemes you qualify
          for. This one keeps going: it checks what the government actually did,
          asks whether the money reached you, works out why when it didn&rsquo;t,
          and keeps watching afterwards.
        </p>
      </header>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Choose someone to follow</h2>
        <p className="mt-0.5 text-sm text-muted">
          There is no sign-in in this prototype. Pick a person to see their
          benefits.
        </p>

        {personas.length === 0 ? (
          <div className="mt-4">
            <EmptyState>
              No demo people have been set up yet. Run{" "}
              <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-sm">
                npm run seed:all
              </code>{" "}
              to create them.
              {!demoMode ? (
                <>
                  <br />
                  <span className="mt-2 inline-block">
                    Demo mode is also off. Set{" "}
                    <code className="rounded bg-surface-sunken px-1.5 py-0.5 text-sm">
                      DEMO_MODE=true
                    </code>
                    .
                  </span>
                </>
              ) : null}
            </EmptyState>
          </div>
        ) : (
          <ul className="mt-4 space-y-3">
            {personas.map((persona) => {
              const summary = persona.citizenId
                ? summaries.get(persona.citizenId)
                : undefined;

              return (
                <Card as="li" key={persona.id} className="sm:flex sm:items-center sm:gap-5">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-lg font-semibold">
                      {persona.label}
                      {persona.citizen?.nameHi ? (
                        <span className="ml-2 text-base font-normal text-subtle">
                          {persona.citizen.nameHi}
                        </span>
                      ) : null}
                    </h3>
                    <p className="mt-0.5 text-sm text-muted">{persona.description}</p>

                    {summary ? (
                      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                        <div>
                          <dt className="inline text-subtle">Received </dt>
                          <dd className="inline font-semibold tabular text-[var(--ok)]">
                            <Money paise={summary.received.toString()} />
                          </dd>
                        </div>
                        <div>
                          <dt className="inline text-subtle">Unconfirmed </dt>
                          <dd className="inline font-semibold tabular text-[var(--warn)]">
                            <Money paise={summary.unverified.toString()} />
                          </dd>
                        </div>
                        <div>
                          <dt className="inline text-subtle">Did not arrive </dt>
                          <dd className="inline font-semibold tabular text-[var(--bad)]">
                            <Money paise={summary.missing.toString()} />
                          </dd>
                        </div>
                      </dl>
                    ) : null}
                  </div>

                  <form action={choosePersona} className="mt-4 shrink-0 sm:mt-0">
                    <input type="hidden" name="citizenId" value={persona.citizenId ?? ""} />
                    <button type="submit" className={buttonClass.primary}>
                      Open
                      <span aria-hidden="true">→</span>
                    </button>
                  </form>
                </Card>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-10 rounded-[var(--radius-panel)] border bg-surface-sunken p-5">
        <h2 className="font-semibold">The distinction this is built around</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          Four different things are tracked separately and never merged: what
          you <strong className="text-foreground">should</strong> receive, what
          the government <strong className="text-foreground">says</strong> it
          sent, what you <strong className="text-foreground">tell us</strong>{" "}
          happened, and what the{" "}
          <strong className="text-foreground">evidence proves</strong>. A payment
          nobody has confirmed is shown as unconfirmed — never as received, and
          never as lost.
        </p>
        {demoMode ? (
          <Link
            href="/demo"
            className="mt-4 inline-block text-sm font-medium text-accent hover:underline"
          >
            Open the demo console →
          </Link>
        ) : null}
      </section>
    </main>
  );
}
