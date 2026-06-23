import type { ContextResult, LanguageBackend, ResolvedPath, SymbolIdentity } from "@symnav/core";
import {
  AmbiguousSymbolError,
  ContextResultBuilder,
  DEFAULT_CONTEXT_CAP,
  SymbolNotFoundError,
  parseSymbolIdentity,
} from "@symnav/core";
import { renderContextJson, renderContextText } from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";

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
      callers: result.callers.edges.length,
      callees: result.callees.edges.length,
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
    const target = await resolveTarget(backend, accepted, identity);

    const definitions = await backend.findDefinitions(accepted, identity);
    const callers = await backend.findCallers(accepted, identity);
    const callees = await backend.findCallees(accepted, identity);
    const references = await backend.findReferences(accepted, identity);
    const history = await ctx.git.recentHistory({
      workspaceRoot: ctx.workspace.root,
      file: target.identity.file,
      range: target.range,
      limit: 5,
    });

    return new ContextResultBuilder({
      identity,
      target,
      definitions,
      callers,
      callees,
      references,
      history,
      cap: DEFAULT_CONTEXT_CAP,
    }).build();
  },
  renderText: renderContextText,
  renderJson: renderContextJson,
};

async function resolveTarget(
  backend: LanguageBackend,
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
) {
  const resolution = await backend.findCallTarget(files, identity);
  if (resolution.outcome === "not-found") {
    throw new SymbolNotFoundError(identity);
  }
  if (resolution.outcome === "ambiguous") {
    throw new AmbiguousSymbolError(identity, resolution.candidates);
  }
  return resolution.target;
}
