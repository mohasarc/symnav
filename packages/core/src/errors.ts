/**
 * Thrown when `createWorkspace` cannot find a `.git` ancestor walking upward
 * from `startDir`. Surfaced by the CLI as the "not in a git workspace" user
 * error.
 */
export class NotInWorkspaceError extends Error {
  readonly startDir: string;
  constructor(startDir: string) {
    super(`No .git directory found at or above ${startDir}`);
    this.name = "NotInWorkspaceError";
    this.startDir = startDir;
  }
}
