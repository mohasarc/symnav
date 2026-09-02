import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
        identityStateDirectory(stateDirectory),
      );
      mkdirSync(identity.registryDirectory, { recursive: true });

      await new NodeDaemonProcessLauncher("1.2.3", 128 * 1024 * 1024).launch(
        identity,
        "instance",
        "process-token",
      );

      const [, args, options] = spawnMock.mock.calls[0] as [
        string,
        readonly string[],
        { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
      ];
      const configuration = DaemonProcessConfigurationParser.parse(args[2]);
      const absoluteStateDirectory = resolve(stateDirectory);
      const absoluteWorkspaceRoot = resolve(root, "workspace");
      expect(configuration.stateDir).toBe(absoluteStateDirectory);
      expect(options.env.SYMNAV_STATE_DIR).toBe(absoluteStateDirectory);
      expect(options.cwd).toBe(tmpdir());
      expect(isAbsolute(options.cwd)).toBe(true);
      expect(options.cwd).not.toBe(absoluteStateDirectory);
      expect(options.cwd).not.toBe(absoluteWorkspaceRoot);
    },
  );

  it("reports child exit after the detached process spawns", async () => {
    const root = mkdtempSync(join(tmpdir(), "symnav-launcher-exit-"));
    roots.push(root);
    const identity = DaemonWorkspaceIdentity.from(join(root, "workspace"), join(root, "state"));
    mkdirSync(identity.registryDirectory, { recursive: true });
    const daemonProcess = await new NodeDaemonProcessLauncher("1.2.3", 128 * 1024 * 1024).launch(
      identity,
      "instance",
      "process-token",
    );

    processListeners.get("exit")?.(7, "SIGTERM");

    await expect(daemonProcess.exited).resolves.toEqual({
      code: 7,
      signal: "SIGTERM",
      cause: "exit",
    });
  });
});
