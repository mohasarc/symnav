import { UserFacingError } from "../errors.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { Signature, SymbolDecl } from "../intermediate-representation/types.js";
import type { SymbolTargetPattern } from "./symbol-target-pattern.js";

export interface SymbolTargetCandidate {
  readonly symbol: SymbolDecl;
  readonly canonicalId: string;
  readonly signature: Signature;
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
    private readonly pattern: SymbolTargetPattern,
    private readonly candidates: readonly SymbolTargetCandidate[],
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

  override render(): string {
    return [
      `Cannot answer: symbol target ${JSON.stringify(this.pattern.raw)} is ambiguous.`,
      "",
      "Candidates",
      ...this.candidates.flatMap((candidate, index) =>
        candidateLines(candidate, index === this.candidates.length - 1),
      ),
      "",
    ].join("\n");
  }
}

function candidateLines(candidate: SymbolTargetCandidate, isLast: boolean): string[] {
  const idPrefix = isLast ? "└── " : "├── ";
  const signaturePrefix = isLast ? "    " : "│   ";
  return [
    `${idPrefix}${candidate.canonicalId}`,
    ...candidate.signature.lines.map((line) => `${signaturePrefix}${line}`),
  ];
}
