// @ts-check
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import boundaries from "eslint-plugin-boundaries";
import prettierPlugin from "eslint-plugin-prettier";
import prettierConfig from "eslint-config-prettier";

const repoRoot = dirname(fileURLToPath(import.meta.url));

/** @param {string} sub */
const pkg = (sub) => join(repoRoot, sub);

/** @type {{ name: string; type: string; dir: string }[]} */
const packages = [
  { name: "@symnav/core", type: "core", dir: "packages/core" },
  { name: "@symnav/daemon", type: "daemon", dir: "packages/daemon" },
  { name: "@symnav/renderer", type: "renderer", dir: "packages/renderer" },
  { name: "@symnav/backend-typescript", type: "backend", dir: "packages/backend-typescript" },
  { name: "@symnav/telemetry", type: "telemetry", dir: "packages/telemetry" },
  { name: "@symnav/testing", type: "testing", dir: "packages/testing" },
];

const elements = [
  ...packages.map((p) => ({ type: p.type, pattern: `${p.dir}/**` })),
  { type: "cli", pattern: "apps/cli/**" },
];

const aliasMap = [
  ...packages.map((p) => /** @type {[string, string]} */ ([p.name, pkg(`${p.dir}/src/index.ts`)])),
  /** @type {[string, string]} */ (["symnav", pkg("apps/cli/src/index.ts")]),
];

function productionRules() {
  return [
    { from: { type: "renderer" }, allow: { to: { type: ["core", "daemon"] } } },
    { from: { type: "backend" }, allow: { to: { type: ["core"] } } },
    {
      from: { type: "cli" },
      allow: { to: { type: ["core", "daemon", "renderer", "backend", "telemetry"] } },
    },
  ];
}

function testRules() {
  return [
    { from: { type: "core" }, allow: { to: { type: ["testing"] } } },
    { from: { type: "daemon" }, allow: { to: { type: ["testing"] } } },
    { from: { type: "renderer" }, allow: { to: { type: ["core", "daemon", "testing"] } } },
    { from: { type: "backend" }, allow: { to: { type: ["core", "testing"] } } },
    { from: { type: "telemetry" }, allow: { to: { type: ["testing"] } } },
    {
      from: { type: "cli" },
      allow: {
        to: { type: ["core", "daemon", "renderer", "backend", "telemetry", "testing"] },
      },
    },
  ];
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
        alias: { map: aliasMap, extensions: [".ts", ".js"] },
      },
    },
    rules: {
      ...prettierConfig.rules,
      "prettier/prettier": "error",
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@symnav/daemon/testing",
              message: "Daemon testing inspection is available only to test files.",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: "VariableDeclarator[init.type='ObjectExpression']:not([id.typeAnnotation])",
          message:
            "Annotate object-literal declarations with a type (`const x: T = {…}`) or use `satisfies`.",
        },
      ],
      "boundaries/dependencies": ["error", { default: "disallow", rules: productionRules() }],
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "no-restricted-imports": "off",
      "boundaries/dependencies": ["error", { default: "disallow", rules: testRules() }],
    },
  },
];
