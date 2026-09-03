import type { WorkspaceFile } from "./workspace.js";

export interface ProjectInput {
  readonly path: string;
  readonly content: string;
}

export interface ProjectInputObservation {
  readonly path: string;
  readonly content: string | null;
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
