import type { SymbolRole } from "@symnav/core";

export type TypeScriptSymbolKind =
  | "class"
  | "interface"
  | "type-alias"
  | "enum"
  | "enum-member"
  | "namespace"
  | "function"
  | "function-implementation"
  | "function-overload-signature"
  | "method"
  | "method-implementation"
  | "method-declaration"
  | "method-overload-signature"
  | "constructor"
  | "constructor-implementation"
  | "constructor-overload-signature"
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
  "function-implementation": "callable",
  "function-overload-signature": "callable",
  method: "callable",
  "method-implementation": "callable",
  "method-declaration": "callable",
  "method-overload-signature": "callable",
  constructor: "callable",
  "constructor-implementation": "callable",
  "constructor-overload-signature": "callable",
  getter: "callable",
  setter: "callable",
  "call-signature": "callable",
  "construct-signature": "callable",
  variable: "value",
  property: "value",
  "default-export": "value",
  "enum-member": "value",
  "type-alias": "type",
  "index-signature": "type",
};

export function roleOf(kind: TypeScriptSymbolKind): SymbolRole {
  return ROLE_BY_KIND[kind];
}
