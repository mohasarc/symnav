import type { DaemonProcessTerminator } from "../../src/daemon/daemon-process-launcher.js";
import { describe, expect, it } from "vitest";
import { E2eProcessCleanup } from "../helpers/e2e-process-cleanup.js";
import {
  NavigationModeCleanup,
  type NavigationModeCleanupDependencies,
  type NavigationModeDaemon,
} from "./navigation-mode-cleanup.js";

describe("NavigationModeCleanup", () => {
  const daemons: readonly NavigationModeDaemon[] = [
    { workspaceRoot: "/workspace/one", pid: 101 },
    { workspaceRoot: "/workspace/two", pid: 202 },
  ];

  it("discovers, stops, terminates, validates, then removes", async () => {
    const events: string[] = [];
    const dependencies: NavigationModeCleanupDependencies = {
      discoverDaemons: () => {
        events.push("discover");
        return daemons;
      },
      stop: (daemon) => events.push(`stop:${daemon.pid}`),
      terminate: async (processIds) => {
        events.push(`terminate:${processIds.join(",")}`);
      },
      validateRemainingDaemons: () => events.push("validate"),
      removeRunRoot: () => events.push("remove"),
    };

    const outcome = await new NavigationModeCleanup(dependencies).run(2);

    expect(events).toEqual([
      "discover",
      "stop:101",
      "stop:202",
      "terminate:101,202",
      "validate",
      "remove",
    ]);
    expect(outcome).toEqual({ status: 2, errors: [] });
  });

  it.each([
    [0, 1],
    [2, 2],
  ])(
    "attempts every stop and force termination after one stop fails and maps status %i to %i",
    async (nestedStatus, expectedStatus) => {
      const stopped: number[] = [];
      const terminated: number[] = [];
      const dependencies: NavigationModeCleanupDependencies = {
        discoverDaemons: () => daemons,
        stop: (daemon) => {
          stopped.push(daemon.pid);
          if (daemon.pid === 101) throw new Error("stop refused");
        },
        terminate: async (processIds) => {
          terminated.push(...processIds);
        },
        validateRemainingDaemons: () => undefined,
        removeRunRoot: () => undefined,
      };

      const outcome = await new NavigationModeCleanup(dependencies).run(nestedStatus);

      expect(stopped).toEqual([101, 202]);
      expect(terminated).toEqual([101, 202]);
      expect(outcome).toEqual({
        status: expectedStatus,
        errors: ["Graceful stop failed for /workspace/one: stop refused"],
      });
    },
  );

  it.each([
    [0, 1],
    [2, 2],
  ])(
    "reports discovery failure, still removes, and maps status %i to %i",
    async (nestedStatus, expectedStatus) => {
      const events: string[] = [];
      const dependencies: NavigationModeCleanupDependencies = {
        discoverDaemons: () => {
          events.push("discover");
          throw new Error("invalid status JSON");
        },
        stop: () => events.push("stop"),
        terminate: async () => {
          events.push("terminate");
        },
        validateRemainingDaemons: () => events.push("validate"),
        removeRunRoot: () => events.push("remove"),
      };

      const outcome = await new NavigationModeCleanup(dependencies).run(nestedStatus);

      expect(events).toEqual(["discover", "remove"]);
      expect(outcome).toEqual({
        status: expectedStatus,
        errors: ["Daemon discovery failed: invalid status JSON"],
      });
    },
  );

  it.each([
    [0, 1],
    [2, 2],
  ])(
    "attempts later pids and validation after the first real termination rejects for status %i",
    async (nestedStatus, expectedStatus) => {
      const alive = new Set(daemons.map((daemon) => daemon.pid));
      const attempted: number[] = [];
      const processTerminator: DaemonProcessTerminator = {
        isAlive: (processId) => alive.has(processId),
        terminate: async (processId) => {
          attempted.push(processId);
          if (processId === 101) throw new Error("first pid stuck");
          alive.delete(processId);
        },
      };
      let validationCalls = 0;
      const dependencies: NavigationModeCleanupDependencies = {
        discoverDaemons: () => daemons,
        stop: () => undefined,
        terminate: (processIds) => E2eProcessCleanup.terminate(processIds, [], processTerminator),
        validateRemainingDaemons: () => {
          validationCalls += 1;
          if (alive.size !== 0) throw new Error(`${alive.size} daemon remains`);
        },
        removeRunRoot: () => undefined,
      };

      const outcome = await new NavigationModeCleanup(dependencies).run(nestedStatus);

      expect(attempted).toEqual([101, 202]);
      expect(alive).toEqual(new Set([101]));
      expect(validationCalls).toBe(1);
      expect(outcome).toEqual({
        status: expectedStatus,
        errors: [
          "Daemon process 101 termination failed: first pid stuck",
          "Remaining daemon validation failed: 1 daemon remains",
        ],
      });
    },
  );

  it("reports termination, remaining validation, and removal failures in lifecycle order", async () => {
    const dependencies: NavigationModeCleanupDependencies = {
      discoverDaemons: () => daemons,
      stop: () => undefined,
      terminate: async () => {
        throw new Error("process stayed alive");
      },
      validateRemainingDaemons: () => {
        throw new Error("status unavailable");
      },
      removeRunRoot: () => {
        throw new Error("ENOTEMPTY: state");
      },
    };

    const outcome = await new NavigationModeCleanup(dependencies).run(0);

    expect(outcome).toEqual({
      status: 1,
      errors: [
        "Daemon termination failed: process stayed alive",
        "Remaining daemon validation failed: status unavailable",
        "Run directory removal failed: ENOTEMPTY: state",
      ],
    });
  });
});
