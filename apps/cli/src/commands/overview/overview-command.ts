import { type FileSymbols, UnsupportedFileError } from "@symnav/core";
import { renderOverviewJson, renderOverviewText } from "@symnav/renderer";
import { Command, type CommandContext } from "../../command.js";

export class OverviewCommand extends Command<FileSymbols> {
  constructor(private readonly file: string) {
    super();
  }

  async compute(ctx: CommandContext): Promise<FileSymbols> {
    const path = await ctx.workspace.resolveInputPath(this.file, ctx.cwd);
    const backend = ctx.router.find(path.relative);
    if (backend === undefined) {
      throw new UnsupportedFileError(this.file);
    }
    return backend.fileSymbols(path);
  }

  renderText(result: FileSymbols): string {
    return renderOverviewText(result);
  }

  renderJson(result: FileSymbols): string {
    return renderOverviewJson(result);
  }
}
