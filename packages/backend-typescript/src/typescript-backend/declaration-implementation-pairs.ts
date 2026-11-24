import { posix } from "node:path";

import {
  Node,
  ts,
  type Project,
  type SourceFile,
  type StringLiteral,
  type TypeChecker,
} from "ts-morph";

import type {
  TypeScriptSemanticSourceProvider,
  TypeScriptWorkspaceState,
} from "./typescript-workspace-state.js";

export interface DeclarationImplementationFilePair {
  readonly declarationFile: string;
  readonly implementationFile: string;
}

interface ImporterResolution {
  readonly program: ts.Program;
  readonly checker: TypeChecker;
  readonly hidingHost: ts.ModuleResolutionHost;
  readonly cache: ts.ModuleResolutionCache;
}

const DECLARATION_FILE_PATTERN = /\.d\.[mc]?ts$/;
const IMPLEMENTATION_FILE_PATTERN = /\.(?:jsx?|mjs|cjs)$/;
const IMPLEMENTATION_EXTENSION_BY_DECLARATION_EXTENSION: ReadonlyMap<string, string> = new Map([
  [".d.ts", ".js"],
  [".d.mts", ".mjs"],
  [".d.cts", ".cjs"],
]);

export class DeclarationImplementationPairs {
  private readonly importerPairsByProgram = new WeakMap<
    ts.Program,
    readonly DeclarationImplementationFilePair[]
  >();

  constructor(
    private readonly semanticSources: TypeScriptSemanticSourceProvider,
    private readonly workspaceState: TypeScriptWorkspaceState,
  ) {}

  filePairsOf(relativePath: string): readonly DeclarationImplementationFilePair[] {
    if (!DeclarationImplementationPairs.selfSpecifier(relativePath)) return [];
    const selfResolvedPair = this.selfResolvedPair(relativePath);
    const importerPairs = this.semanticSources
      .sourceFilesFor(relativePath)
      .flatMap((sourceFile) => this.importerPairsOf(sourceFile.getProject()))
      .filter((pair) => DeclarationImplementationPairs.includes(pair, relativePath));
    const pairsByKey = new Map<string, DeclarationImplementationFilePair>();
    for (const pair of [...(selfResolvedPair ? [selfResolvedPair] : []), ...importerPairs]) {
      pairsByKey.set(`${pair.declarationFile}\0${pair.implementationFile}`, pair);
    }
    return [...pairsByKey.values()];
  }

  private selfResolvedPair(relativePath: string): DeclarationImplementationFilePair | undefined {
    const specifier = DeclarationImplementationPairs.selfSpecifier(relativePath);
    if (!specifier) return undefined;
    const sourceFile = this.semanticSources.sourceFileFor(relativePath);
    if (!sourceFile) return undefined;
    const pair = this.resolvedPair(specifier, sourceFile);
    return pair && DeclarationImplementationPairs.includes(pair, relativePath) ? pair : undefined;
  }

  private importerPairsOf(project: Project): readonly DeclarationImplementationFilePair[] {
    const program = project.getProgram().compilerObject;
    const cached = this.importerPairsByProgram.get(program);
    if (cached) return cached;
    const pairs = this.scanImporterPairs(project, program);
    this.importerPairsByProgram.set(program, pairs);
    return pairs;
  }

  private scanImporterPairs(
    project: Project,
    program: ts.Program,
  ): readonly DeclarationImplementationFilePair[] {
    const resolution: ImporterResolution = {
      program,
      checker: project.getTypeChecker(),
      hidingHost: DeclarationImplementationPairs.hidingDeclarationFiles(
        project.getModuleResolutionHost(),
      ),
      cache: ts.createModuleResolutionCache(
        program.getCurrentDirectory(),
        (fileName) => fileName,
        program.getCompilerOptions(),
      ),
    };
    return project.getSourceFiles().flatMap((importer) => {
      if (!this.workspaceState.relativePathOf(importer)) return [];
      return importer.getImportStringLiterals().flatMap((literal) => {
        const pair = this.importerPair(importer, literal, resolution);
        return pair ? [pair] : [];
      });
    });
  }

  private importerPair(
    importer: SourceFile,
    literal: StringLiteral,
    resolution: ImporterResolution,
  ): DeclarationImplementationFilePair | undefined {
    const declarationPath = resolution.checker
      .getSymbolAtLocation(literal)
      ?.getDeclarations()
      .find((declaration) => Node.isSourceFile(declaration))
      ?.getSourceFile()
      .getFilePath();
    const landsInWorkspaceDeclarationFile =
      declarationPath !== undefined &&
      DECLARATION_FILE_PATTERN.test(declarationPath) &&
      this.workspaceState.relativePathOfAbsolute(declarationPath) !== undefined;
    if (!landsInWorkspaceDeclarationFile) return undefined;
    const implementationPath = ts.resolveModuleName(
      literal.getLiteralText(),
      importer.getFilePath(),
      resolution.program.getCompilerOptions(),
      resolution.hidingHost,
      resolution.cache,
      undefined,
      resolution.program.getModeForUsageLocation(importer.compilerNode, literal.compilerNode),
    ).resolvedModule?.resolvedFileName;
    return this.workspacePair(declarationPath, implementationPath);
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

  private static includes(pair: DeclarationImplementationFilePair, relativePath: string): boolean {
    return pair.declarationFile === relativePath || pair.implementationFile === relativePath;
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
