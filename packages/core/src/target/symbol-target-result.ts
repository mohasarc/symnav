import { UserFacingError } from "../errors.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { Header } from "../intermediate-representation/types.js";
import type { SymbolOverviewNode } from "../intermediate-representation/overview-tree.js";

export interface SymbolTargetCandidate {
  readonly symbol: SymbolOverviewNode;
  readonly canonicalId: string;
  readonly header: Header;
}

export class InvalidSymbolTargetError extends UserFacingError {
  constructor(
    private readonly explanation: string,
    private readonly raw: string,
  ) {
    super();
    this.name = "InvalidSymbolTargetError";
  }

  get reason(): string {
    return `invalid symbol target (${this.explanation}): ${JSON.stringify(this.raw)}`;
  }
}

export class InvalidSymbolTargetRequestError extends UserFacingError {
  constructor(readonly explanation: string) {
    super();
    this.name = "InvalidSymbolTargetRequestError";
  }

  get reason(): string {
    return this.explanation;
  }
}

export class SymbolTargetNotFoundError extends UserFacingError {
  constructor(readonly rawTarget: string) {
    super();
    this.name = "SymbolTargetNotFoundError";
  }

  get reason(): string {
    return `no symbol target ${JSON.stringify(this.rawTarget)} found`;
  }
}

export class SymbolTargetLineMismatchError extends UserFacingError {
  constructor(
    readonly rawTarget: string,
    readonly line: number,
  ) {
    super();
    this.name = "SymbolTargetLineMismatchError";
  }

  get reason(): string {
    return `no symbol target ${JSON.stringify(this.rawTarget)} matching line ${this.line}`;
  }
}

export class AmbiguousSymbolTargetError extends UserFacingError {
  constructor(
    readonly rawTarget: string,
    readonly candidates: readonly SymbolTargetCandidate[],
  ) {
    super();
    this.name = "AmbiguousSymbolTargetError";
  }

  get reason(): string {
    const candidateIds = this.candidates
      .map((candidate) => formatSymbolIdentity(candidate.symbol.identity))
      .join(", ");
    return `symbol target ${JSON.stringify(this.rawTarget)} is ambiguous: ${candidateIds}`;
  }
}
