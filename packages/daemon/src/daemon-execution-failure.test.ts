import { describe, expect, expectTypeOf, it } from "vitest";

import {
  DaemonExecutionFailures,
  type DaemonExecutionFailureCode,
  type DaemonExecutionFailureContext,
  type DaemonWorkerFailureCode,
} from "./daemon-execution-failure.js";

describe("DaemonExecutionFailures", () => {
  it("accepts exactly the closed outer failure vocabulary", () => {
    const codes = [
      "worker-exit",
      "controlled-resource",
      "response-capacity",
      "stopping",
      "internal",
    ] as const satisfies readonly DaemonExecutionFailureCode[];

    for (const code of codes) expect(DaemonExecutionFailures.isCode(code)).toBe(true);
    for (const value of [undefined, null, 1, "", "execution", "resource", "unknown"]) {
      expect(DaemonExecutionFailures.isCode(value)).toBe(false);
    }
  });

  it("keeps the worker vocabulary distinct from outer failures", () => {
    expectTypeOf<DaemonWorkerFailureCode>().toEqualTypeOf<
      "initialization" | "execution" | "protocol" | "resource"
    >();
    expectTypeOf<Extract<DaemonWorkerFailureCode, DaemonExecutionFailureCode>>().toBeNever();
  });

  it.each<[string, DaemonExecutionFailureContext, DaemonExecutionFailureCode]>([
    [
      "consumed resource interruption",
      {
        resourceInterrupted: true,
        responseCapacityExceeded: true,
        workerExited: true,
        shutdownFailureCode: "stopping",
        shutdownStarted: true,
      },
      "controlled-resource",
    ],
    [
      "spool capacity",
      {
        resourceInterrupted: false,
        responseCapacityExceeded: true,
        workerExited: true,
        shutdownFailureCode: "stopping",
        shutdownStarted: true,
      },
      "response-capacity",
    ],
    [
      "worker exit during graceful shutdown",
      {
        resourceInterrupted: false,
        responseCapacityExceeded: false,
        workerExited: true,
        shutdownFailureCode: "stopping",
        shutdownStarted: true,
      },
      "stopping",
    ],
    [
      "worker exit during controlled shutdown",
      {
        resourceInterrupted: false,
        responseCapacityExceeded: false,
        workerExited: true,
        shutdownFailureCode: "controlled-resource",
        shutdownStarted: true,
      },
      "worker-exit",
    ],
    [
      "worker exit without shutdown",
      {
        resourceInterrupted: false,
        responseCapacityExceeded: false,
        workerExited: true,
        shutdownStarted: false,
      },
      "worker-exit",
    ],
    [
      "first shutdown failure",
      {
        resourceInterrupted: false,
        responseCapacityExceeded: false,
        workerExited: false,
        shutdownFailureCode: "controlled-resource",
        shutdownStarted: true,
      },
      "controlled-resource",
    ],
    [
      "shutdown begun",
      {
        resourceInterrupted: false,
        responseCapacityExceeded: false,
        workerExited: false,
        shutdownStarted: true,
      },
      "stopping",
    ],
    [
      "internal fallback",
      {
        resourceInterrupted: false,
        responseCapacityExceeded: false,
        workerExited: false,
        shutdownStarted: false,
      },
      "internal",
    ],
  ])("classifies %s with preserved precedence", (_name, context, expected) => {
    expect(DaemonExecutionFailures.classify(context)).toBe(expected);
  });
});
