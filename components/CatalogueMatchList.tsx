/**
 * Catalogue matches: schemes from the synced myScheme list that a citizen may
 * qualify for, beyond the payment-tracked benefits on the dashboard.
 *
 * A server component with no interactivity, so labels arrive as plain strings
 * (never functions) and nothing here can cross into client code by accident.
 *
 * Every card links to the scheme's official page and the list states its
 * source and age: these are leads to confirm, not decisions, and a citizen
 * must be able to see how fresh the information is.
 */

import type { CatalogueMatch } from "@/lib/catalogue/match";
import { Card, StatusPill, VerdictBadge } from "@/components/ui";

export interface CatalogueLabels {
  possible: string;
  meantFor: string;
  toConfirm: string;
  official: string;
  closes: string;
}

function MatchVerdict({ verdict, possible }: { verdict: CatalogueMatch["verdict"]; possible: string }) {
  if (verdict === "POSSIBLE") {
    return (
      <StatusPill tone="neutral" icon="?">
        {possible}
      </StatusPill>
    );
  }
  return <VerdictBadge verdict={verdict} />;
}

export function CatalogueMatchList({
  matches,
  labels,
  locale,
}: {
  matches: CatalogueMatch[];
  labels: CatalogueLabels;
  locale: "en" | "hi";
}) {
  return (
    <ul className="space-y-3">
      {matches.map((match) => (
        <Card as="li" key={`${match.source}-${match.externalId}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="font-semibold">
                {locale === "hi" && match.nameHi ? match.nameHi : match.name}
              </p>
              <p className="text-sm text-subtle">
                {match.level === "State" && match.states.length > 0
                  ? match.states.join(", ")
                  : match.ministry ?? match.level}
              </p>
            </div>
            <MatchVerdict verdict={match.verdict} possible={labels.possible} />
          </div>

          {match.briefDescription ? (
            <p className="mt-2 text-sm text-muted">{match.briefDescription}</p>
          ) : null}

          {match.matchedOn.length > 0 ? (
            <p className="mt-2 text-sm">
              <span className="text-subtle">{labels.meantFor}: </span>
              {match.matchedOn.join(" · ")}
            </p>
          ) : null}

          {match.toConfirm.length > 0 ? (
            <div className="mt-2 rounded-[var(--radius-card)] border border-[var(--warn-border)] bg-[var(--warn-soft)] px-3 py-2 text-sm text-[var(--warn)]">
              <p className="font-medium">{labels.toConfirm}:</p>
              <ul className="mt-1 list-disc pl-5">
                {match.toConfirm.slice(0, 4).map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <a
              href={match.officialUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-accent hover:underline"
            >
              {labels.official} ↗
            </a>
            {match.closesOn ? (
              <span className="text-subtle">
                {labels.closes}: {match.closesOn}
              </span>
            ) : null}
          </div>
        </Card>
      ))}
    </ul>
  );
}
