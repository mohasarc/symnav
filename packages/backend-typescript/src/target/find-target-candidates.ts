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
  readonly declarationIndex: WorkspaceDeclarationIndex;
  readonly files: readonly ResolvedPath[];
  readonly pattern: SymbolTargetPattern;
  readonly options: ResolveSymbolTargetOptions;
}

export class TargetCandidateFinder {
  static async find(args: FindTargetCandidatesArgs): Promise<readonly SymbolTargetCandidate[]> {
    validateResolveSymbolTargetOptions(args.options);
    args.declarationIndex.ensureFiles(args.files);
    const candidates: SymbolTargetCandidate[] = [];
    for (const file of args.files) {
      for (const symbol of args.declarationIndex.declarationsIn(file.relative) ?? []) {
        if (!SymbolTargetGrammar.matches(args.pattern, symbol.identity)) continue;
        if (!TargetCandidateFinder.matchesLine(args.options.containingLine, symbol)) continue;
        candidates.push({
          symbol,
          canonicalId: formatSymbolIdentity(symbol.identity),
          header: symbol.header,
        });
      }
    }
    return candidates;
  }

  private static matchesLine(line: number | undefined, symbol: SymbolOverviewNode): boolean {
    if (line === undefined) {
      return true;
    }
    return line >= symbol.range.startLine && line <= symbol.range.endLine;
  }
}
