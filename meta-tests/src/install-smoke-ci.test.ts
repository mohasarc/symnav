import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

class WorkflowSource {
  private static readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  static read(name: string): string {
    return readFileSync(join(WorkflowSource.repoRoot, ".github/workflows", name), "utf8");
  }

  static job(workflow: string, name: string): string {
    const start = workflow.indexOf(`\n  ${name}:\n`);
    if (start === -1) throw new Error(`Missing workflow job: ${name}`);
    const bodyStart = start + name.length + 4;
    const nextJob = workflow.slice(bodyStart).search(/\n  [A-Za-z][\w-]*:\n/);
    return workflow.slice(start, nextJob === -1 ? undefined : bodyStart + nextJob);
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

  it("checks out the caller-given ref, defaulting to the triggering commit", () => {
    expect(workflow).toMatch(/^ {6}ref:\n {8}required: false\n {8}type: string\n {8}default: ""$/m);
    WorkflowSource.expectOrdered(workflow, ["uses: actions/checkout@v4", "ref: ${{ inputs.ref }}"]);
  });

  it("runs on Linux, macOS, and Windows under Node 20 and .nvmrc", () => {
    expect(workflow).toContain("os: [ubuntu-latest, macos-latest, windows-latest]");
    expect(workflow).toContain('node: ["20", nvmrc]');
    expect(workflow).toContain("runs-on: ${{ matrix.os }}");
    expect(workflow).toContain("node-version: ${{ matrix.node != 'nvmrc' && matrix.node || '' }}");
    expect(workflow).toContain(
      "node-version-file: ${{ matrix.node == 'nvmrc' && '.nvmrc' || '' }}",
    );
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

  it("packs the npm latest release as the previous tarball unless it is missing, 0.0.0, or the expected version", () => {
    const resolveStep = workflow.slice(workflow.indexOf("id: previous-release"));
    WorkflowSource.expectOrdered(resolveStep, [
      'latest="$(npm view symnav version 2>/dev/null || true)"',
      '[ -z "$latest" ]',
      '[ "$latest" = "0.0.0" ]',
      '[ "$latest" = "$SYMNAV_EXPECTED_VERSION" ]',
      "exit 0",
      'npm pack "symnav@$latest" --pack-destination',
      'echo "tarball=',
      "pnpm --filter symnav test:install-smoke",
    ]);
  });

  it("points the upgrade smoke at the new and previous tarballs", () => {
    const smokeStep = workflow.slice(workflow.indexOf("pnpm --filter symnav test:install-smoke"));
    expect(smokeStep).toContain(
      "SYMNAV_TARBALL: ${{ runner.temp }}/symnav-tarball/symnav-${{ inputs.expected-version }}.tgz",
    );
    expect(smokeStep).toContain(
      "SYMNAV_PREVIOUS_TARBALL: ${{ steps.previous-release.outputs.tarball }}",
    );
  });
});

describe("CI install smoke", () => {
  const workflow = WorkflowSource.read("ci.yml");

  it("packs the built symnav package and uploads the tarball", () => {
    const packJob = WorkflowSource.job(workflow, "pack");
    WorkflowSource.expectOrdered(packJob, [
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm --filter symnav pack",
      "uses: actions/upload-artifact@v4",
      "name: symnav-tarball",
    ]);
  });

  it("reads the expected version from the symnav package", () => {
    const packJob = WorkflowSource.job(workflow, "pack");
    expect(packJob).toContain("version: ${{ steps.version.outputs.version }}");
    expect(packJob).toContain("require('./apps/cli/package.json').version");
  });

  it("packs a runner-only prerelease version so the upgrade smoke crosses versions", () => {
    const packJob = WorkflowSource.job(workflow, "pack");
    WorkflowSource.expectOrdered(packJob, [
      "pnpm build",
      'version="$(node -p "require(\'./apps/cli/package.json\').version")-smoke-${GITHUB_SHA::7}"',
      'npm version "$version" --no-git-tag-version --prefix apps/cli',
      'echo "version=$version" >> "$GITHUB_OUTPUT"',
      "pnpm --filter symnav pack",
    ]);
  });

  it("runs the reusable install smoke on the packed tarball", () => {
    const smokeJob = WorkflowSource.job(workflow, "install-smoke");
    expect(smokeJob).toContain("needs: pack");
    expect(smokeJob).toContain("uses: ./.github/workflows/install-smoke.yml");
    expect(smokeJob).toContain("tarball-artifact: symnav-tarball");
    expect(smokeJob).toContain("expected-version: ${{ needs.pack.outputs.version }}");
  });
});

describe("release install smoke", () => {
  const workflow = WorkflowSource.read("release.yml");

  it("packs the tagged version without changing it", () => {
    expect(WorkflowSource.job(workflow, "pack")).not.toContain("npm version");
  });
});
