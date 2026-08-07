import type { SymbolPathSegment } from "./symbol-identity.js";
import { OverviewTree, type OverviewNode, type SymbolOverviewNode } from "./overview-tree.js";

export function assignDisambiguators(siblings: readonly OverviewNode[]): readonly OverviewNode[] {
  const occurrencesByName = countByOwnName(OverviewTree.scopeSymbols(siblings));
  const assignedCountsByName = new Map<string, number>();
  return siblings.map((sibling) =>
    assignWithinScope(sibling, occurrencesByName, assignedCountsByName),
  );
}

function countByOwnName(symbols: readonly SymbolOverviewNode[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const symbol of symbols) {
    const name = OverviewTree.ownName(symbol);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function assignWithinScope(
  node: OverviewNode,
  occurrencesByName: ReadonlyMap<string, number>,
  assignedCountsByName: Map<string, number>,
): OverviewNode {
  if (node.type === "re-export") {
    return node;
  }
  if (node.type === "fold") {
    return {
      ...node,
      children: node.children.map((child) =>
        assignWithinScope(child, occurrencesByName, assignedCountsByName),
      ),
    };
  }
  const name = OverviewTree.ownName(node);
  const totalForName = occurrencesByName.get(name) ?? 0;
  const disambiguator = totalForName >= 2 ? (assignedCountsByName.get(name) ?? 0) + 1 : undefined;
  if (disambiguator !== undefined) {
    assignedCountsByName.set(name, disambiguator);
  }
  return disambiguatedSymbol(node, disambiguator);
}

function disambiguatedSymbol(
  symbol: SymbolOverviewNode,
  disambiguator: number | undefined,
): SymbolOverviewNode {
  const leafIndex = symbol.identity.segments.length - 1;
  const children =
    disambiguator === undefined
      ? symbol.children
      : symbol.children.map((child) => stampAncestorDisambiguator(child, leafIndex, disambiguator));
  return {
    ...symbol,
    identity: {
      ...symbol.identity,
      segments: withLeafDisambiguator(symbol.identity.segments, disambiguator),
    },
    children: assignDisambiguators(children),
  };
}

function stampAncestorDisambiguator(
  node: OverviewNode,
  index: number,
  disambiguator: number,
): OverviewNode {
  if (node.type === "re-export") {
    return node;
  }
  const children = node.children.map((child) =>
    stampAncestorDisambiguator(child, index, disambiguator),
  );
  if (node.type === "fold") {
    return { ...node, children };
  }
  const segments = node.identity.segments.map((segment, position) =>
    position === index ? { name: segment.name, disambiguator } : segment,
  );
  return { ...node, identity: { ...node.identity, segments }, children };
}

function withLeafDisambiguator(
  path: readonly SymbolPathSegment[],
  disambiguator: number | undefined,
): readonly SymbolPathSegment[] {
  const leaf = path[path.length - 1];
  if (!leaf) {
    return path;
  }
  const updatedLeaf: SymbolPathSegment =
    disambiguator === undefined ? { name: leaf.name } : { name: leaf.name, disambiguator };
  return [...path.slice(0, -1), updatedLeaf];
}
