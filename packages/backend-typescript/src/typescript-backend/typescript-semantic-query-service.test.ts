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
