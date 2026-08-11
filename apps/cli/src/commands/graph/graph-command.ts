import type { GraphDirection, GraphResult, PageRequest } from "@symnav/core";
import {
  DEFAULT_GRAPH_DEPTH,
  CommandTargetResolver,
  GraphDepthExceededError,
  GraphResultBuilder,
  GraphTraverser,
  InvalidGraphRequestError,
  MAX_GRAPH_DEPTH,
  isPositiveInteger,
} from "@symnav/core";
import { SymbolTargetErrorRenderer, renderGraphJson, renderGraphText } from "@symnav/renderer";

import type { Command, CommandContext } from "../../command.js";
import { classifyArgKind, lengthBucketOf } from "../../telemetry/arg-shape.js";
import { NavigationDiagnosticsCollector } from "../navigation-diagnostics-collector.js";
import { resolveCallTarget } from "../resolve-call-target.js";

export interface GraphArgs {
  readonly target: string;
  readonly line: number | string | undefined;
  readonly incoming: boolean;
  readonly outgoing: boolean;
  readonly depth: number | string | undefined;
  readonly page: number | undefined;
  readonly pageSize: number | undefined;
  readonly all: boolean;
}

export const graphCommand: Command<GraphResult, GraphArgs> = {
  name: "graph",
  describeArgs(args: GraphArgs) {
    return {
      kind: classifyArgKind(args.target),
      lengthBucket: lengthBucketOf(args.target),
      flags: graphFlags(args),
    };
  },
  countResults(result: GraphResult) {
    return {
      incomingPaths: result.incoming?.totalPathCount ?? 0,
      outgoingPaths: result.outgoing?.totalPathCount ?? 0,
      pages: result.pageCount,
    };
  },
  async compute(ctx: CommandContext<GraphArgs>): Promise<GraphResult> {
    const request = graphRequestFrom(ctx.args);
    const resolved = await CommandTargetResolver.resolve({
      workspace: ctx.workspace,
      router: ctx.router,
      cwd: ctx.cwd,
      rawTarget: ctx.args.target,
      line: ctx.args.line,
    });
    const identity = resolved.identity;
    const backend = resolved.backend;
    const root = await resolveCallTarget(backend, resolved.files, identity);
    const traverser = new GraphTraverser({
      backend,
      files: resolved.files,
      root,
      depth: request.depth,
    });
    const incomingPaths = includesIncoming(request.direction)
      ? await traverser.traverseIncoming()
      : [];
    const outgoingPaths = includesOutgoing(request.direction)
      ? await traverser.traverseOutgoing()
      : [];

    const result = new GraphResultBuilder({
      identity,
      root,
      depth: request.depth,
      direction: request.direction,
      incomingPaths,
      outgoingPaths,
      pageRequest: request.pageRequest,
    }).build();
    return NavigationDiagnosticsCollector.attach(result, ctx.workspace, ctx.router);
  },
  renderText: renderGraphText,
  renderJson: renderGraphJson,
  renderError: SymbolTargetErrorRenderer.render,
};

interface GraphRequest {
  readonly depth: number;
  readonly direction: GraphDirection;
  readonly pageRequest: PageRequest;
}

function graphRequestFrom(args: GraphArgs): GraphRequest {
  if (args.incoming && args.outgoing) {
    throw new InvalidGraphRequestError("--incoming cannot be combined with --outgoing");
  }
  const depth = depthFrom(args.depth);
  if (depth > MAX_GRAPH_DEPTH) {
    throw new GraphDepthExceededError(depth);
  }
  return {
    depth,
    direction: directionFrom(args),
    pageRequest: {
      ...(args.page !== undefined && { page: args.page }),
      ...(args.pageSize !== undefined && { pageSize: args.pageSize }),
      all: args.all,
    },
  };
}

function depthFrom(depth: GraphArgs["depth"]): number {
  if (depth === undefined) {
    return DEFAULT_GRAPH_DEPTH;
  }
  const numericDepth = typeof depth === "number" ? depth : Number(depth);
  if (!isPositiveInteger(numericDepth)) {
    throw new InvalidGraphRequestError(`depth must be a positive integer, got ${depth}`);
  }
  return numericDepth;
}

function directionFrom(args: GraphArgs): GraphDirection {
  if (args.incoming) {
    return "incoming";
  }
  if (args.outgoing) {
    return "outgoing";
  }
  return "both";
}

function includesIncoming(direction: GraphDirection): boolean {
  return direction === "incoming" || direction === "both";
}

function includesOutgoing(direction: GraphDirection): boolean {
  return direction === "outgoing" || direction === "both";
}

function graphFlags(args: GraphArgs): string[] {
  return [
    ...(args.all ? ["all"] : []),
    ...(args.depth !== undefined ? ["depth"] : []),
    ...(args.incoming ? ["incoming"] : []),
    ...(args.line !== undefined ? ["line"] : []),
    ...(args.outgoing ? ["outgoing"] : []),
    ...(args.page !== undefined ? ["page"] : []),
    ...(args.pageSize !== undefined ? ["page-size"] : []),
  ].sort();
}
