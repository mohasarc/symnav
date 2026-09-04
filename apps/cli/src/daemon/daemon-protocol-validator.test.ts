import { describe, expect, it } from "vitest";
import { DaemonProtocolValidator } from "./daemon-protocol-validator.js";
import {
  DAEMON_PROTOCOL_VERSION,
  type DaemonExecuteRequest,
  type DaemonExecutionServerFrame,
  type DaemonLifecycleRequest,
  type DaemonLifecycleResponse,
} from "./daemon-protocol.js";

const validator = new DaemonProtocolValidator();
const executionRequest: DaemonExecuteRequest = {
  kind: "execute",
  protocolVersion: DAEMON_PROTOCOL_VERSION,
  instanceId: "instance",
  processToken: "token",
  requestId: "request",
  commandName: "version",
  request: {
    argv: ["--version"],
    cwd: "/repo",
    telemetryEnabled: false,
    executionMode: "warm",
  },
};

describe("DaemonProtocolValidator", () => {
  it.each([
    { kind: "identify", instanceId: "instance", processToken: "token" },
    { kind: "terminate", instanceId: "instance", processToken: "token" },
    { kind: "kill", instanceId: "instance", processToken: "token" },
    { kind: "ping", protocolVersion: DAEMON_PROTOCOL_VERSION, instanceId: "instance" },
    { kind: "stop", protocolVersion: DAEMON_PROTOCOL_VERSION, instanceId: "instance" },
    executionRequest,
    {
      kind: "execution-status",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
    },
    {
      kind: "result-fetch",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      offset: 0,
    },
    {
      kind: "result-ack",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      transferId: "transfer",
    },
  ] as const)("accepts the exact $kind request schema", (request) => {
    expect(validator.request(request)).toEqual(request);
    expect(() => validator.request({ ...request, extra: true })).toThrow(/Malformed daemon/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "rejects invalid protocol version %s",
    (protocolVersion) => {
      expect(() =>
        validator.lifecycleRequest({ kind: "ping", protocolVersion, instanceId: "instance" }),
      ).toThrow("Malformed daemon request envelope");
    },
  );

  it.each(["/source/secret", " space", "request!", ""])(
    "rejects invalid runtime request identifier %s",
    (requestId) => {
      expect(() => validator.request({ ...executionRequest, requestId })).toThrow(
        "Malformed daemon execution request",
      );
    },
  );

  it.each([
    [
      { kind: "identify", instanceId: "instance", processToken: "token" },
      {
        kind: "identity",
        instanceId: "instance",
        processToken: "token",
        pid: 123,
        startedAt: 10,
      },
    ],
    [
      { kind: "terminate", instanceId: "instance", processToken: "token" },
      { kind: "terminating", instanceId: "instance", processToken: "token" },
    ],
    [
      { kind: "kill", instanceId: "instance", processToken: "token" },
      { kind: "killing", instanceId: "instance", processToken: "token" },
    ],
    [
      { kind: "ping", protocolVersion: DAEMON_PROTOCOL_VERSION, instanceId: "instance" },
      {
        kind: "pong",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        instanceId: "instance",
        symnavVersion: "0.1.0",
      },
    ],
    [
      { kind: "stop", protocolVersion: DAEMON_PROTOCOL_VERSION, instanceId: "instance" },
      { kind: "stopped", instanceId: "instance" },
    ],
  ] as const)("accepts and correlates an exact $0.kind lifecycle response", (request, response) => {
    expect(validator.lifecycleResponse(request as DaemonLifecycleRequest, response)).toEqual(
      response,
    );
    expect(() =>
      validator.lifecycleResponse(request as DaemonLifecycleRequest, { ...response, extra: true }),
    ).toThrow(/Malformed daemon/);
  });

  it("requires finite lifecycle metrics and consistent activity", () => {
    const request = {
      kind: "ping",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
    } as const;
    const response = {
      kind: "pong",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      symnavVersion: "0.1.0",
      startedAt: Number.POSITIVE_INFINITY,
    } satisfies DaemonLifecycleResponse;
    expect(() => validator.lifecycleResponse(request, response)).toThrow("Malformed daemon pong");

    expect(() =>
      validator.lifecycleResponse(request, {
        ...response,
        startedAt: 10,
        activity: {
          lifecycle: "busy",
          pid: 123,
          startedAt: 10,
          startupElapsedMs: 1,
          fileCount: 1,
          processRssBytes: 1,
          hardProcessRssBytes: 2,
          workerGeneration: 1,
          queued: 0,
          spoolBytes: 0,
        },
      }),
    ).toThrow("Malformed daemon pong");
  });

  it.each([
    acceptedFrame(),
    {
      kind: "rejected",
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      code: "not-ready",
      retrySafe: true,
    },
    {
      kind: "execution-failed",
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      code: "internal",
    },
    {
      kind: "result-manifest",
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      manifest: {
        transferId: "transfer",
        instanceId: "instance",
        requestId: "request",
        exitCode: 0,
        rawBytes: 0,
        recordCount: 0,
        sha256: "0".repeat(64),
      },
    },
    {
      kind: "result-end",
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
      transferId: "transfer",
      rawBytes: 0,
      recordCount: 0,
      sha256: "0".repeat(64),
    },
  ] satisfies readonly DaemonExecutionServerFrame[])(
    "accepts and correlates an exact $kind execution frame",
    (frame) => {
      expect(validator.executionFrame(executionRequest, frame)).toEqual(frame);
      expect(() => validator.executionFrame(executionRequest, { ...frame, extra: true })).toThrow(
        /Malformed daemon/,
      );
    },
  );

  it("rejects invalid execution codes and inconsistent retry flags", () => {
    expect(() =>
      validator.executionFrame(executionRequest, {
        ...acceptedFrame(),
        kind: "execution-failed",
        code: "legacy-worker-failure",
      }),
    ).toThrow("Malformed daemon execution failure");
    expect(() =>
      validator.executionFrame(executionRequest, {
        ...acceptedFrame(),
        kind: "rejected",
        code: "not-ready",
        retrySafe: false,
      }),
    ).toThrow("Malformed daemon execution rejection");
  });

  it.each([{ instanceId: "other" }, { processToken: "other" }, { requestId: "other" }])(
    "rejects mismatched execution coordinates %#",
    (mismatch) => {
      expect(() =>
        validator.executionFrame(executionRequest, { ...acceptedFrame(), ...mismatch }),
      ).toThrow(/does not match/);
    },
  );

  it("rejects legacy embedded results and wrong-kind responses", () => {
    expect(() =>
      validator.executionFrame(executionRequest, {
        kind: "completed",
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        result: { exitCode: 0 },
      }),
    ).toThrow("Malformed daemon response");
    expect(() =>
      validator.lifecycleResponse(
        { kind: "ping", protocolVersion: DAEMON_PROTOCOL_VERSION, instanceId: "instance" },
        { kind: "stopped", instanceId: "instance" },
      ),
    ).toThrow("Daemon pong does not match request protocol and instance");
  });

  it("validates status and acknowledgement schemas and coordinates", () => {
    const statusRequest = {
      kind: "execution-status",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      instanceId: "instance",
      processToken: "token",
      requestId: "request",
    } as const;
    expect(
      validator.executionStatusResponse(statusRequest, {
        kind: "execution-status",
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        status: { state: "running", startedAt: 10 },
      }),
    ).toMatchObject({ status: { state: "running" } });
    expect(() =>
      validator.executionStatusResponse(statusRequest, {
        kind: "execution-status",
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        status: { state: "completed" },
        extra: true,
      }),
    ).toThrow("Malformed daemon execution status");
    expect(() =>
      validator.executionStatusResponse(statusRequest, {
        kind: "execution-status",
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        status: { state: "failed", code: "legacy" },
      }),
    ).toThrow("Malformed daemon execution status");

    expect(() =>
      validator.resultAcknowledgement(executionRequest, "transfer", {
        kind: "result-acknowledged",
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        transferId: "other",
      }),
    ).toThrow("Invalid daemon result acknowledgement");
    expect(() =>
      validator.resultAcknowledgement(executionRequest, "transfer", {
        kind: "result-acknowledged",
        instanceId: "instance",
        processToken: "token",
        requestId: "request",
        transferId: "transfer",
        extra: true,
      }),
    ).toThrow("Malformed daemon result acknowledgement");
  });
});

function acceptedFrame(): Extract<DaemonExecutionServerFrame, { kind: "accepted" }> {
  return {
    kind: "accepted",
    instanceId: "instance",
    processToken: "token",
    requestId: "request",
    acceptedAt: 1,
    queuePosition: 0,
  };
}
