import { posix } from "node:path";

import type { FileSystem } from "./file-system.js";
import { isUnderRoot } from "./paths/is-under-root.js";
import type { WorkspaceFile, WorkspaceSnapshot } from "./workspace.js";

export interface ProjectInput {
  readonly path: string;
  readonly content: string;
}

export interface ProjectInputObservation {
  readonly path: string;
  readonly content: string | null;
}

export class ProjectInputCollector {
  private readonly observationByPath = new Map<string, ProjectInputObservation>();

  constructor(private readonly fileSystem: FileSystem) {}

  read(path: string): string | undefined {
    let observation = this.observationByPath.get(path);
    if (!observation) {
      observation = { path, content: this.readCurrentInput(path) };
      this.observationByPath.set(path, observation);
    }
    return observation.content ?? undefined;
  }

  observations(): readonly ProjectInputObservation[] {
    return [...this.observationByPath.values()];
  }

  private readCurrentInput(path: string): string | null {
    if (!this.fileSystem.existsSync(path) || this.fileSystem.isDirectorySync(path)) return null;
    return this.fileSystem.readFileSync(path);
  }
}

export interface ParsedProjectConfiguration<ConfigurationUnit> {
  readonly configuration: ConfigurationUnit;
  readonly referencedConfigurationPaths: readonly string[];
  readonly inputs: readonly ProjectInput[];
}

export interface ProjectConfigurationMembership<ConfigurationUnit> {
  readonly path: string;
  readonly configuration: ConfigurationUnit;
  readonly files: readonly WorkspaceFile[];
}

export interface ProjectGraphPreparationRequest<ConfigurationUnit> {
  readonly snapshot: WorkspaceSnapshot;
  readonly configurations: readonly ProjectConfigurationMembership<ConfigurationUnit>[];
  readonly inferredFiles: readonly WorkspaceFile[];
  readonly inputCollector: ProjectInputCollector;
}

export interface PreparedProjectGraph<Project> {
  readonly configuredProjects: readonly Project[];
  readonly inferredProject: Project;
  readonly inputs: readonly ProjectInput[];
}

export interface ProjectWithTransientResources {
  releaseTransientResources(): void | Promise<void>;
}

export interface ProjectGraphRefreshSummary {
  readonly root: string;
  readonly configuredProjectCount: number;
  readonly inferredFileCount: number;
  readonly changedInputCount: number;
}

interface DiscoveredProjectConfiguration<ConfigurationUnit> {
  readonly path: string;
  readonly parsed: ParsedProjectConfiguration<ConfigurationUnit>;
  readonly confinedToDirectory: boolean;
}

interface ProjectGraphState<Project> {
  readonly root: string;
  readonly filesByRelativePath: ReadonlyMap<string, WorkspaceFile>;
  readonly configuredProjects: readonly Project[];
  readonly projectsByRelativePath: ReadonlyMap<string, readonly Project[]>;
  readonly primaryProjectByRelativePath: ReadonlyMap<string, Project>;
  readonly inferredProject: Project;
  readonly inferredFileCount: number;
  readonly inputsByPath: ReadonlyMap<string, string>;
  readonly observations: readonly ProjectInputObservation[];
  readonly nestedConfigurationPaths: readonly string[];
}

export abstract class ProjectGraph<
  ConfigurationUnit,
  Project extends ProjectWithTransientResources,
> {
  private static readonly UNRELATED_OWNER_NEARNESS = -1;

  private state: ProjectGraphState<Project> | undefined;

  protected constructor(protected readonly fileSystem: FileSystem) {}

  protected async refreshProjectGraph(
    snapshot: WorkspaceSnapshot,
    workspaceSnapshot: WorkspaceSnapshot,
  ): Promise<ProjectGraphRefreshSummary> {
    const nestedPaths = [...this.nestedConfigurationPaths(workspaceSnapshot)].sort();
    if (this.projectStateUnchanged(snapshot, nestedPaths)) return this.currentSummary(0);
    const inputCollector = new ProjectInputCollector(this.fileSystem);
    const discovered = await this.discoverConfigurations({ snapshot, nestedPaths, inputCollector });
    const candidateConfigurations = discovered.map(({ path, parsed }) => ({
      path,
      configuration: parsed.configuration,
      files: this.filesForConfiguration(parsed.configuration, snapshot),
    }));
    const configurations = ProjectGraph.canonicalizeMembership(snapshot, candidateConfigurations);
    const ownedConfigurations = configurations.map((configuration, index) =>
      discovered[index]?.confinedToDirectory
        ? {
            ...configuration,
            files: ProjectGraph.filesInsideDirectoryOf(configuration.path, configuration.files),
          }
        : configuration,
    );
    const ownedRelativePaths = new Set(
      ownedConfigurations.flatMap((configuration) =>
        configuration.files.map((file) => file.relative),
      ),
    );
    const inferredFiles = snapshot.files.filter((file) => !ownedRelativePaths.has(file.relative));
    const prepared = await this.prepareProjects({
      snapshot,
      configurations,
      inferredFiles,
      inputCollector,
    });
    this.validatePreparedProjectCount(configurations, prepared);
    const activeInputs = [...discovered.flatMap(({ parsed }) => parsed.inputs), ...prepared.inputs];
    const observations = inputCollector.observations();
    ProjectGraph.validateActiveInputs(activeInputs, observations);
    const inputsByPath = ProjectGraph.collectInputs(activeInputs);
    const changedInputCount = ProjectGraph.changedInputCount(
      this.state?.inputsByPath ?? new Map(),
      inputsByPath,
    );
    const ownership = ProjectGraph.buildOwnership(ownedConfigurations, prepared.configuredProjects);
    this.state = {
      root: snapshot.root,
      filesByRelativePath: new Map(snapshot.files.map((file) => [file.relative, file])),
      configuredProjects: prepared.configuredProjects,
      ...ownership,
      inferredProject: prepared.inferredProject,
      inferredFileCount: inferredFiles.length,
      inputsByPath,
      observations,
      nestedConfigurationPaths: nestedPaths,
    };
    return this.currentSummary(changedInputCount);
  }

  async releaseTransientResources(): Promise<void> {
    if (!this.state) return;
    for (const project of this.state.configuredProjects) {
      const release = project.releaseTransientResources();
      if (release) await release;
    }
    const inferredRelease = this.state.inferredProject.releaseTransientResources();
    if (inferredRelease) await inferredRelease;
  }

  protected primaryProjectFor(relativePath: string): Project | undefined {
    const file = this.state?.filesByRelativePath.get(relativePath);
    if (!file) return undefined;
    return (
      this.state?.primaryProjectByRelativePath.get(relativePath) ?? this.state?.inferredProject
    );
  }

  protected projectsFor(relativePath: string): readonly Project[] {
    const file = this.state?.filesByRelativePath.get(relativePath);
    if (!file) return [];
    return this.state?.projectsByRelativePath.get(relativePath) ?? [this.state!.inferredProject];
  }

  protected workspaceFile(relativePath: string): WorkspaceFile | undefined {
    return this.state?.filesByRelativePath.get(relativePath);
  }

  protected abstract initialConfigurationPaths(root: string): readonly string[];

  protected abstract nestedConfigurationPaths(
    workspaceSnapshot: WorkspaceSnapshot,
  ): readonly string[];

  protected abstract parseConfiguration(request: {
    readonly path: string;
    readonly content: string;
    readonly snapshot: WorkspaceSnapshot;
    readonly inputCollector: ProjectInputCollector;
  }): Promise<ParsedProjectConfiguration<ConfigurationUnit> | undefined>;

  protected abstract filesForConfiguration(
    configuration: ConfigurationUnit,
    snapshot: WorkspaceSnapshot,
  ): readonly WorkspaceFile[];

  protected abstract prepareProjects(
    request: ProjectGraphPreparationRequest<ConfigurationUnit>,
  ): Promise<PreparedProjectGraph<Project>>;

  private async discoverConfigurations(request: {
    readonly snapshot: WorkspaceSnapshot;
    readonly nestedPaths: readonly string[];
    readonly inputCollector: ProjectInputCollector;
  }): Promise<readonly DiscoveredProjectConfiguration<ConfigurationUnit>[]> {
    const { snapshot, nestedPaths, inputCollector } = request;
    const seen = new Set<string>();
    const seeds = [
      { paths: this.initialConfigurationPaths(snapshot.root), confinedPaths: new Set<string>() },
      { paths: nestedPaths, confinedPaths: new Set(nestedPaths) },
    ];
    const configurations: DiscoveredProjectConfiguration<ConfigurationUnit>[] = [];
    for (const seed of seeds) {
      const discovered = await this.discoverReachableConfigurations({
        seed: seed.paths,
        confinedPaths: seed.confinedPaths,
        seen,
        snapshot,
        inputCollector,
      });
      configurations.push(...discovered);
    }
    return configurations;
  }

  private async discoverReachableConfigurations(request: {
    readonly seed: readonly string[];
    readonly confinedPaths: ReadonlySet<string>;
    readonly seen: Set<string>;
    readonly snapshot: WorkspaceSnapshot;
    readonly inputCollector: ProjectInputCollector;
  }): Promise<readonly DiscoveredProjectConfiguration<ConfigurationUnit>[]> {
    const { confinedPaths, seen, snapshot, inputCollector } = request;
    const pending = [...request.seed];
    const configurations: DiscoveredProjectConfiguration<ConfigurationUnit>[] = [];
    while (pending.length > 0) {
      const path = pending.shift() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      const content = inputCollector.read(path);
      if (content === undefined) continue;
      const parsed = await this.parseConfiguration({
        path,
        content,
        snapshot,
        inputCollector,
      });
      if (!parsed) continue;
      configurations.push({ path, parsed, confinedToDirectory: confinedPaths.has(path) });
      pending.push(...parsed.referencedConfigurationPaths);
    }
    return configurations;
  }

  private currentSummary(changedInputCount: number): ProjectGraphRefreshSummary {
    const state = this.state as ProjectGraphState<Project>;
    return {
      root: state.root,
      configuredProjectCount: state.configuredProjects.length,
      inferredFileCount: state.inferredFileCount,
      changedInputCount,
    };
  }

  private projectStateUnchanged(
    snapshot: WorkspaceSnapshot,
    nestedPaths: readonly string[],
  ): boolean {
    if (!this.workspaceFilesUnchanged(snapshot)) return false;
    if (!ProjectGraph.samePaths(this.state!.nestedConfigurationPaths, nestedPaths)) return false;
    return this.state!.observations.every(
      (observation) => this.readCurrentInput(observation.path) === observation.content,
    );
  }

  private workspaceFilesUnchanged(snapshot: WorkspaceSnapshot): boolean {
    if (!this.state || this.state.root !== snapshot.root) return false;
    if (this.state.filesByRelativePath.size !== snapshot.files.length) return false;
    return snapshot.files.every((file) => {
      const current = this.state?.filesByRelativePath.get(file.relative);
      return current?.metadata.changeToken === file.metadata.changeToken;
    });
  }

  private readCurrentInput(path: string): string | null {
    if (!this.fileSystem.existsSync(path) || this.fileSystem.isDirectorySync(path)) return null;
    return this.fileSystem.readFileSync(path);
  }

  private static samePaths(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((path, index) => path === right[index]);
  }

  private static collectInputs(inputs: readonly ProjectInput[]): ReadonlyMap<string, string> {
    const byPath = new Map<string, string>();
    for (const input of inputs) byPath.set(input.path, input.content);
    return byPath;
  }

  private static validateActiveInputs(
    inputs: readonly ProjectInput[],
    observations: readonly ProjectInputObservation[],
  ): void {
    const observationByPath = new Map(
      observations.map((observation) => [observation.path, observation]),
    );
    for (const input of inputs) {
      const observation = observationByPath.get(input.path);
      if (!observation || observation.content === null) {
        throw new Error(`Project input ${input.path} was not observed successfully`);
      }
      if (observation.content !== input.content) {
        throw new Error(`Project input ${input.path} does not match observed content`);
      }
    }
  }

  private static canonicalizeMembership<ConfigurationUnit>(
    snapshot: WorkspaceSnapshot,
    configurations: readonly ProjectConfigurationMembership<ConfigurationUnit>[],
  ): readonly ProjectConfigurationMembership<ConfigurationUnit>[] {
    const snapshotFileByRelativePath = new Map(snapshot.files.map((file) => [file.relative, file]));
    return configurations.map((configuration) => ({
      ...configuration,
      files: configuration.files.map((file) => {
        const snapshotFile = snapshotFileByRelativePath.get(file.relative);
        if (snapshotFile && ProjectGraph.sameWorkspaceFile(file, snapshotFile)) {
          return snapshotFile;
        }
        throw new Error(
          `Project configuration ${configuration.path} returned non-snapshot file ${file.relative}`,
        );
      }),
    }));
  }

  private static sameWorkspaceFile(left: WorkspaceFile, right: WorkspaceFile): boolean {
    return (
      left.relative === right.relative &&
      left.absolute === right.absolute &&
      left.metadata.size === right.metadata.size &&
      left.metadata.modifiedAtMs === right.metadata.modifiedAtMs &&
      left.metadata.changeToken === right.metadata.changeToken &&
      left.metadata.fileIdentity === right.metadata.fileIdentity
    );
  }

  private validatePreparedProjectCount(
    configurations: readonly ProjectConfigurationMembership<ConfigurationUnit>[],
    prepared: PreparedProjectGraph<Project>,
  ): void {
    if (prepared.configuredProjects.length === configurations.length) return;
    throw new Error(
      `Project graph preparation returned ${prepared.configuredProjects.length} configured projects for ${configurations.length} configurations`,
    );
  }

  private static changedInputCount(
    current: ReadonlyMap<string, string>,
    next: ReadonlyMap<string, string>,
  ): number {
    const paths = new Set([...current.keys(), ...next.keys()]);
    return [...paths].filter((path) => current.get(path) !== next.get(path)).length;
  }

  private static buildOwnership<ConfigurationUnit, Project>(
    configurations: readonly ProjectConfigurationMembership<ConfigurationUnit>[],
    configuredProjects: readonly Project[],
  ): {
    readonly projectsByRelativePath: ReadonlyMap<string, readonly Project[]>;
    readonly primaryProjectByRelativePath: ReadonlyMap<string, Project>;
  } {
    const projectsByRelativePath = new Map<string, Project[]>();
    const primaryProjectByRelativePath = new Map<string, Project>();
    const primaryNearnessByRelativePath = new Map<string, number>();
    for (const [index, configuration] of configurations.entries()) {
      const project = configuredProjects[index];
      if (!project) continue;
      for (const file of configuration.files) {
        const projects = projectsByRelativePath.get(file.relative) ?? [];
        projects.push(project);
        projectsByRelativePath.set(file.relative, projects);
        const nearness = ProjectGraph.ownerNearness(configuration.path, file);
        const primaryNearness = primaryNearnessByRelativePath.get(file.relative);
        if (primaryNearness !== undefined && nearness < primaryNearness) continue;
        primaryProjectByRelativePath.set(file.relative, project);
        primaryNearnessByRelativePath.set(file.relative, nearness);
      }
    }
    return { projectsByRelativePath, primaryProjectByRelativePath };
  }

  private static ownerNearness(configurationPath: string, file: WorkspaceFile): number {
    const directory = ProjectGraph.configurationDirectory(configurationPath);
    if (!isUnderRoot(file.absolute, directory)) return ProjectGraph.UNRELATED_OWNER_NEARNESS;
    return directory.length;
  }

  private static filesInsideDirectoryOf(
    configurationPath: string,
    files: readonly WorkspaceFile[],
  ): readonly WorkspaceFile[] {
    const directory = ProjectGraph.configurationDirectory(configurationPath);
    return files.filter((file) => isUnderRoot(file.absolute, directory));
  }

  private static configurationDirectory(configurationPath: string): string {
    return posix.dirname(configurationPath.replaceAll("\\", "/"));
  }
}
