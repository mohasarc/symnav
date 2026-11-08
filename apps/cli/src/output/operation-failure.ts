import { CommandErrorLine } from "./command-error-line.js";

export const OPERATION_FAILURE_EXIT_CODE = 2;

interface SystemError extends Error {
  readonly code: string;
  readonly path: string;
}

export class OperationFailure {
  public static render(action: string, error: unknown): string {
    return CommandErrorLine.render(`cannot ${action}: ${OperationFailure.reasonFor(error)}`);
  }

  private static reasonFor(error: unknown): string {
    if (OperationFailure.isSystemError(error)) return `cannot access ${error.path} (${error.code})`;
    return error instanceof Error ? error.message : String(error);
  }

  private static isSystemError(error: unknown): error is SystemError {
    if (!(error instanceof Error)) return false;
    const { code, path } = error as Partial<SystemError>;
    return typeof code === "string" && typeof path === "string";
  }
}
