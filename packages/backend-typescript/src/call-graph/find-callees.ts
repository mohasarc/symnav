import {
  Node,
  type CallExpression,
  type ClassDeclaration,
  type NewExpression,
  type SourceFile,
} from "ts-morph";
import type {
  CallEdge,
  CallSite,
  EdgeConfidence,
  FileSystem,
  ResolvedPath,
  SymbolDecl,
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
  readonly symbol: SymbolDecl;
  readonly confidence: EdgeConfidence;
  readonly reason?: string;
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
      const callee = this.resolveCallee(call);
      if (!callee) return;
      const key = `${DeclarationLocator.identityKey(callee.symbol.identity)}#${callee.confidence}`;
      const existing = edgesByKey.get(key);
      const site = this.siteFor(call.getExpression());
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
    });
    return [...edgesByKey.values()].map(finalizeEdge).sort(compareEdges);
  }

  private resolveCallee(call: CallExpression | NewExpression): ResolvedCallee | undefined {
    if (Node.isNewExpression(call)) return this.resolveConstructed(call);
    return this.resolveCalled(call);
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
    const nameNode = calleeNameNode(expression);
    if (nameNode) {
      const symbol = this.workspaceSymbolForDefinitionsOf(nameNode);
      if (symbol) return { symbol, confidence: "certain" };
      if (nameNode.getSymbol()) return undefined;
    }
    return this.resolveDynamic(call);
  }

  private resolveConcreteElementAccess(expression: Node): SymbolDecl | undefined {
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

  private workspaceSymbolForDefinitionsOf(node: Node): SymbolDecl | undefined {
    for (const declaration of definitionNodesOf(node)) {
      const symbol = this.workspaceSymbolFor(declaration);
      if (symbol) return symbol;
    }
    return undefined;
  }

  private workspaceSymbolFor(node: Node): SymbolDecl | undefined {
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
  symbol: SymbolDecl;
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
