import { posix } from "node:path";

import {
  ProjectGraph,
  type FileSystem,
  type ParsedProjectConfiguration,
  type PreparedProjectGraph,
  type ProjectGraphPreparationRequest,
  type ProjectGraphRefreshSummary,
  type ProjectInputCollector,
  type WorkspaceFile,
  type WorkspaceSnapshot,
} from "@symnav/core";
import { Project, type SourceFile, ts } from "ts-morph";

import type { TypeScriptSemanticSourceProvider } from "./typescript-workspace-state.js";
import type { TypeScriptSemanticQueryObserver } from "./typescript-semantic-query-observer.js";
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
  private project: Project;
  private loaded = false;

  constructor(
    private readonly fileSystem: FileSystem,
    private readonly compilerOptions: ts.CompilerOptions,
    private readonly ownedFiles: readonly WorkspaceFile[],
    private readonly observer?: TypeScriptSemanticQueryObserver,
  ) {
    this.project = this.createProject();
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
    if (this.ownedFiles.length === 0) return undefined;
    this.load();
    return this.project.getSourceFile(absolutePath);
  }

  releaseTransientResources(): void {
    if (!this.loaded) return;
    this.project.getLanguageService().compilerObject.cleanupSemanticCache();
    this.observer?.semanticCacheReleased?.();
    this.project = this.createProject();
    this.loaded = false;
  }

  private load(): void {
    if (this.loaded) return;
    this.observer?.semanticProjectLoaded?.(this.ownedFiles.length);
    for (const file of this.ownedFiles) {
      this.project.addSourceFileAtPathIfExists(file.absolute);
    }
    this.project.resolveSourceFileDependencies();
    this.loaded = true;
  }

  private createProject(): Project {
    return new Project({
      fileSystem: new WorkspaceFileSystemHost(this.fileSystem),
      compilerOptions: this.compilerOptions,
      skipAddingFilesFromTsConfig: true,
    });
  }
}

export class TypeScriptProjectGraph
  extends ProjectGraph<ParsedTypeScriptConfiguration, TypeScriptSemanticProject>
  implements TypeScriptSemanticSourceProvider
{
  private semanticProjects: readonly TypeScriptSemanticProject[] = [];
  private preparedSemanticProjects: readonly TypeScriptSemanticProject[] | undefined;

  constructor(
    fileSystem: FileSystem,
    private readonly observer?: TypeScriptSemanticQueryObserver,
  ) {
    super(fileSystem);
  }

  async refresh(snapshot: WorkspaceSnapshot): Promise<TypeScriptProjectGraphRefresh> {
    try {
      const summary = await this.refreshProjectGraph(snapshot);
      if (this.preparedSemanticProjects) {
        this.semanticProjects = this.preparedSemanticProjects;
        this.preparedSemanticProjects = undefined;
      }
      return TypeScriptProjectGraph.refreshSummary(summary);
    } catch (error) {
      this.preparedSemanticProjects = undefined;
      throw error;
    }
  }

  programFor(relativePath: string): ts.Program | undefined {
    return this.primaryProjectFor(relativePath)?.program();
  }

  languageServiceFor(relativePath: string): ts.LanguageService | undefined {
    return this.primaryProjectFor(relativePath)?.languageService();
  }

  sourceFilesFor(relativePath: string): readonly SourceFile[] {
    const file = this.workspaceFile(relativePath);
    if (!file) return [];
    return this.semanticProjects.flatMap((project) => {
      const sourceFile = project.sourceFile(file.absolute);
      return sourceFile ? [sourceFile] : [];
    });
  }

  sourceFileFor(relativePath: string): SourceFile | undefined {
    const file = this.workspaceFile(relativePath);
    if (!file) return undefined;
    return this.primaryProjectFor(relativePath)?.sourceFile(file.absolute);
  }

  protected initialConfigurationPaths(root: string): readonly string[] {
    const paths = new WorkspacePathDialect(root);
    return [paths.join(root, "tsconfig.json")];
  }

  protected async parseConfiguration(request: {
    readonly path: string;
    readonly content: string;
    readonly snapshot: WorkspaceSnapshot;
    readonly inputCollector: ProjectInputCollector;
  }): Promise<ParsedProjectConfiguration<ParsedTypeScriptConfiguration> | undefined> {
    const { path, content, snapshot, inputCollector } = request;
    const paths = new WorkspacePathDialect(snapshot.root);
    const normalizedPath = paths.normalize(path);
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
          return inputCollector.read(normalizedCandidate) !== undefined;
        },
        readFile: (candidate) => {
          const normalizedCandidate = paths.normalize(candidate);
          const candidateContent = inputCollector.read(normalizedCandidate);
          if (candidateContent === undefined) return undefined;
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
    const configuration: ParsedTypeScriptConfiguration = {
      path: normalizedPath,
      directory: paths.dirname(normalizedPath),
      content,
      value,
      compilerOptions: parsedConfiguration.options,
      fileNames: parsedConfiguration.fileNames.map((fileName) => paths.normalize(fileName)),
      extendedInputs,
    };
    return {
      configuration,
      referencedConfigurationPaths: TypeScriptProjectGraph.referencePaths(configuration, paths),
      inputs: [
        { path: normalizedPath, content },
        ...[...extendedInputs].map(([inputPath, inputContent]) => ({
          path: inputPath,
          content: inputContent,
        })),
      ],
    };
  }

  protected filesForConfiguration(
    configuration: ParsedTypeScriptConfiguration,
    snapshot: WorkspaceSnapshot,
  ): readonly WorkspaceFile[] {
    const paths = new WorkspacePathDialect(snapshot.root);
    const configuredPaths = new Set(configuration.fileNames.map((path) => paths.key(path)));
    return snapshot.files.filter((file) => configuredPaths.has(paths.key(file.absolute)));
  }

  protected async prepareProjects(
    request: ProjectGraphPreparationRequest<ParsedTypeScriptConfiguration>,
  ): Promise<PreparedProjectGraph<TypeScriptSemanticProject>> {
    const configurations = request.configurations.map(({ configuration }) => configuration);
    const workspacePackages = this.readWorkspacePackages(
      request.snapshot,
      configurations,
      request.inputCollector,
    );
    const configuredProjects = request.configurations.map(
      ({ configuration, files }) =>
        new TypeScriptSemanticProject(
          this.fileSystem,
          TypeScriptProjectGraph.compilerOptionsFor(
            request.snapshot.root,
            configuration,
            workspacePackages,
          ),
          files,
          this.observer,
        ),
    );
    const inferredProject = new TypeScriptSemanticProject(
      this.fileSystem,
      TypeScriptProjectGraph.inferredCompilerOptions(request.snapshot.root, workspacePackages),
      request.inferredFiles,
      this.observer,
    );
    this.preparedSemanticProjects = [...configuredProjects, inferredProject];
    return {
      configuredProjects,
      inferredProject,
      inputs: workspacePackages.map(({ path, content }) => ({ path, content })),
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
    inputCollector: ProjectInputCollector,
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
      const content = inputCollector.read(path);
      if (content === undefined) continue;
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

  private static refreshSummary(
    summary: ProjectGraphRefreshSummary,
  ): TypeScriptProjectGraphRefresh {
    return {
      root: summary.root,
      configuredProjectCount: summary.configuredProjectCount,
      inferredFileCount: summary.inferredFileCount,
      changedConfigurationCount: summary.changedInputCount,
    };
  }

  private static referencePaths(
    configuration: ParsedTypeScriptConfiguration,
    paths: WorkspacePathDialect,
  ): readonly string[] {
    const references = Array.isArray(configuration.value.references)
      ? configuration.value.references
      : [];
    return references.flatMap((reference) => {
      const referencePath = TypeScriptProjectGraph.recordValue(reference).path;
      if (typeof referencePath !== "string") return [];
      const resolved = paths.resolve(configuration.directory, referencePath);
      return [resolved.endsWith(".json") ? resolved : paths.join(resolved, "tsconfig.json")];
    });
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
