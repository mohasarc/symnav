import type { DefinitionResult, DefinitionSymbol, SymbolOverviewNode } from "@symnav/core";
import { DefinitionSourceReader, SymbolTargetResolver } from "@symnav/core";
import {
  SymbolTargetErrorRenderer,
  renderDefinitionJson,
  renderDefinitionText,
} from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { NavigationDiagnosticsCollector } from "../navigation-diagnostics-collector.js";

export interface DefArgs {
  readonly target: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
  readonly source: boolean;
}

class DefinitionSourceAttachment {
  static async attach(
    symbols: readonly SymbolOverviewNode[],
    ctx: CommandContext<DefArgs>,
  ): Promise<readonly DefinitionSymbol[]> {
    const reader = new DefinitionSourceReader(ctx.fileSystem);
    return Promise.all(
      symbols.map(async (symbol) => {
        const path = await ctx.workspace.resolveInputPath(symbol.identity.file, ctx.workspace.root);
        return { ...symbol, source: await reader.read(path, symbol.range) };
      }),
    );
  }
}

export const defCommand: Command<DefinitionResult, DefArgs> = {
  name: "def",
  validate(args: DefArgs) {
    SymbolTargetResolver.validateRequest({
      rawTarget: args.target,
      line: args.line,
      regex: args.regex,
    });
  },
  describeArgs(args: DefArgs) {
    return {
      kind: classifyArgKind(args.target),
      lengthBucket: lengthBucketOf(args.target),
      flags: [
        ...(args.line === undefined ? [] : ["line"]),
        ...(args.regex ? ["regex"] : []),
        ...(args.source ? ["source"] : []),
      ].sort(),
    };
  },
  countResults(result: DefinitionResult) {
    return { definitions: result.symbols.length };
  },
  async compute(ctx: CommandContext<DefArgs>): Promise<DefinitionResult> {
    const resolved = await SymbolTargetResolver.resolve({
      workspace: ctx.workspace,
      router: ctx.router,
      cwd: ctx.cwd,
      rawTarget: ctx.args.target,
      line: ctx.args.line,
      regex: ctx.args.regex,
    });
    const definitions = await resolved.backend.findDefinitions(resolved.files, resolved.identity);
    const symbols = ctx.args.source
      ? await DefinitionSourceAttachment.attach(definitions, ctx)
      : definitions;
    const result: DefinitionResult = { identity: resolved.identity, symbols };
    return NavigationDiagnosticsCollector.attach(result, ctx.workspace, ctx.router);
  },
  renderText: renderDefinitionText,
  renderJson: renderDefinitionJson,
  renderError: SymbolTargetErrorRenderer.render,
};
