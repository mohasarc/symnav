import { afterEach, expect, it, vi } from "vitest";
import type { DaemonClient, DaemonExecutorExecutionResult, DaemonPolicy } from "@symnav/daemon";
import { CommandOutputSnapshot } from "./command-execution-result.js";
import type { ProgramDependencies } from "./program-dependencies.js";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([
  ["0", false, "1", ["overview", "src/a.ts"]],
  ["1", true, "1", ["overview", "src/a.ts"]],
  ["0", false, "0", ["overview", "src/a.ts"]],
  ["0", false, "0", ["stats", "--json"]],
] as const)(
  "composes one state, dependency set, client, and daemon flag for SYMNAV_DAEMON=%s",
  async (environmentValue, daemonEnabled, telemetryValue, argv) => {
    vi.stubEnv("SYMNAV_DAEMON", environmentValue);
    vi.stubEnv("SYMNAV_TELEMETRY", telemetryValue);
    const needsState = daemonEnabled || telemetryValue === "1";
    const stateDirectory = "/canonical/state";
    const daemonPolicy = {} as DaemonPolicy;
    const daemonClient = {} as DaemonClient;
    const executionResult: DaemonExecutorExecutionResult = {
      output: new CommandOutputSnapshot([]),
      exitCode: 0,
    };
    const resolveStateDirectory = vi.fn(() => stateDirectory);
    const createDefaultDependencies = vi.fn(
      (receivedStateDirectory: string, receivedPolicy: DaemonPolicy, receivedEnabled: boolean) =>
        ({
          stateDirectory: receivedStateDirectory,
          daemonPolicy: receivedPolicy,
          daemonClient,
          daemonEnabled: receivedEnabled,
          telemetryEnabled: telemetryValue === "1",
          fs: {},
        }) as unknown as ProgramDependencies,
    );
    const execute = vi.fn(async () => ({ mode: "warm" as const, result: executionResult }));
    const run = vi.fn(async () => 0);
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
    }));
    vi.doMock("./cli-invocation-coordinator.js", () => ({
      CliInvocationCoordinator: class {
        constructor(options: unknown) {
          coordinatorOptions.push(options);
        }

        execute = execute;
      },
    }));

    vi.doMock("./cli-invocation-runner.js", () => ({
      CliInvocationRunner: class {
        run = run;
      },
    }));
    const originalArgv = process.argv;
    process.argv = [...originalArgv.slice(0, 2), ...argv];
    try {
      await import("./cli.js");
    } finally {
      process.argv = originalArgv;
    }

    expect(resolveStateDirectory).toHaveBeenCalledTimes(needsState ? 1 : 0);
    expect(createDefaultDependencies).toHaveBeenCalledOnce();
    expect(createDefaultDependencies).toHaveBeenCalledWith(
      needsState ? stateDirectory : "",
      daemonPolicy,
      daemonEnabled,
    );
    expect(coordinatorOptions).toEqual([
      expect.objectContaining({ daemonClient, createLocalExecutor: expect.any(Function) }),
    ]);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ telemetryEnabled: telemetryValue === "1" }),
      expect.any(Object),
    );
  },
);
