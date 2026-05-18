import type { OverviewFileSymbols } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { Command, CommandContext } from "../../command.js";

export interface OverviewArgs {
  readonly file: string;
}

export const overviewCommand: Command<OverviewFileSymbols, OverviewArgs> = {
  async compute(ctx: CommandContext<OverviewArgs>): Promise<OverviewFileSymbols> {
    const path = await ctx.workspace.resolveInputPath(ctx.args.file, ctx.cwd);
    const backend = ctx.router.findOrThrow(path.relative);
    return backend.fileSymbols(path);
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
};
