import {
  Node,
  Project,
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

import { extractFileSymbols } from "../extract/extract-file-symbols.js";
import { DeclarationLocator } from "../identity/locate-declarations.js";
import { WorkspaceFileSystemHost } from "../typescript-backend/workspace-file-system-host.js";

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
  private readonly project: Project;
  private readonly fileByRelativePath = new Map<string, ResolvedPath>();
  private readonly relativePathByAbsolute = new Map<string, string>();
  private readonly declarationsByLocation = new Map<string, Map<number, SymbolDecl>>();

  constructor(private readonly args: FindCalleesArgs) {
    this.project = new Project({ fileSystem: new WorkspaceFileSystemHost(args.fs) });
  }

  find(): readonly CallEdge[] {
    this.loadWorkspaceFiles();
    this.indexDeclarationsByLocation();
    const bodyNode = this.targetBodyNode();
    if (!bodyNode) return [];
    return this.edgesFrom(bodyNode);
  }

  private loadWorkspaceFiles(): void {
    for (const path of this.args.files) {
      this.project.addSourceFileAtPath(path.absolute);
      this.fileByRelativePath.set(path.relative, path);
      this.relativePathByAbsolute.set(path.absolute, path.relative);
    }
  }

  private indexDeclarationsByLocation(): void {
    for (const [relative, path] of this.fileByRelativePath) {
      const sourceFile = this.project.getSourceFile(path.absolute);
      if (!sourceFile) continue;
      const byLine = new Map<number, SymbolDecl>();
      const { symbols } = extractFileSymbols({ sourceFile, filePath: relative });
      for (const declaration of withNestedDeclarations(symbols)) {
        byLine.set(declaration.range.startLine, declaration);
      }
      this.declarationsByLocation.set(relative, byLine);
    }
  }

  private targetBodyNode(): Node | undefined {
    const targetSource = this.targetSourceFile();
    if (!targetSource) return undefined;
    const matches = new DeclarationLocator(targetSource).locate(this.args.identity);
    const withBody = matches.find((match) => carriesBody(match.node));
    return (withBody ?? matches[0])?.node;
  }

  private targetSourceFile(): SourceFile | undefined {
    const targetPath = this.fileByRelativePath.get(this.args.identity.file);
    if (!targetPath) return undefined;
    return this.project.getSourceFile(targetPath.absolute);
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
    const nameNode = calleeNameNode(expression);
    if (nameNode) {
      const symbol = this.workspaceSymbolForDefinitionsOf(nameNode);
      if (symbol) return { symbol, confidence: "certain" };
      if (nameNode.getSymbol()) return undefined;
    }
    return this.resolveDynamic(call);
  }

  private resolveDynamic(call: CallExpression): ResolvedCallee | undefined {
    const type = call.getExpression().getType();
    const symbol = type.getAliasSymbol() ?? type.getSymbol();
    const declaration = symbol?.getDeclarations()[0];
    const resolved = declaration && this.workspaceSymbolFor(declaration);
    if (!resolved) return undefined;
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
    const relative = this.relativePathByAbsolute.get(node.getSourceFile().getFilePath());
    if (!relative) return undefined;
    return this.declarationsByLocation.get(relative)?.get(node.getStartLineNumber());
  }

  private siteFor(node: Node): CallSite {
    const sourceFile = node.getSourceFile();
    const relative = this.relativePathByAbsolute.get(sourceFile.getFilePath()) ?? "";
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

function carriesBody(node: Node): boolean {
  return Node.isBodyable(node) && node.hasBody();
}

function withNestedDeclarations(symbols: readonly SymbolDecl[]): readonly SymbolDecl[] {
  const queue = [...symbols];
  for (let i = 0; i < queue.length; i++) {
    queue.push(...queue[i]!.children);
  }
  return queue;
}

function lineText(sourceFile: SourceFile, zeroBasedLine: number): string {
  const fullText = sourceFile.getFullText();
  const lineStarts = sourceFile.compilerNode.getLineStarts();
  const start = lineStarts[zeroBasedLine] ?? 0;
  const end =
    zeroBasedLine + 1 < lineStarts.length ? lineStarts[zeroBasedLine + 1]! : fullText.length;
  return fullText.slice(start, end).replace(/\r?\n$/, "");
}
