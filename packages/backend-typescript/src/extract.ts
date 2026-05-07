import { Node, SyntaxKind, type SourceFile } from "ts-morph";
import type { FileSymbols, LineRange, SymbolDecl, SymbolKind } from "@symnav/core";
import { SIGNATURE_CAP_CHARS, SIGNATURE_ELLIPSIS } from "./signature-cap.js";

export function extractFileSymbols(args: {
  sourceFile: SourceFile;
  filePath: string;
}): FileSymbols {
  return {
    filePath: args.filePath,
    symbols: extractTopLevel(args.sourceFile),
  };
}

export function extractTopLevel(sourceFile: SourceFile): readonly SymbolDecl[] {
  const decls: SymbolDecl[] = [];
  for (const stmt of sourceFile.getStatements()) {
    decls.push(...declsFromStatement(stmt));
  }
  return decls;
}

export function extractChildren(parent: Node): readonly SymbolDecl[] {
  const decls: SymbolDecl[] = [];

  if (Node.isClassDeclaration(parent) || Node.isClassExpression(parent)) {
    for (const member of parent.getMembers()) {
      const decl = declFromMember(member);
      if (decl) decls.push(decl);
    }
  } else if (Node.isInterfaceDeclaration(parent)) {
    for (const member of parent.getMembers()) {
      const decl = declFromInterfaceMember(member);
      if (decl) decls.push(decl);
    }
  } else if (Node.isModuleDeclaration(parent) || Node.isModuleBlock(parent)) {
    const body = Node.isModuleDeclaration(parent) ? parent.getBody() : parent;
    if (body && Node.isModuleBlock(body)) {
      for (const stmt of body.getStatements()) {
        decls.push(...declsFromStatement(stmt));
      }
    }
  }

  return decls;
}

function declsFromStatement(stmt: Node): SymbolDecl[] {
  if (Node.isFunctionDeclaration(stmt)) {
    const name = stmt.getName();
    if (!name) return [];
    return [makeDecl("function", name, stmt)];
  }
  if (Node.isClassDeclaration(stmt)) {
    const name = stmt.getName();
    if (!name) return [];
    return [makeDecl("class", name, stmt, extractChildren(stmt))];
  }
  if (Node.isInterfaceDeclaration(stmt)) {
    return [makeDecl("interface", stmt.getName(), stmt, extractChildren(stmt))];
  }
  if (Node.isTypeAliasDeclaration(stmt)) {
    return [makeDecl("type-alias", stmt.getName(), stmt)];
  }
  if (Node.isEnumDeclaration(stmt)) {
    return [makeDecl("enum", stmt.getName(), stmt)];
  }
  if (Node.isModuleDeclaration(stmt)) {
    return [makeDecl("namespace", stmt.getName(), stmt, extractChildren(stmt))];
  }
  if (Node.isVariableStatement(stmt)) {
    const decls: SymbolDecl[] = [];
    for (const v of stmt.getDeclarations()) {
      decls.push(makeVariableDecl(stmt, v));
    }
    return decls;
  }
  if (Node.isExportAssignment(stmt)) {
    return [
      {
        kind: "default-export",
        name: "default",
        range: rangeOf(stmt),
        signature: renderExportAssignment(stmt),
        children: [],
      },
    ];
  }
  return [];
}

function declFromMember(member: Node): SymbolDecl | null {
  if (Node.isConstructorDeclaration(member)) {
    return {
      kind: "constructor",
      name: "constructor",
      range: rangeOf(member),
      signature: renderCallableSignature(member),
      children: [],
    };
  }
  if (Node.isMethodDeclaration(member)) {
    return {
      kind: "method",
      name: member.getName(),
      range: rangeOf(member),
      signature: renderCallableSignature(member),
      children: [],
    };
  }
  if (Node.isGetAccessorDeclaration(member)) {
    return {
      kind: "getter",
      name: member.getName(),
      range: rangeOf(member),
      signature: renderCallableSignature(member),
      children: [],
    };
  }
  if (Node.isSetAccessorDeclaration(member)) {
    return {
      kind: "setter",
      name: member.getName(),
      range: rangeOf(member),
      signature: renderCallableSignature(member),
      children: [],
    };
  }
  if (Node.isPropertyDeclaration(member)) {
    return {
      kind: "property",
      name: member.getName(),
      range: rangeOf(member),
      signature: renderProperty(member),
      children: [],
    };
  }
  return null;
}

function declFromInterfaceMember(member: Node): SymbolDecl | null {
  if (Node.isPropertySignature(member)) {
    return {
      kind: "property",
      name: member.getName(),
      range: rangeOf(member),
      signature: capSignature(member.getText().replace(/;\s*$/, "")),
      children: [],
    };
  }
  if (Node.isMethodSignature(member)) {
    return {
      kind: "method",
      name: member.getName(),
      range: rangeOf(member),
      signature: capSignature(member.getText().replace(/;\s*$/, "")),
      children: [],
    };
  }
  if (Node.isIndexSignatureDeclaration(member)) {
    return {
      kind: "index-signature",
      name: "[]",
      range: rangeOf(member),
      signature: capSignature(member.getText().replace(/;\s*$/, "")),
      children: [],
    };
  }
  if (Node.isCallSignatureDeclaration(member)) {
    return {
      kind: "call-signature",
      name: "()",
      range: rangeOf(member),
      signature: capSignature(member.getText().replace(/;\s*$/, "")),
      children: [],
    };
  }
  if (Node.isConstructSignatureDeclaration(member)) {
    return {
      kind: "construct-signature",
      name: "new",
      range: rangeOf(member),
      signature: capSignature(member.getText().replace(/;\s*$/, "")),
      children: [],
    };
  }
  return null;
}

function makeDecl(
  kind: SymbolKind,
  name: string,
  node: Node,
  children: readonly SymbolDecl[] = [],
): SymbolDecl {
  return {
    kind,
    name,
    range: rangeOf(node),
    signature: renderDeclarationSignature(node),
    children,
  };
}

function makeVariableDecl(stmt: Node, decl: Node): SymbolDecl {
  if (!Node.isVariableDeclaration(decl)) {
    throw new Error("expected VariableDeclaration");
  }
  return {
    kind: "variable",
    name: decl.getName(),
    range: rangeOf(decl),
    signature: renderVariable(stmt, decl),
    children: [],
  };
}

export function nodeRange(node: Node): LineRange {
  return rangeOf(node);
}

function rangeOf(node: Node): LineRange {
  const sf = node.getSourceFile();
  const start = sf.getLineAndColumnAtPos(node.getStart()).line;
  const end = sf.getLineAndColumnAtPos(node.getEnd()).line;
  return { startLine: start, endLine: end };
}

export function renderSignature(node: Node): string {
  return renderDeclarationSignature(node);
}

function renderDeclarationSignature(node: Node): string {
  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  ) {
    return capSignature(renderCallableSignature(node));
  }
  if (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node)
  ) {
    return capSignature(renderHeader(node));
  }
  if (Node.isTypeAliasDeclaration(node)) {
    const text = node.getText().replace(/;\s*$/, "");
    return capSignature(text);
  }
  return capSignature(node.getText());
}

function renderCallableSignature(node: Node): string {
  const text = node.getText();
  const bodyStart = text.indexOf("{");
  if (bodyStart === -1) {
    return text.replace(/;\s*$/, "").trim();
  }
  return text.slice(0, bodyStart).trim();
}

function renderHeader(node: Node): string {
  const text = node.getText();
  const bodyStart = text.indexOf("{");
  if (bodyStart === -1) return text.trim();
  return text.slice(0, bodyStart).trim();
}

function renderProperty(node: Node): string {
  if (!Node.isPropertyDeclaration(node)) return node.getText();
  const text = node.getText().replace(/;\s*$/, "");
  return capSignature(text);
}

function renderVariable(stmt: Node, decl: Node): string {
  if (!Node.isVariableStatement(stmt) || !Node.isVariableDeclaration(decl)) {
    return decl.getText();
  }
  const list = stmt.getDeclarationList();
  const flag = list.getFirstChildByKind(SyntaxKind.ConstKeyword)
    ? "const"
    : list.getFirstChildByKind(SyntaxKind.LetKeyword)
      ? "let"
      : "var";
  const name = decl.getName();
  const typeNode = decl.getTypeNode();
  if (typeNode) {
    return capSignature(`${flag} ${name}: ${typeNode.getText()}`);
  }
  const initializer = decl.getInitializer();
  if (initializer) {
    return capSignature(`${flag} ${name} = ${initializer.getText()}`);
  }
  return capSignature(`${flag} ${name}`);
}

function renderExportAssignment(node: Node): string {
  const text = node.getText().replace(/;\s*$/, "");
  return capSignature(text);
}

function capSignature(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SIGNATURE_CAP_CHARS) return collapsed;
  return collapsed.slice(0, SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length) + SIGNATURE_ELLIPSIS;
}

export function nodeKind(node: Node): SymbolKind | null {
  switch (node.getKind()) {
    case SyntaxKind.FunctionDeclaration:
      return "function";
    case SyntaxKind.ClassDeclaration:
      return "class";
    case SyntaxKind.InterfaceDeclaration:
      return "interface";
    case SyntaxKind.TypeAliasDeclaration:
      return "type-alias";
    case SyntaxKind.EnumDeclaration:
      return "enum";
    case SyntaxKind.ModuleDeclaration:
      return "namespace";
    case SyntaxKind.MethodDeclaration:
    case SyntaxKind.MethodSignature:
      return "method";
    case SyntaxKind.Constructor:
      return "constructor";
    case SyntaxKind.GetAccessor:
      return "getter";
    case SyntaxKind.SetAccessor:
      return "setter";
    case SyntaxKind.PropertyDeclaration:
    case SyntaxKind.PropertySignature:
      return "property";
    case SyntaxKind.VariableDeclaration:
      return "variable";
    case SyntaxKind.ExportAssignment:
      return "default-export";
    case SyntaxKind.IndexSignature:
      return "index-signature";
    case SyntaxKind.CallSignature:
      return "call-signature";
    case SyntaxKind.ConstructSignature:
      return "construct-signature";
    default:
      return null;
  }
}

export function nodeName(node: Node): string {
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
    Node.isVariableDeclaration(node)
  ) {
    return node.getName() ?? "";
  }
  return "";
}
