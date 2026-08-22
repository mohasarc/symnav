import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

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
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => {
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const child: FakeChildProcess = {
        pid: 4321,
        once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
          listeners.set(event, listener);
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
    "uses one absolute state directory for %s identity configuration, cwd, and environment",
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
      expect(configuration.stateDir).toBe(absoluteStateDirectory);
      expect(options.cwd).toBe(absoluteStateDirectory);
      expect(options.env.SYMNAV_STATE_DIR).toBe(absoluteStateDirectory);
    },
  );
});
