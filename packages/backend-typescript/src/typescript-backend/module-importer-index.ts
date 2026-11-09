import { posix } from "node:path";

import type { WorkspacePathDialect } from "./workspace-path-dialect.js";

export interface ModuleImporterSource {
  readonly absolute: string;
  readonly text: string;
}

export interface ModuleResolutionScope {
  readonly baseUrl: string | undefined;
  readonly paths: Readonly<Record<string, readonly string[]>>;
}

export interface ModuleImporterIndexInput {
  readonly paths: WorkspacePathDialect;
  readonly sources: readonly ModuleImporterSource[];
  readonly packageDirectories: readonly string[];
}

type ImportersByTargetKey = Map<string, Set<string>>;

export class ModuleImporterIndex {
  private static readonly QUOTES = ["'", '"', "`"];
  private static readonly LINE_BREAK = "\n";
  private static readonly MODULE_EXTENSION = /(?:\.d)?\.[cm]?[jt]sx?$/;
  private static readonly RELATIVE_SPECIFIER = /^\.\.?(?:\/|$)/;
  private static readonly TRAILING_SEPARATORS = /\/+$/;
  private static readonly PATTERN_WILDCARD = "*";
  private static readonly INDEX_STEM = "index";
  private static readonly ARBITRARY_EXTENSION_DECLARATION = /\.d(\.[^./]+)$/;

  private readonly paths: WorkspacePathDialect;
  private readonly packageDirectoryKeys: ReadonlySet<string>;
  private readonly pathImporters: ImportersByTargetKey = new Map();
  private readonly nonRelativeSpecifiersByImporter = new Map<string, readonly string[]>();
  private readonly scopeImportersByScopeKey = new Map<string, ImportersByTargetKey>();

  constructor(input: ModuleImporterIndexInput) {
    this.paths = input.paths;
    this.packageDirectoryKeys = new Set(
      input.packageDirectories.map((directory) => input.paths.key(directory)),
    );
    for (const source of input.sources) this.indexSource(source);
  }

  filesReaching(absolutePath: string, scope: ModuleResolutionScope): ReadonlySet<string> {
    const scopeImporters = this.scopeImporters(scope);
    const targetKey = this.paths.key(absolutePath);
    const reaching = new Set([targetKey]);
    const pending = [targetKey];
    for (let fileKey = pending.pop(); fileKey !== undefined; fileKey = pending.pop()) {
      for (const lookupKey of this.lookupKeys(fileKey)) {
        const importers = [
          ...(this.pathImporters.get(lookupKey) ?? []),
          ...(scopeImporters.get(lookupKey) ?? []),
        ];
        for (const importerKey of importers) {
          if (reaching.has(importerKey)) continue;
          reaching.add(importerKey);
          pending.push(importerKey);
        }
      }
    }
    return reaching;
  }

  private indexSource(source: ModuleImporterSource): void {
    const importerKey = this.paths.key(source.absolute);
    const directory = this.paths.dirname(source.absolute);
    const nonRelativeSpecifiers: string[] = [];
    for (const specifier of new Set(ModuleImporterIndex.quotedStrings(source.text))) {
      const pathSpecifier =
        ModuleImporterIndex.RELATIVE_SPECIFIER.test(specifier) || this.paths.isAbsolute(specifier);
      if (pathSpecifier) {
        const targetKey = this.moduleKey(this.paths.resolve(directory, specifier));
        ModuleImporterIndex.addImporter(this.pathImporters, targetKey, importerKey);
      } else {
        nonRelativeSpecifiers.push(specifier);
      }
    }
    this.nonRelativeSpecifiersByImporter.set(importerKey, nonRelativeSpecifiers);
  }

  private scopeImporters(scope: ModuleResolutionScope): ImportersByTargetKey {
    const scopeKey = JSON.stringify(scope);
    const existing = this.scopeImportersByScopeKey.get(scopeKey);
    if (existing) return existing;
    const importers: ImportersByTargetKey = new Map();
    const targetKeysBySpecifier = new Map<string, readonly string[]>();
    for (const [importerKey, specifiers] of this.nonRelativeSpecifiersByImporter) {
      for (const specifier of specifiers) {
        let targetKeys = targetKeysBySpecifier.get(specifier);
        if (!targetKeys) {
          targetKeys = this.nonRelativeResolutions(specifier, scope).map((target) =>
            this.moduleKey(target),
          );
          targetKeysBySpecifier.set(specifier, targetKeys);
        }
        for (const targetKey of targetKeys) {
          ModuleImporterIndex.addImporter(importers, targetKey, importerKey);
        }
      }
    }
    this.scopeImportersByScopeKey.set(scopeKey, importers);
    return importers;
  }

  private nonRelativeResolutions(
    specifier: string,
    scope: ModuleResolutionScope,
  ): readonly string[] {
    const baseUrlResolutions =
      scope.baseUrl === undefined ? [] : [this.paths.resolve(scope.baseUrl, specifier)];
    const pathResolutions = Object.entries(scope.paths).flatMap(([pattern, targets]) =>
      ModuleImporterIndex.substitutedTargets(specifier, pattern, targets),
    );
    return [...baseUrlResolutions, ...pathResolutions];
  }

  private moduleKey(path: string): string {
    return this.paths
      .key(path)
      .replace(ModuleImporterIndex.TRAILING_SEPARATORS, "")
      .replace(ModuleImporterIndex.MODULE_EXTENSION, "");
  }

  private lookupKeys(fileKey: string): readonly string[] {
    const stem = fileKey.replace(ModuleImporterIndex.MODULE_EXTENSION, "");
    const keys = [stem];
    const arbitraryExtensionStem = stem.replace(
      ModuleImporterIndex.ARBITRARY_EXTENSION_DECLARATION,
      "$1",
    );
    if (arbitraryExtensionStem !== stem) keys.push(arbitraryExtensionStem);
    if (posix.basename(stem) === ModuleImporterIndex.INDEX_STEM) keys.push(posix.dirname(stem));
    for (
      let directory = posix.dirname(fileKey);
      directory !== posix.dirname(directory);
      directory = posix.dirname(directory)
    ) {
      if (this.packageDirectoryKeys.has(directory)) keys.push(directory);
    }
    return keys;
  }

  private static addImporter(
    importers: ImportersByTargetKey,
    targetKey: string,
    importerKey: string,
  ): void {
    let targetImporters = importers.get(targetKey);
    if (!targetImporters) {
      targetImporters = new Set();
      importers.set(targetKey, targetImporters);
    }
    targetImporters.add(importerKey);
  }

  private static substitutedTargets(
    specifier: string,
    pattern: string,
    targets: readonly string[],
  ): readonly string[] {
    const wildcardIndex = pattern.indexOf(ModuleImporterIndex.PATTERN_WILDCARD);
    if (wildcardIndex < 0) return pattern === specifier ? targets : [];
    const prefix = pattern.slice(0, wildcardIndex);
    const suffix = pattern.slice(wildcardIndex + 1);
    const matches =
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix);
    if (!matches) return [];
    const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    return targets.map((target) => target.replace(ModuleImporterIndex.PATTERN_WILDCARD, captured));
  }

  private static quotedStrings(text: string): readonly string[] {
    const strings: string[] = [];
    for (const quote of ModuleImporterIndex.QUOTES) {
      for (let open = text.indexOf(quote); open >= 0; open = text.indexOf(quote, open + 1)) {
        const close = text.indexOf(quote, open + 1);
        if (close < 0) break;
        const value = text.slice(open + 1, close);
        if (value.length > 0 && !value.includes(ModuleImporterIndex.LINE_BREAK)) {
          strings.push(value);
        }
      }
    }
    return strings;
  }
}
