import { describe, expect, it } from "vitest";

import { TypeScriptBackend, TypeScriptWorkspaceState } from "@symnav/backend-typescript";
import {
  InMemoryFileSystem,
  type FileMetadata,
  type Workspace,
  WorkspaceCatalog,
} from "@symnav/core";

import { FakeLanguageBackend } from "../test/integration/commands/helpers/fake-language-backend.js";
import { WorkspaceRequestScopeFactory } from "./workspace-request-scope.js";

class FailingSiblingMetadataFileSystem extends InMemoryFileSystem {
  readonly siblingMetadataReads: string[] = [];
  private failSiblingMetadata = false;

  failUnrelatedSiblingMetadata(): void {
    this.failSiblingMetadata = true;
    this.siblingMetadataReads.length = 0;
  }

  override async metadata(absPath: string): Promise<FileMetadata> {
    if (absPath.startsWith("/repo/siblings/")) {
      this.siblingMetadataReads.push(absPath);
      if (this.failSiblingMetadata) {
        throw new Error(`unrelated metadata failure: ${absPath}`);
      }
    }
    return super.metadata(absPath);
  }
}

describe("WorkspaceRequestScopeFactory", () => {
  it("creates fresh request snapshots while reusing the provided backend instances", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = 1;\n",
    });
    const backend = new FakeLanguageBackend({ accept: (path) => path.endsWith(".ts") });
    const factory = new WorkspaceRequestScopeFactory(fs, [backend]);

    const first = await factory.prepare("/repo");
    const second = await factory.prepare("/repo");

    expect(first.workspace).not.toBe(second.workspace);
    expect(first.snapshot).not.toBe(second.snapshot);
    expect(first.snapshot.files.map((file) => file.relative)).toEqual(["src/a.ts"]);
    expect(second.snapshot.files.map((file) => file.relative)).toEqual(["src/a.ts"]);
    expect(first.router.find("src/a.ts")).toBe(backend);
    expect(second.router.find("src/a.ts")).toBe(backend);
    expect(first.refresh).toEqual({ added: 1, changed: 0, removed: 0, unchanged: 0 });
    expect(second.refresh).toEqual({ added: 1, changed: 0, removed: 0, unchanged: 0 });
    expect(backend.refreshCalls).toHaveLength(2);
  });

  it("retains omitted siblings across an overview-style partial scope", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = 1;\n",
      "/repo/src/b.ts": "export const b = 2;\n",
    });
    const state = new TypeScriptWorkspaceState(fs);
    const backend = new TypeScriptBackend(fs, state);
    const factory = new WorkspaceRequestScopeFactory(fs, [backend]);

    const firstFullScope = await factory.prepare("/repo");
    const siblingSourceFile = state.sourceFile("src/b.ts");
    const overviewScope = await factory.prepare("/repo", async (workspace) => {
      const fullSnapshot = await workspace.snapshot();
      return {
        root: fullSnapshot.root,
        files: fullSnapshot.files.filter((file) => file.relative === "src/a.ts"),
      };
    });

    expect(firstFullScope.refresh).toEqual({
      added: 2,
      changed: 0,
      removed: 0,
      unchanged: 0,
    });
    expect(overviewScope.refresh).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 1,
    });
    expect(siblingSourceFile).toBeDefined();
    expect(state.currentFileCount()).toBe(2);
    expect(state.sourceFile("src/b.ts")).toBe(siblingSourceFile);

    const secondFullScope = await factory.prepare("/repo");

    expect(secondFullScope.refresh).toEqual({
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 2,
    });
    expect(state.sourceFile("src/b.ts")).toBe(siblingSourceFile);
  });

  it("publishes a new immutable catalog turn only when prepare starts", async () => {
    const fs = new InMemoryFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = 1;\n",
    });
    const backend = new FakeLanguageBackend({ accept: (path) => path.endsWith(".ts") });
    const factory = new WorkspaceRequestScopeFactory(fs, [backend], new WorkspaceCatalog(fs));

    const first = await factory.prepare("/repo");
    const second = await factory.prepare("/repo");

    expect(first.workspace).not.toBe(second.workspace);
    expect(first.snapshot).not.toBe(second.snapshot);
    expect(Object.isFrozen(first.snapshot)).toBe(true);
    expect(Object.isFrozen(first.snapshot.files)).toBe(true);
    expect(first.snapshot.files[0]).toBe(second.snapshot.files[0]);
  });

  it("prepares a retained selection without reconciling unrelated siblings", async () => {
    const siblings = Object.fromEntries(
      Array.from({ length: 4_000 }, (_, index) => [
        `/repo/siblings/file-${index}.ts`,
        `export const sibling${index} = ${index};\n`,
      ]),
    );
    const fs = new FailingSiblingMetadataFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/target.ts": "export const target = true;\n",
      ...siblings,
    });
    const catalog = new WorkspaceCatalog(fs);
    await catalog.refresh("/repo");
    fs.failUnrelatedSiblingMetadata();
    const retainedFactory = new WorkspaceRequestScopeFactory(
      fs,
      [new FakeLanguageBackend({ accept: (path) => path.endsWith(".ts") })],
      catalog,
    );
    const coldFactory = new WorkspaceRequestScopeFactory(fs, [
      new FakeLanguageBackend({ accept: (path) => path.endsWith(".ts") }),
    ]);
    const selectTarget = async (workspace: Workspace) => {
      const target = await workspace.resolveInputPath("src/target.ts", "/repo");
      return workspace.snapshot([target]);
    };

    const retained = await retainedFactory.prepare("/repo", selectTarget);
    const cold = await coldFactory.prepare("/repo", selectTarget);

    expect(retained.snapshot).toEqual(cold.snapshot);
    expect(retained.snapshot.files.map((file) => file.relative)).toEqual(["src/target.ts"]);
    expect(fs.siblingMetadataReads).toEqual([]);
  });
});
