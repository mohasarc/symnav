import { posix } from "node:path";

import { ts, type SourceFile } from "ts-morph";

import type {
  TypeScriptSemanticSourceProvider,
  TypeScriptWorkspaceState,
} from "./typescript-workspace-state.js";

export interface DeclarationImplementationFilePair {
  readonly declarationFile: string;
  readonly implementationFile: string;
}

const DECLARATION_FILE_PATTERN = /\.d\.[mc]?ts$/;
const IMPLEMENTATION_FILE_PATTERN = /\.(?:jsx?|mjs|cjs)$/;
const IMPLEMENTATION_EXTENSION_BY_DECLARATION_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".d.ts", ".js"],
  [".d.mts", ".mjs"],
  [".d.cts", ".cjs"],
]);

export class DeclarationImplementationPairs {
  constructor(
    private readonly semanticSources: TypeScriptSemanticSourceProvider,
    private readonly workspaceState: TypeScriptWorkspaceState,
  ) {}

  filePairsOf(relativePath: string): readonly DeclarationImplementationFilePair[] {
    const pair = this.selfResolvedPair(relativePath);
    return pair ? [pair] : [];
  }

  private selfResolvedPair(relativePath: string): DeclarationImplementationFilePair | undefined {
    const specifier = DeclarationImplementationPairs.selfSpecifier(relativePath);
    if (!specifier) return undefined;
    const sourceFile = this.semanticSources.sourceFileFor(relativePath);
    if (!sourceFile) return undefined;
    const pair = this.resolvedPair(specifier, sourceFile);
    const pairsRelativePath =
      pair?.declarationFile === relativePath || pair?.implementationFile === relativePath;
    return pairsRelativePath ? pair : undefined;
  }

  private resolvedPair(
    specifier: string,
    containingFile: SourceFile,
  ): DeclarationImplementationFilePair | undefined {
    const project = containingFile.getProject();
    const options = project.getCompilerOptions();
    const host = project.getModuleResolutionHost();
    const containingPath = containingFile.getFilePath();
    const declarationPath = ts.resolveModuleName(specifier, containingPath, options, host)
      .resolvedModule?.resolvedFileName;
    const implementationPath = ts.resolveModuleName(
      specifier,
      containingPath,
      options,
      DeclarationImplementationPairs.hidingDeclarationFiles(host),
    ).resolvedModule?.resolvedFileName;
    return this.workspacePair(declarationPath, implementationPath);
  }

  private workspacePair(
    declarationPath: string | undefined,
    implementationPath: string | undefined,
  ): DeclarationImplementationFilePair | undefined {
    if (!declarationPath || !DECLARATION_FILE_PATTERN.test(declarationPath)) return undefined;
    if (!implementationPath || !IMPLEMENTATION_FILE_PATTERN.test(implementationPath)) {
      return undefined;
    }
    const declarationFile = this.workspaceState.relativePathOfAbsolute(declarationPath);
    const implementationFile = this.workspaceState.relativePathOfAbsolute(implementationPath);
    if (!declarationFile || !implementationFile) return undefined;
    return { declarationFile, implementationFile };
  }

  private static selfSpecifier(relativePath: string): string | undefined {
    const name = posix.basename(relativePath);
    if (IMPLEMENTATION_FILE_PATTERN.test(name)) return `./${name}`;
    const declarationExtension = [...IMPLEMENTATION_EXTENSION_BY_DECLARATION_EXTENSION.keys()].find(
      (extension) => name.endsWith(extension),
    );
    if (!declarationExtension) return undefined;
    const implementationExtension =
      IMPLEMENTATION_EXTENSION_BY_DECLARATION_EXTENSION.get(declarationExtension);
    return `./${name.slice(0, -declarationExtension.length)}${implementationExtension}`;
  }

  private static hidingDeclarationFiles(host: ts.ModuleResolutionHost): ts.ModuleResolutionHost {
    return {
      ...host,
      fileExists: (path) => !DECLARATION_FILE_PATTERN.test(path) && host.fileExists(path),
    };
  }
}
