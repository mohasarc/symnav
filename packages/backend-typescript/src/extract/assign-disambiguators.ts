import type { SymbolIdentity, SymbolPathSegment } from "@symnav/core";

interface IdentitySymbolDecl {
  readonly identity: SymbolIdentity;
  readonly children: readonly IdentitySymbolDecl[];
}

export function assignDisambiguators<T extends IdentitySymbolDecl>(
  siblings: readonly T[],
): readonly T[] {
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

function leafNameOf(decl: IdentitySymbolDecl): string {
  const segments = decl.identity.segments;
  const last = segments[segments.length - 1];
  if (!last) {
    throw new Error("symbol identity has empty path");
  }
  return last.name;
}

function countByLeafName(siblings: readonly IdentitySymbolDecl[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sibling of siblings) {
    const name = leafNameOf(sibling);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

function withDisambiguatedIdentity<T extends IdentitySymbolDecl>(
  decl: T,
  disambiguator: number | undefined,
): T {
  const updatedLeaf = updatedLeafSegment(decl.identity.segments, disambiguator);
  const updatedChildren = assignDisambiguators(decl.children);
  return {
    ...decl,
    identity: { ...decl.identity, segments: updatedLeaf },
    children: updatedChildren,
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
