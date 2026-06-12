import type { PageRequest, RefsResult } from "@symnav/core";
import { buildRefsResult, parseSymbolIdentity } from "@symnav/core";
import { renderRefsJson, renderRefsText } from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";

export interface RefsArgs {
  readonly symbolId: string;
  readonly page: number | undefined;
  readonly pageSize: number | undefined;
  readonly all: boolean;
  readonly fullLines: boolean;
}

export const refsCommand: Command<RefsResult, RefsArgs> = {
  async compute(ctx: CommandContext<RefsArgs>): Promise<RefsResult> {
    const identity = parseSymbolIdentity(ctx.args.symbolId);
    await ctx.workspace.resolveInputPath(identity.file, ctx.cwd);
    const files = await ctx.workspace.enumerate();
    const backend = ctx.router.findOrThrow(identity.file);
    const accepted = files.filter((file) => backend.accepts(file.relative));
    const references = await backend.findReferences(accepted, identity);
    return buildRefsResult({
      identity,
      references,
      pageRequest: pageRequestFrom(ctx.args),
      fullLines: ctx.args.fullLines,
    });
  },
  renderText: renderRefsText,
  renderJson: renderRefsJson,
};

function pageRequestFrom(args: RefsArgs): PageRequest {
  return {
    ...(args.page !== undefined && { page: args.page }),
    ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
    all: args.all,
  };
}
