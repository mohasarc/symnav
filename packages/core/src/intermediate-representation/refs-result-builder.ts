import type { PageRequest } from "../pagination/paginator.js";
import { Paginator } from "../pagination/paginator.js";
import type { ReferenceKind, RefsResult, SymbolReference } from "./references.js";
import type { SymbolIdentity } from "./symbol-identity.js";

export interface BuildRefsResultArgs {
  readonly identity: SymbolIdentity;
  readonly references: readonly SymbolReference[];
  readonly pageRequest: PageRequest;
  readonly fullLines: boolean;
}

export class RefsResultBuilder {
  constructor(private readonly args: BuildRefsResultArgs) {}

  build(): RefsResult {
    const sorted = [...this.args.references].sort(RefsResultBuilder.compareReferences);
    const { items, page, pageCount } = new Paginator(this.args.pageRequest).paginate(sorted);
    return {
      identity: this.args.identity,
      total: sorted.length,
      kindCounts: RefsResultBuilder.countKinds(sorted),
      page,
      pageCount,
      fullLines: this.args.fullLines,
      references: items,
    };
  }

  private static compareReferences(left: SymbolReference, right: SymbolReference): number {
    if (left.file !== right.file) {
      return left.file < right.file ? -1 : 1;
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    return left.matchStart - right.matchStart;
  }

  private static countKinds(
    references: readonly SymbolReference[],
  ): Readonly<Record<ReferenceKind, number>> {
    const counts: Record<ReferenceKind, number> = { usage: 0, import: 0, export: 0, type: 0 };
    for (const reference of references) {
      counts[reference.kind] += 1;
    }
    return counts;
  }
}
