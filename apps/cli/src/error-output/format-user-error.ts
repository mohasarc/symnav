import { extname } from "node:path";
import {
  FileNotFoundError,
  IgnoredFileError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";

export function formatUserError(err: FileNotFoundError, ctx: { inputPath: string }): string;
export function formatUserError(err: IgnoredFileError, ctx: { inputPath: string }): string;
export function formatUserError(
  err: OutsideWorkspaceError,
  ctx: { inputPath: string; workspaceRoot: string },
): string;
export function formatUserError(err: UnsupportedFileError, ctx: { inputPath: string }): string;
export function formatUserError(err: NotInWorkspaceError, ctx: { cwd: string }): string;
export function formatUserError(
  err:
    | FileNotFoundError
    | IgnoredFileError
    | OutsideWorkspaceError
    | UnsupportedFileError
    | NotInWorkspaceError,
  ctx: { inputPath?: string; workspaceRoot?: string; cwd?: string },
): string {
  if (err instanceof FileNotFoundError) {
    return `Cannot answer: file not found: ${ctx.inputPath}.`;
  }
  if (err instanceof IgnoredFileError) {
    return `Cannot answer: ${ctx.inputPath} is ignored by .gitignore.`;
  }
  if (err instanceof OutsideWorkspaceError) {
    return `Cannot answer: ${ctx.inputPath} is outside the workspace rooted at ${ctx.workspaceRoot}.`;
  }
  if (err instanceof UnsupportedFileError) {
    return `Cannot answer: cannot read ${extname(ctx.inputPath ?? "")} files (${ctx.inputPath}).`;
  }
  return `Cannot answer: not in a git workspace (no .git found in or above ${ctx.cwd}).`;
}
