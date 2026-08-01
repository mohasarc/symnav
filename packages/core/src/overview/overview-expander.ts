import type {
  OverviewFileEntries,
  OverviewNode,
} from "../intermediate-representation/overview-tree.js";
import type { LineRange } from "../intermediate-representation/types.js";
import { formatSymbolPath } from "../intermediate-representation/canonical-identity.js";
import {
  AmbiguousLineTargetError,
  AmbiguousOverviewTargetError,
  type OverviewExpansionCandidate,
  type OverviewExpansionRequest,
  type OverviewExpansionResult,
  OverviewTargetNotFoundError,
} from "./overview-query.js";

export interface ExpandOverviewArgs {
  readonly file: OverviewFileEntries;
  readonly request: OverviewExpansionRequest;
}

export class OverviewExpander {
  private readonly file: OverviewFileEntries;
  private readonly request: OverviewExpansionRequest;

  constructor(args: ExpandOverviewArgs) {
    this.file = args.file;
    this.request = args.request;
  }

  expand(): OverviewExpansionResult {
    const entries =
      this.request.at === undefined && this.request.line === undefined
        ? OverviewExpander.expandNodes(this.file.entries, this.request.depth)
        : [OverviewExpander.expandNode(this.selectTarget().node, this.request.depth)];

    const result: OverviewExpansionResult = {
      file: this.file.file,
      entries,
      request: this.request,
    };
    if (this.file.diagnostics === undefined) return result;
    return { ...result, diagnostics: this.file.diagnostics };
  }

  private selectTarget(): OverviewExpansionCandidate {
    const candidates = OverviewExpander.collectCandidates(this.file.entries).filter((candidate) =>
      this.matchesRequest(candidate),
    );

    if (candidates.length === 0) {
      throw new OverviewTargetNotFoundError(this.request);
    }
    if (candidates.length === 1) {
      return candidates[0]!;
    }
    if (this.request.at === undefined && this.request.line !== undefined) {
      throw new AmbiguousLineTargetError(this.request.line, candidates);
    }
    throw new AmbiguousOverviewTargetError(candidates);
  }

  private matchesRequest(candidate: OverviewExpansionCandidate): boolean {
    return this.matchesAt(candidate) && this.matchesLine(candidate.range);
  }

  private matchesAt(candidate: OverviewExpansionCandidate): boolean {
    const at = this.request.at;
    return (
      at === undefined ||
      OverviewExpander.searchableHeaders(candidate.header).some((header) => header.includes(at))
    );
  }

  private matchesLine(range: LineRange): boolean {
    const line = this.request.line;
    return line === undefined || (range.startLine <= line && line <= range.endLine);
  }

  private static expandNodes(
    nodes: readonly OverviewNode[],
    remainingFoldDepth: number,
  ): readonly OverviewNode[] {
    return nodes.map((node) => OverviewExpander.expandNode(node, remainingFoldDepth));
  }

  private static expandNode(node: OverviewNode, remainingFoldDepth: number): OverviewNode {
    if (node.type === "re-export") {
      return node;
    }
    if (node.type === "fold") {
      if (remainingFoldDepth <= 0) {
        return { ...node, children: [] };
      }
      return {
        ...node,
        children: OverviewExpander.expandNodes(node.children, remainingFoldDepth - 1),
      };
    }
    return { ...node, children: OverviewExpander.expandNodes(node.children, remainingFoldDepth) };
  }

  private static collectCandidates(
    nodes: readonly OverviewNode[],
  ): readonly OverviewExpansionCandidate[] {
    const candidates: OverviewExpansionCandidate[] = [];
    for (const node of nodes) {
      OverviewExpander.collectCandidate(node, candidates);
    }
    return candidates;
  }

  private static collectCandidate(
    node: OverviewNode,
    candidates: OverviewExpansionCandidate[],
  ): void {
    candidates.push({
      header: OverviewExpander.headerFor(node),
      range: node.range,
      node,
    });
    if (node.type === "re-export") {
      return;
    }
    for (const child of node.children) {
      OverviewExpander.collectCandidate(child, candidates);
    }
  }

  private static headerFor(node: OverviewNode): string {
    return `${OverviewExpander.formatRange(node.range)}: ${OverviewExpander.labelFor(node)}`;
  }

  private static labelFor(node: OverviewNode): string {
    if (node.type === "symbol") return formatSymbolPath(node.identity.segments);
    return node.header.lines[0] ?? "";
  }

  private static formatRange(range: LineRange): string {
    if (range.startLine === range.endLine) return `${range.startLine}`;
    return `${range.startLine}-${range.endLine}`;
  }

  private static searchableHeaders(header: string): readonly string[] {
    const callbackTail = ", () => {";
    if (!header.endsWith(callbackTail)) return [header];
    return [header, `${header.slice(0, -callbackTail.length)})`];
  }
}
