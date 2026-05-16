import type { FileSymbols } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { Command, CommandContext } from "../../command.js";

export const overviewCommand: Command<FileSymbols> = {
  compute(ctx: CommandContext): Promise<FileSymbols> {
    return ctx.backend.fileSymbols(ctx.path);
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
};
