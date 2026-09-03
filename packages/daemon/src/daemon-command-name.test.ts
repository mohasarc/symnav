import { describe, expect, it } from "vitest";

import {
  DAEMON_COMMAND_NAMES,
  DaemonCommandNames,
  type DaemonCommandName,
} from "./daemon-command-name.js";

describe("DaemonCommandNames", () => {
  it("accepts exactly the closed command vocabulary", () => {
    expect(DAEMON_COMMAND_NAMES).toEqual([
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
    for (const commandName of DAEMON_COMMAND_NAMES) {
      expect(DaemonCommandNames.is(commandName)).toBe(true);
      expect(DaemonCommandNames.parse(commandName)).toBe(commandName);
    }
  });

  it.each([undefined, null, 1, "", "daemon", "start", "Overview"])(
    "rejects the value %j",
    (value) => {
      expect(DaemonCommandNames.is(value)).toBe(false);
      expect(() => DaemonCommandNames.parse(value)).toThrow("Invalid daemon command name");
    },
  );

  it("publishes an immutable tuple", () => {
    expect(Object.isFrozen(DAEMON_COMMAND_NAMES)).toBe(true);
    expect(() =>
      (DAEMON_COMMAND_NAMES as unknown as DaemonCommandName[]).push("unknown"),
    ).toThrow(TypeError);
  });
});
