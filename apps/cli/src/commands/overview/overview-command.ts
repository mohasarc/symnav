import type { NavigationDiagnostic, OverviewFileSymbols } from "@symnav/core";
import { walkOverviewSymbols } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";

export interface OverviewArgs {
  readonly file: string;
}

export const overviewCommand: Command<OverviewFileSymbols, OverviewArgs> = {
  name: "overview",
  describeArgs(args: OverviewArgs) {
    return {
      kind: classifyArgKind(args.file),
      lengthBucket: lengthBucketOf(args.file),
      flags: [],
    };
  },
  countResults(result: OverviewFileSymbols) {
    return { symbols: walkOverviewSymbols(result.entries).length };
  },
  diagnostics(result: OverviewFileSymbols): readonly NavigationDiagnostic[] {
    return result.diagnostics ?? [];
  },
  async compute(ctx: CommandContext<OverviewArgs>): Promise<OverviewFileSymbols> {
    const path = await ctx.workspace.resolveInputPath(ctx.args.file, ctx.cwd);
    const backend = ctx.router.findOrThrow(path.relative);
    return backend.fileSymbols(path);
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
};
