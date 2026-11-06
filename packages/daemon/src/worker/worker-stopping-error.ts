export class DaemonWorkerStoppingError extends Error {
  public constructor() {
    super("Navigation worker is stopping");
    this.name = "DaemonWorkerStoppingError";
  }
}
