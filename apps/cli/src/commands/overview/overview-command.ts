import type { NavigationDiagnostic, OverviewExpansionResult } from "@symnav/core";
import { InvalidOverviewExpansionRequestError, OverviewExpander, OverviewTree } from "@symnav/core";
import { renderOverviewError, renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";

export interface OverviewArgs {
  readonly file: string;
  readonly depth: string | undefined;
  readonly at: string | undefined;
  readonly line: string | undefined;
}

export const overviewCommand: Command<OverviewExpansionResult, OverviewArgs> = {
  name: "overview",
  describeArgs(args: OverviewArgs) {
    return {
      kind: classifyArgKind(args.file),
      lengthBucket: lengthBucketOf(args.file),
      flags: flagsFor(args),
    };
  },
  countResults(result: OverviewExpansionResult) {
    return { symbols: OverviewTree.walkSymbols(result.entries).length };
  },
  diagnostics(result: OverviewExpansionResult): readonly NavigationDiagnostic[] {
    return result.diagnostics ?? [];
  },
  async compute(ctx: CommandContext<OverviewArgs>): Promise<OverviewExpansionResult> {
    const request = overviewRequestFrom(ctx.args);
    const path = await ctx.workspace.resolveInputPath(ctx.args.file, ctx.cwd);
    const backend = ctx.router.findOrThrow(path.relative);
    const file = await backend.fileEntries(path);
    return new OverviewExpander({
      file,
      request,
    }).expand();
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
  renderError: renderOverviewError,
};

function flagsFor(args: OverviewArgs): readonly string[] {
  const flags: string[] = [];
  if (args.depth !== undefined) flags.push("depth");
  if (args.at !== undefined) flags.push("at");
  if (args.line !== undefined) flags.push("line");
  return flags;
}

function overviewRequestFrom(args: OverviewArgs): {
  readonly depth: number;
  readonly at: string | undefined;
  readonly line: number | undefined;
} {
  return {
    depth: depthFrom(args.depth),
    at: args.at,
    line: lineFrom(args.line),
  };
}

function depthFrom(depth: OverviewArgs["depth"]): number {
  if (depth === undefined) return 0;
  const numericDepth = Number(depth);
  if (!Number.isInteger(numericDepth) || numericDepth < 0) {
    throw new InvalidOverviewExpansionRequestError(
      `depth must be a non-negative integer, got ${depth}`,
    );
  }
  return numericDepth;
}

function lineFrom(line: OverviewArgs["line"]): number | undefined {
  if (line === undefined) return undefined;
  const numericLine = Number(line);
  if (!Number.isInteger(numericLine) || numericLine <= 0) {
    throw new InvalidOverviewExpansionRequestError(`line must be a positive integer, got ${line}`);
  }
  return numericLine;
}
