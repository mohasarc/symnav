import type { SymbolIdentity } from "./symbol-identity.js";
import type { LineRange, ResultWithDiagnostics, Header, SymbolKind } from "./types.js";

export type OverviewNode = SymbolOverviewNode | FoldOverviewNode | ReExportOverviewNode;

export interface OverviewNodeBase {
  readonly range: LineRange;
  readonly header: Header;
}

export interface SymbolOverviewNode extends OverviewNodeBase {
  readonly type: "symbol";
  readonly identity: SymbolIdentity;
  readonly kind: SymbolKind;
  readonly children: readonly OverviewNode[];
}

export interface FoldOverviewNode extends OverviewNodeBase {
  readonly type: "fold";
  readonly foldKind: string;
  readonly children: readonly OverviewNode[];
}

export interface ReExportOverviewNode extends OverviewNodeBase {
  readonly type: "re-export";
  readonly exportKind: string;
  readonly exportedNames: readonly string[];
  readonly sourceModule: string | undefined;
}

export interface OverviewFileEntries extends ResultWithDiagnostics {
  readonly file: string;
  readonly entries: readonly OverviewNode[];
}

export class OverviewTree {
  static symbol(
    fields: Omit<SymbolOverviewNode, "type" | "children"> &
      Partial<Pick<SymbolOverviewNode, "children">>,
  ): SymbolOverviewNode {
    return { type: "symbol", ...fields, children: fields.children ?? [] };
  }

  static fold(
    fields: Omit<FoldOverviewNode, "type" | "children"> &
      Partial<Pick<FoldOverviewNode, "children">>,
  ): FoldOverviewNode {
    return { type: "fold", ...fields, children: fields.children ?? [] };
  }

  static reExport(fields: Omit<ReExportOverviewNode, "type">): ReExportOverviewNode {
    return { type: "re-export", ...fields };
  }

  static walkSymbols(entries: readonly OverviewNode[]): readonly SymbolOverviewNode[] {
    const symbols: SymbolOverviewNode[] = [];
    for (const entry of entries) {
      OverviewTree.collectSymbols(entry, symbols);
    }
    return symbols;
  }

  static directSymbolChildren(nodes: readonly OverviewNode[]): readonly SymbolOverviewNode[] {
    return nodes.filter((node): node is SymbolOverviewNode => node.type === "symbol");
  }

  static directFolds(nodes: readonly OverviewNode[]): readonly FoldOverviewNode[] {
    return nodes.filter((node): node is FoldOverviewNode => node.type === "fold");
  }

  static scopeSymbols(siblings: readonly OverviewNode[]): readonly SymbolOverviewNode[] {
    return siblings.flatMap((sibling) => {
      if (sibling.type === "symbol") return [sibling];
      if (sibling.type === "re-export") return [];
      return OverviewTree.scopeSymbols(sibling.children);
    });
  }

  static ownName(symbol: SymbolOverviewNode): string {
    const segments = symbol.identity.segments;
    return segments[segments.length - 1]?.name ?? "";
  }

  private static collectSymbols(node: OverviewNode, symbols: SymbolOverviewNode[]): void {
    if (node.type === "re-export") {
      return;
    }
    if (node.type === "symbol") {
      symbols.push(node);
    }
    for (const child of node.children) {
      OverviewTree.collectSymbols(child, symbols);
    }
  }
}
