import type { PageRequest, RefsResult } from "@symnav/core";
import { RefsResultBuilder, SymbolTargetResolver } from "@symnav/core";
import { SymbolTargetErrorRenderer, renderRefsJson, renderRefsText } from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { NavigationDiagnosticsCollector } from "../navigation-diagnostics-collector.js";

export interface RefsArgs {
  readonly target: string;
  readonly line: number | string | undefined;
  readonly regex: boolean;
  readonly page: number | undefined;
  readonly pageSize: number | undefined;
  readonly all: boolean;
  readonly fullLines: boolean;
}

export const refsCommand: Command<RefsResult, RefsArgs> = {
  name: "refs",
  validate(args: RefsArgs) {
    SymbolTargetResolver.validateRequest({
      rawTarget: args.target,
      line: args.line,
      regex: args.regex,
    });
  },
  describeArgs(args: RefsArgs) {
    return {
      kind: classifyArgKind(args.target),
      lengthBucket: lengthBucketOf(args.target),
      flags: refsFlags(args),
    };
  },
  countResults(result: RefsResult) {
    return {
      total: result.total,
      page: result.references.length,
      pages: result.pageCount,
    };
  },
  async compute(ctx: CommandContext<RefsArgs>): Promise<RefsResult> {
    const resolved = await SymbolTargetResolver.resolve({
      workspace: ctx.workspace,
      router: ctx.router,
      cwd: ctx.cwd,
      rawTarget: ctx.args.target,
      line: ctx.args.line,
      regex: ctx.args.regex,
    });
    const references = await resolved.backend.findReferences(resolved.files, resolved.identity);
    const result = new RefsResultBuilder({
      identity: resolved.identity,
      references,
      pageRequest: pageRequestFrom(ctx.args),
      fullLines: ctx.args.fullLines,
    }).build();
    return NavigationDiagnosticsCollector.attach(result, ctx.workspace, ctx.router);
  },
  renderText: renderRefsText,
  renderJson: renderRefsJson,
  renderError: SymbolTargetErrorRenderer.render,
};

function pageRequestFrom(args: RefsArgs): PageRequest {
  return {
    ...(args.page !== undefined && { page: args.page }),
    ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
    all: args.all,
  };
}

function refsFlags(args: RefsArgs): string[] {
  return [
    ...(args.all ? ["all"] : []),
    ...(args.fullLines ? ["full-lines"] : []),
    ...(args.line !== undefined ? ["line"] : []),
    ...(args.page !== undefined ? ["page"] : []),
    ...(args.pageSize !== undefined ? ["page-size"] : []),
    ...(args.regex ? ["regex"] : []),
  ].sort();
}
