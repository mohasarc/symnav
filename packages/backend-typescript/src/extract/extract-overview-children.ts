import {
  Node,
  SyntaxKind,
  type Block,
  type ClassDeclaration,
  type ExpressionStatement,
  type InterfaceDeclaration,
  type ModuleDeclaration,
  type TryStatement,
  type VariableStatement,
} from "ts-morph";
import {
  splitHeaderLines,
  type DiagnosticSink,
  type FoldOverviewNode,
  type LineRange,
  type OverviewNode,
  type Header,
  type SymbolIdentity,
  type SymbolOverviewNode,
} from "@symnav/core";

import { reportUnrecognisedNode } from "./extraction-diagnostics.js";
import { extractFoldHeader } from "./extract-fold-header.js";
import { extractReExportEntry } from "./extract-re-export-entry.js";
import { extractSignatureSource } from "./extract-signature-source.js";
import { extractVariableSignature } from "./extract-variable-signature.js";
import { childSymbolScope, type ExtractionScope } from "./extraction-scope.js";
import { foldKindOf, type TypeScriptFoldKind } from "./fold-node-kind.js";
import { nodeKind } from "./node-kind.js";
import { refineLabel } from "./refine-label.js";
import { roleOf } from "./typescript-symbol-kind.js";

export interface ExtractOverviewChildrenArgs {
  readonly nodes: readonly Node[];
  readonly scope: ExtractionScope;
  readonly diagnostics?: DiagnosticSink | undefined;
}

export function extractOverviewChildren(
  args: ExtractOverviewChildrenArgs,
): readonly OverviewNode[] {
  const diagnostics = args.diagnostics ?? args.scope.diagnostics;
  return extractNodes(args.nodes, args.scope, diagnostics, "statement");
}

function extractNodes(
  nodes: readonly Node[],
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
  category: "statement" | "member",
): readonly OverviewNode[] {
  return nodes.flatMap((node) => toOverviewNode(node, scope, diagnostics, category));
}

const IGNORED_STATEMENT_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ImportDeclaration,
  SyntaxKind.NamespaceExportDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.EmptyStatement,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.ThrowStatement,
  SyntaxKind.ReturnStatement,
  SyntaxKind.BreakStatement,
  SyntaxKind.ContinueStatement,
  SyntaxKind.LabeledStatement,
  SyntaxKind.DebuggerStatement,
  SyntaxKind.WithStatement,
]);

const IGNORED_MEMBER_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.SemicolonClassElement,
]);

function toOverviewNode(
  node: Node,
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
  category: "statement" | "member",
): readonly OverviewNode[] {
  const kind = nodeKind(node);
  if (kind) return toSymbolNodes(node, kind, scope, diagnostics);

  const foldKind = foldKindOf(node);
  if (foldKind) return toFoldNodes(node, foldKind, scope, diagnostics);

  const reExport = extractReExportEntry(node, scope.file);
  if (reExport) return [reExport];

  if (isIgnoredNode(node)) return [];
  if (!diagnostics) return [];
  reportUnrecognisedNode({
    sink: diagnostics,
    node,
    filePath: scope.file,
    category,
  });
  return [];
}

function toSymbolNodes(
  node: Node,
  kind: NonNullable<ReturnType<typeof nodeKind>>,
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
): readonly SymbolOverviewNode[] {
  if (Node.isVariableStatement(node)) {
    return expandVariableStatement(node, scope);
  }
  if (isMemberNode(node)) {
    return expandOverloads(node).map((member) => buildSymbolNode(member, kind, scope, diagnostics));
  }
  return [buildSymbolNode(node, kind, scope, diagnostics)];
}

function buildSymbolNode(
  node: Node,
  kind: NonNullable<ReturnType<typeof nodeKind>>,
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
): SymbolOverviewNode {
  const range = nodeRange(node);
  const name = nodeName(node);
  const refined = refineLabel(node, kind);
  const symbolScope = childSymbolScope(scope, name);
  return {
    type: "symbol",
    identity: identityFor(symbolScope),
    kind: { role: roleOf(refined), nativeLabel: refined },
    range,
    header: signatureFrom(range.startLine, extractSignatureSource(node)),
    children: symbolChildren(node, symbolScope, diagnostics),
  };
}

function symbolChildren(
  node: Node,
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
): readonly OverviewNode[] {
  if (Node.isClassDeclaration(node) || Node.isInterfaceDeclaration(node)) {
    return extractNodes(node.getMembers(), scope, diagnostics, "member");
  }
  if (Node.isModuleDeclaration(node)) {
    return extractOverviewChildren({
      nodes: node.getStatements(),
      scope,
      diagnostics,
    });
  }
  const body = functionBodyOf(node);
  if (!body) return [];
  return extractOverviewChildren({
    nodes: body.getStatements(),
    scope,
    diagnostics,
  });
}

function toFoldNodes(
  node: Node,
  foldKind: TypeScriptFoldKind,
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
): readonly FoldOverviewNode[] {
  if (Node.isTryStatement(node)) {
    return tryFoldNodes(node, scope, diagnostics);
  }
  return [
    {
      type: "fold",
      foldKind,
      range: nodeRange(node),
      header: extractFoldHeader(node),
      children: foldChildren(node, scope, diagnostics),
    },
  ];
}

function tryFoldNodes(
  node: TryStatement,
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
): readonly FoldOverviewNode[] {
  const nodes: FoldOverviewNode[] = [
    {
      type: "fold",
      foldKind: "try",
      range: nodeRange(node.getTryBlock()),
      header: extractFoldHeader(node),
      children: extractOverviewChildren({
        nodes: node.getTryBlock().getStatements(),
        scope,
        diagnostics,
      }),
    },
  ];
  const catchClause = node.getCatchClause();
  if (catchClause) {
    nodes.push({
      type: "fold",
      foldKind: "catch",
      range: nodeRange(catchClause),
      header: extractFoldHeader(catchClause),
      children: extractOverviewChildren({
        nodes: catchClause.getBlock().getStatements(),
        scope,
        diagnostics,
      }),
    });
  }
  const finallyBlock = node.getFinallyBlock();
  if (finallyBlock) {
    nodes.push({
      type: "fold",
      foldKind: "finally",
      range: nodeRange(finallyBlock),
      header: { startLine: finallyBlock.getStartLineNumber(), lines: ["finally {"] },
      children: extractOverviewChildren({
        nodes: finallyBlock.getStatements(),
        scope,
        diagnostics,
      }),
    });
  }
  return nodes;
}

function foldChildren(
  node: Node,
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
): readonly OverviewNode[] {
  if (Node.isExpressionStatement(node)) {
    const body = trailingCallBody(node);
    return body ? extractOverviewChildren({ nodes: body.getStatements(), scope, diagnostics }) : [];
  }
  if (Node.isBlock(node)) {
    return extractOverviewChildren({ nodes: node.getStatements(), scope, diagnostics });
  }
  if (Node.isIfStatement(node)) {
    return extractStatementChildren(node.getThenStatement(), scope, diagnostics);
  }
  if (
    Node.isForStatement(node) ||
    Node.isForInStatement(node) ||
    Node.isForOfStatement(node) ||
    Node.isWhileStatement(node) ||
    Node.isDoStatement(node)
  ) {
    return extractStatementChildren(node.getStatement(), scope, diagnostics);
  }
  if (Node.isSwitchStatement(node)) {
    return extractOverviewChildren({
      nodes: node.getCaseBlock().getClauses(),
      scope,
      diagnostics,
    });
  }
  if (Node.isCaseClause(node) || Node.isDefaultClause(node)) {
    return node
      .getStatements()
      .flatMap((statement) =>
        Node.isBlock(statement)
          ? extractOverviewChildren({ nodes: statement.getStatements(), scope, diagnostics })
          : toOverviewNode(statement, scope, diagnostics, "statement"),
      );
  }
  return [];
}

function extractStatementChildren(
  statement: Node,
  scope: ExtractionScope,
  diagnostics: DiagnosticSink | undefined,
): readonly OverviewNode[] {
  if (Node.isBlock(statement)) {
    return extractOverviewChildren({ nodes: statement.getStatements(), scope, diagnostics });
  }
  return toOverviewNode(statement, scope, diagnostics, "statement");
}

function expandVariableStatement(
  statement: VariableStatement,
  scope: ExtractionScope,
): readonly SymbolOverviewNode[] {
  const declList = statement.getDeclarationList();
  const range = nodeRange(statement);
  return declList.getDeclarations().map((decl) => {
    const symbolScope = childSymbolScope(scope, decl.getName());
    return {
      type: "symbol",
      identity: identityFor(symbolScope),
      kind: { role: roleOf("variable"), nativeLabel: "variable" },
      range,
      header: signatureFrom(
        range.startLine,
        extractVariableSignature({ statement, declaration: decl }),
      ),
      children: [],
    };
  });
}

function expandOverloads(node: Node): Node[] {
  if (Node.isOverloadable(node) && node.isImplementation()) {
    const overloads = node.getOverloads();
    if (overloads.length > 0) {
      return [...overloads, node];
    }
  }
  return [node];
}

function functionBodyOf(node: Node): Block | undefined {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isFunctionExpression(node)
  ) {
    const body = node.getBody();
    return body && Node.isBlock(body) ? body : undefined;
  }
  return undefined;
}

function trailingCallBody(node: ExpressionStatement): Block | undefined {
  const expression = node.getExpression();
  if (!Node.isCallExpression(expression)) return undefined;
  const args = expression.getArguments();
  const trailing = args[args.length - 1];
  if (!trailing) return undefined;
  if (Node.isArrowFunction(trailing)) {
    const body = trailing.getBody();
    return Node.isBlock(body) ? body : undefined;
  }
  if (Node.isFunctionExpression(trailing)) {
    const body = trailing.getBody();
    return body && Node.isBlock(body) ? body : undefined;
  }
  return undefined;
}

function identityFor(scope: ExtractionScope): SymbolIdentity {
  return {
    file: scope.file,
    segments: scope.symbolSegments,
  };
}

function signatureFrom(startLine: number, raw: string): Header {
  return { startLine, lines: splitHeaderLines(raw) };
}

function nodeName(node: Node): string {
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isCallSignatureDeclaration(node)) return "()";
  if (Node.isConstructSignatureDeclaration(node)) return "new()";
  if (Node.isIndexSignatureDeclaration(node)) return "[index]";
  if (Node.isExportAssignment(node)) return "default";

  if (
    Node.isFunctionDeclaration(node) ||
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isTypeAliasDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isPropertySignature(node)
  ) {
    return node.getName() ?? "";
  }

  return "";
}

function nodeRange(node: Node): LineRange {
  return {
    startLine: node.getStartLineNumber(),
    endLine: node.getEndLineNumber(),
  };
}

function isMemberNode(node: Node): boolean {
  const parent = node.getParent();
  return (
    !!parent &&
    (Node.isClassDeclaration(parent) || Node.isInterfaceDeclaration(parent)) &&
    !Node.isClassDeclaration(node) &&
    !Node.isInterfaceDeclaration(node)
  );
}

function isIgnoredNode(node: Node): boolean {
  if (IGNORED_STATEMENT_KINDS.has(node.getKind())) return true;
  if (IGNORED_MEMBER_KINDS.has(node.getKind())) return true;
  return false;
}
