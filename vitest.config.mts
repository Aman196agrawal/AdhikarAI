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
  },
  resolve: {
    alias: { "@": root },
  },
});
