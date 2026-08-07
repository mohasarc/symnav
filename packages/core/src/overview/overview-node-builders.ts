import type {
  FoldOverviewNode,
  SymbolOverviewNode,
} from "../intermediate-representation/overview-tree.js";
import type { Header } from "../intermediate-representation/types.js";
import { OverviewTree } from "../intermediate-representation/overview-tree.js";

export function symbol(
  name: string,
  partial: Partial<Pick<SymbolOverviewNode, "range" | "header" | "children" | "identity">> = {},
): SymbolOverviewNode {
  const range = partial.range ?? { startLine: 1, endLine: 1 };
  return OverviewTree.symbol({
    identity: partial.identity ?? { file: "src/file.ts", segments: [{ name }] },
    kind: { role: "value", nativeLabel: "function" },
    range,
    header: partial.header ?? header(range.startLine, `function ${name}(): void`),
    children: partial.children ?? [],
  });
}

export function fold(
  headerText: string,
  partial: Partial<Pick<FoldOverviewNode, "range" | "children" | "headerVariants">> = {},
): FoldOverviewNode {
  const range = partial.range ?? { startLine: 1, endLine: 3 };
  const node = OverviewTree.fold({
    foldKind: "block",
    range,
    header: header(range.startLine, headerText),
    children: partial.children ?? [],
  });
  if (partial.headerVariants === undefined) return node;
  return { ...node, headerVariants: partial.headerVariants };
}

export function header(startLine: number, ...lines: string[]): Header {
  return { startLine, lines };
}
