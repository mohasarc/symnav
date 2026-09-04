import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import {
  CommandOutputSnapshot,
  type CliExecutionRequest,
  type CommandExecutionResult,
} from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import {
  DaemonCommandDispatcher,
  type DaemonDispatchRuntime,
} from "./daemon-command-dispatcher.js";
import type {
  DaemonLifecycleRequest,
  DaemonLifecycleResponse,
  DaemonRecord,
} from "./daemon-protocol.js";
import type {
  DaemonProcess,
  DaemonProcessLauncher,
  DaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import { TestDaemonRegistry as DaemonRegistry } from "../../test/helpers/daemon-registry.js";
import { TestDaemonStartupCoordinator as DaemonStartupCoordinator } from "../../test/helpers/daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import type { DaemonExecutionReceipt, LocalDaemonTransport } from "./local-daemon-transport.js";

const workspaceRoot = resolve("reference-workspace");
const REFERENCE_WORKSPACE_FILE_COUNT = 4_000;

describe("DaemonCommandDispatcher startup routing", () => {
  it("finishes concurrent reference-workspace calls cold behind one independent startup barrier", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "symnav-routing-barrier-"));
    try {
      const barrier = new StartupBarrier();
      const identity = DaemonWorkspaceIdentity.from(workspaceRoot, stateDirectory);
      const registry = new DaemonRegistry(identity.registryDirectory);
      const processTerminator = new LiveTestProcessTerminator();
      const launcher = new BarrierDaemonLauncher(registry, identity, processTerminator, barrier);
      const coordinator = new DaemonStartupCoordinator(
        registry,
        launcher,
        new RegistryDaemonTransport(registry, identity) as unknown as LocalDaemonTransport,
        { pollIntervalMs: 1, processTerminator },
      );
      const coldExecute = vi.fn(async (request: CliExecutionRequest) =>
        result(`cold:${request.argv[1] ?? "unknown"}`),
      );
      const runtime: DaemonDispatchRuntime = {
        coordinator,
        registry,
        observer: {
          observe: async (record) => ({
            kind: "responsive",
            record,
            pong: {
              kind: "pong",
              protocolVersion: record.protocolVersion,
              instanceId: record.instanceId,
              symnavVersion: record.symnavVersion,
              state: "ready",
              fileCount: REFERENCE_WORKSPACE_FILE_COUNT,
            },
          }),
        },
        transport: {
          execute: async (_endpoint, daemonRequest): Promise<DaemonExecutionReceipt> => ({
            acceptance: {
              requestId: daemonRequest.requestId,
              instanceId: daemonRequest.instanceId,
              acceptedAt: 1,
              queuePosition: 0,
            },
            completion: Promise.resolve({ status: "completed", result: result("warm") }),
          }),
        },
      };
      const dispatcher = createDispatcher(runtime, coldExecute, stateDirectory);
      const requests = Array.from({ length: 24 }, (_, index) => ({
        argv: ["overview", `src/module-${String(index).padStart(4, "0")}.ts`],
        cwd: workspaceRoot,
        telemetryEnabled: false,
      }));

      const coldResults = await Promise.all(requests.map((request) => dispatcher.execute(request)));

      expect(coldResults.map(({ mode }) => mode)).toEqual(Array(24).fill("cold"));
      expect(coldExecute).toHaveBeenCalledTimes(24);
      expect(launcher.launchCount).toBe(1);
      expect(registry.read(identity)?.state).toBe("starting");

      await expect(dispatcher.execute(requests[0]!)).resolves.toMatchObject({ mode: "cold" });
      expect(launcher.launchCount).toBe(1);

      barrier.release();
      await vi.waitFor(() => expect(registry.read(identity)?.state).toBe("ready"));

      await expect(dispatcher.execute(requests[0]!)).resolves.toEqual({
        mode: "warm",
        result: result("warm"),
      });
      expect(coldExecute).toHaveBeenCalledTimes(25);
    } finally {
      rmSync(stateDirectory, { recursive: true, force: true });
    }
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

class BarrierDaemonLauncher implements DaemonProcessLauncher {
  readonly symnavVersion = "0.1.0";
  readonly memoryCapBytes = 1024;
  launchCount = 0;
  private readonly pid = 12_345;

  constructor(
    private readonly registry: DaemonRegistry,
    private readonly identity: DaemonWorkspaceIdentity,
    private readonly processTerminator: LiveTestProcessTerminator,
    private readonly barrier: StartupBarrier,
  ) {}

  async launch(
    _identity: DaemonWorkspaceIdentity,
    instanceId: string,
    _processToken: string,
  ): Promise<DaemonProcess> {
    this.launchCount += 1;
    this.processTerminator.alive.add(this.pid);
    void this.barrier.wait().then(() => this.publishReady(instanceId));
    return {
      pid: this.pid,
      exited: new Promise<never>(() => {}),
      terminate: async () => {
        this.processTerminator.alive.delete(this.pid);
      },
    };
  }

  private publishReady(instanceId: string): void {
    const starting = this.registry.readStoredInstance(this.identity, instanceId);
    if (starting?.state !== "starting") return;
    const ready: DaemonRecord = {
      ...starting,
      state: "ready" as const,
      readyAt: 2,
      fileCount: REFERENCE_WORKSPACE_FILE_COUNT,
    };
    this.registry.writeIfStartupOwner(this.identity, ready);
    this.registry.removeStartupLockIfProcess(this.identity, ready);
  }
}

class LiveTestProcessTerminator implements DaemonProcessTerminator {
  readonly alive = new Set<number>([process.pid]);

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async terminate(pid: number): Promise<void> {
    this.alive.delete(pid);
  }
}

class RegistryDaemonTransport {
  constructor(
    private readonly registry: DaemonRegistry,
    private readonly identity: DaemonWorkspaceIdentity,
  ) {}

  async request(
    _endpoint: string,
    request: DaemonLifecycleRequest,
  ): Promise<DaemonLifecycleResponse> {
    const record = this.registry.readStoredInstance(this.identity, request.instanceId);
    if (record === undefined) throw new Error("Missing daemon record");
    if (request.kind === "identify") {
      return {
        kind: "identity",
        instanceId: record.instanceId,
        processToken: record.processToken,
        pid: record.pid,
        startedAt: record.startedAt,
      };
    }
    if (request.kind === "ping") {
      return {
        kind: "pong",
        protocolVersion: record.protocolVersion,
        instanceId: record.instanceId,
        symnavVersion: record.symnavVersion,
        state: record.state,
        startedAt: record.startedAt,
        ...(record.fileCount === undefined ? {} : { fileCount: record.fileCount }),
      };
    }
    throw new Error(`Unexpected startup request ${request.kind}`);
  }
}

function createDispatcher(
  runtime: DaemonDispatchRuntime,
  coldExecute: (request: CliExecutionRequest) => Promise<CommandExecutionResult>,
  stateDirectory: string,
): DaemonCommandDispatcher {
  return new DaemonCommandDispatcher({
    createDependencies: () =>
      ({
        symnavVersion: "0.1.0",
        recorder: { record: () => {} },
      }) as unknown as ProgramDependencies,
    stateDirectory,
    policy: DaemonPolicy.currentSystem(),
    resolveWorkspaceRoot: async () => workspaceRoot,
    runtimeFactory: () => runtime,
    executorFactory: () => ({ execute: coldExecute }),
    requestId: () => "expected-request",
  });
}

function result(output: string): CommandExecutionResult {
  return {
    output: new CommandOutputSnapshot([{ stream: "stdout", bytes: Buffer.from(output) }]),
    exitCode: 0,
  };
}
