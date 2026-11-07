import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

class ReleaseWorkflow {
  private static readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  private static readonly jobHeader = /\n {2}([A-Za-z][\w-]*):\n/g;

  readonly source = readFileSync(
    join(ReleaseWorkflow.repoRoot, ".github/workflows/release.yml"),
    "utf8",
  );

  job(name: string): string {
    const start = this.source.indexOf(`\n  ${name}:\n`);
    if (start === -1) throw new Error(`Missing workflow job: ${name}`);
    const bodyStart = start + name.length + 4;
    const nextJob = this.source.slice(bodyStart).search(/\n {2}[A-Za-z][\w-]*:\n/);
    return this.source.slice(start, nextJob === -1 ? undefined : bodyStart + nextJob);
  }

  jobNames(): string[] {
    const jobsStart = this.source.indexOf("\njobs:\n");
    const jobs = this.source.slice(jobsStart);
    return [...jobs.matchAll(ReleaseWorkflow.jobHeader)].map((match) => match[1]!);
  }

  needs(name: string): string[] {
    const line = /^ {4}needs: (.+)$/m.exec(this.job(name));
    if (!line) return [];
    return line[1]!.replace(/[[\]]/g, "").split(/,\s*/);
  }

  dependsOn(name: string, ancestor: string): boolean {
    const direct = this.needs(name);
    return direct.includes(ancestor) || direct.some((parent) => this.dependsOn(parent, ancestor));
  }

  static expectOrdered(source: string, values: readonly string[]): void {
    let previousIndex = -1;
    for (const value of values) {
      const index = source.indexOf(value, previousIndex + 1);
      expect(index, value).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
  }
}

class NpmVersion {
  private static readonly minimumTrustedPublishing = [11, 5, 1];

  static supportsTrustedPublishing(installCommand: string): boolean {
    const match = /npm install -g npm@\^?(\d+)\.(\d+)\.(\d+)/.exec(installCommand);
    if (!match) return false;
    const requested = match.slice(1).map(Number);
    for (const [index, minimum] of NpmVersion.minimumTrustedPublishing.entries()) {
      if (requested[index]! !== minimum) return requested[index]! > minimum;
    }
    return true;
  }
}

describe("release pipeline", () => {
  const workflow = new ReleaseWorkflow();
  const releaseTag = "${{ needs.release-please.outputs.release_tag }}";
  const releaseTarball = "symnav-${{ needs.pack.outputs.version }}.tgz";

  it("can be dispatched with an existing release tag", () => {
    expect(workflow.source).toMatch(
      /^ {2}workflow_dispatch:\n {4}inputs:\n {6}tag:\n(?: {8}description: .+\n)? {8}required: true\n {8}type: string$/m,
    );
  });

  it("takes the release tag from the dispatch input or release-please", () => {
    const releasePlease = workflow.job("release-please");
    expect(releasePlease).toContain(
      "release_tag: ${{ inputs.tag || steps.release.outputs.tag_name }}",
    );
    ReleaseWorkflow.expectOrdered(releasePlease, [
      "uses: googleapis/release-please-action@",
      "if: github.event_name == 'push'",
    ]);
  });

  it("verifies the tag with the full CI-parity sequence only when a release exists", () => {
    const verify = workflow.job("verify");
    expect(verify).toContain("needs: release-please");
    expect(verify).toContain(
      "if: needs.release-please.outputs.release_created == 'true' || github.event_name == 'workflow_dispatch'",
    );
    ReleaseWorkflow.expectOrdered(verify, [
      `ref: ${releaseTag}`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm test",
      "pnpm --filter symnav test:e2e:cold",
      "pnpm --filter symnav test:e2e:warm",
      "pnpm lint",
      "pnpm typecheck",
    ]);
  });

  it("runs every later job only after verify", () => {
    const laterJobs = workflow
      .jobNames()
      .filter((name) => !["release-please", "verify"].includes(name));

    expect(laterJobs).toEqual(["pack", "install-smoke", "publish-npm", "upload-release-asset"]);
    for (const name of laterJobs) expect(workflow.dependsOn(name, "verify"), name).toBe(true);
  });

  it("packs the tag once and names the version after the tag", () => {
    const pack = workflow.job("pack");
    ReleaseWorkflow.expectOrdered(pack, [
      `ref: ${releaseTag}`,
      "pnpm install --frozen-lockfile",
      "pnpm build",
      "pnpm --filter symnav pack",
      "uses: actions/upload-artifact@v4",
      "name: symnav-release-tarball",
    ]);
    expect(pack).toContain("version: ${{ steps.version.outputs.version }}");
    expect(pack).toContain('echo "version=${RELEASE_TAG#v}" >> "$GITHUB_OUTPUT"');
    expect(pack).toContain(`RELEASE_TAG: ${releaseTag}`);
  });

  it("smoke-tests the packed tarball against the tag version", () => {
    const smoke = workflow.job("install-smoke");
    expect(workflow.needs("install-smoke")).toContain("pack");
    expect(smoke).toContain("uses: ./.github/workflows/install-smoke.yml");
    expect(smoke).toContain("tarball-artifact: symnav-release-tarball");
    expect(smoke).toContain("expected-version: ${{ needs.pack.outputs.version }}");
    expect(smoke).toContain(`ref: ${releaseTag}`);
  });

  it("publishes the smoke-tested tarball to npm with provenance over OIDC", () => {
    const publish = workflow.job("publish-npm");
    expect(workflow.needs("publish-npm")).toContain("install-smoke");
    expect(publish).toMatch(/^ {6}id-token: write$/m);
    expect(publish).not.toMatch(/^ {4}uses:/m);
    expect(publish).toContain("registry-url: https://registry.npmjs.org");
    ReleaseWorkflow.expectOrdered(publish, [
      "npm install -g npm@",
      "name: symnav-release-tarball",
      'npm publish "$SYMNAV_TARBALL" --provenance --access public',
    ]);
    expect(publish).toContain(releaseTarball);
    expect(NpmVersion.supportsTrustedPublishing(publish)).toBe(true);
  });

  it("uses no long-lived npm token", () => {
    expect(workflow.source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("attaches the published tarball to the GitHub Release", () => {
    const upload = workflow.job("upload-release-asset");
    expect(workflow.needs("upload-release-asset")).toContain("publish-npm");
    expect(upload).toMatch(/^ {6}contents: write$/m);
    ReleaseWorkflow.expectOrdered(upload, [
      "name: symnav-release-tarball",
      'gh release upload "$RELEASE_TAG" "$SYMNAV_TARBALL" --clobber',
    ]);
    expect(upload).toContain(`RELEASE_TAG: ${releaseTag}`);
    expect(upload).toContain(releaseTarball);
  });
});
