/**
 * GET /api/citizens
 *
 * The persona list that stands in for a login. Demo records are only listed
 * when DEMO_MODE is enabled, so a deployment carrying seeded personas does not
 * present them as real cases.
 */

import { prisma } from "@/lib/db";
import { handler, ok } from "@/lib/api/http";
import { isDemoMode } from "@/lib/authz";

export const GET = handler("GET /api/citizens", async () => {
  const demoMode = isDemoMode();

  const citizens = await prisma.citizen.findMany({
    where: demoMode ? {} : { isDemo: false },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      name: true,
      nameHi: true,
      locale: true,
      isDemo: true,
      _count: { select: { entitlements: true } },
    },
  });

  return ok({
    demoMode,
    citizens: citizens.map((citizen) => ({
      id: citizen.id,
      name: citizen.name,
      nameHi: citizen.nameHi,
      locale: citizen.locale,
      isDemo: citizen.isDemo,
      entitlementCount: citizen._count.entitlements,
    })),
  });
});
