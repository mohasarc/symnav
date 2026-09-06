import { randomUUID } from "node:crypto";
import { createWorkspace } from "@symnav/core";
import type {
  DaemonCommandName,
  DaemonExecutionFailureCode,
  DaemonExecutorExecutionResult,
  DaemonPolicy,
} from "@symnav/daemon";
import { CliProgramExecutor } from "../cli-program-executor.js";
import { daemonExecutorModuleUrl } from "../daemon-executor.js";
import type {
  CliExecutionRequest,
  CommandExecutionResult,
  DispatchedCommandResult,
} from "../command-execution-result.js";
import { ControlledCommandResult } from "../command-execution-result.js";
import type { ProgramDependencies } from "../program-dependencies.js";
import type { DaemonExecuteRequest, DaemonRecord } from "./daemon-protocol.js";
import { DaemonRegistry } from "./daemon-registry.js";
import {
  NodeDaemonProcessLauncher,
  NodeDaemonProcessTerminator,
} from "./daemon-process-launcher.js";
import {
  DaemonStartupCoordinator,
  type DaemonWarmupTriggerResult,
} from "./daemon-startup-coordinator.js";
import { DaemonWorkspaceIdentity } from "./daemon-workspace-identity.js";
import { InvocationWorkspaceSelector } from "../invocation-workspace-selector.js";
import { DaemonTransportError } from "./daemon-transport-error.js";
import { LocalDaemonTransport } from "./local-daemon-transport.js";
import type { DaemonExecutionReceipt, DaemonExecutionRequester } from "./daemon-transport.js";
import { DaemonRecordObserver, type DaemonObservation } from "./daemon-record-observer.js";

export type DaemonRouteSnapshot =
  | { readonly kind: "disabled" }
  | { readonly kind: "cold"; readonly reason: "absent" | "starting" | "recovering" }
  | { readonly kind: "warm"; readonly record: DaemonRecord }
  | { readonly kind: "fallback"; readonly reason: "dead" | "incompatible" };

export interface DaemonWarmupTrigger {
  trigger(identity: DaemonWorkspaceIdentity): Promise<DaemonWarmupTriggerResult>;
}

interface DaemonDispatchRegistry {
  read(identity: DaemonWorkspaceIdentity): DaemonRecord | undefined;
  removeIfProcess(
    identity: DaemonWorkspaceIdentity,
    instanceId: string,
    processToken: string,
  ): boolean;
}

interface DaemonDispatchObserver {
  observe(record: DaemonRecord): Promise<DaemonObservation>;
}

export interface DaemonDispatchRuntime {
  readonly coordinator: DaemonWarmupTrigger;
  readonly observer: DaemonDispatchObserver;
  readonly registry: DaemonDispatchRegistry;
  readonly transport: DaemonExecutionRequester;
}

interface CommandExecutor {
  execute(request: CliExecutionRequest): Promise<CommandExecutionResult>;
}

export interface DaemonCommandDispatcherOptions {
  readonly createDependencies: (stateDirectory: string) => ProgramDependencies;
  readonly stateDirectory: string;
  readonly policy: DaemonPolicy;
  readonly daemonEnabled?: () => boolean;
  readonly selector?: InvocationWorkspaceSelector;
  readonly resolveWorkspaceRoot?: (
    startDir: string,
    dependencies: ProgramDependencies,
  ) => Promise<string>;
  readonly runtimeFactory?: (
    identity: DaemonWorkspaceIdentity,
    dependencies: ProgramDependencies,
    policy: DaemonPolicy,
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
    policy: DaemonPolicy,
  ) => DaemonDispatchRuntime;
  private readonly executorFactory: (dependencies: ProgramDependencies) => CommandExecutor;
  private readonly requestId: () => string;
  private readonly policy: DaemonPolicy;

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
    this.policy = options.policy;
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
    const runtime = this.runtimeFactory(identity, workspaceDependencies, this.policy);
    const routeSnapshot = await this.routeFor(
      identity,
      runtime,
      workspaceDependencies.symnavVersion,
    );
    if (routeSnapshot.kind === "warm") {
      return this.executeWarm(
        runtime,
        routeSnapshot.record,
        selected.commandName,
        workspaceRequest,
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
    commandName: DaemonCommandName,
    request: CliExecutionRequest,
  ): Promise<DispatchedCommandResult> {
    let receipt: DaemonExecutionReceipt;
    try {
      receipt = await runtime.transport.execute(record.endpoint, {
        kind: "execute",
        protocolVersion: record.protocolVersion,
        instanceId: record.instanceId,
        processToken: record.processToken,
        requestId: this.requestId(),
        commandName,
        request: { ...request, executionMode: "warm" },
      });
    } catch (error) {
      if (DaemonCommandDispatcher.isRetrySafeFailure(error)) {
        return this.executeLocally(request, "fallback");
      }
      return { mode: "warm", result: ControlledCommandResult.acceptedRequestDidNotComplete() };
    }
    try {
      const completion = await receipt.completion;
      if (completion.status === "failed") {
        return {
          mode: "warm",
          result: DaemonCommandDispatcher.controlledFailure(completion.code),
        };
      }
      if (!DaemonCommandDispatcher.isCompleteResult(completion.result)) {
        return { mode: "warm", result: ControlledCommandResult.acceptedRequestDidNotComplete() };
      }
      return {
        mode: "warm",
        result: completion.result,
      };
    } catch {
      return { mode: "warm", result: ControlledCommandResult.acceptedRequestDidNotComplete() };
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
    policy: DaemonPolicy,
  ): DaemonDispatchRuntime {
    const registry = new DaemonRegistry(identity.registryDirectory, policy.values.startup);
    const transport = new LocalDaemonTransport({ policy });
    const processTerminator = new NodeDaemonProcessTerminator(policy.values.shutdown);
    const launcher = new NodeDaemonProcessLauncher(
      dependencies.symnavVersion,
      daemonExecutorModuleUrl(),
      policy,
      processTerminator,
    );
    return {
      registry,
      transport,
      observer: new DaemonRecordObserver(transport, processTerminator),
      coordinator: new DaemonStartupCoordinator(registry, launcher, transport, {
        policy: policy.values,
        processTerminator,
      }),
    };
  }

  private static isCompleteResult(result: DaemonExecutorExecutionResult): boolean {
    return Number.isInteger(result.exitCode) && result.output !== undefined;
  }

  private static isRetrySafeFailure(error: unknown): boolean {
    return error instanceof DaemonTransportError && error.retrySafe;
  }

  private static controlledFailure(code: DaemonExecutionFailureCode): CommandExecutionResult {
    if (code === "controlled-resource") return ControlledCommandResult.workspaceCapacityExceeded();
    if (code === "response-capacity") return ControlledCommandResult.responseCapacityExceeded();
    return ControlledCommandResult.acceptedRequestDidNotComplete();
  }
}
