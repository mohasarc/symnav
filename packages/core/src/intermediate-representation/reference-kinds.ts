import type { ReferenceKind, SymbolReference } from "./references.js";

export function countReferenceKinds(
  references: readonly SymbolReference[],
): Readonly<Record<ReferenceKind, number>> {
  const counts: Record<ReferenceKind, number> = { usage: 0, import: 0, export: 0, type: 0 };
  for (const reference of references) {
    counts[reference.kind] += 1;
  }
  return counts;
}
