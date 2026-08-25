import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  GraphTraverser,
  InMemoryFileSystem,
  NodeFileSystem,
  type SymbolIdentity,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";

const mutableFixtures: MutableSemanticFixture[] = [];

afterEach(() => {
  for (const fixture of mutableFixtures.splice(0)) fixture.dispose();
});

describe("TypeScriptSemanticQueryService", () => {
  it("shares one reference search across caller and reference projections", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/src/lib.ts": "export function target(): void {}\n",
      "/repo/src/app.ts": [
        'import { target } from "./lib.js";',
        "export function caller(): void { target(); }",
        "",
      ].join("\n"),
    });
    const referenceSearches: SymbolIdentity[] = [];
    const backend = new TypeScriptBackend(fileSystem, undefined, undefined, {
      referenceSearch: (identity) => referenceSearches.push(identity),
    });
    const files = workspaceFiles(fileSystem, "src/app.ts", "src/lib.ts");
    const target = identity("src/lib.ts", "target");
    await backend.refresh({ snapshot: { root: "/repo", files }, coverage: "workspace" });

    await expect(backend.findCallers(files, target)).resolves.toHaveLength(1);
    await expect(backend.findReferences(files, target)).resolves.toHaveLength(2);
    expect(referenceSearches).toEqual([target]);
  });

  it("shares caches within one turn and clears them for the next turn", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/src/lib.ts": "export function target(): void {}\n",
      "/repo/src/app.ts": [
        'import { target } from "./lib.js";',
        "export function caller(): void { target(); }",
        "",
      ].join("\n"),
    });
    let referenceSearches = 0;
    const backend = new TypeScriptBackend(fileSystem, undefined, undefined, {
      referenceSearch: () => {
        referenceSearches += 1;
      },
    });
    const files = workspaceFiles(fileSystem, "src/app.ts", "src/lib.ts");
    const snapshot: WorkspaceSnapshot = { root: "/repo", files };
    const target = identity("src/lib.ts", "target");
    await backend.refresh({ snapshot, coverage: "workspace" });

    await backend.findReferences(files, target);
    await backend.findReferences(files, target);
    expect(referenceSearches).toBe(1);

    await backend.refresh({ snapshot, coverage: "workspace" });
    await backend.findReferences(files, target);
    expect(referenceSearches).toBe(2);
  });

  it("resolves each call position once while grouping repeated targets", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/src/app.ts": [
        "export function target(value: string): string;",
        "export function target(value: number): string;",
        "export function target(value: string | number): string { return String(value); }",
        "export function caller(): string { return `${target(1)}:${target('x')}`; }",
        "",
      ].join("\n"),
    });
    const resolvedPositions: string[] = [];
    const backend = new TypeScriptBackend(fileSystem, undefined, undefined, {
      callTargetResolution: (relativePath, start) =>
        resolvedPositions.push(`${relativePath}:${start}`),
    });
    const files = workspaceFiles(fileSystem, "src/app.ts");
    const caller = identity("src/app.ts", "caller");
    await backend.refresh({ snapshot: { root: "/repo", files }, coverage: "workspace" });

    const first = await backend.findCallees(files, caller);
    const second = await backend.findCallees(files, caller);

    expect(first).toBe(second);
    expect(first.map((edge) => edge.symbol.kind.nativeLabel)).toEqual([
      "function-overload-signature",
      "function-overload-signature",
    ]);
    expect(resolvedPositions).toHaveLength(2);
    expect(new Set(resolvedPositions).size).toBe(2);
  });

  it("queries each declaration position once across diamond graph paths", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/src/graph.ts": [
        "export function leaf(): void {}",
        "export function left(): void { leaf(); }",
        "export function right(): void { leaf(); }",
        "export function root(): void { left(); right(); }",
        "",
      ].join("\n"),
    });
    const resolvedPositions: string[] = [];
    const backend = new TypeScriptBackend(fileSystem, undefined, undefined, {
      callTargetResolution: (relativePath, start) =>
        resolvedPositions.push(`${relativePath}:${start}`),
    });
    const files = workspaceFiles(fileSystem, "src/graph.ts");
    await backend.refresh({ snapshot: { root: "/repo", files }, coverage: "workspace" });
    const [root] = await backend.findDefinitions(files, identity("src/graph.ts", "root"));
    if (!root) throw new Error("expected root declaration");

    const paths = await new GraphTraverser({ backend, files, root, depth: 2 }).traverseOutgoing();

    expect(paths).toHaveLength(2);
    expect(paths.map((path) => path.steps.at(-1)?.symbol.identity)).toEqual([
      identity("src/graph.ts", "leaf"),
      identity("src/graph.ts", "leaf"),
    ]);
    expect(resolvedPositions).toHaveLength(4);
    expect(new Set(resolvedPositions).size).toBe(4);
  });

  it("rebuilds released semantics once from fresh source and configuration", async () => {
    const fixture = new MutableSemanticFixture();
    mutableFixtures.push(fixture);
    let referenceSearches = 0;
    let semanticReleases = 0;
    let semanticProjectLoads = 0;
    const backend = new TypeScriptBackend(fixture.fileSystem, undefined, undefined, {
      referenceSearch: () => {
        referenceSearches += 1;
      },
      semanticCacheReleased: () => {
        semanticReleases += 1;
      },
      semanticProjectLoaded: () => {
        semanticProjectLoads += 1;
      },
    });
    let snapshot = await fixture.snapshot();
    let files = snapshot.files;
    const stable = identity("src/stable.ts", "stableTarget");
    const original = identity("src/lib.ts", "originalTarget");
    await backend.refresh({ snapshot, coverage: "workspace" });
    const [preparedDeclaration] = await backend.findDefinitions(files, stable);
    const stableFile = files.find((file) => file.relative === "src/stable.ts");
    if (!stableFile) throw new Error("expected stable source");
    const preparedEntries = await backend.fileEntries(stableFile);
    await expect(backend.findReferences(files, original)).resolves.toHaveLength(2);
    expect(semanticProjectLoads).toBe(1);

    await backend.releaseTransientResources();
    fixture.writeConfiguration("@fresh");
    fixture.write("src/lib.ts", "export function freshTarget(): void {}\n");
    fixture.write(
      "src/app.ts",
      [
        'import { freshTarget } from "@fresh";',
        "export function caller(): void { freshTarget(); }",
        "",
      ].join("\n"),
    );
    snapshot = await fixture.snapshot();
    files = snapshot.files;
    await backend.refresh({ snapshot, coverage: "workspace" });

    expect(semanticReleases).toBe(1);
    await expect(
      backend.resolveSymbols(files, "originalTarget", { mode: "exact" }),
    ).resolves.toEqual([]);
    await expect(backend.findDefinitions(files, stable)).resolves.toContain(preparedDeclaration);
    await expect(backend.fileEntries(stableFile)).resolves.toBe(preparedEntries);

    const fresh = identity("src/lib.ts", "freshTarget");
    await expect(backend.findReferences(files, fresh)).resolves.toHaveLength(2);
    await expect(backend.findCallers(files, fresh)).resolves.toHaveLength(1);
    await expect(backend.findCallees(files, fresh)).resolves.toEqual([]);
    expect(semanticProjectLoads).toBe(2);
    expect(referenceSearches).toBe(2);
  });
});

class MutableSemanticFixture {
  readonly root = mkdtempSync(join(tmpdir(), "symnav-semantic-release-"));
  readonly fileSystem = new NodeFileSystem();

  constructor() {
    mkdirSync(join(this.root, "src"), { recursive: true });
    this.writeConfiguration("@original");
    this.write("src/lib.ts", "export function originalTarget(): void {}\n");
    this.write(
      "src/app.ts",
      [
        'import { originalTarget } from "@original";',
        "export function caller(): void { originalTarget(); }",
        "",
      ].join("\n"),
    );
    this.write("src/stable.ts", "export function stableTarget(): void {}\n");
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
  }

  write(relativePath: string, content: string): void {
    writeFileSync(join(this.root, relativePath), content);
  }

  writeConfiguration(alias: string): void {
    this.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { [alias]: ["src/lib.ts"] } },
        include: ["src/**/*.ts"],
      }),
    );
  }

  async snapshot(): Promise<WorkspaceSnapshot> {
    const relativePaths = ["src/app.ts", "src/lib.ts", "src/stable.ts"];
    return {
      root: this.root.replaceAll("\\", "/"),
      files: await Promise.all(
        relativePaths.map(async (relativePath) => {
          const absolute = join(this.root, relativePath).replaceAll("\\", "/");
          return {
            relative: relative(this.root, absolute).replaceAll("\\", "/"),
            absolute,
            metadata: await this.fileSystem.metadata(absolute),
          };
        }),
      ),
    };
  }
}

function workspaceFiles(
  fileSystem: InMemoryFileSystem,
  ...relativePaths: readonly string[]
): readonly WorkspaceFile[] {
  return relativePaths.map((relative) => ({
    relative,
    absolute: `/repo/${relative}`,
    metadata: fileSystem.metadataSync(`/repo/${relative}`),
  }));
}

function identity(file: string, name: string): SymbolIdentity {
  return { file, segments: [{ name }] };
}
