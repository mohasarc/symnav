/**
 * Base class for user-facing backend errors. Each subclass carries the
 * `displayedPath` — the path string the CLI should echo back to the user when
 * formatting the failure (typically the user's original input, not a
 * normalized absolute path).
 */
export class BackendError extends Error {
  readonly displayedPath: string;
  constructor(message: string, displayedPath: string) {
    super(message);
    this.name = "BackendError";
    this.displayedPath = displayedPath;
  }
}

/** The requested file does not exist on disk (or in the workspace fs). */
export class FileNotFoundError extends BackendError {
  constructor(displayedPath: string) {
    super(`File not found: ${displayedPath}`, displayedPath);
    this.name = "FileNotFoundError";
  }
}

/** The requested path resolves outside the active workspace root. */
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

/** The requested path is matched by a `.gitignore` rule. */
export class IgnoredFileError extends BackendError {
  constructor(displayedPath: string) {
    super(`${displayedPath} is ignored by .gitignore`, displayedPath);
    this.name = "IgnoredFileError";
  }
}

/** No registered backend accepts the file's extension. */
export class UnsupportedFileError extends BackendError {
  readonly extension: string;
  constructor(displayedPath: string, extension: string) {
    super(`Unsupported file extension: ${extension}`, displayedPath);
    this.name = "UnsupportedFileError";
    this.extension = extension;
  }
}
