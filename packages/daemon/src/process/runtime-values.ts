import { DAEMON_COMMAND_NAMES, type DaemonCommandName } from "@symnav/daemon";

export class DaemonRuntimeValues {
  static isCommandName(value: unknown): value is DaemonCommandName {
    return DAEMON_COMMAND_NAMES.includes(value as DaemonCommandName);
  }

  static isRequestId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
  }
}
