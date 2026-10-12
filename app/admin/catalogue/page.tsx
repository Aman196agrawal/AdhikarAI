/**
 * /admin/catalogue - review AI-drafted rules for synced myScheme schemes.
 *
 * The page itself is public but empty; every piece of data comes from the
 * admin API, which requires ADMIN_TOKEN (and returns 404 when none is set).
 */

import { CatalogueReview } from "@/components/CatalogueReview";

export const dynamic = "force-dynamic";

export default function AdminCataloguePage() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <p className="text-sm font-semibold uppercase tracking-wider text-accent">AdhikarAI · Admin</p>
      <h1 className="mt-1 text-2xl font-bold">Scheme catalogue review</h1>
      <p className="mt-1 max-w-3xl text-muted">
        Rules are drafted by AI from myScheme&apos;s eligibility text. Nothing here reaches a citizen as
        “You qualify” until a person has approved every drafted rule for the scheme&apos;s current text. If the
        text changes, approvals stop counting automatically.
      </p>
      <div className="mt-8">
        <CatalogueReview />
      </div>
    </main>
  );
}
