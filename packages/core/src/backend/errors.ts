export class BackendError extends Error {
  readonly displayedPath: string;
  constructor(message: string, displayedPath: string) {
    super(message);
    this.name = "BackendError";
    this.displayedPath = displayedPath;
  }
}

export class FileNotFoundError extends BackendError {
  constructor(displayedPath: string) {
    super(`File not found: ${displayedPath}`, displayedPath);
    this.name = "FileNotFoundError";
  }
}

export class OutsideWorkspaceError extends BackendError {
  readonly workspaceRoot: string;
  constructor(displayedPath: string, workspaceRoot: string) {
    super(
      `Path ${displayedPath} is outside the workspace rooted at ${workspaceRoot}`,
      displayedPath,
    );
    this.name = "OutsideWorkspaceError";
    this.workspaceRoot = workspaceRoot;
  }
}

export class IgnoredFileError extends BackendError {
  constructor(displayedPath: string) {
    super(`${displayedPath} is ignored by .gitignore`, displayedPath);
    this.name = "IgnoredFileError";
  }
}

export class UnsupportedFileError extends BackendError {
  readonly extension: string;
  constructor(displayedPath: string, extension: string) {
    super(`Unsupported file extension: ${extension}`, displayedPath);
    this.name = "UnsupportedFileError";
    this.extension = extension;
  }
}
