import type { ContextResult } from "@symnav/core";
import { ContextResultBuilder, DEFAULT_CONTEXT_CAP } from "@symnav/core";
import { SymbolTargetErrorRenderer, renderContextJson, renderContextText } from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { resolveCallTarget } from "../resolve-call-target.js";
import { resolveSymbolTargetForCommand } from "../resolve-symbol-target.js";

export interface ContextArgs {
  readonly target: string;
  readonly line: number | undefined;
}

export const contextCommand: Command<ContextResult, ContextArgs> = {
  name: "context",
  describeArgs(args: ContextArgs) {
    return {
      kind: classifyArgKind(args.target),
      lengthBucket: lengthBucketOf(args.target),
      flags: args.line === undefined ? [] : ["line"],
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
    const requestedTarget = await resolveSymbolTargetForCommand({
      workspace: ctx.workspace,
      router: ctx.router,
      cwd: ctx.cwd,
      rawTarget: ctx.args.target,
      containingLine: ctx.args.line,
    });
    const identity = requestedTarget.identity;
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
  renderError: SymbolTargetErrorRenderer.render,
};
