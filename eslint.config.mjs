// Root ESLint flat config (WP-010 quality gate).
// Type-aware rules are deliberately deferred until packages contain real code.
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/coverage/**",
      "python/**",
      "**/*.tsbuildinfo",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-console": "off",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
);
