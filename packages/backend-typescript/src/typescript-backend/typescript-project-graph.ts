import { posix } from "node:path";

import type { FileSystem, WorkspaceSnapshot } from "@symnav/core";
import { Project, ts } from "ts-morph";

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
}

interface WorkspacePackage {
  readonly path: string;
  readonly content: string;
  readonly name: string;
  readonly target: string;
}

export class TypeScriptProjectGraph {
  private readonly project: Project;
  private acceptedFiles = new Set<string>();
  private configurationInputs = new Map<string, string>();
  private initialized = false;

  constructor(private readonly fileSystem: FileSystem) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(fileSystem) });
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
    if (changedConfigurationCount > 0 || !this.initialized) {
      this.configureProject(snapshot.root, configurations, workspacePackages);
    }
    this.initialized = true;
    for (const file of snapshot.files) {
      if (!this.project.getSourceFile(file.absolute)) {
        this.project.addSourceFileAtPath(file.absolute);
      }
    }
    this.configurationInputs = nextInputs;
    this.acceptedFiles = new Set(snapshot.files.map((file) => file.relative));
    const configuredFiles = this.configuredFiles(snapshot, configurations);
    return {
      root: snapshot.root,
      configuredProjectCount: configurations.length,
      inferredFileCount: snapshot.files.filter((file) => !configuredFiles.has(file.relative))
        .length,
      changedConfigurationCount,
    };
  }

  programFor(relativePath: string): ts.Program | undefined {
    if (!this.acceptedFiles.has(relativePath)) return undefined;
    return this.project.getProgram().compilerObject;
  }

  languageServiceFor(relativePath: string): ts.LanguageService | undefined {
    if (!this.acceptedFiles.has(relativePath)) return undefined;
    return this.project.getLanguageService().compilerObject;
  }

  releaseTransientResources(): void {
    this.project.getLanguageService().compilerObject.cleanupSemanticCache();
  }

  workspaceProject(): Project {
    return this.project;
  }

  private configureProject(
    root: string,
    configurations: readonly ParsedTypeScriptConfiguration[],
    workspacePackages: readonly WorkspacePackage[],
  ): void {
    const compilerOptions: ts.CompilerOptions = {};
    const paths: Record<string, string[]> = {};
    for (const configuration of configurations) {
      const rawCompilerOptions = TypeScriptProjectGraph.recordValue(
        configuration.value.compilerOptions,
      );
      const converted = ts.convertCompilerOptionsFromJson(
        rawCompilerOptions,
        configuration.directory,
      );
      Object.assign(compilerOptions, converted.options);
      const configuredPaths = TypeScriptProjectGraph.recordValue(rawCompilerOptions.paths);
      const baseUrl =
        typeof rawCompilerOptions.baseUrl === "string"
          ? posix.resolve(configuration.directory, rawCompilerOptions.baseUrl)
          : configuration.directory;
      for (const [alias, targets] of Object.entries(configuredPaths)) {
        if (!Array.isArray(targets)) continue;
        paths[alias] = targets
          .filter((target): target is string => typeof target === "string")
          .map((target) => posix.resolve(baseUrl, target));
      }
    }
    for (const workspacePackage of workspacePackages) {
      paths[workspacePackage.name] = [workspacePackage.target];
    }
    delete compilerOptions.rootDir;
    delete compilerOptions.outDir;
    delete compilerOptions.composite;
    compilerOptions.baseUrl = root;
    compilerOptions.paths = paths;
    compilerOptions.noEmit = true;
    this.project.compilerOptions.reset();
    this.project.compilerOptions.set(compilerOptions);
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
    if (!this.fileSystem.existsSync(path) || this.fileSystem.isDirectorySync(path))
      return undefined;
    const content = this.fileSystem.readFileSync(path);
    const parsed = ts.parseConfigFileTextToJson(path, content);
    if (parsed.error || !parsed.config || typeof parsed.config !== "object") return undefined;
    return {
      path,
      directory: posix.dirname(path),
      content,
      value: parsed.config as Record<string, unknown>,
    };
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
      const target = value && TypeScriptProjectGraph.packageTarget(value);
      if (typeof name !== "string" || !target) continue;
      packages.push({ path, content, name, target: posix.resolve(directory, target) });
    }
    return packages;
  }

  private configuredFiles(
    snapshot: WorkspaceSnapshot,
    configurations: readonly ParsedTypeScriptConfiguration[],
  ): ReadonlySet<string> {
    const configured = new Set<string>();
    for (const configuration of configurations) {
      const explicitFiles = Array.isArray(configuration.value.files)
        ? configuration.value.files.filter((file): file is string => typeof file === "string")
        : undefined;
      if (explicitFiles) {
        for (const file of explicitFiles) {
          const absolute = posix.resolve(configuration.directory, file);
          const match = snapshot.files.find((candidate) => candidate.absolute === absolute);
          if (match) configured.add(match.relative);
        }
        continue;
      }
      const includes = Array.isArray(configuration.value.include)
        ? configuration.value.include.filter((value): value is string => typeof value === "string")
        : ["**/*"];
      const excludes = Array.isArray(configuration.value.exclude)
        ? configuration.value.exclude.filter((value): value is string => typeof value === "string")
        : ["node_modules", "bower_components", "jspm_packages"];
      for (const file of snapshot.files) {
        const relative = posix.relative(configuration.directory, file.absolute);
        if (relative.startsWith("../")) continue;
        if (!includes.some((pattern) => TypeScriptProjectGraph.matchesGlob(relative, pattern))) {
          continue;
        }
        if (excludes.some((pattern) => TypeScriptProjectGraph.matchesGlob(relative, pattern))) {
          continue;
        }
        configured.add(file.relative);
      }
    }
    return configured;
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
