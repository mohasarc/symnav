import { UserFacingError } from "../errors.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { Header } from "../intermediate-representation/types.js";
import type { SymbolOverviewNode } from "../intermediate-representation/overview-tree.js";
import type { SymbolTargetPattern } from "./symbol-target-pattern.js";

export interface SymbolTargetCandidate {
  readonly symbol: SymbolOverviewNode;
  readonly canonicalId: string;
  readonly header: Header;
}

export class SymbolTargetNotFoundError extends UserFacingError {
  constructor(private readonly pattern: SymbolTargetPattern) {
    super();
    this.name = "SymbolTargetNotFoundError";
  }

  get reason(): string {
    return `no symbol target ${JSON.stringify(this.pattern.raw)} found`;
  }
}

export class AmbiguousSymbolTargetError extends UserFacingError {
  constructor(
    readonly pattern: SymbolTargetPattern,
    readonly candidates: readonly SymbolTargetCandidate[],
  ) {
    super();
    this.name = "AmbiguousSymbolTargetError";
  }

  get reason(): string {
    const candidateIds = this.candidates
      .map((candidate) => formatSymbolIdentity(candidate.symbol.identity))
      .join(", ");
    return `symbol target ${JSON.stringify(this.pattern.raw)} is ambiguous: ${candidateIds}`;
  }
}
