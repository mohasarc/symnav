import {
  InvalidResolveRegexError,
  type FileSystem,
  type ResolveSymbolsOptions,
  type ResolvedPath,
  type SymbolOverviewNode,
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

export async function resolveSymbols(args: ResolveSymbolsArgs): Promise<readonly SymbolOverviewNode[]> {
  const candidates = extractAllSymbols(args.fs, args.files);
  if (args.options.mode === "fuzzy") {
    return fuzzyMatch(candidates, args.query);
  }
  if (args.options.mode === "regex") {
    return regexMatch(candidates, args.query);
  }
  return exactMatch(candidates, args.query);
}

function extractAllSymbols(fs: FileSystem, files: readonly ResolvedPath[]): readonly SymbolOverviewNode[] {
  const all: SymbolOverviewNode[] = [];
  for (const file of files) {
    all.push(...OverviewTree.walkSymbols(loadFileEntries(fs, file).entries));
  }
  return all;
}

function exactMatch(candidates: readonly SymbolOverviewNode[], query: string): readonly SymbolOverviewNode[] {
  return candidates.filter(
    (decl) => OverviewTree.ownName(decl) === query || formatSymbolIdentity(decl.identity) === query,
  );
}

function fuzzyMatch(candidates: readonly SymbolOverviewNode[], query: string): readonly SymbolOverviewNode[] {
  const indexed = candidates.map((decl) => ({ decl, name: OverviewTree.ownName(decl) }));
  const results = fuzzysort.go(query, indexed, { key: "name" });
  return results.map((result) => result.obj.decl);
}

function regexMatch(candidates: readonly SymbolOverviewNode[], query: string): readonly SymbolOverviewNode[] {
  const regex = compileRegex(query);
  return candidates.filter((decl) => regex.test(OverviewTree.ownName(decl)));
}

function compileRegex(query: string): RegExp {
  try {
    return new RegExp(query);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new InvalidResolveRegexError(query, reason);
  }
}
