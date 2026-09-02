import { describe, expect, it } from "vitest";
import { WorkspaceRequestQueue, type WorkspaceQueuedRequest } from "./workspace-request-queue.js";

describe("WorkspaceRequestQueue", () => {
  it("runs requests FIFO and exposes active metadata without counting it as queued", async () => {
    const queue = new WorkspaceRequestQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = queue.enqueue(metadata("first", "refs", 10), async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
      return 1;
    });
    const second = queue.enqueue(metadata("second", "overview", 20), async () => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(queue.snapshot).toEqual({
      state: "accepting",
      active: {
        requestId: "first",
        command: "refs",
        acceptedAt: 10,
        startedAt: expect.any(Number),
      },
      queued: 1,
    });
    const snapshot = queue.snapshot;
    expect(() => Object.assign(snapshot, { queued: 99 })).toThrow();
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
    expect(queue.snapshot).toEqual({ state: "accepting", queued: 0 });
  });

  it("continues FIFO after rejection", async () => {
    const queue = new WorkspaceRequestQueue();
    const failed = queue.enqueue(metadata("failed", "resolve", 1), () =>
      Promise.reject(new Error("failed")),
    );
    const recovered = queue.enqueue(metadata("recovered", "def", 2), () =>
      Promise.resolve("recovered"),
    );
    await expect(failed).rejects.toThrow("failed");
    await expect(recovered).resolves.toBe("recovered");
  });

  it("becomes idle only after active work completes", async () => {
    const queue = new WorkspaceRequestQueue();
    expect(queue.isIdle).toBe(true);
    let complete!: () => void;
    const active = queue.enqueue(
      metadata("active", "context", 1),
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    await Promise.resolve();
    expect(queue.isIdle).toBe(false);
    complete();
    await active;
    expect(queue.isIdle).toBe(true);
  });

  it("drains admitted work, rejects new work, and closes after active completion", async () => {
    const queue = new WorkspaceRequestQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = queue.enqueue(metadata("active", "graph", 1), () => gate);
    await Promise.resolve();
    const drained = queue.drain();
    expect(queue.snapshot).toMatchObject({ state: "draining", queued: 0 });
    await expect(
      queue.enqueue(metadata("late", "overview", 2), () => Promise.resolve()),
    ).rejects.toThrow(/draining/i);
    release();
    await active;
    await drained;
    expect(queue.snapshot).toEqual({ state: "closed", queued: 0 });
    expect(queue.isIdle).toBe(true);
    queue.close();
    await expect(
      queue.enqueue(metadata("closed", "overview", 3), () => Promise.resolve()),
    ).rejects.toThrow(/closed/i);
  });

  it("force-closes admission without treating active work as idle", async () => {
    const queue = new WorkspaceRequestQueue();
    const active = queue.enqueue(
      metadata("active", "refs", 1),
      () => new Promise<never>(() => undefined),
    );
    void active.catch(() => undefined);
    await Promise.resolve();
    queue.close();
    expect(queue.snapshot).toMatchObject({ state: "closed", active: { requestId: "active" } });
    expect(queue.isIdle).toBe(false);
  });
});

function metadata(
  requestId: string,
  command: WorkspaceQueuedRequest["command"],
  acceptedAt: number,
): WorkspaceQueuedRequest {
  return { requestId, command, acceptedAt };
}
