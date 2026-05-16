import { type FileSymbols, UnsupportedFileError } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import type { Command, CommandContext } from "../../command.js";

export class OverviewCommand implements Command<FileSymbols> {
  constructor(private readonly file: string) {}

  async compute(ctx: CommandContext): Promise<FileSymbols> {
    const path = await ctx.workspace.resolveInputPath(this.file, ctx.cwd);
    const backend = ctx.router.find(path.relative);
    if (backend === undefined) {
      throw new UnsupportedFileError(this.file);
    }
    return backend.fileSymbols(path);
  }

  readonly renderText = renderOverviewText;
  readonly renderJson = renderOverviewJson;
}
