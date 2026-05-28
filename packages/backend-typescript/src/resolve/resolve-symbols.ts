import type { FileSystem, ResolveSymbolsOptions, ResolvedPath, SymbolDecl } from "@symnav/core";
import fuzzysort from "fuzzysort";
import { Project } from "ts-morph";

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";

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
  const project = new Project({ fileSystem: new WorkspaceFileSystemHost(fs) });
  const all: SymbolDecl[] = [];
  for (const path of files) {
    if (!fs.existsSync(path.absolute) || fs.isDirectorySync(path.absolute)) continue;
    const sourceFile = project.addSourceFileAtPath(path.absolute);
    const { symbols } = extractFileSymbols({ sourceFile, filePath: path.relative });
    collectAll(symbols, all);
  }
  return all;
}

function collectAll(symbols: readonly SymbolDecl[], out: SymbolDecl[]): void {
  for (const symbol of symbols) {
    out.push(symbol);
    collectAll(symbol.children, out);
  }
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
