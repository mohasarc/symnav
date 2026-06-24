import type { SymbolIdentity } from "./symbol-identity.js";
import type { SourceMatch } from "./source-match.js";

export type ReferenceKind = "usage" | "import" | "export" | "type";

export interface SymbolReference extends SourceMatch {
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
