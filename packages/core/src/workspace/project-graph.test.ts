import { describe, expect, it, vi } from "vitest";

import type { FileSystem } from "./file-system.js";
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

  constructor(fileSystem: FileSystem) {
    super(fileSystem);
  }

  refresh(snapshot: WorkspaceSnapshot): Promise<ProjectGraphRefreshSummary> {
    return this.refreshProjectGraph(snapshot);
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
    return {
      configuration,
      referencedConfigurationPaths: configuration.referencedPaths,
      inputs,
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
    return {
      configuredProjects: request.configurations.map(({ path }) => new FakeProject(path)),
      inferredProject: new FakeProject("inferred"),
      inputs: [],
    };
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
});
