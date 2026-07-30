import type { NavigationDiagnostic, OverviewFileEntries } from "@symnav/core";
import { OverviewTree } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";

export interface OverviewArgs {
  readonly file: string;
}

export const overviewCommand: Command<OverviewFileEntries, OverviewArgs> = {
  name: "overview",
  describeArgs(args: OverviewArgs) {
    return {
      kind: classifyArgKind(args.file),
      lengthBucket: lengthBucketOf(args.file),
      flags: [],
    };
  },
  countResults(result: OverviewFileEntries) {
    return { symbols: OverviewTree.walkSymbols(result.entries).length };
  },
  diagnostics(result: OverviewFileEntries): readonly NavigationDiagnostic[] {
    return result.diagnostics ?? [];
  },
  async compute(ctx: CommandContext<OverviewArgs>): Promise<OverviewFileEntries> {
    const path = await ctx.workspace.resolveInputPath(ctx.args.file, ctx.cwd);
    const backend = ctx.router.findOrThrow(path.relative);
    return backend.fileEntries(path);
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
};
