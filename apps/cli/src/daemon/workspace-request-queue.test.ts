import { describe, expect, it } from "vitest";
import { WorkspaceRequestQueue } from "./workspace-request-queue.js";

describe("WorkspaceRequestQueue", () => {
  it("runs tasks one at a time in FIFO order", async () => {
    const queue = new WorkspaceRequestQueue();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueue(async () => {
      events.push("first-start");
      await firstGate;
      events.push("first-end");
      return 1;
    });
    const second = queue.enqueue(async () => {
      events.push("second");
      return 2;
    });

    await Promise.resolve();
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
    expect(events).toEqual(["first-start", "first-end", "second"]);
  });

  it("continues after rejection", async () => {
    const queue = new WorkspaceRequestQueue();
    const failed = queue.enqueue(() => Promise.reject(new Error("failed")));
    const recovered = queue.enqueue(() => Promise.resolve("recovered"));

    await expect(failed).rejects.toThrow("failed");
    await expect(recovered).resolves.toBe("recovered");
  });

  it("tracks idle state across successful and rejected work", async () => {
    const queue = new WorkspaceRequestQueue();
    expect(queue.isIdle).toBe(true);

    let complete!: () => void;
    const active = queue.enqueue(
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

    let reject!: (error: Error) => void;
    const rejected = queue.enqueue(
      () =>
        new Promise<void>((_resolve, rejectTask) => {
          reject = rejectTask;
        }),
    );
    await Promise.resolve();
    expect(queue.isIdle).toBe(false);
    reject(new Error("rejected"));
    await expect(rejected).rejects.toThrow("rejected");
    expect(queue.isIdle).toBe(true);
  });
});
