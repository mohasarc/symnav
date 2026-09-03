import type { FileSystem } from "./file-system.js";
import type { WorkspaceFile } from "./workspace.js";

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
