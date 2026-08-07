import type {
  CallEdge,
  CallTargetResolution,
  LanguageBackend,
  OverviewFileEntries,
  SymbolReference,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolTargetCandidate,
  SymbolTargetPattern,
} from "@symnav/core";
import { SymbolTargetGrammar } from "@symnav/core";

export interface FakeLanguageBackendOptions {
  accept?: (filePath: string) => boolean;
  entries?: (filePath: string) => OverviewFileEntries;
  targetCandidates?: readonly SymbolTargetCandidate[];
}

export class FakeLanguageBackend implements LanguageBackend {
  readonly calls: string[] = [];
  readonly targetCandidateCalls: string[][] = [];
  private readonly acceptFn: (filePath: string) => boolean;
  private readonly entriesFn: (filePath: string) => OverviewFileEntries;
  private readonly targetCandidates: readonly SymbolTargetCandidate[];

  constructor(options: FakeLanguageBackendOptions = {}) {
    this.acceptFn = options.accept ?? (() => true);
    this.entriesFn = options.entries ?? ((filePath: string) => ({ file: filePath, entries: [] }));
    this.targetCandidates = options.targetCandidates ?? [];
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

  async findTargetCandidates(
    files: readonly ResolvedPath[],
    pattern: SymbolTargetPattern,
  ): Promise<readonly SymbolTargetCandidate[]> {
    this.targetCandidateCalls.push(files.map((file) => file.relative));
    return this.targetCandidates.filter((candidate) =>
      SymbolTargetGrammar.matches(pattern, candidate.symbol.identity),
    );
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
