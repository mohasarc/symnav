import {
  Node,
  type CallExpression,
  type NewExpression,
  type ReferencedSymbolEntry,
  type SourceFile,
} from "ts-morph";
import type {
  CallEdge,
  CallSite,
  EdgeConfidence,
  FileSystem,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
} from "@symnav/core";

import { DeclarationLocator } from "../identity/locate-declarations.js";
import { WorkspaceDeclarationIndex } from "../identity/workspace-declaration-index.js";

const DYNAMIC_DISPATCH_REASON = "dynamic dispatch: call target not statically resolvable";

export interface FindCallersArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findCallers(args: FindCallersArgs): Promise<readonly CallEdge[]> {
  return new CallerFinder(args).find();
}

interface CallPosition {
  readonly confidence: EdgeConfidence;
  readonly reason?: string;
}

class CallerFinder {
  private readonly index: WorkspaceDeclarationIndex;

  constructor(private readonly args: FindCallersArgs) {
    this.index = new WorkspaceDeclarationIndex(args);
  }

  find(): readonly CallEdge[] {
    const declarationNodes = this.targetDeclarationNodes();
    if (declarationNodes.length === 0) return [];
    return this.edgesFrom(declarationNodes);
  }

  private targetDeclarationNodes(): readonly Node[] {
    return this.index.locate(this.args.identity).map((located) => located.node);
  }

  private edgesFrom(declarationNodes: readonly Node[]): readonly CallEdge[] {
    const edgesByKey = new Map<string, MutableEdge>();
    const seenReferences = new Set<string>();
    for (const declarationNode of declarationNodes) {
      for (const referenceNode of this.referenceNodesOf(declarationNode)) {
        this.addCallerEdge(referenceNode, edgesByKey, seenReferences);
      }
    }
    return [...edgesByKey.values()].map(finalizeEdge).sort(compareEdges);
  }

  private addCallerEdge(
    referenceNode: Node,
    edgesByKey: Map<string, MutableEdge>,
    seenReferences: Set<string>,
  ): void {
    const callPosition = callPositionOf(referenceNode);
    if (!callPosition) return;
    const site = this.siteFor(referenceNode);
    const dedupeKey = `${site.file}:${site.line}:${site.matchStart}`;
    if (seenReferences.has(dedupeKey)) return;
    seenReferences.add(dedupeKey);
    const caller = this.enclosingSymbolOf(referenceNode);
    if (!caller) return;
    const key = `${DeclarationLocator.identityKey(caller.identity)}#${callPosition.confidence}`;
    const existing = edgesByKey.get(key);
    if (existing) {
      existing.sites.push(site);
      return;
    }
    edgesByKey.set(key, {
      symbol: caller,
      confidence: callPosition.confidence,
      reason: callPosition.reason,
      sites: [site],
    });
  }

  private referenceNodesOf(declarationNode: Node): readonly Node[] {
    if (!Node.isReferenceFindable(declarationNode)) return [];
    return declarationNode
      .findReferences()
      .flatMap((referencedSymbol) => referencedSymbol.getReferences())
      .filter((entry) => !entry.isDefinition())
      .map((entry: ReferencedSymbolEntry) => entry.getNode());
  }

  private enclosingSymbolOf(referenceNode: Node): SymbolOverviewNode | undefined {
    let ancestor = referenceNode.getParent();
    let nearestValue: SymbolDecl | undefined;
    while (ancestor) {
      const declaration = this.index.declarationAt(ancestor);
      if (declaration) {
        if (declaration.kind.role !== "value") return declaration;
        nearestValue = declaration;
      }
      ancestor = ancestor.getParent();
    }
    return nearestValue;
  }

  private siteFor(node: Node): CallSite {
    const sourceFile = node.getSourceFile();
    const relative = this.index.relativePathOf(sourceFile) ?? "";
    const { line, character } = sourceFile.compilerNode.getLineAndCharacterOfPosition(
      node.getStart(),
    );
    return {
      file: relative,
      line: line + 1,
      previewSource: lineText(sourceFile, line),
      matchStart: character,
      matchEnd: character + node.getWidth(),
    };
  }
}

interface MutableEdge {
  symbol: SymbolOverviewNode;
  confidence: EdgeConfidence;
  reason: string | undefined;
  sites: CallSite[];
}

function callPositionOf(referenceNode: Node): CallPosition | undefined {
  const call = nearestCall(referenceNode);
  if (!call) return undefined;
  const expression = call.getExpression();
  if (!containsNode(expression, referenceNode)) return undefined;
  if (calleeNameNode(expression) === referenceNode) return { confidence: "certain" };
  return { confidence: "possible", reason: DYNAMIC_DISPATCH_REASON };
}

function nearestCall(node: Node): CallExpression | NewExpression | undefined {
  let ancestor = node.getParent();
  while (ancestor) {
    if (Node.isCallExpression(ancestor) || Node.isNewExpression(ancestor)) return ancestor;
    ancestor = ancestor.getParent();
  }
  return undefined;
}

function containsNode(container: Node, node: Node): boolean {
  return (
    container.getSourceFile() === node.getSourceFile() &&
    node.getStart() >= container.getStart() &&
    node.getEnd() <= container.getEnd()
  );
}

function calleeNameNode(expression: Node): Node | undefined {
  if (Node.isIdentifier(expression)) return expression;
  if (Node.isPropertyAccessExpression(expression)) return expression.getNameNode();
  return undefined;
}

function finalizeEdge(edge: MutableEdge): CallEdge {
  return {
    symbol: edge.symbol,
    confidence: edge.confidence,
    ...(edge.reason === undefined ? {} : { reason: edge.reason }),
    sites: [...edge.sites].sort(compareSites),
  };
}

function compareSites(a: CallSite, b: CallSite): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

function compareEdges(a: CallEdge, b: CallEdge): number {
  const aIdentity = a.symbol.identity;
  const bIdentity = b.symbol.identity;
  if (aIdentity.file !== bIdentity.file) return aIdentity.file < bIdentity.file ? -1 : 1;
  if (a.symbol.range.startLine !== b.symbol.range.startLine) {
    return a.symbol.range.startLine - b.symbol.range.startLine;
  }
  const aKey = DeclarationLocator.identityKey(aIdentity);
  const bKey = DeclarationLocator.identityKey(bIdentity);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function lineText(sourceFile: SourceFile, zeroBasedLine: number): string {
  const fullText = sourceFile.getFullText();
  const lineStarts = sourceFile.compilerNode.getLineStarts();
  const start = lineStarts[zeroBasedLine] ?? 0;
  const end =
    zeroBasedLine + 1 < lineStarts.length ? lineStarts[zeroBasedLine + 1]! : fullText.length;
  return fullText.slice(start, end).replace(/\r?\n$/, "");
}
