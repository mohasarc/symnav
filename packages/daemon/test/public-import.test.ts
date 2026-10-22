import { describe, expect, expectTypeOf, it } from "vitest";
import * as daemonRuntime from "@symnav/daemon";
import {
  DAEMON_COMMAND_NAMES,
  DaemonClient,
  DaemonPolicy,
  type DaemonActivitySnapshot,
  type DaemonClientExecuteRequest,
  type DaemonClientExecuteResult,
  type DaemonClientOptions,
  type DaemonCommandName,
  type DaemonControlRequest,
  type DaemonDiagnosticValue,
  type DaemonDiagnostics,
  type DaemonExecutionMode,
  type DaemonExecutor,
  type DaemonExecutorExecutionResult,
  type DaemonExecutorFactory,
  type DaemonExecutorFactoryOptions,
  type DaemonExecutorInitializationResult,
  type DaemonExecutorModule,
  type DaemonExecutorModuleUrl,
  type DaemonExecutorOutput,
  type DaemonExecutorRequest,
  type DaemonOutputRecord,
  type DaemonOutputStream,
  type DaemonPolicyValues,
  type DaemonReadinessProbe,
  type DaemonStartResult,
  type DaemonStatusEnvelope,
  type DaemonStopResult,
  type DaemonSystemMemory,
  type RunningDaemonStatus,
} from "@symnav/daemon";

describe("@symnav/daemon public import", () => {
  it("exports the exact runtime surface", () => {
    expect(Object.keys(daemonRuntime).sort()).toEqual([
      "DAEMON_COMMAND_NAMES",
      "DaemonClient",
      "DaemonPolicy",
    ]);
    expect(DAEMON_COMMAND_NAMES.length).toBeGreaterThan(0);
    expect(DaemonClient).toBeTypeOf("function");
    expect(DaemonPolicy).toBeTypeOf("function");
  });

  it("exposes the complete host type allowlist", () => {
    expectTypeOf<DaemonExecutionMode>().toBeString();
    expectTypeOf<DaemonOutputStream>().toBeString();
    expectTypeOf<DaemonExecutorRequest>().toBeObject();
    expectTypeOf<DaemonOutputRecord>().toBeObject();
    expectTypeOf<DaemonExecutorOutput>().toBeObject();
    expectTypeOf<DaemonDiagnosticValue>();
    expectTypeOf<DaemonDiagnostics>().toBeObject();
    expectTypeOf<DaemonExecutorInitializationResult>().toBeObject();
    expectTypeOf<DaemonExecutorExecutionResult>().toBeObject();
    expectTypeOf<DaemonExecutor>().toBeObject();
    expectTypeOf<DaemonExecutorFactoryOptions>().toBeObject();
    expectTypeOf<DaemonExecutorFactory>().toBeFunction();
    expectTypeOf<DaemonExecutorModule>().toBeObject();
    expectTypeOf<DaemonExecutorModuleUrl>().toBeString();
    expectTypeOf<DaemonCommandName>().toBeString();
    expectTypeOf<DaemonActivitySnapshot>().toBeObject();
    expectTypeOf<RunningDaemonStatus>().toBeObject();
    expectTypeOf<DaemonStatusEnvelope>().toBeObject();
    expectTypeOf<DaemonStartResult>().toBeObject();
    expectTypeOf<DaemonStopResult>().toBeObject();
    expectTypeOf<DaemonSystemMemory>().toBeObject();
    expectTypeOf<DaemonPolicyValues>().toBeObject();
    expectTypeOf<DaemonReadinessProbe>();
    expectTypeOf<DaemonClientOptions>().toBeObject();
    expectTypeOf<DaemonClientExecuteRequest>().toBeObject();
    expectTypeOf<DaemonClientExecuteResult>().toBeObject();
    expectTypeOf<DaemonControlRequest>().toBeObject();
  });
});
