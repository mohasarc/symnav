export type SymbolRole = "container" | "callable" | "value" | "type";

export interface SymbolKind {
  readonly role: SymbolRole;
  readonly nativeLabel: string;
}

export interface LineRange {
  readonly startLine: number; // 1-based, inclusive
  readonly endLine: number; // 1-based, inclusive; equals startLine for single-line decls
}

export interface Signature {
  readonly startLine: number; // 1-based source line of lines[0]
  readonly lines: readonly string[]; // each element single-line, no "\n"
}

export interface SymbolDecl {
  readonly kind: SymbolKind;
  readonly name: string;
  readonly range: LineRange;
  readonly signature: Signature;
  readonly children: readonly SymbolDecl[];
}

export interface FileSymbols {
  readonly filePath: string; // workspace-relative, POSIX separators
  readonly symbols: readonly SymbolDecl[]; // top-level entries, source order
}
