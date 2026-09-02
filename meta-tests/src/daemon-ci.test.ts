import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("daemon CI matrix", () => {
  const workflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const cliPackage = JSON.parse(readFileSync(join(repoRoot, "apps/cli/package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  it("runs build, tests, and the same cold and warm E2E sources on Linux and Windows", () => {
    const testJob = job("test");
    expect(testJob).toContain("os: [ubuntu-latest, windows-latest]");
    expect(testJob).toContain("runs-on: ${{ matrix.os }}");
    expectOrdered(testJob, [
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm test",
      "pnpm --filter symnav test:e2e:cold",
      "pnpm --filter symnav test:e2e:warm",
    ]);
  });

  it("keeps lint and typecheck on Linux", () => {
    expect(job("lint")).toContain("runs-on: ubuntu-latest");
    expect(job("typecheck")).toContain("runs-on: ubuntu-latest");
  });

  it("runs cold and warm modes through the same navigation source runner", () => {
    expect(cliPackage.scripts["test:e2e:cold"]).toBe("tsx test/e2e/run-navigation-mode.ts 0");
    expect(cliPackage.scripts["test:e2e:warm"]).toBe("tsx test/e2e/run-navigation-mode.ts 1");
  });

  function job(name: string): string {
    const start = workflow.indexOf(`  ${name}:`);
    if (start === -1) throw new Error(`Missing workflow job: ${name}`);
    const remaining = workflow.slice(start + name.length + 3);
    const nextJob = remaining.search(/\n  [A-Za-z][\w-]*:/);
    const end = nextJob === -1 ? undefined : start + name.length + 3 + nextJob;
    return workflow.slice(start, end);
  }

  function expectOrdered(source: string, values: readonly string[]): void {
    let previousIndex = -1;
    for (const value of values) {
      const index = source.indexOf(value);
      expect(index).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  }
});
