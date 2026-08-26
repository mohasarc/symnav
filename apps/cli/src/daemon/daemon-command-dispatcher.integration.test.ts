import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CliExecutionRequest, CommandExecutionResult } from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import {
  DaemonCommandDispatcher,
  type DaemonDispatchRuntime,
} from "./daemon-command-dispatcher.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DAEMON_RECORD_SCHEMA_VERSION,
  type DaemonRecord,
  type DaemonResponse,
} from "./daemon-protocol.js";

const workspaceRoot = resolve("reference-workspace");
const REFERENCE_WORKSPACE_FILE_COUNT = 4_000;

describe("DaemonCommandDispatcher startup routing", () => {
  it("finishes concurrent reference-workspace calls cold behind one independent startup barrier", async () => {
    const barrier = new StartupBarrier();
    let record: DaemonRecord | undefined;
    let daemonStarts = 0;
    const coldExecute = vi.fn(async (request: CliExecutionRequest) =>
      result(`cold:${request.argv[1] ?? "unknown"}`),
    );
    const trigger = vi.fn(async () => {
      if (record?.state === "starting") {
        return { status: "starting", instanceId: record.instanceId, pid: record.pid } as const;
      }
      daemonStarts += 1;
      record = daemonRecord("warming", "starting");
      await barrier.wait();
      record = daemonRecord("warming", "ready");
      return { status: "launched", instanceId: record.instanceId, pid: record.pid } as const;
    });
    const runtime: DaemonDispatchRuntime = {
      coordinator: { trigger },
      registry: {
        read: () => record,
        removeIfProcess: () => false,
      },
      observer: {
        observe: async (observedRecord) => ({
          kind: "responsive",
          record: observedRecord,
          pong: {
            kind: "pong",
            protocolVersion: observedRecord.protocolVersion,
            instanceId: observedRecord.instanceId,
            symnavVersion: observedRecord.symnavVersion,
            state: "ready",
            fileCount: REFERENCE_WORKSPACE_FILE_COUNT,
          },
        }),
      },
      transport: {
        request: async (_endpoint, daemonRequest): Promise<DaemonResponse> => ({
          kind: "result",
          requestId: daemonRequest.kind === "execute" ? daemonRequest.requestId : "unexpected",
          result: result("warm"),
        }),
      },
    };
    const dispatcher = createDispatcher(runtime, coldExecute);
    const requests = Array.from({ length: 24 }, (_, index) => ({
      argv: ["overview", `src/module-${String(index).padStart(4, "0")}.ts`],
      cwd: workspaceRoot,
      telemetryEnabled: false,
    }));

    const coldResults = await Promise.all(requests.map((request) => dispatcher.execute(request)));

    expect(coldResults.map(({ mode }) => mode)).toEqual(Array(24).fill("cold"));
    expect(coldExecute).toHaveBeenCalledTimes(24);
    expect(daemonStarts).toBe(1);
    expect(record?.state).toBe("starting");

    await expect(dispatcher.execute(requests[0]!)).resolves.toMatchObject({ mode: "cold" });
    expect(trigger).toHaveBeenCalledTimes(24);

    barrier.release();
    await vi.waitFor(() => expect(record?.state).toBe("ready"));

    await expect(dispatcher.execute(requests[0]!)).resolves.toEqual({
      mode: "warm",
      result: result("warm"),
    });
    expect(coldExecute).toHaveBeenCalledTimes(25);
  });
});

class StartupBarrier {
  private readonly waiting: Promise<void>;
  private releaseWaiting!: () => void;

  constructor() {
    this.waiting = new Promise((resolve) => {
      this.releaseWaiting = resolve;
    });
  }

  wait(): Promise<void> {
    return this.waiting;
  }

  release(): void {
    this.releaseWaiting();
  }
}

function createDispatcher(
  runtime: DaemonDispatchRuntime,
  coldExecute: (request: CliExecutionRequest) => Promise<CommandExecutionResult>,
): DaemonCommandDispatcher {
  return new DaemonCommandDispatcher({
    createDependencies: () =>
      ({
        symnavVersion: "0.1.0",
        recorder: { record: () => {} },
      }) as unknown as ProgramDependencies,
    stateDirectory: "/state",
    resolveWorkspaceRoot: async () => workspaceRoot,
    runtimeFactory: () => runtime,
    executorFactory: () => ({ execute: coldExecute }),
    requestId: () => "expected-request",
  });
}

function daemonRecord(instanceId: string, state: "starting" | "ready"): DaemonRecord {
  const base = {
    schemaVersion: DAEMON_RECORD_SCHEMA_VERSION,
    protocolVersion: DAEMON_PROTOCOL_VERSION,
    symnavVersion: "0.1.0",
    workspaceRoot,
    workspaceKey: "key",
    stateKey: "state-key",
    identityKey: "identity-key",
    instanceId,
    processToken: `${instanceId}-process`,
    endpoint: "/endpoint",
    pid: 123,
    state,
    startedAt: 1,
    memoryCapBytes: 1024,
  } as const;
  return state === "ready"
    ? { ...base, state, readyAt: 2, fileCount: REFERENCE_WORKSPACE_FILE_COUNT }
    : base;
}

function result(output: string): CommandExecutionResult {
  return {
    frames: [{ stream: "stdout", bytesBase64: Buffer.from(output).toString("base64") }],
    exitCode: 0,
  };
}
