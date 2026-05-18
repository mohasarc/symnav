import { Node } from "ts-morph";

import type { TypeScriptSymbolKind } from "./typescript-symbol-kind.js";

export function refineLabel(node: Node, baseKind: TypeScriptSymbolKind): TypeScriptSymbolKind {
  if (baseKind === "method") {
    return refineMethodLabel(node);
  }
  if (baseKind === "function") {
    return refineOverloadableLabel(node, "function-implementation", "function-overload-signature");
  }
  if (baseKind === "constructor") {
    return refineOverloadableLabel(
      node,
      "constructor-implementation",
      "constructor-overload-signature",
    );
  }
  return baseKind;
}

function refineMethodLabel(node: Node): TypeScriptSymbolKind {
  if (Node.isMethodSignature(node)) {
    return "method-declaration";
  }
  if (Node.isMethodDeclaration(node)) {
    if (!node.hasBody()) {
      return "method-declaration";
    }
    if (node.isOverload()) {
      return "method-overload-signature";
    }
    return "method-implementation";
  }
  return "method-implementation";
}

function refineOverloadableLabel(
  node: Node,
  implementationLabel: TypeScriptSymbolKind,
  overloadLabel: TypeScriptSymbolKind,
): TypeScriptSymbolKind {
  if (Node.isOverloadable(node) && node.isOverload()) {
    return overloadLabel;
  }
  return implementationLabel;
}
