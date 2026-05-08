import type { LineRange, SymbolKind } from "@symnav/core";
import { Node } from "ts-morph";

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
