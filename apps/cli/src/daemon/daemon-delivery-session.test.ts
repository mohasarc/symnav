import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonPolicy } from "@symnav/daemon";
import { AcceptedRequestLedger } from "./accepted-request-ledger.js";
import { DaemonCompletionSpoolStore } from "./completion-spool.js";
import { DaemonDeliverySession } from "./daemon-delivery-session.js";
import { DaemonOperationObserver } from "./daemon-operation-observer.js";
import type { DaemonDiagnosticEvent } from "./daemon-protocol.js";

describe("DaemonDeliverySession", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  it("creates completion writers and records their spool timing", async () => {
    const harness = await DeliverySessionHarness.create(directories);
    const trace = harness.session.beginAcceptedTrace("request-1", "version", 2, 3);

    const completion = await harness.session.createCompletion("request-1");
    await completion.append({ sequence: 0, stream: "stdout", bytes: Buffer.from("result\n") });
    harness.setMonotonicNow(17);
    const manifest = await completion.finish(4);

    expect(trace).toBeDefined();
    expect(manifest).toMatchObject({
      requestId: "request-1",
      instanceId: "instance-1",
      exitCode: 4,
      rawBytes: 7,
      recordCount: 1,
    });
    expect(harness.session.snapshot).toEqual({
      spoolBytes: 7,
      hasUnacknowledgedCompletions: false,
    });
    expect(harness.events).toEqual([
      {
        kind: "request-accepted",
        requestId: "request-1",
        command: "version",
        queueDepth: 2,
        workerGeneration: 3,
      },
      {
        kind: "response-spooled",
        requestId: "request-1",
        rawBytes: 7,
        recordCount: 1,
        spoolMs: 17,
      },
    ]);
  });
});

class DeliverySessionHarness {
  private constructor(
    readonly session: DaemonDeliverySession,
    readonly events: DaemonDiagnosticEvent[],
    private readonly time: { monotonicNow: number },
  ) {}

  static async create(directories: string[]): Promise<DeliverySessionHarness> {
    const directory = await mkdtemp(join(tmpdir(), "symnav-delivery-session-"));
    directories.push(directory);
    const policy = DaemonPolicy.currentSystem().values;
    const journal = new AcceptedRequestLedger(() => 1);
    const events: DaemonDiagnosticEvent[] = [];
    const time = { monotonicNow: 0 };
    const clock = {
      wallNowMs: () => 1,
      monotonicNowMs: () => time.monotonicNow,
    };
    const diagnostics = { record: (event: DaemonDiagnosticEvent) => events.push(event) };
    const observer = new DaemonOperationObserver(diagnostics, clock);
    const spoolStore = new DaemonCompletionSpoolStore({
      directory,
      workspaceKey: "workspace-1",
      instanceId: "instance-1",
      policy: policy.output,
    });
    const harness = new DeliverySessionHarness(
      new DaemonDeliverySession({
        coordinates: { instanceId: "instance-1", processToken: "token-1" },
        journal,
        spoolStore,
        observer,
        diagnostics,
        clock,
        policy,
      }),
      events,
      time,
    );
    return harness;
  }

  setMonotonicNow(monotonicNow: number): void {
    this.time.monotonicNow = monotonicNow;
  }
}
