import type {
  ResolvedPath,
  ResolveSymbolTargetOptions,
  SymbolOverviewNode,
  SymbolTargetCandidate,
  SymbolTargetPattern,
} from "@symnav/core";
import {
  formatSymbolIdentity,
  SymbolTargetGrammar,
  validateResolveSymbolTargetOptions,
} from "@symnav/core";

import type { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";

export interface FindTargetCandidatesArgs {
  readonly index: WorkspaceDeclarationIndex;
  readonly files: readonly ResolvedPath[];
  readonly pattern: SymbolTargetPattern;
  readonly options: ResolveSymbolTargetOptions;
}

export async function findTargetCandidates(
  args: FindTargetCandidatesArgs,
): Promise<readonly SymbolTargetCandidate[]> {
  validateResolveSymbolTargetOptions(args.options);
  args.index.ensureFiles(args.files);
  const candidates: SymbolTargetCandidate[] = [];
  for (const file of args.files) {
    for (const symbol of args.index.declarationsIn(file.relative) ?? []) {
      if (!SymbolTargetGrammar.matches(args.pattern, symbol.identity)) continue;
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
