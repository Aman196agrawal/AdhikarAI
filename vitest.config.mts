import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Scenario tests touch a real database; keep them serial so they cannot
    // race each other through shared rows.
    fileParallelism: false,
  },
  resolve: {
    alias: { "@": root },
  },
});
