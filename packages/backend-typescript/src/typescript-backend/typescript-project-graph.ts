import { posix } from "node:path";

import type { FileSystem, WorkspaceFile, WorkspaceSnapshot } from "@symnav/core";
import { Project, type SourceFile, ts } from "ts-morph";

import type { TypeScriptSemanticSourceProvider } from "./typescript-workspace-state.js";
import { WorkspaceFileSystemHost } from "./workspace-file-system-host.js";

export interface TypeScriptProjectGraphRefresh {
  readonly root: string;
  readonly configuredProjectCount: number;
  readonly inferredFileCount: number;
  readonly changedConfigurationCount: number;
}

interface ParsedTypeScriptConfiguration {
  readonly path: string;
  readonly directory: string;
  readonly content: string;
  readonly value: Record<string, unknown>;
  readonly compilerOptions: ts.CompilerOptions;
}

interface WorkspacePackageMapping {
  readonly specifier: string;
  readonly target: string;
}

interface WorkspacePackage {
  readonly path: string;
  readonly content: string;
  readonly mappings: readonly WorkspacePackageMapping[];
}

class TypeScriptSemanticProject {
  readonly project: Project;
  private loaded = false;

  constructor(
    fileSystem: FileSystem,
    compilerOptions: ts.CompilerOptions,
    private readonly ownedFiles: readonly WorkspaceFile[],
  ) {
    this.project = new Project({
      fileSystem: new WorkspaceFileSystemHost(fileSystem),
      compilerOptions,
      skipAddingFilesFromTsConfig: true,
    });
  }

  program(): ts.Program {
    this.load();
    return this.project.getProgram().compilerObject;
  }

  languageService(): ts.LanguageService {
    this.load();
    return this.project.getLanguageService().compilerObject;
  }

  sourceFile(absolutePath: string): SourceFile | undefined {
    this.load();
    return this.project.getSourceFile(absolutePath);
  }

  releaseTransientResources(): void {
    if (!this.loaded) return;
    this.project.getLanguageService().compilerObject.cleanupSemanticCache();
  }

  private load(): void {
    if (this.loaded) return;
    for (const file of this.ownedFiles) {
      this.project.addSourceFileAtPathIfExists(file.absolute);
    }
    this.project.resolveSourceFileDependencies();
    this.loaded = true;
  }
}

export class TypeScriptProjectGraph implements TypeScriptSemanticSourceProvider {
  private acceptedFiles = new Map<string, WorkspaceFile>();
  private configuredProjects: readonly TypeScriptSemanticProject[] = [];
  private configuredProjectByFile = new Map<string, TypeScriptSemanticProject>();
  private inferredProject: TypeScriptSemanticProject;
  private configurationInputs = new Map<string, string>();
  private workspaceRevision = "";
  private initialized = false;

  constructor(private readonly fileSystem: FileSystem) {
    this.inferredProject = new TypeScriptSemanticProject(fileSystem, { noEmit: true }, []);
  }

  async refresh(snapshot: WorkspaceSnapshot): Promise<TypeScriptProjectGraphRefresh> {
    const configurations = this.readConfigurations(snapshot.root);
    const workspacePackages = this.readWorkspacePackages(snapshot, configurations);
    const nextInputs = new Map<string, string>();
    for (const configuration of configurations) {
      nextInputs.set(configuration.path, configuration.content);
    }
    for (const workspacePackage of workspacePackages) {
      nextInputs.set(workspacePackage.path, workspacePackage.content);
    }
    const changedConfigurationCount = TypeScriptProjectGraph.changedInputCount(
      this.configurationInputs,
      nextInputs,
    );
    const workspaceRevision = snapshot.files
      .map((file) => `${file.relative}:${file.metadata.changeToken}`)
      .join("\n");
    if (
      changedConfigurationCount > 0 ||
      !this.initialized ||
      workspaceRevision !== this.workspaceRevision
    ) {
      this.configureProjects(snapshot, configurations, workspacePackages);
    }
    this.initialized = true;
    this.configurationInputs = nextInputs;
    this.workspaceRevision = workspaceRevision;
    this.acceptedFiles = new Map(snapshot.files.map((file) => [file.relative, file]));
    return {
      root: snapshot.root,
      configuredProjectCount: configurations.length,
      inferredFileCount: snapshot.files.filter(
        (file) => !this.configuredProjectByFile.has(file.relative),
      ).length,
      changedConfigurationCount,
    };
  }

  programFor(relativePath: string): ts.Program | undefined {
    if (!this.acceptedFiles.has(relativePath)) return undefined;
    return this.projectFor(relativePath).program();
  }

  languageServiceFor(relativePath: string): ts.LanguageService | undefined {
    if (!this.acceptedFiles.has(relativePath)) return undefined;
    return this.projectFor(relativePath).languageService();
  }

  sourceFilesFor(relativePath: string): readonly SourceFile[] {
    const file = this.acceptedFiles.get(relativePath);
    if (!file) return [];
    const sourceFiles: SourceFile[] = [];
    for (const configuredProject of this.configuredProjects) {
      const sourceFile = configuredProject.sourceFile(file.absolute);
      if (sourceFile) sourceFiles.push(sourceFile);
    }
    const inferredSourceFile = this.inferredProject.sourceFile(file.absolute);
    if (inferredSourceFile) sourceFiles.push(inferredSourceFile);
    return sourceFiles;
  }

  releaseTransientResources(): void {
    for (const configuredProject of this.configuredProjects) {
      configuredProject.releaseTransientResources();
    }
    this.inferredProject.releaseTransientResources();
  }

  private projectFor(relativePath: string): TypeScriptSemanticProject {
    return this.configuredProjectByFile.get(relativePath) ?? this.inferredProject;
  }

  private configureProjects(
    snapshot: WorkspaceSnapshot,
    configurations: readonly ParsedTypeScriptConfiguration[],
    workspacePackages: readonly WorkspacePackage[],
  ): void {
    const configuredProjectByFile = new Map<string, TypeScriptSemanticProject>();
    const configuredProjects: TypeScriptSemanticProject[] = [];
    for (const configuration of configurations) {
      const ownedFiles = this.configuredFiles(snapshot, configuration);
      const compilerOptions = TypeScriptProjectGraph.compilerOptionsFor(
        snapshot.root,
        configuration,
        workspacePackages,
      );
      const project = new TypeScriptSemanticProject(this.fileSystem, compilerOptions, ownedFiles);
      configuredProjects.push(project);
      for (const file of ownedFiles) configuredProjectByFile.set(file.relative, project);
    }
    const inferredFiles = snapshot.files.filter(
      (file) => !configuredProjectByFile.has(file.relative),
    );
    const fallbackOptions = configurations.at(-1)?.compilerOptions ?? {};
    this.configuredProjects = configuredProjects;
    this.configuredProjectByFile = configuredProjectByFile;
    this.inferredProject = new TypeScriptSemanticProject(
      this.fileSystem,
      { ...fallbackOptions, noEmit: true },
      inferredFiles,
    );
  }

  private readConfigurations(root: string): readonly ParsedTypeScriptConfiguration[] {
    const pending = [posix.join(root, "tsconfig.json")];
    const seen = new Set<string>();
    const configurations: ParsedTypeScriptConfiguration[] = [];
    while (pending.length > 0) {
      const path = pending.shift() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      const parsed = this.readConfiguration(path);
      if (!parsed) continue;
      configurations.push(parsed);
      const references = Array.isArray(parsed.value.references) ? parsed.value.references : [];
      for (const reference of references) {
        const referencePath = TypeScriptProjectGraph.recordValue(reference).path;
        if (typeof referencePath !== "string") continue;
        const resolved = posix.resolve(parsed.directory, referencePath);
        pending.push(resolved.endsWith(".json") ? resolved : posix.join(resolved, "tsconfig.json"));
      }
    }
    return configurations;
  }

  private readConfiguration(path: string): ParsedTypeScriptConfiguration | undefined {
    if (!this.fileSystem.existsSync(path) || this.fileSystem.isDirectorySync(path)) {
      return undefined;
    }
    const content = this.fileSystem.readFileSync(path);
    const parsed = ts.parseConfigFileTextToJson(path, content);
    if (parsed.error || !parsed.config || typeof parsed.config !== "object") return undefined;
    const value = parsed.config as Record<string, unknown>;
    const compilerOptions = ts.convertCompilerOptionsFromJson(
      TypeScriptProjectGraph.recordValue(value.compilerOptions),
      posix.dirname(path),
    ).options;
    return { path, directory: posix.dirname(path), content, value, compilerOptions };
  }

  private readWorkspacePackages(
    snapshot: WorkspaceSnapshot,
    configurations: readonly ParsedTypeScriptConfiguration[],
  ): readonly WorkspacePackage[] {
    const directories = new Set<string>([snapshot.root]);
    for (const configuration of configurations) directories.add(configuration.directory);
    for (const file of snapshot.files) {
      let directory = posix.dirname(file.absolute);
      while (directory.startsWith(snapshot.root)) {
        directories.add(directory);
        if (directory === snapshot.root) break;
        directory = posix.dirname(directory);
      }
    }
    const packages: WorkspacePackage[] = [];
    for (const directory of directories) {
      const path = posix.join(directory, "package.json");
      if (!this.fileSystem.existsSync(path) || this.fileSystem.isDirectorySync(path)) continue;
      const content = this.fileSystem.readFileSync(path);
      const value = TypeScriptProjectGraph.parseJson(content);
      const name = value?.name;
      if (typeof name !== "string" || !value) continue;
      const target = TypeScriptProjectGraph.packageTarget(value);
      const mappings = target
        ? [{ specifier: name, target: posix.resolve(directory, target) }]
        : [];
      if (mappings.length === 0) continue;
      packages.push({ path, content, mappings });
    }
    return packages;
  }

  private configuredFiles(
    snapshot: WorkspaceSnapshot,
    configuration: ParsedTypeScriptConfiguration,
  ): readonly WorkspaceFile[] {
    const explicitFiles = Array.isArray(configuration.value.files)
      ? configuration.value.files.filter((file): file is string => typeof file === "string")
      : undefined;
    if (explicitFiles) {
      const absoluteFiles = new Set(
        explicitFiles.map((file) => posix.resolve(configuration.directory, file)),
      );
      return snapshot.files.filter((file) => absoluteFiles.has(file.absolute));
    }
    const includes = Array.isArray(configuration.value.include)
      ? configuration.value.include.filter((value): value is string => typeof value === "string")
      : ["**/*"];
    const excludes = Array.isArray(configuration.value.exclude)
      ? configuration.value.exclude.filter((value): value is string => typeof value === "string")
      : ["node_modules", "bower_components", "jspm_packages"];
    return snapshot.files.filter((file) => {
      const relative = posix.relative(configuration.directory, file.absolute);
      if (relative.startsWith("../")) return false;
      if (!includes.some((pattern) => TypeScriptProjectGraph.matchesGlob(relative, pattern))) {
        return false;
      }
      return !excludes.some((pattern) => TypeScriptProjectGraph.matchesGlob(relative, pattern));
    });
  }

  private static compilerOptionsFor(
    root: string,
    configuration: ParsedTypeScriptConfiguration,
    workspacePackages: readonly WorkspacePackage[],
  ): ts.CompilerOptions {
    const compilerOptions: ts.CompilerOptions = { ...configuration.compilerOptions };
    const baseUrl = compilerOptions.baseUrl ?? configuration.directory;
    const paths: Record<string, string[]> = {};
    for (const workspacePackage of workspacePackages) {
      for (const mapping of workspacePackage.mappings) paths[mapping.specifier] = [mapping.target];
    }
    for (const [specifier, targets] of Object.entries(compilerOptions.paths ?? {})) {
      paths[specifier] = targets.map((target) => posix.resolve(baseUrl, target));
    }
    delete compilerOptions.rootDir;
    delete compilerOptions.outDir;
    delete compilerOptions.composite;
    compilerOptions.baseUrl ??= root;
    compilerOptions.paths = paths;
    compilerOptions.noEmit = true;
    return compilerOptions;
  }

  private static changedInputCount(
    current: ReadonlyMap<string, string>,
    next: ReadonlyMap<string, string>,
  ): number {
    const paths = new Set([...current.keys(), ...next.keys()]);
    return [...paths].filter((path) => current.get(path) !== next.get(path)).length;
  }

  private static matchesGlob(path: string, pattern: string): boolean {
    const normalized = pattern.replace(/^\.\//, "").replace(/\/$/, "/**/*");
    let expression = "";
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index] as string;
      if (character === "*" && normalized[index + 1] === "*") {
        if (normalized[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else if (character === "*") {
        expression += "[^/]*";
      } else {
        expression += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
      }
    }
    return new RegExp(`^${expression}$`).test(path);
  }

  private static parseJson(content: string): Record<string, unknown> | undefined {
    try {
      const value: unknown = JSON.parse(content);
      return TypeScriptProjectGraph.recordValue(value);
    } catch {
      return undefined;
    }
  }

  private static packageTarget(value: Record<string, unknown>): string | undefined {
    const exports = value.exports;
    const rootExport = TypeScriptProjectGraph.recordValue(exports)["."] ?? exports;
    return (
      TypeScriptProjectGraph.stringTarget(rootExport) ??
      TypeScriptProjectGraph.stringTarget(value.types) ??
      TypeScriptProjectGraph.stringTarget(value.main)
    );
  }

  private static stringTarget(value: unknown): string | undefined {
    if (typeof value === "string") return value;
    const record = TypeScriptProjectGraph.recordValue(value);
    if (Object.keys(record).length === 0) return undefined;
    return [record.types, record.import, record.default]
      .map((candidate) => TypeScriptProjectGraph.stringTarget(candidate))
      .find((candidate) => candidate !== undefined);
  }

  private static recordValue(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
}
