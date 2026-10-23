import { DaemonProcessLifetimeCreationError } from "../process/process-lifetime-creation-error.js";
import { DaemonLogger } from "../diagnostics/logger.js";
import { DaemonFailureJournal } from "../diagnostics/failure-journal.js";
import { DaemonFailureRecorder } from "../diagnostics/failure-recorder.js";
import { NodeDaemonClock } from "../lifecycle/daemon-clock.js";
import type {
  DaemonStateWriteFailure,
  DaemonStateWriteFailureObserver,
} from "../state-write-failure.js";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DaemonStateWriteErrors } from "../state-write-errors.js";
import type { DaemonExecutionFailureCode } from "../daemon-execution-failure.js";
import type {
  DaemonExecutorExecutionResult,
  DaemonExecutorOutput,
  DaemonExecutorRequest,
  DaemonOutputRecord,
} from "../daemon-executor.js";
import { DaemonPolicy } from "../daemon-policy.js";
import type {
  DaemonStartResult,
  DaemonStopResult,
  DaemonStatusReport,
} from "../daemon-lifecycle-report.js";
import { DaemonController } from "../process/controller.js";
import {
  NodeDaemonProcessLauncher,
  NodeDaemonProcessTerminator,
} from "../process/process-launcher.js";
import { DaemonRecordObserver } from "../registry/record-observer.js";
import { DaemonRegistry } from "../registry/registry.js";
import { DaemonStartupCoordinator } from "../registry/startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "../registry/workspace-identity.js";
import { DaemonClientResultCapture } from "../transport/client-result-capture.js";
import { DaemonTransportFactory } from "../transport/daemon-transport.js";
import type {
  DaemonExecutionRequester,
  DaemonLifecycleRequestSender,
} from "../transport/contracts.js";
import type { DaemonExecuteRequest, DaemonLifecycleRequest } from "../transport/protocol.js";
import { DAEMON_PROTOCOL_VERSION, type DaemonRecord } from "../transport/protocol.js";
import { DaemonTransportError } from "../transport/transport-error.js";
import type {
  DaemonClientExecuteRequest,
  DaemonClientExecuteResult,
  DaemonClientOptions,
  DaemonControlRequest,
} from "./daemon-client-contracts.js";
import { DaemonRoutingContextState, DaemonRoutingPolicy } from "./daemon-routing-policy.js";

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

class DaemonClientTransport implements DaemonLifecycleRequestSender, DaemonExecutionRequester {
  constructor(
    private readonly lifecycle: ReturnType<typeof DaemonTransportFactory.create>["lifecycle"],
    private readonly execution: ReturnType<typeof DaemonTransportFactory.create>["execution"],
  ) {}

  request(endpoint: string, request: DaemonLifecycleRequest) {
    return this.lifecycle.request(endpoint, request);
  }

  execute(endpoint: string, request: DaemonExecuteRequest) {
    return this.execution.execute(endpoint, request);
  }
}

class DaemonWriteObservedLifecycle
  implements DaemonLifecycleRequestSender, DaemonExecutionRequester
{
  private disabled = false;

  public constructor(
    private readonly transport: DaemonLifecycleRequestSender & DaemonExecutionRequester,
    private readonly stateDirectory: string,
    private readonly stateWriteFailed: DaemonStateWriteFailureObserver,
  ) {}

  public async request(endpoint: string, request: DaemonLifecycleRequest) {
    if (this.disabled) throw new Error("Invocation state writes are disabled");
    try {
      return await this.transport.request(endpoint, request);
    } catch (error) {
      const failure = DaemonStateWriteErrors.from(error, this.stateDirectory);
      if (failure !== undefined) {
        this.disabled = true;
        this.stateWriteFailed(failure);
      }
      throw error;
    }
  }

  public async execute(endpoint: string, request: DaemonExecuteRequest) {
    if (this.disabled) throw new Error("Invocation state writes are disabled");
    try {
      return await this.transport.execute(endpoint, request);
    } catch (error) {
      const failure = DaemonStateWriteErrors.from(error, this.stateDirectory);
      if (failure !== undefined) {
        this.disabled = true;
        this.stateWriteFailed(failure);
      }
      throw error;
    }
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

export class DaemonClientRuntime {
  private readonly policy: DaemonPolicy;
  private readonly registry: DaemonRegistry;
  private readonly routingTransport: DaemonClientTransport;
  private readonly statusTransport: DaemonClientTransport;
  private readonly coordinator: DaemonStartupCoordinator;
  private readonly controlController: DaemonController;
  private readonly statusController: DaemonController;
  private readonly routing = new DaemonRoutingPolicy();
  private readonly clock = new NodeDaemonClock();

  constructor(private readonly options: DaemonClientOptions) {
    this.policy = options.policy ?? DaemonPolicy.currentSystem();
    this.registry = new DaemonRegistry(
      DaemonWorkspaceIdentity.registryDirectory(options.stateDirectory),
      this.policy.values.startup,
    );
    const routingComponents = DaemonTransportFactory.create({
      policy: this.policy,
      createOutput: () =>
        new DaemonClientResultCapture({
          policy: this.policy.values.output,
          directory: join(options.stateDirectory, "captures"),
        }),
    });
    const statusComponents = DaemonTransportFactory.create({
      policy: this.policy,
      captureDirectory: join(options.stateDirectory, "captures"),
      lifecycleResponseTimeoutMs: this.policy.values.transport.statusResponseTimeoutMs,
    });
    this.routingTransport = new DaemonClientTransport(
      routingComponents.lifecycle,
      routingComponents.execution,
    );
    this.statusTransport = new DaemonClientTransport(
      statusComponents.lifecycle,
      routingComponents.execution,
    );
    const processTerminator = new NodeDaemonProcessTerminator(this.policy.values.shutdown);
    const launcher = new NodeDaemonProcessLauncher(
      options.productVersion,
      options.executorModuleUrl,
      this.policy,
    );
    this.coordinator = new DaemonStartupCoordinator(
      this.registry,
      launcher,
      this.routingTransport,
      {
        policy: this.policy.values,
        processTerminator,
        readinessProbe: options.readinessProbe,
      },
    );
    this.controlController = new DaemonController(
      this.registry,
      this.routingTransport,
      options.stateDirectory,
      {
        policy: this.policy.values,
        processTerminator,
        launcher,
        startupCoordinator: this.coordinator,
      },
    );
    this.statusController = new DaemonController(
      this.registry,
      this.statusTransport,
      options.stateDirectory,
      {
        policy: this.policy.values,
        processTerminator,
      },
    );
  }

  async execute(request: DaemonClientExecuteRequest): Promise<DaemonClientExecuteResult> {
    if (!this.options.daemonEnabled) return this.executeLocally(request, "cold");
    const identity = DaemonWorkspaceIdentity.from(
      request.workspaceRoot,
      this.options.stateDirectory,
    );
    let stateWriteFailure: DaemonStateWriteFailure | undefined;
    const stateWriteFailed: DaemonStateWriteFailureObserver = (failure) => {
      if (stateWriteFailure !== undefined) return;
      stateWriteFailure = failure;
      request.stateWriteFailed?.(failure);
    };
    const observer = new DaemonRecordObserver(
      new DaemonWriteObservedLifecycle(
        this.routingTransport,
        this.options.stateDirectory,
        stateWriteFailed,
      ),
      new NodeDaemonProcessTerminator(this.policy.values.shutdown),
    );
    const observedRequest: DaemonClientExecuteRequest = { ...request, stateWriteFailed };
    const routingContext = new DaemonRoutingContextState(
      identity,
      this.options.productVersion,
      () => this.registry.read(identity),
      async (record) => {
        const observation = await observer.observe(record);
        if (observation.kind === "exited")
          await this.failureRecorder(record.workspaceRoot, stateWriteFailed).record(
            record.state === "starting" ? "startup-failure" : "termination",
            "process spawn",
            "process-terminated",
            undefined,
            record.instanceId,
          );
        return observation;
      },
      (record) => this.registry.removeIfProcess(identity, record.instanceId, record.processToken),
    );
    const route = await this.routing.decide(routingContext);
    const restartStarting =
      route.kind === "cold" &&
      route.reason === "starting" &&
      (await this.recoverExitedStarting(
        identity,
        routingContext.readRecord()!,
        observer,
        stateWriteFailed,
      ));
    if (stateWriteFailure !== undefined)
      return this.executeLocally({ ...observedRequest, telemetryEnabled: false }, "cold");
    if (route.kind === "warm") return this.executeWarm(route.record, observedRequest);
    if (route.kind === "fallback") {
      await this.failureRecorder(request.workspaceRoot, stateWriteFailed).record(
        "fallback",
        route.reason === "dead" ? "process spawn" : "endpoint connect",
        route.reason === "dead" ? "process-terminated" : "daemon-incompatible",
        undefined,
        undefined,
        randomUUID(),
      );
    }
    if (
      stateWriteFailure === undefined &&
      ((route.kind === "cold" && route.reason === "absent") ||
        route.kind === "fallback" ||
        restartStarting)
    ) {
      DaemonClientRuntime.triggerIndependently(this.coordinator, identity, observedRequest);
    }
    return this.executeLocally(
      stateWriteFailure === undefined
        ? observedRequest
        : { ...observedRequest, telemetryEnabled: false },
      route.kind === "fallback" ? "fallback" : "cold",
    );
  }

  private async recoverExitedStarting(
    identity: DaemonWorkspaceIdentity,
    record: DaemonRecord,
    observer: DaemonRecordObserver,
    stateWriteFailed: DaemonStateWriteFailureObserver,
  ): Promise<boolean> {
    if ((await observer.observeIdentity(record)).kind !== "exited") return false;
    let journalWriteFailed = false;
    await this.failureRecorder(record.workspaceRoot, (failure) => {
      journalWriteFailed = true;
      stateWriteFailed(failure);
    }).record(
      "startup-failure",
      "process spawn",
      "process-terminated",
      undefined,
      record.instanceId,
    );
    if (journalWriteFailed) return false;
    try {
      return this.registry.removeIfProcess(identity, record.instanceId, record.processToken);
    } catch (error) {
      const failure = DaemonStateWriteErrors.from(error, this.options.stateDirectory);
      if (failure !== undefined) stateWriteFailed(failure);
      return false;
    }
  }

  control(
    request: Extract<DaemonControlRequest, { readonly action: "start" }>,
  ): Promise<DaemonStartResult>;
  control(
    request: Extract<DaemonControlRequest, { readonly action: "status" }>,
  ): Promise<DaemonStatusReport>;
  control(
    request: Extract<DaemonControlRequest, { readonly action: "stop" }>,
  ): Promise<DaemonStopResult>;
  async control(
    request: DaemonControlRequest,
  ): Promise<DaemonStartResult | DaemonStatusReport | DaemonStopResult> {
    let stateWriteFailure: DaemonStateWriteFailure | undefined;
    const stateWriteFailed: DaemonStateWriteFailureObserver = (failure) => {
      if (stateWriteFailure !== undefined) return;
      stateWriteFailure = failure;
      request.stateWriteFailed?.(failure);
    };
    const observedRequest =
      request.stateWriteFailed === undefined ? request : { ...request, stateWriteFailed };
    const controller = this.controllerFor(observedRequest);
    try {
      if (request.action === "start") {
        if (!this.options.daemonEnabled) return { status: "disabled" };
        return await controller.start(request.workspaceRoot);
      }
      if (request.action === "status") return await controller.status();
      return await controller.stop(request.workspaceRoot);
    } catch (error) {
      const failure = DaemonStateWriteErrors.from(error, this.options.stateDirectory);
      if (failure !== undefined) stateWriteFailed(failure);
      throw error;
    }
  }

  private controllerFor(request: DaemonControlRequest): DaemonController {
    if (request.stateWriteFailed === undefined)
      return request.action === "status" ? this.statusController : this.controlController;
    const processTerminator = new NodeDaemonProcessTerminator(this.policy.values.shutdown);
    const transport = new DaemonWriteObservedLifecycle(
      request.action === "status" ? this.statusTransport : this.routingTransport,
      this.options.stateDirectory,
      request.stateWriteFailed,
    );
    const launcher = new NodeDaemonProcessLauncher(
      this.options.productVersion,
      this.options.executorModuleUrl,
      this.policy,
    );
    return new DaemonController(this.registry, transport, this.options.stateDirectory, {
      policy: this.policy.values,
      processTerminator,
      launcher,
      startupCoordinator:
        request.action === "start"
          ? new DaemonStartupCoordinator(this.registry, launcher, transport, {
              policy: this.policy.values,
              processTerminator,
              readinessProbe: this.options.readinessProbe,
            })
          : this.coordinator,
      ...(request.stateWriteFailed === undefined
        ? {}
        : { stateWriteFailed: request.stateWriteFailed }),
    });
  }

  private async executeWarm(
    record: DaemonRecord,
    request: DaemonClientExecuteRequest,
  ): Promise<DaemonClientExecuteResult> {
    const requestId = randomUUID();
    let receipt: Awaited<ReturnType<DaemonClientTransport["execute"]>>;
    try {
      receipt = await this.routingTransport.execute(record.endpoint, {
        kind: "execute",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: record.instanceId,
        processToken: record.processToken,
        requestId,
        commandName: request.commandName,
        request: DaemonClientRuntime.executorRequest(request, "warm"),
      });
    } catch (error) {
      DaemonClientRuntime.observeWriteFailure(request, error, this.options.stateDirectory);
      if (error instanceof DaemonTransportError && error.retrySafe) {
        let journalWriteFailed = false;
        if (DaemonStateWriteErrors.from(error) === undefined) {
          const lifetimeFailure = DaemonProcessLifetimeCreationError.from(error);
          const phase = lifetimeFailure === undefined ? "endpoint connect" : "endpoint create";
          const reason =
            lifetimeFailure === undefined
              ? error.code === "incompatible"
                ? "daemon-incompatible"
                : "endpoint-connect-failed"
              : "endpoint-create-failed";
          await this.failureRecorder(record.workspaceRoot, (failure) => {
            journalWriteFailed = true;
            request.stateWriteFailed?.(failure);
          }).record("fallback", phase, reason, error, record.instanceId, requestId);
        }
        return this.executeLocally(
          journalWriteFailed ? { ...request, telemetryEnabled: false } : request,
          "fallback",
        );
      }
      await this.recordTransportFailure(record, request, error);
      return { mode: "warm", result: DaemonControlledResult.acceptedRequestDidNotComplete() };
    }
    try {
      const completion = await receipt.completion;
      if (completion.status === "failed") {
        if (completion.stateWriteFailure !== undefined)
          request.stateWriteFailed?.(completion.stateWriteFailure);
        return {
          mode: "warm",
          result: {
            ...DaemonClientRuntime.controlledFailure(completion.code),
            ...(completion.stateWriteFailure === undefined
              ? {}
              : { stateWriteFailure: completion.stateWriteFailure }),
          },
        };
      }
      if (!DaemonClientRuntime.isCompleteResult(completion.result)) {
        await DaemonClientRuntime.disposeMalformedOutput(completion.result);
        return { mode: "warm", result: DaemonControlledResult.acceptedRequestDidNotComplete() };
      }
      return { mode: "warm", result: completion.result };
    } catch (error) {
      DaemonClientRuntime.observeWriteFailure(request, error, this.options.stateDirectory);
      await this.recordTransportFailure(record, request, error);
      return { mode: "warm", result: DaemonControlledResult.acceptedRequestDidNotComplete() };
    }
  }

  private failureRecorder(
    workspaceRoot: string,
    stateWriteFailed?: DaemonStateWriteFailureObserver,
  ): DaemonFailureRecorder {
    return new DaemonFailureRecorder(
      new DaemonFailureJournal(
        this.options.stateDirectory,
        this.policy.values.diagnostics,
        this.clock,
      ),
      workspaceRoot,
      this.clock,
      stateWriteFailed,
    );
  }

  private async recordTransportFailure(
    record: DaemonRecord,
    request: DaemonClientExecuteRequest,
    error: unknown,
  ): Promise<void> {
    if (DaemonStateWriteErrors.from(error) !== undefined) return;
    const logger = new DaemonLogger(
      DaemonWorkspaceIdentity.from(record.workspaceRoot, this.options.stateDirectory),
      record.instanceId,
      this.clock,
      {
        policy: this.policy.values.diagnostics,
        ...(request.stateWriteFailed === undefined
          ? {}
          : { stateWriteFailed: request.stateWriteFailed }),
      },
    );
    logger.record({
      kind: "failure",
      operation: "completion-delivery",
      failureCode: "internal",
      errorName: DaemonLogger.errorName(error),
      failure: DaemonFailureRecorder.failure(
        this.clock.wallNowMs(),
        "transfer",
        "transfer-failed",
        error,
      ),
    });
    await logger.close();
  }

  private async executeLocally(
    request: DaemonClientExecuteRequest,
    mode: "cold" | "fallback",
  ): Promise<DaemonClientExecuteResult> {
    if (request.executeLocally !== undefined)
      return { mode, result: await request.executeLocally(mode) };
    const executor = await this.options.executorFactory({
      stateDirectory: this.options.stateDirectory,
      productVersion: this.options.productVersion,
      sampleResources: () => undefined,
    });
    const result = await executor.execute(DaemonClientRuntime.executorRequest(request, mode));
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
    request: DaemonClientExecuteRequest,
  ): void {
    try {
      void coordinator.trigger(identity, request.stateWriteFailed).catch(async (error: unknown) => {
        DaemonClientRuntime.observeWriteFailure(request, error, identity.identityDirectory);
        await coordinator.recordTriggerFailure(identity, error, request.stateWriteFailed);
      });
    } catch (error) {
      DaemonClientRuntime.observeWriteFailure(request, error, identity.identityDirectory);
    }
  }

  private static observeWriteFailure(
    request: DaemonClientExecuteRequest,
    error: unknown,
    path: string,
  ): void {
    const failure = DaemonStateWriteErrors.from(error, path);
    if (failure !== undefined) request.stateWriteFailed?.(failure);
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
