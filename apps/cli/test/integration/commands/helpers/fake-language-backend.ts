import type {
  CallEdge,
  CallTargetResolution,
  LanguageBackend,
  OverviewFileEntries,
  SymbolReference,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolTargetPattern,
} from "@symnav/core";

export interface FakeLanguageBackendOptions {
  accept?: (filePath: string) => boolean;
  entries?: (filePath: string) => OverviewFileEntries;
}

export class FakeLanguageBackend implements LanguageBackend {
  readonly calls: string[] = [];
  private readonly acceptFn: (filePath: string) => boolean;
  private readonly entriesFn: (filePath: string) => OverviewFileEntries;

  constructor(options: FakeLanguageBackendOptions = {}) {
    this.acceptFn = options.accept ?? (() => true);
    this.entriesFn = options.entries ?? ((filePath: string) => ({ file: filePath, entries: [] }));
  }

  accepts(filePath: string): boolean {
    return this.acceptFn(filePath);
  }

  async fileEntries(path: ResolvedPath): Promise<OverviewFileEntries> {
    this.calls.push(path.relative);
    return this.entriesFn(path.relative);
  }

  async resolveSymbols(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async resolveSymbolTarget(
    _files: readonly ResolvedPath[],
    pattern: SymbolTargetPattern,
  ): Promise<SymbolOverviewNode> {
    throw new Error(`unexpected symbol target resolution: ${pattern.raw}`);
  }

  async findDefinitions(): Promise<readonly SymbolOverviewNode[]> {
    return [];
  }

  async findReferences(): Promise<readonly SymbolReference[]> {
    return [];
  }

  async findCallTarget(): Promise<CallTargetResolution> {
    return { outcome: "not-found" };
  }

  async findCallees(): Promise<readonly CallEdge[]> {
    return [];
  }

  async findCallers(): Promise<readonly CallEdge[]> {
    return [];
  }
}
