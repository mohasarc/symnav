export class BackendError extends Error {}

export class FileNotFoundError extends BackendError {
  constructor() {
    super("file-not-found");
    this.name = "FileNotFoundError";
  }
}

export class IgnoredFileError extends BackendError {
  constructor() {
    super("ignored-file");
    this.name = "IgnoredFileError";
  }
}

export class OutsideWorkspaceError extends BackendError {
  constructor() {
    super("outside-workspace");
    this.name = "OutsideWorkspaceError";
  }
}

export class UnsupportedFileError extends BackendError {
  constructor() {
    super("unsupported-file");
    this.name = "UnsupportedFileError";
  }
}
