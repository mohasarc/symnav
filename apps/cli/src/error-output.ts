import {
  FileNotFoundError,
  IgnoredFileError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";

/**
 * Format a known user-facing error as the spec's `Cannot answer: <reason>.`
 * single-line voice (with trailing period, no trailing newline).
 *
 * Returns `null` for any error this formatter does not own, so the caller can
 * decide what to do with unexpected errors (typically: rethrow / exit 2).
 */
export function formatUserError(err: unknown): string | null {
  if (err instanceof FileNotFoundError) {
    return `Cannot answer: file not found: ${err.displayedPath}.`;
  }
  if (err instanceof OutsideWorkspaceError) {
    return `Cannot answer: ${err.displayedPath} is outside the workspace rooted at ${err.workspaceRoot}.`;
  }
  if (err instanceof IgnoredFileError) {
    return `Cannot answer: ${err.displayedPath} is ignored by .gitignore.`;
  }
  if (err instanceof UnsupportedFileError) {
    return `Cannot answer: ${err.extension} files are not supported.`;
  }
  if (err instanceof NotInWorkspaceError) {
    return `Cannot answer: not in a git workspace (no .git ancestor of ${err.startDir}).`;
  }
  return null;
}
