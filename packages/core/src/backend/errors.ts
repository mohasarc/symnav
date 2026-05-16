import { extname } from "node:path";

import { UserFacingError } from "../errors.js";

export class UnsupportedFileError extends UserFacingError {
  constructor(private readonly inputPath: string) {
    super();
    this.name = "UnsupportedFileError";
  }

  get reason(): string {
    return `cannot read ${extname(this.inputPath)} files (${this.inputPath})`;
  }
}
