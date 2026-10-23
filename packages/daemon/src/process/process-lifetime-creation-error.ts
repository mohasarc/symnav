export class DaemonProcessLifetimeCreationError extends Error {
  public readonly code: string | undefined;
  public readonly path: string | undefined;

  public constructor(cause: unknown) {
    super("Daemon endpoint lifetime creation failed", { cause });
    this.name = "DaemonProcessLifetimeCreationError";
    const original = cause as NodeJS.ErrnoException | undefined;
    this.code = original?.code;
    this.path = original?.path;
  }
}
