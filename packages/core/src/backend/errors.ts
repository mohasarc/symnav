import { extname } from "node:path";

import { UserFacingError } from "../errors.js";
import { formatSymbolIdentity } from "../intermediate-representation/canonical-identity.js";
import type { SymbolIdentity } from "../intermediate-representation/symbol-identity.js";

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
