import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface ChangelogSection {
  type: string;
  section: string;
  hidden?: boolean;
}

interface ReleasePleasePackage {
  "release-type": string;
  "package-name": string;
  "include-component-in-tag": boolean;
  "extra-files": unknown[];
  "changelog-sections": ChangelogSection[];
  "pull-request-title-pattern": string;
  "release-as"?: string;
}

interface ReleasePleaseConfig {
  "last-release-sha"?: string;
  packages: Record<string, ReleasePleasePackage>;
}

class RepositoryFile {
  private static readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

  static read(path: string): string {
    return readFileSync(join(RepositoryFile.repoRoot, path), "utf8");
  }

  static json<T>(path: string): T {
    return JSON.parse(RepositoryFile.read(path)) as T;
  }

  static version(path: string): string {
    return RepositoryFile.json<{ version: string }>(path).version;
  }
}

class PullRequestTitleRule {
  private readonly workflow = RepositoryFile.read(".github/workflows/pr-title.yml");

  accepts(title: string): boolean {
    const match = /^(?<type>[a-z]+)(?<scope>\(.*\))?: (?<subject>.+)$/.exec(title);
    if (!match?.groups) return false;
    const { type, scope, subject } = match.groups;
    const isAllowedType = this.allowedTypes().includes(type!);
    const isCapitalizedSubject = /^[A-Z]/.test(subject!);
    return isAllowedType && scope === undefined && isCapitalizedSubject;
  }

  private allowedTypes(): string[] {
    const block = /types: \|\n((?: {12}\S+\n)+)/.exec(this.workflow);
    if (!block) throw new Error("Missing types block in pr-title.yml");
    return block[1]!.trim().split(/\s+/);
  }
}

describe("release version source", () => {
  const config = RepositoryFile.json<ReleasePleaseConfig>("release-please-config.json");
  const rootPackage = config.packages["."];
  const workflow = RepositoryFile.read(".github/workflows/release.yml");

  it("keeps root, CLI, and manifest versions equal", () => {
    const manifest = RepositoryFile.json<Record<string, string>>(".release-please-manifest.json");
    const rootVersion = RepositoryFile.version("package.json");

    expect(RepositoryFile.version("apps/cli/package.json")).toBe(rootVersion);
    expect(manifest["."]).toBe(rootVersion);
  });

  it("releases the root package as symnav with a bare version tag", () => {
    expect(rootPackage).toMatchObject({
      "release-type": "node",
      "package-name": "symnav",
      "include-component-in-tag": false,
    });
  });

  it("derives the next version from commits since the last tag", () => {
    expect(config["last-release-sha"]).toBeUndefined();
    expect(rootPackage?.["release-as"]).toBeUndefined();
  });

  it("bumps the CLI package version alongside the root", () => {
    expect(rootPackage?.["extra-files"]).toContainEqual({
      type: "json",
      path: "apps/cli/package.json",
      jsonpath: "$.version",
    });
  });

  it("shows only feat, fix, and perf in the changelog", () => {
    const visibleTypes = rootPackage?.["changelog-sections"]
      .filter((section) => !section.hidden)
      .map((section) => section.type);

    expect(visibleTypes).toEqual(["feat", "fix", "perf"]);
  });

  it("titles the release PR so the PR title check accepts it", () => {
    const pattern = rootPackage?.["pull-request-title-pattern"] ?? "";
    const releaseTitle = pattern.replace("${version}", "1.0.0");

    expect(pattern).toContain("${version}");
    expect(pattern).not.toContain("${scope}");
    expect(new PullRequestTitleRule().accepts(releaseTitle)).toBe(true);
  });

  it("runs release-please on every push to main", () => {
    expect(workflow).toMatch(/^on:\n {2}push:\n {4}branches: \[main\]$/m);
    expect(workflow).toMatch(/uses: googleapis\/release-please-action@v\d+/);
  });

  it("exposes whether a release was created and its tag", () => {
    expect(workflow).toMatch(
      /^ {6}release_created: \$\{\{ steps\.release\.outputs\.release_created \}\}$/m,
    );
    expect(workflow).toMatch(/^ {6}tag_name: \$\{\{ steps\.release\.outputs\.tag_name \}\}$/m);
  });
});
