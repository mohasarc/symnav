import { describe, expect, it, vi } from "vitest";
import type { DaemonFailureEvent } from "../daemon-failure.js";
import { DaemonStateWriteErrors } from "../state-write-errors.js";
import { DaemonTransportError } from "../transport/transport-error.js";
import { DaemonFailureRecorder } from "./failure-recorder.js";

describe("DaemonFailureRecorder", () => {
  it("records closed phase and original OS cause without messages or stacks", async () => {
    const record = vi.fn<(event: DaemonFailureEvent) => Promise<void>>().mockResolvedValue();
    const recorder = new DaemonFailureRecorder({ record }, "/workspace", { wallNowMs: () => 23 });
    const cause = Object.assign(new Error("secret source and environment"), { code: "ECONNRESET" });
    const error = new DaemonTransportError(
      "unreachable",
      "not-submitted",
      "secret",
      undefined,
      undefined,
      cause,
    );
    await recorder.record(
      "fallback",
      "endpoint connect",
      "endpoint-connect-failed",
      error,
      "instance",
      "request",
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      schemaVersion: 1,
      eventId: expect.any(String),
      workspaceRoot: "/workspace",
      instanceId: "instance",
      requestId: "request",
      kind: "fallback",
      failure: {
        phase: "endpoint connect",
        reason: "daemon-connection-reset",
        timestamp: 23,
        osCode: "ECONNRESET",
      },
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain("secret");
  });

  it("observes a journal write failure once without recursively recording it", async () => {
    const error = DaemonStateWriteErrors.failedWrite(
      "/state",
      Object.assign(new Error("denied"), { code: "EPERM" }),
    );
    const record = vi.fn().mockRejectedValue(error);
    const stateWriteFailed = vi.fn();
    const recorder = new DaemonFailureRecorder(
      { record },
      "/workspace",
      { wallNowMs: () => 23 },
      stateWriteFailed,
    );
    await recorder.record(
      "startup-failure",
      "process spawn",
      "process-spawn-failed",
      undefined,
      "instance",
    );
    expect(record).toHaveBeenCalledTimes(1);
    expect(stateWriteFailed).toHaveBeenCalledTimes(1);
    expect(stateWriteFailed).toHaveBeenCalledWith({ path: "/state", osCode: "EPERM" });
  });
});
