import type { DefinitionResult } from "@symnav/core";
import {
  SymbolTargetErrorRenderer,
  renderDefinitionJson,
  renderDefinitionText,
} from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { NavigationDiagnosticsCollector } from "../navigation-diagnostics-collector.js";
import { CommandTargetResolver } from "../resolve-symbol-target.js";

export interface DefArgs {
  readonly target: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
}

export const defCommand: Command<DefinitionResult, DefArgs> = {
  name: "def",
  describeArgs(args: DefArgs) {
    return {
      kind: classifyArgKind(args.target),
      lengthBucket: lengthBucketOf(args.target),
      flags: [
        ...(args.line === undefined ? [] : ["line"]),
        ...(args.regex ? ["regex"] : []),
      ].sort(),
    };
  },
  countResults(result: DefinitionResult) {
    return { definitions: result.symbols.length };
  },
  async compute(ctx: CommandContext<DefArgs>): Promise<DefinitionResult> {
    const resolved = await CommandTargetResolver.resolve({
      workspace: ctx.workspace,
      router: ctx.router,
      cwd: ctx.cwd,
      rawTarget: ctx.args.target,
      line: ctx.args.line,
      regex: ctx.args.regex,
    });
    const symbols = await resolved.backend.findDefinitions(resolved.files, resolved.identity);
    const result: DefinitionResult = { identity: resolved.identity, symbols };
    return NavigationDiagnosticsCollector.attach(result, ctx.workspace, ctx.router);
  },
  renderText: renderDefinitionText,
  renderJson: renderDefinitionJson,
  renderError: SymbolTargetErrorRenderer.render,
};
