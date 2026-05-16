import { UserFacingError } from "../errors.js";

export class NotInWorkspaceError extends UserFacingError {
  constructor(private readonly startDir: string) {
    super();
    this.name = "NotInWorkspaceError";
  }

  get reason(): string {
    return `not in a git workspace (no .git found in or above ${this.startDir})`;
  }
}

export class FileNotFoundError extends UserFacingError {
  constructor(private readonly inputPath: string) {
    super();
    this.name = "FileNotFoundError";
  }

  get reason(): string {
    return `file not found: ${this.inputPath}`;
  }
}

export class IgnoredFileError extends UserFacingError {
  constructor(private readonly inputPath: string) {
    super();
    this.name = "IgnoredFileError";
  }

  get reason(): string {
    return `${this.inputPath} is ignored by .gitignore`;
  }
}

export class OutsideWorkspaceError extends UserFacingError {
  constructor(
    private readonly inputPath: string,
    private readonly workspaceRoot: string,
  ) {
    super();
    this.name = "OutsideWorkspaceError";
  }

  get reason(): string {
    return `${this.inputPath} is outside the workspace rooted at ${this.workspaceRoot}`;
  }
}
