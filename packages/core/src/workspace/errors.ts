import { BackendError } from "../backend/errors.js";

export class NotInWorkspaceError extends Error {
  readonly startDir: string;
  constructor(startDir: string) {
    super(`No .git directory found at or above ${startDir}`);
    this.name = "NotInWorkspaceError";
    this.startDir = startDir;
  }
}

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
