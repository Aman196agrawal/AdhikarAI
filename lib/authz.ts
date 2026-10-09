/**
 * Authorization.
 *
 * The demo has no login: a citizen is chosen from a persona list. That is a
 * deliberate scope decision, not an oversight, and it is confined to ONE
 * function. Everything downstream is written as though authentication were
 * real:
 *
 *   - no service function takes "the current citizen" from ambient state;
 *     every one receives an explicit `citizenId`,
 *   - every query is scoped by that id,
 *   - `requireCitizen` is the single place a request is turned into an
 *     identity.
 *
 * Replacing this with a real session means changing this file alone. If the
 * demo had instead let routes read an id straight from the request body and
 * query freely, that change would have meant auditing every handler.
 */

import { timingSafeEqual } from "node:crypto";

import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/api/http";

export interface CitizenContext {
  citizenId: string;
  name: string;
  locale: string;
  isDemo: boolean;
}

export function isDemoMode(): boolean {
  return (process.env.DEMO_MODE ?? "").trim().toLowerCase() === "true";
}

/**
 * Resolve and authorise a citizen id.
 *
 * Verifies the citizen exists, and in a non-demo environment refuses to serve
 * demo records at all - so a production deployment carrying seeded personas
 * cannot accidentally expose them as real cases.
 */
export async function requireCitizen(
  citizenId: string | undefined | null,
): Promise<CitizenContext> {
  if (!citizenId || citizenId.trim() === "") {
    throw new ApiError("UNAUTHORIZED", "No citizen was identified for this request.");
  }

  const citizen = await prisma.citizen.findUnique({
    where: { id: citizenId },
    select: { id: true, name: true, locale: true, isDemo: true },
  });

  if (!citizen) {
    throw new ApiError("NOT_FOUND", "That citizen record does not exist.");
  }

  if (citizen.isDemo && !isDemoMode()) {
    throw new ApiError(
      "UNAUTHORIZED",
      "Demo records are not available in this environment.",
    );
  }

  return {
    citizenId: citizen.id,
    name: citizen.name,
    locale: citizen.locale,
    isDemo: citizen.isDemo,
  };
}

/**
 * Guard a demo-only operation, such as advancing the simulated clock or
 * driving the mock government store.
 */
export function requireDemoMode(): void {
  if (!isDemoMode()) {
    throw new ApiError(
      "UNAUTHORIZED",
      "This operation is only available when DEMO_MODE is enabled.",
    );
  }
}

/**
 * Guard the scheduler endpoint with the shared cron secret.
 *
 * A missing or placeholder secret is treated as misconfiguration and refused,
 * rather than defaulting to open: an unauthenticated endpoint that advances
 * benefit state would be a genuine problem, not an inconvenience.
 */
export function requireCronSecret(request: Request): void {
  const expected = (process.env.CRON_SECRET ?? "").trim();

  if (expected === "") {
    throw new ApiError(
      "UNAUTHORIZED",
      "CRON_SECRET is not configured, so scheduled runs are refused.",
    );
  }

  const header = request.headers.get("authorization") ?? "";
  const provided = header.replace(/^Bearer\s+/i, "").trim();

  // Constant-time comparison: `!==` returns as soon as a character differs,
  // which leaks how much of a guess was right to anyone timing the response.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  const matches = a.length === b.length && timingSafeEqual(a, b);

  if (provided === "" || !matches) {
    throw new ApiError("UNAUTHORIZED", "Invalid or missing cron credentials.");
  }
}
