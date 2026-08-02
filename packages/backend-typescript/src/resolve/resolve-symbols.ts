import type {
  FileSystem,
  ResolveSymbolsOptions,
  ResolvedPath,
  SymbolOverviewNode,
} from "@symnav/core";
import { formatSymbolIdentity, OverviewTree } from "@symnav/core";
import fuzzysort from "fuzzysort";

import { loadFileEntries } from "../extract/load-file-entries.js";

export interface ResolveSymbolsArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly query: string;
  readonly options: ResolveSymbolsOptions;
}

export class SymbolResolver {
  static async resolveSymbols(args: ResolveSymbolsArgs): Promise<readonly SymbolOverviewNode[]> {
    const candidates = SymbolResolver.extractAllSymbols(args.fs, args.files);
    if (args.options.mode === "fuzzy") {
      return SymbolResolver.fuzzyMatch(candidates, args.query);
    }
    if (args.options.mode === "regex") {
      return SymbolResolver.regexMatch(candidates, args.options.regex);
    }
    return SymbolResolver.exactMatch(candidates, args.query);
  }

  private static extractAllSymbols(
    fs: FileSystem,
    files: readonly ResolvedPath[],
  ): readonly SymbolOverviewNode[] {
    const all: SymbolOverviewNode[] = [];
    for (const file of files) {
      all.push(...OverviewTree.walkSymbols(loadFileEntries(fs, file).entries));
    }
    return all;
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
