import type { Node } from "ts-morph";
import type { DiagnosticSink } from "@symnav/core";

export interface ReportUnrecognisedNodeArgs {
  readonly sink: DiagnosticSink;
  readonly node: Node;
  readonly filePath: string;
  readonly category: "statement" | "member";
}

export function reportUnrecognisedNode(args: ReportUnrecognisedNodeArgs): void {
  const kind = args.node.getKindName();
  const line = args.node.getStartLineNumber();
  args.sink.report({
    severity: "warning",
    dedupeKey: `${args.filePath}:${args.category}:${kind}`,
    message: `skipped unrecognised ${args.category} syntax at ${args.filePath}:${line} (${kind})`,
  });
}
