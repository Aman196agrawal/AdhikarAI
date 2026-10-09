import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Scenario tests share one database. Running files serially keeps them
    // from racing each other through the same rows.
    fileParallelism: false,
    // Scenario tests drive the real pipeline against Postgres: dozens of round
    // trips per case. Typical runs take 0.5-1.5s, but the first case in a file
    // can take 5s+ on a cold connection under Docker on Windows, which is
    // timing, not a hang. 20s still fails fast on a genuine deadlock.
    testTimeout: 20_000,
  },
  resolve: {
    alias: { "@": root },
  },
});
