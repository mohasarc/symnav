import type { DaemonStateWriteFailure } from "./state-write-failure.js";

class DaemonStateWriteError extends Error {
  public readonly code: string | undefined;
  public readonly path: string;
  public readonly syscall: string | undefined;

  public constructor(
    public readonly failure: DaemonStateWriteFailure,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "Required state write failed", { cause });
    this.code = failure.osCode;
    this.path = failure.path;
    this.syscall = (cause as NodeJS.ErrnoException | undefined)?.syscall;
  }
}

export class DaemonStateWriteErrors {
  public static from(error: unknown, fallbackPath?: string): DaemonStateWriteFailure | undefined {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      seen.add(current);
      if (current instanceof DaemonStateWriteError) return current.failure;
      const failure = current as NodeJS.ErrnoException;
      if (
        failure.syscall !== undefined &&
        /^(mkdir|write|rename|unlink|rmdir|chmod|fsync)/u.test(failure.syscall)
      ) {
        const path = failure.path ?? fallbackPath;
        if (path !== undefined)
          return { path, ...(failure.code === undefined ? {} : { osCode: failure.code }) };
      }
      current = "cause" in current ? current.cause : undefined;
    }
    return undefined;
  }

  public static failedWrite(path: string, error: unknown): Error {
    const failure = error as NodeJS.ErrnoException | undefined;
    const osCode = failure?.code;
    return new DaemonStateWriteError(
      { path: failure?.path ?? path, ...(typeof osCode === "string" ? { osCode } : {}) },
      error,
    );
  }

  public static isFailure(value: unknown): value is DaemonStateWriteFailure {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const failure = value as Record<string, unknown>;
    const keys = Object.keys(failure);
    return (
      typeof failure.path === "string" &&
      failure.path.length > 0 &&
      keys.every((key) => key === "path" || key === "osCode") &&
      (failure.osCode === undefined || typeof failure.osCode === "string")
    );
  }
}
