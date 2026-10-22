import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { E2eProcessCleanup, type TestProcessTerminator } from "./e2e-process-cleanup.js";

describe("E2eProcessCleanup", () => {
  it("gives terminated processes time to release Windows directory handles", () => {
    const removals: Array<{ readonly directory: string; readonly options: unknown }> = [];

    E2eProcessCleanup.removeDirectories(["first", "second"], (directory, options) => {
      removals.push({ directory: String(directory), options });
    });

    expect(removals).toEqual([
      {
        directory: "first",
        options: { recursive: true, force: true, maxRetries: 30, retryDelay: 100 },
      },
      {
        directory: "second",
        options: { recursive: true, force: true, maxRetries: 30, retryDelay: 100 },
      },
    ]);
  });

  it("terminates a daemon that appears while directory removal is retrying", async () => {
    const attempted: number[] = [];
    let discoveryCount = 0;
    let removalCount = 0;
    const processTerminator: TestProcessTerminator = {
      isAlive: () => true,
      terminate: async (processId) => {
        attempted.push(processId);
      },
    };

    await E2eProcessCleanup.terminateAndRemoveDirectories(
      ["root"],
      () => (discoveryCount++ === 0 ? [] : [505]),
      {
        processTerminator,
        removeDirectory: () => {
          removalCount += 1;
          if (removalCount === 1) {
            throw Object.assign(new Error("late writer"), { code: "ENOTEMPTY" });
          }
        },
        retryDelayMs: 0,
      },
    );

    expect(attempted).toEqual([505]);
    expect(removalCount).toBe(2);
  });

  it("attempts every deduplicated pid and reports failures in input order", async () => {
    const attempted: number[] = [];
    const processTerminator: TestProcessTerminator = {
      isAlive: () => true,
      terminate: async (processId) => {
        attempted.push(processId);
        if (processId !== 202) throw new Error(`refused ${processId}`);
      },
    };

    await expect(
      E2eProcessCleanup.terminate([101, 202, 101, 303], [], processTerminator),
    ).rejects.toMatchObject({
      failures: [
        "Daemon process 101 termination failed: refused 101",
        "Daemon process 303 termination failed: refused 303",
      ],
    });
    expect(attempted).toEqual([101, 202, 303]);
  });

  it("observes child exit failures while continuing pid termination", async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      signalCode: null,
      pid: 404,
    }) as ChildProcess;
    const attempted: number[] = [];
    const processTerminator: TestProcessTerminator = {
      isAlive: () => true,
      terminate: async (processId) => {
        attempted.push(processId);
        if (processId === 101) child.emit("error", new Error("child wait failed"));
      },
    };

    await expect(
      E2eProcessCleanup.terminate([101, 202], [child], processTerminator),
    ).rejects.toMatchObject({
      failures: ["Child process 404 exit wait failed: child wait failed"],
    });
    expect(attempted).toEqual([101, 202, 404]);
  });

  it("labels a child-only pid termination failure as a helper process", async () => {
    const child = {
      exitCode: 0,
      signalCode: null,
      pid: 404,
    } as ChildProcess;
    const processTerminator: TestProcessTerminator = {
      isAlive: () => true,
      terminate: async () => {
        throw new Error("helper stuck");
      },
    };

    await expect(E2eProcessCleanup.terminate([], [child], processTerminator)).rejects.toMatchObject(
      {
        failures: ["Helper process 404 termination failed: helper stuck"],
      },
    );
  });

  it("retains daemon provenance when a helper child has the same pid", async () => {
    const child = {
      exitCode: 0,
      signalCode: null,
      pid: 101,
    } as ChildProcess;
    const attempted: number[] = [];
    const processTerminator: TestProcessTerminator = {
      isAlive: () => true,
      terminate: async (processId) => {
        attempted.push(processId);
        throw new Error("overlap stuck");
      },
    };

    await expect(
      E2eProcessCleanup.terminate([101], [child], processTerminator),
    ).rejects.toMatchObject({
      failures: ["Daemon process 101 termination failed: overlap stuck"],
    });
    expect(attempted).toEqual([101]);
  });
});
