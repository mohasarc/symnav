import type { FileSystem, ResolveSymbolsOptions, ResolvedPath, SymbolDecl } from "@symnav/core";
import { walkOverviewSymbols } from "@symnav/core";
import fuzzysort from "fuzzysort";

import { loadFileSymbols } from "../extract/load-file-symbols.js";

export interface ResolveSymbolsArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly query: string;
  readonly options: ResolveSymbolsOptions;
}

export async function resolveSymbols(args: ResolveSymbolsArgs): Promise<readonly SymbolDecl[]> {
  const candidates = extractAllSymbols(args.fs, args.files);
  if (args.options.fuzzy) {
    return fuzzyMatch(candidates, args.query);
  }
  return exactMatch(candidates, args.query);
}

function extractAllSymbols(fs: FileSystem, files: readonly ResolvedPath[]): readonly SymbolDecl[] {
  const all: SymbolDecl[] = [];
  for (const file of files) {
    all.push(...walkOverviewSymbols(loadFileSymbols(fs, file).entries));
  }
  return all;
}

function ownName(decl: SymbolDecl): string {
  const segment = decl.identity.segments[decl.identity.segments.length - 1];
  return segment?.name ?? "";
}

function exactMatch(candidates: readonly SymbolDecl[], query: string): readonly SymbolDecl[] {
  return candidates.filter((decl) => ownName(decl) === query);
}

function fuzzyMatch(candidates: readonly SymbolDecl[], query: string): readonly SymbolDecl[] {
  const indexed = candidates.map((decl) => ({ decl, name: ownName(decl) }));
  const results = fuzzysort.go(query, indexed, { key: "name" });
  return results.map((result) => result.obj.decl);
}
