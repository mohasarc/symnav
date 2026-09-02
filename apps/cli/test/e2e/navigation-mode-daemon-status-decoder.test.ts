import { describe, expect, it } from "vitest";
import { NavigationModeDaemonStatusDecoder } from "./run-navigation-mode.js";

describe("NavigationModeDaemonStatusDecoder", () => {
  it("extracts daemons from the versioned status envelope", () => {
    const daemons = [
      { workspaceRoot: "/workspace/one", pid: 0 },
      { workspaceRoot: "/workspace/two", pid: 202, state: "ready" },
    ];

    expect(NavigationModeDaemonStatusDecoder.decode({ schemaVersion: 1, daemons })).toEqual(
      daemons,
    );
  });

  it.each([null, [], "status", 1])("rejects invalid envelope root %j", (status) => {
    expect(() => NavigationModeDaemonStatusDecoder.decode(status)).toThrow(
      "Invalid daemon status envelope",
    );
  });

  it.each([undefined, 0, 2, "1"])("rejects schema version %j", (schemaVersion) => {
    expect(() => NavigationModeDaemonStatusDecoder.decode({ schemaVersion, daemons: [] })).toThrow(
      "Invalid daemon status envelope",
    );
  });

  it.each([undefined, null, {}, "daemons"])("rejects daemons collection %j", (daemons) => {
    expect(() => NavigationModeDaemonStatusDecoder.decode({ schemaVersion: 1, daemons })).toThrow(
      "Invalid daemon status envelope",
    );
  });

  it.each([
    null,
    {},
    { workspaceRoot: 1, pid: 1 },
    { workspaceRoot: "/workspace", pid: -1 },
    { workspaceRoot: "/workspace", pid: 1.5 },
    { workspaceRoot: "/workspace", pid: Number.NaN },
  ])("rejects invalid daemon entry %j", (daemon) => {
    expect(() =>
      NavigationModeDaemonStatusDecoder.decode({ schemaVersion: 1, daemons: [daemon] }),
    ).toThrow("Invalid daemon status envelope");
  });
});
