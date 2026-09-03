import { describe, expect, it, vi } from "vitest";

import type { CallEdge } from "../intermediate-representation/call-edge.js";
import type { CallTargetResolution } from "../intermediate-representation/call-target.js";
import type { OverviewFileEntries } from "../intermediate-representation/overview-tree.js";
import type { SymbolReference } from "../intermediate-representation/references.js";
import type { SymbolOverviewNode } from "../intermediate-representation/overview-tree.js";
import type {
  BackendRefreshRequest,
  BackendRefreshSummary,
  LanguageBackend,
} from "../backend/language-backend.js";
import type { ResolvedPath, Workspace } from "./workspace.js";
import { InMemoryFileSystem } from "./in-memory/in-memory-file-system.js";
import { WorkspaceSession } from "./workspace-session.js";

class RecordingBackend implements LanguageBackend {
  readonly refreshCalls: BackendRefreshRequest[] = [];
  readonly releaseCalls: number[] = [];

  constructor(
    readonly name: string,
    private readonly acceptsPath: (path: string) => boolean = () => true,
    private readonly refreshResult: BackendRefreshSummary = {
      added: 0,
      changed: 0,
      removed: 0,
      unchanged: 0,
    },
    private readonly release: () => Promise<void> = async () => undefined,
  ) {}

  accepts(filePath: string): boolean {
    return this.acceptsPath(filePath);
  }

  async refresh(request: BackendRefreshRequest): Promise<BackendRefreshSummary> {
    this.refreshCalls.push(request);
    return this.refreshResult;
  }

  releaseTransientResources(): Promise<void> {
    this.releaseCalls.push(this.releaseCalls.length + 1);
    return this.release();
  }

  async fileEntries(path: ResolvedPath): Promise<OverviewFileEntries> {
    return { file: path.relative, entries: [] };
  }

  async resolveSymbols(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async declarations(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async findDefinitions(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async findReferences(): Promise<readonly SymbolReference[]> {
    return [];
  }

  async findCallTarget(): Promise<CallTargetResolution> {
    return { outcome: "not-found" };
  }

  async findCallees(): Promise<readonly CallEdge[]> {
    return [];
  }

  async findCallers(): Promise<readonly CallEdge[]> {
    return [];
  }
}

class SelectiveFailureFileSystem extends InMemoryFileSystem {
  failPath: string | undefined;

  override async metadata(absPath: string) {
    if (absPath === this.failPath) throw new Error(`metadata failed: ${absPath}`);
    return super.metadata(absPath);
  }
}

describe("WorkspaceSession", () => {
  it("returns fresh turns while only session discovery retains file identity", async () => {
    const fileSystem = workspaceFileSystem();
    const requestSession = new WorkspaceSession({
      fileSystem,
      backends: [new RecordingBackend("request")],
      discoveryRetention: "request",
    });
    const retainedSession = new WorkspaceSession({
      fileSystem,
      backends: [new RecordingBackend("session")],
      discoveryRetention: "session",
    });

    const firstRequest = await requestSession.prepare("/repo");
    const secondRequest = await requestSession.prepare("/repo");
    const firstRetained = await retainedSession.prepare("/repo");
    const secondRetained = await retainedSession.prepare("/repo");

    expect(firstRequest.workspace).not.toBe(secondRequest.workspace);
    expect(firstRequest.snapshot).not.toBe(secondRequest.snapshot);
    expect(firstRequest.router).not.toBe(secondRequest.router);
    expect(firstRequest.snapshot.files[0]).not.toBe(secondRequest.snapshot.files[0]);
    expect(firstRetained.workspace).not.toBe(secondRetained.workspace);
    expect(firstRetained.snapshot).not.toBe(secondRetained.snapshot);
    expect(firstRetained.router).not.toBe(secondRetained.router);
    expect(firstRetained.snapshot.files[0]).toBe(secondRetained.snapshot.files[0]);
  });

  it.each(["request", "session"] as const)(
    "uses fresh lazy selection discovery for %s retention",
    async (discoveryRetention) => {
      const fileSystem = new SelectiveFailureFileSystem({
        "/repo/.git/HEAD": "ref: refs/heads/main\n",
        "/repo/src/target.ts": "export const target = true;\n",
        "/repo/src/sibling.ts": "export const sibling = true;\n",
      });
      const backend = new RecordingBackend(discoveryRetention);
      const session = new WorkspaceSession({ fileSystem, backends: [backend], discoveryRetention });
      if (discoveryRetention === "session") await session.prepare("/repo");
      fileSystem.failPath = "/repo/src/sibling.ts";

      const selected = await session.prepare("/repo", {
        coverage: "selection",
        selectSnapshot: select("src/target.ts", "/repo"),
      });

      expect(selected.snapshot.files.map((file) => file.relative)).toEqual(["src/target.ts"]);
      expect(backend.refreshCalls.at(-1)?.coverage).toBe("selection");
      fileSystem.failPath = undefined;
      await session.prepare("/repo");
      expect(backend.refreshCalls.at(-1)?.coverage).toBe("workspace");
    },
  );

  it("copies backend order and creates a new first-accepting router for each turn", async () => {
    const first = new RecordingBackend("first");
    const second = new RecordingBackend("second");
    const suppliedBackends: LanguageBackend[] = [first, second];
    const session = new WorkspaceSession({
      fileSystem: workspaceFileSystem(),
      backends: suppliedBackends,
      discoveryRetention: "request",
    });
    suppliedBackends.reverse();

    const firstTurn = await session.prepare("/repo");
    const secondTurn = await session.prepare("/repo");

    expect(firstTurn.router).not.toBe(secondTurn.router);
    expect(firstTurn.router.find("src/a.ts")).toBe(first);
    expect(first.refreshCalls[0]?.snapshot.files).toHaveLength(1);
    expect(second.refreshCalls[0]?.snapshot.files).toHaveLength(0);
    expect(session).not.toHaveProperty("backends");
  });

  it("does not refresh backends when selection fails", async () => {
    const backend = new RecordingBackend("backend");
    const session = new WorkspaceSession({
      fileSystem: workspaceFileSystem(),
      backends: [backend],
      discoveryRetention: "session",
    });

    await expect(
      session.prepare("/repo", {
        coverage: "selection",
        selectSnapshot: async () => {
          throw new Error("selection failed");
        },
      }),
    ).rejects.toThrow("selection failed");
    expect(backend.refreshCalls).toEqual([]);
  });

  it("returns no stale scope when retained catalog discovery fails", async () => {
    const fileSystem = new SelectiveFailureFileSystem({
      "/repo/.git/HEAD": "ref: refs/heads/main\n",
      "/repo/src/a.ts": "export const a = true;\n",
    });
    const backend = new RecordingBackend("backend");
    const session = new WorkspaceSession({
      fileSystem,
      backends: [backend],
      discoveryRetention: "session",
    });
    await session.prepare("/repo");
    fileSystem.failPath = "/repo/src/a.ts";

    await expect(session.prepare("/repo")).rejects.toThrow("metadata failed: /repo/src/a.ts");
    expect(backend.refreshCalls).toHaveLength(1);
  });

  it("does not return a scope after a later backend fails following an earlier commit", async () => {
    const first = new RecordingBackend("first", (path) => path.endsWith(".ts"), {
      added: 1,
      changed: 0,
      removed: 0,
      unchanged: 0,
    });
    const second = new RecordingBackend(
      "second",
      () => false,
      undefined,
      async () => undefined,
    );
    second.refresh = vi.fn(async () => {
      throw new Error("later backend failed");
    });
    const session = new WorkspaceSession({
      fileSystem: workspaceFileSystem(),
      backends: [first, second],
      discoveryRetention: "request",
    });

    await expect(session.prepare("/repo")).rejects.toThrow("later backend failed");
    expect(first.refreshCalls).toHaveLength(1);
    expect(second.refresh).toHaveBeenCalledOnce();
  });

  it("retains independent catalogs for multiple accepted roots", async () => {
    const fileSystem = new InMemoryFileSystem({
      "/first/.git/HEAD": "ref: refs/heads/main\n",
      "/first/a.ts": "export const a = true;\n",
      "/second/.git/HEAD": "ref: refs/heads/main\n",
      "/second/b.ts": "export const b = true;\n",
    });
    const session = new WorkspaceSession({
      fileSystem,
      backends: [new RecordingBackend("backend")],
      discoveryRetention: "session",
    });

    const first = await session.prepare("/first");
    const second = await session.prepare("/second");
    const retainedFirst = await session.prepare("/first");

    expect(first.workspace.root).toBe("/first");
    expect(second.workspace.root).toBe("/second");
    expect(first.snapshot.files[0]).toBe(retainedFirst.snapshot.files[0]);
  });
});

function workspaceFileSystem(): InMemoryFileSystem {
  return new InMemoryFileSystem({
    "/repo/.git/HEAD": "ref: refs/heads/main\n",
    "/repo/src/a.ts": "export const a = true;\n",
  });
}

function select(relativePath: string, cwd: string) {
  return async (workspace: Workspace) => {
    const path = await workspace.resolveInputPath(relativePath, cwd);
    return workspace.snapshot([path]);
  };
}
