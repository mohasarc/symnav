import type { DaemonCommandName } from "./daemon-protocol.js";

export class DaemonRuntimeValues {
  private static readonly commandNames = new Set<DaemonCommandName>([
    "overview",
    "resolve",
    "def",
    "refs",
    "context",
    "graph",
    "stats",
    "help",
    "version",
    "unknown",
  ]);

  static isCommandName(value: unknown): value is DaemonCommandName {
    return this.commandNames.has(value as DaemonCommandName);
  }

  static isRequestId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  }
}
