/**
 * The grievance channel.
 *
 * DEMO IMPLEMENTATION. Simulates filing and escalating a grievance with the
 * department administering a scheme. No real grievance portal is contacted and
 * no real endpoint is invented.
 *
 * Kept separate from `GovGateway` because it is a separate real-world system
 * with its own lifecycle: a grievance has a ticket, a tier, and an escalation
 * path, none of which belong in an application-status API.
 *
 * Modelled behaviour that matters to the loop: filing a grievance at tier 1
 * may not resolve anything, and escalating to tier 2 is a distinct action with
 * a distinct outcome. That is what lets the demo show a first corrective
 * action failing and a second succeeding.
 */

import { prisma } from "@/lib/db";
import type { Clock } from "@/lib/clock";
import { log } from "@/lib/log";

export interface FileGrievanceInput {
  schemeCode: string;
  /** The government application this concerns, when there is one. */
  applicationRef: string | null;
  aadhaarLast4: string;
  idempotencyKey: string;
  subject: string;
  detail: string;
  clock: Clock;
}

export interface EscalateGrievanceInput extends FileGrievanceInput {
  /** The tier-1 ticket being escalated. */
  previousTicket: string;
}

export type GrievanceResult =
  | {
      ok: true;
      ticket: string;
      tier: 1 | 2;
      filedOn: Date;
      /** What the department said it would do. */
      acknowledgement: string;
    }
  | {
      ok: false;
      reason: "CHANNEL_UNAVAILABLE" | "REJECTED" | "DUPLICATE";
      message: string;
      ticket?: string;
    };

export interface GrievanceProvider {
  readonly name: string;
  readonly isMock: boolean;
  file(input: FileGrievanceInput): Promise<GrievanceResult>;
  escalate(input: EscalateGrievanceInput): Promise<GrievanceResult>;
}

function ticketFor(prefix: string, key: string): string {
  const body = key
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(-10);
  return `${prefix}${body}`;
}

/** Record the grievance against the government's own event log. */
async function recordEvent(
  input: FileGrievanceInput,
  status: string,
  note: string,
  occurredOn: Date,
): Promise<void> {
  if (!input.applicationRef) return;

  await prisma.govStatusEvent.create({
    data: {
      applicationRef: input.applicationRef,
      schemeCode: input.schemeCode,
      status,
      note,
      occurredOn,
    },
  });
}

export function createMockGrievanceProvider(options?: {
  failureMode?: "none" | "unavailable";
  /** When true, a tier-1 filing is acknowledged but changes nothing. */
  tier1Ineffective?: boolean;
}): GrievanceProvider {
  const failureMode = options?.failureMode ?? "none";
  const tier1Ineffective = options?.tier1Ineffective ?? true;

  return {
    name: "mock-grievance-channel",
    isMock: true,

    async file(input: FileGrievanceInput): Promise<GrievanceResult> {
      if (failureMode === "unavailable") {
        return {
          ok: false,
          reason: "CHANNEL_UNAVAILABLE",
          message:
            "The grievance portal did not respond. (Simulated failure: nothing was filed.)",
        };
      }

      const filedOn = input.clock.now();
      const ticket = ticketFor("GRV1", input.idempotencyKey);

      await recordEvent(
        input,
        "GRIEVANCE_FILED",
        `Grievance ${ticket} filed: ${input.subject}`,
        filedOn,
      );

      log.info("grievance.filed", {
        schemeCode: input.schemeCode,
        ticket,
        tier: 1,
        simulated: true,
      });

      return {
        ok: true,
        ticket,
        tier: 1,
        filedOn,
        acknowledgement: tier1Ineffective
          ? "Grievance registered at the first tier. The department will respond within 30 working days. (Simulated: no change to the underlying problem.)"
          : "Grievance registered and forwarded for action. (Simulated.)",
      };
    },

    async escalate(input: EscalateGrievanceInput): Promise<GrievanceResult> {
      if (failureMode === "unavailable") {
        return {
          ok: false,
          reason: "CHANNEL_UNAVAILABLE",
          message: "The grievance portal did not respond. (Simulated failure.)",
        };
      }

      const filedOn = input.clock.now();
      const ticket = ticketFor("GRV2", input.idempotencyKey);

      await recordEvent(
        input,
        "GRIEVANCE_ESCALATED",
        `Grievance ${input.previousTicket} escalated to tier 2 as ${ticket}: ${input.subject}`,
        filedOn,
      );

      log.info("grievance.escalated", {
        schemeCode: input.schemeCode,
        ticket,
        tier: 2,
        simulated: true,
      });

      return {
        ok: true,
        ticket,
        tier: 2,
        filedOn,
        acknowledgement:
          "Escalated to the second tier with a named grievance officer. (Simulated.)",
      };
    },
  };
}

let cached: GrievanceProvider | null = null;

export function grievanceProvider(): GrievanceProvider {
  cached ??= createMockGrievanceProvider();
  return cached;
}

export function setGrievanceProvider(provider: GrievanceProvider | null): void {
  cached = provider;
}
