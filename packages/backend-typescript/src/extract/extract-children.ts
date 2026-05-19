import {
  Node,
  SyntaxKind,
  type ClassDeclaration,
  type InterfaceDeclaration,
  type ModuleDeclaration,
  type VariableDeclaration,
  type VariableDeclarationKind,
  type VariableStatement,
} from "ts-morph";
import type { LineRange, Signature, SymbolDecl, SymbolIdentity } from "@symnav/core";
import { splitSignatureLines } from "@symnav/core";

import { extractSignatureSource } from "./extract-signature-source.js";
import { nodeKind } from "./node-kind.js";
import { refineLabel } from "./refine-label.js";
import { roleOf } from "./typescript-symbol-kind.js";

export interface ExtractionScope {
  readonly file: string;
  readonly ancestorNames: readonly string[];
}

function childScope(parent: ExtractionScope, name: string): ExtractionScope {
  return { file: parent.file, ancestorNames: [...parent.ancestorNames, name] };
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
): readonly SymbolDecl[] {
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
): readonly SymbolDecl[] {
  return statements.flatMap((stmt) => toStatementDecl(stmt, scope));
}

const IGNORED_STATEMENT_KINDS: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ImportDeclaration,
  SyntaxKind.ExportDeclaration,
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

function toMemberDecl(member: Node, scope: ExtractionScope): SymbolDecl[] {
  const kind = nodeKind(member);
  if (!kind) {
    if (IGNORED_MEMBER_KINDS.has(member.getKind())) return [];
    throw new Error(`Unrecognised class/interface member kind: ${member.getKindName()}`);
  }
  return expandOverloads(member).map((node) => buildMemberDecl(node, kind, scope));
}

function buildMemberDecl(
  member: Node,
  kind: NonNullable<ReturnType<typeof nodeKind>>,
  scope: ExtractionScope,
): SymbolDecl {
  const range = nodeRange(member);
  const name = nodeName(member);
  const refined = refineLabel(member, kind);
  return {
    identity: identityFor(scope, name),
    kind: { role: roleOf(refined), nativeLabel: refined },
    range,
    signature: signatureFrom(range.startLine, extractSignatureSource(member)),
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

function toStatementDecl(stmt: Node, scope: ExtractionScope): SymbolDecl[] {
  const kind = nodeKind(stmt);
  if (!kind) {
    if (IGNORED_STATEMENT_KINDS.has(stmt.getKind())) return [];
    throw new Error(`Unrecognised top-level statement kind: ${stmt.getKindName()}`);
  }
  if (Node.isVariableStatement(stmt)) {
    return expandVariableStatement(stmt, scope);
  }
  const range = nodeRange(stmt);
  const name = nodeName(stmt);
  const refined = refineLabel(stmt, kind);
  return [
    {
      identity: identityFor(scope, name),
      kind: { role: roleOf(refined), nativeLabel: refined },
      range,
      signature: signatureFrom(range.startLine, extractSignatureSource(stmt)),
      children: hasChildren(stmt) ? extractChildren(stmt, childScope(scope, name)) : [],
    },
  ];
}

function expandVariableStatement(stmt: VariableStatement, scope: ExtractionScope): SymbolDecl[] {
  const declList = stmt.getDeclarationList();
  const keyword = declList.getDeclarationKind();
  const range = nodeRange(stmt);
  return declList.getDeclarations().map((decl) => ({
    identity: identityFor(scope, decl.getName()),
    kind: { role: roleOf("variable"), nativeLabel: "variable" },
    range,
    signature: signatureFrom(range.startLine, singleVariableSignature(stmt, keyword, decl)),
    children: [],
  }));
}

function signatureFrom(startLine: number, raw: string): Signature {
  return { startLine, lines: splitSignatureLines(raw) };
}

function singleVariableSignature(
  stmt: VariableStatement,
  keyword: VariableDeclarationKind,
  decl: VariableDeclaration,
): string {
  const modifiers = stmt
    .getModifiers()
    .map((m) => m.getText())
    .join(" ");
  const head = modifiers ? `${modifiers} ${keyword}` : keyword;
  return `${head} ${decl.getText()}`;
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
