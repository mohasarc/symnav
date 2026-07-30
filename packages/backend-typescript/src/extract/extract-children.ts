import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type ModuleDeclaration,
  type VariableStatement,
} from "ts-morph";
import type {
  DiagnosticSink,
  LineRange,
  Signature,
  SymbolOverviewNode,
  SymbolIdentity,
} from "@symnav/core";
import { splitSignatureLines } from "@symnav/core";

import { reportUnrecognisedNode } from "./extraction-diagnostics.js";
import { extractSignatureSource } from "./extract-signature-source.js";
import { extractVariableSignature } from "./extract-variable-signature.js";
import { nodeKind } from "./node-kind.js";
import { refineLabel } from "./refine-label.js";
import { roleOf } from "./typescript-symbol-kind.js";

export interface ExtractionScope {
  readonly file: string;
  readonly ancestorNames: readonly string[];
  readonly diagnostics?: DiagnosticSink | undefined;
}

function childScope(parent: ExtractionScope, name: string): ExtractionScope {
  return {
    file: parent.file,
    ancestorNames: [...parent.ancestorNames, name],
    diagnostics: parent.diagnostics,
  };
}

function identityFor(scope: ExtractionScope, name: string): SymbolIdentity {
  return {
    file: scope.file,
    segments: [...scope.ancestorNames, name].map((segmentName) => ({ name: segmentName })),
  };
}

function extractChildren(
  parent: ClassDeclaration | InterfaceDeclaration | ModuleDeclaration,
  scope: ExtractionScope,
): readonly SymbolOverviewNode[] {
  if (Node.isClassDeclaration(parent) || Node.isInterfaceDeclaration(parent)) {
    return parent.getMembers().flatMap((member) => toMemberDecl(member, scope));
  }
  return extractStatementDecls(parent.getStatements(), scope);
}

function hasChildren(
  node: Node,
): node is ClassDeclaration | InterfaceDeclaration | ModuleDeclaration {
  return (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isModuleDeclaration(node)
  );
}

export function extractStatementDecls(
  statements: readonly Node[],
  scope: ExtractionScope,
): readonly SymbolOverviewNode[] {
  return statements.flatMap((stmt) => toStatementDecl(stmt, scope));
}

const IGNORED_STATEMENT_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ExportDeclaration,
  SyntaxKind.NamespaceExportDeclaration,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.EmptyStatement,
  SyntaxKind.ExpressionStatement,
  SyntaxKind.IfStatement,
  SyntaxKind.ForStatement,
  SyntaxKind.ForInStatement,
  SyntaxKind.ForOfStatement,
  SyntaxKind.WhileStatement,
  SyntaxKind.DoStatement,
  SyntaxKind.SwitchStatement,
  SyntaxKind.TryStatement,
  SyntaxKind.ThrowStatement,
  SyntaxKind.ReturnStatement,
  SyntaxKind.BreakStatement,
  SyntaxKind.ContinueStatement,
  SyntaxKind.LabeledStatement,
  SyntaxKind.Block,
  SyntaxKind.DebuggerStatement,
  SyntaxKind.WithStatement,
]);

const IGNORED_MEMBER_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ClassStaticBlockDeclaration,
  SyntaxKind.SemicolonClassElement,
]);

function toMemberDecl(member: Node, scope: ExtractionScope): SymbolOverviewNode[] {
  const kind = nodeKind(member);
  if (!kind) {
    if (IGNORED_MEMBER_KINDS.has(member.getKind())) return [];
    reportUnrecognisedMember(member, scope);
    return [];
  }
  return expandOverloads(member).map((node) => buildMemberDecl(node, kind, scope));
}

function buildMemberDecl(
  member: Node,
  kind: NonNullable<ReturnType<typeof nodeKind>>,
  scope: ExtractionScope,
): SymbolOverviewNode {
  const range = nodeRange(member);
  const name = nodeName(member);
  const refined = refineLabel(member, kind);
  return {
    type: "symbol",
    identity: identityFor(scope, name),
    kind: { role: roleOf(refined), nativeLabel: refined },
    range,
    header: signatureFrom(range.startLine, extractSignatureSource(member)),
    children: [],
  };
}

function expandOverloads(member: Node): Node[] {
  if (Node.isOverloadable(member) && member.isImplementation()) {
    const overloads = member.getOverloads();
    if (overloads.length > 0) {
      return [...overloads, member];
    }
  }
  return [member];
}

function toStatementDecl(stmt: Node, scope: ExtractionScope): SymbolOverviewNode[] {
  const kind = nodeKind(stmt);
  if (!kind) {
    if (IGNORED_STATEMENT_KINDS.has(stmt.getKind())) return [];
    reportUnrecognisedStatement(stmt, scope);
    return [];
  }
  if (Node.isVariableStatement(stmt)) {
    return expandVariableStatement(stmt, scope);
  }
  const range = nodeRange(stmt);
  const name = nodeName(stmt);
  const refined = refineLabel(stmt, kind);
  return [
    {
      type: "symbol",
      identity: identityFor(scope, name),
      kind: { role: roleOf(refined), nativeLabel: refined },
      range,
      header: signatureFrom(range.startLine, extractSignatureSource(stmt)),
      children: hasChildren(stmt) ? extractChildren(stmt, childScope(scope, name)) : [],
    },
  ];
}

function expandVariableStatement(
  stmt: VariableStatement,
  scope: ExtractionScope,
): SymbolOverviewNode[] {
  const declList = stmt.getDeclarationList();
  const range = nodeRange(stmt);
  return declList.getDeclarations().map((decl) => ({
    type: "symbol",
    identity: identityFor(scope, decl.getName()),
    kind: { role: roleOf("variable"), nativeLabel: "variable" },
    range,
    header: signatureFrom(
      range.startLine,
      extractVariableSignature({ statement: stmt, declaration: decl }),
    ),
    children: [],
  }));
}

function signatureFrom(startLine: number, raw: string): Signature {
  return { startLine, lines: splitSignatureLines(raw) };
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

function reportUnrecognisedStatement(stmt: Node, scope: ExtractionScope): void {
  if (!scope.diagnostics) return;
  reportUnrecognisedNode({
    sink: scope.diagnostics,
    node: stmt,
    filePath: scope.file,
    category: "statement",
  });
}

function reportUnrecognisedMember(member: Node, scope: ExtractionScope): void {
  if (!scope.diagnostics) return;
  reportUnrecognisedNode({
    sink: scope.diagnostics,
    node: member,
    filePath: scope.file,
    category: "member",
  });
}
