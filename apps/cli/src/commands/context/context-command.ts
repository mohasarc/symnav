import type { ContextResult } from "@symnav/core";
import { ContextResultBuilder, DEFAULT_CONTEXT_CAP, parseSymbolIdentity } from "@symnav/core";
import { renderContextJson, renderContextText } from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { resolveCallTarget } from "../resolve-call-target.js";

export interface ContextArgs {
  readonly symbolId: string;
}

export const contextCommand: Command<ContextResult, ContextArgs> = {
  name: "context",
  describeArgs(args: ContextArgs) {
    return {
      kind: classifyArgKind(args.symbolId),
      lengthBucket: lengthBucketOf(args.symbolId),
      flags: [],
    };
  },
  countResults(result: ContextResult) {
    return {
      callers: result.callers.sortedEdges.length,
      callees: result.callees.sortedEdges.length,
      references: result.references.total,
      history: result.history.length,
    };
  },
  async compute(ctx: CommandContext<ContextArgs>): Promise<ContextResult> {
    const identity = parseSymbolIdentity(ctx.args.symbolId);
    await ctx.workspace.resolveInputPath(identity.file, ctx.cwd);
    const files = await ctx.workspace.enumerate();
    const backend = ctx.router.findOrThrow(identity.file);
    const accepted = files.filter((file) => backend.accepts(file.relative));
    const target = await resolveCallTarget(backend, accepted, identity);

    const definitions = await backend.findDefinitions(accepted, identity);
    const callers = await backend.findCallers(accepted, target.identity);
    const callees = await backend.findCallees(accepted, target.identity);
    const references = await backend.findReferences(accepted, identity);
    const history = await ctx.git.recentHistory({
      workspaceRoot: ctx.workspace.root,
      workspaceRelativeFile: target.identity.file,
      range: target.range,
      limit: 5,
    });

    return new ContextResultBuilder({
      identity,
      target,
      definitions,
      callerEdgesWithAnyConfidence: callers,
      calleeEdgesWithAnyConfidence: callees,
      references,
      history,
      cap: DEFAULT_CONTEXT_CAP,
    }).build();
  },
  renderText: renderContextText,
  renderJson: renderContextJson,
};
