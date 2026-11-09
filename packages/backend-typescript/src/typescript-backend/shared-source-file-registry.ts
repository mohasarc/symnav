import { type Project, ts } from "ts-morph";

interface ProjectDocumentRegistry {
  createOrUpdateSourceFile(
    fileName: string,
    compilationSettings: ts.CompilerOptions,
    scriptSnapshot: ts.IScriptSnapshot,
    scriptKind: ts.ScriptKind | undefined,
  ): ts.SourceFile;
  acquireDocument(
    fileName: string,
    compilationSettings: ts.CompilerOptions,
    scriptSnapshot: ts.IScriptSnapshot,
    version: string,
    scriptKind: ts.ScriptKind | undefined,
  ): ts.SourceFile;
  getSourceFileVersion(sourceFile: ts.SourceFile): string;
}

interface ProjectWithDocumentRegistry {
  readonly _context: {
    readonly compilerFactory: { readonly documentRegistry: ProjectDocumentRegistry };
  };
}

interface SharedSourceFileRequest {
  readonly fileName: string;
  readonly compilationSettings: ts.CompilerOptions;
  readonly scriptSnapshot: ts.IScriptSnapshot;
  readonly scriptKind: ts.ScriptKind | undefined;
  readonly registry: ProjectDocumentRegistry;
}

export class SharedSourceFileRegistry {
  private static readonly INITIAL_VERSION = "0";

  private readonly settingsKeys = ts.createDocumentRegistry();
  private sourceFilesByKey = new Map<string, ts.SourceFile>();

  share(project: Project): void {
    const registry = (project as unknown as ProjectWithDocumentRegistry)._context.compilerFactory
      .documentRegistry;
    registry.createOrUpdateSourceFile = (
      fileName,
      compilationSettings,
      scriptSnapshot,
      scriptKind,
    ) => this.sourceFile({ fileName, compilationSettings, scriptSnapshot, scriptKind, registry });
    registry.acquireDocument = (
      fileName,
      compilationSettings,
      scriptSnapshot,
      _version,
      scriptKind,
    ) => this.sourceFile({ fileName, compilationSettings, scriptSnapshot, scriptKind, registry });
  }

  clear(): void {
    this.sourceFilesByKey = new Map();
  }

  private sourceFile(request: SharedSourceFileRequest): ts.SourceFile {
    const { fileName, compilationSettings, scriptSnapshot, scriptKind, registry } = request;
    const settingsKey = this.settingsKeys.getKeyForCompilationSettings(compilationSettings);
    const key = `${settingsKey}|${scriptKind}|${fileName}`;
    const text = scriptSnapshot.getText(0, scriptSnapshot.getLength());
    const cached = this.sourceFilesByKey.get(key);
    if (cached?.text === text) return cached;
    const version = cached
      ? String(Number(registry.getSourceFileVersion(cached)) + 1)
      : SharedSourceFileRegistry.INITIAL_VERSION;
    const created = ts.createLanguageServiceSourceFile(
      fileName,
      scriptSnapshot,
      compilationSettings.target ?? ts.ScriptTarget.Latest,
      version,
      true,
      scriptKind,
    );
    this.sourceFilesByKey.set(key, created);
    return created;
  }
}
