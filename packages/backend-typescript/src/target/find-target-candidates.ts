import type { ResolvedPath, SymbolTargetCandidate, SymbolTargetQuery } from "@symnav/core";
import { formatSymbolIdentity, SymbolTargetGrammar } from "@symnav/core";

import type { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";

export interface FindTargetCandidatesArgs {
  readonly declarationIndex: WorkspaceDeclarationIndex;
  readonly files: readonly ResolvedPath[];
  readonly query: SymbolTargetQuery;
}

export class TargetCandidateFinder {
  static async find(args: FindTargetCandidatesArgs): Promise<readonly SymbolTargetCandidate[]> {
    args.declarationIndex.ensureFiles(args.files);
    const candidates: SymbolTargetCandidate[] = [];
    for (const file of args.files) {
      for (const symbol of args.declarationIndex.declarationsIn(file.relative) ?? []) {
        const canonicalId = formatSymbolIdentity(symbol.identity);
        if (!TargetCandidateFinder.matches(args.query, canonicalId, symbol.identity)) continue;
        candidates.push({
          symbol,
          canonicalId,
          header: symbol.header,
        });
      }
    }
    return candidates;
  }

  private static matches(
    query: SymbolTargetQuery,
    canonicalId: string,
    identity: SymbolTargetCandidate["symbol"]["identity"],
  ): boolean {
    if (query.mode === "regex") {
      return query.regex.test(canonicalId);
    }
    return SymbolTargetGrammar.match(query.pattern, identity) !== undefined;
  }
}
