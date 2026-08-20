import type {
  OverviewFileEntries,
  OverviewNode,
} from "../intermediate-representation/overview-tree.js";
import { OverviewTree } from "../intermediate-representation/overview-tree.js";
import type { LineRange } from "../intermediate-representation/types.js";
import { formatSymbolPath } from "../intermediate-representation/canonical-identity.js";
import { isPositiveInteger } from "../validation/is-positive-integer.js";
import {
  AmbiguousLineTargetError,
  AmbiguousOverviewTargetError,
  InvalidOverviewExpansionRequestError,
  OverviewTargetNotFoundError,
} from "./errors.js";
import type {
  OverviewExpansionCandidate,
  OverviewExpansionRequest,
  OverviewExpansionResult,
} from "./overview-expansion-result.js";

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
    this.validateRequest();
  }

  private validateRequest(): void {
    const { depth, line } = this.request;
    if (!Number.isInteger(depth) || depth < 0) {
      throw new InvalidOverviewExpansionRequestError(
        `depth must be a non-negative integer, got ${depth}`,
      );
    }
    if (line !== undefined && !isPositiveInteger(line)) {
      throw new InvalidOverviewExpansionRequestError(
        `line must be a positive integer, got ${line}`,
      );
    }
  }

  expand(): OverviewExpansionResult {
    const entries =
      this.request.at === undefined && this.request.line === undefined
        ? OverviewExpander.trimNodes(this.file.entries, this.request.depth)
        : [OverviewExpander.trimNode(this.selectTarget().node, this.request.depth)];

    const result: OverviewExpansionResult = {
      file: this.file.file,
      entries,
      request: this.request,
      totalSymbolCount: OverviewTree.walkSymbols(this.file.entries).length,
    };
    if (this.file.diagnostics === undefined) return result;
    return { ...result, diagnostics: this.file.diagnostics };
  }

  private selectTarget(): OverviewExpansionCandidate {
    const candidates = this.exactLabelCandidates(this.matchingCandidates());

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

  private matchingCandidates(): readonly OverviewExpansionCandidate[] {
    return OverviewExpander.collectCandidates(this.file.entries).filter((candidate) =>
      this.matchesRequest(candidate),
    );
  }

  private exactLabelCandidates(
    candidates: readonly OverviewExpansionCandidate[],
  ): readonly OverviewExpansionCandidate[] {
    const at = this.request.at;
    if (at === undefined) return candidates;

    const exactCandidates = candidates.filter((candidate) =>
      OverviewExpander.targetLabels(candidate.node).includes(at),
    );
    return exactCandidates.length === 0 ? candidates : exactCandidates;
  }

  private matchesRequest(candidate: OverviewExpansionCandidate): boolean {
    return this.matchesAt(candidate) && this.matchesLine(candidate.range);
  }

  private matchesAt(candidate: OverviewExpansionCandidate): boolean {
    const at = this.request.at;
    return (
      at === undefined ||
      OverviewExpander.searchableTexts(candidate.node).some((text) => text.includes(at))
    );
  }

  private matchesLine(range: LineRange): boolean {
    const line = this.request.line;
    return line === undefined || (range.startLine <= line && line <= range.endLine);
  }

  private static trimNodes(
    nodes: readonly OverviewNode[],
    remainingChildLevels: number,
  ): readonly OverviewNode[] {
    return nodes.map((node) => OverviewExpander.trimNode(node, remainingChildLevels));
  }

  private static trimNode(node: OverviewNode, remainingChildLevels: number): OverviewNode {
    if (node.type === "re-export") {
      return node;
    }
    if (remainingChildLevels <= 0) {
      return { ...node, children: [] };
    }
    return {
      ...node,
      children: OverviewExpander.trimNodes(node.children, remainingChildLevels - 1),
    };
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

  private static targetLabels(node: OverviewNode): readonly string[] {
    const label = OverviewExpander.labelFor(node);
    if (node.type !== "fold") return [label];
    return [label, ...(node.headerVariants ?? [])];
  }

  private static formatRange(range: LineRange): string {
    if (range.startLine === range.endLine) return `${range.startLine}`;
    return `${range.startLine}-${range.endLine}`;
  }

  private static searchableTexts(node: OverviewNode): readonly string[] {
    const header = OverviewExpander.headerFor(node);
    if (node.type !== "fold" || node.headerVariants === undefined) return [header];
    return [
      header,
      ...node.headerVariants.map(
        (variant) => `${OverviewExpander.formatRange(node.range)}: ${variant}`,
      ),
    ];
  }
}
