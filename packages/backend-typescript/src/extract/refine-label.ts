import { Node } from "ts-morph";

import type { TypeScriptSymbolKind } from "./typescript-symbol-kind.js";

export function refineLabel(node: Node, baseKind: TypeScriptSymbolKind): TypeScriptSymbolKind {
  if (baseKind === "method") {
    return refineMethodLabel(node);
  }
  if (baseKind === "function") {
    return refineFunctionLabel(node);
  }
  if (baseKind === "constructor") {
    return refineConstructorLabel(node);
  }
  return baseKind;
}

function refineMethodLabel(node: Node): TypeScriptSymbolKind {
  if (Node.isMethodSignature(node)) {
    return "method-declaration";
  }
  if (Node.isMethodDeclaration(node)) {
    if (node.isAbstract()) {
      return "method-declaration";
    }
    if (node.isOverload()) {
      return "method-overload-signature";
    }
    if (!node.hasBody()) {
      return "method-declaration";
    }
    return "method-implementation";
  }
  return "method-implementation";
}

function refineFunctionLabel(node: Node): TypeScriptSymbolKind {
  if (isOverloadSignature(node)) {
    return "function-overload-signature";
  }
  return "function-implementation";
}

function refineConstructorLabel(node: Node): TypeScriptSymbolKind {
  if (isOverloadSignature(node)) {
    return "constructor-overload-signature";
  }
  return "constructor-implementation";
}

function isOverloadSignature(node: Node): boolean {
  return Node.isOverloadable(node) && node.isOverload();
}
