import type {
  FileSystem,
  ResolvedPath,
  ResolveSymbolTargetOptions,
  SymbolOverviewNode,
  SymbolTargetCandidate,
  SymbolTargetPattern,
} from "@symnav/core";
import { formatSymbolIdentity, symbolTargetMatches, OverviewTree } from "@symnav/core";

import { loadFileEntries } from "../extract/load-file-entries.js";

export interface FindTargetCandidatesArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly pattern: SymbolTargetPattern;
  readonly options: ResolveSymbolTargetOptions;
}

export async function findTargetCandidates(
  args: FindTargetCandidatesArgs,
): Promise<readonly SymbolTargetCandidate[]> {
  const candidates: SymbolTargetCandidate[] = [];
  for (const file of args.files) {
    for (const symbol of OverviewTree.walkSymbols(loadFileEntries(args.fs, file).entries)) {
      if (!symbolTargetMatches(args.pattern, symbol.identity)) continue;
      if (!matchesLine(args.options.containingLine, symbol)) continue;
      candidates.push({
        symbol,
        canonicalId: formatSymbolIdentity(symbol.identity),
        header: symbol.header,
      });
    }
  }
  return candidates;
}

function matchesLine(line: number | undefined, symbol: SymbolOverviewNode): boolean {
  if (line === undefined) {
    return true;
  }
  return line >= symbol.range.startLine && line <= symbol.range.endLine;
}
