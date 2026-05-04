import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import boundaries from "eslint-plugin-boundaries";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

const elements = [
  { type: "core", pattern: "packages/core/**" },
  { type: "renderer", pattern: "packages/renderer/**" },
  { type: "backend", pattern: "packages/backend-typescript/**" },
  { type: "cli", pattern: "apps/cli/**" },
  { type: "testing", pattern: "packages/testing/**" },
];

function dependencyRules(allowTesting) {
  const baseAllows = {
    core: [],
    renderer: ["core"],
    backend: ["core"],
    cli: ["core", "renderer", "backend"],
    testing: ["core"],
  };
  const rules = [];
  for (const [from, allow] of Object.entries(baseAllows)) {
    const allowed = allowTesting ? [...allow, "testing"] : allow;
    if (allowed.length > 0) {
      rules.push({ from: { type: from }, allow: { to: { type: allowed } } });
    }
  }
  return rules;
}

const baseLanguageOptions = {
  parser: tsParser,
  parserOptions: { ecmaVersion: 2022, sourceType: "module" },
};

export default [
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "**/*.tsbuildinfo",
      "packages/testing/fixtures/**",
    ],
  },
  {
    files: ["**/*.ts"],
    languageOptions: baseLanguageOptions,
    plugins: {
      "@typescript-eslint": tsPlugin,
      boundaries,
      prettier: prettierPlugin,
    },
    settings: {
      "boundaries/elements": elements,
      "import/resolver": {
        alias: {
          map: [
            ["@symnav/core", "./packages/core/src/index.ts"],
            ["@symnav/renderer", "./packages/renderer/src/index.ts"],
            ["@symnav/backend-typescript", "./packages/backend-typescript/src/index.ts"],
            ["@symnav/testing", "./packages/testing/src/index.ts"],
          ],
          extensions: [".ts", ".js"],
        },
      },
    },
    rules: {
      ...prettierConfig.rules,
      "prettier/prettier": "error",
      "boundaries/dependencies": [
        "error",
        { default: "disallow", rules: dependencyRules(false) },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "boundaries/dependencies": [
        "error",
        { default: "disallow", rules: dependencyRules(true) },
      ],
    },
  },
];
