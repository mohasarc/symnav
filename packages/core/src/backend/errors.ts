import { extname } from "node:path";

import { UserFacingError } from "../errors.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";
import type { SymbolOverviewNode } from "../intermediate-representation/overview-tree.js";

export class UnsupportedFileError extends UserFacingError {
  constructor(private readonly inputPath: string) {
    super();
    this.name = "UnsupportedFileError";
  }

  get reason(): string {
    const extension = extname(this.inputPath);
    if (extension === "") {
      return `${this.inputPath} has no file extension; expected a source file`;
    }
    return `cannot read ${extension} files (${this.inputPath})`;
  }
}

export class NoSupportedFilesError extends UserFacingError {
  constructor() {
    super();
    this.name = "NoSupportedFilesError";
  }

  get reason(): string {
    return "workspace contains no files supported by any language backend";
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
    private readonly candidates: readonly SymbolOverviewNode[],
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

export class InvalidRegexError extends UserFacingError {
  constructor(
    readonly pattern: string,
    readonly detail: string,
  ) {
    super();
    this.name = "InvalidRegexError";
  }

  get reason(): string {
    return `invalid regex ${JSON.stringify(this.pattern)}: ${this.detail}`;
  }
}

export class InvalidResolveRegexError extends UserFacingError {
  constructor(
    readonly pattern: string,
    readonly detail: string,
  ) {
    super();
    this.name = "InvalidResolveRegexError";
  }

  get reason(): string {
    return `invalid resolve regex ${JSON.stringify(this.pattern)}: ${this.detail}`;
  }
}
