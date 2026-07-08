import type {
  OverviewFileSymbols,
  OverviewNode,
} from "../intermediate-representation/overview-tree.js";
import type { LineRange } from "../intermediate-representation/types.js";
import type { SymbolPathSegment } from "../intermediate-representation/symbol-identity.js";
import {
  AmbiguousLineTargetError,
  AmbiguousOverviewTargetError,
  type OverviewExpansionCandidate,
  type OverviewExpansionRequest,
  type OverviewExpansionResult,
  OverviewTargetNotFoundError,
} from "./overview-query.js";

export interface ExpandOverviewArgs {
  readonly file: OverviewFileSymbols;
  readonly request: OverviewExpansionRequest;
}

export class OverviewExpander {
  readonly #file: OverviewFileSymbols;
  readonly #request: OverviewExpansionRequest;

  constructor(args: ExpandOverviewArgs) {
    this.#file = args.file;
    this.#request = args.request;
  }

  expand(): OverviewExpansionResult {
    const entries =
      this.#request.at === undefined && this.#request.line === undefined
        ? expandNodes(this.#file.entries, this.#request.depth)
        : [expandNode(this.selectTarget().node, this.#request.depth)];

    return {
      file: this.#file.file,
      entries,
      request: this.#request,
      diagnostics: this.#file.diagnostics,
    };
  }

  private selectTarget(): OverviewExpansionCandidate {
    const candidates = collectCandidates(this.#file.entries).filter((candidate) =>
      matchesRequest(candidate, this.#request),
    );

    if (candidates.length === 0) {
      throw new OverviewTargetNotFoundError(this.#request);
    }
    if (candidates.length === 1) {
      return candidates[0]!;
    }
    if (this.#request.at === undefined && this.#request.line !== undefined) {
      throw new AmbiguousLineTargetError(this.#request.line, candidates);
    }
    throw new AmbiguousOverviewTargetError(candidates);
  }
}

function expandNodes(
  nodes: readonly OverviewNode[],
  remainingFoldDepth: number,
): readonly OverviewNode[] {
  return nodes.map((node) => expandNode(node, remainingFoldDepth));
}

function expandNode(node: OverviewNode, remainingFoldDepth: number): OverviewNode {
  if (node.type === "fold") {
    if (remainingFoldDepth <= 0) {
      return { ...node, children: [] };
    }
    return { ...node, children: expandNodes(node.children, remainingFoldDepth - 1) };
  }
  return { ...node, children: expandNodes(node.children, remainingFoldDepth) };
}

function collectCandidates(nodes: readonly OverviewNode[]): readonly OverviewExpansionCandidate[] {
  const candidates: OverviewExpansionCandidate[] = [];
  for (const node of nodes) {
    collectCandidate(node, candidates);
  }
  return candidates;
}

function collectCandidate(
  node: OverviewNode,
  candidates: OverviewExpansionCandidate[],
): void {
  candidates.push({
    header: headerFor(node),
    range: node.range,
    node,
  });
  for (const child of node.children) {
    collectCandidate(child, candidates);
  }
}

function matchesRequest(
  candidate: OverviewExpansionCandidate,
  request: OverviewExpansionRequest,
): boolean {
  return matchesAt(candidate, request.at) && matchesLine(candidate.range, request.line);
}

function matchesAt(candidate: OverviewExpansionCandidate, at: string | undefined): boolean {
  return at === undefined || searchableHeaders(candidate.header).some((header) => header.includes(at));
}

function matchesLine(range: LineRange, line: number | undefined): boolean {
  return line === undefined || (range.startLine <= line && line <= range.endLine);
}

function headerFor(node: OverviewNode): string {
  return `${formatRange(node.range)}: ${labelFor(node)}`;
}

function labelFor(node: OverviewNode): string {
  if (node.type === "symbol") return formatSegments(node.identity.segments);
  return node.header.lines[0] ?? "";
}

function formatRange(range: LineRange): string {
  if (range.startLine === range.endLine) return `${range.startLine}`;
  return `${range.startLine}-${range.endLine}`;
}

function formatSegments(segments: readonly SymbolPathSegment[]): string {
  return segments.map(formatSegment).join("::");
}

function formatSegment(segment: SymbolPathSegment): string {
  if (segment.disambiguator === undefined) return segment.name;
  return `${segment.name}#${segment.disambiguator}`;
}

function searchableHeaders(header: string): readonly string[] {
  const callbackTail = ", () => {";
  if (!header.endsWith(callbackTail)) return [header];
  return [header, `${header.slice(0, -callbackTail.length)})`];
}
