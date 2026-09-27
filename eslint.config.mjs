// Root ESLint flat config (WP-010 quality gate).
// Type-aware rules live in ONE block, the LINT-1 block below (CI1-L2). It lints every file this
// config lints (tests, workspace source, tools/*.mjs and this file) with type information from the
// single lint-only program in tsconfig.lint.json. Every other block is syntax-only.
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
  // LINT-1 (CI1-L2): no floating promises, with type information. Before this block nothing caught
  // an un-awaited `runCheckerJson(...).then((r) => expect(...))` in a test: it passed eslint, tsc and
  // the test itself. `files` must equal tsconfig.lint.json's `include`, and that program must carry
  // every tsconfig's path aliases (a suite alias it lacks resolves to an error type, whose promises
  // the rule cannot see). test/unit/tooling/lint-typed-program.test.ts pins both, and pins that every
  // file this config lints gets this block. A file matched here but missing from the program fails
  // lint with a parsing error. Default options: `void promise;` stays the explicit, visible opt-out.
  {
    files: [
      "test/**/*.ts",
      "test/**/*.mjs",
      "packages/**/src/**/*.ts",
      "apps/**/src/**/*.ts",
      "tools/*.mjs",
      "eslint.config.mjs",
    ],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.lint.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
