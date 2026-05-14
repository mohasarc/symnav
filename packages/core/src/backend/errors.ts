export class BackendError extends Error {}

export class UnsupportedFileError extends BackendError {
  constructor() {
    super("unsupported-file");
    this.name = "UnsupportedFileError";
  }
}
