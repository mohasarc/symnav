import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_RECORD_SCHEMA_VERSION } from "../transport/protocol.js";
import { DaemonTestingInspector } from "./daemon-testing-inspector.js";

describe("daemon testing inspector", () => {
  const directories: string[] = [];

  afterEach(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    directories.length = 0;
  });

  it("lists only read-only public instance identity and state", () => {
    const stateDirectory = temporaryDirectory(directories);
    const identity = DaemonWorkspaceIdentity.from("/canonical/workspace", stateDirectory);
    mkdirSync(identity.identityDirectory, { recursive: true });
    writeFileSync(
      identity.recordPath("opaque-instance"),
      JSON.stringify({
        schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        symnavVersion: "1.0.0",
        workspaceRoot: identity.workspaceRoot,
        workspaceKey: identity.workspaceKey,
        stateKey: identity.stateKey,
        identityKey: identity.identityKey,
        instanceId: "opaque-instance",
        processToken: "secret-token",
        endpoint: identity.endpoint("opaque-instance"),
        pid: process.pid,
        state: "ready",
        startedAt: 1,
        readyAt: 2,
        fileCount: 3,
        memoryCapBytes: 4,
      }),
    );

    expect(new DaemonTestingInspector(stateDirectory).listInstances()).toEqual([
      {
        workspaceRoot: "/canonical/workspace",
        pid: process.pid,
        instanceId: "opaque-instance",
        state: "ready",
      },
    ]);
  });

  it("paginates parsed diagnostics by event index", () => {
    const stateDirectory = temporaryDirectory(directories);
    const identity = DaemonWorkspaceIdentity.from("/canonical/workspace", stateDirectory);
    mkdirSync(identity.identityDirectory, { recursive: true });
    writeFileSync(identity.logPath + ".1", '{"kind":"start"}\n');
    writeFileSync(
      identity.logPath,
      '{"kind":"ready","nested":[null,true,1,"value"]}\n' +
        '{"kind":"request","future":{"count":2}}\n',
    );

    const page = new DaemonTestingInspector(stateDirectory).readDiagnostics(
      identity.workspaceRoot,
      1,
    );

    expect(page).toEqual({
      events: [
        { kind: "ready", nested: [null, true, 1, "value"] },
        { kind: "request", future: { count: 2 } },
      ],
      nextCursor: 3,
    });
  });

  it("reports aggregate spool file count and bytes without exposing coordinates", () => {
    const stateDirectory = temporaryDirectory(directories);
    const identity = DaemonWorkspaceIdentity.from("/canonical/workspace", stateDirectory);
    mkdirSync(join(identity.spoolDirectory, "instance"), { recursive: true });
    writeFileSync(join(identity.spoolDirectory, "first.spool"), "123");
    writeFileSync(join(identity.spoolDirectory, "instance", "second.spool"), "4567");

    expect(
      new DaemonTestingInspector(stateDirectory).completionSpoolUsage(identity.workspaceRoot),
    ).toEqual({ fileCount: 2, bytes: 7 });
  });

  it("reports artifact presence without exposing storage layout", () => {
    const stateDirectory = temporaryDirectory(directories);
    const inspector = new DaemonTestingInspector(stateDirectory);
    expect(inspector.hasStateArtifacts()).toBe(false);

    mkdirSync(join(stateDirectory, "daemons"), { recursive: true });

    expect(inspector.hasStateArtifacts()).toBe(true);
    expect(Object.keys(inspector)).toEqual([]);
  });

  it("returns empty observations when the configured state path is a file", () => {
    const root = temporaryDirectory(directories);
    const statePath = join(root, "state");
    writeFileSync(statePath, "occupied");
    const inspector = new DaemonTestingInspector(statePath);

    expect(inspector.listInstances()).toEqual([]);
    expect(inspector.hasStateArtifacts()).toBe(false);
    expect(inspector.readDiagnostics("/canonical/workspace")).toEqual({
      events: [],
      nextCursor: 0,
    });
    expect(inspector.completionSpoolUsage("/canonical/workspace")).toEqual({
      fileCount: 0,
      bytes: 0,
    });
  });

  it.each([
    ["instance list", (inspector: DaemonTestingInspector) => inspector.listInstances()],
    ["artifact", (inspector: DaemonTestingInspector) => inspector.hasStateArtifacts()],
    [
      "diagnostic",
      (inspector: DaemonTestingInspector) => inspector.readDiagnostics("/canonical/workspace"),
    ],
    [
      "spool",
      (inspector: DaemonTestingInspector) => inspector.completionSpoolUsage("/canonical/workspace"),
    ],
  ])("preserves unrelated %s filesystem failures", (_name, inspect) => {
    const stateDirectory = temporaryDirectory(directories);
    const registryDirectory = join(stateDirectory, "daemons");
    symlinkSync(registryDirectory, registryDirectory);

    expect(() => inspect(new DaemonTestingInspector(stateDirectory))).toThrow(
      expect.objectContaining({ code: "ELOOP" }),
    );
  });
});

function temporaryDirectory(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "symnav-daemon-inspector-"));
  directories.push(directory);
  return directory;
}
