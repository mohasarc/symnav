export class NotInWorkspaceError extends Error {
  readonly startDir: string;

  constructor(startDir: string) {
    super(`No git workspace found at or above ${startDir}.`);
    this.name = "NotInWorkspaceError";
    this.startDir = startDir;
  }
}
