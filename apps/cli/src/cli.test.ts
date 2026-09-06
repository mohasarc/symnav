import { afterEach, expect, it, vi } from "vitest";
import type { DaemonClient, DaemonPolicy } from "@symnav/daemon";
import { CommandOutputSnapshot } from "./command-execution-result.js";
import type { ProgramDependencies } from "./program-dependencies.js";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  ["0", false],
  ["1", true],
] as const)(
  "composes one state, dependency set, client, and daemon flag for SYMNAV_DAEMON=%s",
  async (environmentValue, daemonEnabled) => {
    vi.stubEnv("SYMNAV_DAEMON", environmentValue);
    const stateDirectory = "/canonical/state";
    const daemonPolicy = {} as DaemonPolicy;
    const daemonClient = {} as DaemonClient;
    const executionResult = { output: new CommandOutputSnapshot([]), exitCode: 0 };
    const resolveStateDirectory = vi.fn(() => stateDirectory);
    const createDefaultDependencies = vi.fn(
      (receivedStateDirectory: string, receivedPolicy: DaemonPolicy, receivedEnabled: boolean) =>
        ({
          stateDirectory: receivedStateDirectory,
          daemonPolicy: receivedPolicy,
          daemonClient,
          daemonEnabled: receivedEnabled,
          telemetryEnabled: true,
          fs: {},
        }) as unknown as ProgramDependencies,
    );
    const execute = vi.fn(async () => ({ mode: "warm" as const, result: executionResult }));
    const replay = vi.fn();
    const coordinatorOptions: unknown[] = [];

    vi.doMock("./state-directory-resolver.js", () => ({
      StateDirectoryResolver: class {
        resolve = resolveStateDirectory;
      },
    }));
    vi.doMock("@symnav/daemon", () => ({
      DaemonPolicy: { currentSystem: () => daemonPolicy },
    }));
    vi.doMock("./program.js", () => ({
      createDefaultDependencies,
      createDefaultProgramContext: () => ({ stdout: {}, stderr: {}, cwd: "/client" }),
    }));
    vi.doMock("./cli-program-executor.js", () => ({
      CliProgramExecutor: class {},
      CommandResultReplayer: { replay },
    }));
    vi.doMock("./cli-invocation-coordinator.js", () => ({
      CliInvocationCoordinator: class {
        constructor(options: unknown) {
          coordinatorOptions.push(options);
        }

        execute = execute;
      },
    }));

    await import("./cli.js");

    expect(resolveStateDirectory).toHaveBeenCalledOnce();
    expect(createDefaultDependencies).toHaveBeenCalledOnce();
    expect(createDefaultDependencies).toHaveBeenCalledWith(
      stateDirectory,
      daemonPolicy,
      daemonEnabled,
    );
    expect(coordinatorOptions).toEqual([
      expect.objectContaining({ daemonClient, createLocalExecutor: expect.any(Function) }),
    ]);
    expect(execute).toHaveBeenCalledOnce();
    expect(replay).toHaveBeenCalledWith(executionResult, expect.any(Object));
  },
);
