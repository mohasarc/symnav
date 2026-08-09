import type {
  ResolvedPath,
  SymbolTargetCandidate,
  SymbolTargetPattern,
} from "@symnav/core";
import { formatSymbolIdentity, SymbolTargetGrammar } from "@symnav/core";

import type { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";

export interface FindTargetCandidatesArgs {
  readonly declarationIndex: WorkspaceDeclarationIndex;
  readonly files: readonly ResolvedPath[];
  readonly pattern: SymbolTargetPattern;
}

export class TargetCandidateFinder {
  static async find(args: FindTargetCandidatesArgs): Promise<readonly SymbolTargetCandidate[]> {
    args.declarationIndex.ensureFiles(args.files);
    const candidates: SymbolTargetCandidate[] = [];
    for (const file of args.files) {
      for (const symbol of args.declarationIndex.declarationsIn(file.relative) ?? []) {
        if (!SymbolTargetGrammar.matches(args.pattern, symbol.identity)) continue;
        candidates.push({
          symbol,
          canonicalId: formatSymbolIdentity(symbol.identity),
          header: symbol.header,
        });
      }
    }
    return candidates;
  }
}
