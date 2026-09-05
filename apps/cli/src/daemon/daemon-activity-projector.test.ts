import { describe, expect, it } from "vitest";
import {
  DaemonActivityProjector,
  type DaemonActivityProjectionInput,
} from "./daemon-activity-projector.js";

describe("DaemonActivityProjector", () => {
  it.each([
    {
      name: "draining over recovering, starting, and busy",
      queueState: "draining" as const,
      resourceState: "replacing" as const,
      workerReady: false,
      active: true,
      expected: "draining",
    },
    {
      name: "stopped over recovering, starting, and busy",
      queueState: "accepting" as const,
      resourceState: "stopped" as const,
      workerReady: false,
      active: true,
      expected: "draining",
    },
    {
      name: "recovering over starting and busy",
      queueState: "accepting" as const,
      resourceState: "replacing" as const,
      workerReady: false,
      active: true,
      expected: "recovering",
    },
    {
      name: "starting over busy",
      queueState: "accepting" as const,
      resourceState: "ready" as const,
      workerReady: false,
      active: true,
      expected: "starting",
    },
    {
      name: "busy over ready",
      queueState: "accepting" as const,
      resourceState: "ready" as const,
      workerReady: true,
      active: true,
      expected: "busy",
    },
    {
      name: "ready without active work",
      queueState: "accepting" as const,
      resourceState: "ready" as const,
      workerReady: true,
      active: false,
      expected: "ready",
    },
  ])("projects $name", ({ queueState, resourceState, workerReady, active, expected }) => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({ queueState, resourceState, workerReady, active }),
    );

    expect(projection.activity.lifecycle).toBe(expected);
  });

  it("projects busy work and available status detail", () => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({
        active: true,
        lastNavigationAt: 950,
        workerHeapUsedBytes: 320,
      }),
    );

    expect(projection.activity).toEqual({
      lifecycle: "busy",
      pid: 41,
      startedAt: 1_000,
      startupElapsedMs: 30,
      fileCount: 12,
      processRssBytes: 500,
      hardProcessRssBytes: 1_000,
      workerHeapUsedBytes: 320,
      workerGeneration: expect.any(Number),
      current: {
        requestId: "request",
        command: "overview",
        elapsedMs: 20,
      },
      queued: 2,
      spoolBytes: expect.any(Number),
    });
    expect(projection.pong).toEqual({
      kind: "pong",
      protocolVersion: 5,
      instanceId: "instance",
      symnavVersion: "1.2.3",
      state: "busy",
      startedAt: 1_000,
      fileCount: 12,
      memoryBytes: 500,
      queued: 2,
      activity: projection.activity,
      currentCommand: "overview",
      currentCommandElapsedMs: 20,
      lastNavigationAt: 950,
    });
  });

  it("omits unavailable status detail", () => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({ includeWorkerFileCount: false }),
    );

    expect(projection.activity).not.toHaveProperty("current");
    expect(projection.activity).not.toHaveProperty("recoveryDetail");
    expect(projection.activity).not.toHaveProperty("fileCount");
    expect(projection.activity).not.toHaveProperty("workerHeapUsedBytes");
    expect(projection.activity).not.toHaveProperty("lastCompletedAgoMs");
    expect(projection.pong).not.toHaveProperty("currentCommand");
    expect(projection.pong).not.toHaveProperty("currentCommandElapsedMs");
    expect(projection.pong).not.toHaveProperty("fileCount");
    expect(projection.pong).not.toHaveProperty("lastNavigationAt");
  });

  it("keeps retained file count only in legacy pong while the worker is not ready", () => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({ workerReady: false }),
    );

    expect(projection.activity).not.toHaveProperty("fileCount");
    expect(projection.pong.fileCount).toBe(12);
  });

  it("clamps activity durations to nonnegative values", () => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({
        active: true,
        nowMonotonicMs: 90,
        lastCompletedMonotonicAt: 140,
      }),
    );

    expect(projection.activity).toMatchObject({
      startupElapsedMs: 0,
      current: { elapsedMs: 0 },
      lastCompletedAgoMs: 0,
    });
  });

  it.each([
    ["replacing", "worker-replacement"],
    ["shedding", "resource-pressure"],
  ] as const)("projects %s recovery detail", (resourceState, expected) => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({ resourceState, active: true }),
    );

    expect(projection.activity.recoveryDetail).toBe(expected);
    expect(projection.activity.current).toBeUndefined();
  });

  it("projects the in-progress worker generation during replacement", () => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({
        resourceState: "replacing",
        resourceGeneration: 3,
        workerGeneration: 4,
        workerReady: false,
      }),
    );

    expect(projection.activity).toMatchObject({
      lifecycle: "recovering",
      workerGeneration: 4,
    });
  });

  it("projects spool bytes from the sampled resource snapshot", () => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({ sampledSpoolBytes: 83 }),
    );

    expect(projection.activity.spoolBytes).toBe(83);
  });

  it.each([
    {
      queueState: "accepting" as const,
      resourceState: "replacing" as const,
      lifecycle: "recovering",
    },
    {
      queueState: "draining" as const,
      resourceState: "replacing" as const,
      lifecycle: "draining",
    },
  ])(
    "keeps legacy pong ready during $lifecycle activity",
    ({ queueState, resourceState, lifecycle }) => {
      const projection = DaemonActivityProjector.project(
        ActivityProjectionFixture.input({
          queueState,
          resourceState,
          workerReady: false,
          active: true,
        }),
      );

      expect(projection.activity.lifecycle).toBe(lifecycle);
      expect(projection.activity.current).toBeUndefined();
      expect(projection.pong.state).toBe("ready");
    },
  );

  it("freezes the projection, pong, activity, and current work", () => {
    const projection = DaemonActivityProjector.project(
      ActivityProjectionFixture.input({ active: true }),
    );

    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.pong)).toBe(true);
    expect(Object.isFrozen(projection.activity)).toBe(true);
    expect(Object.isFrozen(projection.activity.current)).toBe(true);
    expect(() => Object.assign(projection.activity, { queued: 9 })).toThrow();
    expect(() => Object.assign(projection.activity.current ?? {}, { elapsedMs: 9 })).toThrow();
  });
});

interface ActivityProjectionOverrides {
  readonly queueState?: DaemonActivityProjectionInput["queue"]["state"];
  readonly resourceState?: DaemonActivityProjectionInput["resources"]["state"];
  readonly workerReady?: boolean;
  readonly active?: boolean;
  readonly lastNavigationAt?: number;
  readonly workerHeapUsedBytes?: number;
  readonly includeWorkerFileCount?: boolean;
  readonly nowMonotonicMs?: number;
  readonly lastCompletedMonotonicAt?: number;
  readonly resourceGeneration?: number;
  readonly workerGeneration?: number;
  readonly sampledSpoolBytes?: number;
}

class ActivityProjectionFixture {
  static input(overrides: ActivityProjectionOverrides = {}): DaemonActivityProjectionInput {
    const active = overrides.active ?? false;
    return {
      nowMonotonicMs: overrides.nowMonotonicMs ?? 130,
      pid: 41,
      processRssBytes: 500,
      startedAt: 1_000,
      startedMonotonicAt: 100,
      ...(overrides.lastNavigationAt === undefined
        ? {}
        : { lastNavigationAt: overrides.lastNavigationAt }),
      ...(overrides.lastCompletedMonotonicAt === undefined
        ? {}
        : { lastCompletedMonotonicAt: overrides.lastCompletedMonotonicAt }),
      productVersion: "1.2.3",
      instanceId: "instance",
      hardProcessRssBytes: 1_000,
      queue: {
        state: overrides.queueState ?? "accepting",
        ...(active
          ? {
              active: {
                requestId: "request",
                command: "overview",
                acceptedAt: 105,
                startedAt: 110,
              },
            }
          : {}),
        queued: 2,
      },
      resources: {
        state: overrides.resourceState ?? "ready",
        generation: overrides.resourceGeneration ?? 3,
        processRssBytes: 400,
        peakProcessRssBytes: 600,
        ...(overrides.workerHeapUsedBytes === undefined
          ? {}
          : { workerHeapUsedBytes: overrides.workerHeapUsedBytes }),
        spoolBytes: overrides.sampledSpoolBytes ?? 70,
        admissionPaused: false,
        replacementCount: 0,
      },
      worker: {
        generation: overrides.workerGeneration ?? 3,
        ready: overrides.workerReady ?? true,
        ...(overrides.includeWorkerFileCount === false ? {} : { fileCount: 12 }),
      },
    };
  }
}
