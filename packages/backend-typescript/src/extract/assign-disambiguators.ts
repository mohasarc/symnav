import type { SymbolDecl, SymbolPathSegment } from "@symnav/core";

export function assignDisambiguators(siblings: readonly SymbolDecl[]): readonly SymbolDecl[] {
  const occurrencesByName = countByLeafName(siblings);
  const assignedCountsByName = new Map<string, number>();
  return siblings.map((sibling) => {
    const leafName = leafNameOf(sibling);
    const totalForName = occurrencesByName.get(leafName) ?? 0;
    const nextDisambiguator =
      totalForName >= 2 ? (assignedCountsByName.get(leafName) ?? 0) + 1 : undefined;
    if (nextDisambiguator !== undefined) {
      assignedCountsByName.set(leafName, nextDisambiguator);
    }
    return withDisambiguatedIdentity(sibling, nextDisambiguator);
  });
}

function leafNameOf(decl: SymbolDecl): string {
  const segments = decl.identity.segments;
  const last = segments[segments.length - 1];
  if (!last) {
    throw new Error("symbol identity has empty path");
  }
  return last.name;
}

function countByLeafName(siblings: readonly SymbolDecl[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sibling of siblings) {
    const name = leafNameOf(sibling);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function withDisambiguatedIdentity(
  decl: SymbolDecl,
  disambiguator: number | undefined,
): SymbolDecl {
  const updatedLeaf = updatedLeafSegment(decl.identity.segments, disambiguator);
  const depth = decl.identity.segments.length - 1;
  const childrenWithUpdatedPrefix =
    disambiguator === undefined
      ? decl.children
      : decl.children.map((child) => stampSegmentDisambiguator(child, depth, disambiguator));
  return {
    ...decl,
    identity: { ...decl.identity, segments: updatedLeaf },
    children: assignDisambiguators(childrenWithUpdatedPrefix),
  };
}

function stampSegmentDisambiguator(
  decl: SymbolDecl,
  index: number,
  disambiguator: number,
): SymbolDecl {
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
