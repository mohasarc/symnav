import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("daemon CI matrix", () => {
  const cliPackage = JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("runs cold and warm modes through the same navigation source runner", () => {
    expect(cliPackage.scripts["test:e2e:cold"]).toBe("tsx test/e2e/run-navigation-mode.ts 0");
    expect(cliPackage.scripts["test:e2e:warm"]).toBe("tsx test/e2e/run-navigation-mode.ts 1");
  });
});
