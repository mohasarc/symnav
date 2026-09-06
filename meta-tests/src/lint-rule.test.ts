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

  it("allows cli files to import @symnav/telemetry", async () => {
    const eslint = await makeESLint();
    const code = `import type { UsageEvent } from "@symnav/telemetry";\nexport type X = UsageEvent;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "apps/cli/src/telemetry.ts"),
    });
    expect(result!.errorCount).toBe(0);
  });

  it("reports a boundaries violation when daemon imports @symnav/core", async () => {
    const eslint = await makeESLint();
    const code = `import type { Workspace } from "@symnav/core";\nexport type X = Workspace;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/daemon/src/forbidden.ts"),
    });
    const boundaries = result!.messages.filter(
      (message) => message.ruleId === "boundaries/dependencies",
    );
    expect(boundaries).toHaveLength(1);
  });

  it("reports a boundaries violation when daemon imports CLI", async () => {
    const eslint = await makeESLint();
    const code = `import type * as Cli from "symnav";\nexport type X = typeof Cli;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/daemon/src/forbidden.ts"),
    });
    const boundaries = result!.messages.filter(
      (message) => message.ruleId === "boundaries/dependencies",
    );
    expect(boundaries).toHaveLength(1);
  });

  it("reports a boundaries violation when backend imports @symnav/daemon", async () => {
    const eslint = await makeESLint();
    const code = `import type { DaemonExecutor } from "@symnav/daemon";\nexport type X = DaemonExecutor;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/backend-typescript/src/forbidden.ts"),
    });
    const boundaries = result!.messages.filter(
      (message) => message.ruleId === "boundaries/dependencies",
    );
    expect(boundaries).toHaveLength(1);
  });

  it("reports a boundaries violation when telemetry imports @symnav/daemon", async () => {
    const eslint = await makeESLint();
    const code = `import type { DaemonExecutor } from "@symnav/daemon";\nexport type X = DaemonExecutor;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/telemetry/src/forbidden.ts"),
    });
    const boundaries = result!.messages.filter(
      (message) => message.ruleId === "boundaries/dependencies",
    );
    expect(boundaries).toHaveLength(1);
  });

  it("allows renderer files to import @symnav/daemon", async () => {
    const eslint = await makeESLint();
    const code = `import type { DaemonStartResult } from "@symnav/daemon";\nexport type X = DaemonStartResult;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/renderer/src/daemon.ts"),
    });
    expect(result!.errorCount).toBe(0);
  });

  it("allows CLI files to import @symnav/daemon", async () => {
    const eslint = await makeESLint();
    const code = `import type { DaemonExecutor } from "@symnav/daemon";\nexport type X = DaemonExecutor;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "apps/cli/src/daemon-contract.ts"),
    });
    expect(result!.errorCount).toBe(0);
  });

  it("allows daemon test files to import @symnav/testing", async () => {
    const eslint = await makeESLint();
    const code = `import { placeholder } from "@symnav/testing";\nexport const value = placeholder;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/daemon/src/contract.test.ts"),
    });
    expect(result!.errorCount).toBe(0);
  });

  it("allows telemetry test files to import @symnav/testing", async () => {
    const eslint = await makeESLint();
    const code = `import { placeholder } from "@symnav/testing";\nexport const value = placeholder;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/telemetry/src/usage.test.ts"),
    });
    expect(result!.errorCount).toBe(0);
  });

  it("reports a boundaries violation when renderer imports @symnav/telemetry", async () => {
    const eslint = await makeESLint();
    const code = `import type { UsageEvent } from "@symnav/telemetry";\nexport type X = UsageEvent;\n`;
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

  it("reports on an untyped object-literal declaration", async () => {
    const eslint = await makeESLint();
    const code = `export const config = { enabled: true };\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/core/src/untyped.ts"),
    });
    const restricted = result!.messages.filter((m) => m.ruleId === "no-restricted-syntax");
    expect(restricted).toHaveLength(1);
  });

  it("allows an annotated or satisfied object-literal declaration", async () => {
    const eslint = await makeESLint();
    const code = [
      `type Config = { enabled: boolean };`,
      `export const annotated: Config = { enabled: true };`,
      `export const satisfied = { enabled: true } satisfies Config;`,
      ``,
    ].join("\n");
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/core/src/typed.ts"),
    });
    const restricted = result!.messages.filter((m) => m.ruleId === "no-restricted-syntax");
    expect(restricted).toHaveLength(0);
  });

  it("reports a boundaries violation when @symnav/testing imports from @symnav/core", async () => {
    const eslint = await makeESLint();
    const code = `import type { Workspace } from "@symnav/core";\nexport type X = Workspace;\n`;
    const [result] = await eslint.lintText(code, {
      filePath: join(repoRoot, "packages/testing/src/forbidden.ts"),
    });
    const boundaries = result!.messages.filter((m) => m.ruleId === "boundaries/dependencies");
    expect(boundaries).toHaveLength(1);
  });
});
