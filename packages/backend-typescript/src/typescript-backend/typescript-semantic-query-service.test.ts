import { describe, expect, it } from "vitest";

import { InMemoryFileSystem, type SymbolIdentity, type WorkspaceFile } from "@symnav/core";

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
