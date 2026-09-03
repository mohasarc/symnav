import { describe, expect, it } from "vitest";

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
import type { ResolvedPath } from "./workspace.js";
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
});

function workspaceFileSystem(): InMemoryFileSystem {
  return new InMemoryFileSystem({
    "/repo/.git/HEAD": "ref: refs/heads/main\n",
    "/repo/src/a.ts": "export const a = true;\n",
  });
}
