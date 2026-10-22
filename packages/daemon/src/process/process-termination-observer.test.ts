import { describe, expect, it, vi } from "vitest";
import type { DaemonDiagnosticEvent } from "../transport/protocol.js";
import { DaemonProcessTerminationObserver } from "./process-termination-observer.js";
import type { DaemonFailure } from "../daemon-failure.js";

describe("DaemonProcessTerminationObserver", () => {
  it("flushes fatal OS evidence before cleanup and process exit", async () => {
    const events: DaemonDiagnosticEvent[] = [];
    const order: string[] = [];
    const observer = new DaemonProcessTerminationObserver(
      {
        record: (event) => events.push(event),
        flush: async () => {
          order.push("flush");
        },
      },
      () => {
        order.push("cleanup");
      },
      (): never => {
        order.push("exit");
        throw new Error("exited");
      },
      async (failure: DaemonFailure) => {
        expect(failure).toMatchObject({
          phase: "process spawn",
          reason: "process-terminated",
          osCode: "EIO",
        });
        order.push("history");
      },
    );
    await expect(
      observer.uncaughtException(
        Object.assign(new Error("secret"), { code: "EIO" }),
        "uncaughtException",
      ),
    ).rejects.toThrow("exited");
    expect(order).toEqual(["history", "flush", "cleanup", "exit"]);
    expect(events[0]).toMatchObject({ failure: expect.objectContaining({ osCode: "EIO" }) });
  });
  it.each([
    [
      "uncaught exception",
      "uncaught-exception",
      (observer: DaemonProcessTerminationObserver) =>
        observer.uncaughtException(new Error("/secret/path"), "uncaughtException"),
    ],
    [
      "unhandled rejection",
      "unhandled-rejection",
      (observer: DaemonProcessTerminationObserver) =>
        observer.unhandledRejection(new TypeError("token=secret")),
    ],
    [
      "signal",
      "signal",
      (observer: DaemonProcessTerminationObserver) => observer.signal("SIGTERM"),
    ],
  ] as const)(
    "records one closed redacted %s classification before cleanup",
    async (_label, reason, terminate) => {
      const events: DaemonDiagnosticEvent[] = [];
      const flush = vi.fn(async () => undefined);
      const cleanup = vi.fn();
      const exit = vi.fn((_code: number): never => {
        throw new Error("process exited");
      });
      const observer = new DaemonProcessTerminationObserver(
        { record: (event) => events.push(event), flush },
        cleanup,
        exit,
      );

      await expect(terminate(observer)).rejects.toThrow("process exited");
      await expect(observer.signal("SIGINT")).rejects.toThrow("process exited");

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "process-termination",
        terminationReason: reason,
      });
      if (reason === "signal") expect(events[0]).toMatchObject({ signal: "SIGTERM" });
      else expect(events[0]).toMatchObject({ errorName: expect.any(String) });
      expect(JSON.stringify(events)).not.toContain("secret");
      expect(flush).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
    },
  );

  it("exits after registry cleanup fails during fatal termination", async () => {
    const events: DaemonDiagnosticEvent[] = [];
    const flush = vi.fn(async () => undefined);
    const cleanup = vi.fn(() => {
      throw new Error("registry unavailable");
    });
    const exit = vi.fn((_code: number): never => {
      throw new Error("process exited");
    });
    const observer = new DaemonProcessTerminationObserver(
      { record: (event) => events.push(event), flush },
      cleanup,
      exit,
    );

    await expect(
      observer.uncaughtException(new Error("secret"), "uncaughtException"),
    ).rejects.toThrow("process exited");
    await expect(observer.unhandledRejection(new Error("second secret"))).rejects.toThrow(
      "process exited",
    );

    expect(events).toHaveLength(1);
    expect(flush).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });
});
