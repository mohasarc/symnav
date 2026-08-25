import { describe, expect, it } from "vitest";

import {
  InMemoryFileSystem,
  type SymbolIdentity,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from "@symnav/core";

import { TypeScriptBackend } from "./typescript-backend.js";

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
});

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
