import type { OverviewFileSymbols, SymbolDecl } from "@symnav/core";
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
    return { symbols: countSymbols(result.symbols) };
  },
  async compute(ctx: CommandContext<OverviewArgs>): Promise<OverviewFileSymbols> {
    const path = await ctx.workspace.resolveInputPath(ctx.args.file, ctx.cwd);
    const backend = ctx.router.findOrThrow(path.relative);
    return backend.fileSymbols(path);
  },
  renderText: renderOverviewText,
  renderJson: renderOverviewJson,
};

function countSymbols(symbols: readonly SymbolDecl[]): number {
  return symbols.reduce((total, symbol) => total + 1 + countSymbols(symbol.children), 0);
}
