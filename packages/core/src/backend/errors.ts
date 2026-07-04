import { extname } from "node:path";

import { UserFacingError } from "../errors.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type { SymbolDecl } from "../intermediate-representation/types.js";

export class UnsupportedFileError extends UserFacingError {
  constructor(private readonly inputPath: string) {
    super();
    this.name = "UnsupportedFileError";
  }

  get reason(): string {
    return `cannot read ${extname(this.inputPath)} files (${this.inputPath})`;
  }
}

export class SymbolNotFoundError extends UserFacingError {
  constructor(private readonly identity: SymbolIdentity) {
    super();
    this.name = "SymbolNotFoundError";
  }

  get reason(): string {
    return `no symbol ${formatSymbolIdentity(this.identity)} found`;
  }
}

export class AmbiguousSymbolError extends UserFacingError {
  constructor(
    private readonly identity: SymbolIdentity,
    private readonly candidates: readonly SymbolDecl[],
  ) {
    super();
    this.name = "AmbiguousSymbolError";
  }

  get reason(): string {
    const candidateIds = this.candidates
      .map((candidate) => formatSymbolIdentity(candidate.identity))
      .join(", ");
    return `symbol ${formatSymbolIdentity(this.identity)} matches multiple implementations: ${candidateIds} — query one directly`;
  }
}
