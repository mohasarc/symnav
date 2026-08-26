import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DaemonWorkspaceGenerator,
  type DaemonBenchmarkScale,
} from "./daemon-workspace-generator.js";
import {
  DaemonWorkspaceProfiler,
  type DaemonWorkspaceProfile,
} from "./daemon-workspace-profile.js";

describe("DaemonWorkspaceGenerator", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it("repeats one versioned seed byte-for-byte with deterministic history", async () => {
    const first = TestWorkspace.create(roots);
    const second = TestWorkspace.create(roots);

    await TestWorkspace.generate(first, 1, "repeatable-seed");
    await TestWorkspace.generate(second, 1, "repeatable-seed");

    expect(TestWorkspace.manifest(first)).toEqual(TestWorkspace.manifest(second));
    expect(TestWorkspace.history(first)).toEqual(TestWorkspace.history(second));
    expect(TestWorkspace.history(first)).toHaveLength(2);
  });

  it("connects project references, aliases, fanout, calls, cycles, ignores, and nested boundaries", async () => {
    const root = TestWorkspace.create(roots);
    const generated = await TestWorkspace.generate(root, 1, "connected-seed");
    const manifest = TestWorkspace.manifest(root);

    expect(readFileSync(join(root, "tsconfig.json"), "utf8")).toContain('"references"');
    expect(manifest.join("\n")).toContain("@workspace/");
    expect(manifest.join("\n")).toContain("benchmarkHub");
    expect(manifest.join("\n")).toContain("cycleEntry");
    expect(statSync(join(root, "ignored", "ignored.ts")).isFile()).toBe(true);
    expect(statSync(join(root, "nested", ".git")).isDirectory()).toBe(true);
    expect(generated.commands.refs.expectNonEmpty).toBe(true);

    const profiled = await new DaemonWorkspaceProfiler().profile(root);
    expect(profiled.visibleTypeScriptFiles).toBe(12);
  });

  it.each([1, 2, 3, 10] as const)("scales connected visible files and counts at %ix", async (scale) => {
    const root = TestWorkspace.create(roots);

    const generated = await TestWorkspace.generate(root, scale, `scale-${scale}`);
    const profiled = await new DaemonWorkspaceProfiler().profile(root);

    expect(profiled.visibleTypeScriptFiles).toBe(12 * scale);
    expect(generated.expectedProfile.visibleTypeScriptFiles).toBe(12 * scale);
    expect(generated.expectedProfile.sourceBytes).toEqual(TestWorkspace.profile.sourceBytes);
  });
});

class TestWorkspace {
  static readonly profile: DaemonWorkspaceProfile = {
    schemaVersion: 1,
    profileVersion: "1.0.0",
    visibleTypeScriptFiles: 12,
    sourceBytes: { minimum: 40, p50: 120, p95: 240, maximum: 320 },
    sourceLines: { minimum: 2, p50: 5, p95: 10, maximum: 14 },
    symbolsPerFile: { minimum: 1, p50: 2, p95: 4, maximum: 5 },
    packageCount: 3,
    configCount: 4,
    projectReferenceCount: 3,
    importsPerFile: { minimum: 1, p50: 2, p95: 3, maximum: 4 },
    referenceFanout: { minimum: 1, p50: 4, p95: 10, maximum: 12 },
    aliasImportRatio: 0.5,
    workspaceImportRatio: 0.5,
    callInDegree: { minimum: 0, p50: 1, p95: 4, maximum: 8 },
    callOutDegree: { minimum: 1, p50: 2, p95: 4, maximum: 8 },
    callDepth: { minimum: 1, p50: 2, p95: 3, maximum: 4 },
    cycleRatio: 0.1,
    declarationKindCounts: { function: 24 },
    representativeResultCounts: {
      overview: 2,
      resolve: 1,
      def: 1,
      refs: 10,
      context: 4,
      graph: 4,
      stats: 1,
      help: 0,
      version: 0,
      unknown: 0,
    },
    ignoredPathRatio: 0.1,
    nestedWorkspaceRatio: 0.1,
  };

  static create(roots: string[]): string {
    const root = mkdtempSync(join(tmpdir(), "symnav-generated-workspace-"));
    roots.push(root);
    return root;
  }

  static generate(root: string, scale: DaemonBenchmarkScale, seed: string) {
    return new DaemonWorkspaceGenerator({
      profile: this.profile,
      generatorVersion: "1.0.0",
      seed,
      scale,
    }).generate(root);
  }

  static manifest(root: string): readonly string[] {
    return this.files(root)
      .filter((path) => !relative(root, path).split(/[/\\]/).includes(".git"))
      .map((path) => {
        const relativePath = relative(root, path).replaceAll("\\", "/");
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        return `${relativePath}:${digest}:${readFileSync(path, "utf8")}`;
      });
  }

  static history(root: string): readonly string[] {
    return execFileSync("git", ["-C", root, "log", "--format=%s:%ct"], { encoding: "utf8" })
      .trim()
      .split("\n");
  }

  private static files(root: string): readonly string[] {
    const paths: string[] = [];
    const pending = [root];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const name of readdirSync(directory).sort()) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) pending.push(path);
        else paths.push(path);
      }
    }
    return paths.sort();
  }
}
