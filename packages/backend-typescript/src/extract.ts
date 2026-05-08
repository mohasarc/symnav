import type { LineRange, SymbolKind } from "@symnav/core";
import { Node, SyntaxKind } from "ts-morph";
import { SIGNATURE_CAP_CHARS, SIGNATURE_ELLIPSIS } from "./signature-cap.js";

/**
 * Map a ts-morph node to its `SymbolKind`, or `null` when the node is not a
 * declaration we want to surface in the IR (re-exports, bare imports, etc.).
 *
 * The classifier is source-text driven: it inspects the node kind only — it
 * does not look at modifiers (`abstract`, `static`, `async`) because those are
 * captured verbatim by the signature renderer.
 */
export function nodeKind(node: Node): SymbolKind | null {
  if (Node.isFunctionDeclaration(node)) return "function";
  if (Node.isClassDeclaration(node)) return "class";
  if (Node.isInterfaceDeclaration(node)) return "interface";
  if (Node.isTypeAliasDeclaration(node)) return "type-alias";
  if (Node.isEnumDeclaration(node)) return "enum";
  if (Node.isModuleDeclaration(node)) return "namespace";
  if (Node.isExportAssignment(node)) return "default-export";

  // Class members
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isGetAccessorDeclaration(node)) return "getter";
  if (Node.isSetAccessorDeclaration(node)) return "setter";
  if (Node.isMethodDeclaration(node) || Node.isMethodSignature(node)) return "method";
  if (Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)) return "property";
  if (Node.isIndexSignatureDeclaration(node)) return "index-signature";
  if (Node.isCallSignatureDeclaration(node)) return "call-signature";
  if (Node.isConstructSignatureDeclaration(node)) return "construct-signature";

  return null;
}

/**
 * Resolve a declaration's local name. For `export default <expr>`, the name is
 * the literal string `"default"` (matching the IR convention). Variable decls
 * use the binding name on the individual declarator.
 */
export function nodeName(node: Node): string {
  if (Node.isExportAssignment(node)) return "default";
  if (Node.isConstructorDeclaration(node)) return "constructor";
  if (Node.isCallSignatureDeclaration(node)) return "";
  if (Node.isConstructSignatureDeclaration(node)) return "new";
  if (Node.isIndexSignatureDeclaration(node)) return "";
  // Most declarations expose `getName()`; fall back to the empty string.
  const candidate = node as unknown as { getName?: () => string | undefined };
  if (typeof candidate.getName === "function") {
    return candidate.getName() ?? "";
  }
  return "";
}

/**
 * Compute the inclusive 1-based source line range a declaration covers.
 */
export function nodeRange(node: Node): LineRange {
  const sourceFile = node.getSourceFile();
  const start = sourceFile.getLineAndColumnAtPos(node.getStart()).line;
  const end = sourceFile.getLineAndColumnAtPos(node.getEnd()).line;
  return { startLine: start, endLine: end };
}

/**
 * Render a declaration's signature: source text up to the body for callable
 * declarations, up to the opening brace for type containers, the full
 * declaration for type aliases / variables (capped + ellipsized), and the
 * expression text for `export default`.
 *
 * The renderer is intentionally source-text driven so that user formatting
 * (whitespace inside parameter lists, type annotations) round-trips faithfully.
 */
export function renderSignature(node: Node): string {
  if (Node.isExportAssignment(node)) {
    return capSignature(stripTrailingSemicolon(node.getText().trimEnd()));
  }

  if (Node.isVariableDeclaration(node)) {
    return renderVariableSignature(node);
  }

  if (Node.isTypeAliasDeclaration(node)) {
    return capSignature(stripTrailingSemicolon(node.getText().trimEnd()));
  }

  if (
    Node.isClassDeclaration(node) ||
    Node.isInterfaceDeclaration(node) ||
    Node.isEnumDeclaration(node) ||
    Node.isModuleDeclaration(node)
  ) {
    return capSignature(textBeforeFirstBrace(node));
  }

  if (Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)) {
    return capSignature(renderPropertySignature(node));
  }

  if (
    Node.isFunctionDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node) ||
    Node.isCallSignatureDeclaration(node) ||
    Node.isConstructSignatureDeclaration(node) ||
    Node.isIndexSignatureDeclaration(node)
  ) {
    return capSignature(textBeforeBodyOrSemicolon(node));
  }

  return capSignature(stripTrailingSemicolon(node.getText().trimEnd()));
}

function renderVariableSignature(node: Node): string {
  if (!Node.isVariableDeclaration(node)) return capSignature(node.getText());

  const list = node.getParentIfKind(SyntaxKind.VariableDeclarationList);
  const declKeyword = list?.getDeclarationKind() ?? "const";
  const name = node.getName();
  const typeNode = node.getTypeNode();

  if (typeNode) {
    return capSignature(`${declKeyword} ${name}: ${typeNode.getText()}`);
  }

  const initializer = node.getInitializer();
  if (initializer) {
    return capSignature(`${declKeyword} ${name} = ${initializer.getText()}`);
  }

  return capSignature(`${declKeyword} ${name}`);
}

function renderPropertySignature(node: Node): string {
  if (!Node.isPropertyDeclaration(node) && !Node.isPropertySignature(node)) {
    return stripTrailingSemicolon(node.getText().trimEnd());
  }
  const typeNode = node.getTypeNode();
  if (typeNode) {
    // Reconstruct from modifiers + name + type so the initializer is dropped.
    const modifierText = node
      .getModifiers()
      .map((m) => m.getText())
      .join(" ");
    const nameNode = node.getNameNode().getText();
    const optional = "hasQuestionToken" in node && node.hasQuestionToken() ? "?" : "";
    const prefix = modifierText.length > 0 ? `${modifierText} ` : "";
    return `${prefix}${nameNode}${optional}: ${typeNode.getText()}`;
  }
  return stripTrailingSemicolon(node.getText().trimEnd());
}

function textBeforeFirstBrace(node: Node): string {
  const text = node.getText();
  const idx = text.indexOf("{");
  const prefix = idx === -1 ? text : text.slice(0, idx);
  return prefix.trimEnd();
}

function textBeforeBodyOrSemicolon(node: Node): string {
  const text = node.getText();
  const block = node.getFirstChildByKind(SyntaxKind.Block);
  if (block) {
    const start = block.getStart() - node.getStart();
    return text.slice(0, start).trimEnd();
  }
  return stripTrailingSemicolon(text.trimEnd());
}

function stripTrailingSemicolon(text: string): string {
  return text.endsWith(";") ? text.slice(0, -1).trimEnd() : text;
}

function capSignature(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SIGNATURE_CAP_CHARS) return collapsed;
  const room = SIGNATURE_CAP_CHARS - SIGNATURE_ELLIPSIS.length;
  return collapsed.slice(0, Math.max(0, room)) + SIGNATURE_ELLIPSIS;
}
