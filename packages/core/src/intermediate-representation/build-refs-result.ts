import type { PageRequest } from "../pagination/paginate.js";
import { paginate } from "../pagination/paginate.js";
import type { Reference, ReferenceKind, RefsResult } from "./references.js";
import type { SymbolIdentity } from "./symbol-identity.js";

export interface BuildRefsResultArgs {
  readonly identity: SymbolIdentity;
  readonly references: readonly Reference[];
  readonly pageRequest: PageRequest;
  readonly fullLines: boolean;
}

export function buildRefsResult(args: BuildRefsResultArgs): RefsResult {
  const sorted = [...args.references].sort(compareReferences);
  const { items, page, pageCount } = paginate(sorted, args.pageRequest);
  return {
    identity: args.identity,
    total: sorted.length,
    kindCounts: countKinds(sorted),
    page,
    pageCount,
    fullLines: args.fullLines,
    references: items,
  };
}

function compareReferences(left: Reference, right: Reference): number {
  if (left.file !== right.file) {
    return left.file < right.file ? -1 : 1;
  }
  if (left.line !== right.line) {
    return left.line - right.line;
  }
  return left.matchStart - right.matchStart;
}

function countKinds(references: readonly Reference[]): Readonly<Record<ReferenceKind, number>> {
  const counts: Record<ReferenceKind, number> = { usage: 0, import: 0, export: 0, type: 0 };
  for (const reference of references) {
    counts[reference.kind] += 1;
  }
  return counts;
}
