import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalStateDir } from "@symnav/telemetry";

const { processListeners, spawnMock } = vi.hoisted(() => ({
  processListeners: new Map<string, (...args: unknown[]) => void>(),
  spawnMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import {
  DaemonProcessConfigurationParser,
  NodeDaemonProcessLauncher,
} from "./daemon-process-launcher.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";

interface FakeChildProcess {
  readonly pid: number;
  readonly once: ReturnType<typeof vi.fn>;
  readonly unref: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): void;
}

describe("NodeDaemonProcessLauncher", () => {
  const roots: string[] = [];

  beforeEach(() => {
    processListeners.clear();
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const child: FakeChildProcess = {
        pid: 4321,
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          processListeners.set(event, listener);
          if (event === "spawn") queueMicrotask(() => listener());
          return child;
        }),
        unref: vi.fn(),
        emit(event: string, ...args: unknown[]) {
          processListeners.get(event)?.(...args);
        },
      };
      return child;
    });
  });

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  it.each([
    ["absolute", (stateDirectory: string) => stateDirectory],
    ["relative", (stateDirectory: string) => relative(process.cwd(), stateDirectory)],
  ])(
    "uses one absolute state directory and a neutral cwd for %s identity configuration",
    async (_label, identityStateDirectory) => {
      const root = mkdtempSync(join(tmpdir(), "symnav-launcher-"));
      roots.push(root);
      const stateDirectory = join(root, "state");
      const identity = DaemonWorkspaceIdentity.from(
        join(root, "workspace"),
        canonicalStateDir(identityStateDirectory(stateDirectory)),
      );
      mkdirSync(identity.identityDirectory, { recursive: true });

      await new NodeDaemonProcessLauncher("1.2.3", 128 * 1024 * 1024).launch(
        identity,
        "instance",
        "process-token",
      );

      const [, args, options] = spawnMock.mock.calls[0] as [
        string,
        readonly string[],
        {
          readonly cwd: string;
          readonly detached: boolean;
          readonly env: NodeJS.ProcessEnv;
          readonly stdio: readonly unknown[];
        },
      ];
      const configuration = DaemonProcessConfigurationParser.parse(args[2]);
      const absoluteStateDirectory = canonicalStateDir(resolve(stateDirectory));
      const absoluteWorkspaceRoot = resolve(root, "workspace");
      expect(configuration.stateDirectory).toBe(absoluteStateDirectory);
      expect(configuration.workspaceRoot).toBe(identity.workspaceRoot);
      expect(configuration.workspaceKey).toBe(identity.workspaceKey);
      expect(configuration.stateKey).toBe(identity.stateKey);
      expect(configuration.identityKey).toBe(identity.identityKey);
      expect(configuration.instanceId).toBe("instance");
      expect(configuration.processToken).toBe("process-token");
      expect(configuration.startupOwnerKind).toBe("daemon");
      expect(configuration.endpoint).toBe(identity.endpoint("instance"));
      expect(options.env.SYMNAV_STATE_DIR).toBe(absoluteStateDirectory);
      expect(options.cwd).toBe(tmpdir());
      expect(isAbsolute(options.cwd)).toBe(true);
      expect(options.cwd).not.toBe(absoluteStateDirectory);
      expect(options.cwd).not.toBe(absoluteWorkspaceRoot);
      expect(options).toMatchObject({ detached: true });
      expect(options.stdio[0]).toBe("ignore");
      expect(spawnMock.mock.results[0]?.value.unref).toHaveBeenCalledOnce();
    },
  );

  it("rejects promptly when the detached child cannot spawn", async () => {
    const error = new Error("spawn refused");
    spawnMock.mockImplementationOnce(() => {
      const child: FakeChildProcess = {
        pid: 4321,
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          if (event === "error") queueMicrotask(() => listener(error));
          return child;
        }),
        unref: vi.fn(),
        emit: vi.fn(),
      };
      return child;
    });
    const identity = launcherIdentity(roots);

    await expect(
      new NodeDaemonProcessLauncher("1.2.3", 128 * 1024 * 1024).launch(
        identity,
        "instance",
        "process-token",
      ),
    ).rejects.toThrow("spawn refused");
    expect(spawnMock.mock.results[0]?.value.unref).not.toHaveBeenCalled();
  });

  it("reports child exit through the launched process immediately", async () => {
    const identity = launcherIdentity(roots);
    const daemonProcess = await new NodeDaemonProcessLauncher("1.2.3", 128 * 1024 * 1024).launch(
      identity,
      "instance",
      "process-token",
    );
    const child = spawnMock.mock.results[0]?.value as FakeChildProcess;

    child.emit("exit", 7, "SIGTERM");

    await expect(daemonProcess.exited).resolves.toEqual({
      code: 7,
      signal: "SIGTERM",
      cause: "exit",
    });
  });

  it("reports a child spawn error after launch", async () => {
    const identity = launcherIdentity(roots);
    const daemonProcess = await new NodeDaemonProcessLauncher("1.2.3", 128 * 1024 * 1024).launch(
      identity,
      "instance",
      "process-token",
    );
    const child = spawnMock.mock.results[0]?.value as FakeChildProcess;
    const error = new Error("child failed");
    error.name = "ChildProcessError";

    child.emit("error", error);

    await expect(daemonProcess.exited).resolves.toEqual({
      code: null,
      signal: null,
      cause: "spawn-error",
      errorName: "ChildProcessError",
    });
  });
});

function launcherIdentity(roots: string[]): DaemonWorkspaceIdentity {
  const root = mkdtempSync(join(tmpdir(), "symnav-launcher-exit-"));
  roots.push(root);
  const identity = DaemonWorkspaceIdentity.from(join(root, "workspace"), join(root, "state"));
  mkdirSync(identity.identityDirectory, { recursive: true });
  return identity;
}
