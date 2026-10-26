export class DaemonProcessLifetimeCreationError extends Error {
  public readonly code: string | undefined;
  public readonly path: string | undefined;

  public static from(error: unknown): DaemonProcessLifetimeCreationError | undefined {
    const seen = new Set<unknown>();
    let current = error;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      if (current instanceof DaemonProcessLifetimeCreationError) return current;
      seen.add(current);
      current = "cause" in current ? current.cause : undefined;
    }
    return undefined;
  }

  public constructor(cause: unknown) {
    super("Daemon endpoint lifetime creation failed", { cause });
    this.name = "DaemonProcessLifetimeCreationError";
    const original = cause as NodeJS.ErrnoException | undefined;
    this.code = original?.code;
    this.path = original?.path;
  }
}
