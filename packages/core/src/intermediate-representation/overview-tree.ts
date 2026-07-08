import type { SymbolIdentity } from "./symbol-identity.js";
import type { LineRange, ResultWithDiagnostics, Signature, SymbolKind } from "./types.js";

export type OverviewNode = SymbolOverviewNode | FoldOverviewNode | ReExportOverviewNode;

export interface OverviewNodeBase {
  readonly range: LineRange;
  readonly header: Signature;
  readonly children: readonly OverviewNode[];
}

export interface SymbolOverviewNode extends OverviewNodeBase {
  readonly type: "symbol";
  readonly identity: SymbolIdentity;
  readonly kind: SymbolKind;
}

export type FoldKind =
  | "call"
  | "block"
  | "loop"
  | "conditional"
  | "switch"
  | "try"
  | "catch"
  | "finally"
  | "callback";

export interface FoldOverviewNode extends OverviewNodeBase {
  readonly type: "fold";
  readonly foldKind: FoldKind;
}

export interface ReExportOverviewNode extends OverviewNodeBase {
  readonly type: "re-export";
  readonly exportKind: "named" | "namespace" | "star";
  readonly exportedNames: readonly string[];
  readonly sourceModule: string | undefined;
}

export interface OverviewFileSymbols extends ResultWithDiagnostics {
  readonly file: string;
  readonly entries: readonly OverviewNode[];
}

export function walkOverviewSymbols(
  entries: readonly OverviewNode[],
): readonly SymbolOverviewNode[] {
  const symbols: SymbolOverviewNode[] = [];
  for (const entry of entries) {
    collectSymbols(entry, symbols);
  }
  return symbols;
}

function collectSymbols(node: OverviewNode, symbols: SymbolOverviewNode[]): void {
  if (node.type === "symbol") {
    symbols.push(node);
  }
  for (const child of node.children) {
    collectSymbols(child, symbols);
  }
}
