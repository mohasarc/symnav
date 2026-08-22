import { describe, expect, it, vi } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import type { DaemonRecord, DaemonRequest, DaemonResponse } from "./daemon-protocol.js";
import {
  DaemonCommandDispatcher,
  type DaemonDispatchRuntime,
} from "./daemon-command-dispatcher.js";

const request: CliExecutionRequest = {
  argv: ["overview", "src/a.ts"],
  cwd: "/repo",
  telemetryEnabled: false,
};
const success: CommandExecutionResult = {
  frames: [{ stream: "stdout", bytesBase64: Buffer.from("answer\n").toString("base64") }],
  exitCode: 0,
};

describe("DaemonCommandDispatcher", () => {
  it("does not touch daemon state when disabled", async () => {
    const harness = new DispatchHarness(success, { daemonEnabled: false });

    await expect(harness.dispatcher().execute(request)).resolves.toEqual({
      mode: "cold",
      result: success,
    });
    expect(harness.runtimeFactory).not.toHaveBeenCalled();
    expect(harness.coldExecute).toHaveBeenCalledWith(
      expect.objectContaining({ executionMode: "cold" }),
    );
  });
});

interface DispatchHarnessOptions {
  readonly daemonEnabled?: boolean;
}

class DispatchHarness {
  readonly ensureRunning = vi.fn();
  readonly removeIfInstance = vi.fn();
  readonly coldExecute = vi.fn(async () => success);
  readonly runtimeFactory = vi.fn(() => this.runtime);
  private readonly requests: DaemonRequest[] = [];
  private readonly runtime: DaemonDispatchRuntime;

  constructor(
    private readonly daemonAnswer: CommandExecutionResult | Error,
    private readonly options: DispatchHarnessOptions = {},
  ) {
    this.runtime = {
      coordinator: { ensureRunning: this.ensureRunning },
      registry: {
        read: () => daemonRecord(),
        removeIfInstance: this.removeIfInstance,
      },
      transport: {
        request: async (_endpoint: string, daemonRequest: DaemonRequest) => {
          this.requests.push(daemonRequest);
          if (this.daemonAnswer instanceof Error) throw this.daemonAnswer;
          return {
            kind: "result",
            requestId: daemonRequest.kind === "execute" ? daemonRequest.requestId : "unexpected",
            result: this.daemonAnswer,
          } satisfies DaemonResponse;
        },
      },
    };
  }

  dispatcher(): DaemonCommandDispatcher {
    return new DaemonCommandDispatcher({
      createDependencies: () => ({ symnavVersion: "0.1.0" }) as ProgramDependencies,
      daemonEnabled: () => this.options.daemonEnabled ?? true,
      stateDirectory: "/state",
      resolveWorkspaceRoot: async () => "/repo",
      runtimeFactory: this.runtimeFactory,
      executorFactory: () => ({ execute: this.coldExecute }),
      requestId: () => "request-1",
    });
  }

  executeRequests(): readonly DaemonRequest[] {
    return this.requests.filter((daemonRequest) => daemonRequest.kind === "execute");
  }
}

function daemonRecord(): DaemonRecord {
  return {
    schemaVersion: 1,
    protocolVersion: 1,
    symnavVersion: "0.1.0",
    workspaceRoot: "/repo",
    workspaceKey: "key",
    instanceId: "instance-1",
    processToken: "instance-1-token",
    endpoint: "/endpoint",
    pid: 123,
    state: "ready",
    startedAt: 1,
    readyAt: 2,
    fileCount: 1,
    memoryCapBytes: 1024,
  };
}
