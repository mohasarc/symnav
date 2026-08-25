import {
  Node,
  SyntaxKind,
  type CallExpression,
  type NewExpression,
  type ReferencedSymbolEntry,
  type SourceFile,
} from "ts-morph";
import type {
  CallEdge,
  CallSite,
  EdgeConfidence,
  ResolvedPath,
  SymbolOverviewNode,
  SymbolIdentity,
} from "@symnav/core";

import { DeclarationLocator } from "../identity/locate-declarations.js";
import type { TypeScriptWorkspaceState } from "../typescript-backend/typescript-workspace-state.js";

const DYNAMIC_DISPATCH_REASON = "dynamic dispatch: call target not statically resolvable";

export interface FindCallersArgs {
  readonly workspaceState: TypeScriptWorkspaceState;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findCallers(args: FindCallersArgs): Promise<readonly CallEdge[]> {
  args.workspaceState.ensureFiles(args.files);
  return new CallerFinder(args).find();
}

interface CallPosition {
  readonly confidence: EdgeConfidence;
  readonly reason?: string;
}

class CallerFinder {
  private readonly workspaceState: TypeScriptWorkspaceState;

  constructor(private readonly args: FindCallersArgs) {
    this.workspaceState = args.workspaceState;
  }

  find(): readonly CallEdge[] {
    const declarationNodes = this.targetDeclarationNodes();
    if (declarationNodes.length === 0) return [];
    return this.edgesFrom(declarationNodes);
  }

  private targetDeclarationNodes(): readonly Node[] {
    return this.workspaceState
      .locateSemanticCopies(this.args.identity)
      .map((located) => located.node);
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
    const ancestors = CallerFinder.ownerCandidateAncestorsOf(referenceNode);
    return this.declaredExecutionOwnerIn(ancestors) ?? this.nearestIndexedDeclarationIn(ancestors);
  }

  private static ownerCandidateAncestorsOf(referenceNode: Node): readonly Node[] {
    const ancestors: Node[] = [];
    let decoratedNode: Node | undefined;
    let ancestor = referenceNode.getParent();
    while (ancestor) {
      if (Node.isDecorator(ancestor)) {
        decoratedNode = ancestor.getParent();
      } else if (ancestor !== decoratedNode) {
        ancestors.push(ancestor);
      }
      ancestor = ancestor.getParent();
    }
    return ancestors;
  }

  private declaredExecutionOwnerIn(ancestors: readonly Node[]): SymbolOverviewNode | undefined {
    for (const ancestor of ancestors) {
      const owner = this.declaredExecutionOwnerOf(ancestor);
      if (owner) return owner;
    }
    return undefined;
  }

  private nearestIndexedDeclarationIn(ancestors: readonly Node[]): SymbolOverviewNode | undefined {
    for (const ancestor of ancestors) {
      const declaration = this.indexedDeclarationAt(ancestor);
      if (declaration) return declaration;
    }
    return undefined;
  }

  private declaredExecutionOwnerOf(node: Node): SymbolOverviewNode | undefined {
    if (
      Node.isFunctionDeclaration(node) ||
      Node.isMethodDeclaration(node) ||
      Node.isConstructorDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node)
    ) {
      return this.indexedDeclarationAt(node);
    }
    if (!Node.isArrowFunction(node) && !Node.isFunctionExpression(node)) return undefined;
    const owner = CallerFinder.functionValueOwnerOf(node);
    return owner && this.indexedDeclarationAt(owner);
  }

  private static functionValueOwnerOf(functionValue: Node): Node | undefined {
    let parent = functionValue.getParent();
    while (parent && Node.isParenthesizedExpression(parent)) {
      parent = parent.getParent();
    }
    if (!parent) return undefined;
    if (
      Node.isVariableDeclaration(parent) ||
      Node.isPropertyDeclaration(parent) ||
      Node.isPropertyAssignment(parent) ||
      Node.isExportAssignment(parent)
    ) {
      return parent;
    }
    if (
      Node.isBinaryExpression(parent) &&
      parent.getOperatorToken().isKind(SyntaxKind.EqualsToken)
    ) {
      return parent.getLeft().getSymbol()?.getDeclarations()[0];
    }
    return undefined;
  }

  private indexedDeclarationAt(node: Node): SymbolOverviewNode | undefined {
    return this.workspaceState.declarationAt(node);
  }

  private siteFor(node: Node): CallSite {
    const sourceFile = node.getSourceFile();
    const relative = this.workspaceState.relativePathOf(sourceFile) ?? "";
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
