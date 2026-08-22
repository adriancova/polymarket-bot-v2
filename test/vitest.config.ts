import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  test: {
    // Unit tests live under test/unit and inside workspace packages.
    // Integration tests are intentionally excluded here; `pnpm test:integration`
    // is an explicit exit-0 skip placeholder until WP-040+.
    include: [
      "test/unit/**/*.test.ts",
      "packages/**/src/**/*.test.ts",
      "apps/**/src/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/dist/**", "test/integration/**"],
    root: repoRoot,
    passWithNoTests: false,
  },
});
