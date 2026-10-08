/**
 * The demo session.
 *
 * A cookie holding the selected persona's id. This is the demo's stand-in for
 * authentication, and it is confined here: pages read the id from this module
 * and pass it explicitly to services, which is the same shape real auth would
 * have. `requireCitizen` in lib/authz.ts still does the authorisation.
 *
 * Deliberately not a security boundary, and it does not pretend to be one.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { requireCitizen, type CitizenContext } from "@/lib/authz";

export const CITIZEN_COOKIE = "adhikarai_citizen";

/** The selected citizen id, or null when no persona has been chosen. */
export async function selectedCitizenId(): Promise<string | null> {
  const store = await cookies();
  const value = store.get(CITIZEN_COOKIE)?.value;
  return value && value.trim() !== "" ? value : null;
}

/**
 * The selected citizen, for a page.
 *
 * Redirects to the persona chooser when the cookie is missing, stale, or
 * points at a citizen that no longer exists — which happens routinely in
 * development after re-seeding. A page is a person looking at a screen, so an
 * unusable session should send them somewhere they can act, not show them a
 * server error.
 */
export async function requireSelectedCitizen(): Promise<CitizenContext> {
  const id = await selectedCitizenId();
  if (!id) redirect("/");

  try {
    return await requireCitizen(id);
  } catch {
    redirect("/");
  }
}
