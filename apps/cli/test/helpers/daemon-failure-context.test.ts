import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { DaemonTestingInspector } from "@symnav/daemon/testing";
import type { RunSymnavBinaryResult } from "@symnav/testing";
import { afterEach, expect, it, vi } from "vitest";
import { StateDirectoryResolver } from "../../src/state-directory-resolver.js";
import { ControlledLifecycleDaemon } from "./controlled-lifecycle-daemon.js";
import { DaemonFailureContext } from "./daemon-failure-context.js";
import { canonicalWorkspaceRoot } from "./canonical-workspace-root.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("retains command and owned evidence in the original assertion after source deletion", async () => {
  const fixture = new FailureContextFixture(directories);
  const result: RunSymnavBinaryResult = {
    status: 2,
    stdout: "original stdout",
    stderr: "original child stderr",
  };
  const assertion = fixture.assertion();
  const context = new DaemonFailureContext({
    stateDirectory: fixture.root,
    workspaceRoot: `${fixture.root}/.`,
    result,
    elapsedMs: 4_123,
  });
  const caught = await context
    .assert(() => {
      throw assertion;
    })
    .catch((error: unknown) => error);
  rmSync(fixture.root, { recursive: true, force: true });

  expect(caught).toBe(assertion);
  expect(assertion.message).toContain("expected 2 to be +0");
  for (const retained of [
    "original stdout",
    "original child stderr",
    '"status":2',
    '"elapsedMs":4123',
    '"pid":123',
    '"kind":"termination"',
    '"kind":"process-termination"',
    '"osCode":"EACCES"',
  ])
    expect(assertion.message).toContain(retained);
  expect(assertion.message).not.toContain("owned-secret-token");
  expect(assertion.message).not.toContain("hostile-payload");
});

it("retains obtainable context and the exact assertion when one inspector read fails", async () => {
  const fixture = new FailureContextFixture(directories);
  vi.spyOn(DaemonTestingInspector.prototype, "readDiagnostics").mockImplementation(() => {
    throw Object.assign(new Error("hostile-payload"), { code: "EACCES" });
  });
  const assertion = fixture.assertion();
  const context = new DaemonFailureContext({
    stateDirectory: fixture.root,
    workspaceRoot: fixture.root,
    result: { status: 2, stdout: "", stderr: "child failure" },
  });
  await expect(
    context.assert(() => {
      throw assertion;
    }),
  ).rejects.toBe(assertion);
  expect(assertion.message).toContain('"diagnostics":{"unavailable":true,"osCode":"EACCES"}');
  expect(assertion.message).toContain('"kind":"termination"');
  expect(assertion.message).toContain("child failure");
  expect(assertion.message).not.toContain("hostile-payload");
});

it("returns successful assertions without any inspector or actor reads", async () => {
  const fixture = new FailureContextFixture(directories);
  const instances = vi.spyOn(DaemonTestingInspector.prototype, "listInstances");
  const diagnostics = vi.spyOn(DaemonTestingInspector.prototype, "readDiagnostics");
  const failures = vi.spyOn(DaemonTestingInspector.prototype, "readFailures");
  const actor = Object.create(ControlledLifecycleDaemon.prototype) as ControlledLifecycleDaemon;
  const actorSnapshot = vi.spyOn(actor, "diagnosticSnapshot");
  const value = { unchanged: true } satisfies Record<string, boolean>;
  expect(
    await new DaemonFailureContext({
      stateDirectory: fixture.root,
      workspaceRoot: fixture.root,
      result: { status: 0, stdout: "", stderr: "" },
      actor,
    }).assert(() => value),
  ).toBe(value);
  expect(instances).not.toHaveBeenCalled();
  expect(diagnostics).not.toHaveBeenCalled();
  expect(failures).not.toHaveBeenCalled();
  expect(actorSnapshot).not.toHaveBeenCalled();
});

it("does not construct or canonicalize diagnostic state for a successful assertion", async () => {
  const fixture = new FailureContextFixture(directories);
  const canonicalize = vi.spyOn(StateDirectoryResolver, "canonicalize");
  const value = { retained: true } satisfies Record<string, boolean>;
  const context = new DaemonFailureContext({
    stateDirectory: fixture.root,
    workspaceRoot: fixture.root,
    result: { status: 0, stdout: "", stderr: "" },
  });
  expect(await context.assert(() => value)).toBe(value);
  expect(canonicalize).not.toHaveBeenCalled();
});

it("preserves the assertion and streams when diagnostic construction fails", async () => {
  const fixture = new FailureContextFixture(directories);
  const assertion = fixture.assertion();
  const actor = Object.create(ControlledLifecycleDaemon.prototype) as ControlledLifecycleDaemon;
  const actorSnapshot = vi.spyOn(actor, "diagnosticSnapshot").mockReturnValue({
    pid: 456,
    stderr: "independent actor context",
    exitCode: null,
    signalCode: null,
    close: { state: "pending" },
  });
  vi.spyOn(StateDirectoryResolver, "canonicalize").mockImplementation(() => {
    throw Object.assign(new Error("hostile-setup-message"), { code: "EACCES" });
  });
  let assertionReached = false;
  const caught = await (async () => {
    const context = new DaemonFailureContext({
      stateDirectory: fixture.root,
      actor,
      workspaceRoot: fixture.root,
      result: { status: 2, stdout: "setup stdout", stderr: "setup child stderr" },
    });
    return context.assert(() => {
      assertionReached = true;
      throw assertion;
    });
  })().catch((error: unknown) => error);
  expect(assertionReached).toBe(true);
  expect(actorSnapshot).toHaveBeenCalledOnce();
  expect(assertion.message).toContain("independent actor context");
  expect(caught).toBe(assertion);
  expect(assertion.message).toContain("setup stdout");
  expect(assertion.message).toContain("setup child stderr");
  expect(assertion.message).toContain('"unavailable":true,"osCode":"EACCES"');
  expect(assertion.message).not.toContain("hostile-setup-message");
});

class FailureContextFixture {
  public readonly root: string;
  public constructor(directories: string[]) {
    this.root = canonicalWorkspaceRoot(
      realpathSync(mkdtempSync(join(tmpdir(), "symnav-failure-context-"))),
    );
    directories.push(this.root);
    const key = FailureContextFixture.hash(this.root);
    const identityDirectory = join(
      this.root,
      "daemons",
      FailureContextFixture.hash(`${key}:${key}`),
    );
    mkdirSync(join(identityDirectory, "failures"), { recursive: true });
    writeFileSync(
      join(identityDirectory, "instance.json"),
      JSON.stringify({
        schemaVersion: 2,
        protocolVersion: 5,
        symnavVersion: "1.0.0",
        workspaceRoot: this.root,
        workspaceKey: key,
        stateKey: key,
        identityKey: FailureContextFixture.hash(`${key}:${key}`),
        instanceId: "instance",
        processToken: "owned-secret-token",
        endpoint: FailureContextFixture.endpoint(
          identityDirectory,
          FailureContextFixture.hash(`${key}:${key}`),
        ),
        pid: 123,
        state: "ready",
        startedAt: 1,
        readyAt: 2,
        fileCount: 1,
        memoryCapBytes: 4,
      }),
    );
    writeFileSync(
      join(identityDirectory, "daemon.log"),
      JSON.stringify({
        kind: "process-termination",
        terminationReason: "unhandled-rejection",
        errorName: "Error",
        operation: "hostile-payload",
        token: "owned-secret-token",
        message: "hostile-payload",
        signal: "owned-secret-token",
        timestamp: 3,
        failure: {
          phase: "transfer",
          reason: "transfer-failed",
          timestamp: 3,
          osCode: "EACCES",
          token: "owned-secret-token",
        },
      }) + "\n",
    );
    writeFileSync(
      join(identityDirectory, "failures", `${FailureContextFixture.hash("failure-event")}.json`),
      JSON.stringify({
        schemaVersion: 1,
        eventId: "failure-event",
        workspaceRoot: this.root,
        kind: "termination",
        failure: { phase: "transfer", reason: "transfer-failed", timestamp: 3, osCode: "EACCES" },
      }),
    );
  }
  public assertion(): Error {
    try {
      expect(2).toBe(0);
    } catch (error) {
      return error as Error;
    }
    throw new Error("Expected failing assertion");
  }
  private static endpoint(identityDirectory: string, identityKey: string): string {
    const instanceKey = this.hash("instance").slice(0, 12);
    if (process.platform !== "win32") return join(identityDirectory, `${instanceKey}.mailbox`);
    const user =
      typeof process.getuid === "function" ? String(process.getuid()) : userInfo().username;
    return `\\\\.\\pipe\\symnav-${this.hash(user).slice(0, 8)}-${identityKey.slice(0, 20)}-${instanceKey}`;
  }

  private static hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }
}
