import { describe, expect, it } from "vitest";

import type { FileMetadata, FileSystem } from "../workspace/file-system.js";
import { InMemoryFileSystem } from "../workspace/in-memory/in-memory-file-system.js";
import type { ResolvedPath, WorkspaceFile } from "../workspace/workspace.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import {
  RevisionedBackendPreparation,
  RevisionedBackendState,
  type RevisionedBackendPreparationRequest,
  type RevisionedBackendPreparedFile,
} from "./revisioned-backend-state.js";

interface PreparedDetails {
  readonly content: string;
}

type CandidateFault = "duplicate" | "outside" | "wrong-revision" | "missing-change";
type FailureStage = "prepare" | "commit";

class TrackingFileSystem implements FileSystem {
  readonly reads: string[] = [];
  readonly metadataReads: string[] = [];
  private readonly delegate: InMemoryFileSystem;

  constructor(files: Record<string, string>) {
    this.delegate = new InMemoryFileSystem(files);
  }

  readFile(absPath: string): Promise<string> {
    this.reads.push(absPath);
    return this.delegate.readFile(absPath);
  }

  exists(absPath: string): Promise<boolean> {
    return this.delegate.exists(absPath);
  }

  listDir(absPath: string): Promise<readonly string[]> {
    return this.delegate.listDir(absPath);
  }

  isDirectory(absPath: string): Promise<boolean> {
    return this.delegate.isDirectory(absPath);
  }

  metadata(absPath: string): Promise<FileMetadata> {
    this.metadataReads.push(absPath);
    return this.delegate.metadata(absPath);
  }

  existsSync(absPath: string): boolean {
    return this.delegate.existsSync(absPath);
  }

  readFileSync(absPath: string): string {
    this.reads.push(absPath);
    return this.delegate.readFileSync(absPath);
  }

  listDirSync(absPath: string): readonly string[] {
    return this.delegate.listDirSync(absPath);
  }

  isDirectorySync(absPath: string): boolean {
    return this.delegate.isDirectorySync(absPath);
  }

  metadataSync(absPath: string): FileMetadata {
    this.metadataReads.push(absPath);
    return this.delegate.metadataSync(absPath);
  }
}

class FakeRevisionedBackendState extends RevisionedBackendState<PreparedDetails> {
  readonly requests: RevisionedBackendPreparationRequest<PreparedDetails>[] = [];
  candidateFault: CandidateFault | undefined;
  failureStage: FailureStage | undefined;
  rollbackCalls = 0;
  commitCalls = 0;
  preparationMode: "incremental" | "full" = "incremental";
  failPreparationNumber: number | undefined;
  private preparationCount = 0;

  constructor(private readonly trackingFileSystem: TrackingFileSystem) {
    super(trackingFileSystem);
  }

  prepared(relativePath: string): RevisionedBackendPreparedFile<PreparedDetails> | undefined {
    return this.preparedFile(relativePath);
  }

  allPrepared(): readonly RevisionedBackendPreparedFile<PreparedDetails>[] {
    return this.preparedFiles();
  }

  relativeFor(absolutePath: string): string | undefined {
    return this.relativePathForAbsolute(absolutePath);
  }

  protected createPreparation(
    request: RevisionedBackendPreparationRequest<PreparedDetails>,
  ): RevisionedBackendPreparation<PreparedDetails> {
    this.requests.push(request);
    this.preparationCount += 1;
    return new FakeRevisionedBackendPreparation(
      this,
      this.trackingFileSystem,
      request,
      this.preparationCount === this.failPreparationNumber,
    );
  }
}

class FakeRevisionedBackendPreparation extends RevisionedBackendPreparation<PreparedDetails> {
  private rolledBack = false;

  constructor(
    private readonly state: FakeRevisionedBackendState,
    private readonly fileSystem: TrackingFileSystem,
    private readonly request: RevisionedBackendPreparationRequest<PreparedDetails>,
    private readonly prepareFailure: boolean,
  ) {
    super();
  }

  async prepare(): Promise<readonly RevisionedBackendPreparedFile<PreparedDetails>[]> {
    if (this.state.failureStage === "prepare" || this.prepareFailure) {
      throw new Error("prepare failed");
    }
    const files =
      this.state.preparationMode === "full"
        ? this.request.effectiveFiles
        : this.request.changes.map((change) => change.file);
    const prepared: RevisionedBackendPreparedFile<PreparedDetails>[] = [];
    for (const file of files) {
      const content = await this.fileSystem.readFile(file.absolute);
      prepared.push(preparedFile(file, content));
    }
    return this.withFault(prepared);
  }

  async commit(): Promise<void> {
    this.state.commitCalls += 1;
    if (this.state.failureStage === "commit") throw new Error("commit failed");
  }

  async rollback(): Promise<void> {
    if (this.rolledBack) return;
    this.rolledBack = true;
    this.state.rollbackCalls += 1;
  }

  private withFault(
    prepared: readonly RevisionedBackendPreparedFile<PreparedDetails>[],
  ): readonly RevisionedBackendPreparedFile<PreparedDetails>[] {
    const first = prepared[0];
    if (!first) return prepared;
    switch (this.state.candidateFault) {
      case "duplicate":
        return [first, first];
      case "outside":
        return [{ ...first, file: workspaceFile("outside.ts", "outside") }];
      case "wrong-revision":
        return [{ ...first, file: { ...first.file, metadata: metadata("wrong") } }];
      case "missing-change":
        return [];
      case undefined:
        return prepared;
    }
  }
}

function preparedFile(
  file: WorkspaceFile,
  content: string,
): RevisionedBackendPreparedFile<PreparedDetails> {
  return {
    file,
    entries: {
      file: file.relative,
      entries: [
        {
          type: "symbol",
          identity: { file: file.relative, segments: [{ name: content }] },
          kind: { role: "value", nativeLabel: "const" },
          range: { startLine: 1, endLine: 1 },
          header: { startLine: 1, lines: [content] },
          children: [],
        },
      ],
      diagnostics: [
        { severity: "warning", message: content, dedupeKey: `${file.relative}:${content}` },
      ],
    },
    details: { content },
  };
}

function metadata(changeToken: string): FileMetadata {
  return { size: changeToken.length, modifiedAtMs: 1, changeToken };
}

function workspaceFile(
  relative: string,
  changeToken: string,
  absolute = `/repo/${relative}`,
): WorkspaceFile {
  return { relative, absolute, metadata: metadata(changeToken) };
}

function paths(...relativePaths: string[]): readonly ResolvedPath[] {
  return relativePaths.map((relative) => ({ relative, absolute: `/repo/${relative}` }));
}

describe("RevisionedBackendState", () => {
  it("diffs authoritative revisions while retaining omitted selection entries", async () => {
    const fileSystem = new TrackingFileSystem({
      "/repo/a.ts": "a",
      "/repo/b.ts": "b",
      "/renamed/a.ts": "renamed-a",
    });
    const state = new FakeRevisionedBackendState(fileSystem);
    const firstA = workspaceFile("a.ts", "a");
    const firstB = workspaceFile("b.ts", "b");

    await expect(state.refresh([firstA, firstB])).resolves.toEqual({
      added: 2,
      changed: 0,
      removed: 0,
      unchanged: 0,
    });
    const retainedB = state.prepared("b.ts");
    await expect(
      state.refresh([workspaceFile("a.ts", "renamed-a", "/renamed/a.ts")], "selection"),
    ).resolves.toEqual({ added: 0, changed: 1, removed: 0, unchanged: 0 });
    expect(state.prepared("b.ts")).toBe(retainedB);
    expect(state.currentFileCount()).toBe(2);

    await expect(
      state.refresh([workspaceFile("a.ts", "renamed-a", "/renamed/a.ts")]),
    ).resolves.toEqual({ added: 0, changed: 0, removed: 1, unchanged: 1 });
    expect(state.currentFileCount()).toBe(1);

    await expect(
      state.refresh([workspaceFile("renamed.ts", "renamed-a", "/renamed/a.ts")]),
    ).resolves.toEqual({ added: 1, changed: 0, removed: 1, unchanged: 0 });
    expect(state.requests[1]?.changes[0]?.kind).toBe("changed");
    expect(state.requests[1]?.removedFiles).toEqual([]);
  });

  it("retains unchanged prepared identity without filesystem work", async () => {
    const fileSystem = new TrackingFileSystem({ "/repo/a.ts": "a" });
    const state = new FakeRevisionedBackendState(fileSystem);
    const file = workspaceFile("a.ts", "a");
    await state.refresh([file]);
    const prepared = state.prepared("a.ts");
    const entries = await state.fileEntries(file);
    const diagnostics = state.diagnostics(file);
    const declarations = state.declarationsIn("a.ts");
    fileSystem.reads.length = 0;
    fileSystem.metadataReads.length = 0;

    await expect(
      state.refresh([{ ...file, metadata: { ...file.metadata, size: 999 } }]),
    ).resolves.toEqual({ added: 0, changed: 0, removed: 0, unchanged: 1 });
    expect(state.prepared("a.ts")).toBe(prepared);
    expect(await state.fileEntries(file)).toBe(entries);
    expect(state.diagnostics(file)).toBe(diagnostics);
    expect(state.declarationsIn("a.ts")).toBe(declarations);
    expect(fileSystem.reads).toEqual([]);
    expect(fileSystem.metadataReads).toEqual([]);
  });

  it.each<CandidateFault>(["missing-change", "duplicate", "outside", "wrong-revision"])(
    "rejects a %s preparation result without publishing it",
    async (candidateFault) => {
      const fileSystem = new TrackingFileSystem({ "/repo/a.ts": "a" });
      const state = new FakeRevisionedBackendState(fileSystem);
      state.candidateFault = candidateFault;

      await expect(state.refresh([workspaceFile("a.ts", "a")])).rejects.toThrow();
      expect(state.currentFileCount()).toBe(0);
      expect(state.rollbackCalls).toBe(1);
    },
  );

  it("rejects an incomplete final key set", async () => {
    const fileSystem = new TrackingFileSystem({ "/repo/a.ts": "a" });
    const state = new FakeRevisionedBackendState(fileSystem);

    await expect(
      state.refresh([workspaceFile("a.ts", "a"), workspaceFile("a.ts", "a")]),
    ).rejects.toThrow();
    expect(state.currentFileCount()).toBe(0);
    expect(state.rollbackCalls).toBe(1);
  });

  it.each<FailureStage>(["prepare", "commit"])(
    "rolls back once and preserves every index when %s fails",
    async (failureStage) => {
      const fileSystem = new TrackingFileSystem({
        "/repo/a.ts": "a",
        "/repo/b.ts": "b",
      });
      const state = new FakeRevisionedBackendState(fileSystem);
      const first = workspaceFile("a.ts", "a");
      await state.refresh([first]);
      const priorPrepared = state.prepared("a.ts");
      const priorEntries = await state.fileEntries(first);
      const priorDiagnostics = state.diagnostics(first);
      const identity: SymbolIdentity = { file: "a.ts", segments: [{ name: "a" }] };
      const priorDeclaration = state.declarationForIdentity(identity);
      state.failureStage = failureStage;

      await expect(
        state.refresh([workspaceFile("a.ts", "changed"), workspaceFile("b.ts", "b")]),
      ).rejects.toThrow(`${failureStage} failed`);
      expect(state.prepared("a.ts")).toBe(priorPrepared);
      await expect(state.fileEntries(first)).resolves.toBe(priorEntries);
      expect(state.diagnostics(first)).toBe(priorDiagnostics);
      await expect(state.declarations([first])).resolves.toEqual([priorDeclaration?.declaration]);
      expect(state.declarationForIdentity(identity)?.declaration).toBe(
        priorDeclaration?.declaration,
      );
      expect(state.declarationForIdentity(identity)?.file).toEqual(priorDeclaration?.file);
      expect(state.relativeFor("/repo/a.ts")).toBe("a.ts");
      expect(state.currentFileCount()).toBe(1);
      expect(state.rollbackCalls).toBe(1);
    },
  );

  it("accepts incremental and full-rebuild preparation results", async () => {
    const fileSystem = new TrackingFileSystem({ "/repo/a.ts": "a", "/repo/b.ts": "b" });
    const state = new FakeRevisionedBackendState(fileSystem);
    const files = [workspaceFile("a.ts", "a"), workspaceFile("b.ts", "b")];
    await state.refresh(files);
    const retainedA = state.prepared("a.ts");

    state.preparationMode = "full";
    await state.refresh(files);
    expect(state.prepared("a.ts")).not.toBe(retainedA);
    expect(state.allPrepared()).toHaveLength(2);
  });

  it("ensures absent files sequentially and retains earlier progress after failure", async () => {
    const fileSystem = new TrackingFileSystem({ "/repo/a.ts": "a", "/repo/b.ts": "b" });
    const state = new FakeRevisionedBackendState(fileSystem);
    state.failPreparationNumber = 2;

    await expect(state.ensureFiles(paths("a.ts", "b.ts"))).rejects.toThrow("prepare failed");
    expect(state.prepared("a.ts")).toBeDefined();
    expect(state.prepared("b.ts")).toBeUndefined();
    expect(state.requests.map((request) => request.coverage)).toEqual(["selection", "selection"]);

    fileSystem.metadataReads.length = 0;
    await state.ensureFiles(paths("a.ts"));
    expect(fileSystem.metadataReads).toEqual([]);
  });
});
