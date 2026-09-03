import type { FileSystem } from "./file-system.js";
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
}

export abstract class ProjectGraph<
  ConfigurationUnit,
  Project extends ProjectWithTransientResources,
> {
  private state: ProjectGraphState<Project> | undefined;

  protected constructor(private readonly fileSystem: FileSystem) {}

  protected async refreshProjectGraph(
    snapshot: WorkspaceSnapshot,
  ): Promise<ProjectGraphRefreshSummary> {
    if (this.projectStateUnchanged(snapshot)) return this.currentSummary(0);
    const inputCollector = new ProjectInputCollector(this.fileSystem);
    const discovered = await this.discoverConfigurations(snapshot, inputCollector);
    const configurations = discovered.map(({ path, parsed }) => ({
      path,
      configuration: parsed.configuration,
      files: this.filesForConfiguration(parsed.configuration, snapshot),
    }));
    const ownedRelativePaths = new Set(
      configurations.flatMap((configuration) => configuration.files.map((file) => file.relative)),
    );
    const inferredFiles = snapshot.files.filter((file) => !ownedRelativePaths.has(file.relative));
    const prepared = await this.prepareProjects({
      snapshot,
      configurations,
      inferredFiles,
      inputCollector,
    });
    const inputsByPath = ProjectGraph.collectInputs([
      ...discovered.flatMap(({ parsed }) => parsed.inputs),
      ...prepared.inputs,
    ]);
    const changedInputCount = ProjectGraph.changedInputCount(
      this.state?.inputsByPath ?? new Map(),
      inputsByPath,
    );
    const ownership = ProjectGraph.buildOwnership(configurations, prepared.configuredProjects);
    this.state = {
      root: snapshot.root,
      filesByRelativePath: new Map(snapshot.files.map((file) => [file.relative, file])),
      configuredProjects: prepared.configuredProjects,
      ...ownership,
      inferredProject: prepared.inferredProject,
      inferredFileCount: inferredFiles.length,
      inputsByPath,
      observations: inputCollector.observations(),
    };
    return this.currentSummary(changedInputCount);
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

  private async discoverConfigurations(
    snapshot: WorkspaceSnapshot,
    inputCollector: ProjectInputCollector,
  ): Promise<readonly DiscoveredProjectConfiguration<ConfigurationUnit>[]> {
    const pending = [...this.initialConfigurationPaths(snapshot.root)];
    const seen = new Set<string>();
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
      configurations.push({ path, parsed });
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

  private projectStateUnchanged(snapshot: WorkspaceSnapshot): boolean {
    if (!this.workspaceFilesUnchanged(snapshot)) return false;
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

  private static collectInputs(inputs: readonly ProjectInput[]): ReadonlyMap<string, string> {
    const byPath = new Map<string, string>();
    for (const input of inputs) byPath.set(input.path, input.content);
    return byPath;
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
    for (const [index, configuration] of configurations.entries()) {
      const project = configuredProjects[index];
      if (!project) continue;
      for (const file of configuration.files) {
        const projects = projectsByRelativePath.get(file.relative) ?? [];
        projects.push(project);
        projectsByRelativePath.set(file.relative, projects);
        primaryProjectByRelativePath.set(file.relative, project);
      }
    }
    return { projectsByRelativePath, primaryProjectByRelativePath };
  }
}
