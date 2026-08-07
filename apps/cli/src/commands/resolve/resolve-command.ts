import { posix } from "node:path";

import type {
  LanguageBackend,
  ResolvedPath,
  ResolveResult,
  ResolveSymbolsMode,
  ResolveSymbolsOptions,
  SymbolOverviewNode,
} from "@symnav/core";
import { compileResolveRegex, NoSupportedFilesError } from "@symnav/core";
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

class ResolveComputation {
  static modeFrom(args: ResolveArgs): ResolveSymbolsMode {
    if (args.fuzzy && args.regex) {
      throw new ConflictingResolveFlagsError();
    }
    if (args.fuzzy) return "fuzzy";
    if (args.regex) return "regex";
    return "exact";
  }

  static symbolsOptionsFrom(mode: ResolveSymbolsMode, query: string): ResolveSymbolsOptions {
    if (mode === "regex") {
      return { mode: "regex", regex: compileResolveRegex(query) };
    }
    if (mode === "fuzzy") {
      return { mode: "fuzzy" };
    }
    return { mode: "exact" };
  }

  static flagsFrom(args: ResolveArgs): string[] {
    return [...(args.fuzzy ? ["fuzzy"] : []), ...(args.regex ? ["regex"] : [])].sort();
  }

  static groupFilesByBackend(
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

  static async collectSymbols(
    groups: ReadonlyMap<LanguageBackend, readonly ResolvedPath[]>,
    query: string,
    options: ResolveSymbolsOptions,
  ): Promise<SymbolOverviewNode[]> {
    const results: SymbolOverviewNode[] = [];
    for (const [backend, backendFiles] of groups) {
      const decls = await backend.resolveSymbols(backendFiles, query, options);
      results.push(...decls);
    }
    return results;
  }

  static sortSymbols(symbols: readonly SymbolOverviewNode[]): SymbolOverviewNode[] {
    return [...symbols].sort((a, b) => {
      if (a.identity.file !== b.identity.file) {
        return a.identity.file < b.identity.file ? -1 : 1;
      }
      return a.range.startLine - b.range.startLine;
    });
  }

  static matchFilesByBasename(
    files: readonly ResolvedPath[],
    query: string,
    options: ResolveSymbolsOptions,
  ): string[] {
    const indexed = files.map((file) => ({
      relative: file.relative,
      basename: ResolveComputation.stripExtension(posix.basename(file.relative)),
    }));
    if (options.mode === "regex") {
      const { regex } = options;
      return indexed
        .filter((entry) => regex.test(entry.basename))
        .map((entry) => entry.relative)
        .sort(ResolveComputation.compareStringsAscending);
    }
    if (options.mode === "fuzzy") {
      const ranked = fuzzysort.go(query, indexed, { key: "basename" });
      return ranked
        .map((result) => result.obj.relative)
        .sort(ResolveComputation.compareStringsAscending);
    }
    return indexed
      .filter((entry) => entry.basename === query)
      .map((entry) => entry.relative)
      .sort(ResolveComputation.compareStringsAscending);
  }

  private static compareStringsAscending(a: string, b: string): number {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }

  private static stripExtension(name: string): string {
    const dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }
}

export const resolveCommand: Command<ResolveResult, ResolveArgs> = {
  name: "resolve",
  describeArgs(args: ResolveArgs) {
    return {
      kind: classifyArgKind(args.query),
      lengthBucket: lengthBucketOf(args.query),
      flags: ResolveComputation.flagsFrom(args),
    };
  },
  countResults(result: ResolveResult) {
    return { symbols: result.symbols.length, files: result.files.length };
  },
  async compute(ctx: CommandContext<ResolveArgs>): Promise<ResolveResult> {
    const mode = ResolveComputation.modeFrom(ctx.args);
    const options = ResolveComputation.symbolsOptionsFrom(mode, ctx.args.query);
    const files = await ctx.workspace.enumerate();
    const groups = ResolveComputation.groupFilesByBackend(files, ctx.router);
    if (groups.size === 0) {
      throw new NoSupportedFilesError();
    }
    const symbols = await ResolveComputation.collectSymbols(groups, ctx.args.query, options);
    const sortedSymbols = ResolveComputation.sortSymbols(symbols);
    const matchingFiles = ResolveComputation.matchFilesByBasename(files, ctx.args.query, options);
    const symbolFiles = new Set(sortedSymbols.map((s) => s.identity.file));
    const filesSection = matchingFiles.filter((file) => !symbolFiles.has(file));
    return {
      query: ctx.args.query,
      mode,
      symbols: sortedSymbols,
      files: filesSection,
    };
  },
  renderText: renderResolveText,
  renderJson: renderResolveJson,
  renderError: ResolveErrorRenderer.render,
};
