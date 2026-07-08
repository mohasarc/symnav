import type { DefinitionResult } from "@symnav/core";
import {
  SymbolTargetErrorRenderer,
  renderDefinitionJson,
  renderDefinitionText,
} from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { collectNavigationDiagnostics } from "../collect-navigation-diagnostics.js";
import { CommandTargetResolver } from "../resolve-symbol-target.js";

export interface DefArgs {
  readonly target: string;
  readonly line: number | string | undefined;
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
  diagnostics(result: DefinitionResult) {
    return result.diagnostics ?? [];
  },
  async compute(ctx: CommandContext<DefArgs>): Promise<DefinitionResult> {
    const resolved = await CommandTargetResolver.resolve({
      workspace: ctx.workspace,
      router: ctx.router,
      cwd: ctx.cwd,
      rawTarget: ctx.args.target,
      line: ctx.args.line,
    });
    const symbols = await resolved.backend.findDefinitions(resolved.files, resolved.identity);
    const diagnostics = await collectNavigationDiagnostics(ctx.workspace, ctx.router);
    return { identity: resolved.identity, symbols, ...(diagnostics.length > 0 && { diagnostics }) };
  },
  renderText: renderDefinitionText,
  renderJson: renderDefinitionJson,
  renderError: SymbolTargetErrorRenderer.render,
};
