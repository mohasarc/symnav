export type SymbolKind =
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

export interface LineRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface SymbolDecl {
  readonly kind: SymbolKind;
  readonly name: string;
  readonly range: LineRange;
  readonly signature: string;
  readonly children: readonly SymbolDecl[];
}

export interface FileSymbols {
  readonly filePath: string;
  readonly symbols: readonly SymbolDecl[];
}
