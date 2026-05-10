import { extname } from "node:path";
import {
  FileNotFoundError,
  IgnoredFileError,
  NotInWorkspaceError,
  OutsideWorkspaceError,
  UnsupportedFileError,
} from "@symnav/core";

export interface FormatUserErrorContext {
  inputPath?: string;
  workspaceRoot?: string;
  cwd?: string;
}

export function formatUserError(err: unknown, ctx: FormatUserErrorContext): string | null {
  if (err instanceof FileNotFoundError && ctx.inputPath !== undefined) {
    return `Cannot answer: file not found: ${ctx.inputPath}.`;
  }
  if (err instanceof IgnoredFileError && ctx.inputPath !== undefined) {
    return `Cannot answer: ${ctx.inputPath} is ignored by .gitignore.`;
  }
  if (
    err instanceof OutsideWorkspaceError &&
    ctx.inputPath !== undefined &&
    ctx.workspaceRoot !== undefined
  ) {
    return `Cannot answer: ${ctx.inputPath} is outside the workspace rooted at ${ctx.workspaceRoot}.`;
  }
  if (err instanceof UnsupportedFileError && ctx.inputPath !== undefined) {
    const extension = extname(ctx.inputPath);
    return `Cannot answer: cannot read ${extension} files (${ctx.inputPath}).`;
  }
  if (err instanceof NotInWorkspaceError && ctx.cwd !== undefined) {
    return `Cannot answer: not in a git workspace (no .git found in or above ${ctx.cwd}).`;
  }
  return null;
}
