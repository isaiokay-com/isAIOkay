import astro from "eslint-plugin-astro";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

export default [
  ...astro.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: { projectService: true }
    },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error"
    }
  },
  {
    files: ["packages/cli/test/**/*.ts"],
    rules: { "@typescript-eslint/no-floating-promises": "off" }
  },
  {
    ignores: ["dist/**", "**/dist/**", ".astro/**", "node_modules/**", "drizzle/**", "src/env.d.ts", "worker-configuration.d.ts"]
  }
];
