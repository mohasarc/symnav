import type {
  DefinitionResult,
  LanguageBackend,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
} from "@symnav/core";
import { renderDefinitionJson, renderDefinitionText } from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { resolveSymbolTargetForCommand } from "../resolve-symbol-target.js";

export interface DefArgs {
  readonly target: string;
  readonly line: number | undefined;
}

export const defCommand: Command<DefinitionResult, DefArgs> = {
  name: "def",
  describeArgs(args: DefArgs) {
    return {
      kind: classifyArgKind(args.target),
      lengthBucket: lengthBucketOf(args.target),
      flags: args.line === undefined ? [] : ["line"],
    };
  },
  countResults(result: DefinitionResult) {
    return { definitions: result.symbols.length };
  },
  async compute(ctx: CommandContext<DefArgs>): Promise<DefinitionResult> {
    const target = await resolveSymbolTargetForCommand({
      workspace: ctx.workspace,
      router: ctx.router,
      cwd: ctx.cwd,
      rawTarget: ctx.args.target,
      line: ctx.args.line,
    });
    const identity = target.identity;
    const files = await ctx.workspace.enumerate();
    const owningBackend = ctx.router.findOrThrow(identity.file);
    const symbols = await callOwningBackend(owningBackend, files, identity);
    return { identity, symbols };
  },
  renderText: renderDefinitionText,
  renderJson: renderDefinitionJson,
};

async function callOwningBackend(
  backend: LanguageBackend,
  files: readonly ResolvedPath[],
  identity: SymbolIdentity,
): Promise<readonly SymbolOverviewNode[]> {
  const accepted = files.filter((file) => backend.accepts(file.relative));
  return backend.findDefinitions(accepted, identity);
}
