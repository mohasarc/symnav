import type { SymbolIdentity } from "./symbol-identity.js";

export type ReferenceKind = "usage" | "import" | "export" | "type";

export interface SymbolReference {
  readonly file: string;
  readonly line: number;
  readonly previewSource: string;
  readonly matchStart: number;
  readonly matchEnd: number;
  readonly kind: ReferenceKind;
}

export interface RefsResult {
  readonly identity: SymbolIdentity;
  readonly total: number;
  readonly kindCounts: Readonly<Record<ReferenceKind, number>>;
  readonly page: number;
  readonly pageCount: number;
  readonly fullLines: boolean;
  readonly references: readonly SymbolReference[];
}
