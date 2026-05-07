import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ESLint, type Linter } from "eslint";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

async function loadConfig(): Promise<Linter.Config[]> {
  const configUrl = pathToFileURL(join(repoRoot, "eslint.config.mjs")).href;
  const mod = (await import(configUrl)) as { default: Linter.Config[] };
  return mod.default;
}

async function makeESLint(): Promise<ESLint> {
  const baseConfig = await loadConfig();
  return new ESLint({
    cwd: repoRoot,
    overrideConfigFile: true,
    baseConfig,
  });
}

describe("ESLint workspace config", () => {
  it("reports a boundaries violation for a forbidden cross-package import", async () => {
    const eslint = await makeESLint();
    const code = `import { Backend } from "@symnav/backend-typescript";\nexport const x: typeof Backend = Backend;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/renderer/src/forbidden.ts"),
    });
    const boundaries = result!.messages.filter((m) => m.ruleId === "boundaries/dependencies");
    expect(boundaries).toHaveLength(1);
  });

  it("reports a prettier violation on unformatted code", async () => {
    const eslint = await makeESLint();
    const code = `export const x   =    1;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/core/src/unformatted.ts"),
    });
    const prettier = result!.messages.filter((m) => m.ruleId === "prettier/prettier");
    expect(prettier).toHaveLength(1);
  });

  it("allows test files to import @symnav/testing", async () => {
    const eslint = await makeESLint();
    const code = `import { placeholder } from "@symnav/testing";\nexport const f = placeholder;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/renderer/src/foo.test.ts"),
    });
    expect(result!.errorCount).toBe(0);
  });
});
