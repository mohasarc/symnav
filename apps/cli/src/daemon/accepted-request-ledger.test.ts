import { describe, expect, it, vi } from "vitest";
import type { CliExecutionRequest } from "../command-execution-result.js";
import {
  AcceptedRequestCorruptionError,
  AcceptedRequestLedger,
  type AcceptedRequestEntry,
} from "./accepted-request-ledger.js";

const request: CliExecutionRequest = {
  argv: ["overview", "src/a.ts"],
  cwd: "/repo",
  telemetryEnabled: true,
  executionMode: "warm",
};

describe("AcceptedRequestLedger", () => {
  it("atomically inserts one queued owner and attaches an identical duplicate", () => {
    const ledger = new AcceptedRequestLedger(() => 10);

    const accepted = ledger.accept("request", "overview", request);
    const duplicate = ledger.accept("request", "overview", {
      ...request,
      argv: [...request.argv],
    });

    expect(accepted).toBe(duplicate);
    expect(accepted).toMatchObject({
      requestId: "request",
      commandName: "overview",
      request,
      state: { state: "queued", acceptedAt: 10, queuePosition: 0 },
    });
    expect(ledger.size).toBe(1);
  });

  it("reports request identifier corruption for a different payload", () => {
    const ledger = new AcceptedRequestLedger(() => 10);
    ledger.accept("request", "overview", request);

    expect(() =>
      ledger.accept("request", "overview", { ...request, argv: ["overview", "src/b.ts"] }),
    ).toThrow(AcceptedRequestCorruptionError);
    expect(() => ledger.accept("request", "refs", request)).toThrow(AcceptedRequestCorruptionError);
    expect(ledger.size).toBe(1);
  });

  it("transitions queued through running to completed", () => {
    const ledger = new AcceptedRequestLedger(() => 10);
    ledger.accept("request", "overview", request);

    expect(ledger.markRunning("request", 20).state).toEqual({
      state: "running",
      acceptedAt: 10,
      startedAt: 20,
    });
    expect(ledger.complete("request", "result", 30).state).toEqual({
      state: "completed",
      completedAt: 30,
      resultId: "result",
    });
    expect(ledger.hasUnacknowledgedCompletions).toBe(true);
    ledger.acknowledge("request");
    expect(ledger.hasUnacknowledgedCompletions).toBe(false);
    expect(ledger.status("request")).toEqual({ state: "completed" });
  });

  it("transitions queued or running requests to a typed failure", () => {
    const queued = new AcceptedRequestLedger(() => 10);
    queued.accept("queued", "overview", request);
    expect(queued.fail("queued", "stopping", 20).state).toEqual({
      state: "failed",
      completedAt: 20,
      code: "stopping",
    });

    const running = new AcceptedRequestLedger(() => 10);
    running.accept("running", "overview", request);
    running.markRunning("running", 15);
    expect(running.fail("running", "worker-exit", 20).state).toEqual({
      state: "failed",
      completedAt: 20,
      code: "worker-exit",
    });
  });

  it("publishes the current entry and each transition to subscribers", () => {
    const ledger = new AcceptedRequestLedger(() => 10);
    ledger.accept("request", "overview", request);
    const subscriber = vi.fn<(entry: AcceptedRequestEntry) => void>();

    const unsubscribe = ledger.subscribe("request", subscriber);
    ledger.markRunning("request", 20);
    unsubscribe();
    ledger.complete("request", "result", 30);

    expect(subscriber).toHaveBeenCalledTimes(2);
    expect(subscriber.mock.calls.map(([entry]) => entry.state.state)).toEqual([
      "queued",
      "running",
    ]);
  });

  it("reports every status and unknown identifiers", () => {
    const ledger = new AcceptedRequestLedger(() => 10);
    expect(ledger.status("missing")).toEqual({ state: "unknown" });
    ledger.accept("request", "overview", request);
    expect(ledger.status("request")).toEqual({ state: "queued", queuePosition: 0 });
    ledger.markRunning("request", 20);
    expect(ledger.status("request")).toEqual({ state: "running", startedAt: 20 });
    ledger.fail("request", "controlled-resource", 30);
    expect(ledger.status("request")).toEqual({
      state: "failed",
      code: "controlled-resource",
    });
  });

  it("retains acknowledged terminal tombstones for the daemon lifetime", () => {
    const ledger = new AcceptedRequestLedger(() => 10);
    ledger.accept("request", "overview", request);
    ledger.complete("request", "result", 20);

    ledger.acknowledge("request");

    expect(ledger.status("request")).toEqual({ state: "completed" });
    expect(ledger.accept("request", "overview", request).state.state).toBe("completed");
    expect(ledger.isAcknowledged("request")).toBe(true);
    expect(ledger.size).toBe(1);
  });

  it("rejects missing, repeated, and regressive transitions", () => {
    const ledger = new AcceptedRequestLedger(() => 10);
    expect(() => ledger.markRunning("missing", 20)).toThrow(/not accepted/);
    ledger.accept("request", "overview", request);
    ledger.complete("request", "result", 20);

    expect(() => ledger.markRunning("request", 30)).toThrow(/completed/);
    expect(() => ledger.complete("request", "other", 30)).toThrow(/completed/);
    expect(() => ledger.fail("request", "internal", 30)).toThrow(/completed/);
  });
});
