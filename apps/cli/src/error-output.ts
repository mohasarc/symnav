import {
  BackendError,
  FileNotFoundError,
  IgnoredFileError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";

export function formatUserError(err: unknown): string | null {
  if (err instanceof FileNotFoundError) {
    return `Cannot answer: file not found: ${err.displayedPath}.`;
  }
  if (err instanceof OutsideWorkspaceError) {
    return `Cannot answer: ${err.displayedPath} is outside the workspace (${err.workspaceRoot}).`;
  }
  if (err instanceof IgnoredFileError) {
    return `Cannot answer: ${err.displayedPath} is ignored by .gitignore.`;
  }
  if (err instanceof UnsupportedFileError) {
    return `Cannot answer: unsupported file type ${err.extension}: ${err.displayedPath}.`;
  }
  if (err instanceof BackendError) {
    return `Cannot answer: ${err.message}.`;
  }
  if (err instanceof NotInWorkspaceError) {
    return `Cannot answer: not in a git workspace (no .git found at or above ${err.startDir}).`;
  }
  return null;
}
