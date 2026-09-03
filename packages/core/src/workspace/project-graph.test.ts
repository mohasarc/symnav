import { describe, expect, it, vi } from "vitest";

import type { FileMetadata, FileSystem } from "./file-system.js";
import { InMemoryFileSystem } from "./in-memory/in-memory-file-system.js";
import {
  ProjectGraph,
  ProjectInputCollector,
  type ParsedProjectConfiguration,
  type PreparedProjectGraph,
  type ProjectGraphPreparationRequest,
  type ProjectGraphRefreshSummary,
  type ProjectInput,
} from "./project-graph.js";
import type { WorkspaceFile, WorkspaceSnapshot } from "./workspace.js";

interface FakeConfiguration {
  readonly referencedPaths: readonly string[];
  readonly filePaths: readonly string[];
  readonly inputPaths?: readonly string[];
  readonly observedPaths?: readonly string[];
}

class FakeProject {
  constructor(readonly name: string) {}

  releaseTransientResources(): void {}
}

class FakeProjectGraph extends ProjectGraph<FakeConfiguration, FakeProject> {
  readonly parsedPaths: string[] = [];
  readonly preparationRequests: ProjectGraphPreparationRequest<FakeConfiguration>[] = [];
  initialPaths: readonly string[] = [];
  configurations = new Map<string, FakeConfiguration>();
  preparedInputPaths: readonly string[] = [];
  preparedInputs: readonly ProjectInput[] = [];

  constructor(fileSystem: FileSystem) {
    super(fileSystem);
  }

  refresh(snapshot: WorkspaceSnapshot): Promise<ProjectGraphRefreshSummary> {
    return this.refreshProjectGraph(snapshot);
  }

  primary(relativePath: string): FakeProject | undefined {
    return this.primaryProjectFor(relativePath);
  }

  projects(relativePath: string): readonly FakeProject[] {
    return this.projectsFor(relativePath);
  }

  file(relativePath: string): WorkspaceFile | undefined {
    return this.workspaceFile(relativePath);
  }

  protected initialConfigurationPaths(): readonly string[] {
    return this.initialPaths;
  }

  protected async parseConfiguration(request: {
    readonly path: string;
    readonly content: string;
    readonly snapshot: WorkspaceSnapshot;
    readonly inputCollector: ProjectInputCollector;
  }): Promise<ParsedProjectConfiguration<FakeConfiguration> | undefined> {
    this.parsedPaths.push(request.path);
    const configuration = this.configurations.get(request.path);
    if (!configuration) return undefined;
    const inputs: ProjectInput[] = [{ path: request.path, content: request.content }];
    for (const path of configuration.inputPaths ?? []) {
      const content = request.inputCollector.read(path);
      if (content !== undefined) inputs.push({ path, content });
    }
    for (const path of configuration.observedPaths ?? []) request.inputCollector.read(path);
    return {
      configuration,
      referencedConfigurationPaths: configuration.referencedPaths,
      inputs: [...inputs, ...this.preparedInputs],
    };
  }

  protected filesForConfiguration(
    configuration: FakeConfiguration,
    snapshot: WorkspaceSnapshot,
  ): readonly WorkspaceFile[] {
    return snapshot.files.filter((file) => configuration.filePaths.includes(file.relative));
  }

  protected async prepareProjects(
    request: ProjectGraphPreparationRequest<FakeConfiguration>,
  ): Promise<PreparedProjectGraph<FakeProject>> {
    this.preparationRequests.push(request);
    const inputs = this.preparedInputPaths.flatMap((path) => {
      const content = request.inputCollector.read(path);
      return content === undefined ? [] : [{ path, content }];
    });
    return {
      configuredProjects: request.configurations.map(({ path }) => new FakeProject(path)),
      inferredProject: new FakeProject("inferred"),
      inputs,
    };
  }
}

class MutableProjectFileSystem implements FileSystem {
  readonly reads: string[] = [];

  constructor(readonly files: Record<string, string>) {}

  readFile(path: string): Promise<string> {
    return Promise.resolve(this.readFileSync(path));
  }

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.existsSync(path));
  }

  listDir(path: string): Promise<readonly string[]> {
    return Promise.resolve(this.delegate().listDirSync(path));
  }

  isDirectory(path: string): Promise<boolean> {
    return Promise.resolve(this.isDirectorySync(path));
  }

  metadata(path: string): Promise<FileMetadata> {
    return Promise.resolve(this.metadataSync(path));
  }

  readFileSync(path: string): string {
    this.reads.push(path);
    return this.delegate().readFileSync(path);
  }

  existsSync(path: string): boolean {
    return this.delegate().existsSync(path);
  }

  listDirSync(path: string): readonly string[] {
    return this.delegate().listDirSync(path);
  }

  isDirectorySync(path: string): boolean {
    return this.delegate().isDirectorySync(path);
  }

  metadataSync(path: string): FileMetadata {
    return this.delegate().metadataSync(path);
  }

  private delegate(): InMemoryFileSystem {
    return new InMemoryFileSystem(this.files);
  }
}

function workspaceFile(relative: string, changeToken = relative): WorkspaceFile {
  return {
    relative,
    absolute: `/repo/${relative}`,
    metadata: { size: changeToken.length, modifiedAtMs: 0, changeToken },
  };
}

function snapshot(...files: readonly WorkspaceFile[]): WorkspaceSnapshot {
  return { root: "/repo", files };
}

function snapshotAtRoot(root: string, ...files: readonly WorkspaceFile[]): WorkspaceSnapshot {
  return { root, files };
}

describe("ProjectInputCollector", () => {
  it("records successful and missing reads once in request order", () => {
    const fileSystem = new InMemoryFileSystem({
      "/repo/tsconfig.json": "root configuration",
    });
    const readFile = vi.spyOn(fileSystem, "readFileSync");
    const exists = vi.spyOn(fileSystem, "existsSync");
    const collector = new ProjectInputCollector(fileSystem);

    expect(collector.read("/repo/tsconfig.json")).toBe("root configuration");
    expect(collector.read("/repo/missing.json")).toBeUndefined();
    expect(collector.read("/repo/tsconfig.json")).toBe("root configuration");
    expect(collector.read("/repo/missing.json")).toBeUndefined();

    expect(collector.observations()).toEqual([
      { path: "/repo/tsconfig.json", content: "root configuration" },
      { path: "/repo/missing.json", content: null },
    ]);
    expect(readFile).toHaveBeenCalledOnce();
    expect(exists).toHaveBeenCalledTimes(2);
  });
});

describe("ProjectGraph", () => {
  it("discovers each configuration once in FIFO order", async () => {
    const graph = new FakeProjectGraph(
      new InMemoryFileSystem({
        "/repo/a.json": "a",
        "/repo/b.json": "b",
        "/repo/c.json": "c",
      }),
    );
    graph.initialPaths = ["/repo/a.json", "/repo/b.json"];
    graph.configurations = new Map([
      ["/repo/a.json", { referencedPaths: ["/repo/c.json", "/repo/b.json"], filePaths: [] }],
      ["/repo/b.json", { referencedPaths: ["/repo/c.json"], filePaths: [] }],
      ["/repo/c.json", { referencedPaths: [], filePaths: [] }],
    ]);

    await expect(graph.refresh(snapshot())).resolves.toEqual({
      root: "/repo",
      configuredProjectCount: 3,
      inferredFileCount: 0,
      changedInputCount: 3,
    });

    expect(graph.parsedPaths).toEqual(["/repo/a.json", "/repo/b.json", "/repo/c.json"]);
    expect(graph.preparationRequests[0]?.configurations.map(({ path }) => path)).toEqual([
      "/repo/a.json",
      "/repo/b.json",
      "/repo/c.json",
    ]);
  });

  it("orders all owners and selects the last owner as primary", async () => {
    const graph = new FakeProjectGraph(
      new InMemoryFileSystem({
        "/repo/a.json": "a",
        "/repo/b.json": "b",
        "/repo/c.json": "c",
      }),
    );
    graph.initialPaths = ["/repo/a.json", "/repo/b.json"];
    graph.configurations = new Map([
      ["/repo/a.json", { referencedPaths: ["/repo/c.json"], filePaths: ["shared.ts"] }],
      ["/repo/b.json", { referencedPaths: [], filePaths: ["shared.ts"] }],
      ["/repo/c.json", { referencedPaths: [], filePaths: ["shared.ts"] }],
    ]);

    await graph.refresh(snapshot(workspaceFile("shared.ts")));

    expect(graph.projects("shared.ts").map(({ name }) => name)).toEqual([
      "/repo/a.json",
      "/repo/b.json",
      "/repo/c.json",
    ]);
    expect(graph.primary("shared.ts")?.name).toBe("/repo/c.json");
  });

  it("uses the inferred project only for unowned workspace files", async () => {
    const graph = new FakeProjectGraph(
      new InMemoryFileSystem({
        "/repo/root.json": "root",
      }),
    );
    graph.initialPaths = ["/repo/root.json"];
    graph.configurations.set("/repo/root.json", {
      referencedPaths: [],
      filePaths: ["owned.ts"],
    });
    const owned = workspaceFile("owned.ts");
    const unowned = workspaceFile("unowned.ts");

    await graph.refresh(snapshot(owned, unowned));

    expect(graph.preparationRequests[0]?.inferredFiles).toEqual([unowned]);
    expect(graph.projects("unowned.ts").map(({ name }) => name)).toEqual(["inferred"]);
    expect(graph.primary("unowned.ts")?.name).toBe("inferred");
    expect(graph.file("unowned.ts")).toBe(unowned);
    expect(graph.projects("outside.ts")).toEqual([]);
    expect(graph.primary("outside.ts")).toBeUndefined();
    expect(graph.file("outside.ts")).toBeUndefined();
  });

  it("reuses projects until an observed input or source revision changes", async () => {
    const fileSystem = new MutableProjectFileSystem({
      "/repo/root.json": "root",
      "/repo/extends.json": "extends",
      "/repo/observed.json": "observed",
      "/repo/package.json": "package",
    });
    const graph = new FakeProjectGraph(fileSystem);
    graph.initialPaths = ["/repo/root.json"];
    graph.configurations.set("/repo/root.json", {
      referencedPaths: [],
      filePaths: ["owned.ts"],
      inputPaths: ["/repo/extends.json"],
      observedPaths: ["/repo/observed.json", "/repo/missing.json"],
    });
    graph.preparedInputPaths = ["/repo/package.json"];
    const owned = workspaceFile("owned.ts", "owned-1");

    const initial = await graph.refresh(snapshot(owned));
    const initialProject = graph.primary("owned.ts");
    const unchanged = await graph.refresh(
      snapshot({
        relative: owned.relative,
        get absolute(): string {
          throw new Error("unchanged graph read an absolute path");
        },
        metadata: { ...owned.metadata, size: 999, modifiedAtMs: 999 },
      }),
    );

    expect(initial.changedInputCount).toBe(3);
    expect(unchanged.changedInputCount).toBe(0);
    expect(graph.primary("owned.ts")).toBe(initialProject);
    expect(graph.parsedPaths).toEqual(["/repo/root.json"]);
    expect(graph.preparationRequests).toHaveLength(1);

    fileSystem.files["/repo/observed.json"] = "changed observation";
    const observationChanged = await graph.refresh(snapshot(owned));
    const observationProject = graph.primary("owned.ts");
    expect(observationChanged.changedInputCount).toBe(0);
    expect(observationProject).not.toBe(initialProject);

    fileSystem.files["/repo/missing.json"] = "appeared";
    const missingAppeared = await graph.refresh(snapshot(owned));
    const appearedProject = graph.primary("owned.ts");
    expect(missingAppeared.changedInputCount).toBe(0);
    expect(appearedProject).not.toBe(observationProject);

    fileSystem.files["/repo/extends.json"] = "changed extends";
    const activeChanged = await graph.refresh(snapshot(owned));
    expect(activeChanged.changedInputCount).toBe(1);

    delete fileSystem.files["/repo/extends.json"];
    const activeDisappeared = await graph.refresh(snapshot(owned));
    expect(activeDisappeared.changedInputCount).toBe(1);

    const sourceChanged = await graph.refresh(snapshot(workspaceFile("owned.ts", "owned-2")));
    const changedSourceProject = graph.primary("owned.ts");
    expect(sourceChanged.changedInputCount).toBe(0);

    const rootChanged = await graph.refresh(
      snapshotAtRoot("/other", workspaceFile("owned.ts", "owned-2")),
    );
    expect(rootChanged.root).toBe("/other");
    expect(rootChanged.changedInputCount).toBe(0);
    expect(graph.primary("owned.ts")).not.toBe(changedSourceProject);
  });

  it("rejects unobserved active inputs without replacing the graph", async () => {
    const fileSystem = new MutableProjectFileSystem({
      "/repo/root.json": "root",
      "/repo/active.json": "active",
    });
    const graph = new FakeProjectGraph(fileSystem);
    graph.initialPaths = ["/repo/root.json"];
    graph.configurations.set("/repo/root.json", {
      referencedPaths: [],
      filePaths: ["owned.ts"],
    });
    const publishedFile = workspaceFile("owned.ts", "published");
    await graph.refresh(snapshot(publishedFile));
    const publishedProject = graph.primary("owned.ts");
    graph.preparedInputs = [{ path: "/repo/active.json", content: "active" }];

    await expect(graph.refresh(snapshot(workspaceFile("owned.ts", "candidate")))).rejects.toThrow(
      "Project input /repo/active.json was not observed successfully",
    );

    expect(graph.primary("owned.ts")).toBe(publishedProject);
    expect(graph.file("owned.ts")).toBe(publishedFile);
  });

  it("rejects active input content that disagrees with its observation", async () => {
    const fileSystem = new MutableProjectFileSystem({
      "/repo/root.json": "root",
      "/repo/active.json": "current",
    });
    const graph = new FakeProjectGraph(fileSystem);
    graph.initialPaths = ["/repo/root.json"];
    graph.configurations.set("/repo/root.json", {
      referencedPaths: [],
      filePaths: ["owned.ts"],
    });
    const publishedFile = workspaceFile("owned.ts", "published");
    await graph.refresh(snapshot(publishedFile));
    const publishedProject = graph.primary("owned.ts");
    graph.preparedInputPaths = ["/repo/active.json"];
    graph.preparedInputs = [{ path: "/repo/active.json", content: "stale" }];

    await expect(graph.refresh(snapshot(workspaceFile("owned.ts", "candidate")))).rejects.toThrow(
      "Project input /repo/active.json does not match observed content",
    );

    expect(graph.primary("owned.ts")).toBe(publishedProject);
    expect(graph.file("owned.ts")).toBe(publishedFile);
  });
});
