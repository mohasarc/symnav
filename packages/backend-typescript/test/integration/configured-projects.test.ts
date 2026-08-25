import { describe, expect, it } from "vitest";
import { fixturePath } from "@symnav/testing";
import {
  NodeFileSystem,
  type ResolvedPath,
  type SymbolIdentity,
  type WorkspaceSnapshot,
} from "@symnav/core";

import { TypeScriptBackend } from "../../src/typescript-backend/typescript-backend.js";

const workspaceRoot = fixturePath("configured-project-cases");

describe("TypeScriptBackend configured projects", () => {
  it("resolves references and call targets through path and workspace package imports", async () => {
    const { backend, files } = await backendOverFixture();
    const appIdentity = identity("packages/app/src/index.ts", "useConfiguredImports");

    const callees = await backend.findCallees(files, appIdentity);

    expect(callees.map((edge) => edge.symbol.identity)).toEqual([
      identity("packages/domain/src/index.ts", "workspaceTarget"),
      identity("packages/domain/src/index.ts", "pathTarget"),
    ]);
    await expect(
      backend.findReferences(files, identity("packages/domain/src/index.ts", "workspaceTarget")),
    ).resolves.not.toHaveLength(0);
    await expect(
      backend.findReferences(files, identity("packages/domain/src/index.ts", "pathTarget")),
    ).resolves.not.toHaveLength(0);
  });

  it("keeps files outside configured membership in an inferred project", async () => {
    const { backend, files } = await backendOverFixture();
    const inferred = identity("scratch/outside.ts", "inferredTarget");

    await expect(backend.findDefinitions(files, inferred)).resolves.toHaveLength(1);
    await expect(backend.findReferences(files, inferred)).resolves.toHaveLength(1);
    await expect(backend.findCallTarget(files, inferred)).resolves.toMatchObject({
      outcome: "resolved",
      target: { identity: inferred },
    });
  });

  it("keeps repeated path aliases owned by their configured projects", async () => {
    const { backend, files } = await backendOverFixture();

    await expect(
      backend.findCallees(files, identity("packages/domain/src/index.ts", "useDomainLocal")),
    ).resolves.toMatchObject([
      { symbol: { identity: identity("packages/domain/src/local.ts", "domainLocalTarget") } },
    ]);
    await expect(
      backend.findCallees(files, identity("packages/app/src/index.ts", "useAppLocal")),
    ).resolves.toMatchObject([
      { symbol: { identity: identity("packages/app/src/local.ts", "appLocalTarget") } },
    ]);
  });
});

async function backendOverFixture(): Promise<{
  readonly backend: TypeScriptBackend;
  readonly files: readonly ResolvedPath[];
}> {
  const fileSystem = new NodeFileSystem();
  const sourceFiles = [
    "packages/app/src/index.ts",
    "packages/app/src/local.ts",
    "packages/domain/src/index.ts",
    "packages/domain/src/local.ts",
    "scratch/outside.ts",
  ];
  const acceptedSnapshot: WorkspaceSnapshot = {
    root: workspaceRoot,
    files: await Promise.all(
      sourceFiles.map(async (relative) => {
        const absolute = `${workspaceRoot}/${relative}`;
        return { relative, absolute, metadata: await fileSystem.metadata(absolute) };
      }),
    ),
  };
  const backend = new TypeScriptBackend(fileSystem);
  await backend.refresh({ snapshot: acceptedSnapshot, coverage: "workspace" });
  return { backend, files: acceptedSnapshot.files };
}

function identity(file: string, name: string): SymbolIdentity {
  return { file, segments: [{ name }] };
}
