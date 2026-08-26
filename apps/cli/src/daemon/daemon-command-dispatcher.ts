import { randomUUID } from "node:crypto";
import { createWorkspace } from "@symnav/core";
import type { Recorder, UsageEventInput } from "@symnav/telemetry";
import { CliProgramExecutor } from "../cli-program-executor.js";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
  DispatchedCommandResult,
} from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import type { DaemonRecord, DaemonRequest, DaemonResponse } from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import {
  NodeDaemonProcessLauncher,
  NodeDaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import { DaemonStartupCoordinator } from "./daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";
import { DaemonTransportError, LocalDaemonTransport } from "./local-daemon-transport.js";
import { DaemonRecordObserver, type DaemonObservation } from "./daemon-record-observer.js";

export type DaemonRouteSnapshot =
  | { readonly kind: "disabled" }
  | { readonly kind: "cold"; readonly reason: "absent" | "starting" | "recovering" }
  | { readonly kind: "warm"; readonly record: DaemonRecord }
  | { readonly kind: "fallback"; readonly reason: "dead" | "incompatible" };

interface DaemonWarmupTrigger {
  trigger(identity: DaemonWorkspaceIdentity): Promise<unknown>;
}

interface DaemonDispatchRegistry {
  read(identity: DaemonWorkspaceIdentity): DaemonRecord | undefined;
  removeIfProcess(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): boolean;
}

interface DaemonDispatchTransport {
  request(endpoint: string, request: DaemonRequest): Promise<DaemonResponse>;
}

interface DaemonDispatchObserver {
  observe(record: DaemonRecord): Promise<DaemonObservation>;
}

export interface DaemonDispatchRuntime {
  readonly coordinator: DaemonWarmupTrigger;
  readonly observer: DaemonDispatchObserver;
  readonly registry: DaemonDispatchRegistry;
  readonly transport: DaemonDispatchTransport;
}

interface CommandExecutor {
  execute(request: CliExecutionRequest): Promise<CommandExecutionResult>;
}

export interface DaemonCommandDispatcherOptions {
  readonly createDependencies: (stateDirectory: string) => ProgramDependencies;
  readonly stateDirectory: string;
  readonly daemonEnabled?: () => boolean;
  readonly selector?: InvocationWorkspaceSelector;
  readonly resolveWorkspaceRoot?: (
    startDir: string,
    dependencies: ProgramDependencies,
  ) => Promise<string>;
  readonly runtimeFactory?: (
    identity: DaemonWorkspaceIdentity,
    dependencies: ProgramDependencies,
  ) => DaemonDispatchRuntime;
  readonly executorFactory?: (dependencies: ProgramDependencies) => CommandExecutor;
  readonly requestId?: () => string;
}

export class DaemonCommandDispatcher {
  private readonly selector: InvocationWorkspaceSelector;
  private readonly daemonEnabled: () => boolean;
  private readonly resolveWorkspaceRoot: (
    startDir: string,
    dependencies: ProgramDependencies,
  ) => Promise<string>;
  private readonly runtimeFactory: (
    identity: DaemonWorkspaceIdentity,
    dependencies: ProgramDependencies,
  ) => DaemonDispatchRuntime;
  private readonly executorFactory: (dependencies: ProgramDependencies) => CommandExecutor;
  private readonly requestId: () => string;

  constructor(private readonly options: DaemonCommandDispatcherOptions) {
    this.selector = options.selector ?? new InvocationWorkspaceSelector();
    this.daemonEnabled = options.daemonEnabled ?? (() => true);
    this.resolveWorkspaceRoot =
      options.resolveWorkspaceRoot ??
      (async (startDir, dependencies) =>
        (await createWorkspace({ startDir, fs: dependencies.fs })).root);
    this.runtimeFactory = options.runtimeFactory ?? DaemonCommandDispatcher.createRuntime;
    this.executorFactory =
      options.executorFactory ?? ((dependencies) => new CliProgramExecutor(dependencies));
    this.requestId = options.requestId ?? randomUUID;
  }

  async execute(request: CliExecutionRequest): Promise<DispatchedCommandResult> {
    const selected = this.selector.select(request.argv, request.cwd);
    const route = selected.route;
    if (route.kind !== "workspace") {
      return this.executeLocally(request, "cold");
    }
    const workspaceRequest: CliExecutionRequest = {
      ...request,
      argv: selected.argv,
    };
    if (!this.daemonEnabled()) {
      return this.executeRoute({ kind: "disabled" }, workspaceRequest);
    }

    const workspaceDependencies = this.options.createDependencies(this.options.stateDirectory);
    let workspaceRoot: string;
    try {
      workspaceRoot = await this.resolveWorkspaceRoot(route.startDir, workspaceDependencies);
    } catch {
      return this.executeLocally(workspaceRequest, "cold");
    }

    const identity = DaemonWorkspaceIdentity.from(workspaceRoot, this.options.stateDirectory);
    const runtime = this.runtimeFactory(identity, workspaceDependencies);
    const routeSnapshot = await this.routeFor(
      identity,
      runtime,
      workspaceDependencies.symnavVersion,
    );
    if (routeSnapshot.kind === "warm") {
      return this.executeWarm(
        runtime,
        routeSnapshot.record,
        workspaceRequest,
        workspaceDependencies.recorder,
      );
    }
    if (
      (routeSnapshot.kind === "cold" && routeSnapshot.reason === "absent") ||
      routeSnapshot.kind === "fallback"
    ) {
      DaemonCommandDispatcher.triggerIndependently(runtime.coordinator, identity);
    }
    return this.executeRoute(routeSnapshot, workspaceRequest);
  }

  private async routeFor(
    identity: DaemonWorkspaceIdentity,
    runtime: DaemonDispatchRuntime,
    symnavVersion: string,
  ): Promise<DaemonRouteSnapshot> {
    let record: DaemonRecord | undefined;
    try {
      record = runtime.registry.read(identity);
    } catch {
      return { kind: "cold", reason: "recovering" };
    }
    if (record === undefined) return { kind: "cold", reason: "absent" };
    if (record.state === "starting") return { kind: "cold", reason: "starting" };
    if (record.symnavVersion !== symnavVersion) {
      return { kind: "fallback", reason: "incompatible" };
    }
    let observation: DaemonObservation;
    try {
      observation = await runtime.observer.observe(record);
    } catch {
      return { kind: "cold", reason: "recovering" };
    }
    if (observation.kind === "responsive") {
      if (observation.pong.symnavVersion !== symnavVersion) {
        return { kind: "fallback", reason: "incompatible" };
      }
      if (observation.pong.state === "starting") {
        return { kind: "cold", reason: "recovering" };
      }
      return { kind: "warm", record };
    }
    if (observation.kind === "starting") return { kind: "cold", reason: "starting" };
    if (observation.kind === "unresponsive") return { kind: "cold", reason: "recovering" };
    if (observation.kind === "exited") {
      try {
        runtime.registry.removeIfProcess(identity, record.instanceId, record.processToken);
      } catch {}
      return { kind: "fallback", reason: "dead" };
    }
    return { kind: "fallback", reason: "incompatible" };
  }

  private async executeWarm(
    runtime: DaemonDispatchRuntime,
    record: DaemonRecord,
    request: CliExecutionRequest,
    recorder: Recorder,
  ): Promise<DispatchedCommandResult> {
    try {
      const response = await runtime.transport.request(record.endpoint, {
        kind: "execute",
        protocolVersion: record.protocolVersion,
        instanceId: record.instanceId,
        requestId: this.requestId(),
        request: { ...request, executionMode: "warm", deferTelemetry: true },
      });
      if (
        response.kind !== "result" ||
        !DaemonCommandDispatcher.isCompleteResult(response.result)
      ) {
        throw new Error("Daemon returned an incomplete command result");
      }
      return {
        mode: "warm",
        result: DaemonCommandDispatcher.commitWarmTelemetry(response.result, recorder),
      };
    } catch (error) {
      if (DaemonCommandDispatcher.isPreAdmissionFailure(error)) {
        return this.executeLocally(request, "fallback");
      }
      throw error;
    }
  }

  private executeRoute(
    route: Exclude<DaemonRouteSnapshot, { readonly kind: "warm" }>,
    request: CliExecutionRequest,
  ): Promise<DispatchedCommandResult> {
    return this.executeLocally(request, route.kind === "fallback" ? "fallback" : "cold");
  }

  private executeLocally(
    request: CliExecutionRequest,
    mode: "cold" | "fallback",
  ): Promise<DispatchedCommandResult> {
    const executor = this.executorFactory(
      this.options.createDependencies(this.options.stateDirectory),
    );
    return executor
      .execute({ ...request, executionMode: mode })
      .then((result) => ({ mode, result }));
  }

  private static triggerIndependently(
    trigger: DaemonWarmupTrigger,
    identity: DaemonWorkspaceIdentity,
  ): void {
    try {
      void trigger.trigger(identity).catch(() => {});
    } catch {}
  }

  private static createRuntime(
    identity: DaemonWorkspaceIdentity,
    dependencies: ProgramDependencies,
  ): DaemonDispatchRuntime {
    const registry = new DaemonRegistry(identity.registryDirectory);
    const transport = new LocalDaemonTransport();
    const processTerminator = new NodeDaemonProcessTerminator();
    const launcher = new NodeDaemonProcessLauncher(
      dependencies.symnavVersion,
      undefined,
      processTerminator,
    );
    return {
      registry,
      transport,
      observer: new DaemonRecordObserver(transport, processTerminator),
      coordinator: new DaemonStartupCoordinator(registry, launcher, transport, {
        processTerminator,
      }),
    };
  }

  private static isCompleteResult(result: CommandExecutionResult): boolean {
    return (
      Number.isInteger(result.exitCode) &&
      Array.isArray(result.frames) &&
      result.frames.every(
        (frame) =>
          (frame.stream === "stdout" || frame.stream === "stderr") &&
          DaemonCommandDispatcher.isBase64(frame.bytesBase64),
      ) &&
      (result.telemetry === undefined || DaemonCommandDispatcher.isTelemetryInput(result.telemetry))
    );
  }

  private static isPreAdmissionFailure(error: unknown): boolean {
    return error instanceof DaemonTransportError && error.delivery === "not-submitted";
  }

  private static commitWarmTelemetry(
    result: CommandExecutionResult,
    recorder: Recorder,
  ): CommandExecutionResult {
    if (result.telemetry !== undefined) {
      try {
        recorder.record(result.telemetry);
      } catch {}
    }
    return { frames: result.frames, exitCode: result.exitCode };
  }

  private static isTelemetryInput(value: UsageEventInput): boolean {
    return (
      typeof value.symnavVersion === "string" &&
      typeof value.command === "string" &&
      typeof value.timestamp === "number" &&
      typeof value.durationMs === "number" &&
      value.executionMode === "warm" &&
      (value.outcome === "success" ||
        ((value.outcome === "user_error" || value.outcome === "crash") &&
          typeof value.errorReason === "string")) &&
      typeof value.argShape === "object" &&
      value.argShape !== null &&
      typeof value.argShape.kind === "string" &&
      typeof value.argShape.lengthBucket === "string" &&
      Array.isArray(value.argShape.flags) &&
      value.argShape.flags.every((flag) => typeof flag === "string") &&
      typeof value.workspaceId === "string" &&
      typeof value.machineId === "string"
    );
  }

  private static isBase64(value: string): boolean {
    if (value.length % 4 !== 0) return false;
    return /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/.test(value);
  }
}
