import { randomUUID } from "node:crypto";
import type { DaemonExecutionFailureCode } from "../daemon-execution-failure.js";
import type {
  DaemonExecutorExecutionResult,
  DaemonExecutorOutput,
  DaemonExecutorRequest,
  DaemonOutputRecord,
} from "../daemon-executor.js";
import { DaemonPolicy } from "../daemon-policy.js";
import {
  NodeDaemonProcessLauncher,
  NodeDaemonProcessTerminator,
} from "../process/process-launcher.js";
import { DaemonRecordObserver } from "../registry/record-observer.js";
import { DaemonRegistry } from "../registry/registry.js";
import { DaemonStartupCoordinator } from "../registry/startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import { LocalDaemonTransport } from "../transport/local-transport.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "../transport/protocol.js";
import { DaemonTransportError } from "../transport/transport-error.js";
import type {
  DaemonClientExecuteRequest,
  DaemonClientExecuteResult,
  DaemonClientOptions,
} from "./daemon-client-contracts.js";
import {
  DaemonRoutingContextState,
  DaemonRoutingPolicy,
  type DaemonRouteSnapshot,
} from "./daemon-routing-policy.js";

class DaemonControlledOutput implements DaemonExecutorOutput {
  private readonly bytes: Uint8Array;

  constructor(message: string) {
    this.bytes = Buffer.from(message);
  }

  async *records(): AsyncIterable<DaemonOutputRecord> {
    yield { stream: "stderr", bytes: this.bytes };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

class DaemonControlledResult {
  static acceptedRequestDidNotComplete(): DaemonExecutorExecutionResult {
    return this.failure("Cannot answer: accepted daemon request did not complete.\n");
  }

  static workspaceCapacityExceeded(): DaemonExecutorExecutionResult {
    return this.failure("Cannot answer: daemon workspace capacity exceeded.\n");
  }

  static responseCapacityExceeded(): DaemonExecutorExecutionResult {
    return this.failure("Cannot answer: daemon response capacity exceeded.\n");
  }

  private static failure(message: string): DaemonExecutorExecutionResult {
    return { exitCode: 1, output: new DaemonControlledOutput(message) };
  }
}

export class DaemonClient {
  private readonly policy: DaemonPolicy;
  private readonly registry: DaemonRegistry;
  private readonly transport: LocalDaemonTransport;
  private readonly observer: DaemonRecordObserver;
  private readonly coordinator: DaemonStartupCoordinator;
  private readonly routing = new DaemonRoutingPolicy();

  constructor(private readonly options: DaemonClientOptions) {
    this.policy = options.policy ?? DaemonPolicy.currentSystem();
    this.registry = new DaemonRegistry(
      DaemonWorkspaceIdentity.registryDirectory(options.stateDirectory),
      this.policy.values.startup,
    );
    this.transport = new LocalDaemonTransport({ policy: this.policy });
    const processTerminator = new NodeDaemonProcessTerminator(this.policy.values.shutdown);
    const launcher = new NodeDaemonProcessLauncher(
      options.productVersion,
      options.executorModuleUrl,
      this.policy,
      processTerminator,
    );
    this.observer = new DaemonRecordObserver(this.transport, processTerminator);
    this.coordinator = new DaemonStartupCoordinator(this.registry, launcher, this.transport, {
      policy: this.policy.values,
      processTerminator,
    });
  }

  async execute(request: DaemonClientExecuteRequest): Promise<DaemonClientExecuteResult> {
    if (!this.options.daemonEnabled) return this.executeLocally(request, "cold");
    const identity = DaemonWorkspaceIdentity.from(
      request.workspaceRoot,
      this.options.stateDirectory,
    );
    const route = await this.routing.decide(
      new DaemonRoutingContextState(
        identity,
        this.options.productVersion,
        () => this.registry.read(identity),
        (record) => this.observer.observe(record),
        (record) => this.registry.removeIfProcess(identity, record.instanceId, record.processToken),
      ),
    );
    if (route.kind === "warm") return this.executeWarm(route.record, request);
    if ((route.kind === "cold" && route.reason === "absent") || route.kind === "fallback") {
      DaemonClient.triggerIndependently(this.coordinator, identity);
    }
    return this.executeLocally(request, route.kind === "fallback" ? "fallback" : "cold");
  }

  private async executeWarm(
    record: DaemonRecord,
    request: DaemonClientExecuteRequest,
  ): Promise<DaemonClientExecuteResult> {
    let receipt: Awaited<ReturnType<LocalDaemonTransport["execute"]>>;
    try {
      receipt = await this.transport.execute(record.endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: record.instanceId,
        processToken: record.processToken,
        requestId: randomUUID(),
        commandName: request.commandName,
        request: DaemonClient.executorRequest(request, "warm"),
      });
    } catch (error) {
      if (error instanceof DaemonTransportError && error.retrySafe) {
        return this.executeLocally(request, "fallback");
      }
      return { mode: "warm", result: DaemonControlledResult.acceptedRequestDidNotComplete() };
    }
    try {
      const completion = await receipt.completion;
      if (completion.status === "failed") {
        return { mode: "warm", result: DaemonClient.controlledFailure(completion.code) };
      }
      if (!DaemonClient.isCompleteResult(completion.result)) {
        await DaemonClient.disposeMalformedOutput(completion.result);
        return { mode: "warm", result: DaemonControlledResult.acceptedRequestDidNotComplete() };
      }
      return { mode: "warm", result: completion.result };
    } catch {
      return { mode: "warm", result: DaemonControlledResult.acceptedRequestDidNotComplete() };
    }
  }

  private async executeLocally(
    request: DaemonClientExecuteRequest,
    mode: "cold" | "fallback",
  ): Promise<DaemonClientExecuteResult> {
    const executor = await this.options.executorFactory({
      stateDirectory: this.options.stateDirectory,
      productVersion: this.options.productVersion,
      sampleResources: () => undefined,
    });
    const result = await executor.execute(DaemonClient.executorRequest(request, mode));
    return { mode, result };
  }

  private static executorRequest(
    request: DaemonClientExecuteRequest,
    executionMode: DaemonExecutorRequest["executionMode"],
  ): DaemonExecutorRequest {
    return {
      argv: request.argv,
      cwd: request.cwd,
      telemetryEnabled: request.telemetryEnabled,
      executionMode,
    };
  }

  private static triggerIndependently(
    coordinator: DaemonStartupCoordinator,
    identity: DaemonWorkspaceIdentity,
  ): void {
    try {
      void coordinator.trigger(identity).catch(() => undefined);
    } catch {}
  }

  private static isCompleteResult(result: DaemonExecutorExecutionResult): boolean {
    return Number.isInteger(result.exitCode) && result.output !== undefined;
  }

  private static async disposeMalformedOutput(
    result: DaemonExecutorExecutionResult,
  ): Promise<void> {
    try {
      await result.output?.dispose();
    } catch {}
  }

  private static controlledFailure(
    code: DaemonExecutionFailureCode,
  ): DaemonExecutorExecutionResult {
    if (code === "controlled-resource") return DaemonControlledResult.workspaceCapacityExceeded();
    if (code === "response-capacity") return DaemonControlledResult.responseCapacityExceeded();
    return DaemonControlledResult.acceptedRequestDidNotComplete();
  }
}
