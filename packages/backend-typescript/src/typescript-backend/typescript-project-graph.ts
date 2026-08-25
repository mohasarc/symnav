import { posix } from "node:path";

import type { FileSystem, WorkspaceFile, WorkspaceSnapshot } from "@symnav/core";
import { Project, type SourceFile, ts } from "ts-morph";

import type { TypeScriptSemanticSourceProvider } from "./typescript-workspace-state.js";
import { WorkspaceFileSystemHost } from "./workspace-file-system-host.js";
import { WorkspacePathDialect } from "./workspace-path-dialect.js";

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
  readonly fileNames: readonly string[];
  readonly extendedInputs: ReadonlyMap<string, string>;
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
    const configurations = this.readConfigurations(snapshot);
    const workspacePackages = this.readWorkspacePackages(snapshot, configurations);
    const nextInputs = new Map<string, string>();
    for (const configuration of configurations) {
      nextInputs.set(configuration.path, configuration.content);
      for (const [path, content] of configuration.extendedInputs) {
        nextInputs.set(path, content);
      }
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
    this.configuredProjects = configuredProjects;
    this.configuredProjectByFile = configuredProjectByFile;
    this.inferredProject = new TypeScriptSemanticProject(
      this.fileSystem,
      TypeScriptProjectGraph.inferredCompilerOptions(snapshot.root, workspacePackages),
      inferredFiles,
    );
  }

  private readConfigurations(
    snapshot: WorkspaceSnapshot,
  ): readonly ParsedTypeScriptConfiguration[] {
    const paths = new WorkspacePathDialect(snapshot.root);
    const pending = [paths.join(snapshot.root, "tsconfig.json")];
    const seen = new Set<string>();
    const configurations: ParsedTypeScriptConfiguration[] = [];
    while (pending.length > 0) {
      const path = pending.shift() as string;
      if (seen.has(path)) continue;
      seen.add(path);
      const parsed = this.readConfiguration(path, snapshot);
      if (!parsed) continue;
      configurations.push(parsed);
      const references = Array.isArray(parsed.value.references) ? parsed.value.references : [];
      for (const reference of references) {
        const referencePath = TypeScriptProjectGraph.recordValue(reference).path;
        if (typeof referencePath !== "string") continue;
        const resolved = paths.resolve(parsed.directory, referencePath);
        pending.push(resolved.endsWith(".json") ? resolved : paths.join(resolved, "tsconfig.json"));
      }
    }
    return configurations;
  }

  private readConfiguration(
    path: string,
    snapshot: WorkspaceSnapshot,
  ): ParsedTypeScriptConfiguration | undefined {
    const paths = new WorkspacePathDialect(snapshot.root);
    const normalizedPath = paths.normalize(path);
    if (
      !this.fileSystem.existsSync(normalizedPath) ||
      this.fileSystem.isDirectorySync(normalizedPath)
    ) {
      return undefined;
    }
    const content = this.fileSystem.readFileSync(normalizedPath);
    const parsed = ts.parseConfigFileTextToJson(normalizedPath, content);
    if (parsed.error || !parsed.config || typeof parsed.config !== "object") return undefined;
    const value = parsed.config as Record<string, unknown>;
    const extendedInputs = new Map<string, string>();
    const parsedConfiguration = ts.parseJsonConfigFileContent(
      value,
      {
        useCaseSensitiveFileNames: paths.caseSensitive,
        fileExists: (candidate) => {
          const normalizedCandidate = paths.normalize(candidate);
          return (
            this.fileSystem.existsSync(normalizedCandidate) &&
            !this.fileSystem.isDirectorySync(normalizedCandidate)
          );
        },
        readFile: (candidate) => {
          const normalizedCandidate = paths.normalize(candidate);
          if (
            !this.fileSystem.existsSync(normalizedCandidate) ||
            this.fileSystem.isDirectorySync(normalizedCandidate)
          ) {
            return undefined;
          }
          const candidateContent = this.fileSystem.readFileSync(normalizedCandidate);
          extendedInputs.set(normalizedCandidate, candidateContent);
          return candidateContent;
        },
        readDirectory: (root, extensions, excludes, includes, depth) =>
          this.readConfiguredDirectory(snapshot, root, extensions, excludes, includes, depth),
      },
      paths.dirname(normalizedPath),
      undefined,
      normalizedPath,
    );
    return {
      path: normalizedPath,
      directory: paths.dirname(normalizedPath),
      content,
      value,
      compilerOptions: parsedConfiguration.options,
      fileNames: parsedConfiguration.fileNames.map((fileName) => paths.normalize(fileName)),
      extendedInputs,
    };
  }

  private readConfiguredDirectory(
    snapshot: WorkspaceSnapshot,
    root: string,
    extensions: readonly string[],
    excludes: readonly string[] | undefined,
    includes: readonly string[] | undefined,
    depth: number | undefined,
  ): string[] {
    const paths = new WorkspacePathDialect(snapshot.root);
    const normalizedRoot = paths.normalize(root);
    return snapshot.files
      .filter((file) => {
        const relative = paths.relative(normalizedRoot, file.absolute);
        if (!paths.contains(normalizedRoot, file.absolute)) return false;
        if (depth !== undefined && relative.split("/").length - 1 > depth) return false;
        if (!extensions.some((extension) => file.absolute.endsWith(extension))) return false;
        if (
          includes &&
          includes.length > 0 &&
          !includes.some((pattern) =>
            TypeScriptProjectGraph.matchesConfiguredPattern(
              relative,
              pattern,
              normalizedRoot,
              paths,
            ),
          )
        ) {
          return false;
        }
        return !excludes?.some((pattern) =>
          TypeScriptProjectGraph.matchesConfiguredPattern(relative, pattern, normalizedRoot, paths),
        );
      })
      .map((file) => file.absolute);
  }

  private readWorkspacePackages(
    snapshot: WorkspaceSnapshot,
    configurations: readonly ParsedTypeScriptConfiguration[],
  ): readonly WorkspacePackage[] {
    const paths = new WorkspacePathDialect(snapshot.root);
    const directories = new Map<string, string>([[paths.key(snapshot.root), snapshot.root]]);
    for (const configuration of configurations) {
      directories.set(paths.key(configuration.directory), configuration.directory);
    }
    for (const file of snapshot.files) {
      let directory = paths.dirname(file.absolute);
      while (paths.contains(snapshot.root, directory)) {
        directories.set(paths.key(directory), directory);
        if (paths.equals(directory, snapshot.root)) break;
        directory = paths.dirname(directory);
      }
    }
    const packages: WorkspacePackage[] = [];
    for (const directory of directories.values()) {
      const path = paths.join(directory, "package.json");
      if (!this.fileSystem.existsSync(path) || this.fileSystem.isDirectorySync(path)) continue;
      const content = this.fileSystem.readFileSync(path);
      const value = TypeScriptProjectGraph.parseJson(content);
      const name = value?.name;
      if (typeof name !== "string" || !value) continue;
      const mappings = TypeScriptProjectGraph.packageMappings(value, name).map((mapping) => ({
        specifier: mapping.specifier,
        target: paths.resolve(directory, mapping.target),
      }));
      if (mappings.length === 0) continue;
      packages.push({ path, content, mappings });
    }
    return packages;
  }

  private configuredFiles(
    snapshot: WorkspaceSnapshot,
    configuration: ParsedTypeScriptConfiguration,
  ): readonly WorkspaceFile[] {
    const paths = new WorkspacePathDialect(snapshot.root);
    const configuredPaths = new Set(configuration.fileNames.map((path) => paths.key(path)));
    return snapshot.files.filter((file) => configuredPaths.has(paths.key(file.absolute)));
  }

  private static compilerOptionsFor(
    root: string,
    configuration: ParsedTypeScriptConfiguration,
    workspacePackages: readonly WorkspacePackage[],
  ): ts.CompilerOptions {
    const pathDialect = new WorkspacePathDialect(root);
    const compilerOptions: ts.CompilerOptions = { ...configuration.compilerOptions };
    const baseUrl = compilerOptions.baseUrl ?? configuration.directory;
    const paths = TypeScriptProjectGraph.workspacePackagePaths(workspacePackages);
    for (const [specifier, targets] of Object.entries(compilerOptions.paths ?? {})) {
      paths[specifier] = targets.map((target) => pathDialect.resolve(baseUrl, target));
    }
    delete compilerOptions.rootDir;
    delete compilerOptions.outDir;
    delete compilerOptions.composite;
    compilerOptions.baseUrl ??= root;
    compilerOptions.paths = paths;
    compilerOptions.noEmit = true;
    return compilerOptions;
  }

  private static inferredCompilerOptions(
    root: string,
    workspacePackages: readonly WorkspacePackage[],
  ): ts.CompilerOptions {
    return {
      baseUrl: root,
      paths: TypeScriptProjectGraph.workspacePackagePaths(workspacePackages),
      noEmit: true,
    };
  }

  private static workspacePackagePaths(
    workspacePackages: readonly WorkspacePackage[],
  ): Record<string, string[]> {
    const paths: Record<string, string[]> = {};
    for (const workspacePackage of workspacePackages) {
      for (const mapping of workspacePackage.mappings) paths[mapping.specifier] = [mapping.target];
    }
    return paths;
  }

  private static changedInputCount(
    current: ReadonlyMap<string, string>,
    next: ReadonlyMap<string, string>,
  ): number {
    const paths = new Set([...current.keys(), ...next.keys()]);
    return [...paths].filter((path) => current.get(path) !== next.get(path)).length;
  }

  private static matchesGlob(path: string, pattern: string, caseSensitive = true): boolean {
    const relativePattern = pattern.replace(/^\.\//, "");
    const normalized =
      !relativePattern.includes("*") && posix.extname(relativePattern) === ""
        ? `${relativePattern.replace(/\/$/, "")}/**/*`
        : relativePattern.replace(/\/$/, "/**/*");
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
    return new RegExp(`^${expression}$`, caseSensitive ? "" : "i").test(path);
  }

  private static matchesConfiguredPattern(
    path: string,
    pattern: string,
    root: string,
    paths: WorkspacePathDialect,
  ): boolean {
    const normalizedPattern = paths.normalize(pattern);
    const relativePattern = paths.isAbsolute(normalizedPattern)
      ? paths.relative(root, normalizedPattern)
      : normalizedPattern;
    return TypeScriptProjectGraph.matchesGlob(path, relativePattern, paths.caseSensitive);
  }

  private static parseJson(content: string): Record<string, unknown> | undefined {
    try {
      const value: unknown = JSON.parse(content);
      return TypeScriptProjectGraph.recordValue(value);
    } catch {
      return undefined;
    }
  }

  private static packageMappings(
    value: Record<string, unknown>,
    packageName: string,
  ): readonly WorkspacePackageMapping[] {
    const exports = value.exports;
    const exportMap = TypeScriptProjectGraph.recordValue(exports);
    const subpathEntries = Object.entries(exportMap).filter(([subpath]) => subpath.startsWith("."));
    if (subpathEntries.length > 0) {
      return subpathEntries.flatMap(([subpath, exportTarget]) => {
        const target = TypeScriptProjectGraph.stringTarget(exportTarget);
        if (!target) return [];
        const specifier =
          subpath === "." ? packageName : `${packageName}/${subpath.replace(/^\.\//, "")}`;
        return [{ specifier, target }];
      });
    }
    const rootTarget =
      TypeScriptProjectGraph.stringTarget(exports) ??
      TypeScriptProjectGraph.stringTarget(value.types) ??
      TypeScriptProjectGraph.stringTarget(value.main);
    return rootTarget ? [{ specifier: packageName, target: rootTarget }] : [];
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
