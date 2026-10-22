import { afterEach, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { DaemonPolicyTestFactory } from "../test/helpers/daemon-policy.js";
import { CommandOutputSnapshot, type DispatchedCommandResult } from "./command-execution-result.js";
import type { ProgramDependencies } from "./program-dependencies.js";
import { DaemonWorkspaceIdentity } from "./daemon/daemon-workspace-identity.js";

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.doUnmock("./cli-program-executor.js");
  vi.doUnmock("./daemon/daemon-command-dispatcher.js");
  vi.doUnmock("./program.js");
  vi.doUnmock("./state-directory-resolver.js");
  vi.doUnmock("@symnav/daemon");
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
  const createDefaultDependencies = vi.fn((stateDirectory: string) => {
    dependencyStateDirectories.push(stateDirectory);
    return {
      stateDirectory,
      telemetryEnabled: true,
    } as unknown as ProgramDependencies;
  });
  let dispatcherStateDirectory = "";
  let daemonRecordPath = "";
  let daemonEndpoint = "";

  vi.doMock("./state-directory-resolver.js", () => ({
    StateDirectoryResolver: class {
      resolve = resolveStateDirectory;
    },
  }));
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
        return { mode: "cold", result: { output: new CommandOutputSnapshot([]), exitCode: 0 } };
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

it("owns one exact daemon policy snapshot across one client invocation", async () => {
  const policy = DaemonPolicyTestFactory.withOverrides(
    DaemonPolicy.fromSystemMemory({ totalBytes: 8 * 1024 ** 3 }),
    {
      transport: { singleResponseTimeoutMs: 471 },
      resources: {
        hardProcessRssBytes: 474 * 1024 ** 2,
        softProcessRssBytes: 473 * 1024 ** 2,
        resumeProcessRssBytes: 472 * 1024 ** 2,
      },
      output: { maximumAggregateSpoolRawBytes: 700 * 1024 ** 2 },
      shutdown: { idleTimeoutMs: 480 },
      diagnostics: { maximumDisconnectedTraces: 483 },
    },
  );
  const dependencyPolicies: DaemonPolicy[] = [];
  const dispatcherPolicies: DaemonPolicy[] = [];

  vi.doMock("@symnav/daemon", () => ({
    DaemonPolicy: { currentSystem: () => policy },
  }));
  vi.doMock("./program.js", () => ({
    createDefaultDependencies: (_stateDirectory: string, daemonPolicy: DaemonPolicy) => {
      dependencyPolicies.push(daemonPolicy);
      return { telemetryEnabled: true } as unknown as ProgramDependencies;
    },
    createDefaultProgramContext: () => ({ stdout: {}, stderr: {}, cwd: "/client" }),
  }));
  vi.doMock("./cli-program-executor.js", () => ({
    CommandResultReplayer: { replay: vi.fn() },
  }));
  vi.doMock("./daemon/daemon-command-dispatcher.js", () => ({
    DaemonCommandDispatcher: class {
      constructor(options: { readonly policy: DaemonPolicy }) {
        dispatcherPolicies.push(options.policy);
      }

      execute(): Promise<DispatchedCommandResult> {
        return Promise.resolve({
          mode: "cold",
          result: { output: new CommandOutputSnapshot([]), exitCode: 0 },
        });
      }
    },
  }));

  await import("./cli.js");

  expect(dependencyPolicies).toEqual([policy]);
  expect(dispatcherPolicies).toEqual([policy]);
});
