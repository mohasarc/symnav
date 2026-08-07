import {
  Node,
  type ArrayLiteralExpression,
  type CallExpression,
  type ClassDeclaration,
  type NewExpression,
  type ObjectLiteralExpression,
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

const DYNAMIC_DISPATCH_REASON = "dynamic dispatch: exact callee not statically resolvable";

export interface FindCalleesArgs {
  readonly fs: FileSystem;
  readonly files: readonly ResolvedPath[];
  readonly identity: SymbolIdentity;
}

export async function findCallees(args: FindCalleesArgs): Promise<readonly CallEdge[]> {
  return new CalleeFinder(args).find();
}

interface ResolvedCallee {
  readonly symbol: SymbolOverviewNode;
  readonly confidence: EdgeConfidence;
  readonly reason?: string;
}

interface DynamicCandidate {
  readonly memberName: string | undefined;
  readonly node: Node;
}

class CalleeFinder {
  private readonly index: WorkspaceDeclarationIndex;

  constructor(private readonly args: FindCalleesArgs) {
    this.index = new WorkspaceDeclarationIndex(args);
  }

  find(): readonly CallEdge[] {
    const bodyNode = this.targetBodyNode();
    if (!bodyNode) return [];
    return this.edgesFrom(bodyNode);
  }

  private targetBodyNode(): Node | undefined {
    const matches = this.index.locate(this.args.identity);
    const withBody = matches.find((match) => carriesBody(match.node));
    return (withBody ?? matches[0])?.node;
  }

  private edgesFrom(bodyNode: Node): readonly CallEdge[] {
    const edgesByKey = new Map<string, MutableEdge>();
    bodyNode.forEachDescendant((node) => {
      const call = asCall(node);
      if (!call) return;
      const site = this.siteFor(call.getExpression());
      for (const callee of this.resolveCallees(call)) {
        this.addEdge(callee, site, edgesByKey);
      }
    });
    return [...edgesByKey.values()].map(finalizeEdge).sort(compareEdges);
  }

  private addEdge(
    callee: ResolvedCallee,
    site: CallSite,
    edgesByKey: Map<string, MutableEdge>,
  ): void {
    const key = `${DeclarationLocator.identityKey(callee.symbol.identity)}#${callee.confidence}`;
    const existing = edgesByKey.get(key);
    if (existing) {
      existing.sites.push(site);
      return;
    }
    edgesByKey.set(key, {
      symbol: callee.symbol,
      confidence: callee.confidence,
      reason: callee.reason,
      sites: [site],
    });
  }

  private resolveCallees(call: CallExpression | NewExpression): readonly ResolvedCallee[] {
    const callee = this.resolveCallee(call);
    if (callee) return [callee];
    if (!Node.isCallExpression(call)) return [];
    return this.resolveDynamicCandidates(call.getExpression()).map((symbol) => ({
      symbol,
      confidence: "possible",
      reason: DYNAMIC_DISPATCH_REASON,
    }));
  }

  private resolveCallee(call: CallExpression | NewExpression): ResolvedCallee | undefined {
    if (Node.isNewExpression(call)) return this.resolveConstructed(call);
    return this.resolveCalled(call);
  }

  private resolveDynamicCandidates(expression: Node): readonly SymbolOverviewNode[] {
    const unwrapped = withoutParentheses(expression);
    if (Node.isElementAccessExpression(unwrapped)) {
      return uniqueSymbols(
        this.elementAccessCandidates(unwrapped)
          .map((candidate) => this.workspaceSymbolForDefinitionsOf(candidate.node))
          .filter((symbol): symbol is SymbolOverviewNode => symbol !== undefined),
      );
    }
    if (Node.isConditionalExpression(unwrapped)) {
      return uniqueSymbols(
        [unwrapped.getWhenTrue(), unwrapped.getWhenFalse()]
          .map((candidate) => this.workspaceSymbolForDefinitionsOf(withoutParentheses(candidate)))
          .filter((symbol): symbol is SymbolOverviewNode => symbol !== undefined),
      );
    }
    return [];
  }

  private elementAccessCandidates(expression: Node): readonly DynamicCandidate[] {
    if (!Node.isElementAccessExpression(expression)) return [];
    const container = this.literalContainerFor(expression.getExpression(), 1);
    if (!container) return [];
    const memberNames = staticMemberNames(expression.getArgumentExpression());
    const candidates = candidatesInContainer(container);
    if (!memberNames) return candidates;
    return candidates.filter(
      (candidate) => candidate.memberName !== undefined && memberNames.has(candidate.memberName),
    );
  }

  private literalContainerFor(node: Node, remainingAliases: number): Node | undefined {
    const unwrapped = withoutParentheses(node);
    if (Node.isObjectLiteralExpression(unwrapped) || Node.isArrayLiteralExpression(unwrapped)) {
      return unwrapped;
    }
    if (!Node.isIdentifier(unwrapped)) return undefined;
    for (const declaration of definitionNodesOf(unwrapped)) {
      if (!Node.isVariableDeclaration(declaration)) continue;
      const initializer = declaration.getInitializer();
      if (!initializer) continue;
      const literal = withoutParentheses(initializer);
      if (Node.isObjectLiteralExpression(literal) || Node.isArrayLiteralExpression(literal)) {
        return literal;
      }
      if (remainingAliases > 0 && Node.isIdentifier(literal)) {
        const resolved = this.literalContainerFor(literal, remainingAliases - 1);
        if (resolved) return resolved;
      }
    }
    return undefined;
  }

  private resolveConstructed(call: NewExpression): ResolvedCallee | undefined {
    const nameNode = calleeNameNode(call.getExpression());
    const classDeclaration = nameNode && definitionNodesOf(nameNode).find(Node.isClassDeclaration);
    if (!classDeclaration) return undefined;
    const constructed = this.constructorTargetOf(classDeclaration);
    const symbol = this.workspaceSymbolFor(constructed);
    if (!symbol) return undefined;
    return { symbol, confidence: "certain" };
  }

  private constructorTargetOf(classDeclaration: ClassDeclaration): Node {
    const constructors = classDeclaration.getConstructors();
    const implementation = constructors.find((node) => carriesBody(node));
    return implementation ?? constructors[0] ?? classDeclaration;
  }

  private resolveCalled(call: CallExpression): ResolvedCallee | undefined {
    const expression = call.getExpression();
    const concreteElementAccess = this.resolveConcreteElementAccess(expression);
    if (concreteElementAccess) return { symbol: concreteElementAccess, confidence: "certain" };
    if (this.resolveDynamicCandidates(expression).length > 0) return undefined;
    const nameNode = calleeNameNode(expression);
    if (nameNode) {
      const symbol = this.workspaceSymbolForDefinitionsOf(nameNode);
      if (symbol) return { symbol, confidence: "certain" };
      if (nameNode.getSymbol()) return undefined;
    }
    return this.resolveDynamic(call);
  }

  private resolveConcreteElementAccess(expression: Node): SymbolOverviewNode | undefined {
    if (!Node.isElementAccessExpression(expression)) return undefined;
    const memberName = literalMemberName(expression.getArgumentExpression());
    if (!memberName) return undefined;
    const target = expression.getExpression();
    if (!Node.isIdentifier(target)) return undefined;
    for (const declaration of definitionNodesOf(target)) {
      if (!Node.isVariableDeclaration(declaration)) continue;
      const initializer = declaration.getInitializer();
      if (!initializer || !Node.isObjectLiteralExpression(initializer)) continue;
      const property = initializer
        .getProperties()
        .find((candidate) => propertyName(candidate) === memberName);
      const callee = property && propertyInitializer(property);
      if (!callee) continue;
      const symbol = this.workspaceSymbolForDefinitionsOf(callee);
      if (symbol) return symbol;
    }
    return undefined;
  }

  private resolveDynamic(call: CallExpression): ResolvedCallee | undefined {
    const type = call.getExpression().getType();
    const symbol = type.getAliasSymbol() ?? type.getSymbol();
    const declaration = symbol?.getDeclarations()[0];
    const resolved = declaration && this.workspaceSymbolFor(declaration);
    if (!resolved) return undefined;
    if (resolved.kind.role === "type") return undefined;
    return { symbol: resolved, confidence: "possible", reason: DYNAMIC_DISPATCH_REASON };
  }

  private workspaceSymbolForDefinitionsOf(node: Node): SymbolOverviewNode | undefined {
    for (const declaration of definitionNodesOf(node)) {
      const symbol = this.workspaceSymbolFor(declaration);
      if (symbol) return symbol;
    }
    return undefined;
  }

  private workspaceSymbolFor(node: Node): SymbolOverviewNode | undefined {
    return this.index.declarationAt(node);
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

function asCall(node: Node): CallExpression | NewExpression | undefined {
  if (Node.isCallExpression(node) || Node.isNewExpression(node)) return node;
  return undefined;
}

function calleeNameNode(expression: Node): Node | undefined {
  if (Node.isIdentifier(expression)) return expression;
  if (Node.isPropertyAccessExpression(expression)) return expression.getNameNode();
  return undefined;
}

function definitionNodesOf(node: Node): readonly Node[] {
  if (Node.isIdentifier(node) || Node.isPrivateIdentifier(node)) {
    return node.getDefinitionNodes();
  }
  return [];
}

function literalMemberName(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralText();
  }
  return undefined;
}

function propertyName(node: Node): string | undefined {
  if (Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) {
    return node.getName();
  }
  return undefined;
}

function propertyInitializer(node: Node): Node | undefined {
  if (Node.isPropertyAssignment(node)) return node.getInitializer();
  if (Node.isShorthandPropertyAssignment(node)) return node.getNameNode();
  return undefined;
}

function candidatesInContainer(node: Node): readonly DynamicCandidate[] {
  if (Node.isObjectLiteralExpression(node)) return objectLiteralCandidates(node);
  if (Node.isArrayLiteralExpression(node)) return arrayLiteralCandidates(node);
  return [];
}

function objectLiteralCandidates(node: ObjectLiteralExpression): readonly DynamicCandidate[] {
  return node
    .getProperties()
    .map((property) => {
      const initializer = propertyInitializer(property);
      if (!initializer) return undefined;
      return { memberName: propertyName(property), node: initializer };
    })
    .filter((candidate): candidate is DynamicCandidate => candidate !== undefined);
}

function arrayLiteralCandidates(node: ArrayLiteralExpression): readonly DynamicCandidate[] {
  return node.getElements().map((element, index) => ({
    memberName: String(index),
    node: element,
  }));
}

function staticMemberNames(node: Node | undefined): ReadonlySet<string> | undefined {
  const literalName = literalMemberName(node);
  if (literalName) return new Set([literalName]);
  if (node && Node.isNumericLiteral(node)) return new Set([node.getLiteralText()]);
  const typeText = node?.getType().getText();
  if (!typeText) return undefined;
  const members = typeText
    .split("|")
    .map((part) => quotedLiteralText(part.trim()))
    .filter((part): part is string => part !== undefined);
  return members.length > 0 ? new Set(members) : undefined;
}

function quotedLiteralText(text: string): string | undefined {
  const match = /^["'](.+)["']$/.exec(text);
  return match?.[1];
}

function withoutParentheses(node: Node): Node {
  let current = node;
  while (Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

function uniqueSymbols(symbols: readonly SymbolOverviewNode[]): readonly SymbolOverviewNode[] {
  const byKey = new Map<string, SymbolOverviewNode>();
  for (const symbol of symbols) {
    byKey.set(DeclarationLocator.identityKey(symbol.identity), symbol);
  }
  return [...byKey.values()].sort(compareSymbolOverviewNodes);
}

function compareSymbolOverviewNodes(a: SymbolOverviewNode, b: SymbolOverviewNode): number {
  if (a.identity.file !== b.identity.file) return a.identity.file < b.identity.file ? -1 : 1;
  if (a.range.startLine !== b.range.startLine) return a.range.startLine - b.range.startLine;
  const aKey = DeclarationLocator.identityKey(a.identity);
  const bKey = DeclarationLocator.identityKey(b.identity);
  return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
}

function carriesBody(node: Node): boolean {
  return Node.isBodyable(node) && node.hasBody();
}

function lineText(sourceFile: SourceFile, zeroBasedLine: number): string {
  const fullText = sourceFile.getFullText();
  const lineStarts = sourceFile.compilerNode.getLineStarts();
  const start = lineStarts[zeroBasedLine] ?? 0;
  const end =
    zeroBasedLine + 1 < lineStarts.length ? lineStarts[zeroBasedLine + 1]! : fullText.length;
  return fullText.slice(start, end).replace(/\r?\n$/, "");
}
