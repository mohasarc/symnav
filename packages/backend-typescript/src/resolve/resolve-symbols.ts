import type { ResolveSymbolsOptions, ResolvedPath, SymbolOverviewNode } from "@symnav/core";
import { formatSymbolIdentity, OverviewTree } from "@symnav/core";
import fuzzysort from "fuzzysort";

import type { TypeScriptWorkspaceState } from "../typescript-backend/typescript-workspace-state.js";

export interface ResolveSymbolsArgs {
  readonly state: TypeScriptWorkspaceState;
  readonly files: readonly ResolvedPath[];
  readonly query: string;
  readonly options: ResolveSymbolsOptions;
}

export class SymbolResolver {
  static async resolveSymbols(args: ResolveSymbolsArgs): Promise<readonly SymbolOverviewNode[]> {
    const candidates = await args.state.declarations(args.files);
    if (args.options.mode === "fuzzy") {
      return SymbolResolver.fuzzyMatch(candidates, args.query);
    }
    if (args.options.mode === "regex") {
      return SymbolResolver.regexMatch(candidates, args.options.regex);
    }
    return SymbolResolver.exactMatch(candidates, args.query);
  }

  private static exactMatch(
    candidates: readonly SymbolOverviewNode[],
    query: string,
  ): readonly SymbolOverviewNode[] {
    return candidates.filter(
      (decl) =>
        OverviewTree.ownName(decl) === query || formatSymbolIdentity(decl.identity) === query,
    );
  }

  private static fuzzyMatch(
    candidates: readonly SymbolOverviewNode[],
    query: string,
  ): readonly SymbolOverviewNode[] {
    const indexed = candidates.map((decl) => ({ decl, name: OverviewTree.ownName(decl) }));
    const results = fuzzysort.go(query, indexed, { key: "name" });
    return results.map((result) => result.obj.decl);
  }

  private static regexMatch(
    candidates: readonly SymbolOverviewNode[],
    regex: RegExp,
  ): readonly SymbolOverviewNode[] {
    return candidates.filter((decl) => regex.test(OverviewTree.ownName(decl)));
  }
}
