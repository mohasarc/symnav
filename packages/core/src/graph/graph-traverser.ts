import type { LanguageBackend } from "../backend/language-backend.js";
import type { CallEdge } from "../intermediate-representation/call-edge.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolDecl } from "../intermediate-representation/types.js";
import type { ResolvedPath } from "../workspace/workspace.js";
import type { GraphPath, GraphPathStep } from "./graph-path.js";

export interface GraphTraverserArgs {
  readonly backend: LanguageBackend;
  readonly files: readonly ResolvedPath[];
  readonly root: SymbolDecl;
  readonly depth: number;
}

type EdgeFinder = (
  files: readonly ResolvedPath[],
  identity: SymbolDecl["identity"],
) => Promise<readonly CallEdge[]>;

export class GraphTraverser {
  private readonly backend: LanguageBackend;
  private readonly files: readonly ResolvedPath[];
  private readonly root: SymbolDecl;
  private readonly depth: number;

  constructor(args: GraphTraverserArgs) {
    this.backend = args.backend;
    this.files = args.files;
    this.root = args.root;
    this.depth = args.depth;
  }

  async traverseIncoming(): Promise<readonly GraphPath[]> {
    return this.traverse((files, identity) => this.backend.findCallers(files, identity));
  }

  async traverseOutgoing(): Promise<readonly GraphPath[]> {
    return this.traverse((files, identity) => this.backend.findCallees(files, identity));
  }

  private async traverse(findEdges: EdgeFinder): Promise<readonly GraphPath[]> {
    const paths: GraphPath[] = [];
    const oneHopEdgesByIdentity = new Map<string, Promise<readonly CallEdge[]>>();
    await this.extend({
      current: this.root,
      steps: [],
      seen: new Set([formatSymbolIdentity(this.root.identity)]),
      paths,
      oneHopEdgesByIdentity,
      findEdges,
    });
    paths.sort(compareGraphPaths);
    return paths;
  }

  private async extend(args: {
    readonly current: SymbolDecl;
    readonly steps: readonly GraphPathStep[];
    readonly seen: ReadonlySet<string>;
    readonly paths: GraphPath[];
    readonly oneHopEdgesByIdentity: Map<string, Promise<readonly CallEdge[]>>;
    readonly findEdges: EdgeFinder;
  }): Promise<void> {
    const { current, steps, seen, paths, oneHopEdgesByIdentity, findEdges } = args;
    if (steps.length >= this.depth) {
      paths.push({ steps });
      return;
    }
    const edges = await this.findCollapsedEdges(current, oneHopEdgesByIdentity, findEdges);
    if (edges.length === 0) {
      if (steps.length > 0) {
        paths.push({ steps });
      }
      return;
    }
    for (const edge of edges) {
      const identity = formatSymbolIdentity(edge.symbol.identity);
      const closesCycle = seen.has(identity);
      const nextSteps = [...steps, toGraphPathStep(edge, closesCycle)];
      if (closesCycle) {
        paths.push({ steps: nextSteps });
        continue;
      }
      await this.extend({
        current: edge.symbol,
        steps: nextSteps,
        seen: new Set([...seen, identity]),
        paths,
        oneHopEdgesByIdentity,
        findEdges,
      });
    }
  }

  private async findCollapsedEdges(
    current: SymbolDecl,
    oneHopEdgesByIdentity: Map<string, Promise<readonly CallEdge[]>>,
    findEdges: EdgeFinder,
  ): Promise<readonly CallEdge[]> {
    const identity = formatSymbolIdentity(current.identity);
    const existingEdges = oneHopEdgesByIdentity.get(identity);
    if (existingEdges !== undefined) {
      return existingEdges;
    }
    const edges = findEdges(this.files, current.identity).then(collapseDuplicateEdges);
    oneHopEdgesByIdentity.set(identity, edges);
    return edges;
  }
}

function collapseDuplicateEdges(edges: readonly CallEdge[]): readonly CallEdge[] {
  const edgesByIdentity = new Map<string, CallEdge>();
  for (const edge of edges) {
    const identity = formatSymbolIdentity(edge.symbol.identity);
    const existingEdge = edgesByIdentity.get(identity);
    if (existingEdge === undefined || shouldReplaceEdge(existingEdge, edge)) {
      edgesByIdentity.set(identity, edge);
    }
  }
  return [...edgesByIdentity.values()];
}

function shouldReplaceEdge(existingEdge: CallEdge, nextEdge: CallEdge): boolean {
  return existingEdge.confidence === "possible" && nextEdge.confidence === "certain";
}

function toGraphPathStep(edge: CallEdge, closesCycle: boolean): GraphPathStep {
  return {
    symbol: edge.symbol,
    confidence: edge.confidence,
    ...(edge.confidence === "possible" && edge.reason !== undefined ? { reason: edge.reason } : {}),
    closesCycle,
  };
}

function compareGraphPaths(left: GraphPath, right: GraphPath): number {
  const lengthComparison = left.steps.length - right.steps.length;
  if (lengthComparison !== 0) {
    return lengthComparison;
  }
  for (let index = 0; index < left.steps.length; index += 1) {
    const leftIdentity = formatSymbolIdentity(left.steps[index]!.symbol.identity);
    const rightIdentity = formatSymbolIdentity(right.steps[index]!.symbol.identity);
    if (leftIdentity < rightIdentity) {
      return -1;
    }
    if (leftIdentity > rightIdentity) {
      return 1;
    }
  }
  return 0;
}
