import type { OverviewFileSymbols } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { Command, CommandContext } from "../../command.js";

export const overviewCommand: Command<OverviewFileSymbols> = {
  compute(ctx: CommandContext): Promise<OverviewFileSymbols> {
    return ctx.backend.fileSymbols(ctx.path);
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
};
