const commandNames = [
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
] as const;

export type DaemonCommandName = (typeof commandNames)[number];

export class DaemonCommandNames {
  static is(value: unknown): value is DaemonCommandName {
    return commandNames.includes(value as DaemonCommandName);
  }

  static parse(value: unknown): DaemonCommandName {
    if (!this.is(value)) throw new Error("Invalid daemon command name");
    return value;
  }
}

export const DAEMON_COMMAND_NAMES = Object.freeze(commandNames);

export interface DaemonReadinessProbe {
  readonly commandName: DaemonCommandName;
  readonly argv: readonly string[];
}
