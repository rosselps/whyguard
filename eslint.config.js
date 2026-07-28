// @ts-check
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import globals from "globals";

/**
 * Flat ESLint config for the WhyGuard monorepo.
 *
 * Enforces the coding standards from CONTRIBUTING.md:
 * - TypeScript strict mode (enforced by tsconfig, complemented here with
 *   type-aware lint rules).
 * - No `any` without a documented boundary reason (`no-explicit-any` as a warning,
 *   escape hatch is an inline eslint-disable comment with justification).
 * - No unused locals/params left behind.
 * - Consistent, predictable code shape across packages.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      // Generated single-file npm artifact (apps/cli/scripts/bundle.mjs output).
      "**/dist-bundle/**",
      "**/build/**",
      "**/.turbo/**",
      "**/.tmp/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.d.ts",
    ],
  },
  js.configs.recommended,
  {
    // Root-level plain JS config files (this file, commitlint.config.js) are not part of
    // any package's tsconfig, so they are linted without type-aware rules.
    files: ["*.js", "*.mjs", "*.cjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Build scripts inside packages (e.g. apps/cli/scripts/bundle.mjs). The root
    // `*.mjs` pattern above only matches the repository root, so these were linted
    // without Node globals and failed on `process`. They are plain Node scripts,
    // outside any package's tsconfig, so type-aware rules do not apply either.
    files: ["**/scripts/**/*.mjs", "**/scripts/**/*.js", "**/scripts/**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["**/*.ts", "**/*.tsx"],
  })),
  eslintConfigPrettier,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Section 27: "No `any` without a documented boundary reason" — warn instead
      // of erroring so a justified, commented `any` at a real infra boundary is
      // still reviewable, not silently blocked.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-misused-promises": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // CLI entrypoints legitimately write to stdout/stderr via console/process.
    files: ["apps/cli/src/**/*.ts", "**/*.test.ts"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // apps/dashboard runs in the browser, not Node — swap globals accordingly.
    files: ["apps/dashboard/**/*.ts", "apps/dashboard/**/*.tsx"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
    },
  },
);
