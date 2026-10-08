/**
 * Smoke check: do the pages actually render?
 *
 * Added after a real miss. Passing a function (a bound translator) from a
 * Server Component to a Client Component is invalid under React Server
 * Components, and it made the dashboard return 500 — while `tsc` was clean,
 * `next build` succeeded, and 398 tests passed. None of those execute a page
 * render against real data.
 *
 * This is the cheapest guard that would have caught it: start the server, load
 * every route, assert a 200 and that the expected content is present. It is
 * not a substitute for end-to-end tests; it is the floor beneath them.
 *
 *   npm run smoke          against an already-running server
 *   npm run smoke -- --start   start one, check, shut it down
 */

import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

import { config } from "dotenv";
import pg from "pg";

config();

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";
const START = process.argv.includes("--start");

/** Find a demo citizen so the authenticated pages can be reached. */
async function findCitizen() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT c.id,
              (SELECT e.id FROM "Entitlement" e WHERE e."citizenId" = c.id LIMIT 1) AS entitlement
         FROM "Citizen" c
        WHERE c."isDemo" = true
        ORDER BY c."createdAt"
        LIMIT 1`,
    );
    return rows[0] ?? null;
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * Wait for the server.
 *
 * Generous when this script starts it (a cold Next dev boot is slow), brief
 * when it is supposed to be running already — a check that takes 90 seconds to
 * report "nothing is listening" is a check nobody runs.
 */
async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(BASE, { redirect: "manual" });
      if (response.status < 500) return true;
    } catch {
      // not up yet
    }
    await sleep(1000);
  }
  return false;
}

async function check(label, path, cookie, mustContain = []) {
  const response = await fetch(`${BASE}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });

  const body = response.status === 200 ? await response.text() : "";

  if (response.status !== 200) {
    return { label, ok: false, detail: `HTTP ${response.status}` };
  }

  const missing = mustContain.filter((needle) => !body.includes(needle));
  if (missing.length > 0) {
    return {
      label,
      ok: false,
      detail: `rendered but missing: ${missing.join(", ")}`,
    };
  }

  // A Next error overlay returns 200 while the page is broken, so the status
  // code alone is not enough.
  if (body.includes("__next_error__") || body.includes("Internal Server Error")) {
    return { label, ok: false, detail: "rendered an error page" };
  }

  return { label, ok: true, detail: `HTTP 200, ${body.length} bytes` };
}

async function main() {
  let server;

  if (START) {
    console.log("Starting the dev server...");
    server = spawn("npm run dev", {
      shell: true,
      stdio: "ignore",
      env: { ...process.env, DEMO_MODE: "true" },
    });
  }

  if (!(await waitForServer(START ? 90_000 : 10_000))) {
    console.error(`No server responding at ${BASE}. Start one with npm run dev.`);
    server?.kill();
    process.exit(1);
  }

  const citizen = await findCitizen();
  if (!citizen) {
    console.error("No demo citizen found. Run `npm run seed:all` first.");
    server?.kill();
    process.exit(1);
  }

  const en = `adhikarai_citizen=${citizen.id}`;
  const hi = `${en}; adhikarai_locale=hi`;

  const results = [
    await check("home", "/", null, ["Choose someone to follow"]),
    await check("dashboard (en)", "/dashboard", en, [
      "Your money",
      "Not yet confirmed",
      "Did not arrive",
    ]),
    // The Hindi check is not decoration: a translation that silently falls
    // back would leave a Hindi reader with English they cannot read.
    await check("dashboard (hi)", "/dashboard", hi, ["आपका पैसा", "अभी पुष्टि नहीं"]),
    await check("onboarding", "/onboard", en, ["Tell us about yourself"]),
    await check("onboarding (hi)", "/onboard", hi, ["अपने बारे में बताइए"]),
    await check("demo console", "/demo", en, ["Drive the simulation"]),
  ];

  if (citizen.entitlement) {
    results.push(
      await check("benefit detail", `/benefit/${citizen.entitlement}`, en, [
        "Do you qualify?",
      ]),
    );
  }

  let failed = 0;
  for (const result of results) {
    console.log(
      `${result.ok ? "  ok  " : "  FAIL"}  ${result.label.padEnd(18)} ${result.detail}`,
    );
    if (!result.ok) failed += 1;
  }

  server?.kill();

  if (failed > 0) {
    console.error(`\n${failed} page(s) did not render.`);
    process.exit(1);
  }

  console.log(`\nAll ${results.length} pages rendered.`);
  process.exit(0);
}

await main();
