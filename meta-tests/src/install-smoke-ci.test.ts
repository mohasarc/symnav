import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

class WorkflowSource {
  private static readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  static read(name: string): string {
    return readFileSync(join(WorkflowSource.repoRoot, ".github/workflows", name), "utf8");
  }

  static expectOrdered(source: string, values: readonly string[]): void {
    let previousIndex = -1;
    for (const value of values) {
      const index = source.indexOf(value);
      expect(index, value).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  }
}

describe("install smoke workflow", () => {
  const workflow = WorkflowSource.read("install-smoke.yml");

  it("is reusable with the tarball artifact and expected version as inputs", () => {
    expect(workflow).toMatch(/^on:\n {2}workflow_call:\n {4}inputs:$/m);
    expect(workflow).toMatch(/^ {6}tarball-artifact:\n {8}required: true\n {8}type: string$/m);
    expect(workflow).toMatch(/^ {6}expected-version:\n {8}required: true\n {8}type: string$/m);
  });

  it("runs on Linux", () => {
    expect(workflow).toContain("runs-on: ubuntu-latest");
  });

  it("installs the downloaded tarball globally under a prefix before running the smoke", () => {
    WorkflowSource.expectOrdered(workflow, [
      "uses: actions/download-artifact@v4",
      "name: ${{ inputs.tarball-artifact }}",
      "npm install -g --prefix",
      "pnpm --filter symnav test:install-smoke",
    ]);
  });

  it("points the smoke at the install prefix and expected version", () => {
    expect(workflow).toContain("SYMNAV_INSTALL_PREFIX: ${{ runner.temp }}/symnav-prefix");
    expect(workflow).toContain("SYMNAV_EXPECTED_VERSION: ${{ inputs.expected-version }}");
  });
});
