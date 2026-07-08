import type { NavigationDiagnostic, OverviewExpansionResult } from "@symnav/core";
import { OverviewExpander, OverviewTree } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";

export interface OverviewArgs {
  readonly file: string;
  readonly depth: number;
  readonly at: string | undefined;
  readonly line: number | undefined;
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
    const path = await ctx.workspace.resolveInputPath(ctx.args.file, ctx.cwd);
    const backend = ctx.router.findOrThrow(path.relative);
    const file = await backend.fileEntries(path);
    return new OverviewExpander({
      file,
      request: {
        depth: ctx.args.depth,
        at: ctx.args.at,
        line: ctx.args.line,
      },
    }).expand();
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
};

function flagsFor(args: OverviewArgs): readonly string[] {
  const flags: string[] = [];
  if ((args.depth ?? 0) !== 0) flags.push("depth");
  if (args.at !== undefined) flags.push("at");
  if (args.line !== undefined) flags.push("line");
  return flags;
}
