import type { SymbolRole } from "@symnav/core";

export type TypeScriptSymbolKind =
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "namespace"
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "property"
  | "variable"
  | "default-export"
  | "index-signature"
  | "call-signature"
  | "construct-signature";

const ROLE_BY_KIND: Record<TypeScriptSymbolKind, SymbolRole> = {
  class: "container",
  interface: "container",
  enum: "container",
  namespace: "container",
  function: "callable",
  method: "callable",
  constructor: "callable",
  getter: "callable",
  setter: "callable",
  "call-signature": "callable",
  "construct-signature": "callable",
  variable: "value",
  property: "value",
  "default-export": "value",
  "type-alias": "type",
  "index-signature": "type",
};

export function roleOf(kind: TypeScriptSymbolKind): SymbolRole {
  return ROLE_BY_KIND[kind];
}
