import { afterEach, expect, it, vi } from "vitest";
import type { DispatchedCommandResult } from "./command-execution-result.js";
import type { ProgramDependencies } from "./program-dependencies.js";
import { DaemonWorkspaceIdentity } from "./daemon/daemon-workspace-identity.js";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("@symnav/telemetry");
  vi.doUnmock("./cli-program-executor.js");
  vi.doUnmock("./daemon/daemon-command-dispatcher.js");
  vi.doUnmock("./program.js");
});

it("owns one canonical state directory across one client invocation", async () => {
  const initialStateDirectory = "/canonical/state-a";
  const retargetedStateDirectory = "/canonical/state-b";
  let currentStateDirectory = initialStateDirectory;
  const resolveStateDirectory = vi.fn(() => {
    const resolvedStateDirectory = currentStateDirectory;
    currentStateDirectory = retargetedStateDirectory;
    return resolvedStateDirectory;
  });
  const dependencyStateDirectories: string[] = [];
  const createDefaultDependencies = vi.fn((stateDirectory?: string) => {
    const dependencyStateDirectory = stateDirectory ?? resolveStateDirectory();
    dependencyStateDirectories.push(dependencyStateDirectory);
    return {
      stateDirectory: dependencyStateDirectory,
      telemetryEnabled: true,
    } as unknown as ProgramDependencies;
  });
  let dispatcherStateDirectory = "";
  let daemonRecordPath = "";
  let daemonEndpoint = "";

  vi.doMock("@symnav/telemetry", () => ({ resolveStateDir: resolveStateDirectory }));
  vi.doMock("./program.js", () => ({
    createDefaultDependencies,
    createDefaultProgramContext: () => ({ stdout: {}, stderr: {}, cwd: "/client" }),
  }));
  vi.doMock("./cli-program-executor.js", () => ({
    CommandResultReplayer: { replay: vi.fn() },
  }));
  vi.doMock("./daemon/daemon-command-dispatcher.js", () => ({
    DaemonCommandDispatcher: class {
      constructor(
        private readonly options: {
          readonly createDependencies: (stateDirectory: string) => ProgramDependencies;
          readonly stateDirectory: string;
        },
      ) {
        dispatcherStateDirectory = options.stateDirectory;
      }

      async execute(): Promise<DispatchedCommandResult> {
        this.options.createDependencies(this.options.stateDirectory);
        this.options.createDependencies(this.options.stateDirectory);
        const identity = DaemonWorkspaceIdentity.from("/workspace", this.options.stateDirectory);
        daemonRecordPath = identity.recordPath("instance");
        daemonEndpoint = identity.endpoint("instance");
        return { mode: "cold", result: { frames: [], exitCode: 0 } };
      }
    },
  }));

  await import("./cli.js");

  const expectedIdentity = DaemonWorkspaceIdentity.from("/workspace", initialStateDirectory);
  expect(resolveStateDirectory).toHaveBeenCalledTimes(1);
  expect(dependencyStateDirectories).toEqual([
    initialStateDirectory,
    initialStateDirectory,
    initialStateDirectory,
  ]);
  expect(dispatcherStateDirectory).toBe(initialStateDirectory);
  expect(daemonRecordPath).toBe(expectedIdentity.recordPath("instance"));
  expect(daemonEndpoint).toBe(expectedIdentity.endpoint("instance"));
});
