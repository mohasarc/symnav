import { posix } from "node:path";

import type {
  LanguageBackend,
  ResolvedPath,
  ResolveResult,
  ResolveSymbolsMode,
  SymbolOverviewNode,
} from "@symnav/core";
import { renderResolveJson, renderResolveText, ResolveErrorRenderer } from "@symnav/renderer";
import fuzzysort from "fuzzysort";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { ConflictingResolveFlagsError } from "./conflicting-resolve-flags-error.js";

export interface ResolveArgs {
  readonly query: string;
  readonly fuzzy: boolean;
  readonly regex: boolean;
}

export const resolveCommand: Command<ResolveResult, ResolveArgs> = {
  name: "resolve",
  describeArgs(args: ResolveArgs) {
    return {
      kind: classifyArgKind(args.query),
      lengthBucket: lengthBucketOf(args.query),
      flags: resolveFlags(args),
    };
  },
  countResults(result: ResolveResult) {
    return { symbols: result.symbols.length, files: result.files.length };
  },
  async compute(ctx: CommandContext<ResolveArgs>): Promise<ResolveResult> {
    const mode = resolveModeFrom(ctx.args);
    const files = await ctx.workspace.enumerate();
    const groups = groupFilesByBackend(files, ctx.router);
    const symbols = await collectSymbols(groups, ctx.args.query, mode);
    const sortedSymbols = sortSymbols(symbols);
    const matchingFiles = matchFilesByBasename(files, ctx.args.query, mode);
    const symbolFiles = new Set(sortedSymbols.map((s) => s.identity.file));
    const filesSection = matchingFiles.filter((file) => !symbolFiles.has(file));
    return {
      query: ctx.args.query,
      fuzzy: mode === "fuzzy",
      symbols: sortedSymbols,
      files: filesSection,
    };
  },
  renderText: renderResolveText,
  renderJson: renderResolveJson,
  renderError: ResolveErrorRenderer.render,
};

function resolveModeFrom(args: ResolveArgs): ResolveSymbolsMode {
  if (args.fuzzy && args.regex) {
    throw new ConflictingResolveFlagsError();
  }
  if (args.fuzzy) return "fuzzy";
  if (args.regex) return "regex";
  return "exact";
}

function resolveFlags(args: ResolveArgs): string[] {
  return [...(args.fuzzy ? ["fuzzy"] : []), ...(args.regex ? ["regex"] : [])].sort();
}

function groupFilesByBackend(
  files: readonly ResolvedPath[],
  router: CommandContext<ResolveArgs>["router"],
): Map<LanguageBackend, ResolvedPath[]> {
  const groups = new Map<LanguageBackend, ResolvedPath[]>();
  for (const file of files) {
    const backend = router.find(file.relative);
    if (!backend) continue;
    const bucket = groups.get(backend);
    if (bucket) {
      bucket.push(file);
    } else {
      groups.set(backend, [file]);
    }
  }
  return groups;
}

async function collectSymbols(
  groups: ReadonlyMap<LanguageBackend, readonly ResolvedPath[]>,
  query: string,
  mode: ResolveSymbolsMode,
): Promise<SymbolOverviewNode[]> {
  const results: SymbolOverviewNode[] = [];
  for (const [backend, backendFiles] of groups) {
    const decls = await backend.resolveSymbols(backendFiles, query, { mode });
    results.push(...decls);
  }
  return results;
}

function sortSymbols(symbols: readonly SymbolOverviewNode[]): SymbolOverviewNode[] {
  return [...symbols].sort((a, b) => {
    if (a.identity.file !== b.identity.file) {
      return a.identity.file < b.identity.file ? -1 : 1;
    }
    return a.range.startLine - b.range.startLine;
  });
}

function matchFilesByBasename(
  files: readonly ResolvedPath[],
  query: string,
  mode: ResolveSymbolsMode,
): string[] {
  const indexed = files.map((file) => ({
    relative: file.relative,
    basename: stripExtension(posix.basename(file.relative)),
  }));
  if (mode === "regex") {
    return [];
  }
  if (mode === "fuzzy") {
    const ranked = fuzzysort.go(query, indexed, { key: "basename" });
    return ranked.map((result) => result.obj.relative).sort(compareStringsAscending);
  }
  return indexed
    .filter((entry) => entry.basename === query)
    .map((entry) => entry.relative)
    .sort(compareStringsAscending);
}

function compareStringsAscending(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
