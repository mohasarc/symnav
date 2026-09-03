import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { SyntaxKind } from "ts-morph";

import {
  GraphTraverser,
  InMemoryFileSystem,
  NodeFileSystem,
  type SymbolIdentity,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";
import type { TypeScriptProjectGraph } from "./typescript-project-graph.js";
import { TypeScriptSemanticQueryService } from "./typescript-semantic-query-service.js";
import { TypeScriptWorkspaceState } from "./typescript-workspace-state.js";

const mutableFixtures: MutableSemanticFixture[] = [];

afterEach(() => {
  for (const fixture of mutableFixtures.splice(0)) fixture.dispose();
});

describe("TypeScriptSemanticQueryService", () => {
  it("shares each identity query promise independently within one turn", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/src/app.ts": [
        "export function target(): void {}",
        "export function caller(): void { target(); }",
        "",
      ].join("\n"),
    });
    const files = workspaceFiles(fileSystem, "src/app.ts");
    const snapshot: WorkspaceSnapshot = { root: "/repo", files };
    const state = new TypeScriptWorkspaceState(fileSystem);
    await state.refresh(files);
    const queries = new TypeScriptSemanticQueryService(undefined, state);
    const target = identity("src/app.ts", "target");
    const caller = identity("src/app.ts", "caller");
    queries.beginTurn(snapshot.files);

    const definitions = queries.findDefinitions(target);
    const callTarget = queries.findCallTarget(target);
    const callers = queries.findCallers(target);
    const callees = queries.findCallees(caller);

    expect(queries.findDefinitions(target)).toBe(definitions);
    expect(queries.findCallTarget(target)).toBe(callTarget);
    expect(queries.findCallers(target)).toBe(callers);
    expect(queries.findCallees(caller)).toBe(callees);
    await expect(definitions).resolves.toHaveLength(1);
    await expect(callTarget).resolves.toMatchObject({ outcome: "resolved" });
    await expect(callers).resolves.toHaveLength(1);
    await expect(callees).resolves.toHaveLength(1);
  });

  it("caches empty position results while rehydrating nodes for every access", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/src/app.ts": [
        "export function target(): void {}",
        "export function caller(): void { target(); missing(); }",
        "",
      ].join("\n"),
    });
    const files = workspaceFiles(fileSystem, "src/app.ts");
    const state = new TypeScriptWorkspaceState(fileSystem);
    await state.refresh(files);
    const resolvedPositions: number[] = [];
    const queries = new TypeScriptSemanticQueryService(undefined, state, {
      callTargetResolution: (_relativePath, start) => resolvedPositions.push(start),
    });
    queries.beginTurn(files);
    const sourceFile = state.sourceFile("src/app.ts");
    const identifiers = sourceFile?.getDescendantsOfKind(SyntaxKind.Identifier) ?? [];
    const targetCall = [...identifiers].reverse().find((node) => node.getText() === "target");
    const missingCall = [...identifiers].reverse().find((node) => node.getText() === "missing");
    if (!targetCall || !missingCall) throw new Error("expected call identifiers");

    const firstDefinitions = queries.definitionNodesOf(targetCall);
    const secondDefinitions = queries.definitionNodesOf(targetCall);
    const firstMissing = queries.definitionNodesOf(missingCall);
    const secondMissing = queries.definitionNodesOf(missingCall);

    expect(firstDefinitions).not.toBe(secondDefinitions);
    expect(firstDefinitions[0]).toBe(secondDefinitions[0]);
    expect(firstMissing).toEqual([]);
    expect(secondMissing).toEqual([]);
    expect(resolvedPositions).toEqual([targetCall.getStart(), missingCall.getStart()]);
  });

  it("retains asynchronous definition and callee failures for the turn", async () => {
    const failure = new Error("semantic failure");
    const ensureFiles = vi.fn(() => Promise.reject(failure));
    const state = { ensureFiles } as unknown as TypeScriptWorkspaceState;
    const queries = new TypeScriptSemanticQueryService(undefined, state);
    const target = identity("src/app.ts", "target");
    queries.beginTurn([]);

    const definitions = queries.findDefinitions(target);
    const callees = queries.findCallees(target);

    expect(queries.findDefinitions(target)).toBe(definitions);
    expect(queries.findCallees(target)).toBe(callees);
    await expect(definitions).rejects.toBe(failure);
    await expect(callees).rejects.toBe(failure);
    expect(ensureFiles).toHaveBeenCalledTimes(2);
  });

  it("retries synchronous reference discovery failures", async () => {
    const failure = new Error("reference failure");
    const locateSemanticCopies = vi.fn(() => {
      throw failure;
    });
    const state = { locateSemanticCopies } as unknown as TypeScriptWorkspaceState;
    let referenceSearches = 0;
    const queries = new TypeScriptSemanticQueryService(undefined, state, {
      referenceSearch: () => {
        referenceSearches += 1;
      },
    });
    const target = identity("src/app.ts", "target");
    queries.beginTurn([]);

    await expect(queries.findReferences(target)).rejects.toBe(failure);
    await expect(queries.findReferences(target)).rejects.toBe(failure);

    expect(locateSemanticCopies).toHaveBeenCalledTimes(2);
    expect(referenceSearches).toBe(2);
  });

  it("preserves the current turn when backend refresh fails", async () => {
    const failure = new Error("refresh failure");
    let refreshFails = false;
    const state = {
      refresh: vi.fn(() => {
        if (refreshFails) return Promise.reject(failure);
        return Promise.resolve({ added: 0, changed: 0, removed: 0, unchanged: 0 });
      }),
      ensureFiles: vi.fn(() => Promise.resolve()),
      locate: vi.fn(() => []),
    } as unknown as TypeScriptWorkspaceState;
    let definitionSearches = 0;
    const backend = new TypeScriptBackend(new InMemoryFileSystem({}), state, undefined, {
      definitionSearch: () => {
        definitionSearches += 1;
      },
    });
    const snapshot: WorkspaceSnapshot = { root: "/repo", files: [] };
    const target = identity("src/app.ts", "target");
    await backend.refresh({ snapshot, coverage: "workspace" });
    const definitions = await backend.findDefinitions([], target);
    refreshFails = true;

    await expect(backend.refresh({ snapshot, coverage: "workspace" })).rejects.toBe(failure);

    await expect(backend.findDefinitions([], target)).resolves.toBe(definitions);
    expect(definitionSearches).toBe(1);
  });

  it("clears caches before awaiting project release and rejects at the backend boundary", async () => {
    const releaseFailure = new Error("project release failed");
    let rejectProjectRelease: ((reason: unknown) => void) | undefined;
    const projectRelease = new Promise<void>((_resolve, reject) => {
      rejectProjectRelease = reject;
    });
    void projectRelease.catch(() => undefined);
    const firstProjectRelease = vi.fn(() => projectRelease);
    const laterProjectRelease = vi.fn();
    const projectGraph = {
      releaseTransientResources: vi.fn(async () => {
        await firstProjectRelease();
        laterProjectRelease();
      }),
    } as unknown as TypeScriptProjectGraph;
    const state = {
      refresh: vi.fn(() => Promise.resolve({ added: 0, changed: 0, removed: 0, unchanged: 0 })),
      ensureFiles: vi.fn(() => Promise.resolve()),
      locate: vi.fn(() => []),
    } as unknown as TypeScriptWorkspaceState;
    let definitionSearches = 0;
    const backend = new TypeScriptBackend(new InMemoryFileSystem({}), state, projectGraph, {
      definitionSearch: () => {
        definitionSearches += 1;
      },
    });
    const snapshot: WorkspaceSnapshot = { root: "/repo", files: [] };
    const target = identity("src/app.ts", "target");
    await backend.refresh({ snapshot, coverage: "selection" });
    const beforeRelease = await backend.findDefinitions([], target);

    const release = backend.releaseTransientResources();
    let releaseSettled = false;
    void release.then(
      () => {
        releaseSettled = true;
      },
      () => {
        releaseSettled = true;
      },
    );
    const afterRelease = await backend.findDefinitions([], target);

    expect(afterRelease).not.toBe(beforeRelease);
    expect(definitionSearches).toBe(2);
    expect(projectGraph.releaseTransientResources).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(releaseSettled).toBe(false);

    rejectProjectRelease?.(releaseFailure);
    await expect(release).rejects.toBe(releaseFailure);
    expect(firstProjectRelease).toHaveBeenCalledOnce();
    expect(laterProjectRelease).not.toHaveBeenCalled();
  });

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

  it("rebuilds released fresh semantics once in an unchanged turn", async () => {
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

    await expect(
      backend.resolveSymbols(files, "originalTarget", { mode: "exact" }),
    ).resolves.toEqual([]);
    await expect(backend.findDefinitions(files, stable)).resolves.toContain(preparedDeclaration);
    await expect(backend.fileEntries(stableFile)).resolves.toBe(preparedEntries);

    const fresh = identity("src/lib.ts", "freshTarget");
    const preparedReferences = await backend.findReferences(files, fresh);
    const preparedCallers = await backend.findCallers(files, fresh);
    const preparedCallees = await backend.findCallees(files, fresh);
    expect(semanticProjectLoads).toBe(2);
    expect(referenceSearches).toBe(2);

    await backend.releaseTransientResources();
    await backend.refresh({ snapshot, coverage: "workspace" });

    expect(semanticReleases).toBe(1);
    expect(semanticProjectLoads).toBe(2);
    await expect(backend.findDefinitions(files, stable)).resolves.toContain(preparedDeclaration);
    await expect(backend.fileEntries(stableFile)).resolves.toBe(preparedEntries);

    await expect(backend.findReferences(files, fresh)).resolves.toEqual(preparedReferences);
    expect(semanticProjectLoads).toBe(3);
    await expect(backend.findCallers(files, fresh)).resolves.toEqual(preparedCallers);
    await expect(backend.findCallees(files, fresh)).resolves.toEqual(preparedCallees);
    expect(semanticProjectLoads).toBe(3);
    expect(referenceSearches).toBe(3);
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
