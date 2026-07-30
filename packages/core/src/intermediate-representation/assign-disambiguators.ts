import type { SymbolPathSegment } from "./symbol-identity.js";
import type { OverviewNode, SymbolOverviewNode } from "./overview-tree.js";

export function assignDisambiguators(
  siblings: readonly SymbolOverviewNode[],
): readonly SymbolOverviewNode[] {
  return assignSymbolDisambiguators(siblings) as readonly SymbolOverviewNode[];
}

export function assignOverviewDisambiguators(
  siblings: readonly OverviewNode[],
): readonly OverviewNode[] {
  return assignSymbolDisambiguators(siblings);
}

type DisambiguatedSymbol = SymbolOverviewNode | SymbolOverviewNode;
type DisambiguatedNode = DisambiguatedSymbol | OverviewNode;

function assignSymbolDisambiguators<T extends DisambiguatedNode>(
  siblings: readonly T[],
): readonly T[] {
  const occurrencesByName = countByOwnName(transparentScopeSymbols(siblings));
  const assignedCountsByName = new Map<string, number>();
  return siblings.map((sibling) =>
    assignNodeInScope(sibling, occurrencesByName, assignedCountsByName),
  ) as readonly T[];
}

function isSymbolNode(node: DisambiguatedNode): node is DisambiguatedSymbol {
  return "identity" in node;
}

function ownNameOf(decl: DisambiguatedSymbol): string {
  const segments = decl.identity.segments;
  const last = segments[segments.length - 1];
  if (!last) {
    throw new Error("symbol identity has empty path");
  }
  return last.name;
}

function countByOwnName(siblings: readonly DisambiguatedSymbol[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sibling of siblings) {
    const name = ownNameOf(sibling);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function transparentScopeSymbols(
  siblings: readonly DisambiguatedNode[],
): readonly DisambiguatedSymbol[] {
  return siblings.flatMap((sibling) => {
    if (isSymbolNode(sibling)) return [sibling];
    if (sibling.type === "re-export") return [];
    return transparentScopeSymbols(sibling.children);
  });
}

function assignNodeInScope<T extends DisambiguatedNode>(
  node: T,
  occurrencesByName: ReadonlyMap<string, number>,
  assignedCountsByName: Map<string, number>,
): T {
  if (!isSymbolNode(node)) {
    if (node.type === "re-export") {
      return node;
    }
    return {
      ...node,
      children: node.children.map((child) =>
        assignNodeInScope(child, occurrencesByName, assignedCountsByName),
      ),
    };
  }
  const ownName = ownNameOf(node);
  const totalForName = occurrencesByName.get(ownName) ?? 0;
  const nextDisambiguator =
    totalForName >= 2 ? (assignedCountsByName.get(ownName) ?? 0) + 1 : undefined;
  if (nextDisambiguator !== undefined) {
    assignedCountsByName.set(ownName, nextDisambiguator);
  }
  return withDisambiguatedIdentity(node, nextDisambiguator) as T;
}

function withDisambiguatedIdentity(
  decl: DisambiguatedSymbol,
  disambiguator: number | undefined,
): DisambiguatedSymbol {
  const updatedLeaf = updatedLeafSegment(decl.identity.segments, disambiguator);
  const depth = decl.identity.segments.length - 1;
  const childrenWithUpdatedPrefix =
    disambiguator === undefined
      ? decl.children
      : decl.children.map((child) => stampSegmentDisambiguator(child, depth, disambiguator));
  return {
    ...decl,
    identity: { ...decl.identity, segments: updatedLeaf },
    children: assignSymbolDisambiguators(childrenWithUpdatedPrefix),
  };
}

function stampSegmentDisambiguator(
  decl: DisambiguatedNode,
  index: number,
  disambiguator: number,
): DisambiguatedNode {
  if (!isSymbolNode(decl)) {
    if (decl.type === "re-export") {
      return decl;
    }
    return {
      ...decl,
      children: decl.children.map((child) =>
        stampSegmentDisambiguator(child, index, disambiguator),
      ),
    };
  }
  const stampedSegments = decl.identity.segments.map((segment, position) =>
    position === index ? { name: segment.name, disambiguator } : segment,
  );
  return {
    ...decl,
    identity: { ...decl.identity, segments: stampedSegments },
    children: decl.children.map((child) => stampSegmentDisambiguator(child, index, disambiguator)),
  };
}

function updatedLeafSegment(
  path: readonly SymbolPathSegment[],
  disambiguator: number | undefined,
): readonly SymbolPathSegment[] {
  if (path.length === 0) {
    throw new Error("symbol identity has empty path");
  }
  const leadingSegments = path.slice(0, -1);
  const lastSegment = path[path.length - 1]!;
  const updatedLast: SymbolPathSegment =
    disambiguator === undefined
      ? { name: lastSegment.name }
      : { name: lastSegment.name, disambiguator };
  return [...leadingSegments, updatedLast];
}
